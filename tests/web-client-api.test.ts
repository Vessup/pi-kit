import { expect, test } from "bun:test";
import {
  commandHelloType,
  createSession,
  healthSupportsWorktreeRefs,
  sendSessionCommand,
  sessionCommandTimeout,
} from "../web/client/api.ts";

test("one-shot commands fall back across an older daemon protocol", () => {
  expect(commandHelloType({ ok: true })).toBe("client.hello");
  expect(commandHelloType({ capabilities: { commandHello: false } })).toBe(
    "client.hello",
  );
  expect(commandHelloType({ capabilities: { commandHello: true } })).toBe(
    "client.command_hello",
  );
  expect(
    healthSupportsWorktreeRefs({ capabilities: { worktreeRefs: true } }),
  ).toBe(true);
  expect(
    healthSupportsWorktreeRefs({ capabilities: { commandHello: true } }),
  ).toBe(false);
});

test("clone and fork outlive the server's 30-second operation bound", () => {
  expect(sessionCommandTimeout({ type: "clone" })).toBeGreaterThan(30_000);
  expect(
    sessionCommandTimeout({ type: "fork", entryId: "entry-1" }),
  ).toBeGreaterThan(30_000);
  expect(
    sessionCommandTimeout({
      type: "create_worktree",
      repository: "/repo",
      name: "feature",
    }),
  ).toBeGreaterThanOrEqual(10 * 60_000);
  expect(
    sessionCommandTimeout({
      type: "create_worktree",
      existing: "/repo/worktree",
    }),
  ).toBeGreaterThanOrEqual(10 * 60_000);
  expect(
    sessionCommandTimeout({
      type: "create_worktree_v2",
      repository: "/repo",
      name: "pr-30",
      branch: "owner/topic",
      startPoint: "origin/owner/topic",
    }),
  ).toBeGreaterThanOrEqual(10 * 60_000);
  expect(sessionCommandTimeout({ type: "reload" })).toBeGreaterThanOrEqual(
    10 * 60_000,
  );
  expect(sessionCommandTimeout({ type: "abort" })).toBe(35_000);
});

test("worktree capability is refreshed for each create request", async () => {
  const originalFetch = globalThis.fetch;
  let healthRequests = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input) === "/api/health") {
      healthRequests += 1;
      return Response.json({
        capabilities: { worktreeRefs: healthRequests === 1 },
      });
    }
    return Response.json({ session: { id: "session-1" } });
  }) as typeof fetch;
  try {
    await createSession({
      cwd: "/repo",
      worktreeName: "topic",
      worktreeBranch: "topic",
    });
    await expect(
      createSession({
        cwd: "/repo",
        worktreeName: "topic",
        worktreeBranch: "topic",
      }),
    ).rejects.toThrow("must be updated");
    expect(healthRequests).toBe(2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("command capability is refreshed and a close during connect rejects immediately", async () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const originalWindow = globalThis.window;
  class MockWebSocket {
    static readonly OPEN = 1;
    static closeOnHello = false;
    static hellos: string[] = [];
    readonly readyState = MockWebSocket.OPEN;
    private listeners = new Map<
      string,
      Array<(event: Event & { data?: string }) => void>
    >();

    constructor(_url: string) {
      queueMicrotask(() => this.emit("open", new Event("open")));
    }

    addEventListener(
      type: string,
      listener: (event: Event & { data?: string }) => void,
    ): void {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    send(payload: string): void {
      const message = JSON.parse(payload) as {
        type: string;
        requestId?: string;
      };
      if (
        message.type === "client.hello" ||
        message.type === "client.command_hello"
      ) {
        MockWebSocket.hellos.push(message.type);
        if (MockWebSocket.closeOnHello)
          this.emit("close", {
            code: 1006,
            reason: "daemon replaced",
          } as CloseEvent);
        return;
      }
      queueMicrotask(() =>
        this.emit("message", {
          data: JSON.stringify({
            type: "server.response",
            requestId: message.requestId,
            success: true,
          }),
        } as MessageEvent),
      );
    }

    close(): void {}

    private emit(type: string, event: Event): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  let healthRequests = 0;
  globalThis.fetch = (async () =>
    Response.json({
      capabilities: { commandHello: healthRequests++ === 0 },
    })) as typeof fetch;
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: MockWebSocket,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { origin: "http://localhost" },
      setTimeout,
      clearTimeout,
    },
  });
  try {
    await sendSessionCommand("session", { type: "abort" });
    await sendSessionCommand("session", { type: "abort" });
    expect(MockWebSocket.hellos).toEqual([
      "client.command_hello",
      "client.hello",
    ]);

    MockWebSocket.closeOnHello = true;
    await expect(
      sendSessionCommand("session", { type: "abort" }),
    ).rejects.toThrow("Command socket closed (1006: daemon replaced)");
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: originalWebSocket,
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});
