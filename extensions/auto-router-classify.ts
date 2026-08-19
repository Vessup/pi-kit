import type { Api, Model } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AutoRouterEffortLevel } from "./auto-router-settings.js";

const CLASSIFY_TIMEOUT_MS = 15_000;
/**
 * Generous compared to the single word this call actually needs, but bounded: a reasoning-capable
 * classifier model can spend real output budget on reasoning content before ever emitting the
 * answer, and the previous fixed cap of 20 starved that to nothing (verified). Uncapped isn't the
 * right fix either though - `CLASSIFY_TIMEOUT_MS` only bounds wall-clock time, not tokens, so a
 * model that reasons at length but still finishes quickly could otherwise run up real cost on what
 * is supposed to be a cheap per-turn triage call. There's no explicit `reasoningEffort` set (see
 * below), so a reasoning model's default reasoning depth for this trivial a prompt is unmeasured -
 * sized generously to hedge against that uncertainty rather than tuned from real data. Still tiny
 * next to a real agent turn's own token usage (input context there dwarfs this call's output cap
 * by orders of magnitude - the two aren't comparable). If replies still come back empty/truncated
 * at this size, that's a signal to control reasoning effort per-provider instead of just raising
 * this further.
 */
export const CLASSIFY_MAX_TOKENS = 8_000;
const VALID_LEVELS: readonly AutoRouterEffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const DEFAULT_LEVEL: AutoRouterEffortLevel = "medium";

/**
 * APIs whose raw `reasoningEffort` field is verified (against each module's own type
 * declaration) to accept the full `AutoRouterEffortLevel` vocabulary (minus "off", handled
 * separately below). Passing it to any other API either does nothing - most providers (Anthropic,
 * Z.ai, MiniMax, OpenCode Go, ...) have no such field at all - or, worse, sends a value invalid
 * for that API's own narrower enum: Mistral's `reasoningEffort` only accepts "none" | "high", so
 * "medium" would be exactly the kind of invalid-value bug this allowlist exists to avoid
 * repeating.
 */
