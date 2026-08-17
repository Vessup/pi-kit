import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Structural — matches both `AutoRouterModelRef` and the SDK's `Model<Api>`. */
export type ModelIdentity = { provider: string; id: string };

const SAVE_DEBOUNCE_MS = 2_000;

/** Resolved at call time (not module load) so it honors a `PI_CODING_AGENT_DIR` override set after import. */
function statePath(): string {
  return join(getAgentDir(), "auto-router-state.json");
}

const RATE_LIMIT_BASE_COOLDOWN_MS = 5 * 60_000;
const RATE_LIMIT_MAX_COOLDOWN_MS = 60 * 60_000;
const SERVER_ERROR_FAILURE_THRESHOLD = 3;
const SERVER_ERROR_COOLDOWN_MS = 2 * 60_000;
const AUTH_ERROR_COOLDOWN_MS = 30 * 60_000;
const GENERIC_FAILURE_THRESHOLD = 5;
const GENERIC_COOLDOWN_MS = 5 * 60_000;

export type ModelHealthEntry = {
  consecutiveFailures: number;
  cooldownUntil?: number;
  lastError?: { status: number; at: number };
  totals: { requests: number; input: number; output: number; cost: number };
  /** epoch ms of the last successful real quota-API reconciliation, if any. */
  verifiedAt?: number;
  /** Human-readable real usage from the last quota-API reconciliation, e.g. "62% used (7d)". */
  verifiedDetail?: string;
};

export type AutoRouterHealthState = Record<string, ModelHealthEntry>;

const CLASSIFICATION_LOG_LIMIT = 20;
const CLASSIFICATION_LOG_TEXT_LIMIT = 200;

/**
 * A single routing decision, kept so `/usage` can show what the classifier actually said - the
 * classification call itself is otherwise a throwaway completion whose result is discarded
 * after parsing, so without this there's no way to tell apart "the model genuinely said medium"
 * from "the reply parsed wrong" after the fact. Deliberately excludes the user's prompt text:
 * `/usage` never displays it, and this file is plaintext on disk, so persisting it would be
 * pure liability - prompts can contain source code, credentials, or personal data - for no
 * actual benefit.
 */
export type ClassificationLogEntry = {
  timestamp: number;
  reply: string;
  level: string;
  tier: string;
  /** The thinking level actually applied - a model's own `effort` override, or `tier` when it has none. */
  effort: string;
  model: ModelIdentity;
};

function truncateForLog(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > CLASSIFICATION_LOG_TEXT_LIMIT
    ? `${collapsed.slice(0, CLASSIFICATION_LOG_TEXT_LIMIT)}…`
    : collapsed;
}

export type UsageDelta = { input: number; output: number; cost: number };

export type QuotaReconciliationResult = {
  exhausted: boolean;
  /** epoch ms the exhausted window resets, if known. */
  resetsAt?: number;
  /** Human-readable real usage summary from the provider, e.g. "62% used (7d)". Shown in /usage when present. */
  detail?: string;
};

export function modelKey(model: ModelIdentity): string {
  return `${model.provider}/${model.id}`;
}

function defaultEntry(): ModelHealthEntry {
  return {
    consecutiveFailures: 0,
    totals: { requests: 0, input: 0, output: 0, cost: 0 },
  };
}

