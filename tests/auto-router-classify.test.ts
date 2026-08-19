import { expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { CLASSIFY_MAX_TOKENS, classifyTurnComplexity } from "../extensions/auto-router-classify.ts";
import type { AutoRouterEffortLevel } from "../extensions/auto-router-settings.ts";

const MODEL = { provider: "prov", id: "classifier" } as unknown as Model<Api>;
const CODEX_MODEL = {
  provider: "openai-codex",
  id: "classifier",
  api: "openai-codex-responses",
} as unknown as Model<Api>;
const UNLISTED_API_MODEL = {
  provider: "anthropic",
  id: "classifier",
  api: "anthropic-messages",
} as unknown as Model<Api>;

function registryReplying(
  text: string,
  usage?: { input: number; output: number; cost: { total: number } },
): ModelRegistry {
  return {
    complete: async () => ({
      content: [{ type: "text", text }],
      usage,
    }),
  } as unknown as ModelRegistry;
}

function registryStoppingAt(
  text: string,
  stopReason: string,
): ModelRegistry {
  return {
    complete: async () => ({
      content: [{ type: "text", text }],
      usage: undefined,
      stopReason,
    }),
  } as unknown as ModelRegistry;
}

/** Captures the raw options object passed to `complete()`, so a test can assert on the actual
 * request shape rather than just the parsed result - the only way to catch a regression like the
 * invalid `reasoningEffort: "off"` this suite didn't previously guard against. */
function registryCapturingOptions(text: string): {
  registry: ModelRegistry;
  options: () => Record<string, unknown> | undefined;
} {
  let captured: Record<string, unknown> | undefined;
  const registry = {
    complete: async (
      _model: Model<Api>,
      _context: unknown,
      options: Record<string, unknown>,
    ) => {
      captured = options;
      return { content: [{ type: "text", text }], usage: undefined };
    },
  } as unknown as ModelRegistry;
  return { registry, options: () => captured };
}

function throwingRegistry(): ModelRegistry {
  return {
    complete: async () => {
      throw new Error("provider down");
    },
  } as unknown as ModelRegistry;
}

const ALL_LEVELS: AutoRouterEffortLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

for (const level of ALL_LEVELS) {
  test(`classifyTurnComplexity parses a bare "${level}" reply`, async () => {
    const result = await classifyTurnComplexity(registryReplying(level), MODEL, "do something", false, "medium");
    expect(result.level).toBe(level);
  });
}

test("classifyTurnComplexity parses the reply case-insensitively with surrounding text", async () => {
  const result = await classifyTurnComplexity(
    registryReplying("  I'd say MAX. \n"),
    MODEL,
    "do something",
    false,
    "medium",
  );
  expect(result.level).toBe("max");
});

test("classifyTurnComplexity picks the level word the model actually led with, not whichever word sorts earliest in the level list", async () => {
  // "medium" sorts before "high" in the internal level list, but the model's stated verdict
  // here is "high" - a naive "first match in list order" parse would wrongly return "medium".
  const result = await classifyTurnComplexity(
    registryReplying("high complexity, more than a medium task"),
    MODEL,
    "do something",
    false,
    "medium",
  );
  expect(result.level).toBe("high");
});

test("classifyTurnComplexity picks the level word the model actually led with, even when a later caveat mentions an earlier-sorting level", async () => {
  const result = await classifyTurnComplexity(
    registryReplying("medium at first glance, though parts could be high"),
    MODEL,
    "do something",
    false,
    "medium",
  );
  expect(result.level).toBe("medium");
});

test("classifyTurnComplexity falls back to medium on an unparseable reply, and flags it as failed", async () => {
  const result = await classifyTurnComplexity(
    registryReplying("uh, tricky one"),
    MODEL,
    "do something",
    false,
    "medium",
  );
  expect(result.level).toBe("medium");
  // `failed: true` is what lets a caller tell "the model actually said medium" apart from "the
  // model said nothing usable, so this is just the fallback" - a distinction that matters because
  // the two look identical if only `level` is checked, which is exactly what let a real, sustained
  // classifier failure pass as ordinary routing undetected.
  expect(result.failed).toBe(true);
});

test("classifyTurnComplexity flags a completely empty reply as failed too, not just unparseable text", async () => {
  const result = await classifyTurnComplexity(registryReplying(""), MODEL, "do something", false, "medium");
  expect(result.level).toBe("medium");
  expect(result.reply).toBe("(empty reply)");
  expect(result.failed).toBe(true);
});

test("classifyTurnComplexity names CLASSIFY_MAX_TOKENS truncation specifically, not just \"(empty reply)\"", async () => {
  // stopReason "length" means the model hit the token cap before finishing - directly actionable
  // (raise the cap, or this model needs less reasoning effort) rather than indistinguishable from
  // any other reason the reply came back unusable.
  const result = await classifyTurnComplexity(
    registryStoppingAt("", "length"),
    MODEL,
    "do something",
    false,
    "medium",
  );
  expect(result.failed).toBe(true);
  expect(result.reply).toContain(`CLASSIFY_MAX_TOKENS=${CLASSIFY_MAX_TOKENS}`);
});

test("classifyTurnComplexity does not claim truncation when the reply is just empty for some other reason", async () => {
  const result = await classifyTurnComplexity(
    registryStoppingAt("", "stop"),
    MODEL,
    "do something",
    false,
    "medium",
  );
  expect(result.failed).toBe(true);
  expect(result.reply).not.toContain("CLASSIFY_MAX_TOKENS");
});

test("classifyTurnComplexity does not flag a genuine parsed verdict as failed", async () => {
  const result = await classifyTurnComplexity(registryReplying("medium"), MODEL, "do something", false, "medium");
  expect(result.level).toBe("medium");
  expect(result.failed).toBe(false);
});

test("classifyTurnComplexity falls back to medium when the provider call throws, and records why in reply", async () => {
  const result = await classifyTurnComplexity(throwingRegistry(), MODEL, "do something", false, "medium");
  expect(result.level).toBe("medium");
  expect(result.usage).toBeUndefined();
  expect(result.reply).toContain("provider down");
  expect(result.failed).toBe(true);
});

test("classifyTurnComplexity surfaces the raw reply text alongside the parsed level, for diagnosing mismatches later", async () => {
  const result = await classifyTurnComplexity(
    registryReplying("high complexity, more than a medium task"),
    MODEL,
    "do something",
    false,
    "medium",
  );
  expect(result.level).toBe("high");
  expect(result.reply).toBe("high complexity, more than a medium task");
});

test("classifyTurnComplexity surfaces usage from the response when present", async () => {
  const result = await classifyTurnComplexity(
    registryReplying("low", { input: 42, output: 7, cost: { total: 0.002 } }),
    MODEL,
    "do something",
    false,
    "medium",
  );
  expect(result.level).toBe("low");
  expect(result.usage).toEqual({ input: 42, output: 7, cost: 0.002 });
});

test("classifyTurnComplexity notes attached images in the classification prompt", async () => {
  let capturedText: string | undefined;
  const registry = {
    complete: async (
      _model: Model<Api>,
      context: { messages: Array<{ content: Array<{ text?: string }> }> },
    ) => {
      capturedText = context.messages[0]?.content?.[0]?.text;
      return { content: [{ type: "text", text: "medium" }], usage: undefined };
    },
  } as unknown as ModelRegistry;

  await classifyTurnComplexity(registry, MODEL, "describe this screenshot", true, "medium");
  expect(capturedText).toContain("attached images");
});

test("classifyTurnComplexity caps output at CLASSIFY_MAX_TOKENS", async () => {
  const { registry, options } = registryCapturingOptions("medium");

  await classifyTurnComplexity(registry, MODEL, "do something", false, "medium");

  // Bounded, but not the old fixed 20 that starved reasoning-capable models to an empty reply.
  expect(options()?.maxTokens).toBe(CLASSIFY_MAX_TOKENS);
});

test("classifyTurnComplexity passes the requested reasoningEffort through for a model on a known-safe API", async () => {
  const { registry, options } = registryCapturingOptions("medium");

  await classifyTurnComplexity(registry, CODEX_MODEL, "do something", false, "max");

  // This is the whole point of threading an effort through at all: a model configured with
  // effort: "max" for its tier should actually reason at max here too, not some unrelated
  // provider default.
  expect(options()?.reasoningEffort).toBe("max");
});

test("classifyTurnComplexity never sends reasoningEffort \"off\", even for a known-safe API", async () => {
  const { registry, options } = registryCapturingOptions("medium");

  await classifyTurnComplexity(registry, CODEX_MODEL, "do something", false, "off");

  // "off" isn't a valid reasoningEffort value for any OpenAI-family API - regression coverage for
  // the bug that started all this: the field must be entirely absent, not just falsy, since some
  // raw request builders treat "any value present" as "send a reasoning object" regardless of
  // its content.
  expect(options()).not.toHaveProperty("reasoningEffort");
});

test("classifyTurnComplexity does not send reasoningEffort for a model on an unlisted API", async () => {
  const { registry, options } = registryCapturingOptions("medium");

  // "high" is a perfectly valid AutoRouterEffortLevel, but this model's API was never verified to
  // accept it as a raw reasoningEffort value - Mistral's own enum, for example, is only
  // "none" | "high", so blindly forwarding an untested value risks repeating the exact bug this
  // allowlist exists to prevent.
  await classifyTurnComplexity(registry, UNLISTED_API_MODEL, "do something", false, "high");

  expect(options()).not.toHaveProperty("reasoningEffort");
});
