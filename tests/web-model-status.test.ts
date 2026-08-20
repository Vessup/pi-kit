import { expect, test } from "bun:test";
import {
  applyRuntimeModelStatus,
  autoTierFromReference,
  isAutoModelReference,
  isAutoRuntimeModelSwap,
  lastAutoRoutedModelFromEntries,
  selectedAutoModelFromEntries,
  selectedModelReference,
} from "../web/model-status";

test("reconstructs a durable Auto selection", () => {
  expect(
    selectedAutoModelFromEntries([
      {
        type: "custom",
        customType: "vessup:auto-router:active",
        data: { enabled: true, pinnedTier: "high" },
      },
    ]),
  ).toBe("auto/auto-high");
  expect(
    selectedAutoModelFromEntries([
      {
        type: "custom",
        customType: "vessup:auto-router:active",
        data: { enabled: false },
      },
    ]),
  ).toBeUndefined();
});

test("finds only models Auto actually routed to", () => {
  const autoEnabled = {
    type: "custom",
    customType: "vessup:auto-router:active",
    data: { enabled: true },
  };
  const autoDisabled = {
    type: "custom",
    customType: "vessup:auto-router:active",
    data: { enabled: false },
  };
  expect(
    lastAutoRoutedModelFromEntries([
      { type: "model_change", provider: "auto", modelId: "auto" },
      autoEnabled,
      {
        type: "model_change",
        provider: "openai-codex",
        modelId: "gpt-5.6-luna",
      },
      { type: "model_change", provider: "auto", modelId: "auto" },
    ]),
  ).toBe("openai-codex/gpt-5.6-luna");
  expect(
    lastAutoRoutedModelFromEntries([
      { type: "model_change", provider: "anthropic", modelId: "manual" },
      { type: "model_change", provider: "auto", modelId: "auto" },
      autoEnabled,
      { type: "model_change", provider: "anthropic", modelId: "manual" },
      autoDisabled,
    ]),
  ).toBeUndefined();
  expect(
    lastAutoRoutedModelFromEntries([
      { type: "model_change", provider: "auto", modelId: "auto" },
    ]),
  ).toBeUndefined();
  expect(
    lastAutoRoutedModelFromEntries([
      { type: "model_change", provider: "", modelId: "model" },
      { type: "model_change", provider: "auto", modelId: "auto" },
      autoEnabled,
      { type: "model_change", provider: "provider", modelId: "" },
    ]),
  ).toBeUndefined();
});

test("recognizes Auto placeholders without matching ordinary models", () => {
  expect(isAutoModelReference("auto/auto")).toBe(true);
  expect(isAutoModelReference("auto/auto-high")).toBe(true);
  expect(isAutoModelReference("openai/gpt-5.6-luna")).toBe(false);
  expect(isAutoModelReference(undefined)).toBe(false);
});

test("only treats an Auto placeholder transition as a routed model swap", () => {
  expect(
    isAutoRuntimeModelSwap(
      "auto/auto",
      "auto/auto",
      "openai-codex/gpt-5.6-luna",
    ),
  ).toBe(true);
  expect(
    isAutoRuntimeModelSwap(
      "auto/auto",
      "openai-codex/gpt-5.6-luna",
      "anthropic/claude-sonnet",
    ),
  ).toBe(false);
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
    lastModel: "openai-codex/gpt-5.6-luna",
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
        lastModel: "openai-codex/gpt-5.6-luna",
      },
      "auto/auto",
      "off",
      false,
    ),
  ).toEqual({
    model: "auto/auto",
    thinkingLevel: "off",
    selectedModel: "auto/auto",
    lastModel: "openai-codex/gpt-5.6-luna",
  });
});

test("autoTierFromReference resolves adaptive and pinned tiers, but never ordinary models", () => {
  expect(autoTierFromReference("auto/auto")).toBe("auto");
  expect(autoTierFromReference("auto/auto-max")).toBe("max");
  expect(autoTierFromReference("auto/auto-medium")).toBe("medium");
  expect(autoTierFromReference("anthropic/claude-sonnet")).toBeUndefined();
  expect(autoTierFromReference(undefined)).toBeUndefined();
});
