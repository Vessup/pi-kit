import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  compareWebSessions,
  moveWebQueuedMessage,
  moveWebSession,
  moveWebSessionRelative,
  orderWebSessions,
  type ServerStateFile,
  type WebQueuedMessage,
  type WebSession,
} from "../web/protocol.ts";
import {
  clearSessionProjectCache,
  resolveSessionProject,
} from "../web/server/projects.ts";
import {
  createWebWorktree,
  WORKTREE_SESSION_ENTRY,
} from "../web/server/worktrees.ts";

let child: Bun.Subprocess | undefined;
// A daemon this test expects another process to evict; reaped unconditionally
// in afterEach so a failed eviction cannot leak it into later tests.
let evictedDaemon: Bun.Subprocess | undefined;
let tempDir: string | undefined;

function session(
  id: string,
  status: WebSession["status"],
  createdAt: number,
  updatedAt: number,
): WebSession {
  return {
    id,
    cwd: "/tmp",
    status,
    source: status === "offline" ? "saved" : "tui",
    createdAt,
    updatedAt,
    messageCount: 0,
  };
}

test("session ordering defaults to creation time and accepts persistent manual moves", () => {
  const older = session("older", "working", 100, 10_000);
  const newer = session("newer", "idle", 200, 300);
  expect(
    [older, newer].sort(compareWebSessions).map((item) => item.id),
  ).toEqual(["newer", "older"]);
  older.updatedAt = 20_000;
  expect(
    [older, newer].sort(compareWebSessions).map((item) => item.id),
  ).toEqual(["newer", "older"]);
  const customOrder = moveWebSession([older, newer], [], "older", "newer");
  expect(
    orderWebSessions([newer, older], customOrder).map((item) => item.id),
  ).toEqual(["older", "newer"]);
  const movedToBottom = moveWebSessionRelative(
    [older, newer],
    customOrder,
    "older",
    { afterId: "newer" },
  );
  expect(
    orderWebSessions([older, newer], movedToBottom).map((item) => item.id),
  ).toEqual(["newer", "older"]);
  const newestInactive = session("inactive", "offline", 300, 400);
  expect(
    [older, newestInactive, newer]
      .sort(compareWebSessions)
      .map((item) => item.id),
  ).toEqual(["inactive", "newer", "older"]);
});

test("queued follow-ups can move into any insertion slot without losing attachments", () => {
  const queue: WebQueuedMessage[] = [
    { id: "first", message: "first" },
    {
      id: "second",
      message: "second",
      images: [{ type: "image", data: "image", mimeType: "image/png" }],
    },
    { id: "third", message: "third" },
  ];
  expect(
    moveWebQueuedMessage(queue, "third", { beforeId: "first" }).map(
      (item) => item.id,
    ),
  ).toEqual(["third", "first", "second"]);
  const movedToEnd = moveWebQueuedMessage(queue, "first", { afterId: "third" });
  expect(movedToEnd.map((item) => item.id)).toEqual([
    "second",
    "third",
    "first",
  ]);
  expect(movedToEnd[0]?.images).toEqual(queue[1]?.images);
  expect(movedToEnd[0]?.images).not.toBe(queue[1]?.images);
});

test("linked Git worktrees resolve to the same sidebar project", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-project-test-"));
  const repository = join(tempDir, "project");
  const worktree = join(tempDir, "project-feature");
  await Bun.$`git init -q ${repository}`;
  await Bun.$`git -C ${repository} config user.name test`;
  await Bun.$`git -C ${repository} config user.email test@example.com`;
  await Bun.write(join(repository, "README.md"), "test\n");
  await Bun.$`git -C ${repository} add README.md`;
  await Bun.$`git -C ${repository} commit -qm initial`;
  await Bun.$`git -C ${repository} worktree add -q -b feature ${worktree}`;
  clearSessionProjectCache();
  const mainProject = resolveSessionProject(repository);
  const worktreeProject = resolveSessionProject(worktree);
  expect(mainProject.id).toBe(worktreeProject.id);
  expect(mainProject.name).toBe("project");
  expect(mainProject.root).toBe(await realpath(repository));
  expect(worktreeProject.root).toBe(await realpath(repository));
});

test("Git projects expose checkout roots for submodules and bare repositories", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-project-root-test-"));
  const repository = join(tempDir, "project");
  const childRepository = join(tempDir, "child-source");
  const submodule = join(repository, "nested");
  const bareRepository = join(tempDir, "archive.git");
  for (const path of [repository, childRepository]) {
    await Bun.$`git init -q ${path}`;
    await Bun.$`git -C ${path} config user.name test`;
    await Bun.$`git -C ${path} config user.email test@example.com`;
    await Bun.write(join(path, "README.md"), "test\n");
    await Bun.$`git -C ${path} add README.md`;
    await Bun.$`git -C ${path} commit -qm initial`;
  }
  await Bun.$`git -c protocol.file.allow=always -C ${repository} submodule add -q ${childRepository} nested`;
  await Bun.$`git init -q --bare ${bareRepository}`;
  clearSessionProjectCache();
  expect(resolveSessionProject(submodule).root).toBe(await realpath(submodule));
  expect(resolveSessionProject(bareRepository).root).toBe(
    await realpath(bareRepository),
  );
});

afterEach(async () => {
  if (child) {
    child.kill("SIGTERM");
    await child.exited.catch(() => undefined);
    child = undefined;
  }
  if (evictedDaemon) {
    try {
      evictedDaemon.kill("SIGKILL");
      await evictedDaemon.exited.catch(() => undefined);
    } catch {
      // Already gone via eviction.
    }
    evictedDaemon = undefined;
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function waitForState(path: string): Promise<ServerStateFile> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as ServerStateFile;
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new Error("web server state file was not created");
}

function browserSocket(
  url: string,
  origin = new URL(url.replace(/^ws/, "http")).origin,
): WebSocket {
  // Bun's WebSocket client accepts request headers as its second argument.
  return new WebSocket(url, {
    headers: { Origin: origin },
  } as unknown as string[]);
}

function sessionCommand(
  url: string,
  sessionId: string,
  command: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = browserSocket(url);
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("session command timed out"));
    }, 10_000);
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "client.command_hello" }));
      socket.send(
        JSON.stringify({
          type: "client.command",
          requestId,
          sessionId,
          command,
        }),
      );
    };
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        requestId?: string;
        success?: boolean;
        error?: string;
        data?: unknown;
      };
      if (message.type === "server.snapshot") {
        clearTimeout(timeout);
        socket.close();
        reject(
          new Error(
            "command-only websocket unexpectedly received the session catalog",
          ),
        );
        return;
      }
      if (message.type !== "server.response" || message.requestId !== requestId)
        return;
      clearTimeout(timeout);
      socket.close();
      if (message.success) resolve(message.data);
      else reject(new Error(message.error ?? "session command failed"));
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("session command websocket failed"));
    };
  });
}

function semanticHistory(url: string, sessionId: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const socket = browserSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("semantic history test timed out"));
    }, 3_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        sessionId?: string;
        entries?: unknown[];
      };
      if (message.type === "server.snapshot") {
        socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
      }
      if (
        message.type === "server.history" &&
        message.sessionId === sessionId
      ) {
        clearTimeout(timeout);
        socket.close();
        resolve(message.entries ?? []);
      }
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("semantic websocket failed"));
    };
  });
}

function websocketSnapshot(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = browserSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("websocket snapshot timed out"));
    }, 3_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
    socket.onmessage = ({ data }) => {
      const message: unknown = JSON.parse(String(data));
      if (
        !message ||
        typeof message !== "object" ||
        !("type" in message) ||
        message.type !== "server.snapshot"
      )
        return;
      clearTimeout(timeout);
      socket.close();
      resolve(message);
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("websocket connection failed"));
    };
  });
}

function nativeLifecycleStatuses(
  url: string,
  sessionId: string,
  agent: WebSocket,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const statuses: string[] = [];
    const socket = browserSocket(url);
    let started = false;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("native lifecycle status update timed out"));
    }, 3_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        sessionId?: string;
        session?: WebSession;
      };
      if (message.type === "server.snapshot")
        socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
      if (
        message.type === "server.history" &&
        message.sessionId === sessionId &&
        !started
      ) {
        started = true;
        agent.send(
          JSON.stringify({
            type: "agent.event",
            sessionId,
            event: { type: "agent_start" },
          }),
        );
        return;
      }
      if (
        !started ||
        message.type !== "server.session" ||
        message.session?.id !== sessionId
      )
        return;
      if (message.session.status === "working" && statuses.length === 0) {
        statuses.push("working");
        agent.send(
          JSON.stringify({
            type: "agent.event",
            sessionId,
            event: { type: "agent_end" },
          }),
        );
      } else if (
        message.session.status === "idle" &&
        statuses[0] === "working" &&
        statuses.length === 1
      ) {
        statuses.push("idle");
        agent.send(
          JSON.stringify({
            type: "agent.update",
            session: {
              ...message.session,
              status: "working",
              updatedAt: Date.now(),
            },
          }),
        );
      } else if (message.session.status === "idle" && statuses.length === 2) {
        statuses.push("idle");
        clearTimeout(timeout);
        socket.close();
        resolve(statuses);
      }
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("native lifecycle websocket failed"));
    };
  });
}

function nativeUpdatePayload(
  url: string,
  sessionId: string,
  agent: WebSocket,
  session: WebSession,
): Promise<WebSession> {
  return new Promise((resolve, reject) => {
    const socket = browserSocket(url);
    let updateSent = false;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("native update metadata timed out"));
    }, 3_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        sessionId?: string;
        session?: WebSession;
      };
      if (message.type === "server.snapshot")
        socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
      if (
        message.type === "server.history" &&
        message.sessionId === sessionId &&
        !updateSent
      ) {
        updateSent = true;
        agent.send(JSON.stringify({ type: "agent.update", session }));
        return;
      }
      if (
        !updateSent ||
        message.type !== "server.session" ||
        message.session?.id !== sessionId
      )
        return;
      clearTimeout(timeout);
      socket.close();
      resolve(message.session);
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("native update websocket failed"));
    };
  });
}

test("Bun web server keeps tokenless clients inside localhost and same-origin trust boundaries", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-web-test-"));
  const statePath = join(tempDir, "server.json");
  child = Bun.spawn({
    cmd: ["bun", "run", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: join(tempDir, "pi-agent"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  const state = await waitForState(statePath);
  const { port } = state;
  expect(port).toBeGreaterThan(0);

  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  expect(health.ok).toBe(true);
  expect(((await health.json()) as { ok: boolean }).ok).toBe(true);

  const app = await fetch(`http://127.0.0.1:${port}/`);
  expect(await app.text()).toContain('<div id="root"></div>');

  for (const headers of [
    { "content-type": "text/plain", Origin: "https://attacker.example" },
    { "content-type": "text/plain" },
  ]) {
    const forbidden = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cwd: tempDir }),
    });
    expect(forbidden.status).toBe(403);
  }
  const forbiddenTailscale = await fetch(
    `http://127.0.0.1:${port}/api/tailscale`,
    {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({ enabled: false }),
    },
  );
  expect(forbiddenTailscale.status).toBe(403);

  const reboundOrigin = await fetch(`http://127.0.0.1:${port}/api/tailscale`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Host: "attacker.example",
      Origin: "https://attacker.example",
    },
    body: JSON.stringify({ enabled: false }),
  });
  expect(reboundOrigin.status).toBe(403);

  const trustedLocalOrigin = await fetch(
    `http://127.0.0.1:${port}/api/tailscale`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ enabled: false, httpsPort: 443 }),
    },
  );
  expect(trustedLocalOrigin.status).toBe(200);

  const snapshot = (await websocketSnapshot(
    `ws://127.0.0.1:${port}/ws/client`,
  )) as {
    type: string;
    sessions: unknown[];
  };
  expect(snapshot.type).toBe("server.snapshot");
  expect(Array.isArray(snapshot.sessions)).toBe(true);

  for (const [path, origin] of [
    ["/ws/client", "https://attacker.example"],
    ["/ws/agent", `http://127.0.0.1:${port}`],
  ] as const) {
    await new Promise<void>((resolve, reject) => {
      const untrusted = browserSocket(`ws://127.0.0.1:${port}${path}`, origin);
      const timeout = setTimeout(
        () => reject(new Error(`browser origin was accepted by ${path}`)),
        1_000,
      );
      untrusted.onopen = () => {
        clearTimeout(timeout);
        untrusted.close();
        reject(new Error(`browser origin was accepted by ${path}`));
      };
      untrusted.onerror = () => {
        clearTimeout(timeout);
        resolve();
      };
      untrusted.onclose = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
  }
  await new Promise<void>((resolve, reject) => {
    const forwarded = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, {
      headers: { "X-Forwarded-Host": "pi-web.example.ts.net" },
    } as unknown as string[]);
    const timeout = setTimeout(
      () => reject(new Error("forwarded agent websocket did not close")),
      1_000,
    );
    forwarded.onopen = () => {
      clearTimeout(timeout);
      forwarded.close();
      reject(new Error("forwarded agent websocket was accepted"));
    };
    forwarded.onerror = () => {
      clearTimeout(timeout);
      resolve();
    };
    forwarded.onclose = () => {
      clearTimeout(timeout);
      resolve();
    };
  });

  const sessionId = `semantic-${crypto.randomUUID()}`;
  const managedWorktree = {
    path: join(tempDir, "worktree"),
    repoRoot: tempDir,
    name: "worktree",
    branch: "feature",
    branchCreated: false,
  };
  const nativeSession: WebSession = {
    id: sessionId,
    cwd: tempDir,
    status: "idle",
    source: "tui",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: 1,
  };
  const agent = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
  await new Promise<void>((resolve, reject) => {
    agent.onopen = () => {
      agent.send(
        JSON.stringify({
          type: "agent.hello",
          session: nativeSession,
          entries: [
            {
              id: "entry-1",
              type: "message",
              message: { role: "user", content: "semantic history" },
            },
            {
              id: "worktree-1",
              type: "custom",
              customType: WORKTREE_SESSION_ENTRY,
              data: managedWorktree,
            },
          ],
        }),
      );
      resolve();
    };
    agent.onerror = () => reject(new Error("native agent websocket failed"));
  });
  await Bun.sleep(25);
  const history = await semanticHistory(
    `ws://127.0.0.1:${port}/ws/client`,
    sessionId,
  );
  expect(history).toHaveLength(1);
  const updated = await nativeUpdatePayload(
    `ws://127.0.0.1:${port}/ws/client`,
    sessionId,
    agent,
    {
      ...nativeSession,
      updatedAt: Date.now() + 1,
      messageCount: 2,
    },
  );
  expect(updated.managedWorktree).toEqual(managedWorktree);
  expect(
    await nativeLifecycleStatuses(
      `ws://127.0.0.1:${port}/ws/client`,
      sessionId,
      agent,
    ),
  ).toEqual(["working", "idle", "idle"]);
  agent.close();
}, 15_000);

async function queuedFollowUpDeliveryOrder(
  url: string,
  sessionId: string,
  agent: WebSocket,
  completionEvent: "agent_settled" | "agent_end" = "agent_settled",
): Promise<string[]> {
  const order: string[] = [];
  let deliveryStarted = false;
  let settledSent = false;
  agent.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)) as {
      type?: string;
      requestId?: string;
      command?: { type?: string; message?: string };
    };
    if (
      message.type !== "agent.command" ||
      message.command?.type !== "prompt" ||
      !message.requestId
    )
      return;
    order.push(
      deliveryStarted ? "prompt-after-transcript" : "prompt-before-transcript",
    );
    agent.send(
      JSON.stringify({
        type: "agent.response",
        requestId: message.requestId,
        success: true,
      }),
    );
  };
  return await new Promise((resolve, reject) => {
    const socket = browserSocket(url);
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("queued delivery transition timed out"));
    }, 10_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        event?: {
          type?: string;
          phase?: string;
          item?: { id?: string };
          queue?: unknown[];
        };
      };
      if (message.type === "server.snapshot") {
        socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
        socket.send(
          JSON.stringify({
            type: "client.prompt",
            requestId,
            sessionId,
            message: "queued transcript message",
            streamingBehavior: "followUp",
          }),
        );
      }
      if (message.type !== "server.event") return;
      if (
        message.event?.type === "web_queue_update" &&
        message.event.queue?.length === 1 &&
        !settledSent
      ) {
        settledSent = true;
        if (completionEvent === "agent_settled") {
          agent.send(
            JSON.stringify({
              type: "agent.event",
              sessionId,
              event: { type: "agent_end" },
            }),
          );
        }
        agent.send(
          JSON.stringify({
            type: "agent.event",
            sessionId,
            event: { type: completionEvent },
          }),
        );
      }
      if (
        message.event?.type === "web_queue_delivery" &&
        message.event.phase === "started"
      ) {
        deliveryStarted = true;
        order.push("transcript");
      }
      if (
        message.event?.type === "web_queue_update" &&
        settledSent &&
        message.event.queue?.length === 0
      ) {
        order.push("queue-cleared");
        clearTimeout(timeout);
        socket.close();
        resolve(order);
      }
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("queued delivery websocket failed"));
    };
  });
}

