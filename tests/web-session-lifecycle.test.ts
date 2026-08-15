import { expect, test } from "bun:test";
import { normalizeLegacySessionUpdate } from "../web/server/session-lifecycle";

test("stale working updates preserve terminal failures until real activity starts", () => {
  const failed = { status: "error" as const, agentRunning: false };
  expect(normalizeLegacySessionUpdate(failed, { status: "working" as const, marker: "stale" })).toEqual({ status: "error", marker: "stale" });
  expect(normalizeLegacySessionUpdate(failed, { status: "idle" as const })).toEqual({ status: "error" });
  expect(normalizeLegacySessionUpdate({ status: "working", agentRunning: true }, { status: "working" as const })).toEqual({ status: "working" });
});