const REASONING_EFFORT_SAFE_APIS: ReadonlySet<string> = new Set([
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);

const SYSTEM_PROMPT = `You triage the complexity of a single upcoming coding-agent turn so it can be routed to an appropriately capable model. Reply with exactly one word, lowercase, no punctuation: minimal, low, medium, high, xhigh, or max.

- minimal: rote, no real reasoning needed. A one-word answer, a pure formatting pass, a trivial rename, echoing back something already known.
- low: simple and mechanical, but not entirely rote. One-line edits, small lookups, answering a quick factual question about the codebase.
- medium: a typical coding task. Implementing a small-to-moderate feature, fixing a well-understood bug, writing straightforward tests. This is the default for ordinary work.
- high: meaningfully harder. Multi-file refactors, tricky or intermittent bugs, non-obvious architectural changes, tasks that require holding a lot of context at once.
- xhigh: very hard, high-stakes, or open-ended. Large-scope redesigns, subtle correctness/security-critical work, or reasoning-heavy problems where getting it wrong is costly.
- max: the hardest, rarest cases. Deep multi-step reasoning under real stakes — major system redesigns, subtle distributed-systems or security bugs, decisions with significant real-world consequences.

Reply with only the single word.`;

export type ClassificationUsage = {
  input: number;
  output: number;
  cost: number;
};

export type ClassificationResult = {
  level: AutoRouterEffortLevel;
  usage?: ClassificationUsage;
  /**
   * The classifier's raw reply (trimmed/lowercased), or a bracketed placeholder when the call
   * itself failed. Callers should log this alongside `level` - otherwise there's no way to tell
   * apart "the model genuinely said medium" from "parsing picked the wrong word out of a messy
   * reply" after the fact, since the model call itself is never persisted anywhere else.
   */
  reply: string;
  /**
   * True when `level` is the `medium` default because the classifier call errored, timed out, or
   * came back with no recognizable level word - not because the model actually judged the turn to
   * be medium complexity. Callers should surface this (a notification, a log line) rather than let
   * it pass as an ordinary classification: silently defaulting with no visible signal is exactly
   * what made a real, sustained classifier failure indistinguishable from normal routing.
   */
  failed: boolean;
};

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Classify a turn's complexity using the given (default/medium-tier) model, reasoning at
 * `reasoningEffort` - the same effort this model is actually dispatched at for real work (its own
 * configured override, or its tier's name), so the classify call doesn't reason at some unrelated
 * provider default. Never throws and never blocks indefinitely: a bounded timeout, a provider
 * error, or an unparseable reply all fall back to `medium` so classification can never stall or
 * break the user's turn - but that fallback is reported via `failed: true` rather than silently,
 * so a caller can still tell a real judgment apart from a classifier that never actually answered.
 */
export async function classifyTurnComplexity(
  modelRegistry: ModelRegistry,
  model: Model<Api>,
  prompt: string,
  hasImages: boolean,
  reasoningEffort: AutoRouterEffortLevel,
): Promise<ClassificationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);
  try {
    const text = hasImages
      ? `${prompt}\n\n(This turn also includes attached images.)`
      : prompt;
    // "off" isn't a valid raw reasoningEffort value on any API observed (that's the bug this
    // whole thing started from), and only route it through at all on APIs verified to accept our
    // effort vocabulary - see REASONING_EFFORT_SAFE_APIS.
    const rawReasoningEffort =
      reasoningEffort !== "off" && REASONING_EFFORT_SAFE_APIS.has(model.api)
        ? reasoningEffort
        : undefined;
    const response = await modelRegistry.complete(
      model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        signal: controller.signal,
        cacheRetention: "none",
        sessionId: uuidv7(),
        maxTokens: CLASSIFY_MAX_TOKENS,
        ...(rawReasoningEffort !== undefined
          ? { reasoningEffort: rawReasoningEffort }
          : {}),
      },
    );
    const reply = response.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("")
      .trim()
      .toLowerCase();
    // Match whichever valid level word appears *first in the reply text*, not the first one
    // in VALID_LEVELS' own order - a naive `VALID_LEVELS.find(word-boundary test)` would let an
    // earlier-in-that-list word like "medium" win over a later one like "high" even when "high"
    // is the word the model actually led with (e.g. "high complexity, more than a medium task"),
    // silently downgrading the classification. `\b(...)\b` as one alternation also keeps the
    // existing "high" vs "xhigh" substring safety: `\b` can't match between two word characters,
    // so "high" never matches inside "xhigh" regardless of alternation order.
    const match = reply.match(new RegExp(`\\b(${VALID_LEVELS.join("|")})\\b`));
    const level = (match?.[1] as AutoRouterEffortLevel | undefined) ?? DEFAULT_LEVEL;
    const usage = response.usage
      ? {
          input: numeric(response.usage.input),
          output: numeric(response.usage.output),
          cost: numeric(response.usage.cost?.total),
        }
      : undefined;
    // `String.match()` returns `null`, not `undefined`, when nothing matches.
    const failed = match === null;
    // `stopReason: "length"` means the model hit CLASSIFY_MAX_TOKENS before finishing - distinct
    // from a model that finished cleanly but just didn't say a recognizable level word. Naming
    // the actual cause here means a diagnosis doesn't have to be guessed at: it's directly
    // actionable (raise CLASSIFY_MAX_TOKENS, or this model needs less reasoning effort) rather
    // than indistinguishable from any other reason the reply came back empty.
    const reasonSuffix =
      failed && response.stopReason === "length"
        ? ` (hit CLASSIFY_MAX_TOKENS=${CLASSIFY_MAX_TOKENS} before answering)`
        : "";
    return {
      level,
      usage,
      reply: `${reply || "(empty reply)"}${reasonSuffix}`,
      failed,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      level: DEFAULT_LEVEL,
      reply: `(classification failed: ${message})`,
      failed: true,
    };
  } finally {
    clearTimeout(timeout);
  }
}