async function stoppedOverflowCompactionDeliversQueuedFollowUp(
  url: string,
  sessionId: string,
  agent: WebSocket,
): Promise<string | undefined> {
  let behavior: string | undefined;
  let lifecycleSent = false;
  agent.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)) as {
      type?: string;
      requestId?: string;
      command?: { type?: string; streamingBehavior?: string };
    };
    if (
      message.type !== "agent.command" ||
      message.command?.type !== "prompt" ||
      !message.requestId
    )
      return;
    behavior = message.command.streamingBehavior;
    agent.send(
      JSON.stringify({
        type: "agent.response",
        requestId: message.requestId,
        success: true,
      }),
    );
  };
  return await new Promise((resolve, reject) => {
    const socket = browserSocket(url);
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("stopped compaction did not advance the queue"));
    }, 10_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        event?: { type?: string; queue?: unknown[] };
      };
      if (message.type === "server.snapshot") {
        socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
        socket.send(
          JSON.stringify({
            type: "client.prompt",
            requestId,
            sessionId,
            message: "run after stopped compaction",
            streamingBehavior: "followUp",
          }),
        );
      }
      if (
        message.event?.type === "web_queue_update" &&
        message.event.queue?.length === 1 &&
        !lifecycleSent
      ) {
        lifecycleSent = true;
        agent.send(
          JSON.stringify({
            type: "agent.event",
            sessionId,
            event: {
              type: "compaction_start",
              reason: "overflow",
              willRetry: true,
            },
          }),
        );
        agent.send(
          JSON.stringify({
            type: "agent.event",
            sessionId,
            event: {
              type: "compaction_end",
              reason: "overflow",
              aborted: false,
              willRetry: true,
            },
          }),
        );
        // Stopping the aborted turn can prevent the advertised retry from
        // starting, leaving agent_settled as the authoritative idle boundary.
        agent.send(
          JSON.stringify({
            type: "agent.event",
            sessionId,
            event: { type: "agent_settled" },
          }),
        );
      }
      if (
        lifecycleSent &&
        behavior &&
        message.event?.type === "web_queue_update" &&
        message.event.queue?.length === 0
      ) {
        clearTimeout(timeout);
        socket.close();
        resolve(behavior);
      }
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("stopped compaction queue websocket failed"));
    };
  });
}

async function steerQueuedFollowUpNow(
  url: string,
  sessionId: string,
  agent: WebSocket,
): Promise<{
  behavior?: string;
  transcriptBeforePrompt: boolean;
  queueCleared: boolean;
}> {
  let deliveryStarted = false;
  let deliveryStartedWhenPrompted = false;
  let behavior: string | undefined;
  agent.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)) as {
      type?: string;
      requestId?: string;
      command?: { type?: string; streamingBehavior?: string };
    };
    if (
      message.type !== "agent.command" ||
      message.command?.type !== "prompt" ||
      !message.requestId
    )
      return;
    behavior = message.command.streamingBehavior;
    deliveryStartedWhenPrompted = deliveryStarted;
    agent.send(
      JSON.stringify({
        type: "agent.response",
        requestId: message.requestId,
        success: true,
      }),
    );
  };
  return await new Promise((resolve, reject) => {
    const socket = browserSocket(url);
    const queueRequestId = crypto.randomUUID();
    const steerRequestId = crypto.randomUUID();
    let steerSent = false;
    let steerSucceeded = false;
    let queueCleared = false;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("immediate queued steer timed out"));
    }, 10_000);
    const finish = () => {
      if (!steerSucceeded || !queueCleared || !behavior) return;
      clearTimeout(timeout);
      socket.close();
      resolve({
        behavior,
        transcriptBeforePrompt: deliveryStartedWhenPrompted,
        queueCleared,
      });
    };
    socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        requestId?: string;
        success?: boolean;
        event?: {
          type?: string;
          phase?: string;
          queue?: Array<{ id?: string }>;
        };
      };
      if (message.type === "server.snapshot") {
        socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
        socket.send(
          JSON.stringify({
            type: "client.prompt",
            requestId: queueRequestId,
            sessionId,
            message: "steer this now",
            streamingBehavior: "followUp",
          }),
        );
      }
      if (
        message.event?.type === "web_queue_update" &&
        message.event.queue?.some((item) => item.id === queueRequestId) &&
        !steerSent
      ) {
        steerSent = true;
        socket.send(
          JSON.stringify({
            type: "client.command",
            requestId: steerRequestId,
            sessionId,
            command: { type: "steer_queue_item", itemId: queueRequestId },
          }),
        );
      }
      if (
        message.event?.type === "web_queue_delivery" &&
        message.event.phase === "started"
      )
        deliveryStarted = true;
      if (
        steerSent &&
        message.event?.type === "web_queue_update" &&
        message.event.queue?.length === 0
      ) {
        queueCleared = true;
        finish();
      }
      if (
        message.type === "server.response" &&
        message.requestId === steerRequestId
      ) {
        if (message.success === false) {
          clearTimeout(timeout);
          socket.close();
          reject(new Error("queued steer was rejected"));
          return;
        }
        steerSucceeded = true;
        finish();
      }
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("immediate queued steer websocket failed"));
    };
  });
}

async function idleQueueReplacementStartsAutomatically(
  url: string,
  sessionId: string,
  agent: WebSocket,
): Promise<string | undefined> {
  let behavior: string | undefined;
  return await new Promise((resolve, reject) => {
    const socket = browserSocket(url);
    const requestId = crypto.randomUUID();
    let replaced = false;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("idle replacement queue timed out"));
    }, 10_000);
    agent.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        requestId?: string;
        command?: { type?: string; streamingBehavior?: string };
      };
      if (
        message.type !== "agent.command" ||
        message.command?.type !== "prompt" ||
        !message.requestId
      )
        return;
      behavior = message.command.streamingBehavior;
      agent.send(
        JSON.stringify({
          type: "agent.response",
          requestId: message.requestId,
          success: true,
        }),
      );
    };
    socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        session?: { id?: string; status?: string };
        event?: { type?: string; queue?: unknown[] };
      };
      if (message.type === "server.snapshot")
        socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
      if (message.type === "server.history") {
        agent.send(
          JSON.stringify({
            type: "agent.event",
            sessionId,
            event: { type: "agent_end" },
          }),
        );
        agent.send(
          JSON.stringify({
            type: "agent.event",
            sessionId,
            event: { type: "agent_settled" },
          }),
        );
      }
      if (
        !replaced &&
        message.type === "server.session" &&
        message.session?.id === sessionId &&
        message.session.status === "idle"
      ) {
        replaced = true;
        socket.send(
          JSON.stringify({
            type: "client.command",
            requestId,
            sessionId,
            command: {
              type: "replace_queue",
              queue: [{ id: "idle-replacement", message: "deliver from idle" }],
            },
          }),
        );
      }
      if (
        replaced &&
        message.event?.type === "web_queue_update" &&
        message.event.queue?.length === 0
      ) {
        clearTimeout(timeout);
        socket.close();
        resolve(behavior);
      }
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("idle replacement queue websocket failed"));
    };
  });
}

async function rejectedPromptPreservesLegacyQueueFallback(
  url: string,
  sessionId: string,
  agent: WebSocket,
): Promise<string | undefined> {
  let queuedBehavior: string | undefined;
  return await new Promise((resolve, reject) => {
    const socket = browserSocket(url);
    const queueRequestId = crypto.randomUUID();
    const rejectedRequestId = crypto.randomUUID();
    let completionSent = false;
    let rejectionSent = false;
    let rejectionObserved = false;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("rejected prompt queue fallback timed out"));
    }, 10_000);
    agent.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        requestId?: string;
        command?: {
          type?: string;
          message?: string;
          streamingBehavior?: string;
        };
      };
      if (
        message.type !== "agent.command" ||
        message.command?.type !== "prompt" ||
        !message.requestId
      )
        return;
      if (message.command.message === "reject during grace") {
        // Settlement belongs to the run that emitted agent_end, not this admitted
        // prompt. Its later rejection must still roll back optimistic working state.
        agent.send(
          JSON.stringify({
            type: "agent.event",
            sessionId,
            event: { type: "agent_settled" },
          }),
        );
        setTimeout(
          () =>
            agent.send(
              JSON.stringify({
                type: "agent.response",
                requestId: message.requestId,
                success: false,
                error: "rejected for test",
              }),
            ),
          10,
        );
      } else if (message.command.message === "deliver despite rejection") {
        queuedBehavior = message.command.streamingBehavior;
        agent.send(
          JSON.stringify({
            type: "agent.response",
            requestId: message.requestId,
            success: true,
          }),
        );
      }
    };
    socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        requestId?: string;
        success?: boolean;
        session?: { id?: string; status?: string };
        event?: { type?: string; queue?: unknown[] };
      };
      if (message.type === "server.snapshot") {
        socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
        socket.send(
          JSON.stringify({
            type: "client.prompt",
            requestId: queueRequestId,
            sessionId,
            message: "deliver despite rejection",
            streamingBehavior: "followUp",
          }),
        );
      }
      if (
        message.event?.type === "web_queue_update" &&
        message.event.queue?.length === 1 &&
        !completionSent
      ) {
        completionSent = true;
        agent.send(
          JSON.stringify({
            type: "agent.event",
            sessionId,
            event: { type: "agent_end" },
          }),
        );
      }
      if (
        completionSent &&
        !rejectionSent &&
        message.type === "server.session" &&
        message.session?.id === sessionId &&
        message.session.status === "idle"
      ) {
        rejectionSent = true;
        socket.send(
          JSON.stringify({
            type: "client.prompt",
            requestId: rejectedRequestId,
            sessionId,
            message: "reject during grace",
          }),
        );
      }
      if (
        message.type === "server.response" &&
        message.requestId === rejectedRequestId &&
        message.success === false
      )
        rejectionObserved = true;
      if (
        rejectionObserved &&
        message.event?.type === "web_queue_update" &&
        message.event.queue?.length === 0
      ) {
        clearTimeout(timeout);
        socket.close();
        resolve(queuedBehavior);
      }
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("rejected prompt queue fallback websocket failed"));
    };
  });
}

async function lateSettlementDoesNotBurstQueue(
  url: string,
  sessionId: string,
  agent: WebSocket,
): Promise<number[]> {
  const promptCounts: number[] = [];
  let promptCount = 0;
  return await new Promise((resolve, reject) => {
    const socket = browserSocket(url);
    const replaceRequestId = crypto.randomUUID();
    let completionSent = false;
    let secondCompletionSent = false;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("late settlement queue test timed out"));
    }, 10_000);
    agent.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        requestId?: string;
        command?: { type?: string };
      };
      if (
        message.type !== "agent.command" ||
        message.command?.type !== "prompt" ||
        !message.requestId
      )
        return;
      promptCount += 1;
      agent.send(
        JSON.stringify({
          type: "agent.response",
          requestId: message.requestId,
          success: true,
        }),
      );
      if (promptCount === 1) {
        setTimeout(
          () =>
            agent.send(
              JSON.stringify({
                type: "agent.event",
                sessionId,
                event: { type: "agent_settled" },
              }),
            ),
          10,
        );
        setTimeout(() => {
          promptCounts.push(promptCount);
          secondCompletionSent = true;
          agent.send(
            JSON.stringify({
              type: "agent.event",
              sessionId,
              event: { type: "agent_end" },
            }),
          );
        }, 160);
      }
    };
    socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        requestId?: string;
        success?: boolean;
        event?: { type?: string; queue?: unknown[] };
      };
      if (message.type === "server.snapshot") {
        socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
        socket.send(
          JSON.stringify({
            type: "client.command",
            requestId: replaceRequestId,
            sessionId,
            command: {
              type: "replace_queue",
              queue: [
                { id: "late-1", message: "first" },
                { id: "late-2", message: "second" },
              ],
            },
          }),
        );
      }
      if (
        message.event?.type === "web_queue_update" &&
        message.event.queue?.length === 2 &&
        !completionSent
      ) {
        completionSent = true;
        agent.send(
          JSON.stringify({
            type: "agent.event",
            sessionId,
            event: { type: "agent_end" },
          }),
        );
      }
      if (
        secondCompletionSent &&
        message.event?.type === "web_queue_update" &&
        message.event.queue?.length === 0
      ) {
        promptCounts.push(promptCount);
        clearTimeout(timeout);
        socket.close();
        resolve(promptCounts);
      }
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("late settlement queue websocket failed"));
    };
  });
}

async function promptAdmissionStatus(
  url: string,
  sessionId: string,
  agent: WebSocket,
): Promise<string[]> {
  const statuses: string[] = [];
  agent.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)) as {
      type?: string;
      requestId?: string;
      command?: { type?: string };
    };
    if (
      message.type === "agent.command" &&
      message.command?.type === "prompt" &&
      message.requestId
    ) {
      agent.send(
        JSON.stringify({
          type: "agent.response",
          requestId: message.requestId,
          success: true,
        }),
      );
    }
  };
  return await new Promise((resolve, reject) => {
    const socket = browserSocket(url);
    const requestId = crypto.randomUUID();
    let prompted = false;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("prompt admission status timed out"));
    }, 10_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        requestId?: string;
        success?: boolean;
        session?: { id?: string; status?: string };
      };
      if (message.type === "server.snapshot")
        socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
      if (message.type === "server.history") {
        agent.send(
          JSON.stringify({
            type: "agent.event",
            sessionId,
            event: { type: "agent_end" },
          }),
        );
        agent.send(
          JSON.stringify({
            type: "agent.event",
            sessionId,
            event: { type: "agent_settled" },
          }),
        );
      }
      if (
        message.type === "server.session" &&
        message.session?.id === sessionId &&
        message.session.status === "idle" &&
        !prompted
      ) {
        prompted = true;
        statuses.push("idle");
        socket.send(
          JSON.stringify({
            type: "client.prompt",
            requestId,
            sessionId,
            message: "start immediately",
          }),
        );
      } else if (
        prompted &&
        message.type === "server.session" &&
        message.session?.id === sessionId &&
        message.session.status === "working"
      ) {
        if (statuses.at(-1) !== "working") statuses.push("working");
      }
      if (
        message.type === "server.response" &&
        message.requestId === requestId
      ) {
        clearTimeout(timeout);
        socket.close();
        if (!message.success) reject(new Error("prompt admission failed"));
        else resolve(statuses);
      }
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("prompt admission websocket failed"));
    };
  });
}

async function promptAcknowledgementLossBecomesUncertain(
  url: string,
  sessionId: string,
  agent: WebSocket,
): Promise<boolean> {
  return await new Promise((resolve, reject) => {
    const socket = browserSocket(url);
    const requestId = crypto.randomUUID();
    let completionSent = false;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("prompt acknowledgement uncertainty timed out"));
    }, 10_000);
    agent.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        requestId?: string;
        command?: { type?: string };
      };
      // This deliberately destroys the shared agent connection and must remain the
      // final helper in the aggregated native-session test below.
      if (
        message.type === "agent.command" &&
        message.command?.type === "prompt" &&
        message.requestId
      )
        agent.close();
    };
    socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        event?: {
          type?: string;
          phase?: string;
          queue?: Array<{ deliveryState?: string }>;
        };
      };
      if (message.type === "server.snapshot") {
        socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
        socket.send(
          JSON.stringify({
            type: "client.prompt",
            requestId,
            sessionId,
            message: "do not redeliver",
            streamingBehavior: "followUp",
          }),
        );
      }
      if (
        message.event?.type === "web_queue_update" &&
        message.event.queue?.length === 1 &&
        !completionSent
      ) {
        completionSent = true;
        agent.send(
          JSON.stringify({
            type: "agent.event",
            sessionId,
            event: { type: "agent_end" },
          }),
        );
        agent.send(
          JSON.stringify({
            type: "agent.event",
            sessionId,
            event: { type: "agent_settled" },
          }),
        );
      }
      if (
        message.event?.type === "web_queue_delivery" &&
        message.event.phase === "uncertain"
      ) {
        clearTimeout(timeout);
        socket.close();
        resolve(true);
      }
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("prompt acknowledgement uncertainty websocket failed"));
    };
  });
}

