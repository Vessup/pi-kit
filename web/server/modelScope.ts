import { readFile } from "node:fs/promises";

/**
 * Model-scope filtering for managed web sessions.
 *
 * Pi's `/model` picker defaults to the session's `scopedModels` — resolved from
 * `--models` or, absent that flag, the global `enabledModels` setting. TUI
 * bridge sessions forward their resolved scope to the daemon via
 * `agent.hello`/`agent.scope`, so `record.scopedModels` already mirrors the
 * picker there. Managed RPC sessions have no such channel: the RPC protocol
 * exposes no scope query, and the daemon spawns them without `--models`, so
 * their scope is exactly the `enabledModels` patterns in the same settings
 * file the daemon already reads. Re-resolving those patterns here keeps the
 * web picker in sync with what the TUI would show.
 */

const THINKING_LEVEL_SUFFIXES = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Read `enabledModels` from a Pi settings file. Unreadable/absent/malformed means no scoping. */
export async function readEnabledModelPatterns(
  settingsPath: string,
): Promise<string[]> {
  try {
    const root: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
    if (!isRecord(root) || !Array.isArray(root.enabledModels)) return [];
    return root.enabledModels.filter(
      (pattern): pattern is string =>
        typeof pattern === "string" && pattern.trim().length > 0,
    );
  } catch {
    return [];
  }
}

/**
 * Convert a glob to a RegExp with minimatch's default semantics for the
 * characters we support: `*` and `?` never cross `/`, and `[...]` character
 * classes pass through. Everything else is literal.
 */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "\\") source += "\\\\";
    else source += char.replace(/[.+^${}()|[\]]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

function hasGlobCharacter(pattern: string): boolean {
  return /[*?[]/.test(pattern);
}

/** Strip an optional `:<thinking-level>` suffix (e.g. `zai/glm-5.3:high`), as Pi's scope resolver does. */
function withoutThinkingSuffix(pattern: string): string {
  const colonIndex = pattern.lastIndexOf(":");
  if (colonIndex < 0) return pattern;
  const suffix = pattern.slice(colonIndex + 1);
  return THINKING_LEVEL_SUFFIXES.has(suffix)
    ? pattern.slice(0, colonIndex)
    : pattern;
}

/**
 * Whether `provider`/`id` matches one scope pattern, following the same rules
 * Pi applies to `enabledModels`: exact `provider/id` or bare-id equality
 * (case-insensitive), a partial id/name containment fallback, or — when the
 * pattern contains glob characters — minimatch-style matching against the
 * full `provider/id` form or the bare id. The Auto Router's `auto/*` pattern
 * relies on the glob path.
 */
export function modelMatchesScopePattern(
  pattern: string,
  provider: string,
  model: { id: string; name?: string },
): boolean {
  const bare = withoutThinkingSuffix(pattern.trim());
  if (bare.length === 0) return false;
  const fullId = `${provider}/${model.id}`;
  if (hasGlobCharacter(bare)) {
    const expression = globToRegExp(bare);
    return expression.test(fullId) || expression.test(model.id);
  }
  const lowered = bare.toLowerCase();
  if (lowered === fullId.toLowerCase() || lowered === model.id.toLowerCase())
    return true;
  return (
    model.id.toLowerCase().includes(lowered) ||
    (model.name ? model.name.toLowerCase().includes(lowered) : false)
  );
}

export type ScopeFilterModel = { provider: string; id: string; name?: string };

/**
 * Keep only the models allowed by `patterns`. An empty pattern list means no
 * scoping is configured and every model passes through, matching Pi's picker.
 */
export function filterModelsByScopePatterns<Model extends ScopeFilterModel>(
  models: Model[],
  patterns: readonly string[],
): Model[] {
  if (patterns.length === 0) return models;
  return models.filter((model) =>
    patterns.some((pattern) =>
      modelMatchesScopePattern(pattern, model.provider, model),
    ),
  );
}
