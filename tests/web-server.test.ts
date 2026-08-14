import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compareWebSessions, moveWebQueuedMessage, moveWebSession, moveWebSessionRelative, orderWebSessions, type ServerStateFile, type WebQueuedMessage, type WebSession } from "../web/protocol.ts";
import { clearSessionProjectCache, resolveSessionProject } from "../web/server/projects.ts";
import { createWebWorktree, WORKTREE_SESSION_ENTRY } from "../web/server/worktrees.ts";

let child: Bun.Subprocess | undefined;
let tempDir: string | undefined;

function session(id: string, status: WebSession["status"], createdAt: number, updatedAt: number): WebSession {
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
	expect([older, newer].sort(compareWebSessions).map((item) => item.id)).toEqual(["newer", "older"]);
	older.updatedAt = 20_000;
	expect([older, newer].sort(compareWebSessions).map((item) => item.id)).toEqual(["newer", "older"]);
	const customOrder = moveWebSession([older, newer], [], "older", "newer");
	expect(orderWebSessions([newer, older], customOrder).map((item) => item.id)).toEqual(["older", "newer"]);
	const movedToBottom = moveWebSessionRelative([older, newer], customOrder, "older", { afterId: "newer" });
	expect(orderWebSessions([older, newer], movedToBottom).map((item) => item.id)).toEqual(["newer", "older"]);
	const newestInactive = session("inactive", "offline", 300, 400);
	expect([older, newestInactive, newer].sort(compareWebSessions).map((item) => item.id)).toEqual(["inactive", "newer", "older"]);
});

test("queued follow-ups can move into any insertion slot without losing attachments", () => {
	const queue: WebQueuedMessage[] = [
		{ id: "first", message: "first" },
		{ id: "second", message: "second", images: [{ type: "image", data: "image", mimeType: "image/png" }] },
		{ id: "third", message: "third" },
	];
	expect(moveWebQueuedMessage(queue, "third", { beforeId: "first" }).map((item) => item.id)).toEqual(["third", "first", "second"]);
	const movedToEnd = moveWebQueuedMessage(queue, "first", { afterId: "third" });
	expect(movedToEnd.map((item) => item.id)).toEqual(["second", "third", "first"]);
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
});

afterEach(async () => {
	if (child) {
		child.kill("SIGTERM");
		await child.exited.catch(() => undefined);
		child = undefined;
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

function browserSocket(url: string, origin = new URL(url.replace(/^ws/, "http")).origin): WebSocket {
	// Bun's WebSocket client accepts request headers as its second argument.
	return new WebSocket(url, { headers: { Origin: origin } } as unknown as string[]);
}

function sessionCommand(url: string, sessionId: string, command: Record<string, unknown>): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = browserSocket(url);
		const requestId = crypto.randomUUID();
		const timeout = setTimeout(() => { socket.close(); reject(new Error("session command timed out")); }, 10_000);
		socket.onopen = () => {
			socket.send(JSON.stringify({ type: "client.command_hello" }));
			socket.send(JSON.stringify({ type: "client.command", requestId, sessionId, command }));
		};
		socket.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; requestId?: string; success?: boolean; error?: string; data?: unknown };
			if (message.type === "server.snapshot") {
				clearTimeout(timeout);
				socket.close();
				reject(new Error("command-only websocket unexpectedly received the session catalog"));
				return;
			}
			if (message.type !== "server.response" || message.requestId !== requestId) return;
			clearTimeout(timeout);
			socket.close();
			if (message.success) resolve(message.data);
			else reject(new Error(message.error ?? "session command failed"));
		};
		socket.onerror = () => { clearTimeout(timeout); reject(new Error("session command websocket failed")); };
	});
}

function semanticHistory(url: string, sessionId: string): Promise<unknown[]> {
	return new Promise((resolve, reject) => {
		const socket = browserSocket(url);
		const timeout = setTimeout(() => { socket.close(); reject(new Error("semantic history test timed out")); }, 3_000);
		socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
		socket.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; sessionId?: string; entries?: unknown[] };
			if (message.type === "server.snapshot") {
				socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
			}
			if (message.type === "server.history" && message.sessionId === sessionId) {
				clearTimeout(timeout);
				socket.close();
				resolve(message.entries ?? []);
			}
		};
		socket.onerror = () => { clearTimeout(timeout); reject(new Error("semantic websocket failed")); };
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
			if (!message || typeof message !== "object" || !("type" in message) || message.type !== "server.snapshot") return;
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

function nativeLifecycleStatuses(url: string, sessionId: string, agent: WebSocket): Promise<string[]> {
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
			const message = JSON.parse(String(data)) as { type?: string; sessionId?: string; session?: WebSession };
			if (message.type === "server.snapshot") socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
			if (message.type === "server.history" && message.sessionId === sessionId && !started) {
				started = true;
				agent.send(JSON.stringify({ type: "agent.event", sessionId, event: { type: "agent_start" } }));
				return;
			}
			if (!started || message.type !== "server.session" || message.session?.id !== sessionId) return;
			if (message.session.status === "working" && statuses.length === 0) {
				statuses.push("working");
				agent.send(JSON.stringify({ type: "agent.event", sessionId, event: { type: "agent_end" } }));
			} else if (message.session.status === "idle" && statuses[0] === "working" && statuses.length === 1) {
				statuses.push("idle");
				agent.send(JSON.stringify({
					type: "agent.update",
					session: { ...message.session, status: "working", updatedAt: Date.now() },
				}));
			} else if (message.session.status === "idle" && statuses.length === 2) {
				statuses.push("idle");
				clearTimeout(timeout);
				socket.close();
				resolve(statuses);
			}
		};
		socket.onerror = () => { clearTimeout(timeout); reject(new Error("native lifecycle websocket failed")); };
	});
}

function nativeUpdatePayload(url: string, sessionId: string, agent: WebSocket, session: WebSession): Promise<WebSession> {
	return new Promise((resolve, reject) => {
		const socket = browserSocket(url);
		let updateSent = false;
		const timeout = setTimeout(() => {
			socket.close();
			reject(new Error("native update metadata timed out"));
		}, 3_000);
		socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
		socket.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; sessionId?: string; session?: WebSession };
			if (message.type === "server.snapshot") socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
			if (message.type === "server.history" && message.sessionId === sessionId && !updateSent) {
				updateSent = true;
				agent.send(JSON.stringify({ type: "agent.update", session }));
				return;
			}
			if (!updateSent || message.type !== "server.session" || message.session?.id !== sessionId) return;
			clearTimeout(timeout);
			socket.close();
			resolve(message.session);
		};
		socket.onerror = () => { clearTimeout(timeout); reject(new Error("native update websocket failed")); };
	});
}

