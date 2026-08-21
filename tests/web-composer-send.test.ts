import { expect, test } from "bun:test";
import { shouldDefaultToQueueFollowUp } from "../web/client/composer-send";

test("compaction makes queue follow-up the default composer action", () => {
  expect(
    shouldDefaultToQueueFollowUp(
      {
        status: "working",
        compaction: { reason: "manual", startedAt: Date.now() },
      },
      false,
    ),
  ).toBe(true);
});

test("an in-flight send falls back to queueing while the session is working", () => {
  expect(
    shouldDefaultToQueueFollowUp(
      { status: "working", compaction: undefined },
      true,
    ),
  ).toBe(true);
});

test("ordinary working sessions still default to steering", () => {
  expect(
    shouldDefaultToQueueFollowUp(
      { status: "working", compaction: undefined },
      false,
    ),
  ).toBe(false);
});

test("idle sessions still wait for immediate sending to become available", () => {
  expect(
    shouldDefaultToQueueFollowUp(
      { status: "idle", compaction: undefined },
      true,
    ),
  ).toBe(false);
});
