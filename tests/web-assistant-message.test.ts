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
    title: "Stopped",
    detail: "Request was aborted",
  });
});

test("a Stop that surfaces as an error with an abort message is not a failure", () => {
  // Clicking Stop ends the in-flight assistant message with stopReason
  // "error" plus an abort message. It must render as stopped, never error.
  expect(
    assistantTerminalNotice({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "This operation was aborted",
    }),
  ).toEqual({
    kind: "stopped",
    title: "Stopped",
    detail: "This operation was aborted",
  });
  expect(
    assistantTerminalNotice({
      role: "assistant",
      content: [],
      stopReason: "aborted",
    }),
  ).toEqual({
    kind: "stopped",
    title: "Stopped",
    detail: "The operation was aborted before Pi could finish.",
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
          errorMessage: "Rate limit exceeded",
        },
      ],
    }),
  ).toEqual({
    kind: "error",
    title: "Run failed",
    detail: "Rate limit exceeded",
  });
  expect(
    agentEndTerminalNotice({
      type: "agent_end",
      messages: [{ role: "assistant", content: "done", stopReason: "stop" }],
    }),
  ).toBeUndefined();
});
