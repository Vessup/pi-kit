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
    // Word-boundary match, not plain substring: "high" is a substring of "xhigh",
    // so a naive `.includes()` would mis-parse an "xhigh" reply as "high".
    const level =
      VALID_LEVELS.find((candidate) => new RegExp(`\\b${candidate}\\b`).test(reply)) ??
      DEFAULT_LEVEL;
    const usage = response.usage
      ? {
          input: numeric(response.usage.input),
          output: numeric(response.usage.output),
          cost: numeric(response.usage.cost?.total),
        }
      : undefined;
    return { level, usage };
  } catch {
    return { level: DEFAULT_LEVEL };
  } finally {
    clearTimeout(timeout);
  }
}
