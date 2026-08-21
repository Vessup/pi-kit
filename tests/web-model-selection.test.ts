import { expect, test } from "bun:test";
import { shouldDeferManagedModelSelection } from "../web/server/commandRouter";

const idle = {
  agentRunning: false,
  settlingGeneration: undefined,
  compaction: undefined,
  applyingModelSelection: false,
};

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