/** Parse a `retry-after` header value (seconds, or an HTTP date) into a millisecond delay from `now`. */
export function parseRetryAfterMs(
  headers: Record<string, string> | undefined,
  now: number,
): number | undefined {
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

export function isHealthy(
  state: AutoRouterHealthState,
  key: string,
  now: number,
): boolean {
  const entry = state[key];
  return !entry?.cooldownUntil || entry.cooldownUntil <= now;
}

export function pickHealthy(
  state: AutoRouterHealthState,
  models: ModelIdentity[],
  now: number,
): ModelIdentity | undefined {
  return models.find((model) => isHealthy(state, modelKey(model), now));
}

export function applySuccess(
  state: AutoRouterHealthState,
  key: string,
  usage: UsageDelta,
): AutoRouterHealthState {
  const previous = state[key] ?? defaultEntry();
  const entry: ModelHealthEntry = {
    ...previous,
    consecutiveFailures: 0,
    cooldownUntil: undefined,
    totals: {
      requests: previous.totals.requests + 1,
      input: previous.totals.input + usage.input,
      output: previous.totals.output + usage.output,
      cost: previous.totals.cost + usage.cost,
    },
  };
  return { ...state, [key]: entry };
}

/** Apply a provider HTTP response outcome. `status` in `[200,300)` is treated as success with no usage delta (see `applySuccess` for usage accounting). */
export function applyFailure(
  state: AutoRouterHealthState,
  key: string,
  status: number,
  headers: Record<string, string> | undefined,
  now: number,
): AutoRouterHealthState {
  const previous = state[key] ?? defaultEntry();
  const consecutiveFailures = previous.consecutiveFailures + 1;
  let cooldownUntil = previous.cooldownUntil;

  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(headers, now);
    const backoffExponent = Math.min(consecutiveFailures, 5) - 1;
    const backoffMs = Math.min(
      RATE_LIMIT_BASE_COOLDOWN_MS * 2 ** backoffExponent,
      RATE_LIMIT_MAX_COOLDOWN_MS,
    );
    cooldownUntil = now + (retryAfterMs ?? backoffMs);
  } else if (status === 401 || status === 403) {
    cooldownUntil = now + AUTH_ERROR_COOLDOWN_MS;
  } else if (status >= 500) {
    if (consecutiveFailures >= SERVER_ERROR_FAILURE_THRESHOLD) {
      cooldownUntil = now + SERVER_ERROR_COOLDOWN_MS;
    }
  } else if (consecutiveFailures >= GENERIC_FAILURE_THRESHOLD) {
    cooldownUntil = now + GENERIC_COOLDOWN_MS;
  }

  const entry: ModelHealthEntry = {
    ...previous,
    consecutiveFailures,
    cooldownUntil,
    lastError: { status, at: now },
  };
  return { ...state, [key]: entry };
}

/**
 * Merge a real quota-API reconciliation result. Real data always wins over locally-inferred
 * state: an exhausted window sets `cooldownUntil` even if the router never saw a 429 itself,
 * and confirmed headroom clears any existing cooldown/failure count outright.
 */
export function applyQuotaResult(
  state: AutoRouterHealthState,
  key: string,
  result: QuotaReconciliationResult,
  now: number,
): AutoRouterHealthState {
  const previous = state[key] ?? defaultEntry();
  const entry: ModelHealthEntry = result.exhausted
    ? {
        ...previous,
        cooldownUntil:
          result.resetsAt && result.resetsAt > now
            ? result.resetsAt
            : now + GENERIC_COOLDOWN_MS,
        verifiedAt: now,
        verifiedDetail: result.detail,
      }
    : {
        ...previous,
        consecutiveFailures: 0,
        cooldownUntil: undefined,
        verifiedAt: now,
        verifiedDetail: result.detail,
      };
  return { ...state, [key]: entry };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseState(value: unknown): AutoRouterHealthState {
  if (!isRecord(value)) return {};
  const state: AutoRouterHealthState = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw) || !isRecord(raw.totals)) continue;
    state[key] = {
      consecutiveFailures: Number(raw.consecutiveFailures) || 0,
      cooldownUntil:
        typeof raw.cooldownUntil === "number" ? raw.cooldownUntil : undefined,
      lastError: isRecord(raw.lastError)
        ? {
            status: Number(raw.lastError.status) || 0,
            at: Number(raw.lastError.at) || 0,
          }
        : undefined,
      totals: {
        requests: Number(raw.totals.requests) || 0,
        input: Number(raw.totals.input) || 0,
        output: Number(raw.totals.output) || 0,
        cost: Number(raw.totals.cost) || 0,
      },
      verifiedAt:
        typeof raw.verifiedAt === "number" ? raw.verifiedAt : undefined,
      verifiedDetail:
        typeof raw.verifiedDetail === "string" ? raw.verifiedDetail : undefined,
    };
  }
  return state;
}

