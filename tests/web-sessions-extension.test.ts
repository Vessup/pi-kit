import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  abortSessionAndSubagents,
  applySubagentStatusToSession,
  applyTailscaleSettingTransaction,
  daemonBuildIsDegraded,
  daemonIsAdoptable,
  isScopedModelAllowed,
  parseDaemonHealth,
  reconcileBackgroundWebServer,
  splitWebWorktreeCommandArgs,
} from "../extensions/web-sessions.ts";
import type { ServerStateFile } from "../web/protocol.ts";

test("the bridge only adopts daemons that can serve the web app", () => {
  const state: ServerStateFile = {
    pid: 7,
    port: 31415,
    startedAt: 1,
    version: 1,
  };
  expect(parseDaemonHealth({ ok: true, pid: 7 }, state)).toEqual({
    ok: true,
    pid: 7,
  });
  expect(parseDaemonHealth({ ok: true, pid: 8 }, state)).toBeUndefined();
  expect(parseDaemonHealth({ ok: false, pid: 7 }, state)).toBeUndefined();
  expect(
    parseDaemonHealth({ ok: true, pid: 7, assets: true, root: "/a" }, state),
  ).toMatchObject({ assets: true });
});

test("the bridge adopts every healthy daemon except one whose checkout is gone", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-kit-daemon-adopt-"));
  try {
    const checkout = join(tempDir, "checkout");
    await Bun.write(join(checkout, "keep"), "");
    // Full health: adoptable.
    expect(
      daemonIsAdoptable({ ok: true, pid: 7, assets: true, root: checkout }),
    ).toBe(true);
    // Degraded browser build over a live checkout: the WS bridge still works,
    // so the daemon stays adoptable (and is flagged degraded for a warning).
    expect(
      daemonIsAdoptable({ ok: true, pid: 7, assets: false, root: checkout }),
    ).toBe(true);
    expect(
      daemonBuildIsDegraded({
        ok: true,
        pid: 7,
        assets: false,
        root: checkout,
      }),
    ).toBe(true);
    expect(
      daemonBuildIsDegraded({ ok: true, pid: 7, assets: true, root: checkout }),
    ).toBe(false);
    // Legacy daemons report neither field: adoptable (pre-change behavior).
    expect(daemonIsAdoptable({ ok: true, pid: 7 })).toBe(true);
    // A daemon whose checkout is confirmed gone can never serve again.
    expect(
      daemonIsAdoptable({
        ok: true,
        pid: 7,
        assets: false,
        root: join(tempDir, "gone"),
      }),
    ).toBe(false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("web Stop aborts the main session and waits for subagent propagation", async () => {
  let releaseSubagents!: () => void;
  const subagents = new Promise<void>((resolve) => {
    releaseSubagents = resolve;
  });
  let mainAborted = false;
  let settled = false;
  const operation = abortSessionAndSubagents({
    sessionId: "session-1",
    abortMain: () => {
      mainAborted = true;
    },
    emit: (request) => request.waitUntil(subagents),
  }).then(() => {
    settled = true;
  });
  expect(mainAborted).toBe(true);
  expect(settled).toBe(false);
  releaseSubagents();
  await operation;
  expect(settled).toBe(true);
});

test("web Stop reports a synchronous main-session abort failure before acknowledgement", () => {
  expect(() =>
    abortSessionAndSubagents({
      sessionId: "session-1",
      abortMain: () => {
        throw new Error("main abort failed");
      },
      emit: () => undefined,
    }),
  ).toThrow("main abort failed");
});

test("web Stop still aborts when an optional subagent listener fails", async () => {
  let mainAborted = false;
  await abortSessionAndSubagents({
    sessionId: "session-1",
    abortMain: () => {
      mainAborted = true;
    },
    emit: () => {
      throw new Error("listener failed");
    },
  });
  expect(mainAborted).toBe(true);
});

test("the bridge retains an authoritative subagent snapshot for reconnect hello", () => {
  const usage = {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const base = {
    id: "worker",
    status: "working" as const,
    model: "test/model",
    effort: "high",
    turns: 1,
    currentTool: null,
    queued: 0,
    createdAt: 1,
    updatedAt: 2,
    completedAt: null,
    error: null,
    usage,
  };
  const session = {
    id: "session-1",
    cwd: "/tmp",
    status: "idle" as const,
    source: "tui" as const,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
  };
  const first = applySubagentStatusToSession(session, {
    sessionId: session.id,
    agents: [
      {
        ...base,
        transcriptReset: true,
        transcriptDelta: [{ timestamp: 1, role: "assistant", text: "first" }],
        streamingTextReset: true,
        streamingTextDelta: "hel",
      },
    ],
    usage,
  });
  const second = applySubagentStatusToSession(first, {
    sessionId: session.id,
    agents: [
      {
        ...base,
        updatedAt: 3,
        transcriptDelta: [{ timestamp: 2, role: "assistant", text: "second" }],
        streamingTextDelta: "lo",
      },
    ],
    usage,
  });
  expect(second.subagents?.[0]?.transcript?.map((item) => item.text)).toEqual([
    "first",
    "second",
  ]);
  expect(second.subagents?.[0]?.streamingText).toBe("hello");
  expect(
    applySubagentStatusToSession(second, {
      sessionId: session.id,
      agents: [],
      usage,
    }).subagents,
  ).toEqual([]);
});

test("web worktree forwarding preserves spaces in quoted arguments", () => {
  expect(
    splitWebWorktreeCommandArgs('request-token --existing "/tmp/my  repo"'),
  ).toEqual({
    token: "request-token",
    worktreeArgs: '--existing "/tmp/my  repo"',
  });
});

test("web model selection honors the session model scope", () => {
  const scoped = [
    { model: { provider: "anthropic", id: "allowed" } },
    { model: { provider: "openai", id: "also-allowed" } },
  ];
  expect(isScopedModelAllowed(scoped, "anthropic", "allowed")).toBe(true);
  expect(isScopedModelAllowed(scoped, "anthropic", "excluded")).toBe(false);
  expect(isScopedModelAllowed(scoped, "openai", "allowed")).toBe(false);
  expect(isScopedModelAllowed([], "any", "model")).toBe(true);
});

test("background handoff keeps a detached local daemon without touching disabled Tailscale", async () => {
  const server: ServerStateFile = {
    pid: 7,
    port: 31415,
    startedAt: 1,
    version: 1,
  };
  let updates = 0;
  expect(
    await reconcileBackgroundWebServer({
      ensure: async () => server,
      readSetting: async () => ({ enabled: false, httpsPort: 443 }),
      updateTailscale: async () => {
        updates += 1;
        throw new Error("must not publish");
      },
    }),
  ).toBe(server);
  expect(updates).toBe(0);
});

test("background handoff republishes enabled Tailscale to the live daemon", async () => {
  const server: ServerStateFile = {
    pid: 7,
    port: 31415,
    startedAt: 1,
    version: 1,
  };
  const setting = {
    enabled: true,
    httpsPort: 443,
    serviceName: "pi-web",
  };
  let appliedState: ServerStateFile | undefined;
  let locked = false;
  const result = await reconcileBackgroundWebServer({
    withLock: async (operation) => {
      locked = true;
      return await operation();
    },
    ensure: async () => server,
    readSetting: async () => setting,
    updateTailscale: async (state, next, current) => {
      appliedState = state;
      expect(next).toEqual(setting);
      expect(current).toEqual(setting);
      return {
        installed: true,
        enabled: true,
        available: true,
        published: true,
        url: "https://pi-web.example/",
      };
    },
  });
  expect(locked).toBe(true);
  expect(appliedState).toBe(server);
  expect(result.tailscale?.url).toBe("https://pi-web.example/");
});

test("Tailscale setting persistence failure rolls the live route back", async () => {
  const current = { enabled: false, httpsPort: 8443 };
  const next = { enabled: true, httpsPort: 443 };
  const applied: (typeof current)[] = [];
  await expect(
    applyTailscaleSettingTransaction({
      current,
      next,
      apply: async (setting) => {
        applied.push(setting);
        return { published: setting.enabled };
      },
      persist: async () => {
        throw new Error("settings rename failed");
      },
    }),
  ).rejects.toThrow("settings rename failed");
  expect(applied).toEqual([next, current]);
});

test("Tailscale setting transaction reports a failed route rollback", async () => {
  let applications = 0;
  await expect(
    applyTailscaleSettingTransaction({
      current: "old",
      next: "new",
      apply: async () => {
        applications += 1;
        if (applications === 2) throw new Error("rollback failed");
        return "published";
      },
      persist: async () => {
        throw new Error("disk failed");
      },
    }),
  ).rejects.toThrow("route rollback failed: rollback failed");
});
