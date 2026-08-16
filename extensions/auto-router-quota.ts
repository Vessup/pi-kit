import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { QuotaReconciliationResult } from "./auto-router-health.js";

const FETCH_TIMEOUT_MS = 15_000;
const EXHAUSTED_UTILIZATION_PERCENT = 99.5;

type FetchResult = { ok: true; data: unknown } | { ok: false };

/** Injectable for tests; defaults to the real network/filesystem. */
export type QuotaFetchDependencies = {
  fetchImpl: typeof fetch;
  readCodexAccountId: () => Promise<string | undefined>;
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

export const defaultQuotaFetchDependencies: QuotaFetchDependencies = {
  fetchImpl: fetch,
  readCodexAccountId: defaultReadCodexAccountId,
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
  for (const window of [
    rateLimit.primary_window ?? rateLimit.primary ?? rateLimit.five_hour_limit ?? rateLimit.five_hour,
    rateLimit.secondary_window ?? rateLimit.secondary ?? rateLimit.weekly_limit ?? rateLimit.weekly,
  ]) {
    if (!isRecord(window)) continue;
    const percentLeft = numeric(window.percent_left) ?? numeric(window.remaining_percent);
    if (percentLeft !== undefined && percentLeft <= 100 - EXHAUSTED_UTILIZATION_PERCENT) {
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

async function fetchOpenRouterQuota(
  modelRegistry: ModelRegistry,
  deps: QuotaFetchDependencies,
): Promise<QuotaReconciliationResult | undefined> {
  const apiKey = await modelRegistry.getApiKeyForProvider("openrouter");
  if (!apiKey) return undefined;
  const result = await fetchJson(
    "https://openrouter.ai/api/v1/key",
    { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    deps.fetchImpl,
  );
  if (!result.ok || !isRecord(result.data)) return undefined;

  const keyData = isRecord(result.data.data) ? result.data.data : undefined;
  if (!keyData) return { exhausted: false };
  const limit = numeric(keyData.limit);
  const limitRemaining = numeric(keyData.limit_remaining);
  if (limit !== undefined && limit > 0 && limitRemaining !== undefined && limitRemaining <= 0) {
    return { exhausted: true };
  }
  return { exhausted: false };
}

/**
 * Best-effort real quota reconciliation, keyed by Pi provider id. Providers without a known
 * fetcher (e.g. Minimax, arbitrary OpenAI-compatible custom providers) simply have no entry
 * here — callers treat a missing/failed fetch as "no correction available", never as failure.
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
  openrouter: fetchOpenRouterQuota,
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