test("Bun web server keeps tokenless clients inside localhost and same-origin trust boundaries", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pi-kit-web-test-"));
	const statePath = join(tempDir, "server.json");
	const port = 32_000 + Math.floor(Math.random() * 8_000);
	child = Bun.spawn({
		cmd: ["bun", "run", "web/server/index.ts"],
		cwd: process.cwd(),
		env: {
			...process.env,
			PI_WEB_PORT: String(port),
			PI_WEB_ROOT: process.cwd(),
			PI_WEB_STATE_FILE: statePath,
			PI_CODING_AGENT_DIR: join(tempDir, "pi-agent"),
		},
		stdout: "ignore",
		stderr: "ignore",
	});

	const state = await waitForState(statePath);
	expect(state.port).toBe(port);

	const health = await fetch(`http://127.0.0.1:${port}/api/health`);
	expect(health.ok).toBe(true);
	expect((await health.json() as { ok: boolean }).ok).toBe(true);

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
	const forbiddenTailscale = await fetch(`http://127.0.0.1:${port}/api/tailscale`, {
		method: "POST",
		headers: { "content-type": "text/plain", Origin: "https://attacker.example" },
		body: JSON.stringify({ enabled: false }),
	});
	expect(forbiddenTailscale.status).toBe(403);

	const reboundOrigin = await fetch(`http://127.0.0.1:${port}/api/tailscale`, {
		method: "POST",
		headers: { "content-type": "application/json", Host: "attacker.example", Origin: "https://attacker.example" },
		body: JSON.stringify({ enabled: false }),
	});
	expect(reboundOrigin.status).toBe(403);

	const trustedLocalOrigin = await fetch(`http://127.0.0.1:${port}/api/tailscale`, {
		method: "POST",
		headers: { "content-type": "application/json", Origin: `http://127.0.0.1:${port}` },
		body: JSON.stringify({ enabled: false, httpsPort: 443 }),
	});
	expect(trustedLocalOrigin.status).toBe(200);

	const snapshot = await websocketSnapshot(`ws://127.0.0.1:${port}/ws/client`) as {
		type: string;
		sessions: unknown[];
	};
	expect(snapshot.type).toBe("server.snapshot");
	expect(Array.isArray(snapshot.sessions)).toBe(true);

	for (const [path, origin] of [["/ws/client", "https://attacker.example"], ["/ws/agent", `http://127.0.0.1:${port}`]] as const) {
		await new Promise<void>((resolve, reject) => {
			const untrusted = browserSocket(`ws://127.0.0.1:${port}${path}`, origin);
			const timeout = setTimeout(() => reject(new Error(`browser origin was accepted by ${path}`)), 1_000);
			untrusted.onopen = () => { clearTimeout(timeout); untrusted.close(); reject(new Error(`browser origin was accepted by ${path}`)); };
			untrusted.onerror = () => { clearTimeout(timeout); resolve(); };
			untrusted.onclose = () => { clearTimeout(timeout); resolve(); };
		});
	}

	const sessionId = `semantic-${crypto.randomUUID()}`;
	const managedWorktree = { path: join(tempDir, "worktree"), repoRoot: tempDir, name: "worktree", branch: "feature", branchCreated: false };
	const nativeSession: WebSession = { id: sessionId, cwd: tempDir, status: "idle", source: "tui", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 1 };
	const agent = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
	await new Promise<void>((resolve, reject) => {
		agent.onopen = () => {
			agent.send(JSON.stringify({
				type: "agent.hello",
				session: nativeSession,
				entries: [
					{ id: "entry-1", type: "message", message: { role: "user", content: "semantic history" } },
					{ id: "worktree-1", type: "custom", customType: WORKTREE_SESSION_ENTRY, data: managedWorktree },
				],
			}));
			resolve();
		};
		agent.onerror = () => reject(new Error("native agent websocket failed"));
	});
	await Bun.sleep(25);
	const history = await semanticHistory(`ws://127.0.0.1:${port}/ws/client`, sessionId);
	expect(history).toHaveLength(2);
	const updated = await nativeUpdatePayload(`ws://127.0.0.1:${port}/ws/client`, sessionId, agent, {
		...nativeSession,
		updatedAt: Date.now() + 1,
		messageCount: 2,
	});
	expect(updated.managedWorktree).toEqual(managedWorktree);
	expect(await nativeLifecycleStatuses(`ws://127.0.0.1:${port}/ws/client`, sessionId, agent)).toEqual(["working", "idle", "idle"]);
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
		const message = JSON.parse(String(data)) as { type?: string; requestId?: string; command?: { type?: string; message?: string } };
		if (message.type !== "agent.command" || message.command?.type !== "prompt" || !message.requestId) return;
		order.push(deliveryStarted ? "prompt-after-transcript" : "prompt-before-transcript");
		agent.send(JSON.stringify({ type: "agent.response", requestId: message.requestId, success: true }));
	};
	return await new Promise((resolve, reject) => {
		const socket = browserSocket(url);
		const requestId = crypto.randomUUID();
		const timeout = setTimeout(() => { socket.close(); reject(new Error("queued delivery transition timed out")); }, 10_000);
		socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
		socket.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; event?: { type?: string; phase?: string; item?: { id?: string }; queue?: unknown[] } };
			if (message.type === "server.snapshot") {
				socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
				socket.send(JSON.stringify({ type: "client.prompt", requestId, sessionId, message: "queued transcript message", streamingBehavior: "followUp" }));
			}
			if (message.type !== "server.event") return;
			if (message.event?.type === "web_queue_update" && message.event.queue?.length === 1 && !settledSent) {
				settledSent = true;
				if (completionEvent === "agent_settled") {
					agent.send(JSON.stringify({ type: "agent.event", sessionId, event: { type: "agent_end" } }));
				}
				agent.send(JSON.stringify({ type: "agent.event", sessionId, event: { type: completionEvent } }));
			}
			if (message.event?.type === "web_queue_delivery" && message.event.phase === "started") {
				deliveryStarted = true;
				order.push("transcript");
			}
			if (message.event?.type === "web_queue_update" && settledSent && message.event.queue?.length === 0) {
				order.push("queue-cleared");
				clearTimeout(timeout);
				socket.close();
				resolve(order);
			}
		};
		socket.onerror = () => { clearTimeout(timeout); reject(new Error("queued delivery websocket failed")); };
	});
}

async function steerQueuedFollowUpNow(url: string, sessionId: string, agent: WebSocket): Promise<{ behavior?: string; transcriptBeforePrompt: boolean; queueCleared: boolean }> {
	let deliveryStarted = false;
	let deliveryStartedWhenPrompted = false;
	let behavior: string | undefined;
	agent.onmessage = ({ data }) => {
		const message = JSON.parse(String(data)) as { type?: string; requestId?: string; command?: { type?: string; streamingBehavior?: string } };
		if (message.type !== "agent.command" || message.command?.type !== "prompt" || !message.requestId) return;
		behavior = message.command.streamingBehavior;
		deliveryStartedWhenPrompted = deliveryStarted;
		agent.send(JSON.stringify({ type: "agent.response", requestId: message.requestId, success: true }));
	};
	return await new Promise((resolve, reject) => {
		const socket = browserSocket(url);
		const queueRequestId = crypto.randomUUID();
		const steerRequestId = crypto.randomUUID();
		let steerSent = false;
		let steerSucceeded = false;
		let queueCleared = false;
		const timeout = setTimeout(() => { socket.close(); reject(new Error("immediate queued steer timed out")); }, 10_000);
		const finish = () => {
			if (!steerSucceeded || !queueCleared || !behavior) return;
			clearTimeout(timeout);
			socket.close();
			resolve({ behavior, transcriptBeforePrompt: deliveryStartedWhenPrompted, queueCleared });
		};
		socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
		socket.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; requestId?: string; success?: boolean; event?: { type?: string; phase?: string; queue?: Array<{ id?: string }> } };
			if (message.type === "server.snapshot") {
				socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
				socket.send(JSON.stringify({ type: "client.prompt", requestId: queueRequestId, sessionId, message: "steer this now", streamingBehavior: "followUp" }));
			}
			if (message.event?.type === "web_queue_update" && message.event.queue?.some((item) => item.id === queueRequestId) && !steerSent) {
				steerSent = true;
				socket.send(JSON.stringify({ type: "client.command", requestId: steerRequestId, sessionId, command: { type: "steer_queue_item", itemId: queueRequestId } }));
			}
			if (message.event?.type === "web_queue_delivery" && message.event.phase === "started") deliveryStarted = true;
			if (steerSent && message.event?.type === "web_queue_update" && message.event.queue?.length === 0) {
				queueCleared = true;
				finish();
			}
			if (message.type === "server.response" && message.requestId === steerRequestId) {
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
		socket.onerror = () => { clearTimeout(timeout); reject(new Error("immediate queued steer websocket failed")); };
	});
}

async function idleQueueReplacementStartsAutomatically(url: string, sessionId: string, agent: WebSocket): Promise<string | undefined> {
	let behavior: string | undefined;
	return await new Promise((resolve, reject) => {
		const socket = browserSocket(url);
		const requestId = crypto.randomUUID();
		let replaced = false;
		const timeout = setTimeout(() => { socket.close(); reject(new Error("idle replacement queue timed out")); }, 10_000);
		agent.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; requestId?: string; command?: { type?: string; streamingBehavior?: string } };
			if (message.type !== "agent.command" || message.command?.type !== "prompt" || !message.requestId) return;
			behavior = message.command.streamingBehavior;
			agent.send(JSON.stringify({ type: "agent.response", requestId: message.requestId, success: true }));
		};
		socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
		socket.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; session?: { id?: string; status?: string }; event?: { type?: string; queue?: unknown[] } };
			if (message.type === "server.snapshot") socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
			if (message.type === "server.history") {
				agent.send(JSON.stringify({ type: "agent.event", sessionId, event: { type: "agent_end" } }));
				agent.send(JSON.stringify({ type: "agent.event", sessionId, event: { type: "agent_settled" } }));
			}
			if (!replaced && message.type === "server.session" && message.session?.id === sessionId && message.session.status === "idle") {
				replaced = true;
				socket.send(JSON.stringify({ type: "client.command", requestId, sessionId, command: { type: "replace_queue", queue: [{ id: "idle-replacement", message: "deliver from idle" }] } }));
			}
			if (replaced && message.event?.type === "web_queue_update" && message.event.queue?.length === 0) {
				clearTimeout(timeout);
				socket.close();
				resolve(behavior);
			}
		};
		socket.onerror = () => { clearTimeout(timeout); reject(new Error("idle replacement queue websocket failed")); };
	});
}

async function rejectedPromptPreservesLegacyQueueFallback(url: string, sessionId: string, agent: WebSocket): Promise<string | undefined> {
	let queuedBehavior: string | undefined;
	return await new Promise((resolve, reject) => {
		const socket = browserSocket(url);
		const queueRequestId = crypto.randomUUID();
		const rejectedRequestId = crypto.randomUUID();
		let completionSent = false;
		let rejectionSent = false;
		let rejectionObserved = false;
		const timeout = setTimeout(() => { socket.close(); reject(new Error("rejected prompt queue fallback timed out")); }, 10_000);
		agent.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; requestId?: string; command?: { type?: string; message?: string; streamingBehavior?: string } };
			if (message.type !== "agent.command" || message.command?.type !== "prompt" || !message.requestId) return;
			if (message.command.message === "reject during grace") {
				// Settlement belongs to the run that emitted agent_end, not this admitted
				// prompt. Its later rejection must still roll back optimistic working state.
				agent.send(JSON.stringify({ type: "agent.event", sessionId, event: { type: "agent_settled" } }));
				setTimeout(() => agent.send(JSON.stringify({ type: "agent.response", requestId: message.requestId, success: false, error: "rejected for test" })), 10);
			} else if (message.command.message === "deliver despite rejection") {
				queuedBehavior = message.command.streamingBehavior;
				agent.send(JSON.stringify({ type: "agent.response", requestId: message.requestId, success: true }));
			}
		};
		socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
		socket.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; requestId?: string; success?: boolean; session?: { id?: string; status?: string }; event?: { type?: string; queue?: unknown[] } };
			if (message.type === "server.snapshot") {
				socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
				socket.send(JSON.stringify({ type: "client.prompt", requestId: queueRequestId, sessionId, message: "deliver despite rejection", streamingBehavior: "followUp" }));
			}
			if (message.event?.type === "web_queue_update" && message.event.queue?.length === 1 && !completionSent) {
				completionSent = true;
				agent.send(JSON.stringify({ type: "agent.event", sessionId, event: { type: "agent_end" } }));
			}
			if (completionSent && !rejectionSent && message.type === "server.session" && message.session?.id === sessionId && message.session.status === "idle") {
				rejectionSent = true;
				socket.send(JSON.stringify({ type: "client.prompt", requestId: rejectedRequestId, sessionId, message: "reject during grace" }));
			}
			if (message.type === "server.response" && message.requestId === rejectedRequestId && message.success === false) rejectionObserved = true;
			if (rejectionObserved && message.event?.type === "web_queue_update" && message.event.queue?.length === 0) {
				clearTimeout(timeout);
				socket.close();
				resolve(queuedBehavior);
			}
		};
		socket.onerror = () => { clearTimeout(timeout); reject(new Error("rejected prompt queue fallback websocket failed")); };
	});
}