async function compactionLifecycle(
  url: string,
  sessionId: string,
  agent: WebSocket,
): Promise<{
  states: Array<{ reason?: string; status: string }>;
  historyReset: boolean;
  completionNotice: string | undefined;
}> {
  return await new Promise((resolve, reject) => {
    const states: Array<{ reason?: string; status: string }> = [];
    let historyReset = false;
    let completionNotice: string | undefined;
    const socket = browserSocket(url);
    let started = false;
    let ended = false;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("compaction lifecycle timed out"));
    }, 10_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        sessionId?: string;
        replace?: boolean;
        entries?: Array<{ id?: string; message?: { content?: unknown } }>;
        event?: {
          type?: string;
          message?: { content?: Array<{ type?: string; text?: string }> };
        };
        session?: {
          id?: string;
          status?: string;
          compaction?: { reason?: string };
        };
      };
      if (message.type === "server.snapshot")
        socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
      if (
        message.type === "server.history" &&
        message.sessionId === sessionId &&
        !started
      ) {
        started = true;
        agent.send(
          JSON.stringify({
            type: "agent.event",
            sessionId,
            event: {
              type: "compaction_start",
              reason: "overflow",
              startedAt: Date.now(),
              willRetry: true,
            },
          }),
        );
      }
      if (
        message.type === "server.history" &&
        message.sessionId === sessionId &&
        message.replace &&
        message.entries?.some(
          (entry) => entry.id === "web-compaction-compact-1",
        )
      ) {
        const serialized = JSON.stringify(message.entries);
        historyReset =
          serialized.includes("compacted summary") &&
          serialized.includes("after compaction") &&
          !serialized.includes("before compaction");
        return;
      }
      if (
        message.type === "server.event" &&
        message.event?.type === "message_end"
      ) {
        completionNotice = message.event.message?.content?.find(
          (part) => part.type === "text",
        )?.text;
      }
      if (
        message.type !== "server.session" ||
        message.session?.id !== sessionId ||
        typeof message.session.status !== "string"
      )
        return;
      if (message.session.compaction?.reason === "overflow" && !ended) {
        states.push({
          reason: message.session.compaction.reason,
          status: message.session.status,
        });
        ended = true;
        agent.send(
          JSON.stringify({
            type: "agent.history",
            sessionId,
            entries: [
              {
                type: "message",
                id: "old-1",
                message: { role: "assistant", content: "before compaction" },
              },
              {
                type: "compaction",
                id: "compact-1",
                timestamp: new Date().toISOString(),
                summary: "compacted summary",
              },
              {
                type: "message",
                id: "new-1",
                message: { role: "user", content: "after compaction" },
              },
            ],
          }),
        );
        agent.send(
          JSON.stringify({
            type: "agent.event",
            sessionId,
            event: {
              type: "compaction_end",
              reason: "overflow",
              aborted: false,
              willRetry: false,
            },
          }),
        );
      } else if (ended && !message.session.compaction) {
        states.push({ status: message.session.status });
        clearTimeout(timeout);
        socket.close();
        resolve({ states, historyReset, completionNotice });
      }
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("compaction lifecycle websocket failed"));
    };
  });
}

function waitForSemanticHistory(
  url: string,
  sessionId: string,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const socket = browserSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("semantic history timed out"));
    }, 10_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        sessionId?: string;
        entries?: unknown[];
      };
      if (message.type === "server.snapshot")
        socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
      if (
        message.type === "server.history" &&
        message.sessionId === sessionId
      ) {
        clearTimeout(timeout);
        socket.close();
        resolve(message.entries ?? []);
      }
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("semantic websocket failed"));
    };
  });
}

test("TUI metadata changes update every connected web catalog", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-live-tui-metadata-test-"));
  const agentDir = join(tempDir, "pi-agent");
  const sessionsDir = join(agentDir, "sessions", "project");
  const statePath = join(tempDir, "web", "server.json");
  const fakeBin = join(tempDir, "bin");
  const prMetadataFile = join(tempDir, "pr.json");
  const selectedId = `selected-${crypto.randomUUID()}`;
  const tuiId = `tui-${crypto.randomUUID()}`;
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(
    join(sessionsDir, `${selectedId}.jsonl`),
    `${JSON.stringify({ type: "session", version: 3, id: selectedId, cwd: tempDir, timestamp: new Date().toISOString() })}\n`,
  );
  await writeFile(
    prMetadataFile,
    JSON.stringify({
      number: 1,
      url: "https://github.com/Vessup/pi-kit/pull/1",
    }),
  );
  const fakeGh = join(fakeBin, "gh");
  await writeFile(fakeGh, `#!/bin/sh\ncat ${JSON.stringify(prMetadataFile)}\n`);
  await chmod(fakeGh, 0o755);
  child = Bun.spawn({
    cmd: ["bun", "run", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: agentDir,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);
  const client = browserSocket(`ws://127.0.0.1:${port}/ws/client`);
  const agent = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
  const agentOpened = new Promise<void>((resolve, reject) => {
    agent.onopen = () => resolve();
    agent.onerror = () => reject(new Error("TUI metadata agent socket failed"));
  });
  const tuiSession = {
    id: tuiId,
    cwd: tempDir,
    name: "Before rename",
    status: "idle" as const,
    source: "tui" as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: 0,
    pullRequest: { number: 1, url: "https://github.com/Vessup/pi-kit/pull/1" },
  };
  let resolveSnapshot!: () => void;
  let resolveSubscribed!: () => void;
  let resolveRegistered!: () => void;
  let resolveRenamed!: () => void;
  let resolveBranch!: () => void;
  let resolvePullRequest!: () => void;
  let resolveCompletedPullRequest!: () => void;
  let resolveWorking!: () => void;
  let resolveIdle!: () => void;
  let resolvePreview!: () => void;
  let resolveCompactionStarted!: () => void;
  let resolveCompactionEnded!: () => void;
  const snapshot = new Promise<void>((resolve) => {
    resolveSnapshot = resolve;
  });
  const subscribed = new Promise<void>((resolve) => {
    resolveSubscribed = resolve;
  });
  const registered = new Promise<void>((resolve) => {
    resolveRegistered = resolve;
  });
  const renamed = new Promise<void>((resolve) => {
    resolveRenamed = resolve;
  });
  const branchUpdated = new Promise<void>((resolve) => {
    resolveBranch = resolve;
  });
  const pullRequestUpdated = new Promise<void>((resolve) => {
    resolvePullRequest = resolve;
  });
  const completedPullRequestUpdated = new Promise<void>((resolve) => {
    resolveCompletedPullRequest = resolve;
  });
  const working = new Promise<void>((resolve) => {
    resolveWorking = resolve;
  });
  const idle = new Promise<void>((resolve) => {
    resolveIdle = resolve;
  });
  const previewUpdated = new Promise<void>((resolve) => {
    resolvePreview = resolve;
  });
  const compactionStarted = new Promise<void>((resolve) => {
    resolveCompactionStarted = resolve;
  });
  const compactionEnded = new Promise<void>((resolve) => {
    resolveCompactionEnded = resolve;
  });
  let observedWorking = false;
  let observedCompaction = false;
  let timeout: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      client.close();
      agent.close();
      reject(new Error("TUI metadata did not propagate to the web catalog"));
    }, 5_000);
  });
  client.onopen = () => client.send(JSON.stringify({ type: "client.hello" }));
  client.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)) as {
      type?: string;
      sessionId?: string;
      session?: {
        id?: string;
        name?: string;
        branch?: string;
        status?: string;
        preview?: string;
        pullRequest?: { number?: number };
        compaction?: { reason?: string };
      };
    };
    if (message.type === "server.snapshot") resolveSnapshot();
    if (message.type === "server.history" && message.sessionId === selectedId)
      resolveSubscribed();
    if (message.type !== "server.session" || message.session?.id !== tuiId)
      return;
    if (message.session.name === "Before rename") resolveRegistered();
    if (message.session.name === "Renamed in TUI") resolveRenamed();
    if (message.session.branch === "feature/live-metadata") resolveBranch();
    if (message.session.pullRequest?.number === 3) resolvePullRequest();
    if (message.session.pullRequest?.number === 4)
      resolveCompletedPullRequest();
    if (message.session.status === "working" && !message.session.compaction) {
      observedWorking = true;
      resolveWorking();
    }
    if (
      observedWorking &&
      message.session.status === "idle" &&
      !message.session.compaction
    )
      resolveIdle();
    if (
      message.session.name === "Preview barrier" &&
      message.session.preview === "Latest assistant preview"
    )
      resolvePreview();
    if (
      message.session.status === "working" &&
      message.session.compaction?.reason === "overflow"
    ) {
      observedCompaction = true;
      resolveCompactionStarted();
    }
    if (
      observedCompaction &&
      message.session.status === "idle" &&
      !message.session.compaction
    )
      resolveCompactionEnded();
  };
  try {
    await Promise.race([snapshot, timedOut]);
    await Promise.race([agentOpened, timedOut]);
    // Register before subscribing. Catalog sockets must not miss sessions created
    // in the gap between their snapshot and selected-session subscription.
    agent.send(
      JSON.stringify({ type: "agent.hello", session: tuiSession, entries: [] }),
    );
    await Promise.race([registered, timedOut]);
    client.send(
      JSON.stringify({ type: "client.subscribe", sessionId: selectedId }),
    );
    await Promise.race([subscribed, timedOut]);
    agent.send(
      JSON.stringify({
        type: "agent.event",
        sessionId: tuiId,
        event: { type: "session_info_changed", name: "Renamed in TUI" },
      }),
    );
    await Promise.race([renamed, timedOut]);
    await writeFile(
      prMetadataFile,
      JSON.stringify({
        number: 3,
        url: "https://github.com/Vessup/pi-kit/pull/3",
      }),
    );
    agent.send(
      JSON.stringify({
        type: "agent.update",
        session: {
          ...tuiSession,
          name: "Renamed in TUI",
          branch: "feature/live-metadata",
          updatedAt: Date.now(),
        },
      }),
    );
    await Promise.race([branchUpdated, timedOut]);
    await Promise.race([pullRequestUpdated, timedOut]);
    agent.send(
      JSON.stringify({
        type: "agent.event",
        sessionId: tuiId,
        event: { type: "agent_start" },
      }),
    );
    await Promise.race([working, timedOut]);
    await writeFile(
      prMetadataFile,
      JSON.stringify({
        number: 4,
        url: "https://github.com/Vessup/pi-kit/pull/4",
      }),
    );
    agent.send(
      JSON.stringify({
        type: "agent.event",
        sessionId: tuiId,
        event: { type: "agent_end" },
      }),
    );
    await Promise.race([idle, timedOut]);
    await Promise.race([completedPullRequestUpdated, timedOut]);
    agent.send(
      JSON.stringify({
        type: "agent.event",
        sessionId: tuiId,
        event: {
          type: "message_end",
          message: { role: "assistant", content: "Latest assistant preview" },
        },
      }),
    );
    agent.send(
      JSON.stringify({
        type: "agent.update",
        session: {
          ...tuiSession,
          name: "Renamed in TUI",
          branch: "feature/live-metadata",
          preview: "Stale first preview",
          updatedAt: Date.now(),
        },
      }),
    );
    agent.send(
      JSON.stringify({
        type: "agent.event",
        sessionId: tuiId,
        event: { type: "session_info_changed", name: "Preview barrier" },
      }),
    );
    await Promise.race([previewUpdated, timedOut]);
    agent.send(
      JSON.stringify({
        type: "agent.event",
        sessionId: tuiId,
        event: {
          type: "compaction_start",
          reason: "overflow",
          startedAt: Date.now(),
        },
      }),
    );
    await Promise.race([compactionStarted, timedOut]);
    agent.send(
      JSON.stringify({
        type: "agent.event",
        sessionId: tuiId,
        event: { type: "compaction_end", aborted: false, willRetry: false },
      }),
    );
    await Promise.race([compactionEnded, timedOut]);
  } finally {
    clearTimeout(timeout);
    client.close();
    agent.close();
  }
}, 10_000);

test("managed sessions are published only after their runtime identity is final", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-final-managed-id-test-"));
  const fakeBin = join(tempDir, "bin");
  const project = join(tempDir, "project");
  const agentDir = join(tempDir, "pi-agent");
  const statePath = join(tempDir, "web", "server.json");
  const finalId = `final-${crypto.randomUUID()}`;
  const startupStartedFile = join(tempDir, "startup-started");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(project, { recursive: true });
  const fakePi = join(fakeBin, "pi");
  await writeFile(
    fakePi,
    `#!/usr/bin/env bun
import { createInterface } from "node:readline";
const finalId = ${JSON.stringify(finalId)};
const startupStartedFile = ${JSON.stringify(startupStartedFile)};
let sessionFile;
let startupDelayed = false;
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  let data;
  if (request.type === "get_state") {
    if (!startupDelayed) {
      startupDelayed = true;
      await Bun.write(startupStartedFile, "started");
      await Bun.sleep(200);
    }
    data = { sessionId: finalId, sessionFile, messageCount: 0, isStreaming: false };
  } else if (request.type === "switch_session") {
    sessionFile = request.sessionPath;
  } else if (request.type === "get_entries") data = { entries: [], leafId: null };
  else if (request.type === "get_messages") data = { messages: [] };
  else if (request.type === "get_session_stats") data = {};
  process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data }) + "\\n");
}
`,
  );
  await chmod(fakePi, 0o755);
  child = Bun.spawn({
    cmd: ["bun", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: agentDir,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);
  const client = browserSocket(`ws://127.0.0.1:${port}/ws/client`);
  const publishedIds: string[] = [];
  let resolveSnapshot!: () => void;
  let resolveFinal!: () => void;
  const snapshot = new Promise<void>((resolve) => {
    resolveSnapshot = resolve;
  });
  const finalPublished = new Promise<void>((resolve) => {
    resolveFinal = resolve;
  });
  client.onopen = () => client.send(JSON.stringify({ type: "client.hello" }));
  client.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)) as {
      type?: string;
      session?: { id?: string; source?: string };
    };
    if (message.type === "server.snapshot") resolveSnapshot();
    if (message.type === "server.session" && message.session?.id) {
      publishedIds.push(message.session.id);
      if (message.session.id === finalId) resolveFinal();
    }
  };
  try {
    await Promise.race([
      snapshot,
      Bun.sleep(2_000).then(() => {
        throw new Error("managed identity observer did not receive a snapshot");
      }),
    ]);
    const creation = fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ cwd: project }),
    });
    const startupDeadline = Date.now() + 2_000;
    while (Date.now() < startupDeadline) {
      try {
        if ((await readFile(startupStartedFile, "utf8")) === "started") break;
      } catch {
        // The fake runtime has not received its first startup request yet.
      }
      await Bun.sleep(10);
    }
    expect(await readFile(startupStartedFile, "utf8")).toBe("started");
    const provisionalCatalog = (await fetch(
      `http://127.0.0.1:${port}/api/sessions`,
    ).then((result) => result.json())) as { sessions: Array<{ cwd: string }> };
    expect(
      provisionalCatalog.sessions.filter((session) => session.cwd === project),
    ).toEqual([]);
    const response = await creation;
    const body = await response.text();
    if (response.status !== 201)
      throw new Error(
        `Managed session creation failed with ${response.status}: ${body}`,
      );
    await Promise.race([
      finalPublished,
      Bun.sleep(2_000).then(() => {
        throw new Error(
          `final managed identity was not published; response=${body}; observed=${publishedIds.join(",")}`,
        );
      }),
    ]);
    await Bun.sleep(100);
    expect(publishedIds.length).toBeGreaterThan(0);
    expect(publishedIds.every((id) => id === finalId)).toBe(true);
  } finally {
    client.close();
  }
}, 10_000);

