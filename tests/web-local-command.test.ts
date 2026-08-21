import { expect, test } from "bun:test";
import {
  localCommandEntryId,
  preserveLocalCommandEntries,
} from "../web/client/local-command";
import type { SemanticEntry } from "../web/client/semantic-session";

function entry(id: string, timestamp: number, text: string): SemanticEntry {
  return {
    id,
    type: "message",
    timestamp: new Date(timestamp).toISOString(),
    message: { role: "user", timestamp, content: [{ type: "text", text }] },
  };
}

test("local compact commands survive authoritative history replacement in timestamp order", () => {
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

test("submitted prompts survive history refreshes until Pi records them", () => {
  const before = entry("history-before", 100, "before");
  const optimistic = entry("optimistic-request-1", 200, "route this now");
  expect(
    preserveLocalCommandEntries([before, optimistic], [before]).map(
      (item) => item.id,
    ),
  ).toEqual(["history-before", "optimistic-request-1"]);

  const olderIdentical = entry("older-identical", 50, "route this now");
  expect(
    preserveLocalCommandEntries(
      [before, optimistic],
      [olderIdentical, before],
    ).map((item) => item.id),
  ).toEqual(["older-identical", "history-before", "optimistic-request-1"]);

  const confirmed = entry("confirmed", 200, "route this now");
  expect(
    preserveLocalCommandEntries([before, optimistic], [before, confirmed]),
  ).toEqual([before, confirmed]);
});

test("local command reconciliation does not duplicate an incoming command", () => {
  const command = entry(localCommandEntryId("request-1"), 200, "/compact");
  expect(preserveLocalCommandEntries([command], [command])).toEqual([command]);
});