async function lateSettlementDoesNotBurstQueue(url: string, sessionId: string, agent: WebSocket): Promise<number[]> {
	const promptCounts: number[] = [];
	let promptCount = 0;
	return await new Promise((resolve, reject) => {
		const socket = browserSocket(url);
		const replaceRequestId = crypto.randomUUID();
		let completionSent = false;
		let secondCompletionSent = false;
		const timeout = setTimeout(() => { socket.close(); reject(new Error("late settlement queue test timed out")); }, 10_000);
		agent.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; requestId?: string; command?: { type?: string } };
			if (message.type !== "agent.command" || message.command?.type !== "prompt" || !message.requestId) return;
			promptCount += 1;
			agent.send(JSON.stringify({ type: "agent.response", requestId: message.requestId, success: true }));
			if (promptCount === 1) {
				setTimeout(() => agent.send(JSON.stringify({ type: "agent.event", sessionId, event: { type: "agent_settled" } })), 10);
				setTimeout(() => {
					promptCounts.push(promptCount);
					secondCompletionSent = true;
					agent.send(JSON.stringify({ type: "agent.event", sessionId, event: { type: "agent_end" } }));
				}, 160);
			}
		};
		socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
		socket.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; requestId?: string; success?: boolean; event?: { type?: string; queue?: unknown[] } };
			if (message.type === "server.snapshot") {
				socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
				socket.send(JSON.stringify({
					type: "client.command", requestId: replaceRequestId, sessionId,
					command: { type: "replace_queue", queue: [{ id: "late-1", message: "first" }, { id: "late-2", message: "second" }] },
				}));
			}
			if (message.event?.type === "web_queue_update" && message.event.queue?.length === 2 && !completionSent) {
				completionSent = true;
				agent.send(JSON.stringify({ type: "agent.event", sessionId, event: { type: "agent_end" } }));
			}
			if (secondCompletionSent && message.event?.type === "web_queue_update" && message.event.queue?.length === 0) {
				promptCounts.push(promptCount);
				clearTimeout(timeout);
				socket.close();
				resolve(promptCounts);
			}
		};
		socket.onerror = () => { clearTimeout(timeout); reject(new Error("late settlement queue websocket failed")); };
	});
}

async function promptAdmissionStatus(url: string, sessionId: string, agent: WebSocket): Promise<string[]> {
	const statuses: string[] = [];
	agent.onmessage = ({ data }) => {
		const message = JSON.parse(String(data)) as { type?: string; requestId?: string; command?: { type?: string } };
		if (message.type === "agent.command" && message.command?.type === "prompt" && message.requestId) {
			agent.send(JSON.stringify({ type: "agent.response", requestId: message.requestId, success: true }));
		}
	};
	return await new Promise((resolve, reject) => {
		const socket = browserSocket(url);
		const requestId = crypto.randomUUID();
		let prompted = false;
		const timeout = setTimeout(() => { socket.close(); reject(new Error("prompt admission status timed out")); }, 10_000);
		socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
		socket.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; requestId?: string; success?: boolean; session?: { id?: string; status?: string } };
			if (message.type === "server.snapshot") socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
			if (message.type === "server.history") {
				agent.send(JSON.stringify({ type: "agent.event", sessionId, event: { type: "agent_end" } }));
				agent.send(JSON.stringify({ type: "agent.event", sessionId, event: { type: "agent_settled" } }));
			}
			if (message.type === "server.session" && message.session?.id === sessionId && message.session.status === "idle" && !prompted) {
				prompted = true;
				statuses.push("idle");
				socket.send(JSON.stringify({ type: "client.prompt", requestId, sessionId, message: "start immediately" }));
			} else if (prompted && message.type === "server.session" && message.session?.id === sessionId && message.session.status === "working") {
				if (statuses.at(-1) !== "working") statuses.push("working");
			}
			if (message.type === "server.response" && message.requestId === requestId) {
				clearTimeout(timeout);
				socket.close();
				if (!message.success) reject(new Error("prompt admission failed"));
				else resolve(statuses);
			}
		};
		socket.onerror = () => { clearTimeout(timeout); reject(new Error("prompt admission websocket failed")); };
	});
}

async function promptAcknowledgementLossBecomesUncertain(url: string, sessionId: string, agent: WebSocket): Promise<boolean> {
	return await new Promise((resolve, reject) => {
		const socket = browserSocket(url);
		const requestId = crypto.randomUUID();
		let completionSent = false;
		const timeout = setTimeout(() => { socket.close(); reject(new Error("prompt acknowledgement uncertainty timed out")); }, 10_000);
		agent.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; requestId?: string; command?: { type?: string } };
			if (message.type === "agent.command" && message.command?.type === "prompt" && message.requestId) agent.close();
		};
		socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
		socket.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; event?: { type?: string; phase?: string; queue?: Array<{ deliveryState?: string }> } };
			if (message.type === "server.snapshot") {
				socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
				socket.send(JSON.stringify({ type: "client.prompt", requestId, sessionId, message: "do not redeliver", streamingBehavior: "followUp" }));
			}
			if (message.event?.type === "web_queue_update" && message.event.queue?.length === 1 && !completionSent) {
				completionSent = true;
				agent.send(JSON.stringify({ type: "agent.event", sessionId, event: { type: "agent_end" } }));
				agent.send(JSON.stringify({ type: "agent.event", sessionId, event: { type: "agent_settled" } }));
			}
			if (message.event?.type === "web_queue_delivery" && message.event.phase === "uncertain") {
				clearTimeout(timeout);
				socket.close();
				resolve(true);
			}
		};
		socket.onerror = () => { clearTimeout(timeout); reject(new Error("prompt acknowledgement uncertainty websocket failed")); };
	});
}

async function compactionLifecycle(url: string, sessionId: string, agent: WebSocket): Promise<Array<{ reason?: string; status: string }>> {
	return await new Promise((resolve, reject) => {
		const states: Array<{ reason?: string; status: string }> = [];
		const socket = browserSocket(url);
		let started = false;
		let ended = false;
		const timeout = setTimeout(() => { socket.close(); reject(new Error("compaction lifecycle timed out")); }, 10_000);
		socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
		socket.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; sessionId?: string; session?: { id?: string; status?: string; compaction?: { reason?: string } } };
			if (message.type === "server.snapshot") socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
			if (message.type === "server.history" && message.sessionId === sessionId && !started) {
				started = true;
				agent.send(JSON.stringify({ type: "agent.event", sessionId, event: { type: "compaction_start", reason: "overflow", startedAt: Date.now(), willRetry: true } }));
			}
			if (message.type !== "server.session" || message.session?.id !== sessionId || typeof message.session.status !== "string") return;
			if (message.session.compaction?.reason === "overflow" && !ended) {
				states.push({ reason: message.session.compaction.reason, status: message.session.status });
				ended = true;
				agent.send(JSON.stringify({ type: "agent.event", sessionId, event: { type: "compaction_end", reason: "overflow", aborted: false, willRetry: true } }));
			} else if (ended && !message.session.compaction) {
				states.push({ status: message.session.status });
				clearTimeout(timeout);
				socket.close();
				resolve(states);
			}
		};
		socket.onerror = () => { clearTimeout(timeout); reject(new Error("compaction lifecycle websocket failed")); };
	});
}

function waitForSemanticHistory(url: string, sessionId: string): Promise<unknown[]> {
	return new Promise((resolve, reject) => {
		const socket = browserSocket(url);
		const timeout = setTimeout(() => { socket.close(); reject(new Error("semantic history timed out")); }, 10_000);
		socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
		socket.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; sessionId?: string; entries?: unknown[] };
			if (message.type === "server.snapshot") socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
			if (message.type === "server.history" && message.sessionId === sessionId) {
				clearTimeout(timeout); socket.close(); resolve(message.entries ?? []);
			}
		};
		socket.onerror = () => { clearTimeout(timeout); reject(new Error("semantic websocket failed")); };
	});
}

test("an idle native session flushes its restored web follow-up queue on hello", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pi-kit-restored-queue-test-"));
	const statePath = join(tempDir, "web", "server.json");
	const sessionId = `restored-${crypto.randomUUID()}`;
	await mkdir(join(tempDir, "web"), { recursive: true });
	await writeFile(join(tempDir, "web", "queues.json"), JSON.stringify({
		version: 1,
		queues: { [sessionId]: [{ id: "restored-follow-up", message: "deliver after reconnect" }] },
	}));
	const port = 40_000 + Math.floor(Math.random() * 5_000);
	child = Bun.spawn({
		cmd: ["bun", "run", "web/server/index.ts"], cwd: process.cwd(),
		env: { ...process.env, PI_WEB_PORT: String(port), PI_WEB_ROOT: process.cwd(), PI_WEB_STATE_FILE: statePath, PI_CODING_AGENT_DIR: join(tempDir, "pi-agent") },
		stdout: "ignore", stderr: "ignore",
	});
	await waitForState(statePath);
	const agent = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
	const delivered = new Promise<{ type?: string; message?: string; streamingBehavior?: string }>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("restored queue was not flushed after hello")), 5_000);
		agent.onmessage = ({ data }) => {
			const frame = JSON.parse(String(data)) as { type?: string; requestId?: string; command?: { type?: string; message?: string; streamingBehavior?: string } };
			if (frame.type !== "agent.command" || frame.command?.type !== "prompt" || !frame.requestId) return;
			clearTimeout(timeout);
			agent.send(JSON.stringify({ type: "agent.response", requestId: frame.requestId, success: true }));
			resolve(frame.command);
		};
		agent.onerror = () => { clearTimeout(timeout); reject(new Error("native agent websocket failed")); };
	});
	await new Promise<void>((resolve, reject) => {
		agent.onopen = () => {
			agent.send(JSON.stringify({
				type: "agent.hello",
				session: { id: sessionId, cwd: tempDir, status: "idle", source: "tui", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 },
				entries: [],
			}));
			resolve();
		};
		agent.onerror = () => reject(new Error("native agent websocket failed"));
	});
	expect(await delivered).toEqual({ type: "prompt", message: "deliver after reconnect", streamingBehavior: "followUp" });
	agent.close();
}, 10_000);