test("Stop acknowledges delivery without waiting for agent teardown", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-stop-ack-test-"));
  const statePath = join(tempDir, "web", "server.json");
  child = Bun.spawn({
    cmd: ["bun", "run", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: join(tempDir, "pi-agent"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);
  const sessionId = `stop-${crypto.randomUUID()}`;
  const agent = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
  let resolveAbortDelivered!: () => void;
  const abortDelivered = new Promise<void>((resolve) => {
    resolveAbortDelivered = resolve;
  });
  agent.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)) as {
      type?: string;
      command?: { type?: string };
    };
    if (message.type === "agent.command" && message.command?.type === "abort")
      resolveAbortDelivered();
    // Deliberately never acknowledge the agent command. The daemon should have
    // already acknowledged socket delivery to the browser.
  };
  await new Promise<void>((resolve, reject) => {
    agent.onopen = () => {
      agent.send(
        JSON.stringify({
          type: "agent.hello",
          session: {
            id: sessionId,
            cwd: tempDir,
            status: "working",
            source: "tui",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messageCount: 0,
          },
          entries: [],
        }),
      );
      resolve();
    };
    agent.onerror = () =>
      reject(new Error("Stop acknowledgement agent socket failed"));
  });
  const registrationDeadline = Date.now() + 3_000;
  while (Date.now() < registrationDeadline) {
    const catalog = (await fetch(`http://127.0.0.1:${port}/api/sessions`).then(
      (response) => response.json(),
    )) as { sessions: Array<{ id: string }> };
    if (catalog.sessions.some((session) => session.id === sessionId)) break;
    await Bun.sleep(25);
  }
  try {
    const result = await Promise.race([
      sessionCommand(`ws://127.0.0.1:${port}/ws/client`, sessionId, {
        type: "abort",
      }),
      Bun.sleep(2_000).then(() => {
        throw new Error("Stop waited for agent teardown");
      }),
    ]);
    expect(result).toEqual({ accepted: true });
    await Promise.race([
      abortDelivered,
      Bun.sleep(2_000).then(() => {
        throw new Error("Stop was acknowledged without being delivered");
      }),
    ]);
  } finally {
    agent.close();
  }
}, 10_000);

test("an idle native session flushes its restored web follow-up queue on hello", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-restored-queue-test-"));
  const statePath = join(tempDir, "web", "server.json");
  const sessionId = `restored-${crypto.randomUUID()}`;
  await mkdir(join(tempDir, "web"), { recursive: true });
  await writeFile(
    join(tempDir, "web", "queues.json"),
    JSON.stringify({
      version: 1,
      queues: {
        [sessionId]: [
          { id: "restored-follow-up", message: "deliver after reconnect" },
        ],
      },
    }),
  );
  child = Bun.spawn({
    cmd: ["bun", "run", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: join(tempDir, "pi-agent"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);
  const agent = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
  const delivered = new Promise<{
    type?: string;
    message?: string;
    streamingBehavior?: string;
  }>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("restored queue was not flushed after hello")),
      5_000,
    );
    agent.onmessage = ({ data }) => {
      const frame = JSON.parse(String(data)) as {
        type?: string;
        requestId?: string;
        command?: {
          type?: string;
          message?: string;
          streamingBehavior?: string;
        };
      };
      if (
        frame.type !== "agent.command" ||
        frame.command?.type !== "prompt" ||
        !frame.requestId
      )
        return;
      clearTimeout(timeout);
      agent.send(
        JSON.stringify({
          type: "agent.response",
          requestId: frame.requestId,
          success: true,
        }),
      );
      resolve(frame.command);
    };
    agent.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("native agent websocket failed"));
    };
  });
  await new Promise<void>((resolve, reject) => {
    agent.onopen = () => {
      agent.send(
        JSON.stringify({
          type: "agent.hello",
          session: {
            id: sessionId,
            cwd: tempDir,
            status: "idle",
            source: "tui",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messageCount: 0,
          },
          entries: [],
        }),
      );
      resolve();
    };
    agent.onerror = () => reject(new Error("native agent websocket failed"));
  });
  expect(await delivered).toEqual({
    type: "prompt",
    message: "deliver after reconnect",
    streamingBehavior: "followUp",
  });
  agent.close();
}, 10_000);

test("a visible client can resynchronize a durable queue after a missed reconnect update", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-queue-sync-test-"));
  const statePath = join(tempDir, "web", "server.json");
  const sessionId = `queue-sync-${crypto.randomUUID()}`;
  const expectedQueue = [
    { id: "still-durable", message: "remain visible after wake" },
  ];
  await mkdir(join(tempDir, "web"), { recursive: true });
  await writeFile(
    join(tempDir, "web", "queues.json"),
    JSON.stringify({ version: 2, queues: { [sessionId]: expectedQueue } }),
  );
  child = Bun.spawn({
    cmd: ["bun", "run", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: join(tempDir, "pi-agent"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);
  const agent = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
  await new Promise<void>((resolve, reject) => {
    agent.onopen = () => {
      agent.send(
        JSON.stringify({
          type: "agent.hello",
          session: {
            id: sessionId,
            cwd: tempDir,
            status: "working",
            source: "tui",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messageCount: 0,
          },
          entries: [],
        }),
      );
      resolve();
    };
    agent.onerror = () => reject(new Error("queue sync agent failed"));
  });
  const synchronized = await new Promise<unknown[]>((resolve, reject) => {
    const socket = browserSocket(`ws://127.0.0.1:${port}/ws/client`);
    let queueSnapshots = 0;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("queue resynchronization timed out"));
    }, 5_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
    socket.onmessage = ({ data }) => {
      const frame = JSON.parse(String(data)) as {
        type?: string;
        event?: { type?: string; queue?: unknown[] };
      };
      if (frame.type === "server.snapshot")
        socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
      if (frame.event?.type !== "web_queue_update") return;
      queueSnapshots++;
      if (queueSnapshots === 1)
        socket.send(
          JSON.stringify({
            type: "client.sync_queue",
            requestId: "wake-sync",
            sessionId,
          }),
        );
      else {
        clearTimeout(timeout);
        socket.close();
        resolve(frame.event.queue ?? []);
      }
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("queue sync client failed"));
    };
  });
  expect(synchronized).toEqual(expectedQueue);
  expect(await Bun.file(join(tempDir, "web", "queues.json")).json()).toEqual({
    version: 2,
    queues: { [sessionId]: expectedQueue },
  });
  agent.close();
}, 10_000);

test("restored uncertain delivery is never automatic and requires explicit reconciliation", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-uncertain-queue-test-"));
  const statePath = join(tempDir, "web", "server.json");
  const sessionId = `uncertain-${crypto.randomUUID()}`;
  await mkdir(join(tempDir, "web"), { recursive: true });
  await writeFile(
    join(tempDir, "web", "queues.json"),
    JSON.stringify({
      version: 2,
      queues: {
        [sessionId]: [
          {
            id: "maybe-sent",
            message: "perform once",
            deliveryState: "delivering",
          },
          { id: "following", message: "must remain blocked" },
        ],
      },
    }),
  );
  child = Bun.spawn({
    cmd: ["bun", "run", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: join(tempDir, "pi-agent"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);
  const agent = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
  let prompts = 0;
  agent.onmessage = ({ data }) => {
    const frame = JSON.parse(String(data)) as { command?: { type?: string } };
    if (frame.command?.type === "prompt") prompts++;
  };
  await new Promise<void>((resolve, reject) => {
    agent.onopen = () => {
      agent.send(
        JSON.stringify({
          type: "agent.hello",
          session: {
            id: sessionId,
            cwd: tempDir,
            status: "idle",
            source: "tui",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messageCount: 0,
          },
          entries: [],
        }),
      );
      resolve();
    };
    agent.onerror = () => reject(new Error("agent failed"));
  });
  const queuePath = join(tempDir, "web", "queues.json");
  const result = await new Promise<{
    uncertain: boolean;
    fabricatedRejected: boolean;
    rejected: boolean;
    persistenceRejected: boolean;
    unchangedRejected: boolean;
    queue: unknown[];
  }>((resolve, reject) => {
    const socket = browserSocket(`ws://127.0.0.1:${port}/ws/client`);
    let uncertain = false;
    let fabricatedRejected = false;
    let rejected = false;
    let persistenceRejected = false;
    let unchangedRejected = false;
    let tested = false;
    const timeout = setTimeout(
      () => reject(new Error("uncertain reconciliation timed out")),
      5000,
    );
    socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
    socket.onmessage = async ({ data }) => {
      const frame = JSON.parse(String(data)) as {
        type?: string;
        requestId?: string;
        success?: boolean;
        event?: { type?: string; phase?: string; queue?: unknown[] };
      };
      if (frame.type === "server.snapshot")
        socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
      if (
        frame.event?.type === "web_queue_delivery" &&
        frame.event.phase === "uncertain"
      )
        uncertain = true;
      if (
        !tested &&
        frame.event?.type === "web_queue_update" &&
        Array.isArray(frame.event.queue) &&
        frame.event.queue.length === 2
      ) {
        tested = true;
        socket.send(
          JSON.stringify({
            type: "client.command",
            requestId: "fabricated",
            sessionId,
            command: {
              type: "replace_queue",
              queue: [
                ...frame.event.queue,
                {
                  id: "fabricated",
                  message: "never sent",
                  deliveryState: "delivering",
                },
              ],
            },
          }),
        );
      }
      if (frame.requestId === "fabricated" && frame.success === false) {
        fabricatedRejected = true;
        socket.send(
          JSON.stringify({
            type: "client.command",
            requestId: "ordinary",
            sessionId,
            command: {
              type: "replace_queue",
              queue: [{ id: "following", message: "must remain blocked" }],
            },
          }),
        );
      }
      if (frame.requestId === "ordinary" && frame.success === false) {
        rejected = true;
        await rm(queuePath, { force: true });
        await mkdir(queuePath);
        socket.send(
          JSON.stringify({
            type: "client.command",
            requestId: "discard-fails",
            sessionId,
            command: {
              type: "reconcile_queue",
              itemId: "maybe-sent",
              action: "discard",
            },
          }),
        );
      }
      if (frame.requestId === "discard-fails" && frame.success === false) {
        persistenceRejected = true;
        socket.send(
          JSON.stringify({
            type: "client.command",
            requestId: "unchanged",
            sessionId,
            command: {
              type: "replace_queue",
              queue: [{ id: "following", message: "must remain blocked" }],
            },
          }),
        );
      }
      if (frame.requestId === "unchanged" && frame.success === false) {
        unchangedRejected = true;
        await rm(queuePath, { recursive: true, force: true });
        socket.send(
          JSON.stringify({
            type: "client.command",
            requestId: "discard",
            sessionId,
            command: {
              type: "reconcile_queue",
              itemId: "maybe-sent",
              action: "discard",
            },
          }),
        );
      }
      if (
        unchangedRejected &&
        frame.event?.type === "web_queue_update" &&
        frame.event.queue?.length === 1
      ) {
        clearTimeout(timeout);
        socket.close();
        resolve({
          uncertain,
          fabricatedRejected,
          rejected,
          persistenceRejected,
          unchangedRejected,
          queue: frame.event.queue,
        });
      }
    };
  });
  await Bun.sleep(100);
  expect(result.uncertain).toBe(true);
  expect(result.fabricatedRejected).toBe(true);
  expect(result.rejected).toBe(true);
  expect(result.persistenceRejected).toBe(true);
  expect(result.unchangedRejected).toBe(true);
  expect(result.queue).toEqual([
    { id: "following", message: "must remain blocked" },
  ]);
  expect(prompts).toBe(0);
  agent.close();
}, 10_000);

test("resuming a selected saved session keeps its existing client subscription", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-resume-subscription-test-"));
  const agentDir = join(tempDir, "pi-agent");
  const sessionsDir = join(agentDir, "sessions", "project");
  const project = join(tempDir, "project");
  const fakeBin = join(tempDir, "bin");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  const sessionId = `resume-${crypto.randomUUID()}`;
  const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
  const abortDeliveryFile = join(tempDir, "abort-delivered");
  await writeFile(
    sessionFile,
    `${[
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        cwd: project,
        timestamp: new Date().toISOString(),
      }),
      JSON.stringify({
        id: "saved-entry",
        type: "message",
        message: { role: "user", content: "saved history" },
      }),
    ].join("\n")}\n`,
  );
  const fakePi = join(fakeBin, "pi");
  await writeFile(
    fakePi,
    `#!/usr/bin/env bun
import { createInterface } from "node:readline";
const sessionId = ${JSON.stringify(sessionId)};
const sessionFile = ${JSON.stringify(sessionFile)};
const abortDeliveryFile = ${JSON.stringify(abortDeliveryFile)};
const entries = [{ id: "managed-entry", type: "message", message: { role: "assistant", content: "managed history" } }];
let reloadGeneration = 0;
let sessionName = "named session";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  let data;
  if (request.type === "get_state") data = { sessionId, sessionFile, sessionName, messageCount: entries.length, isStreaming: false };
  else if (request.type === "get_entries") data = { entries, leafId: "managed-entry" };
  else if (request.type === "get_messages") data = { messages: entries.map((entry) => entry.message) };
  else if (request.type === "get_session_stats") data = {};
  else if (request.type === "get_commands") data = { commands: [{ name: "web-reload", description: "generation-" + reloadGeneration, source: "extension", sourceInfo: { path: "web-sessions.ts", scope: "temporary" } }] };
  else if (request.type === "set_session_name") sessionName = request.name || null;
  else if (request.type === "prompt" && request.message === "/web-reload") reloadGeneration += 1;
  else if (request.type === "abort") {
    await Bun.write(abortDeliveryFile, "delivered");
    continue;
  }
  process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data }) + "\\n");
  if (request.type === "set_session_name") process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
}
`,
  );
  await chmod(fakePi, 0o755);
  const statePath = join(tempDir, "server.json");
  child = Bun.spawn({
    cmd: ["bun", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: agentDir,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);

  const socket = browserSocket(`ws://127.0.0.1:${port}/ws/client`);
  let initialHistory!: () => void;
  const subscribed = new Promise<void>((resolve) => {
    initialHistory = resolve;
  });
  const resumedHistory = new Promise<unknown[]>((resolve, reject) => {
    let historyFrames = 0;
    const timeout = setTimeout(() => {
      socket.close();
      reject(
        new Error("resumed session did not reach the existing subscriber"),
      );
    }, 5_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        sessionId?: string;
        entries?: unknown[];
      };
      if (message.type === "server.snapshot")
        socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
      if (message.type !== "server.history" || message.sessionId !== sessionId)
        return;
      historyFrames += 1;
      if (historyFrames === 1) initialHistory();
      if (historyFrames === 2) {
        clearTimeout(timeout);
        socket.close();
        resolve(message.entries ?? []);
      }
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("resume subscription websocket failed"));
    };
  });
  await subscribed;
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions/resume`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: `http://127.0.0.1:${port}`,
    },
    body: JSON.stringify({ file: sessionFile }),
  });
  const responseBody = await response.text();
  if (response.status !== 201)
    throw new Error(`Resume failed with ${response.status}: ${responseBody}`);
  const managedHistory = await resumedHistory;
  expect(managedHistory).toHaveLength(1);
  expect(managedHistory[0]).toMatchObject({
    type: "message",
    message: { role: "assistant", content: "managed history" },
  });
  const initialCatalog = (await fetch(
    `http://127.0.0.1:${port}/api/sessions`,
  ).then((result) => result.json())) as {
    sessions: Array<{ id: string; name?: string }>;
  };
  expect(
    initialCatalog.sessions.find((session) => session.id === sessionId)?.name,
  ).toBe("named session");
  await sessionCommand(`ws://127.0.0.1:${port}/ws/client`, sessionId, {
    type: "set_session_name",
    name: "",
  });
  let clearedName: string | undefined = "named session";
  const clearDeadline = Date.now() + 3_000;
  while (Date.now() < clearDeadline && clearedName !== undefined) {
    await Bun.sleep(25);
    const catalog = (await fetch(`http://127.0.0.1:${port}/api/sessions`).then(
      (result) => result.json(),
    )) as { sessions: Array<{ id: string; name?: string }> };
    clearedName = catalog.sessions.find(
      (session) => session.id === sessionId,
    )?.name;
  }
  expect(clearedName).toBeUndefined();

  const reloadResult = new Promise<{ response: unknown; confirmation: string }>(
    (resolve, reject) => {
      const reloadSocket = browserSocket(`ws://127.0.0.1:${port}/ws/client`);
      const requestId = crypto.randomUUID();
      let promptSent = false;
      let response: unknown;
      let confirmation: string | undefined;
      const timeout = setTimeout(() => {
        reloadSocket.close();
        reject(new Error("resumed managed reload timed out"));
      }, 5_000);
      const finish = () => {
        if (response === undefined || confirmation === undefined) return;
        clearTimeout(timeout);
        reloadSocket.close();
        resolve({ response, confirmation });
      };
      reloadSocket.onopen = () =>
        reloadSocket.send(JSON.stringify({ type: "client.hello" }));
      reloadSocket.onmessage = ({ data }) => {
        const message = JSON.parse(String(data)) as {
          type?: string;
          requestId?: string;
          success?: boolean;
          data?: unknown;
          error?: string;
          event?: {
            type?: string;
            message?: { content?: Array<{ type?: string; text?: string }> };
          };
        };
        if (message.type === "server.snapshot")
          reloadSocket.send(
            JSON.stringify({ type: "client.subscribe", sessionId }),
          );
        if (message.type === "server.history" && !promptSent) {
          promptSent = true;
          reloadSocket.send(
            JSON.stringify({
              type: "client.prompt",
              requestId,
              sessionId,
              message: "/reload",
              images: [],
            }),
          );
        }
        if (
          message.type === "server.event" &&
          message.event?.type === "message_end"
        ) {
          confirmation = message.event.message?.content?.find(
            (part) => part.type === "text",
          )?.text;
          finish();
        }
        if (
          message.type !== "server.response" ||
          message.requestId !== requestId
        )
          return;
        if (!message.success) {
          clearTimeout(timeout);
          reloadSocket.close();
          reject(new Error(message.error ?? "resumed managed reload failed"));
          return;
        }
        response = message.data;
        finish();
      };
    },
  );
  expect(await reloadResult).toEqual({
    response: { reloaded: true },
    confirmation: "Reload complete.",
  });
  const afterReload = (await fetch(
    `http://127.0.0.1:${port}/api/sessions`,
  ).then((result) => result.json())) as {
    sessions: Array<{ id: string; status: string }>;
  };
  expect(
    afterReload.sessions.find((session) => session.id === sessionId)?.status,
  ).toBe("idle");
  const abortResult = await Promise.race([
    sessionCommand(`ws://127.0.0.1:${port}/ws/client`, sessionId, {
      type: "abort",
    }),
    Bun.sleep(2_000).then(() => {
      throw new Error("managed Stop waited for an RPC response or refresh");
    }),
  ]);
  expect(abortResult).toEqual({ accepted: true });
  const deliveryDeadline = Date.now() + 2_000;
  while (Date.now() < deliveryDeadline) {
    try {
      if ((await readFile(abortDeliveryFile, "utf8")) === "delivered") break;
    } catch {
      // The fake runtime has not consumed the delivered frame yet.
    }
    await Bun.sleep(10);
  }
  expect(await readFile(abortDeliveryFile, "utf8")).toBe("delivered");

  const deleteStarted = performance.now();
  const origin = `http://127.0.0.1:${port}`;
  const deleted = await fetch(
    `${origin}/api/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "DELETE",
      headers: { Origin: origin },
    },
  );
  expect(deleted.status).toBe(200);
  expect(performance.now() - deleteStarted).toBeLessThan(2_000);
  await expect(readFile(sessionFile, "utf8")).rejects.toThrow();
}, 10_000);

test("managed RPC requests fail within the configured bound when Pi wedges", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-rpc-timeout-test-"));
  const fakeBin = join(tempDir, "bin");
  const project = join(tempDir, "project");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(project, { recursive: true });
  const fakePi = join(fakeBin, "pi");
  await writeFile(fakePi, "#!/bin/sh\nwhile IFS= read -r line; do :; done\n");
  await chmod(fakePi, 0o755);
  const statePath = join(tempDir, "server.json");
  child = Bun.spawn({
    cmd: ["bun", "run", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_WEB_RPC_TIMEOUT_MS: "50",
      PI_CODING_AGENT_DIR: join(tempDir, "pi-agent"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: `http://127.0.0.1:${port}`,
    },
    body: JSON.stringify({ cwd: project }),
  });
  expect(response.status).toBe(500);
  expect(await response.text()).toContain(
    "RPC command get_state timed out after 50ms",
  );
}, 10_000);

