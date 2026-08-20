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
 * classes (sets, ranges, `!`/`^` negation, a leading `]` as a literal member,
 * `\`-escaped members, and unterminated `[` treated as a literal) translate
 * directly. Everything else is literal.
 */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "\\") source += "\\\\";
    else if (char === "[") {
      const charClass = parseCharClass(pattern, index);
      if (charClass) {
        source += charClass.source;
        index = charClass.nextIndex - 1;
      } else {
        // Unterminated class: minimatch treats the `[` as a literal.
        source += "\\[";
      }
    } else source += char.replace(/[.+^${}()|[\]]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

/** Escape a character so it is a literal member of a RegExp character class. */
function escapeClassMember(char: string): string {
  return char === "\\" || char === "]" || char === "^" ? `\\${char}` : char;
}

/**
 * Translate the `[...]` character class starting at `start` into a RegExp
 * class source with minimatch's semantics, returning the source and the index
 * just past the closing `]`. `undefined` when the class is unterminated.
 */
function parseCharClass(
  pattern: string,
  start: number,
): { source: string; nextIndex: number } | undefined {
  let index = start + 1;
  let negate = false;
  if (pattern[index] === "!" || pattern[index] === "^") {
    negate = true;
    index += 1;
  }
  const members: string[] = [];
  // A `]` immediately after `[` (or the negation) is a literal member.
  if (pattern[index] === "]") {
    members.push("\\]");
    index += 1;
  }
  let closed = false;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === "\\") {
      const next = pattern[index + 1];
      if (next === undefined) return undefined;
      members.push(escapeClassMember(next));
      index += 2;
      continue;
    }
    if (char === "]") {
      closed = true;
      index += 1;
      break;
    }
    members.push(escapeClassMember(char));
    index += 1;
  }
  if (!closed) return undefined;
  // Minimatch classes never match the path separator: a `/` member can never
  // match (dropped), and a negated class excludes `/` alongside its members.
  const literalMembers = members.filter((member) => member !== "/");
  return {
    source: `[${negate ? "^/" : ""}${literalMembers.join("")}]`,
    nextIndex: index,
  };
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
