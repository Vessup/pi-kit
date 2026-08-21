import { expect, test } from "bun:test";
import { shouldDeferManagedModelSelection } from "../web/server/commandRouter";
import { modelSelectionBlocksPrompts } from "../web/server/model-selection-gate";

const idle = {
  agentRunning: false,
  settlingGeneration: undefined,
  compaction: undefined,
  applyingModelSelection: false,
};

test("prompts wait while a model selection is pending or failed", () => {
  const available = {
    pendingModelSelection: undefined,
    applyingModelSelection: false,
    modelSelectionFlush: undefined,
    modelSelectionError: undefined,
  };
  expect(modelSelectionBlocksPrompts(available)).toBe(false);
  expect(
    modelSelectionBlocksPrompts({
      ...available,
      pendingModelSelection: { provider: "test", modelId: "next" },
    }),
  ).toBe(true);
  expect(
    modelSelectionBlocksPrompts({
      ...available,
      modelSelectionError: "No credentials",
    }),
  ).toBe(true);
});

test("managed model selection applies immediately only after settlement", () => {
  expect(shouldDeferManagedModelSelection(idle)).toBe(false);
  expect(
    shouldDeferManagedModelSelection({ ...idle, agentRunning: true }),
  ).toBe(true);
  expect(
    shouldDeferManagedModelSelection({ ...idle, settlingGeneration: 3 }),
  ).toBe(true);
});

test("managed model selection also waits through compaction and prior changes", () => {
  expect(
    shouldDeferManagedModelSelection({
      ...idle,
      compaction: { reason: "manual", startedAt: Date.now() },
    }),
  ).toBe(true);
  expect(
    shouldDeferManagedModelSelection({
      ...idle,
      applyingModelSelection: true,
    }),
  ).toBe(true);
});
