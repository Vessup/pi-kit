import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DaemonHealth,
  daemonIsEvictable,
  daemonServesWebApps,
  isPidAlive,
  isPiWebDaemonPid,
  matchesPiWebDaemonCommand,
} from "../web/server/daemon-process.ts";

function health(overrides: Partial<DaemonHealth> = {}): DaemonHealth {
  return {
    ok: true,
    pid: 123,
    port: 31415,
    assets: true,
    root: "",
    ...overrides,
  };
}

test("daemonServesWebApps requires the daemon to report servable assets", () => {
  expect(daemonServesWebApps(health())).toBe(true);
  expect(daemonServesWebApps(health({ assets: false }))).toBe(false);
});

test("a daemon whose checkout disappeared is evictable", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-kit-daemon-evict-"));
  try {
    const vanished = join(tempDir, "vanishing");
    await Bun.write(join(vanished, "keep"), "");
    expect(daemonIsEvictable(health({ root: vanished }))).toBe(false);
    await rm(vanished, { recursive: true, force: true });
    expect(daemonIsEvictable(health({ root: vanished }))).toBe(true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("daemons that cannot prove they serve the web app are evictable exactly once replaced", () => {
  // Legacy daemons never report assets, which probes normalize to false with
  // no root, so a newer spawn replaces them once.
  expect(daemonIsEvictable(health({ assets: false }))).toBe(true);
  expect(daemonIsEvictable(health())).toBe(false);
  // A reported build failure over an existing checkout is not fixable by
  // respawning from the same checkout, so the daemon is left alone.
  expect(
    daemonIsEvictable(health({ root: process.cwd(), assets: false })),
  ).toBe(false);
});

test("isPidAlive accepts the current process and rejects pids that cannot exist", () => {
  expect(isPidAlive(process.pid)).toBe(true);
  expect(isPidAlive(0)).toBe(false);
  expect(isPidAlive(-1)).toBe(false);
  expect(isPidAlive(999_999_999)).toBe(false);
});

test("pid verification reads a real command line and only matches Pi web daemons", async () => {
  // The test runner is a real, readable process: verification must read its
  // command line (via /proc or ps) and correctly report it is not a daemon.
  expect(await isPiWebDaemonPid(process.pid)).toBe(false);
  expect(await isPiWebDaemonPid(999_999_999)).toBe(false);
});

test("daemon command matching requires bun itself as the executable", () => {
  expect(matchesPiWebDaemonCommand("bun run /repo/web/server/index.ts")).toBe(
    true,
  );
  expect(
    matchesPiWebDaemonCommand(
      "/Users/x/.bun/bin/bun run /repo/web/server/index.ts",
    ),
  ).toBe(true);
  expect(matchesPiWebDaemonCommand("bun run webServer")).toBe(true);
  expect(matchesPiWebDaemonCommand("bun --hot /repo/web/server/index.ts")).toBe(
    true,
  );
  // A recycled pid running an unrelated command that merely mentions the
  // entrypoint must never be mistaken for the daemon.
  expect(matchesPiWebDaemonCommand("vim web/server/index.ts")).toBe(false);
  expect(matchesPiWebDaemonCommand("rg web/server/index.ts")).toBe(false);
  expect(matchesPiWebDaemonCommand("node web/server/index.ts")).toBe(false);
  expect(matchesPiWebDaemonCommand("bun test tests/web-server.test.ts")).toBe(
    false,
  );
  expect(matchesPiWebDaemonCommand("")).toBe(false);
});