test("a visible client can resynchronize a durable queue after a missed reconnect update", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pi-kit-queue-sync-test-"));
	const statePath = join(tempDir, "web", "server.json");
	const sessionId = `queue-sync-${crypto.randomUUID()}`;
	const expectedQueue = [{ id: "still-durable", message: "remain visible after wake" }];
	await mkdir(join(tempDir, "web"), { recursive: true });
	await writeFile(join(tempDir, "web", "queues.json"), JSON.stringify({ version: 2, queues: { [sessionId]: expectedQueue } }));
	const port = 40_000 + Math.floor(Math.random() * 5_000);
	child = Bun.spawn({
		cmd: ["bun", "run", "web/server/index.ts"], cwd: process.cwd(),
		env: { ...process.env, PI_WEB_PORT: String(port), PI_WEB_ROOT: process.cwd(), PI_WEB_STATE_FILE: statePath, PI_CODING_AGENT_DIR: join(tempDir, "pi-agent") },
		stdout: "ignore", stderr: "ignore",
	});
	await waitForState(statePath);
	const agent = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
	await new Promise<void>((resolve, reject) => {
		agent.onopen = () => {
			agent.send(JSON.stringify({
				type: "agent.hello",
				session: { id: sessionId, cwd: tempDir, status: "working", source: "tui", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 },
				entries: [],
			}));
			resolve();
		};
		agent.onerror = () => reject(new Error("queue sync agent failed"));
	});
	const synchronized = await new Promise<unknown[]>((resolve, reject) => {
		const socket = browserSocket(`ws://127.0.0.1:${port}/ws/client`);
		let queueSnapshots = 0;
		const timeout = setTimeout(() => { socket.close(); reject(new Error("queue resynchronization timed out")); }, 5_000);
		socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
		socket.onmessage = ({ data }) => {
			const frame = JSON.parse(String(data)) as { type?: string; event?: { type?: string; queue?: unknown[] } };
			if (frame.type === "server.snapshot") socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
			if (frame.event?.type !== "web_queue_update") return;
			queueSnapshots++;
			if (queueSnapshots === 1) socket.send(JSON.stringify({ type: "client.sync_queue", requestId: "wake-sync", sessionId }));
			else {
				clearTimeout(timeout);
				socket.close();
				resolve(frame.event.queue ?? []);
			}
		};
		socket.onerror = () => { clearTimeout(timeout); reject(new Error("queue sync client failed")); };
	});
	expect(synchronized).toEqual(expectedQueue);
	expect(await Bun.file(join(tempDir, "web", "queues.json")).json()).toEqual({ version: 2, queues: { [sessionId]: expectedQueue } });
	agent.close();
}, 10_000);

