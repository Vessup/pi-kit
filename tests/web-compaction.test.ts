import { expect, test } from "bun:test";
import { isSuccessfulCompactionEnd } from "../web/server/compactionNotice.ts";

test("compaction failures do not look like successful completions", () => {
  expect(
    isSuccessfulCompactionEnd({
      type: "compaction_end",
      aborted: false,
      willRetry: false,
    }),
  ).toBe(true);
  expect(
    isSuccessfulCompactionEnd({
      type: "compaction_end",
      aborted: false,
      willRetry: false,
      errorMessage: "Summarization failed: Connection error.",
    }),
  ).toBe(false);
  expect(
    isSuccessfulCompactionEnd({
      type: "compaction_end",
      aborted: true,
      willRetry: false,
    }),
  ).toBe(false);
});
