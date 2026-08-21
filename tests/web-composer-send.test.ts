import { expect, test } from "bun:test";
import {
  restoreFailedDraft,
  restoreFailedImages,
  shouldDefaultToQueueFollowUp,
} from "../web/client/composer-send";

test("concurrent failed submissions are both restored", () => {
  const first = restoreFailedDraft("", "first failed prompt");
  expect(restoreFailedDraft(first, "second failed prompt")).toBe(
    "second failed prompt\n\nfirst failed prompt",
  );
  expect(
    restoreFailedImages(
      [{ data: "current", mimeType: "image/png" }],
      [{ data: "failed", mimeType: "image/jpeg" }],
    ),
  ).toEqual([
    { data: "failed", mimeType: "image/jpeg" },
    { data: "current", mimeType: "image/png" },
  ]);
});

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