test("restored uncertain delivery is never automatic and requires explicit reconciliation", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pi-kit-uncertain-queue-test-"));
	const statePath = join(tempDir, "web", "server.json");
	const sessionId = `uncertain-${crypto.randomUUID()}`;
	await mkdir(join(tempDir, "web"), { recursive: true });
	await writeFile(join(tempDir, "web", "queues.json"), JSON.stringify({ version: 2, queues: { [sessionId]: [
		{ id: "maybe-sent", message: "perform once", deliveryState: "delivering" },
		{ id: "following", message: "must remain blocked" },
	] } }));
	const port = 40_000 + Math.floor(Math.random() * 5_000);
	child = Bun.spawn({ cmd: ["bun", "run", "web/server/index.ts"], cwd: process.cwd(), env: { ...process.env, PI_WEB_PORT: String(port), PI_WEB_ROOT: process.cwd(), PI_WEB_STATE_FILE: statePath, PI_CODING_AGENT_DIR: join(tempDir, "pi-agent") }, stdout: "ignore", stderr: "ignore" });
	await waitForState(statePath);
	const agent = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
	let prompts = 0;
	agent.onmessage = ({ data }) => { const frame = JSON.parse(String(data)) as { command?: { type?: string } }; if (frame.command?.type === "prompt") prompts++; };
	await new Promise<void>((resolve, reject) => { agent.onopen = () => { agent.send(JSON.stringify({ type: "agent.hello", session: { id: sessionId, cwd: tempDir, status: "idle", source: "tui", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }, entries: [] })); resolve(); }; agent.onerror = () => reject(new Error("agent failed")); });
	const queuePath = join(tempDir, "web", "queues.json");
	const result = await new Promise<{ uncertain: boolean; fabricatedRejected: boolean; rejected: boolean; persistenceRejected: boolean; unchangedRejected: boolean; queue: unknown[] }>((resolve, reject) => {
		const socket = browserSocket(`ws://127.0.0.1:${port}/ws/client`); let uncertain = false; let fabricatedRejected = false; let rejected = false; let persistenceRejected = false; let unchangedRejected = false; let tested = false;
		const timeout = setTimeout(() => reject(new Error("uncertain reconciliation timed out")), 5000);
		socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
		socket.onmessage = async ({ data }) => {
			const frame = JSON.parse(String(data)) as { type?: string; requestId?: string; success?: boolean; event?: { type?: string; phase?: string; queue?: unknown[] } };
			if (frame.type === "server.snapshot") socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
			if (frame.event?.type === "web_queue_delivery" && frame.event.phase === "uncertain") uncertain = true;
			if (!tested && frame.event?.type === "web_queue_update" && Array.isArray(frame.event.queue) && frame.event.queue.length === 2) {
				tested = true;
				socket.send(JSON.stringify({ type: "client.command", requestId: "fabricated", sessionId, command: { type: "replace_queue", queue: [...frame.event.queue, { id: "fabricated", message: "never sent", deliveryState: "delivering" }] } }));
			}
			if (frame.requestId === "fabricated" && frame.success === false) {
				fabricatedRejected = true;
				socket.send(JSON.stringify({ type: "client.command", requestId: "ordinary", sessionId, command: { type: "replace_queue", queue: [{ id: "following", message: "must remain blocked" }] } }));
			}
			if (frame.requestId === "ordinary" && frame.success === false) {
				rejected = true;
				await rm(queuePath, { force: true });
				await mkdir(queuePath);
				socket.send(JSON.stringify({ type: "client.command", requestId: "discard-fails", sessionId, command: { type: "reconcile_queue", itemId: "maybe-sent", action: "discard" } }));
			}
			if (frame.requestId === "discard-fails" && frame.success === false) {
				persistenceRejected = true;
				socket.send(JSON.stringify({ type: "client.command", requestId: "unchanged", sessionId, command: { type: "replace_queue", queue: [{ id: "following", message: "must remain blocked" }] } }));
			}
			if (frame.requestId === "unchanged" && frame.success === false) {
				unchangedRejected = true;
				await rm(queuePath, { recursive: true, force: true });
				socket.send(JSON.stringify({ type: "client.command", requestId: "discard", sessionId, command: { type: "reconcile_queue", itemId: "maybe-sent", action: "discard" } }));
			}
			if (unchangedRejected && frame.event?.type === "web_queue_update" && frame.event.queue?.length === 1) { clearTimeout(timeout); socket.close(); resolve({ uncertain, fabricatedRejected, rejected, persistenceRejected, unchangedRejected, queue: frame.event.queue }); }
		};
	});
	await Bun.sleep(100);
	expect(result.uncertain).toBe(true);
	expect(result.fabricatedRejected).toBe(true);
	expect(result.rejected).toBe(true);
	expect(result.persistenceRejected).toBe(true);
	expect(result.unchangedRejected).toBe(true);
	expect(result.queue).toEqual([{ id: "following", message: "must remain blocked" }]);
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
	await writeFile(sessionFile, [
		JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: project, timestamp: new Date().toISOString() }),
		JSON.stringify({ id: "saved-entry", type: "message", message: { role: "user", content: "saved history" } }),
	].join("\n") + "\n");
	const fakePi = join(fakeBin, "pi");
	await writeFile(fakePi, `#!/usr/bin/env bun
import { createInterface } from "node:readline";
const sessionId = ${JSON.stringify(sessionId)};
const sessionFile = ${JSON.stringify(sessionFile)};
const entries = [{ id: "managed-entry", type: "message", message: { role: "assistant", content: "managed history" } }];
let reloadGeneration = 0;
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  let data;
  if (request.type === "get_state") data = { sessionId, sessionFile, messageCount: entries.length, isStreaming: false };
  else if (request.type === "get_entries") data = { entries, leafId: "managed-entry" };
  else if (request.type === "get_session_stats") data = {};
  else if (request.type === "get_commands") data = { commands: [{ name: "web-reload", description: "generation-" + reloadGeneration, source: "extension", sourceInfo: { path: "web-sessions.ts", scope: "temporary" } }] };
  else if (request.type === "prompt" && request.message === "/web-reload") reloadGeneration += 1;
  process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data }) + "\\n");
}
`);
	await chmod(fakePi, 0o755);
	const statePath = join(tempDir, "server.json");
	const port = 40_000 + Math.floor(Math.random() * 5_000);
	child = Bun.spawn({
		cmd: ["bun", "web/server/index.ts"], cwd: process.cwd(),
		env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, PI_WEB_PORT: String(port), PI_WEB_ROOT: process.cwd(), PI_WEB_STATE_FILE: statePath, PI_CODING_AGENT_DIR: agentDir },
		stdout: "ignore", stderr: "ignore",
	});
	await waitForState(statePath);

	const socket = browserSocket(`ws://127.0.0.1:${port}/ws/client`);
	let initialHistory!: () => void;
	const subscribed = new Promise<void>((resolve) => { initialHistory = resolve; });
	const resumedHistory = new Promise<unknown[]>((resolve, reject) => {
		let historyFrames = 0;
		const timeout = setTimeout(() => { socket.close(); reject(new Error("resumed session did not reach the existing subscriber")); }, 5_000);
		socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
		socket.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; sessionId?: string; entries?: unknown[] };
			if (message.type === "server.snapshot") socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
			if (message.type !== "server.history" || message.sessionId !== sessionId) return;
			historyFrames += 1;
			if (historyFrames === 1) initialHistory();
			if (historyFrames === 2) {
				clearTimeout(timeout);
				socket.close();
				resolve(message.entries ?? []);
			}
		};
		socket.onerror = () => { clearTimeout(timeout); reject(new Error("resume subscription websocket failed")); };
	});
	await subscribed;
	const response = await fetch(`http://127.0.0.1:${port}/api/sessions/resume`, {
		method: "POST",
		headers: { "content-type": "application/json", Origin: `http://127.0.0.1:${port}` },
		body: JSON.stringify({ file: sessionFile }),
	});
	const responseBody = await response.text();
	if (response.status !== 201) throw new Error(`Resume failed with ${response.status}: ${responseBody}`);
	expect(await resumedHistory).toEqual([
		{ id: "managed-entry", type: "message", message: { role: "assistant", content: "managed history" } },
	]);

	const reloadResult = new Promise<{ response: unknown; confirmation: string }>((resolve, reject) => {
		const reloadSocket = browserSocket(`ws://127.0.0.1:${port}/ws/client`);
		const requestId = crypto.randomUUID();
		let promptSent = false;
		let response: unknown;
		let confirmation: string | undefined;
		const timeout = setTimeout(() => { reloadSocket.close(); reject(new Error("resumed managed reload timed out")); }, 5_000);
		const finish = () => {
			if (response === undefined || confirmation === undefined) return;
			clearTimeout(timeout);
			reloadSocket.close();
			resolve({ response, confirmation });
		};
		reloadSocket.onopen = () => reloadSocket.send(JSON.stringify({ type: "client.hello" }));
		reloadSocket.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as {
				type?: string;
				requestId?: string;
				success?: boolean;
				data?: unknown;
				error?: string;
				event?: { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
			};
			if (message.type === "server.snapshot") reloadSocket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
			if (message.type === "server.history" && !promptSent) {
				promptSent = true;
				reloadSocket.send(JSON.stringify({ type: "client.prompt", requestId, sessionId, message: "/reload", images: [] }));
			}
			if (message.type === "server.event" && message.event?.type === "message_end") {
				confirmation = message.event.message?.content?.find((part) => part.type === "text")?.text;
				finish();
			}
			if (message.type !== "server.response" || message.requestId !== requestId) return;
			if (!message.success) {
				clearTimeout(timeout);
				reloadSocket.close();
				reject(new Error(message.error ?? "resumed managed reload failed"));
				return;
			}
			response = message.data;
			finish();
		};
	});
	expect(await reloadResult).toEqual({ response: { reloaded: true }, confirmation: "Reload complete." });
	const afterReload = await fetch(`http://127.0.0.1:${port}/api/sessions`).then((result) => result.json()) as { sessions: Array<{ id: string; status: string }> };
	expect(afterReload.sessions.find((session) => session.id === sessionId)?.status).toBe("idle");
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
	const port = 40_000 + Math.floor(Math.random() * 5_000);
	child = Bun.spawn({
		cmd: ["bun", "run", "web/server/index.ts"], cwd: process.cwd(),
		env: {
			...process.env,
			PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
			PI_WEB_PORT: String(port),
			PI_WEB_ROOT: process.cwd(),
			PI_WEB_STATE_FILE: statePath,
			PI_WEB_RPC_TIMEOUT_MS: "50",
			PI_CODING_AGENT_DIR: join(tempDir, "pi-agent"),
		},
		stdout: "ignore", stderr: "ignore",
	});
	await waitForState(statePath);
	const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
		method: "POST",
		headers: { "content-type": "application/json", Origin: `http://127.0.0.1:${port}` },
		body: JSON.stringify({ cwd: project }),
	});
	expect(response.status).toBe(500);
	expect(await response.text()).toContain("RPC command get_state timed out after 50ms");
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
	await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: project, timestamp: new Date().toISOString() })}\n`);
	await writeFile(queuePath, JSON.stringify({ version: 2, queues: { [sessionId]: [{ id: "retained", message: "do not lose" }] } }));
	const port = 40_000 + Math.floor(Math.random() * 5_000);
	child = Bun.spawn({
		cmd: ["bun", "run", "web/server/index.ts"], cwd: process.cwd(),
		env: { ...process.env, PI_WEB_PORT: String(port), PI_WEB_ROOT: process.cwd(), PI_WEB_STATE_FILE: statePath, PI_CODING_AGENT_DIR: agentDir },
		stdout: "ignore", stderr: "ignore",
	});
	await waitForState(statePath);
	await fetch(`http://127.0.0.1:${port}/api/sessions`);
	await rm(queuePath, { force: true });
	await mkdir(queuePath);

	const failed = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}`, {
		method: "DELETE",
		headers: { Origin: `http://127.0.0.1:${port}` },
	});
	expect(failed.status).toBe(400);
	expect(await readFile(sessionFile, "utf8")).toContain(sessionId);
	const afterFailure = await fetch(`http://127.0.0.1:${port}/api/sessions`).then((response) => response.json()) as { sessions: WebSession[] };
	expect(afterFailure.sessions.some((item) => item.id === sessionId)).toBe(true);

	await rm(queuePath, { recursive: true, force: true });
	const retried = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}`, {
		method: "DELETE",
		headers: { Origin: `http://127.0.0.1:${port}` },
	});
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
	await writeFile(sessionFile, [
		JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: worktree.path, timestamp: new Date().toISOString() }),
		JSON.stringify({ type: "custom", id: "managed-worktree", parentId: null, timestamp: new Date().toISOString(), customType: WORKTREE_SESSION_ENTRY, data: worktree }),
	].join("\n") + "\n");
	const statePath = join(tempDir, "server.json");
	const port = 40_000 + Math.floor(Math.random() * 5_000);
	child = Bun.spawn({
		cmd: ["bun", "run", "web/server/index.ts"], cwd: process.cwd(),
		env: { ...process.env, PI_WEB_PORT: String(port), PI_WEB_ROOT: process.cwd(), PI_WEB_STATE_FILE: statePath, PI_CODING_AGENT_DIR: agentDir },
		stdout: "ignore", stderr: "ignore",
	});
	await waitForState(statePath);
	const origin = `http://127.0.0.1:${port}`;
	const response = await fetch(`${origin}/api/sessions/${encodeURIComponent(sessionId)}`, {
		method: "DELETE",
		headers: { Origin: origin },
	});
	expect(response.status).toBe(200);
	await expect(readFile(sessionFile, "utf8")).rejects.toThrow();
	await expect(readFile(join(worktree.path, "README.md"), "utf8")).rejects.toThrow();
	expect((await Bun.$`git -C ${repository} branch --list delete-with-session`.text()).trim()).toBe("");
}, 10_000);

