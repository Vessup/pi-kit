import { expect, test } from "bun:test";
import { isSuccessfulCompactionEnd } from "../web/server/compactionNotice.ts";
import { ManagedRpcSession } from "../web/server/managed-rpc-session.ts";

test("managed web compaction waits for the compaction_end event", async () => {
  const session = new ManagedRpcSession({
    cwd: process.cwd(),
    onEvent: () => undefined,
    onExit: () => undefined,
  });
  const runtime = session as unknown as {
    started: boolean;
    stopped: boolean;
    process: {
      stdin: {
        write: (value: string | Uint8Array) => Promise<void>;
      };
    };
    handleLine: (line: string) => void;
  };
  runtime.started = true;
  runtime.stopped = false;
  runtime.process = {
    stdin: {
      write: async (value) => {
        const text =
          typeof value === "string" ? value : new TextDecoder().decode(value);
        const request = JSON.parse(text) as {
          id: string;
          type: string;
        };
        if (request.type === "get_commands") {
          queueMicrotask(() =>
            runtime.handleLine(
              JSON.stringify({
                id: request.id,
                type: "response",
                command: request.type,
                success: true,
                data: { commands: [{ name: "web-compact" }] },
              }),
            ),
          );
          return;
        }
        if (request.type !== "prompt") return;
        queueMicrotask(() => {
          runtime.handleLine(
            JSON.stringify({
              id: request.id,
              type: "response",
              command: request.type,
              success: true,
            }),
          );
          setTimeout(
            () =>
              runtime.handleLine(
                JSON.stringify({
                  type: "compaction_start",
                  reason: "manual",
                }),
              ),
            10,
          );
          setTimeout(
            () =>
              runtime.handleLine(
                JSON.stringify({
                  type: "compaction_end",
                  reason: "manual",
                  aborted: false,
                  willRetry: false,
                  result: { summary: "done" },
                }),
              ),
            60,
          );
        });
      },
    },
  };

  let settled = false;
  const compacting = session.compact("instructions").then((result) => {
    settled = true;
    return result;
  });
  await Bun.sleep(25);
  expect(settled).toBe(false);
  expect(await compacting).toEqual({ summary: "done" });
});

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
