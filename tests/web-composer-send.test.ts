import { expect, test } from "bun:test";
import {
  isQueuedFollowUpResponse,
  restoreFailedDraft,
  restoreFailedImages,
  shouldDefaultToQueueFollowUp,
  shouldShowOptimisticPrompt,
} from "../web/client/composer-send";

test("concurrent failed submissions are both restored", () => {
  const first = restoreFailedDraft("", "first failed prompt");
  expect(restoreFailedDraft(first, "second failed prompt")).toBe(
    "second failed prompt\n\nfirst failed prompt",
  );
  expect(
    restoreFailedImages(
      [
        { type: "image", data: "current-1", mimeType: "image/png" },
        { type: "image", data: "current-2", mimeType: "image/png" },
        { type: "image", data: "current-3", mimeType: "image/png" },
      ],
      [
        { type: "image", data: "failed-1", mimeType: "image/jpeg" },
        { type: "image", data: "failed-2", mimeType: "image/jpeg" },
      ],
    ),
  ).toEqual([
    { type: "image", data: "failed-1", mimeType: "image/jpeg" },
    { type: "image", data: "failed-2", mimeType: "image/jpeg" },
    { type: "image", data: "current-1", mimeType: "image/png" },
    { type: "image", data: "current-2", mimeType: "image/png" },
  ]);
});

test("queued follow-ups stay out of the transcript until delivery", () => {
  expect(shouldShowOptimisticPrompt("followUp", "working")).toBe(false);
  expect(shouldShowOptimisticPrompt("steer", "working")).toBe(true);
  expect(shouldShowOptimisticPrompt(undefined, "idle")).toBe(true);
  expect(
    isQueuedFollowUpResponse({ queued: true, reason: "followUp" }),
  ).toBe(true);
  expect(
    isQueuedFollowUpResponse({ queued: true, reason: "modelSelection" }),
  ).toBe(false);
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
