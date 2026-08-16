import { expect, test } from "bun:test";
import {
  agentEndTerminalNotice,
  assistantTerminalNotice,
} from "../web/assistant-message.ts";

test("aborted assistant turns produce a visible stopped notice", () => {
  expect(
    assistantTerminalNotice({
      role: "assistant",
      content: [],
      stopReason: "aborted",
      errorMessage: "Request was aborted",
    }),
  ).toEqual({
    kind: "stopped",
    title: "Run stopped",
    detail: "Request was aborted",
  });
});

test("failed agent ends are distinguishable from successful idle settlement", () => {
  expect(
    agentEndTerminalNotice({
      type: "agent_end",
      messages: [
        { role: "assistant", content: "earlier", stopReason: "stop" },
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "This operation was aborted",
        },
      ],
    }),
  ).toEqual({
    kind: "error",
    title: "Run failed",
    detail: "This operation was aborted",
  });
  expect(
    agentEndTerminalNotice({
      type: "agent_end",
      messages: [{ role: "assistant", content: "done", stopReason: "stop" }],
    }),
  ).toBeUndefined();
});
