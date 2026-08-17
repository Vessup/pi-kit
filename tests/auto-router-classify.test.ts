import { expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { classifyTurnComplexity } from "../extensions/auto-router-classify.ts";
import type { AutoRouterEffortLevel } from "../extensions/auto-router-settings.ts";

const MODEL = { provider: "prov", id: "classifier" } as unknown as Model<Api>;

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
    const result = await classifyTurnComplexity(registryReplying(level), MODEL, "do something", false);
    expect(result.level).toBe(level);
  });
}

test("classifyTurnComplexity parses the reply case-insensitively with surrounding text", async () => {
  const result = await classifyTurnComplexity(
    registryReplying("  I'd say MAX. \n"),
    MODEL,
    "do something",
    false,
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
  );
  expect(result.level).toBe("high");
});

test("classifyTurnComplexity picks the level word the model actually led with, even when a later caveat mentions an earlier-sorting level", async () => {
  const result = await classifyTurnComplexity(
    registryReplying("medium at first glance, though parts could be high"),
    MODEL,
    "do something",
    false,
  );
  expect(result.level).toBe("medium");
});

test("classifyTurnComplexity falls back to medium on an unparseable reply", async () => {
  const result = await classifyTurnComplexity(registryReplying("uh, tricky one"), MODEL, "do something", false);
  expect(result.level).toBe("medium");
});

test("classifyTurnComplexity falls back to medium when the provider call throws", async () => {
  const result = await classifyTurnComplexity(throwingRegistry(), MODEL, "do something", false);
  expect(result.level).toBe("medium");
  expect(result.usage).toBeUndefined();
});

test("classifyTurnComplexity surfaces usage from the response when present", async () => {
  const result = await classifyTurnComplexity(
    registryReplying("low", { input: 42, output: 7, cost: { total: 0.002 } }),
    MODEL,
    "do something",
    false,
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

  await classifyTurnComplexity(registry, MODEL, "describe this screenshot", true);
  expect(capturedText).toContain("attached images");
});
