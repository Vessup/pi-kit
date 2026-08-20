import { expect, test } from "bun:test";
import { isPrivateWebSessionCommand } from "../web/compact-command.ts";
import { isSuccessfulCompactionEnd } from "../web/server/compactionNotice.ts";
import { ManagedRpcSession } from "../web/server/managed-rpc-session.ts";

type FakeManagedRuntime = {
  started: boolean;
  stopped: boolean;
  process: {
    stdin: {
      write: (value: string | Uint8Array) => Promise<void>;
    };
    exited: Promise<number>;
    kill: () => void;
  };
  handleLine: (line: string) => void;
};

function fakeManagedCompaction(onPrompt: (runtime: FakeManagedRuntime) => void) {
  const session = new ManagedRpcSession({
    cwd: process.cwd(),
    onEvent: () => undefined,
    onExit: () => undefined,
  });
  const runtime = session as unknown as FakeManagedRuntime;
  runtime.started = true;
  runtime.stopped = false;
  runtime.process = {
    exited: Promise.resolve(0),
    kill: () => undefined,
    stdin: {
      write: async (value) => {
        const text =
          typeof value === "string" ? value : new TextDecoder().decode(value);
        const request = JSON.parse(text) as { id: string; type: string };
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
          onPrompt(runtime);
        });
      },
    },
  };
  return session;
}

test("managed web compaction waits for the compaction_end event", async () => {
  const session = fakeManagedCompaction((runtime) => {
    setTimeout(
      () =>
        runtime.handleLine(
          JSON.stringify({ type: "compaction_start", reason: "manual" }),
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

  let settled = false;
  const compacting = session.compact("instructions").then((result) => {
    settled = true;
    return result;
  });
  await Bun.sleep(25);
  expect(settled).toBe(false);
  expect(await compacting).toEqual({ summary: "done" });
});

test("managed web compaction rejects immediately when its runtime shuts down", async () => {
  const session = fakeManagedCompaction(() => undefined);
  const compacting = session.compact();
  await Bun.sleep(10);

  await session.shutdown();
  await expect(compacting).rejects.toThrow("RPC session stopped");
});

test("private compaction transport stays out of slash-command discovery", () => {
  expect(isPrivateWebSessionCommand("web-compact")).toBe(true);
  expect(isPrivateWebSessionCommand("web-reload")).toBe(true);
  expect(isPrivateWebSessionCommand("compact")).toBe(false);
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
