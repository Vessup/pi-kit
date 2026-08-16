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
): Promise<QuotaReconciliationResult | undefined> {
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

  for (const key of ["five_hour", "seven_day"] as const) {
    const window = result.data[key];
    if (!isRecord(window)) continue;
    const utilization = numeric(window.utilization);
    if (utilization !== undefined && utilization >= EXHAUSTED_UTILIZATION_PERCENT) {
      return { exhausted: true, resetsAt: parseDateish(window.resets_at) };
    }
  }
  return { exhausted: false };
}

async function fetchCodexQuota(
  modelRegistry: ModelRegistry,
  deps: QuotaFetchDependencies,
): Promise<QuotaReconciliationResult | undefined> {
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
    return { exhausted: true };
  }

  const rateLimit = result.data.rate_limit ?? result.data.rate_limits;
  if (!isRecord(rateLimit)) return { exhausted: false };

  // Codex reports this account-wide, authoritatively, right on the rate_limit object itself -
  // check it before falling back to inferring exhaustion from individual window percentages.
  // (Verified directly against a real exhausted account: `{"allowed":false,"limit_reached":true,
  // "primary_window":{"used_percent":100,...}}` at the top level, alongside a *healthy*
  // per-model entry under `additional_rate_limits` for the specific model in use - the
  // account-wide flag is the one that actually blocks every model under this provider.)
  if (rateLimit.limit_reached === true || rateLimit.allowed === false) {
    const window = rateLimit.primary_window ?? rateLimit.primary;
    return {
      exhausted: true,
      resetsAt: isRecord(window) ? parseDateish(window.reset_at ?? window.reset_time_ms) : undefined,
    };
  }

  for (const window of [
    rateLimit.primary_window ?? rateLimit.primary ?? rateLimit.five_hour_limit ?? rateLimit.five_hour,
    rateLimit.secondary_window ?? rateLimit.secondary ?? rateLimit.weekly_limit ?? rateLimit.weekly,
  ]) {
    if (!isRecord(window)) continue;
    // The API has been observed reporting this three different ways: "percent left" fields
    // (convert to used%) or a direct "used%" field. Check all three rather than assuming one.
    const percentLeft = numeric(window.percent_left) ?? numeric(window.remaining_percent);
    const usedPercent = percentLeft !== undefined ? 100 - percentLeft : numeric(window.used_percent);
    if (usedPercent !== undefined && usedPercent >= EXHAUSTED_UTILIZATION_PERCENT) {
      return {
        exhausted: true,
        resetsAt: parseDateish(window.reset_at ?? window.reset_time_ms),
      };
    }
  }
  return { exhausted: false };
}

async function fetchZaiQuota(
  modelRegistry: ModelRegistry,
  deps: QuotaFetchDependencies,
): Promise<QuotaReconciliationResult | undefined> {
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
  for (const entry of limits) {
    if (!isRecord(entry) || entry.type !== "TOKENS_LIMIT") continue;
    const percentage = numeric(entry.percentage);
    if (percentage !== undefined && percentage >= EXHAUSTED_UTILIZATION_PERCENT) {
      return { exhausted: true, resetsAt: parseDateish(entry.nextResetTime) };
    }
  }
  return { exhausted: false };
}

async function fetchKimiCodingQuota(
  modelRegistry: ModelRegistry,
  deps: QuotaFetchDependencies,
): Promise<QuotaReconciliationResult | undefined> {
  const apiKey = await modelRegistry.getApiKeyForProvider("kimi-coding");
  if (!apiKey) return undefined;
  const result = await fetchJson(
    "https://api.kimi.com/coding/v1/usages",
    { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    deps.fetchImpl,
  );
  if (!result.ok || !isRecord(result.data)) return undefined;

  const weekly = result.data.usage;
  if (isRecord(weekly)) {
    const limit = numeric(weekly.limit);
    const used = numeric(weekly.used);
    if (limit !== undefined && used !== undefined && limit > 0 && used >= limit) {
      return { exhausted: true, resetsAt: parseDateish(weekly.resetTime) };
    }
  }
  return { exhausted: false };
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
): Promise<QuotaReconciliationResult | undefined> {
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
  const entries = isRecord(general) ? [general] : data.model_remains;
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    // The API reports *remaining* percent (opposite convention from the other providers'
    // *used* percent), and tracks a short rolling interval plus a weekly window separately.
    const intervalRemaining = numeric(entry.current_interval_remaining_percent);
    if (intervalRemaining !== undefined && intervalRemaining <= 100 - EXHAUSTED_UTILIZATION_PERCENT) {
      return { exhausted: true, resetsAt: numeric(entry.end_time) };
    }
    const weeklyRemaining = numeric(entry.current_weekly_remaining_percent);
    if (weeklyRemaining !== undefined && weeklyRemaining <= 100 - EXHAUSTED_UTILIZATION_PERCENT) {
      return { exhausted: true, resetsAt: numeric(entry.weekly_end_time) };
    }
  }
  return { exhausted: false };
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
  ) => Promise<QuotaReconciliationResult | undefined>
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
): Promise<QuotaReconciliationResult | undefined> {
  const fetcher = QUOTA_FETCHERS[provider];
  if (!fetcher) return undefined;
  try {
    return await fetcher(modelRegistry, deps);
  } catch {
    return undefined;
  }
}