test("worktree cleanup failure does not turn a completed session deletion into an error", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pi-kit-delete-worktree-warning-test-"));
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
	const invalidWorktree = { path: join(repository, ".pi", "worktrees", "missing"), repoRoot: repository, branch: "missing" };
	await writeFile(doomedFile, [
		JSON.stringify({ type: "session", version: 3, id: doomedId, cwd: invalidWorktree.path, timestamp: new Date().toISOString() }),
		JSON.stringify({ type: "custom", id: "managed-worktree", parentId: null, timestamp: new Date().toISOString(), customType: WORKTREE_SESSION_ENTRY, data: invalidWorktree }),
	].join("\n") + "\n");
	await writeFile(survivorFile, `${JSON.stringify({ type: "session", version: 3, id: survivorId, cwd: repository, timestamp: new Date().toISOString() })}\n`);
	const statePath = join(tempDir, "server.json");
	const port = 40_000 + Math.floor(Math.random() * 5_000);
	child = Bun.spawn({
		cmd: ["bun", "run", "web/server/index.ts"], cwd: process.cwd(),
		env: { ...process.env, PI_WEB_PORT: String(port), PI_WEB_ROOT: process.cwd(), PI_WEB_STATE_FILE: statePath, PI_CODING_AGENT_DIR: agentDir },
		stdout: "ignore", stderr: "ignore",
	});
	await waitForState(statePath);
	const origin = `http://127.0.0.1:${port}`;
	const observer = browserSocket(`ws://127.0.0.1:${port}/ws/client`);
	let resolveReady!: () => void;
	let resolveRemoved!: (sessionId: string) => void;
	const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
	const removed = new Promise<string>((resolve) => { resolveRemoved = resolve; });
	observer.onopen = () => observer.send(JSON.stringify({ type: "client.hello" }));
	observer.onmessage = ({ data }) => {
		const message = JSON.parse(String(data)) as { type?: string; sessionId?: string };
		if (message.type === "server.snapshot") observer.send(JSON.stringify({ type: "client.subscribe", sessionId: survivorId }));
		if (message.type === "server.history" && message.sessionId === survivorId) resolveReady();
		if (message.type === "server.session_removed" && message.sessionId) resolveRemoved(message.sessionId);
	};
	await ready;
	const response = await fetch(`${origin}/api/sessions/${encodeURIComponent(doomedId)}`, {
		method: "DELETE",
		headers: { Origin: origin },
	});
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
	const replacementFile = join(sessionsRoot, "replacement", `${replacementId}.jsonl`);
	const uncommittedSourceId = `uncommitted-${crypto.randomUUID()}`;
	const uncommittedSourceFile = join(sessionsRoot, "uncommitted", `${uncommittedSourceId}.jsonl`);
	const uncommittedTombstone = `${uncommittedSourceFile}.replaced-${crypto.randomUUID()}.tmp`;
	await mkdir(dirname(sourceFile), { recursive: true });
	await mkdir(dirname(uncommittedSourceFile), { recursive: true });
	await mkdir(dirname(replacementFile), { recursive: true });
	await mkdir(webDir, { recursive: true });
	await writeFile(tombstone, `${JSON.stringify({ type: "session", version: 3, id: sourceId, timestamp: new Date().toISOString(), cwd: tempDir })}\n`);
	await writeFile(uncommittedTombstone, `${JSON.stringify({ type: "session", version: 3, id: uncommittedSourceId, timestamp: new Date().toISOString(), cwd: tempDir })}\n`);
	await writeFile(replacementFile, [
		JSON.stringify({ type: "session", version: 3, id: replacementId, timestamp: new Date().toISOString(), cwd: tempDir }),
		JSON.stringify({ type: "custom", id: crypto.randomUUID(), parentId: null, timestamp: new Date().toISOString(), customType: "vessup-replaced-session", data: { previousSessionId: sourceId, previousSessionFile: sourceFile, replacementSessionId: replacementId } }),
	].join("\n") + "\n");
	await writeFile(join(webDir, "managed-sessions.json"), `${JSON.stringify({ version: 1, files: [sourceFile, uncommittedSourceFile] })}\n`);
	await writeFile(join(webDir, "queues.json"), `${JSON.stringify({ version: 2, queues: { [sourceId]: [{ id: "queued", message: "preserve queue" }] } })}\n`);
	const port = 40_000 + Math.floor(Math.random() * 5_000);
	child = Bun.spawn({
		cmd: ["bun", "run", "web/server/index.ts"], cwd: process.cwd(),
		env: { ...process.env, PI_WEB_PORT: String(port), PI_WEB_ROOT: process.cwd(), PI_WEB_STATE_FILE: statePath, PI_CODING_AGENT_DIR: agentDir },
		stdout: "ignore", stderr: "ignore",
	});
	await waitForState(statePath);
	expect(await Bun.file(tombstone).exists()).toBe(false);
	expect(await Bun.file(sourceFile).exists()).toBe(false);
	expect(await Bun.file(uncommittedTombstone).exists()).toBe(false);
	expect(await Bun.file(uncommittedSourceFile).exists()).toBe(true);
	expect(await Bun.file(join(webDir, "managed-sessions.json")).json()).toEqual({ version: 1, files: [await realpath(uncommittedSourceFile), await realpath(replacementFile)] });
	expect(await Bun.file(join(webDir, "queues.json")).json()).toEqual({ version: 2, queues: { [replacementId]: [{ id: "queued", message: "preserve queue" }] } });
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
	await writeFile(join(repository, ".pi", "worktrees", "setup.sh"), "#!/bin/sh\nprintf 'generated by setup' > setup-generated.txt\n");
	const fakePi = join(fakeBin, "pi");
	const piStartedMarker = join(tempDir, "base-pi-started");
	await writeFile(fakePi, `#!/usr/bin/env bun
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
`);
	await chmod(fakePi, 0o755);
	const statePath = join(tempDir, "server.json");
	const port = 40_000 + Math.floor(Math.random() * 5_000);
	child = Bun.spawn({
		cmd: ["bun", "web/server/index.ts"], cwd: process.cwd(),
		env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, PI_WEB_PORT: String(port), PI_WEB_ROOT: process.cwd(), PI_WEB_STATE_FILE: statePath, PI_CODING_AGENT_DIR: agentDir },
		stdout: "ignore", stderr: "ignore",
	});
	await waitForState(statePath);
	const origin = `http://127.0.0.1:${port}`;
	const baseResponse = await fetch(`${origin}/api/sessions`, {
		method: "POST", headers: { "content-type": "application/json", Origin: origin }, body: JSON.stringify({ cwd: repository }),
	});
	expect(baseResponse.status).toBe(201);
	expect(await readFile(piStartedMarker, "utf8")).toBe("started");
	const failed = await fetch(`${origin}/api/sessions`, {
		method: "POST", headers: { "content-type": "application/json", Origin: origin },
		body: JSON.stringify({ cwd: repository, worktreeName: "startup-fails" }),
	});
	expect(failed.status).toBe(500);
	const worktree = join(repository, ".pi", "worktrees", "startup-fails");
	expect(await failed.text()).toContain("initialized worktree retained at ");
	expect(await readFile(join(worktree, "setup-generated.txt"), "utf8")).toBe("generated by setup");
	expect((await Bun.$`git -C ${repository} branch --list startup-fails`.text()).trim()).toContain("startup-fails");
}, 15_000);

test("web reload survives a native bridge reconnect", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pi-kit-native-reload-test-"));
	const statePath = join(tempDir, "server.json");
	const port = 40_000 + Math.floor(Math.random() * 5_000);
	child = Bun.spawn({
		cmd: ["bun", "run", "web/server/index.ts"], cwd: process.cwd(),
		env: { ...process.env, PI_WEB_PORT: String(port), PI_WEB_ROOT: process.cwd(), PI_WEB_STATE_FILE: statePath, PI_CODING_AGENT_DIR: join(tempDir, "pi-agent") },
		stdout: "ignore", stderr: "ignore",
	});
	await waitForState(statePath);
	const sessionId = `reload-${crypto.randomUUID()}`;
	const socketUrl = `ws://127.0.0.1:${port}`;
	const connectAgent = async () => {
		const agent = new WebSocket(`${socketUrl}/ws/agent`);
		await new Promise<void>((resolve, reject) => {
			agent.onopen = () => {
				agent.send(JSON.stringify({
					type: "agent.hello",
					session: { id: sessionId, cwd: tempDir, status: "idle", source: "tui", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 },
					entries: [],
				}));
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
		const timeout = setTimeout(() => { client.close(); reject(new Error("native reload response timed out")); }, 5_000);
		client.onopen = () => client.send(JSON.stringify({ type: "client.hello" }));
		client.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; requestId?: string; success?: boolean; data?: unknown };
			if (message.type === "server.snapshot") {
				client.send(JSON.stringify({ type: "client.prompt", requestId: clientRequestId, sessionId, message: "/reload", images: [] }));
			}
			if (message.type !== "server.response" || message.requestId !== clientRequestId) return;
			clearTimeout(timeout);
			client.close();
			message.success ? resolve(message.data) : reject(new Error("native reload failed"));
		};
	});
	const agentCommand = await new Promise<{ requestId: string; command: { type: string } }>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("reload command was not routed to native Pi")), 3_000);
		firstAgent.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; requestId?: string; command?: { type?: string } };
			if (message.type !== "agent.command" || !message.requestId || message.command?.type !== "reload") return;
			clearTimeout(timeout);
			resolve({ requestId: message.requestId, command: { type: message.command.type } });
		};
	});
	firstAgent.close();
	await Bun.sleep(25);
	const replacementAgent = await connectAgent();
	replacementAgent.send(JSON.stringify({ type: "agent.response", requestId: agentCommand.requestId, success: true, data: { reloaded: true } }));
	expect(await result).toEqual({ reloaded: true });
	replacementAgent.close();
}, 10_000);

