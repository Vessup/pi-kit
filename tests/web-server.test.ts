import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareWebSessions, moveWebQueuedMessage, moveWebSession, moveWebSessionRelative, orderWebSessions, type ServerStateFile, type WebQueuedMessage, type WebSession } from "../web/protocol.ts";
import { clearSessionProjectCache, resolveSessionProject } from "../web/server/projects.ts";

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
		socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
		socket.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; requestId?: string; success?: boolean; error?: string; data?: unknown };
			if (message.type === "server.snapshot") socket.send(JSON.stringify({ type: "client.command", requestId, sessionId, command }));
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
	const agent = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
	await new Promise<void>((resolve, reject) => {
		agent.onopen = () => {
			agent.send(JSON.stringify({
				type: "agent.hello",
				session: { id: sessionId, cwd: tempDir, status: "idle", source: "tui", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 1 },
				entries: [{ id: "entry-1", type: "message", message: { role: "user", content: "semantic history" } }],
			}));
			resolve();
		};
		agent.onerror = () => reject(new Error("native agent websocket failed"));
	});
	await Bun.sleep(25);
	const history = await semanticHistory(`ws://127.0.0.1:${port}/ws/client`, sessionId);
	expect(history).toHaveLength(1);
	agent.close();
}, 15_000);

function replaceQueueAndReadBack(url: string, sessionId: string): Promise<Array<{ id: string; message: string }>> {
	return new Promise((resolve, reject) => {
		const socket = browserSocket(url);
		const requestId = crypto.randomUUID();
		const expected = [{ id: "queued-1", message: "editable follow-up" }];
		let subscribed = false;
		const timeout = setTimeout(() => { socket.close(); reject(new Error("web queue round-trip timed out")); }, 10_000);
		socket.onopen = () => socket.send(JSON.stringify({ type: "client.hello" }));
		socket.onmessage = ({ data }) => {
			const message = JSON.parse(String(data)) as { type?: string; requestId?: string; success?: boolean; event?: { type?: string; queue?: Array<{ id: string; message: string }> } };
			if (message.type === "server.snapshot" && !subscribed) {
				subscribed = true;
				socket.send(JSON.stringify({ type: "client.subscribe", sessionId }));
				socket.send(JSON.stringify({ type: "client.command", requestId, sessionId, command: { type: "replace_queue", queue: expected } }));
			}
			if (message.type === "server.event" && message.event?.type === "web_queue_update" && message.event.queue?.[0]?.id === "queued-1") {
				clearTimeout(timeout); socket.close(); resolve(message.event.queue);
			}
			if (message.type === "server.response" && message.requestId === requestId && message.success === false) {
				clearTimeout(timeout); socket.close(); reject(new Error("replace_queue failed"));
			}
		};
		socket.onerror = () => { clearTimeout(timeout); reject(new Error("web queue websocket failed")); };
	});
}

async function queuedFollowUpDeliveryOrder(url: string, sessionId: string, agent: WebSocket): Promise<string[]> {
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
				agent.send(JSON.stringify({ type: "agent.event", sessionId, event: { type: "agent_settled" } }));
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
	const delivered = new Promise<{ type?: string; message?: string }>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("restored queue was not flushed after hello")), 5_000);
		agent.onmessage = ({ data }) => {
			const frame = JSON.parse(String(data)) as { type?: string; requestId?: string; command?: { type?: string; message?: string } };
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
	expect(await delivered).toEqual({ type: "prompt", message: "deliver after reconnect" });
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
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  let data;
  if (request.type === "get_state") data = { sessionId, sessionFile, messageCount: entries.length, isStreaming: false };
  else if (request.type === "get_entries") data = { entries, leafId: "managed-entry" };
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
	const base = await baseResponse.json() as { session: WebSession };
	const failed = await fetch(`${origin}/api/sessions`, {
		method: "POST", headers: { "content-type": "application/json", Origin: origin },
		body: JSON.stringify({ worktreeName: "startup-fails", worktreeBaseSessionId: base.session.id }),
	});
	expect(failed.status).toBe(500);
	const worktree = join(repository, ".pi", "worktrees", "startup-fails");
	expect(await failed.text()).toContain("initialized worktree retained at ");
	expect(await readFile(join(worktree, "setup-generated.txt"), "utf8")).toBe("generated by setup");
	expect((await Bun.$`git -C ${repository} branch --list startup-fails`.text()).trim()).toContain("startup-fails");
}, 15_000);

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
	expect(await queuedFollowUpDeliveryOrder(socketUrl, sessionId, agent)).toEqual([
		"transcript",
		"prompt-after-transcript",
		"queue-cleared",
	]);
	expect(await compactionLifecycle(socketUrl, sessionId, agent)).toEqual([
		{ reason: "overflow", status: "working" },
		{ status: "working" },
	]);
	agent.close();
}, 15_000);

test("browser sessions start as semantic Pi RPC sessions", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pi-kit-semantic-test-"));
	const statePath = join(tempDir, "server.json");
	const cwd = join(tempDir, "project");
	await Bun.write(join(cwd, ".keep"), "");
	const port = 40_000 + Math.floor(Math.random() * 5_000);
	child = Bun.spawn({
		cmd: ["bun", "run", "web/server/index.ts"], cwd: process.cwd(),
		env: { ...process.env, PI_WEB_PORT: String(port), PI_WEB_ROOT: process.cwd(), PI_WEB_STATE_FILE: statePath, PI_CODING_AGENT_DIR: join(tempDir, "pi-agent") },
		stdout: "ignore", stderr: "ignore",
	});
	await waitForState(statePath);
	const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
		method: "POST", headers: { "content-type": "application/json", Origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ cwd, name: "semantic-test" }),
	});
	expect(response.status).toBe(201);
	const payload = await response.json() as { session: { id: string; source: string } };
	expect(payload.session.source).toBe("web");
	const socketUrl = `ws://127.0.0.1:${port}/ws/client`;
	const semanticHistory = await waitForSemanticHistory(socketUrl, payload.session.id);
	expect(Array.isArray(semanticHistory)).toBe(true);
	expect(await replaceQueueAndReadBack(socketUrl, payload.session.id)).toEqual([{ id: "queued-1", message: "editable follow-up" }]);
	const deleted = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(payload.session.id)}`, {
		method: "DELETE",
		headers: { Origin: `http://127.0.0.1:${port}` },
	});
	expect(deleted.status).toBe(200);
}, 15_000);

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
