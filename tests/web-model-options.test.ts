import { expect, test } from "bun:test";
import type { WebModelOption } from "../web/protocol.ts";
import { thinkingLevelsForSelectedModel } from "../web/client/model-options.ts";

const models: WebModelOption[] = [
  {
    provider: "minimax",
    id: "MiniMax-M3",
    name: "MiniMax-M3",
    reasoning: true,
    thinkingLevels: ["off", "minimal", "low", "medium", "high"],
  },
  {
    provider: "openai-codex",
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    reasoning: true,
    thinkingLevels: [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ],
  },
];

test("effort menu uses only the selected model's supported thinking levels", () => {
  expect(
    thinkingLevelsForSelectedModel(models, "minimax/MiniMax-M3"),
  ).toEqual(["off", "minimal", "low", "medium", "high"]);
});

test("effort menu does not guess when selected model metadata is missing", () => {
  expect(
    thinkingLevelsForSelectedModel(models, "unknown/model"),
  ).toEqual([]);
});

test("effort menu shows no guesses while model metadata is unavailable", () => {
  expect(thinkingLevelsForSelectedModel([], "minimax/MiniMax-M3")).toEqual(
    [],
  );
});
