import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SETTINGS_KEY = "autoRouter";

/** Resolved at call time (not module load) so it honors a `PI_CODING_AGENT_DIR` override set after import. */
function settingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

type ReleaseLock = () => Promise<void>;
type LockSettingsFile = (
  path: string,
  options: {
    realpath: boolean;
    retries: { retries: number; minTimeout: number; maxTimeout: number };
  },
) => Promise<ReleaseLock>;
const lockfile = createRequire(import.meta.url)("proper-lockfile") as {
  lock: LockSettingsFile;
};

type SettingsWriteDependencies = {
  lock: LockSettingsFile;
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  rename: typeof rename;
  rm: typeof rm;
  randomUUID: typeof randomUUID;
};

const defaultWriteDependencies: SettingsWriteDependencies = {
  lock: lockfile.lock,
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  randomUUID,
};

/** Pi thinking levels, ordered from lightest to heaviest. `medium` is the conventional default/anchor tier. */
export const AUTO_ROUTER_EFFORT_ORDER = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type AutoRouterEffortLevel = (typeof AUTO_ROUTER_EFFORT_ORDER)[number];

export type AutoRouterModelRef = {
  provider: string;
  id: string;
};

export type AutoRouterTierConfig = {
  /** Ordered list of models for this effort tier; first is preferred, later entries are failover. */
  models: AutoRouterModelRef[];
};

export type AutoRouterSettings = {
  efforts: Partial<Record<AutoRouterEffortLevel, AutoRouterTierConfig>>;
};

