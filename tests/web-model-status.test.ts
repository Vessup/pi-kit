import { expect, test } from "bun:test";
import {
  applyRuntimeModelStatus,
  isAutoModelReference,
  selectedModelReference,
} from "../web/model-status";

test("recognizes Auto placeholders without matching ordinary models", () => {
  expect(isAutoModelReference("auto/auto")).toBe(true);
  expect(isAutoModelReference("auto/auto-high")).toBe(true);
  expect(isAutoModelReference("openai/gpt-5.6-luna")).toBe(false);
  expect(isAutoModelReference(undefined)).toBe(false);
});

test("keeps Auto selected while recording the routed runtime model and effort", () => {
  const status = applyRuntimeModelStatus(
    {
      model: "auto/auto",
      thinkingLevel: "off",
      selectedModel: "auto/auto",
    },
    "openai-codex/gpt-5.6-luna",
    "high",
    true,
  );
  expect(status).toEqual({
    model: "openai-codex/gpt-5.6-luna",
    thinkingLevel: "high",
    selectedModel: "auto/auto",
  });
  expect(selectedModelReference(status)).toBe("auto/auto");
});

test("ordinary model changes replace both the runtime and selected model", () => {
  expect(
    applyRuntimeModelStatus(
      {
        model: "openai-codex/gpt-5.6-luna",
        thinkingLevel: "high",
        selectedModel: "auto/auto",
      },
      "anthropic/claude-sonnet",
      "medium",
      false,
    ),
  ).toEqual({
    model: "anthropic/claude-sonnet",
    thinkingLevel: "medium",
    selectedModel: "anthropic/claude-sonnet",
  });
});

test("the Auto placeholder is selected again after the runtime reverts", () => {
  expect(
    applyRuntimeModelStatus(
      {
        model: "openai-codex/gpt-5.6-luna",
        thinkingLevel: "high",
        selectedModel: "auto/auto",
      },
      "auto/auto",
      "off",
      false,
    ),
  ).toEqual({
    model: "auto/auto",
    thinkingLevel: "off",
    selectedModel: "auto/auto",
  });
});