test("queued web reload waits for active subagents and executes as a control command", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pi-kit-queued-reload-test-"));
	const statePath = join(tempDir, "server.json");
	const port = 40_000 + Math.floor(Math.random() * 5_000);
	child = Bun.spawn({
		cmd: ["bun", "run", "web/server/index.ts"], cwd: process.cwd(),
		env: { ...process.env, PI_WEB_PORT: String(port), PI_WEB_ROOT: process.cwd(), PI_WEB_STATE_FILE: statePath, PI_CODING_AGENT_DIR: join(tempDir, "pi-agent") },
		stdout: "ignore", stderr: "ignore",
	});
	await waitForState(statePath);
	const sessionId = `queued-reload-${crypto.randomUUID()}`;
	const socketUrl = `ws://127.0.0.1:${port}`;
	const agent = new WebSocket(`${socketUrl}/ws/agent`);
	let reloadCommand: { requestId: string } | undefined;
	let resolveReload!: (value: { requestId: string }) => void;
	const reloadReceived = new Promise<{ requestId: string }>((resolve) => { resolveReload = resolve; });
	agent.onmessage = ({ data }) => {
		const frame = JSON.parse(String(data)) as { type?: string; requestId?: string; command?: { type?: string } };
		if (frame.type === "agent.command" && frame.requestId && frame.command?.type === "reload") {
			reloadCommand = { requestId: frame.requestId };
			resolveReload(reloadCommand);
		}
	};
	await new Promise<void>((resolve, reject) => {
		agent.onopen = () => {
			agent.send(JSON.stringify({
				type: "agent.hello",
				session: { id: sessionId, cwd: tempDir, status: "idle", source: "tui", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 },
				entries: [],
			}));
			agent.send(JSON.stringify({
				type: "agent.subagents",
				sessionId,
				agents: [{ id: "worker", status: "working", model: "test/model", effort: "high", turns: 1, currentTool: null, queued: 0, createdAt: 1, updatedAt: 2, completedAt: null, error: null }],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			}));
			resolve();
		};
		agent.onerror = () => reject(new Error("queued reload agent failed"));
	});
	const client = browserSocket(`${socketUrl}/ws/client`);
	const requestId = crypto.randomUUID();
	let sawQueued = false;
	let resolveAdmission!: () => void;
	let resolveEmpty!: () => void;
	const admitted = new Promise<void>((resolve) => { resolveAdmission = resolve; });
	const emptied = new Promise<void>((resolve) => { resolveEmpty = resolve; });
	client.onopen = () => client.send(JSON.stringify({ type: "client.hello" }));
	client.onmessage = ({ data }) => {
		const frame = JSON.parse(String(data)) as { type?: string; requestId?: string; success?: boolean; event?: { type?: string; queue?: Array<{ id?: string }> } };
		if (frame.type === "server.snapshot") {
			client.send(JSON.stringify({ type: "client.subscribe", sessionId }));
			client.send(JSON.stringify({ type: "client.prompt", requestId, sessionId, message: "/reload", images: [], streamingBehavior: "followUp" }));
		}
		if (frame.type === "server.response" && frame.requestId === requestId && frame.success) resolveAdmission();
		if (frame.event?.type === "web_queue_update" && frame.event.queue?.some((item) => item.id === requestId)) sawQueued = true;
		if (sawQueued && frame.event?.type === "web_queue_update" && frame.event.queue?.length === 0) resolveEmpty();
	};
	await admitted;
	await Bun.sleep(50);
	expect(sawQueued).toBe(true);
	expect(reloadCommand).toBeUndefined();
	agent.send(JSON.stringify({
		type: "agent.subagents",
		sessionId,
		agents: [{ id: "worker", status: "completed", model: "test/model", effort: "high", turns: 2, currentTool: null, queued: 0, createdAt: 1, updatedAt: 3, completedAt: 3, error: null }],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	}));
	const command = await Promise.race([
		reloadReceived,
		Bun.sleep(3_000).then(() => { throw new Error("queued reload was not delivered after settlement"); }),
	]);
	agent.send(JSON.stringify({ type: "agent.response", requestId: command.requestId, success: true, data: { reloaded: true } }));
	await Promise.race([emptied, Bun.sleep(3_000).then(() => { throw new Error("accepted queued reload was not removed"); })]);
	client.close();
	agent.close();
}, 10_000);

test("native replacement recovery merges orphaned source and replacement queues", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pi-kit-native-worktree-queue-recovery-"));
	const agentDir = join(tempDir, "pi-agent");
	const webDir = join(tempDir, "web");
	const statePath = join(webDir, "server.json");
	const sourceId = `source-${crypto.randomUUID()}`;
	const replacementId = `replacement-${crypto.randomUUID()}`;
	const sourceFile = join(agentDir, "sessions", "source", `${sourceId}.jsonl`);
	const replacementFile = join(agentDir, "sessions", "replacement", `${replacementId}.jsonl`);
	await mkdir(dirname(replacementFile), { recursive: true });
	await mkdir(webDir, { recursive: true });
	await writeFile(replacementFile, [
		JSON.stringify({ type: "session", version: 3, id: replacementId, timestamp: new Date().toISOString(), cwd: tempDir }),
		JSON.stringify({ type: "custom", id: crypto.randomUUID(), parentId: null, timestamp: new Date().toISOString(), customType: "vessup-replaced-session", data: { previousSessionId: sourceId, previousSessionFile: sourceFile, replacementSessionId: replacementId } }),
	].join("\n") + "\n");
	await writeFile(join(webDir, "queues.json"), `${JSON.stringify({ version: 2, queues: {
		[sourceId]: [{ id: "source-queue", message: "from source" }],
		[replacementId]: [{ id: "replacement-queue", message: "from replacement" }],
	} })}\n`);
	const port = 40_000 + Math.floor(Math.random() * 5_000);
	child = Bun.spawn({
		cmd: ["bun", "run", "web/server/index.ts"], cwd: process.cwd(),
		env: { ...process.env, PI_WEB_PORT: String(port), PI_WEB_ROOT: process.cwd(), PI_WEB_STATE_FILE: statePath, PI_CODING_AGENT_DIR: agentDir },
		stdout: "ignore", stderr: "ignore",
	});
	await waitForState(statePath);
	const socketUrl = `ws://127.0.0.1:${port}`;
	const agent = new WebSocket(`${socketUrl}/ws/agent`);
	await new Promise<void>((resolve, reject) => {
		agent.onopen = () => {
			agent.send(JSON.stringify({ type: "agent.hello", session: { id: replacementId, file: replacementFile, cwd: tempDir, status: "working", source: "tui", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }, entries: [] }));
			resolve();
		};
		agent.onerror = () => reject(new Error("replacement recovery agent failed"));
	});
	await Bun.sleep(25);
	agent.send(JSON.stringify({ type: "agent.session_replaced", previousSessionId: sourceId, previousSessionFile: sourceFile, replacementSessionId: replacementId }));
	await Bun.sleep(50);
	const stored = await Bun.file(join(webDir, "queues.json")).json();
	expect(stored).toEqual({ version: 2, queues: { [replacementId]: [
		{ id: "source-queue", message: "from source" },
		{ id: "replacement-queue", message: "from replacement" },
	] } });
	agent.close();
}, 10_000);

test("native worktree switches survive the replacement bridge reconnect", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pi-kit-native-worktree-test-"));
	const statePath = join(tempDir, "server.json");
	const port = 40_000 + Math.floor(Math.random() * 5_000);
	child = Bun.spawn({
		cmd: ["bun", "run", "web/server/index.ts"], cwd: process.cwd(),
		env: { ...process.env, PI_WEB_PORT: String(port), PI_WEB_ROOT: process.cwd(), PI_WEB_STATE_FILE: statePath, PI_CODING_AGENT_DIR: join(tempDir, "pi-agent") },
		stdout: "ignore", stderr: "ignore",
	});
	await waitForState(statePath);
	const originalSessionId = `worktree-${crypto.randomUUID()}`;
	const replacementSessionId = `replacement-${crypto.randomUUID()}`;
	const originalSessionFile = join(tempDir, "pi-agent", "sessions", "source", `${originalSessionId}.jsonl`);
	const replacementSessionFile = join(tempDir, "pi-agent", "sessions", "replacement", `${replacementSessionId}.jsonl`);
	await mkdir(dirname(originalSessionFile), { recursive: true });
	await mkdir(dirname(replacementSessionFile), { recursive: true });
	await writeFile(originalSessionFile, `${JSON.stringify({ type: "session", version: 3, id: originalSessionId, timestamp: new Date().toISOString(), cwd: tempDir })}\n`);
	await writeFile(replacementSessionFile, [
		JSON.stringify({ type: "session", version: 3, id: replacementSessionId, timestamp: new Date().toISOString(), cwd: tempDir }),
		JSON.stringify({ type: "custom", id: crypto.randomUUID(), parentId: null, timestamp: new Date().toISOString(), customType: "vessup-replaced-session", data: { previousSessionId: originalSessionId, previousSessionFile: originalSessionFile, replacementSessionId } }),
	].join("\n") + "\n");
	const socketUrl = `ws://127.0.0.1:${port}`;
	const connectAgent = async (sessionId: string, file?: string) => {
		const agent = new WebSocket(`${socketUrl}/ws/agent`);
		await new Promise<void>((resolve, reject) => {
			agent.onopen = () => {
				agent.send(JSON.stringify({
					type: "agent.hello",
					session: { id: sessionId, file, cwd: tempDir, status: "idle", source: "tui", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 },
					entries: [],
				}));
				resolve();
			};
			agent.onerror = () => reject(new Error("worktree agent websocket failed"));
		});
		return agent;
	};
	const firstAgent = await connectAgent(originalSessionId, originalSessionFile);
	await Bun.sleep(25);
	const command = new Promise<{ requestId: string; command: { type: string; name?: string; repository?: string; branch?: string; startPoint?: string } }>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("worktree command was not routed to native Pi")), 3_000);
		firstAgent.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; requestId?: string; command?: { type?: string; name?: string; repository?: string; branch?: string; startPoint?: string } };
			if (message.type !== "agent.command" || !message.requestId || message.command?.type !== "create_worktree_v2") return;
			clearTimeout(timeout);
			resolve({ requestId: message.requestId, command: { ...message.command, type: message.command.type } });
		};
	});
	const result = new Promise<unknown>((resolve, reject) => {
		const client = browserSocket(`${socketUrl}/ws/client`);
		const clientRequestId = crypto.randomUUID();
		const timeout = setTimeout(() => { client.close(); reject(new Error("native worktree response timed out")); }, 5_000);
		client.onopen = () => client.send(JSON.stringify({ type: "client.hello" }));
		client.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; requestId?: string; success?: boolean; data?: unknown; error?: string };
			if (message.type === "server.snapshot") {
				client.send(JSON.stringify({ type: "client.prompt", requestId: clientRequestId, sessionId: originalSessionId, message: `/worktree pr-30 --repo ${tempDir} --branch tembo/cancel-builds --start-point origin/tembo/cancel-builds`, images: [] }));
			}
			if (message.type !== "server.response" || message.requestId !== clientRequestId) return;
			clearTimeout(timeout);
			client.close();
			message.success ? resolve(message.data) : reject(new Error(message.error ?? "native worktree failed"));
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
	const replacementAgent = await connectAgent(replacementSessionId, replacementSessionFile);
	let markObserverReady!: () => void;
	const observerReady = new Promise<void>((resolve) => { markObserverReady = resolve; });
	const removed = new Promise<{ type?: string; sessionId?: string; replacementSessionId?: string }>((resolve, reject) => {
		const observer = browserSocket(`${socketUrl}/ws/client`);
		const timeout = setTimeout(() => { observer.close(); reject(new Error("source session removal was not broadcast")); }, 5_000);
		observer.onopen = () => observer.send(JSON.stringify({ type: "client.hello" }));
		observer.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; sessionId?: string; replacementSessionId?: string };
			if (message.type === "server.snapshot") observer.send(JSON.stringify({ type: "client.subscribe", sessionId: replacementSessionId }));
			if (message.type === "server.history" && message.sessionId === replacementSessionId) markObserverReady();
			if (message.type !== "server.session_removed" || message.sessionId !== originalSessionId) return;
			clearTimeout(timeout);
			observer.close();
			resolve(message);
		};
	});
	await observerReady;
	await rm(originalSessionFile);
	replacementAgent.send(JSON.stringify({
		type: "agent.session_replaced",
		previousSessionId: originalSessionId,
		previousSessionFile: originalSessionFile,
		replacementSessionId,
	}));
	expect(await removed).toEqual({ type: "server.session_removed", sessionId: originalSessionId, replacementSessionId });
	// Durable replacement markers are replayed after daemon/native reconnects.
	replacementAgent.send(JSON.stringify({
		type: "agent.session_replaced",
		previousSessionId: originalSessionId,
		previousSessionFile: originalSessionFile,
		replacementSessionId,
	}));
	replacementAgent.send(JSON.stringify({ type: "agent.response", requestId: routed.requestId, success: true, data: { sessionId: replacementSessionId } }));
	expect(await result).toEqual({ sessionId: replacementSessionId });
	const catalog = await fetch(`http://127.0.0.1:${port}/api/sessions`).then((response) => response.json()) as { sessions: Array<{ id: string }> };
	expect(catalog.sessions.some((session) => session.id === originalSessionId)).toBe(false);
	expect(catalog.sessions.some((session) => session.id === replacementSessionId)).toBe(true);
	replacementAgent.close();
}, 10_000);

