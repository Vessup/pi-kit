import { expect, test } from "bun:test";
import type { ManagedRpcSession } from "../web/server/managed-rpc-session";
import { SlashCommandService } from "../web/server/slash-command-service";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("slash command discovery deduplicates concurrent runtime starts", async () => {
  const gate = deferred();
  let runtimes = 0;
  let shutdowns = 0;
  const service = new SlashCommandService(
    (path) => path,
    () => {
      runtimes += 1;
      return {
        start: () => gate.promise,
        getCommands: async () => ({
          commands: [
            {
              name: "address-pr",
              source: "prompt",
              sourceInfo: { path: "prompt.md" },
            },
          ],
        }),
        shutdown: async () => {
          shutdowns += 1;
        },
      } as unknown as ManagedRpcSession;
    },
  );
  const first = service.discover("/repo");
  const second = service.discover("/repo");
  expect(runtimes).toBe(1);
  gate.resolve();
  expect(await first).toEqual(await second);
  expect(shutdowns).toBe(1);
});

test("invalidation isolates overlapping slash command discoveries", async () => {
  const gates = [deferred(), deferred()];
  let runtimes = 0;
  const service = new SlashCommandService(
    (path) => path,
    () => {
      const index = runtimes++;
      return {
        start: () => gates[index]?.promise,
        getCommands: async () => ({
          commands: [
            {
              name: index === 0 ? "stale" : "fresh",
              source: "prompt",
              sourceInfo: { path: "prompt.md" },
            },
          ],
        }),
        shutdown: async () => {},
      } as unknown as ManagedRpcSession;
    },
  );

  const stale = service.discover("/repo");
  service.invalidate("/repo");
  const fresh = service.discover("/repo");
  expect(runtimes).toBe(2);

  gates[0]?.resolve();
  expect((await stale)[0]?.name).toBe("stale");
  const overlapping = service.discover("/repo");
  expect(runtimes).toBe(2);

  gates[1]?.resolve();
  expect((await fresh)[0]?.name).toBe("fresh");
  expect((await overlapping)[0]?.name).toBe("fresh");
  expect((await service.discover("/repo"))[0]?.name).toBe("fresh");
  expect(runtimes).toBe(2);
});

test("slash command discovery is bounded and shutdown cannot mask the timeout", async () => {
  const service = new SlashCommandService(
    (path) => path,
    () =>
      ({
        start: () => new Promise<void>(() => {}),
        getCommands: async () => ({ commands: [] }),
        shutdown: async () => {
          throw new Error("shutdown failed");
        },
      }) as unknown as ManagedRpcSession,
    10,
  );
  await expect(service.discover("/wedged")).rejects.toThrow(
    "Slash command discovery timed out for /wedged",
  );
});

test("slash command projection reuses the compact fallback", () => {
  const service = new SlashCommandService(
    (path) => path,
    () => ({}) as ManagedRpcSession,
  );
  expect(service.toWeb([]).map((command) => command.name)).toEqual([
    "compact",
    "reload",
  ]);
});
