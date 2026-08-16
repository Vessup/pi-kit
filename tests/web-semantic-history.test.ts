import { expect, test } from "bun:test";
import {
  preserveSemanticEntryKeys,
  semanticHistoriesEqual,
} from "../web/client/semantic-history";
import type { SemanticEntry } from "../web/client/semantic-session";

function entry(
  id: string,
  wrapperTimestamp: string,
  text: string,
): SemanticEntry {
  return {
    id,
    type: "message",
    timestamp: wrapperTimestamp,
    message: {
      role: "assistant",
      timestamp: 1234,
      content: [{ type: "text", text }],
    },
  };
}

test("reconnect history ignores regenerated wrapper metadata", () => {
  const live = [entry("live-id", "2026-01-01T00:00:00Z", "same message")];
  const reconnect = [
    entry("server-id", "2026-01-01T00:00:01Z", "same message"),
  ];
  const reconciled = preserveSemanticEntryKeys(live, reconnect);
  expect(reconciled[0]?.id).toBe("live-id");
  expect(semanticHistoriesEqual(live, reconciled)).toBe(true);
  expect(
    semanticHistoriesEqual(live, [
      entry("server-id", "2026-01-01T00:00:01Z", "changed"),
    ]),
  ).toBe(false);
});