test("native sessions expose queued-delivery ordering and context compaction lifecycle", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pi-kit-queued-delivery-test-"));
	const statePath = join(tempDir, "server.json");
	const port = 40_000 + Math.floor(Math.random() * 5_000);
	child = Bun.spawn({
		cmd: ["bun", "run", "web/server/index.ts"], cwd: process.cwd(),
		env: { ...process.env, PI_WEB_PORT: String(port), PI_WEB_ROOT: process.cwd(), PI_WEB_STATE_FILE: statePath, PI_CODING_AGENT_DIR: join(tempDir, "pi-agent") },
		stdout: "ignore", stderr: "ignore",
	});
	await waitForState(statePath);
	const sessionId = `queued-${crypto.randomUUID()}`;
	const agent = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
	await new Promise<void>((resolve, reject) => {
		agent.onopen = () => {
			agent.send(JSON.stringify({
				type: "agent.hello",
				session: { id: sessionId, cwd: tempDir, status: "working", source: "tui", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 },
				entries: [],
			}));
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
	expect(await queuedFollowUpDeliveryOrder(socketUrl, sessionId, agent)).toEqual([
		"transcript",
		"prompt-after-transcript",
		"queue-cleared",
	]);
	// Compatibility path for native bridges loaded before agent_settled forwarding
	// was added: agent_end still advances the durable queue after a short grace.
	expect(await queuedFollowUpDeliveryOrder(socketUrl, sessionId, agent, "agent_end")).toEqual([
		"transcript",
		"prompt-after-transcript",
		"queue-cleared",
	]);
	expect(await idleQueueReplacementStartsAutomatically(socketUrl, sessionId, agent)).toBe("followUp");
	expect(await rejectedPromptPreservesLegacyQueueFallback(socketUrl, sessionId, agent)).toBe("followUp");
	expect(await lateSettlementDoesNotBurstQueue(socketUrl, sessionId, agent)).toEqual([1, 2]);
	expect(await promptAdmissionStatus(socketUrl, sessionId, agent)).toEqual(["idle", "working"]);
	expect(await compactionLifecycle(socketUrl, sessionId, agent)).toEqual([
		{ reason: "overflow", status: "working" },
		{ status: "working" },
	]);
	expect(await promptAcknowledgementLossBecomesUncertain(socketUrl, sessionId, agent)).toBe(true);
	agent.close();
}, 15_000);

test("browser sessions stay managed and idle across daemon restarts", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pi-kit-semantic-test-"));
	const statePath = join(tempDir, "server.json");
	const agentDir = join(tempDir, "pi-agent");
	const cwd = join(tempDir, "project");
	await Bun.write(join(cwd, ".keep"), "");
	const port = 40_000 + Math.floor(Math.random() * 5_000);
	const startServer = () => Bun.spawn({
		cmd: ["bun", "run", "web/server/index.ts"], cwd: process.cwd(),
		env: { ...process.env, PI_WEB_PORT: String(port), PI_WEB_ROOT: process.cwd(), PI_WEB_STATE_FILE: statePath, PI_CODING_AGENT_DIR: agentDir },
		stdout: "ignore", stderr: "ignore",
	});
	child = startServer();
	await waitForState(statePath);
	const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
		method: "POST", headers: { "content-type": "application/json", Origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ cwd, name: "semantic-test" }),
	});
	const responseText = await response.text();
	if (response.status !== 201) throw new Error(`Session creation failed with ${response.status}: ${responseText}`);
	const payload = JSON.parse(responseText) as { session: { id: string; file?: string; source: string } };
	expect(payload.session.source).toBe("web");
	expect(payload.session.file).toBeString();
	expect(await Bun.file(join(tempDir, "managed-sessions.json")).json()).toEqual({ version: 1, files: [await realpath(payload.session.file!)] });
	const socketUrl = `ws://127.0.0.1:${port}/ws/client`;
	const semanticHistory = await waitForSemanticHistory(socketUrl, payload.session.id);
	expect(Array.isArray(semanticHistory)).toBe(true);
	await writeFile(payload.session.file!, `${JSON.stringify({ id: crypto.randomUUID(), type: "message", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", timestamp: Date.now(), content: [{ type: "text", text: "persist me" }] } })}\n`, { flag: "a" });

	child.kill("SIGTERM");
	await child.exited;
	child = startServer();
	await waitForState(statePath);
	let restored: { id: string; source: string; status: string } | undefined;
	const deadline = Date.now() + 8_000;
	while (Date.now() < deadline) {
		const catalog = await fetch(`http://127.0.0.1:${port}/api/sessions`).then((result) => result.json()) as { sessions: Array<{ id: string; source: string; status: string }> };
		restored = catalog.sessions.find((session) => session.id === payload.session.id);
		if (restored?.source === "web" && restored.status === "idle") break;
		await Bun.sleep(50);
	}
	expect(restored).toEqual(expect.objectContaining({ id: payload.session.id, source: "web", status: "idle" }));

	const deleted = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(payload.session.id)}`, {
		method: "DELETE",
		headers: { Origin: `http://127.0.0.1:${port}` },
	});
	expect(deleted.status).toBe(200);
	expect(await Bun.file(join(tempDir, "managed-sessions.json")).json()).toEqual({ version: 1, files: [] });
}, 20_000);

async function waitForMirroredSession(port: number): Promise<string> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const response = await fetch(`http://127.0.0.1:${port}/api/sessions`);
		const payload = await response.json() as { sessions: Array<{ id: string; source: string; status: string }> };
		const session = payload.sessions.find((item) => item.source === "tui" && item.status !== "offline");
		if (session) return session.id;
		await Bun.sleep(50);
	}
	throw new Error("native Pi session did not register with the web server");
}

test("native Pi sessions expose semantic history without replacing their physical TUI", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pi-kit-semantic-native-test-"));
	const agentDir = join(tempDir, "pi-agent");
	await mkdir(join(agentDir, "prompts"), { recursive: true });
	await writeFile(join(agentDir, "prompts", "address-pr.md"), "---\ndescription: Get PR ready to merge\n---\nAddress the pull request.\n");
	const statePath = join(agentDir, "web", "server.json");
	const port = 45_000 + Math.floor(Math.random() * 2_000);
	child = Bun.spawn({ cmd: ["bun", "run", "web/server/index.ts"], cwd: process.cwd(), env: { ...process.env, PI_WEB_PORT: String(port), PI_WEB_ROOT: process.cwd(), PI_WEB_STATE_FILE: statePath, PI_CODING_AGENT_DIR: agentDir }, stdout: "ignore", stderr: "ignore" });
	await waitForState(statePath);
	const terminal = new Bun.Terminal({ cols: 90, rows: 28, data() {} });
	const pi = Bun.spawn({
		cmd: ["pi", "-ne", "-e", join(process.cwd(), "extensions", "session-footer.ts"), "-e", join(process.cwd(), "extensions", "web-sessions.ts"), "--approve", "--no-session"],
		cwd: process.cwd(), env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEB_PORT: String(port), PI_WEB_STATE_FILE: statePath, PI_WEB_MANAGED: "0" }, terminal,
	});
	try {
		const sessionId = await waitForMirroredSession(port);
		const socketUrl = `ws://127.0.0.1:${port}/ws/client`;
		const entries = await waitForSemanticHistory(socketUrl, sessionId);
		expect(Array.isArray(entries)).toBe(true);
		const commandData = await sessionCommand(socketUrl, sessionId, { type: "get_commands" }) as { commands: Array<{ name: string; source: string }> };
		expect(commandData.commands).toContainEqual(expect.objectContaining({ name: "address-pr", source: "prompt" }));
	} finally {
		terminal.write("\u0004");
		await Promise.race([pi.exited, Bun.sleep(2_000)]);
		if (pi.exitCode === null) pi.kill("SIGTERM");
		terminal.close();
	}
}, 15_000);