test("sessions deleted from the TUI are removed from the live web catalog", async () => {
  tempDir = await mkdtemp(
    join(tmpdir(), "pi-kit-external-session-delete-test-"),
  );
  const agentDir = join(tempDir, "pi-agent");
  const sessionsDir = join(agentDir, "sessions", "project");
  const webDir = join(tempDir, "web");
  const statePath = join(webDir, "server.json");
  const queuePath = join(webDir, "queues.json");
  const repository = join(tempDir, "repository");
  await mkdir(repository, { recursive: true });
  await Bun.$`git -C ${repository} init -q`;
  await Bun.$`git -C ${repository} config user.name test`;
  await Bun.$`git -C ${repository} config user.email test@example.com`;
  await writeFile(join(repository, "README.md"), "base\n");
  await Bun.$`git -C ${repository} add README.md`;
  await Bun.$`git -C ${repository} commit -qm initial`;
  const worktree = await createWebWorktree(repository, "tui-delete");
  const sessionId = `tui-delete-${crypto.randomUUID()}`;
  const survivorId = `tui-survivor-${crypto.randomUUID()}`;
  const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
  const survivorFile = join(sessionsDir, `${survivorId}.jsonl`);
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(webDir, { recursive: true });
  await writeFile(
    sessionFile,
    `${[
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        cwd: worktree.path,
        timestamp: new Date().toISOString(),
      }),
      JSON.stringify({
        type: "custom",
        id: "managed-worktree",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: WORKTREE_SESSION_ENTRY,
        data: worktree,
      }),
    ].join("\n")}\n`,
  );
  await writeFile(
    survivorFile,
    `${JSON.stringify({ type: "session", version: 3, id: survivorId, cwd: repository, timestamp: new Date().toISOString() })}\n`,
  );
  await writeFile(
    queuePath,
    `${JSON.stringify({ version: 2, queues: { [sessionId]: [{ id: "stale", message: "remove with session" }] } })}\n`,
  );
  child = Bun.spawn({
    cmd: ["bun", "run", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: agentDir,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);
  const initialCatalog = (await fetch(
    `http://127.0.0.1:${port}/api/sessions`,
  ).then((response) => response.json())) as { sessions: Array<{ id: string }> };
  expect(
    initialCatalog.sessions.some((session) => session.id === sessionId),
  ).toBe(true);
  expect(
    initialCatalog.sessions.some((session) => session.id === survivorId),
  ).toBe(true);
  const observer = browserSocket(`ws://127.0.0.1:${port}/ws/client`);
  let resolveReady!: () => void;
  let resolveRemoved!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const removed = new Promise<void>((resolve) => {
    resolveRemoved = resolve;
  });
  observer.onopen = () =>
    observer.send(JSON.stringify({ type: "client.hello" }));
  observer.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)) as {
      type?: string;
      sessionId?: string;
      sessions?: Array<{ id: string }>;
    };
    if (message.type === "server.snapshot") {
      expect(
        message.sessions?.some((session) => session.id === sessionId),
      ).toBe(true);
      observer.send(
        JSON.stringify({ type: "client.subscribe", sessionId: survivorId }),
      );
    }
    if (message.type === "server.history" && message.sessionId === survivorId)
      resolveReady();
    if (
      message.type === "server.session_removed" &&
      message.sessionId === sessionId
    )
      resolveRemoved();
  };
  await ready;

  // Pi's built-in /resume selector deletes the JSONL directly, outside the web API.
  await rm(sessionFile);
  await Promise.race([
    removed,
    Bun.sleep(4_000).then(() => {
      throw new Error("externally deleted session was not removed from Pi web");
    }),
  ]);
  const catalog = (await fetch(`http://127.0.0.1:${port}/api/sessions`).then(
    (response) => response.json(),
  )) as { sessions: Array<{ id: string }> };
  expect(catalog.sessions.some((session) => session.id === sessionId)).toBe(
    false,
  );
  expect(catalog.sessions.some((session) => session.id === survivorId)).toBe(
    true,
  );
  expect(await Bun.file(queuePath).json()).toEqual({ version: 2, queues: {} });
  await expect(
    readFile(join(worktree.path, "README.md"), "utf8"),
  ).rejects.toThrow();
  expect(
    (await Bun.$`git -C ${repository} branch --list tui-delete`.text()).trim(),
  ).toBe("");
  observer.close();
}, 10_000);

