import type { Api, Model } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AutoRouterEffortLevel } from "./auto-router-settings.js";

const CLASSIFY_TIMEOUT_MS = 15_000;
const VALID_LEVELS: readonly AutoRouterEffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const DEFAULT_LEVEL: AutoRouterEffortLevel = "medium";

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
};

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Classify a turn's complexity using the given (default/medium-tier) model. Never throws and
 * never blocks indefinitely: a bounded timeout, a provider error, or an unparseable reply all
 * fall back to `medium` so classification can never stall or break the user's turn.
 */
export async function classifyTurnComplexity(
  modelRegistry: ModelRegistry,
  model: Model<Api>,
  prompt: string,
  hasImages: boolean,
): Promise<ClassificationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);
  try {
    const text = hasImages
      ? `${prompt}\n\n(This turn also includes attached images.)`
      : prompt;
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
        reasoningEffort: "off",
        cacheRetention: "none",
        sessionId: uuidv7(),
        maxTokens: 20,
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
    return { level, usage, reply: reply || "(empty reply)" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { level: DEFAULT_LEVEL, reply: `(classification failed: ${message})` };
  } finally {
    clearTimeout(timeout);
  }
}
