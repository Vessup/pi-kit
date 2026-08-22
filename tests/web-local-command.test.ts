import { expect, test } from "bun:test";
import {
  localCommandEntryId,
  localHistoryBaselineIdentities,
  preserveLocalCommandEntries,
  reconcileOptimisticQueueEntries,
} from "../web/client/local-command";
import type { SemanticEntry } from "../web/client/semantic-session";

function entry(id: string, timestamp: number, text: string): SemanticEntry {
  return contentEntry(id, timestamp, [{ type: "text", text }]);
}

function contentEntry(
  id: string,
  timestamp: number,
  content: NonNullable<SemanticEntry["message"]>["content"],
): SemanticEntry {
  return {
    id,
    type: "message",
    timestamp: new Date(timestamp).toISOString(),
    message: { role: "user", timestamp, content },
  };
}

test("local compact commands survive replacement at their history anchor", () => {
  const before = entry("history-before", 100, "before");
  const command = entry(
    localCommandEntryId("request-1"),
    200,
    "/compact preserve names",
  );
  const summary = entry("compaction-summary", 300, "Context compacted");

  expect(
    preserveLocalCommandEntries([before, command], [before, summary]).map(
      (item) => item.id,
    ),
  ).toEqual([
    "history-before",
    "local-command-request-1",
    "compaction-summary",
  ]);
});

test("submitted prompts reconcile by local history sequence, not wall clocks", () => {
  const olderIdentical = entry("older-identical", 900_000, "route this now");
  const before = entry("history-before", 900_100, "before");
  const optimistic = entry("optimistic-request-1", 900_200, "route this now");
  optimistic.localHistoryBaselineIdentities =
    localHistoryBaselineIdentities([olderIdentical, before]);

  const refreshedOlder = entry("disk-older-identical", 900_000, "route this now");
  const refreshedBefore = entry("disk-history-before", 900_100, "before");
  expect(
    preserveLocalCommandEntries(
      [olderIdentical, before, optimistic],
      [refreshedOlder, refreshedBefore],
    ).map((item) => item.id),
  ).toEqual([
    "disk-older-identical",
    "disk-history-before",
    "optimistic-request-1",
  ]);

  // The host clock can be far behind the browser. A new authoritative entry
  // still confirms the prompt because it was absent from the local baseline.
  const confirmed = entry("confirmed", 100, "route this now");
  expect(
    preserveLocalCommandEntries(
      [olderIdentical, before, optimistic],
      [refreshedOlder, refreshedBefore, confirmed],
    ),
  ).toEqual([refreshedOlder, refreshedBefore, confirmed]);
});

test("optimistic prompt confirmations are consumed one-to-one", () => {
  const first = entry("optimistic-request-1", 200, "same prompt");
  const second = entry("optimistic-request-2", 300, "same prompt");
  const confirmed = entry("confirmed", 250, "same prompt");
  expect(
    preserveLocalCommandEntries([first, second], [confirmed]).map(
      (item) => item.id,
    ),
  ).toEqual(["confirmed", "optimistic-request-2"]);
});

test("image-only optimistic prompts reconcile by image content", () => {
  const optimistic = contentEntry("optimistic-image", 200, [
    { type: "image", data: "same-image", mimeType: "image/png" },
  ]);
  const confirmed = contentEntry("confirmed-image", 200, [
    { type: "image", data: "same-image", mimeType: "image/png" },
  ]);
  expect(preserveLocalCommandEntries([optimistic], [confirmed])).toEqual([
    confirmed,
  ]);

  const different = contentEntry("different-image", 200, [
    { type: "image", data: "different-image", mimeType: "image/png" },
  ]);
  expect(
    preserveLocalCommandEntries([optimistic], [different]).map(
      (item) => item.id,
    ),
  ).toEqual(["optimistic-image", "different-image"]);
});

test("accepted queue edits update or remove model-gated optimistic prompts", () => {
  const optimistic = entry("optimistic-request-1", 200, "original");
  expect(
    reconcileOptimisticQueueEntries(
      [optimistic],
      [{ id: "request-1", message: "original" }],
      [{ id: "request-1", message: "edited" }],
    )[0]?.message?.content,
  ).toEqual([{ type: "text", text: "edited" }]);
  expect(
    reconcileOptimisticQueueEntries(
      [optimistic],
      [{ id: "request-1", message: "original" }],
      [],
    ),
  ).toEqual([]);
});

test("local command reconciliation does not duplicate an incoming command", () => {
  const command = entry(localCommandEntryId("request-1"), 200, "/compact");
  expect(preserveLocalCommandEntries([command], [command])).toEqual([command]);
});