test("transient session-file access errors do not reconcile as deletion", async () => {
  if (
    process.platform === "win32" ||
    (typeof process.getuid === "function" && process.getuid() === 0)
  )
    return;
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-session-access-error-test-"));
  const agentDir = join(tempDir, "pi-agent");
  const sessionsDir = join(agentDir, "sessions", "project");
  const webDir = join(tempDir, "web");
  const statePath = join(webDir, "server.json");
  const queuePath = join(webDir, "queues.json");
  const sessionId = `access-error-${crypto.randomUUID()}`;
  const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(webDir, { recursive: true });
  await writeFile(
    sessionFile,
    `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: tempDir, timestamp: new Date().toISOString() })}\n`,
  );
  await writeFile(
    queuePath,
    `${JSON.stringify({ version: 2, queues: { [sessionId]: [{ id: "retained", message: "keep during access error" }] } })}\n`,
  );
  child = Bun.spawn({
    cmd: ["bun", "run", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: agentDir,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);
  const initial = (await fetch(`http://127.0.0.1:${port}/api/sessions`).then(
    (response) => response.json(),
  )) as { sessions: Array<{ id: string }> };
  expect(initial.sessions.some((session) => session.id === sessionId)).toBe(
    true,
  );

  await chmod(sessionsDir, 0o000);
  try {
    await Bun.sleep(1_500);
  } finally {
    await chmod(sessionsDir, 0o700);
  }
  const afterError = (await fetch(`http://127.0.0.1:${port}/api/sessions`).then(
    (response) => response.json(),
  )) as { sessions: Array<{ id: string }> };
  expect(afterError.sessions.some((session) => session.id === sessionId)).toBe(
    true,
  );
  expect(await Bun.file(queuePath).json()).toEqual({
    version: 2,
    queues: {
      [sessionId]: [{ id: "retained", message: "keep during access error" }],
    },
  });
}, 10_000);

test("saved-session metadata refresh clears hydrated ownership and skips malformed markers", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-worktree-marker-clear-test-"));
  const agentDir = join(tempDir, "pi-agent");
  const sessionsDir = join(agentDir, "sessions", "project");
  const statePath = join(tempDir, "web", "server.json");
  const clearedSessionId = `marker-clear-${crypto.randomUUID()}`;
  const malformedSessionId = `marker-malformed-${crypto.randomUUID()}`;
  const managedWorktree = {
    path: join(tempDir, "worktree"),
    repoRoot: tempDir,
    name: "worktree",
    branch: "feature",
    branchCreated: true,
  };
  await mkdir(sessionsDir, { recursive: true });
  const clearedSessionFile = join(sessionsDir, `${clearedSessionId}.jsonl`);
  await writeFile(
    clearedSessionFile,
    `${[
      JSON.stringify({
        type: "session",
        version: 3,
        id: clearedSessionId,
        cwd: tempDir,
        timestamp: new Date().toISOString(),
      }),
      JSON.stringify({
        type: "custom",
        id: "owned",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: WORKTREE_SESSION_ENTRY,
        data: managedWorktree,
      }),
    ].join("\n")}\n`,
  );
  await writeFile(
    join(sessionsDir, `${malformedSessionId}.jsonl`),
    `${[
      JSON.stringify({
        type: "session",
        version: 3,
        id: malformedSessionId,
        cwd: tempDir,
        timestamp: new Date().toISOString(),
      }),
      JSON.stringify({
        type: "custom",
        id: "owned",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: WORKTREE_SESSION_ENTRY,
        data: managedWorktree,
      }),
      JSON.stringify({
        type: "custom",
        id: "malformed",
        parentId: "owned",
        timestamp: new Date().toISOString(),
        customType: WORKTREE_SESSION_ENTRY,
        data: { managed: true },
      }),
    ].join("\n")}\n`,
  );
  child = Bun.spawn({
    cmd: ["bun", "run", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: agentDir,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);
  const initialCatalog = (await fetch(
    `http://127.0.0.1:${port}/api/sessions`,
  ).then((response) => response.json())) as {
    sessions: Array<{ id: string; managedWorktree?: unknown }>;
  };
  expect(
    initialCatalog.sessions.find((session) => session.id === clearedSessionId)
      ?.managedWorktree,
  ).toEqual(managedWorktree);
  expect(
    initialCatalog.sessions.find((session) => session.id === malformedSessionId)
      ?.managedWorktree,
  ).toEqual(managedWorktree);

  const messageLine = JSON.stringify({
    type: "message",
    id: "latest",
    parentId: "owned",
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "incremental metadata" },
  });
  const splitAt = Math.floor(messageLine.length / 2);
  await appendFile(clearedSessionFile, messageLine.slice(0, splitAt));
  const partialCatalog = (await fetch(
    `http://127.0.0.1:${port}/api/sessions`,
  ).then((response) => response.json())) as {
    sessions: Array<{ id: string; messageCount?: number; preview?: string }>;
  };
  const partial = partialCatalog.sessions.find(
    (session) => session.id === clearedSessionId,
  );
  expect(partial?.messageCount).toBe(0);
  expect(partial?.preview).toBeUndefined();
  await appendFile(
    clearedSessionFile,
    `${[
      messageLine.slice(splitAt),
      JSON.stringify({
        type: "custom",
        id: "cleared",
        parentId: "latest",
        timestamp: new Date().toISOString(),
        customType: WORKTREE_SESSION_ENTRY,
        data: { ...managedWorktree, managed: false },
      }),
    ].join("\n")}\n`,
  );
  const refreshedCatalog = (await fetch(
    `http://127.0.0.1:${port}/api/sessions`,
  ).then((response) => response.json())) as {
    sessions: Array<{
      id: string;
      managedWorktree?: unknown;
      messageCount?: number;
      preview?: string;
    }>;
  };
  const refreshed = refreshedCatalog.sessions.find(
    (session) => session.id === clearedSessionId,
  );
  expect(refreshed?.managedWorktree).toBeUndefined();
  expect(refreshed?.messageCount).toBe(1);
  expect(refreshed?.preview).toBe("incremental metadata");
}, 10_000);

test("failed durable queue deletion leaves the session file and record retryable", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-delete-transaction-test-"));
  const agentDir = join(tempDir, "pi-agent");
  const sessionsDir = join(agentDir, "sessions", "project");
  const statePath = join(tempDir, "web", "server.json");
  const queuePath = join(tempDir, "web", "queues.json");
  const project = join(tempDir, "project");
  const sessionId = `delete-${crypto.randomUUID()}`;
  const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(join(tempDir, "web"), { recursive: true });
  await writeFile(
    sessionFile,
    `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: project, timestamp: new Date().toISOString() })}\n`,
  );
  await writeFile(
    queuePath,
    JSON.stringify({
      version: 2,
      queues: { [sessionId]: [{ id: "retained", message: "do not lose" }] },
    }),
  );
  child = Bun.spawn({
    cmd: ["bun", "run", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: agentDir,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);
  await fetch(`http://127.0.0.1:${port}/api/sessions`);
  await rm(queuePath, { force: true });
  await mkdir(queuePath);

  const failed = await fetch(
    `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "DELETE",
      headers: { Origin: `http://127.0.0.1:${port}` },
    },
  );
  expect(failed.status).toBe(400);
  expect(await readFile(sessionFile, "utf8")).toContain(sessionId);
  const afterFailure = (await fetch(
    `http://127.0.0.1:${port}/api/sessions`,
  ).then((response) => response.json())) as { sessions: WebSession[] };
  expect(afterFailure.sessions.some((item) => item.id === sessionId)).toBe(
    true,
  );

  await rm(queuePath, { recursive: true, force: true });
  const retried = await fetch(
    `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "DELETE",
      headers: { Origin: `http://127.0.0.1:${port}` },
    },
  );
  expect(retried.status).toBe(200);
  await expect(readFile(sessionFile, "utf8")).rejects.toThrow();
}, 10_000);

test("deleting a saved managed-worktree session removes its checkout and branch", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-delete-worktree-test-"));
  const repository = join(tempDir, "repository");
  const agentDir = join(tempDir, "pi-agent");
  const sessionDirectory = join(agentDir, "sessions", "worktree");
  await mkdir(repository, { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  await Bun.$`git -C ${repository} init -q`;
  await Bun.$`git -C ${repository} config user.name test`;
  await Bun.$`git -C ${repository} config user.email test@example.com`;
  await writeFile(join(repository, "README.md"), "base\n");
  await Bun.$`git -C ${repository} add README.md`;
  await Bun.$`git -C ${repository} commit -qm initial`;
  const worktree = await createWebWorktree(repository, "delete-with-session");
  const sessionId = `worktree-${crypto.randomUUID()}`;
  const sessionFile = join(sessionDirectory, `${sessionId}.jsonl`);
  await writeFile(
    sessionFile,
    `${[
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        cwd: worktree.path,
        timestamp: new Date().toISOString(),
      }),
      JSON.stringify({
        type: "custom",
        id: "managed-worktree",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: WORKTREE_SESSION_ENTRY,
        data: worktree,
      }),
    ].join("\n")}\n`,
  );
  const statePath = join(tempDir, "server.json");
  child = Bun.spawn({
    cmd: ["bun", "run", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: agentDir,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);
  const origin = `http://127.0.0.1:${port}`;
  const response = await fetch(
    `${origin}/api/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "DELETE",
      headers: { Origin: origin },
    },
  );
  expect(response.status).toBe(200);
  await expect(readFile(sessionFile, "utf8")).rejects.toThrow();
  const cleanupDeadline = Date.now() + 3_000;
  let cleanupBranch = "delete-with-session";
  while (Date.now() < cleanupDeadline) {
    cleanupBranch = (
      await Bun.$`git -C ${repository} branch --list delete-with-session`.text()
    ).trim();
    if (
      !(await Bun.file(join(worktree.path, "README.md")).exists()) &&
      !cleanupBranch
    )
      break;
    await Bun.sleep(25);
  }
  await expect(
    readFile(join(worktree.path, "README.md"), "utf8"),
  ).rejects.toThrow();
  expect(cleanupBranch).toBe("");
}, 10_000);

test("worktree cleanup failure does not turn a completed session deletion into an error", async () => {
  tempDir = await mkdtemp(
    join(tmpdir(), "pi-kit-delete-worktree-warning-test-"),
  );
  const repository = join(tempDir, "repository");
  const agentDir = join(tempDir, "pi-agent");
  const sessionDirectory = join(agentDir, "sessions", "worktree");
  await mkdir(repository, { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  await Bun.$`git -C ${repository} init -q`;
  const doomedId = `doomed-${crypto.randomUUID()}`;
  const survivorId = `survivor-${crypto.randomUUID()}`;
  const doomedFile = join(sessionDirectory, `${doomedId}.jsonl`);
  const survivorFile = join(sessionDirectory, `${survivorId}.jsonl`);
  const invalidWorktree = {
    path: join(repository, ".pi", "worktrees", "missing"),
    repoRoot: repository,
    branch: "missing",
  };
  await writeFile(
    doomedFile,
    `${[
      JSON.stringify({
        type: "session",
        version: 3,
        id: doomedId,
        cwd: invalidWorktree.path,
        timestamp: new Date().toISOString(),
      }),
      JSON.stringify({
        type: "custom",
        id: "managed-worktree",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: WORKTREE_SESSION_ENTRY,
        data: invalidWorktree,
      }),
    ].join("\n")}\n`,
  );
  await writeFile(
    survivorFile,
    `${JSON.stringify({ type: "session", version: 3, id: survivorId, cwd: repository, timestamp: new Date().toISOString() })}\n`,
  );
  const statePath = join(tempDir, "server.json");
  child = Bun.spawn({
    cmd: ["bun", "run", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: agentDir,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);
  const origin = `http://127.0.0.1:${port}`;
  const observer = browserSocket(`ws://127.0.0.1:${port}/ws/client`);
  let resolveReady!: () => void;
  let resolveRemoved!: (sessionId: string) => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const removed = new Promise<string>((resolve) => {
    resolveRemoved = resolve;
  });
  observer.onopen = () =>
    observer.send(JSON.stringify({ type: "client.hello" }));
  observer.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)) as {
      type?: string;
      sessionId?: string;
    };
    if (message.type === "server.snapshot")
      observer.send(
        JSON.stringify({ type: "client.subscribe", sessionId: survivorId }),
      );
    if (message.type === "server.history" && message.sessionId === survivorId)
      resolveReady();
    if (message.type === "server.session_removed" && message.sessionId)
      resolveRemoved(message.sessionId);
  };
  await ready;
  const response = await fetch(
    `${origin}/api/sessions/${encodeURIComponent(doomedId)}`,
    {
      method: "DELETE",
      headers: { Origin: origin },
    },
  );
  expect(response.status).toBe(200);
  expect(await removed).toBe(doomedId);
  await expect(readFile(doomedFile, "utf8")).rejects.toThrow();
  observer.close();
}, 10_000);

test("daemon restart completes a staged managed worktree source deletion", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-worktree-delete-recovery-"));
  const agentDir = join(tempDir, "pi-agent");
  const sessionsRoot = join(agentDir, "sessions");
  const webDir = join(tempDir, "web");
  const statePath = join(webDir, "server.json");
  const sourceId = `source-${crypto.randomUUID()}`;
  const replacementId = `replacement-${crypto.randomUUID()}`;
  const sourceFile = join(sessionsRoot, "source", `${sourceId}.jsonl`);
  const tombstone = `${sourceFile}.replaced-${crypto.randomUUID()}.tmp`;
  const replacementFile = join(
    sessionsRoot,
    "replacement",
    `${replacementId}.jsonl`,
  );
  const uncommittedSourceId = `uncommitted-${crypto.randomUUID()}`;
  const uncommittedSourceFile = join(
    sessionsRoot,
    "uncommitted",
    `${uncommittedSourceId}.jsonl`,
  );
  const uncommittedTombstone = `${uncommittedSourceFile}.replaced-${crypto.randomUUID()}.tmp`;
  await mkdir(dirname(sourceFile), { recursive: true });
  await mkdir(dirname(uncommittedSourceFile), { recursive: true });
  await mkdir(dirname(replacementFile), { recursive: true });
  await mkdir(webDir, { recursive: true });
  await writeFile(
    tombstone,
    `${JSON.stringify({ type: "session", version: 3, id: sourceId, timestamp: new Date().toISOString(), cwd: tempDir })}\n`,
  );
  await writeFile(
    uncommittedTombstone,
    `${JSON.stringify({ type: "session", version: 3, id: uncommittedSourceId, timestamp: new Date().toISOString(), cwd: tempDir })}\n`,
  );
  await writeFile(
    replacementFile,
    `${[
      JSON.stringify({
        type: "session",
        version: 3,
        id: replacementId,
        timestamp: new Date().toISOString(),
        cwd: tempDir,
      }),
      JSON.stringify({
        type: "custom",
        id: crypto.randomUUID(),
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: "vessup-replaced-session",
        data: {
          previousSessionId: sourceId,
          previousSessionFile: sourceFile,
          replacementSessionId: replacementId,
        },
      }),
    ].join("\n")}\n`,
  );
  await writeFile(
    join(webDir, "managed-sessions.json"),
    `${JSON.stringify({ version: 1, files: [sourceFile, uncommittedSourceFile] })}\n`,
  );
  await writeFile(
    join(webDir, "queues.json"),
    `${JSON.stringify({ version: 2, queues: { [sourceId]: [{ id: "queued", message: "preserve queue" }] } })}\n`,
  );
  child = Bun.spawn({
    cmd: ["bun", "run", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: agentDir,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForState(statePath);
  expect(await Bun.file(tombstone).exists()).toBe(false);
  expect(await Bun.file(sourceFile).exists()).toBe(false);
  expect(await Bun.file(uncommittedTombstone).exists()).toBe(false);
  expect(await Bun.file(uncommittedSourceFile).exists()).toBe(true);
  const managed = (await Bun.file(
    join(webDir, "managed-sessions.json"),
  ).json()) as { version: number; files: string[] };
  expect(managed.version).toBe(1);
  expect([...managed.files].sort()).toEqual(
    [
      await realpath(uncommittedSourceFile),
      await realpath(replacementFile),
    ].sort(),
  );
  expect(await Bun.file(join(webDir, "queues.json")).json()).toEqual({
    version: 2,
    queues: { [replacementId]: [{ id: "queued", message: "preserve queue" }] },
  });
}, 10_000);

test("managed startup failure retains an initialized worktree and setup output", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-worktree-startup-test-"));
  const repository = join(tempDir, "repository");
  const fakeBin = join(tempDir, "bin");
  const agentDir = join(tempDir, "pi-agent");
  await mkdir(repository, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await Bun.$`git -C ${repository} init -q`;
  await Bun.$`git -C ${repository} config user.name test`;
  await Bun.$`git -C ${repository} config user.email test@example.com`;
  await writeFile(join(repository, "README.md"), "base\n");
  await Bun.$`git -C ${repository} add README.md`;
  await Bun.$`git -C ${repository} commit -qm initial`;
  await mkdir(join(repository, ".pi", "worktrees"), { recursive: true });
  await writeFile(
    join(repository, ".pi", "worktrees", "setup.sh"),
    "#!/bin/sh\nprintf 'generated by setup' > setup-generated.txt\n",
  );
  const fakePi = join(fakeBin, "pi");
  const piStartedMarker = join(tempDir, "base-pi-started");
  await writeFile(
    fakePi,
    `#!/usr/bin/env bun
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const marker = ${JSON.stringify(piStartedMarker)};
const fail = existsSync(marker);
if (!fail) writeFileSync(marker, "started");
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (fail && request.type === "get_state") {
    process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: request.type, success: false, error: "worktree startup failed" }) + "\\n");
    continue;
  }
  let data;
  if (request.type === "get_state") data = { sessionId: "base-session", messageCount: 0, isStreaming: false };
  else if (request.type === "get_entries") data = { entries: [], leafId: null };
  else if (request.type === "get_session_stats") data = {};
  process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data }) + "\\n");
}
`,
  );
  await chmod(fakePi, 0o755);
  const statePath = join(tempDir, "server.json");
  child = Bun.spawn({
    cmd: ["bun", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: agentDir,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);
  const origin = `http://127.0.0.1:${port}`;
  const baseResponse = await fetch(`${origin}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: origin },
    body: JSON.stringify({ cwd: repository }),
  });
  expect(baseResponse.status).toBe(201);
  expect(await readFile(piStartedMarker, "utf8")).toBe("started");
  const failed = await fetch(`${origin}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: origin },
    body: JSON.stringify({ cwd: repository, worktreeName: "startup-fails" }),
  });
  expect(failed.status).toBe(500);
  const worktree = join(repository, ".pi", "worktrees", "startup-fails");
  expect(await failed.text()).toContain("initialized worktree retained at ");
  expect(await readFile(join(worktree, "setup-generated.txt"), "utf8")).toBe(
    "generated by setup",
  );
  expect(
    (
      await Bun.$`git -C ${repository} branch --list startup-fails`.text()
    ).trim(),
  ).toContain("startup-fails");
}, 15_000);

test("entered checkout startup failure cleans up the stale initial session", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-worktree-entered-fail-test-"));
  const repository = join(tempDir, "repository");
  const fakeBin = join(tempDir, "bin");
  const agentDir = join(tempDir, "pi-agent");
  await mkdir(repository, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await Bun.$`git -C ${repository} init -q -b main`;
  await Bun.$`git -C ${repository} config user.name test`;
  await Bun.$`git -C ${repository} config user.email test@example.com`;
  await writeFile(join(repository, "README.md"), "base\n");
  await Bun.$`git -C ${repository} add README.md`;
  await Bun.$`git -C ${repository} commit -qm initial`;
  const fakePi = join(fakeBin, "pi");
  const piStartedMarker = join(tempDir, "base-pi-started");
  await writeFile(
    fakePi,
    `#!/usr/bin/env bun
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const marker = ${JSON.stringify(piStartedMarker)};
const fail = existsSync(marker);
if (!fail) writeFileSync(marker, "started");
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (fail && request.type === "get_state") {
    process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: request.type, success: false, error: "worktree startup failed" }) + "\\n");
    continue;
  }
  let data;
  if (request.type === "get_state") data = { sessionId: "base-session", messageCount: 0, isStreaming: false };
  else if (request.type === "get_entries") data = { entries: [], leafId: null };
  else if (request.type === "get_session_stats") data = {};
  process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data }) + "\\n");
}
`,
  );
  await chmod(fakePi, 0o755);
  const statePath = join(tempDir, "server.json");
  child = Bun.spawn({
    cmd: ["bun", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: agentDir,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);
  const origin = `http://127.0.0.1:${port}`;
  const baseResponse = await fetch(`${origin}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: origin },
    body: JSON.stringify({ cwd: repository }),
  });
  expect(baseResponse.status).toBe(201);
  const base = (await baseResponse.json()) as { session: { id: string } };
  expect(await readFile(piStartedMarker, "utf8")).toBe("started");
  // main is already checked out in the primary checkout, so this enters it.
  const failed = await fetch(`${origin}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: origin },
    body: JSON.stringify({
      cwd: repository,
      worktreeName: "entered",
      worktreeBranch: "main",
    }),
  });
  expect(failed.status).toBe(500);
  const body = await failed.text();
  expect(body).toContain("worktree startup failed");
  expect(body).not.toContain("retained at");
  expect(existsSync(join(repository, ".pi", "worktrees"))).toBe(false);
  const listed = await fetch(`${origin}/api/sessions`, {
    headers: { Origin: origin },
  });
  const payload = (await listed.json()) as {
    sessions: Array<{ id: string }>;
  };
  // The stale initial session for the failed entry is cleaned up; only the
  // base session survives.
  expect(payload.sessions.map((session) => session.id)).toEqual([
    base.session.id,
  ]);
}, 15_000);

test("native sessions route the web /compact command with optional instructions", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-native-compact-test-"));
  const statePath = join(tempDir, "server.json");
  child = Bun.spawn({
    cmd: ["bun", "run", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: join(tempDir, "pi-agent"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);
  const sessionId = `compact-${crypto.randomUUID()}`;
  const agent = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
  await new Promise<void>((resolve, reject) => {
    agent.onopen = () => {
      agent.send(
        JSON.stringify({
          type: "agent.hello",
          session: {
            id: sessionId,
            cwd: tempDir,
            status: "idle",
            source: "tui",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messageCount: 0,
          },
          entries: [],
        }),
      );
      resolve();
    };
    agent.onerror = () => reject(new Error("compact agent websocket failed"));
  });
  const command = new Promise<{
    requestId: string;
    customInstructions?: string;
  }>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("compact command was not routed to native Pi")),
      3_000,
    );
    agent.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        requestId?: string;
        command?: { type?: string; customInstructions?: string };
      };
      if (
        message.type !== "agent.command" ||
        !message.requestId ||
        message.command?.type !== "compact"
      )
        return;
      clearTimeout(timeout);
      // Mirror the real native bridge: emit compaction_end before acking so the
      // web server can broadcast "Compaction complete." to subscribed clients.
      agent.send(
        JSON.stringify({
          type: "agent.event",
          sessionId,
          event: {
            type: "compaction_end",
            reason: "manual",
            aborted: false,
            willRetry: false,
          },
        }),
      );
      resolve({
        requestId: message.requestId,
        customInstructions: message.command.customInstructions,
      });
    };
  });
  const result = new Promise<string | undefined>((resolve, reject) => {
    const client = browserSocket(`ws://127.0.0.1:${port}/ws/client`);
    const requestId = crypto.randomUUID();
    let completionNotice: string | undefined;
    let responseError: string | undefined;
    let responded = false;
    let settled = false;
    const timeout = setTimeout(() => {
      client.close();
      reject(new Error("compact client response timed out"));
    }, 5_000);
    const finish = () => {
      if (settled) return;
      // The completion notice is broadcast from the compaction_end handler and
      // the command response arrives once the agent acks; accept either order.
      if (!responseError && (!responded || completionNotice === undefined))
        return;
      clearTimeout(timeout);
      client.close();
      settled = true;
      if (responseError) reject(new Error(responseError));
      else resolve(completionNotice);
    };
    client.onopen = () => client.send(JSON.stringify({ type: "client.hello" }));
    client.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        requestId?: string;
        success?: boolean;
        error?: string;
        event?: {
          type?: string;
          message?: { content?: Array<{ type?: string; text?: string }> };
        };
      };
      if (message.type === "server.snapshot") {
        client.send(JSON.stringify({ type: "client.subscribe", sessionId }));
        client.send(
          JSON.stringify({
            type: "client.prompt",
            requestId,
            sessionId,
            message: "/compact preserve file names",
            images: [],
          }),
        );
      }
      if (
        message.type === "server.event" &&
        message.event?.type === "message_end"
      ) {
        completionNotice = message.event.message?.content?.find(
          (part) => part.type === "text",
        )?.text;
        finish();
      }
      if (message.type !== "server.response" || message.requestId !== requestId)
        return;
      responded = true;
      if (!message.success) responseError = message.error ?? "compact failed";
      finish();
    };
  });
  const routed = await command;
  expect(routed.customInstructions).toBe("preserve file names");
  agent.send(
    JSON.stringify({
      type: "agent.response",
      requestId: routed.requestId,
      success: true,
      data: { accepted: true },
    }),
  );
  expect(await result).toBe("Compaction complete.");
  agent.close();
}, 10_000);