export const EMPTY_AUTO_ROUTER_SETTINGS: AutoRouterSettings = { efforts: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEffortLevel(value: string): value is AutoRouterEffortLevel {
  return (AUTO_ROUTER_EFFORT_ORDER as readonly string[]).includes(value);
}

function parseModelRef(value: unknown): AutoRouterModelRef | undefined {
  if (!isRecord(value)) return undefined;
  const { provider, id } = value;
  if (typeof provider !== "string" || !provider.trim()) return undefined;
  if (typeof id !== "string" || !id.trim()) return undefined;
  return { provider: provider.trim(), id: id.trim() };
}

/** Parse the raw `autoRouter` settings value, silently dropping malformed entries rather than throwing on hand-edited config. */
export function parseAutoRouterSettings(value: unknown): AutoRouterSettings {
  const efforts: AutoRouterSettings["efforts"] = {};
  if (!isRecord(value) || !isRecord(value.efforts)) return { efforts };
  for (const [key, tier] of Object.entries(value.efforts)) {
    if (!isEffortLevel(key) || !isRecord(tier) || !Array.isArray(tier.models))
      continue;
    const models = tier.models
      .map(parseModelRef)
      .filter((model): model is AutoRouterModelRef => model !== undefined);
    if (models.length > 0) efforts[key] = { models };
  }
  return { efforts };
}

/** Read the shared `autoRouter` global setting. Returns an empty config (Auto effectively unconfigured) on any read/parse failure. */
export async function readAutoRouterSettings(): Promise<AutoRouterSettings> {
  try {
    const root: unknown = JSON.parse(await readFile(settingsPath(), "utf8"));
    if (!isRecord(root)) return EMPTY_AUTO_ROUTER_SETTINGS;
    return parseAutoRouterSettings(root[SETTINGS_KEY]);
  } catch {
    return EMPTY_AUTO_ROUTER_SETTINGS;
  }
}

/**
 * Lock, read, and rewrite the shared settings file. `mutate` receives the current parsed root
 * (empty object on first write) and returns the new root to persist, or `undefined` to skip
 * the write entirely (e.g. no change needed) while still safely releasing the lock.
 */
async function withLockedSettingsFile(
  settingsPath: string,
  mutate: (root: Record<string, unknown>) => Record<string, unknown> | undefined,
  dependencies: Partial<SettingsWriteDependencies> = {},
): Promise<void> {
  const io = { ...defaultWriteDependencies, ...dependencies };
  const settingsDir = dirname(settingsPath);
  await io.mkdir(settingsDir, { recursive: true });
  const release = await io.lock(settingsPath, {
    realpath: false,
    retries: { retries: 9, minTimeout: 20, maxTimeout: 20 },
  });
  try {
    let root: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(
        await io.readFile(settingsPath, "utf8"),
      );
      if (isRecord(parsed)) root = parsed;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        // First global setting write.
      } else {
        throw new Error(
          `Could not read ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const next = mutate(root);
    if (!next) return;
    const tempPath = join(
      settingsDir,
      `.settings.${process.pid}.${io.randomUUID()}.tmp`,
    );
    try {
      await io.writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await io.rename(tempPath, settingsPath);
    } finally {
      await io.rm(tempPath, { force: true }).catch(() => undefined);
    }
  } finally {
    await release();
  }
}

/** Persist the `autoRouter` setting without dropping keys owned by Pi or other extensions. */
export async function writeAutoRouterSettingsFile(
  settingsPath: string,
  settings: AutoRouterSettings,
  dependencies: Partial<SettingsWriteDependencies> = {},
): Promise<void> {
  await withLockedSettingsFile(
    settingsPath,
    (root) => ({ ...root, [SETTINGS_KEY]: settings }),
    dependencies,
  );
}

/** Persist the package-specific global `autoRouter` setting without dropping unknown keys. */
export async function writeAutoRouterSettings(
  settings: AutoRouterSettings,
): Promise<void> {
  await writeAutoRouterSettingsFile(settingsPath(), settings);
}

/** Pattern that matches our registered virtual "Auto" model in `/model`'s scoping patterns. */
export const AUTO_MODEL_SCOPE_PATTERN = "auto/auto";

/**
 * Best-effort: Pi's `/model` picker defaults to showing only `enabledModels`-scoped models
 * when that setting is non-empty, hiding everything else (including our own registered "Auto"
 * entry) behind a manual Tab toggle to "all". If the user has scoping configured, make sure it
 * includes a pattern matching Auto so it's visible by default. No-op when scoping isn't
 * configured at all (everything is already visible) or already includes a matching pattern.
 */
export async function ensureAutoModelScoped(
  settingsPath: string,
  dependencies: Partial<SettingsWriteDependencies> = {},
): Promise<void> {
  await withLockedSettingsFile(
    settingsPath,
    (root) => {
      const current = root.enabledModels;
      if (!Array.isArray(current) || current.length === 0) return undefined;
      if (current.includes(AUTO_MODEL_SCOPE_PATTERN)) return undefined;
      return { ...root, enabledModels: [...current, AUTO_MODEL_SCOPE_PATTERN] };
    },
    dependencies,
  );
}

/** `ensureAutoModelScoped` against the real global settings file. */
export async function ensureAutoModelScopedInGlobalSettings(): Promise<void> {
  await ensureAutoModelScoped(settingsPath());
}

/**
 * Resolve a classified effort level to the concrete tier to route to: walk the ordered
 * level list from `level` toward `medium`, using the first tier with configured models.
 * `medium` is the last resort even if unconfigured (callers should validate config has
 * at least one tier before routing).
 */
export function resolveEffortTier(
  settings: AutoRouterSettings,
  level: AutoRouterEffortLevel,
): AutoRouterEffortLevel {
  const levelIndex = AUTO_ROUTER_EFFORT_ORDER.indexOf(level);
  const mediumIndex = AUTO_ROUTER_EFFORT_ORDER.indexOf("medium");
  const step = levelIndex <= mediumIndex ? 1 : -1;
  for (
    let index = levelIndex;
    step > 0 ? index <= mediumIndex : index >= mediumIndex;
    index += step
  ) {
    const candidate = AUTO_ROUTER_EFFORT_ORDER[index];
    if (settings.efforts[candidate]?.models.length) return candidate;
  }
  return "medium";
}

/**
 * Tiers to try, in escalation order, when every model in `fromTier` is unhealthy: strictly
 * upward through configured tiers only (`fromTier` excluded), e.g. medium -> high -> xhigh -> max.
 */
export function escalationTiers(
  settings: AutoRouterSettings,
  fromTier: AutoRouterEffortLevel,
): AutoRouterEffortLevel[] {
  const fromIndex = AUTO_ROUTER_EFFORT_ORDER.indexOf(fromTier);
  const tiers: AutoRouterEffortLevel[] = [];
  for (
    let index = fromIndex + 1;
    index < AUTO_ROUTER_EFFORT_ORDER.length;
    index++
  ) {
    const candidate = AUTO_ROUTER_EFFORT_ORDER[index];
    if (settings.efforts[candidate]?.models.length) tiers.push(candidate);
  }
  return tiers;
}

/** All models referenced anywhere in the config, in tier order then list order, deduplicated by provider/id. */
export function allConfiguredModels(
  settings: AutoRouterSettings,
): AutoRouterModelRef[] {
  const seen = new Set<string>();
  const models: AutoRouterModelRef[] = [];
  for (const level of AUTO_ROUTER_EFFORT_ORDER) {
    for (const model of settings.efforts[level]?.models ?? []) {
      const key = `${model.provider}/${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      models.push(model);
    }
  }
  return models;
}
