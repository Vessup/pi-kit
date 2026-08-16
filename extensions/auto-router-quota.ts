import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { QuotaReconciliationResult } from "./auto-router-health.js";

const execFileAsync = promisify(execFile);

const FETCH_TIMEOUT_MS = 15_000;
const EXHAUSTED_UTILIZATION_PERCENT = 99.5;

type FetchResult = { ok: true; data: unknown } | { ok: false };

/**
 * A provider's reconciliation result. `default` applies to every configured model under the
 * provider; `perModel` (keyed by `normalizeModelId(modelId)`) overrides it for models the
 * provider reports on individually — e.g. Codex's per-model usage alongside its account-wide
 * limit. Falling back to `default` for anything not in `perModel` keeps this correct even for
 * models the provider doesn't break out individually.
 */
export type ProviderQuotaResult = {
  default: QuotaReconciliationResult;
  perModel?: Record<string, QuotaReconciliationResult>;
};

/** Injectable for tests; defaults to the real network/filesystem/CLI. */
export type QuotaFetchDependencies = {
  fetchImpl: typeof fetch;
  readCodexAccountId: () => Promise<string | undefined>;
  /** Runs the `mmx` CLI (MiniMax's own tool) and returns stdout, or `undefined` if it's missing, not logged in, or fails. */
  runMinimaxCli: (args: string[]) => Promise<string | undefined>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Loosely matches a provider's own model label (e.g. "GPT-5.3-Codex-Spark") to a configured model id (e.g. "gpt-5.3-codex-spark"). */
export function normalizeModelId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function defaultReadCodexAccountId(): Promise<string | undefined> {
  try {
    const authPath = join(homedir(), ".codex", "auth.json");
    const data: unknown = JSON.parse(await readFile(authPath, "utf8"));
    if (!isRecord(data) || !isRecord(data.tokens)) return undefined;
    const { account_id: accountId, accountId: camelAccountId } = data.tokens as Record<string, unknown>;
    return typeof accountId === "string"
      ? accountId
      : typeof camelAccountId === "string"
        ? camelAccountId
        : undefined;
  } catch {
    return undefined;
  }
}

async function defaultRunMinimaxCli(args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("mmx", args, {
      timeout: FETCH_TIMEOUT_MS,
      encoding: "utf8",
    });
    return stdout;
  } catch {
    return undefined;
  }
}