test("web reload survives a native bridge reconnect", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-native-reload-test-"));
  const statePath = join(tempDir, "server.json");
  child = Bun.spawn({
    cmd: ["bun", "run", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: join(tempDir, "pi-agent"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);
  const sessionId = `reload-${crypto.randomUUID()}`;
  const socketUrl = `ws://127.0.0.1:${port}`;
  const connectAgent = async () => {
    const agent = new WebSocket(`${socketUrl}/ws/agent`);
    await new Promise<void>((resolve, reject) => {
      agent.onopen = () => {
        agent.send(
          JSON.stringify({
            type: "agent.hello",
            session: {
              id: sessionId,
              cwd: tempDir,
              status: "idle",
              source: "tui",
              createdAt: Date.now(),
              updatedAt: Date.now(),
              messageCount: 0,
            },
            entries: [],
          }),
        );
        resolve();
      };
      agent.onerror = () => reject(new Error("reload agent websocket failed"));
    });
    return agent;
  };
  const firstAgent = await connectAgent();
  await Bun.sleep(25);
  const result = new Promise<unknown>((resolve, reject) => {
    const client = browserSocket(`${socketUrl}/ws/client`);
    const clientRequestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      client.close();
      reject(new Error("native reload response timed out"));
    }, 5_000);
    client.onopen = () => client.send(JSON.stringify({ type: "client.hello" }));
    client.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        requestId?: string;
        success?: boolean;
        data?: unknown;
      };
      if (message.type === "server.snapshot") {
        client.send(
          JSON.stringify({
            type: "client.prompt",
            requestId: clientRequestId,
            sessionId,
            message: "/reload",
            images: [],
          }),
        );
      }
      if (
        message.type !== "server.response" ||
        message.requestId !== clientRequestId
      )
        return;
      clearTimeout(timeout);
      client.close();
      message.success
        ? resolve(message.data)
        : reject(new Error("native reload failed"));
    };
  });
  const agentCommand = await new Promise<{
    requestId: string;
    command: { type: string };
  }>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("reload command was not routed to native Pi")),
      3_000,
    );
    firstAgent.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        requestId?: string;
        command?: { type?: string };
      };
      if (
        message.type !== "agent.command" ||
        !message.requestId ||
        message.command?.type !== "reload"
      )
        return;
      clearTimeout(timeout);
      resolve({
        requestId: message.requestId,
        command: { type: message.command.type },
      });
    };
  });
  firstAgent.close();
  await Bun.sleep(25);
  const replacementAgent = await connectAgent();
  replacementAgent.send(
    JSON.stringify({
      type: "agent.response",
      requestId: agentCommand.requestId,
      success: true,
      data: { reloaded: true },
    }),
  );
  expect(await result).toEqual({ reloaded: true });
  replacementAgent.close();
}, 10_000);

test("queued web reload waits for active subagents and executes as a control command", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-queued-reload-test-"));
  const statePath = join(tempDir, "server.json");
  child = Bun.spawn({
    cmd: ["bun", "run", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: join(tempDir, "pi-agent"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);
  const sessionId = `queued-reload-${crypto.randomUUID()}`;
  const socketUrl = `ws://127.0.0.1:${port}`;
  const agent = new WebSocket(`${socketUrl}/ws/agent`);
  let reloadCommand: { requestId: string } | undefined;
  let resolveReload!: (value: { requestId: string }) => void;
  const reloadReceived = new Promise<{ requestId: string }>((resolve) => {
    resolveReload = resolve;
  });
  agent.onmessage = ({ data }) => {
    const frame = JSON.parse(String(data)) as {
      type?: string;
      requestId?: string;
      command?: { type?: string };
    };
    if (
      frame.type === "agent.command" &&
      frame.requestId &&
      frame.command?.type === "reload"
    ) {
      reloadCommand = { requestId: frame.requestId };
      resolveReload(reloadCommand);
    }
  };
  await new Promise<void>((resolve, reject) => {
    agent.onopen = () => {
      agent.send(
        JSON.stringify({
          type: "agent.hello",
          session: {
            id: sessionId,
            cwd: tempDir,
            status: "idle",
            source: "tui",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messageCount: 0,
          },
          entries: [],
        }),
      );
      agent.send(
        JSON.stringify({
          type: "agent.subagents",
          sessionId,
          agents: [
            {
              id: "worker",
              status: "working",
              model: "test/model",
              effort: "high",
              turns: 1,
              currentTool: null,
              queued: 0,
              createdAt: 1,
              updatedAt: 2,
              completedAt: null,
              error: null,
            },
          ],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        }),
      );
      resolve();
    };
    agent.onerror = () => reject(new Error("queued reload agent failed"));
  });
  const client = browserSocket(`${socketUrl}/ws/client`);
  const requestId = crypto.randomUUID();
  let sawQueued = false;
  let reloadCompletions = 0;
  let resolveAdmission!: () => void;
  let resolveEmpty!: () => void;
  const admitted = new Promise<void>((resolve) => {
    resolveAdmission = resolve;
  });
  const emptied = new Promise<void>((resolve) => {
    resolveEmpty = resolve;
  });
  client.onopen = () => client.send(JSON.stringify({ type: "client.hello" }));
  client.onmessage = ({ data }) => {
    const frame = JSON.parse(String(data)) as {
      type?: string;
      requestId?: string;
      success?: boolean;
      event?: {
        type?: string;
        queue?: Array<{ id?: string }>;
        message?: { content?: Array<{ text?: string }> };
      };
    };
    if (frame.type === "server.snapshot") {
      client.send(JSON.stringify({ type: "client.subscribe", sessionId }));
      client.send(
        JSON.stringify({
          type: "client.prompt",
          requestId,
          sessionId,
          message: "/reload",
          images: [],
          streamingBehavior: "followUp",
        }),
      );
    }
    if (
      frame.type === "server.response" &&
      frame.requestId === requestId &&
      frame.success
    )
      resolveAdmission();
    if (
      frame.event?.type === "message_end" &&
      frame.event.message?.content?.some(
        (part) => part.text === "Reload complete.",
      )
    )
      reloadCompletions += 1;
    if (
      frame.event?.type === "web_queue_update" &&
      frame.event.queue?.some((item) => item.id === requestId)
    )
      sawQueued = true;
    if (
      sawQueued &&
      frame.event?.type === "web_queue_update" &&
      frame.event.queue?.length === 0
    )
      resolveEmpty();
  };
  await admitted;
  await Bun.sleep(50);
  expect(sawQueued).toBe(true);
  expect(reloadCommand).toBeUndefined();
  expect(reloadCompletions).toBe(0);
  await expect(
    sessionCommand(`${socketUrl}/ws/client`, sessionId, {
      type: "create_worktree",
      name: "blocked",
      repository: tempDir,
    }),
  ).rejects.toThrow("subagents to become idle");
  agent.send(
    JSON.stringify({
      type: "agent.subagents",
      sessionId,
      agents: [
        {
          id: "worker",
          status: "completed",
          model: "test/model",
          effort: "high",
          turns: 2,
          currentTool: null,
          queued: 0,
          createdAt: 1,
          updatedAt: 3,
          completedAt: 3,
          error: null,
        },
      ],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }),
  );
  const command = await Promise.race([
    reloadReceived,
    Bun.sleep(3_000).then(() => {
      throw new Error("queued reload was not delivered after settlement");
    }),
  ]);
  agent.send(
    JSON.stringify({
      type: "agent.response",
      requestId: command.requestId,
      success: true,
      data: { reloaded: true },
    }),
  );
  await Promise.race([
    emptied,
    Bun.sleep(3_000).then(() => {
      throw new Error("accepted queued reload was not removed");
    }),
  ]);
  expect(reloadCompletions).toBe(1);
  client.close();
  agent.close();
}, 10_000);

test("native replacement recovery redirects a queue-free source session", async () => {
  tempDir = await mkdtemp(
    join(tmpdir(), "pi-kit-native-worktree-queue-recovery-"),
  );
  const agentDir = join(tempDir, "pi-agent");
  const webDir = join(tempDir, "web");
  const statePath = join(webDir, "server.json");
  const sourceId = `source-${crypto.randomUUID()}`;
  const replacementId = `replacement-${crypto.randomUUID()}`;
  const sourceFile = join(agentDir, "sessions", "source", `${sourceId}.jsonl`);
  const replacementFile = join(
    agentDir,
    "sessions",
    "replacement",
    `${replacementId}.jsonl`,
  );
  await mkdir(dirname(replacementFile), { recursive: true });
  await mkdir(webDir, { recursive: true });
  await writeFile(
    replacementFile,
    `${[
      JSON.stringify({
        type: "session",
        version: 3,
        id: replacementId,
        timestamp: new Date().toISOString(),
        cwd: tempDir,
      }),
      JSON.stringify({
        type: "custom",
        id: crypto.randomUUID(),
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: "vessup-replaced-session",
        data: {
          previousSessionId: sourceId,
          previousSessionFile: sourceFile,
          replacementSessionId: replacementId,
        },
      }),
    ].join("\n")}\n`,
  );
  await writeFile(
    join(webDir, "queues.json"),
    `${JSON.stringify({
      version: 2,
      queues: {
        [replacementId]: [
          { id: "replacement-queue", message: "from replacement" },
        ],
      },
    })}\n`,
  );
  child = Bun.spawn({
    cmd: ["bun", "run", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: agentDir,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);
  const socketUrl = `ws://127.0.0.1:${port}`;
  const agent = new WebSocket(`${socketUrl}/ws/agent`);
  await new Promise<void>((resolve, reject) => {
    agent.onopen = () => {
      agent.send(
        JSON.stringify({
          type: "agent.hello",
          session: {
            id: replacementId,
            file: replacementFile,
            cwd: tempDir,
            status: "working",
            source: "tui",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messageCount: 0,
          },
          entries: [],
        }),
      );
      resolve();
    };
    agent.onerror = () =>
      reject(new Error("replacement recovery agent failed"));
  });
  await Bun.sleep(25);
  const redirected = new Promise<string | undefined>((resolve, reject) => {
    const observer = browserSocket(`${socketUrl}/ws/client`);
    const timeout = setTimeout(() => {
      observer.close();
      reject(new Error("queue-free replacement redirect timed out"));
    }, 3_000);
    observer.onopen = () =>
      observer.send(JSON.stringify({ type: "client.hello" }));
    observer.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        sessionId?: string;
        replacementSessionId?: string;
      };
      if (message.type === "server.snapshot") {
        observer.send(
          JSON.stringify({
            type: "client.subscribe",
            sessionId: replacementId,
          }),
        );
        setTimeout(
          () =>
            agent.send(
              JSON.stringify({
                type: "agent.session_replaced",
                previousSessionId: sourceId,
                previousSessionFile: sourceFile,
                replacementSessionId: replacementId,
              }),
            ),
          25,
        );
      }
      if (
        message.type !== "server.session_removed" ||
        message.sessionId !== sourceId
      )
        return;
      clearTimeout(timeout);
      observer.close();
      resolve(message.replacementSessionId);
    };
  });
  expect(await redirected).toBe(replacementId);
  expect(await Bun.file(join(webDir, "queues.json")).json()).toEqual({
    version: 2,
    queues: {
      [replacementId]: [
        { id: "replacement-queue", message: "from replacement" },
      ],
    },
  });
  agent.close();
}, 10_000);

test("native worktree switches survive the replacement bridge reconnect", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-native-worktree-test-"));
  const statePath = join(tempDir, "server.json");
  child = Bun.spawn({
    cmd: ["bun", "run", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: join(tempDir, "pi-agent"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);
  const originalSessionId = `worktree-${crypto.randomUUID()}`;
  const replacementSessionId = `replacement-${crypto.randomUUID()}`;
  const originalSessionFile = join(
    tempDir,
    "pi-agent",
    "sessions",
    "source",
    `${originalSessionId}.jsonl`,
  );
  const replacementSessionFile = join(
    tempDir,
    "pi-agent",
    "sessions",
    "replacement",
    `${replacementSessionId}.jsonl`,
  );
  await mkdir(dirname(originalSessionFile), { recursive: true });
  await mkdir(dirname(replacementSessionFile), { recursive: true });
  await writeFile(
    originalSessionFile,
    `${JSON.stringify({ type: "session", version: 3, id: originalSessionId, timestamp: new Date().toISOString(), cwd: tempDir })}\n`,
  );
  await writeFile(
    replacementSessionFile,
    `${[
      JSON.stringify({
        type: "session",
        version: 3,
        id: replacementSessionId,
        timestamp: new Date().toISOString(),
        cwd: tempDir,
      }),
      JSON.stringify({
        type: "custom",
        id: crypto.randomUUID(),
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: "vessup-replaced-session",
        data: {
          previousSessionId: originalSessionId,
          previousSessionFile: originalSessionFile,
          replacementSessionId,
        },
      }),
    ].join("\n")}\n`,
  );
  const socketUrl = `ws://127.0.0.1:${port}`;
  const connectAgent = async (sessionId: string, file?: string) => {
    const agent = new WebSocket(`${socketUrl}/ws/agent`);
    await new Promise<void>((resolve, reject) => {
      agent.onopen = () => {
        agent.send(
          JSON.stringify({
            type: "agent.hello",
            session: {
              id: sessionId,
              file,
              cwd: tempDir,
              status: "idle",
              source: "tui",
              createdAt: Date.now(),
              updatedAt: Date.now(),
              messageCount: 0,
            },
            entries: [],
          }),
        );
        resolve();
      };
      agent.onerror = () =>
        reject(new Error("worktree agent websocket failed"));
    });
    return agent;
  };
  const firstAgent = await connectAgent(originalSessionId, originalSessionFile);
  await Bun.sleep(25);
  const command = new Promise<{
    requestId: string;
    command: {
      type: string;
      name?: string;
      repository?: string;
      branch?: string;
      startPoint?: string;
    };
  }>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("worktree command was not routed to native Pi")),
      3_000,
    );
    firstAgent.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        requestId?: string;
        command?: {
          type?: string;
          name?: string;
          repository?: string;
          branch?: string;
          startPoint?: string;
        };
      };
      if (
        message.type !== "agent.command" ||
        !message.requestId ||
        message.command?.type !== "create_worktree_v2"
      )
        return;
      clearTimeout(timeout);
      resolve({
        requestId: message.requestId,
        command: { ...message.command, type: message.command.type },
      });
    };
  });
  const result = new Promise<unknown>((resolve, reject) => {
    const client = browserSocket(`${socketUrl}/ws/client`);
    const clientRequestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      client.close();
      reject(new Error("native worktree response timed out"));
    }, 5_000);
    client.onopen = () => client.send(JSON.stringify({ type: "client.hello" }));
    client.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        requestId?: string;
        success?: boolean;
        data?: unknown;
        error?: string;
      };
      if (message.type === "server.snapshot") {
        client.send(
          JSON.stringify({
            type: "client.prompt",
            requestId: clientRequestId,
            sessionId: originalSessionId,
            message: `/worktree pr-30 --repo ${tempDir} --branch tembo/cancel-builds --start-point origin/tembo/cancel-builds`,
            images: [],
          }),
        );
      }
      if (
        message.type !== "server.response" ||
        message.requestId !== clientRequestId
      )
        return;
      clearTimeout(timeout);
      client.close();
      message.success
        ? resolve(message.data)
        : reject(new Error(message.error ?? "native worktree failed"));
    };
  });
  const routed = await command;
  expect(routed.command).toEqual({
    type: "create_worktree_v2",
    name: "pr-30",
    repository: tempDir,
    branch: "tembo/cancel-builds",
    startPoint: "origin/tembo/cancel-builds",
  });
  firstAgent.close();
  await Bun.sleep(25);
  const replacementAgent = await connectAgent(
    replacementSessionId,
    replacementSessionFile,
  );
  let markObserverReady!: () => void;
  const observerReady = new Promise<void>((resolve) => {
    markObserverReady = resolve;
  });
  const removed = new Promise<{
    type?: string;
    sessionId?: string;
    replacementSessionId?: string;
  }>((resolve, reject) => {
    const observer = browserSocket(`${socketUrl}/ws/client`);
    const timeout = setTimeout(() => {
      observer.close();
      reject(new Error("source session removal was not broadcast"));
    }, 5_000);
    observer.onopen = () =>
      observer.send(JSON.stringify({ type: "client.hello" }));
    observer.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        sessionId?: string;
        replacementSessionId?: string;
      };
      if (message.type === "server.snapshot")
        observer.send(
          JSON.stringify({
            type: "client.subscribe",
            sessionId: replacementSessionId,
          }),
        );
      if (
        message.type === "server.history" &&
        message.sessionId === replacementSessionId
      )
        markObserverReady();
      if (
        message.type !== "server.session_removed" ||
        message.sessionId !== originalSessionId
      )
        return;
      clearTimeout(timeout);
      observer.close();
      resolve(message);
    };
  });
  await observerReady;
  await rm(originalSessionFile);
  // The missing-file reconciler must leave durable worktree replacements to the
  // replacement handshake so queued work can migrate instead of being discarded.
  await Bun.sleep(1_100);
  const beforeReplacement = (await fetch(
    `http://127.0.0.1:${port}/api/sessions`,
  ).then((response) => response.json())) as { sessions: Array<{ id: string }> };
  expect(
    beforeReplacement.sessions.some(
      (session) => session.id === originalSessionId,
    ),
  ).toBe(true);
  replacementAgent.send(
    JSON.stringify({
      type: "agent.session_replaced",
      previousSessionId: originalSessionId,
      previousSessionFile: originalSessionFile,
      replacementSessionId,
    }),
  );
  expect(await removed).toEqual({
    type: "server.session_removed",
    sessionId: originalSessionId,
    replacementSessionId,
  });
  // Durable replacement markers are replayed after daemon/native reconnects.
  replacementAgent.send(
    JSON.stringify({
      type: "agent.session_replaced",
      previousSessionId: originalSessionId,
      previousSessionFile: originalSessionFile,
      replacementSessionId,
    }),
  );
  replacementAgent.send(
    JSON.stringify({
      type: "agent.response",
      requestId: routed.requestId,
      success: true,
      data: { sessionId: replacementSessionId },
    }),
  );
  expect(await result).toEqual({ sessionId: replacementSessionId });
  const catalog = (await fetch(`http://127.0.0.1:${port}/api/sessions`).then(
    (response) => response.json(),
  )) as { sessions: Array<{ id: string }> };
  expect(
    catalog.sessions.some((session) => session.id === originalSessionId),
  ).toBe(false);
  expect(
    catalog.sessions.some((session) => session.id === replacementSessionId),
  ).toBe(true);
  replacementAgent.close();
}, 10_000);