function parseClassifications(value: unknown): ClassificationLogEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: ClassificationLogEntry[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    if (typeof raw.timestamp !== "number") continue;
    if (typeof raw.reply !== "string") continue;
    if (typeof raw.level !== "string" || typeof raw.tier !== "string") continue;
    if (
      !isRecord(raw.model) ||
      typeof raw.model.provider !== "string" ||
      typeof raw.model.id !== "string"
    )
      continue;
    // Any `prompt` field from an entry logged before this was dropped is intentionally not
    // read back here, so a reload+resave (e.g. the next classification) scrubs it from disk.
    entries.push({
      timestamp: raw.timestamp,
      reply: raw.reply,
      level: raw.level,
      tier: raw.tier,
      // Back-compat: entries logged before the `effort` field existed default to the tier name,
      // matching what actually ran for them at the time.
      effort: typeof raw.effort === "string" ? raw.effort : raw.tier,
      model: { provider: raw.model.provider, id: raw.model.id },
    });
  }
  return entries;
}

/**
 * Handles both the current `{models, classifications}` shape and the flat `Record<modelKey,
 * ModelHealthEntry>` shape every persisted file had before classification logging existed.
 */
function parsePersisted(value: unknown): {
  models: AutoRouterHealthState;
  classifications: ClassificationLogEntry[];
} {
  if (!isRecord(value)) return { models: {}, classifications: [] };
  if (isRecord(value.models)) {
    return {
      models: parseState(value.models),
      classifications: parseClassifications(value.classifications),
    };
  }
  return { models: parseState(value), classifications: [] };
}

/** Debounced, best-effort persistence for router-observed health/usage state, shared across concurrent Pi processes on a last-write-wins basis (telemetry, not correctness-critical config). */
export class AutoRouterHealthStore {
  private state: AutoRouterHealthState = {};
  private classifications: ClassificationLogEntry[] = [];
  private writeTimer: ReturnType<typeof setTimeout> | undefined;

  async load(): Promise<void> {
    try {
      const parsed = parsePersisted(
        JSON.parse(await readFile(statePath(), "utf8")),
      );
      this.state = parsed.models;
      this.classifications = parsed.classifications;
    } catch {
      this.state = {};
      this.classifications = [];
    }
  }

  getState(): AutoRouterHealthState {
    return this.state;
  }

  getClassifications(): readonly ClassificationLogEntry[] {
    return this.classifications;
  }

  getEntry(key: string): ModelHealthEntry | undefined {
    return this.state[key];
  }

  isHealthy(key: string, now: number = Date.now()): boolean {
    return isHealthy(this.state, key, now);
  }

  pickHealthy(
    models: ModelIdentity[],
    now: number = Date.now(),
  ): ModelIdentity | undefined {
    return pickHealthy(this.state, models, now);
  }

  recordSuccess(key: string, usage: UsageDelta): void {
    this.state = applySuccess(this.state, key, usage);
    this.scheduleSave();
  }

  recordFailure(
    key: string,
    status: number,
    headers: Record<string, string> | undefined,
    now: number = Date.now(),
  ): void {
    this.state = applyFailure(this.state, key, status, headers, now);
    this.scheduleSave();
  }

  applyQuotaResult(
    key: string,
    result: QuotaReconciliationResult,
    now: number = Date.now(),
  ): void {
    this.state = applyQuotaResult(this.state, key, result, now);
    this.scheduleSave();
  }

  recordClassification(
    entry: Omit<ClassificationLogEntry, "timestamp">,
    now: number = Date.now(),
  ): void {
    const full: ClassificationLogEntry = {
      timestamp: now,
      reply: truncateForLog(entry.reply),
      level: entry.level,
      tier: entry.tier,
      effort: entry.effort,
      model: entry.model,
    };
    this.classifications = [...this.classifications, full].slice(
      -CLASSIFICATION_LOG_LIMIT,
    );
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
    this.writeTimer.unref?.();
  }

  async flush(): Promise<void> {
    const dir = dirname(statePath());
    await mkdir(dir, { recursive: true });
    const tempPath = join(
      dir,
      `.auto-router-state.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(
        tempPath,
        `${JSON.stringify({ models: this.state, classifications: this.classifications }, null, 2)}\n`,
        "utf8",
      );
      await rename(tempPath, statePath());
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}