export const defaultQuotaFetchDependencies: QuotaFetchDependencies = {
  fetchImpl: fetch,
  readCodexAccountId: defaultReadCodexAccountId,
  runMinimaxCli: defaultRunMinimaxCli,
};

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<FetchResult> {
  try {
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false };
    return { ok: true, data: await response.json() };
  } catch {
    return { ok: false };
  }
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Accepts epoch seconds, epoch milliseconds, or an ISO date string. */
function parseDateish(value: unknown): number | undefined {
  if (typeof value === "number") return value > 10 ** 11 ? value : value * 1000;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * A raw Anthropic API key (`sk-ant-...`) has no subscription usage window to report; only
 * `pi /login` OAuth subscription credentials do.
 */
function isDirectAnthropicApiKey(token: string): boolean {
  return token.startsWith("sk-ant-");
}

async function fetchAnthropicQuota(
  modelRegistry: ModelRegistry,
  deps: QuotaFetchDependencies,
): Promise<ProviderQuotaResult | undefined> {
  const token = await modelRegistry.getApiKeyForProvider("anthropic");
  if (!token || isDirectAnthropicApiKey(token)) return undefined;
  const result = await fetchJson(
    "https://api.anthropic.com/api/oauth/usage",
    {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
    },
    deps.fetchImpl,
  );
  if (!result.ok || !isRecord(result.data)) return undefined;

  let mostUsed: { label: string; percent: number; window: Record<string, unknown> } | undefined;
  for (const [key, label] of [["five_hour", "5h"], ["seven_day", "7d"]] as const) {
    const window = result.data[key];
    if (!isRecord(window)) continue;
    const utilization = numeric(window.utilization);
    if (utilization === undefined) continue;
    if (!mostUsed || utilization > mostUsed.percent) mostUsed = { label, percent: utilization, window };
  }
  if (!mostUsed) return { default: { exhausted: false } };
  const detail = `${mostUsed.label} ${roundPercent(mostUsed.percent)}% used`;
  if (mostUsed.percent >= EXHAUSTED_UTILIZATION_PERCENT) {
    return { default: { exhausted: true, resetsAt: parseDateish(mostUsed.window.resets_at), detail } };
  }
  return { default: { exhausted: false, detail } };
}

/**
 * The API has been observed reporting a window's usage three different ways: "percent left"
 * fields (converted to used%) or a direct "used%" field. Check all three rather than assuming one.
 */
function windowUsedPercent(window: Record<string, unknown>): number | undefined {
  const percentLeft = numeric(window.percent_left) ?? numeric(window.remaining_percent);
  return percentLeft !== undefined ? 100 - percentLeft : numeric(window.used_percent);
}

function windowResetsAt(window: Record<string, unknown>): number | undefined {
  return parseDateish(window.reset_at ?? window.reset_time_ms);
}

async function fetchCodexQuota(
  modelRegistry: ModelRegistry,
  deps: QuotaFetchDependencies,
): Promise<ProviderQuotaResult | undefined> {
  const token = await modelRegistry.getApiKeyForProvider("openai-codex");
  const accountId = await deps.readCodexAccountId();
  if (!token || !accountId) return undefined;
  const result = await fetchJson(
    "https://chatgpt.com/backend-api/wham/usage",
    {
      Authorization: `Bearer ${token}`,
      "ChatGPT-Account-Id": accountId,
      Accept: "application/json",
      Origin: "https://chatgpt.com",
      Referer: "https://chatgpt.com/",
    },
    deps.fetchImpl,
  );
  if (!result.ok || !isRecord(result.data)) return undefined;

  const spendControl = result.data.spend_control;
  if (isRecord(spendControl) && spendControl.reached === true) {
    return { default: { exhausted: true, detail: "spend cap reached" } };
  }

  const rateLimit = result.data.rate_limit ?? result.data.rate_limits;
  if (!isRecord(rateLimit)) return { default: { exhausted: false } };

  const accountWindow = isRecord(rateLimit.primary_window ?? rateLimit.primary)
    ? ((rateLimit.primary_window ?? rateLimit.primary) as Record<string, unknown>)
    : undefined;
  const accountUsedPercent = accountWindow ? windowUsedPercent(accountWindow) : undefined;
  const accountDetail = accountUsedPercent !== undefined ? `account ${roundPercent(accountUsedPercent)}% used` : undefined;
  const accountResetsAt = accountWindow ? windowResetsAt(accountWindow) : undefined;

  // Codex reports exhaustion account-wide, authoritatively, right on the rate_limit object
  // itself - check it before falling back to inferring exhaustion from window percentages.
  // (Verified directly against a real exhausted account: `{"allowed":false,"limit_reached":true,
  // "primary_window":{"used_percent":100,...}}` at the top level, alongside a *healthy*
  // per-model entry under `additional_rate_limits` for the specific model in use - the
  // account-wide flag is the one that actually blocks every model under this provider.)
  const accountExhausted =
    rateLimit.limit_reached === true ||
    rateLimit.allowed === false ||
    (accountUsedPercent !== undefined && accountUsedPercent >= EXHAUSTED_UTILIZATION_PERCENT);

  const defaultResult: QuotaReconciliationResult = accountExhausted
    ? { exhausted: true, resetsAt: accountResetsAt, detail: accountDetail }
    : { exhausted: false, detail: accountDetail };

  // Per-model detail (and, when the account itself isn't blocking, per-model exhaustion) from
  // additional_rate_limits, matched to configured model ids by normalized label.
  const perModel: Record<string, QuotaReconciliationResult> = {};
  const additional = Array.isArray(result.data.additional_rate_limits) ? result.data.additional_rate_limits : [];
  for (const entry of additional) {
    if (!isRecord(entry) || typeof entry.limit_name !== "string") continue;
    const entryRateLimit = entry.rate_limit;
    if (!isRecord(entryRateLimit)) continue;
    const window = isRecord(entryRateLimit.primary_window) ? entryRateLimit.primary_window : undefined;
    const usedPercent = window ? windowUsedPercent(window) : undefined;
    const modelExhausted =
      accountExhausted ||
      entryRateLimit.limit_reached === true ||
      entryRateLimit.allowed === false ||
      (usedPercent !== undefined && usedPercent >= EXHAUSTED_UTILIZATION_PERCENT);
    perModel[normalizeModelId(entry.limit_name)] = {
      exhausted: modelExhausted,
      resetsAt: modelExhausted ? (accountResetsAt ?? (window ? windowResetsAt(window) : undefined)) : undefined,
      detail: usedPercent !== undefined ? `${roundPercent(usedPercent)}% used` : accountDetail,
    };
  }

  return { default: defaultResult, perModel: Object.keys(perModel).length > 0 ? perModel : undefined };
}

async function fetchZaiQuota(
  modelRegistry: ModelRegistry,
  deps: QuotaFetchDependencies,
): Promise<ProviderQuotaResult | undefined> {
  const apiKey = await modelRegistry.getApiKeyForProvider("zai");
  if (!apiKey) return undefined;
  const result = await fetchJson(
    "https://api.z.ai/api/monitor/usage/quota/limit",
    { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    deps.fetchImpl,
  );
  if (!result.ok || !isRecord(result.data)) return undefined;

  const nested = isRecord(result.data.data) ? result.data.data : result.data;
  const limits = Array.isArray(nested.limits) ? nested.limits : [];
  let mostUsed: { label: string; percent: number; entry: Record<string, unknown> } | undefined;
  for (const entry of limits) {
    if (!isRecord(entry) || entry.type !== "TOKENS_LIMIT") continue;
    const percentage = numeric(entry.percentage);
    if (percentage === undefined) continue;
    const label = entry.unit === 3 ? "hourly" : entry.unit === 6 ? "weekly" : "token";
    if (!mostUsed || percentage > mostUsed.percent) mostUsed = { label, percent: percentage, entry };
  }
  if (!mostUsed) return { default: { exhausted: false } };
  const detail = `${mostUsed.label} ${roundPercent(mostUsed.percent)}% used`;
  if (mostUsed.percent >= EXHAUSTED_UTILIZATION_PERCENT) {
    return { default: { exhausted: true, resetsAt: parseDateish(mostUsed.entry.nextResetTime), detail } };
  }
  return { default: { exhausted: false, detail } };
}

async function fetchKimiCodingQuota(
  modelRegistry: ModelRegistry,
  deps: QuotaFetchDependencies,
): Promise<ProviderQuotaResult | undefined> {
  const apiKey = await modelRegistry.getApiKeyForProvider("kimi-coding");
  if (!apiKey) return undefined;
  const result = await fetchJson(
    "https://api.kimi.com/coding/v1/usages",
    { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    deps.fetchImpl,
  );
  if (!result.ok || !isRecord(result.data)) return undefined;

  const weekly = result.data.usage;
  if (!isRecord(weekly)) return { default: { exhausted: false } };
  const limit = numeric(weekly.limit);
  const used = numeric(weekly.used);
  const detail = limit !== undefined && used !== undefined ? `${used}/${limit} this week` : undefined;
  if (limit !== undefined && used !== undefined && limit > 0 && used >= limit) {
    return { default: { exhausted: true, resetsAt: parseDateish(weekly.resetTime), detail } };
  }
  return { default: { exhausted: false, detail } };
}

/**
 * MiniMax has no documented HTTP quota endpoint, but its own `mmx` CLI does — `mmx --verbose`
 * shows it calling `GET https://api.minimax.io/v1/token_plan/remains` with its own OAuth
 * session (`mmx auth login`), separate from whatever credential Pi itself uses for inference.
 * Shelling out to the CLI (rather than reading its private token cache directly) lets `mmx`
 * own token refresh/expiry, and only degrades — never breaks — when `mmx` isn't installed or
 * isn't logged in.
 */
async function fetchMinimaxQuota(
  _modelRegistry: ModelRegistry,
  deps: QuotaFetchDependencies,
): Promise<ProviderQuotaResult | undefined> {
  const stdout = await deps.runMinimaxCli(["quota", "show", "--output", "json"]);
  if (!stdout) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(data) || !Array.isArray(data.model_remains)) return undefined;

  const general = data.model_remains.find((entry) => isRecord(entry) && entry.model_name === "general");
  if (!isRecord(general)) return { default: { exhausted: false } };

  // The API reports *remaining* percent (opposite convention from the other providers' *used*
  // percent), and tracks a short rolling interval plus a weekly window separately.
  const intervalRemaining = numeric(general.current_interval_remaining_percent);
  const weeklyRemaining = numeric(general.current_weekly_remaining_percent);
  const detailParts: string[] = [];
  if (intervalRemaining !== undefined) detailParts.push(`interval ${roundPercent(intervalRemaining)}% left`);
  if (weeklyRemaining !== undefined) detailParts.push(`weekly ${roundPercent(weeklyRemaining)}% left`);
  const detail = detailParts.length > 0 ? detailParts.join(", ") : undefined;

  if (intervalRemaining !== undefined && intervalRemaining <= 100 - EXHAUSTED_UTILIZATION_PERCENT) {
    return { default: { exhausted: true, resetsAt: numeric(general.end_time), detail } };
  }
  if (weeklyRemaining !== undefined && weeklyRemaining <= 100 - EXHAUSTED_UTILIZATION_PERCENT) {
    return { default: { exhausted: true, resetsAt: numeric(general.weekly_end_time), detail } };
  }
  return { default: { exhausted: false, detail } };
}

/**
 * Best-effort real quota reconciliation, keyed by Pi provider id. Providers without a known
 * fetcher (arbitrary OpenAI-compatible custom providers, mostly) simply have no entry here —
 * callers treat a missing/failed fetch as "no correction available", never as failure.
 */
export const QUOTA_FETCHERS: Record<
  string,
  (
    modelRegistry: ModelRegistry,
    deps: QuotaFetchDependencies,
  ) => Promise<ProviderQuotaResult | undefined>
> = {
  anthropic: fetchAnthropicQuota,
  "openai-codex": fetchCodexQuota,
  zai: fetchZaiQuota,
  "kimi-coding": fetchKimiCodingQuota,
  minimax: fetchMinimaxQuota,
};

/** Reconcile one provider's real quota state. Never throws; returns `undefined` when there's no known fetcher, no credentials, or the request failed. */
export async function reconcileProviderQuota(
  provider: string,
  modelRegistry: ModelRegistry,
  deps: QuotaFetchDependencies = defaultQuotaFetchDependencies,
): Promise<ProviderQuotaResult | undefined> {
  const fetcher = QUOTA_FETCHERS[provider];
  if (!fetcher) return undefined;
  try {
    return await fetcher(modelRegistry, deps);
  } catch {
    return undefined;
  }
}