test("native sessions expose queued-delivery ordering and context compaction lifecycle", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-queued-delivery-test-"));
  const statePath = join(tempDir, "server.json");
  child = Bun.spawn({
    cmd: ["bun", "run", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: join(tempDir, "pi-agent"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);
  const sessionId = `queued-${crypto.randomUUID()}`;
  const agent = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
  await new Promise<void>((resolve, reject) => {
    agent.onopen = () => {
      agent.send(
        JSON.stringify({
          type: "agent.hello",
          session: {
            id: sessionId,
            cwd: tempDir,
            status: "working",
            source: "tui",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messageCount: 0,
          },
          entries: [],
        }),
      );
      resolve();
    };
    agent.onerror = () => reject(new Error("native agent websocket failed"));
  });
  await Bun.sleep(25);
  const socketUrl = `ws://127.0.0.1:${port}/ws/client`;
  expect(await steerQueuedFollowUpNow(socketUrl, sessionId, agent)).toEqual({
    behavior: "steer",
    transcriptBeforePrompt: true,
    queueCleared: true,
  });
  expect(
    await queuedFollowUpDeliveryOrder(socketUrl, sessionId, agent),
  ).toEqual(["transcript", "prompt-after-transcript", "queue-cleared"]);
  // Compatibility path for native bridges loaded before agent_settled forwarding
  // was added: agent_end still advances the durable queue after a short grace.
  expect(
    await queuedFollowUpDeliveryOrder(socketUrl, sessionId, agent, "agent_end"),
  ).toEqual(["transcript", "prompt-after-transcript", "queue-cleared"]);
  expect(
    await idleQueueReplacementStartsAutomatically(socketUrl, sessionId, agent),
  ).toBe("followUp");
  expect(
    await rejectedPromptPreservesLegacyQueueFallback(
      socketUrl,
      sessionId,
      agent,
    ),
  ).toBe("followUp");
  expect(
    await lateSettlementDoesNotBurstQueue(socketUrl, sessionId, agent),
  ).toEqual([1, 2]);
  expect(await promptAdmissionStatus(socketUrl, sessionId, agent)).toEqual([
    "idle",
    "working",
  ]);
  expect(
    await stoppedOverflowCompactionDeliversQueuedFollowUp(
      socketUrl,
      sessionId,
      agent,
    ),
  ).toBe("followUp");
  expect(await compactionLifecycle(socketUrl, sessionId, agent)).toEqual({
    states: [{ reason: "overflow", status: "working" }, { status: "idle" }],
    historyReset: true,
    // Overflow compaction completes server-side and announces "Compaction
    // complete." to subscribed clients just like a manual /compact.
    completionNotice: "Compaction complete.",
  });
  const compactedHistory = JSON.stringify(
    await waitForSemanticHistory(socketUrl, sessionId),
  );
  expect(compactedHistory).toContain("compacted summary");
  expect(compactedHistory).toContain("after compaction");
  expect(compactedHistory).not.toContain("before compaction");
  agent.send(
    JSON.stringify({
      type: "agent.event",
      sessionId,
      event: { type: "agent_start" },
    }),
  );
  await Bun.sleep(25);
  expect(
    await promptAcknowledgementLossBecomesUncertain(
      socketUrl,
      sessionId,
      agent,
    ),
  ).toBe(true);
  agent.close();
}, 100_000);

test("browser sessions stay managed and idle across daemon restarts", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-semantic-test-"));
  const statePath = join(tempDir, "server.json");
  const agentDir = join(tempDir, "pi-agent");
  const cwd = join(tempDir, "project");
  await Bun.write(join(cwd, ".keep"), "");
  const startServer = () =>
    Bun.spawn({
      cmd: ["bun", "run", "web/server/index.ts"],
      cwd: process.cwd(),
      env: {
        ...process.env,
        PI_WEB_PORT: "0",
        PI_WEB_ROOT: process.cwd(),
        PI_WEB_STATE_FILE: statePath,
        PI_CODING_AGENT_DIR: agentDir,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
  child = startServer();
  let { port } = await waitForState(statePath);
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: `http://127.0.0.1:${port}`,
    },
    body: JSON.stringify({ cwd, name: "semantic-test" }),
  });
  const responseText = await response.text();
  if (response.status !== 201)
    throw new Error(
      `Session creation failed with ${response.status}: ${responseText}`,
    );
  const payload = JSON.parse(responseText) as {
    session: { id: string; file?: string; source: string };
  };
  expect(payload.session.source).toBe("web");
  expect(payload.session.file).toBeString();
  const sessionFile = payload.session.file;
  if (!sessionFile) throw new Error("payload.session.file not set");
  expect(await Bun.file(join(tempDir, "managed-sessions.json")).json()).toEqual(
    { version: 1, files: [await realpath(sessionFile)] },
  );
  const socketUrl = `ws://127.0.0.1:${port}/ws/client`;
  const semanticHistory = await waitForSemanticHistory(
    socketUrl,
    payload.session.id,
  );
  expect(Array.isArray(semanticHistory)).toBe(true);
  await writeFile(
    sessionFile,
    `${JSON.stringify({ id: crypto.randomUUID(), type: "message", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", timestamp: Date.now(), content: [{ type: "text", text: "persist me" }] } })}\n`,
    { flag: "a" },
  );

  child.kill("SIGTERM");
  await child.exited;
  child = startServer();
  ({ port } = await waitForState(statePath));
  let restored: { id: string; source: string; status: string } | undefined;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const catalog = (await fetch(`http://127.0.0.1:${port}/api/sessions`).then(
      (result) => result.json(),
    )) as { sessions: Array<{ id: string; source: string; status: string }> };
    restored = catalog.sessions.find(
      (session) => session.id === payload.session.id,
    );
    if (restored?.source === "web" && restored.status === "idle") break;
    await Bun.sleep(50);
  }
  expect(restored).toEqual(
    expect.objectContaining({
      id: payload.session.id,
      source: "web",
      status: "idle",
    }),
  );

  const deleted = await fetch(
    `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(payload.session.id)}`,
    {
      method: "DELETE",
      headers: { Origin: `http://127.0.0.1:${port}` },
    },
  );
  expect(deleted.status).toBe(200);
  expect(await Bun.file(join(tempDir, "managed-sessions.json")).json()).toEqual(
    { version: 1, files: [] },
  );
}, 20_000);

async function waitForMirroredSession(port: number): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    const payload = (await response.json()) as {
      sessions: Array<{ id: string; source: string; status: string }>;
    };
    const session = payload.sessions.find(
      (item) => item.source === "tui" && item.status !== "offline",
    );
    if (session) return session.id;
    await Bun.sleep(50);
  }
  throw new Error("native Pi session did not register with the web server");
}

test("native Pi sessions expose semantic history without replacing their physical TUI", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-semantic-native-test-"));
  const agentDir = join(tempDir, "pi-agent");
  await mkdir(join(agentDir, "prompts"), { recursive: true });
  await writeFile(
    join(agentDir, "prompts", "address-pr.md"),
    "---\ndescription: Get PR ready to merge\n---\nAddress the pull request.\n",
  );
  const statePath = join(agentDir, "web", "server.json");
  child = Bun.spawn({
    cmd: ["bun", "run", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: agentDir,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const { port } = await waitForState(statePath);
  const terminal = new Bun.Terminal({ cols: 90, rows: 28, data() {} });
  const pi = Bun.spawn({
    cmd: [
      "pi",
      "-ne",
      "-e",
      join(process.cwd(), "extensions", "session-footer.ts"),
      "-e",
      join(process.cwd(), "extensions", "web-sessions.ts"),
      "--approve",
      "--no-session",
    ],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_WEB_PORT: String(port),
      PI_WEB_STATE_FILE: statePath,
      PI_WEB_MANAGED: "0",
    },
    terminal,
  });
  try {
    const sessionId = await waitForMirroredSession(port);
    const socketUrl = `ws://127.0.0.1:${port}/ws/client`;
    const entries = await waitForSemanticHistory(socketUrl, sessionId);
    expect(Array.isArray(entries)).toBe(true);
    const commandData = (await sessionCommand(socketUrl, sessionId, {
      type: "get_commands",
    })) as { commands: Array<{ name: string; source: string }> };
    expect(commandData.commands).toContainEqual(
      expect.objectContaining({ name: "address-pr", source: "prompt" }),
    );
  } finally {
    terminal.write("\u0004");
    await Promise.race([pi.exited, Bun.sleep(2_000)]);
    if (pi.exitCode === null) pi.kill("SIGTERM");
    terminal.close();
  }
}, 15_000);

test("a second daemon defers to the running daemon instead of stealing discovery", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-web-defer-test-"));
  const statePath = join(tempDir, "server.json");
  const serverEnv = () => ({
    ...process.env,
    PI_WEB_PORT: "0",
    PI_WEB_ROOT: process.cwd(),
    PI_WEB_STATE_FILE: statePath,
    PI_CODING_AGENT_DIR: join(tempDir, "pi-agent"),
  });
  const startServer = () =>
    Bun.spawn({
      cmd: ["bun", "run", "web/server/index.ts"],
      cwd: process.cwd(),
      env: serverEnv(),
      stdout: "ignore",
      stderr: "ignore",
    });
  child = startServer();
  const first = await waitForState(statePath);
  const health = (await (
    await fetch(`http://127.0.0.1:${first.port}/api/health`)
  ).json()) as { assets?: boolean; root?: string; pid?: number };
  expect(health.assets).toBe(true);
  expect(health.root).toBe(process.cwd());
  expect(health.pid).toBe(first.pid);

  const second = startServer();
  const outcome = await Promise.race([
    second.exited.then((code) => code),
    Bun.sleep(15_000).then(() => "timeout" as const),
  ]);
  if (outcome === "timeout") {
    second.kill("SIGKILL");
    throw new Error("second daemon did not defer to the running daemon");
  }
  expect(outcome).toBe(0);
  const after = await waitForState(statePath);
  expect(after.pid).toBe(first.pid);
  expect(after.port).toBe(first.port);
  const stillHealthy = await fetch(`http://127.0.0.1:${first.port}/api/health`);
  expect(stillHealthy.ok).toBe(true);
}, 30_000);

test("a daemon whose checkout disappeared is replaced by the next spawn", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-web-evict-test-"));
  const statePath = join(tempDir, "server.json");
  const agentDir = join(tempDir, "pi-agent");
  const vanishingRoot = join(tempDir, "vanishing-checkout");
  await mkdir(vanishingRoot, { recursive: true });
  const serverEnv = (root: string) => ({
    ...process.env,
    PI_WEB_PORT: "0",
    PI_WEB_ROOT: root,
    PI_WEB_STATE_FILE: statePath,
    PI_CODING_AGENT_DIR: agentDir,
  });
  const startServer = (root: string) =>
    Bun.spawn({
      cmd: ["bun", "run", "web/server/index.ts"],
      cwd: process.cwd(),
      env: serverEnv(root),
      stdout: "ignore",
      stderr: "ignore",
    });
  child = startServer(vanishingRoot);
  const doomed = await waitForState(statePath);
  const doomedHealth = (await (
    await fetch(`http://127.0.0.1:${doomed.port}/api/health`)
  ).json()) as { assets?: boolean; root?: string };
  expect(doomedHealth.assets).toBe(false);
  expect(doomedHealth.root).toBe(vanishingRoot);
  const shell = await fetch(`http://127.0.0.1:${doomed.port}/`);
  expect(shell.status).toBe(404);

  await rm(vanishingRoot, { recursive: true, force: true });
  // Keep an explicit handle on the doomed daemon: if eviction does not
  // happen, afterEach must still reap it instead of leaking the process.
  evictedDaemon = child;
  const replacement = startServer(process.cwd());
  child = replacement;
  let successor: ServerStateFile | undefined;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(
        await readFile(statePath, "utf8"),
      ) as ServerStateFile;
      // The evicted daemon deletes the shared state file on exit; the
      // replacement rewrites it once serving, so ENOENT is an expected window.
      if (state.pid !== doomed.pid) {
        successor = state;
        break;
      }
    } catch {
      // State file is between deletion and rewrite.
    }
    await Bun.sleep(50);
  }
  if (!successor) throw new Error("replacement daemon never took over");
  const successorPort = successor.port;
  const successorPid = successor.pid;
  const successorHealth = await (async () => {
    const deadline = Date.now() + 8_000;
    for (;;) {
      try {
        const response = await fetch(
          `http://127.0.0.1:${successorPort}/api/health`,
        );
        const payload = (await response.json()) as {
          assets?: boolean;
          pid?: number;
        };
        if (payload.assets === true) return payload;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) throw new Error("successor never served");
      await Bun.sleep(50);
    }
  })();
  expect(successorHealth.pid).toBe(successorPid);
  const restoredShell = await fetch(`http://127.0.0.1:${successorPort}/`);
  expect(restoredShell.status).toBe(200);
  expect(await restoredShell.text()).toContain('<div id="root"></div>');
  let doomedStillAlive = true;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      process.kill(doomed.pid, 0);
      await Bun.sleep(100);
    } catch {
      doomedStillAlive = false;
      break;
    }
  }
  expect(doomedStillAlive).toBe(false);
}, 60_000);
