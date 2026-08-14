import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	FOOTER_CONTRIBUTION_EVENT,
	type FooterContribution,
} from "./footer-events.js";
import {
	SUBAGENT_ABORT_EVENT,
	SUBAGENT_STATUS_EVENT,
	type SubagentAbortRequest,
	type SubagentStatusEvent,
} from "./subagent-events.js";
import type {
	AgentCommand,
	AgentEventMessage,
	AgentHelloMessage,
	AgentResponseMessage,
	AgentSessionReplacedMessage,
	AgentSubagentsMessage,
	AgentToServerMessage,
	AgentUpdateMessage,
	RpcSessionCommand,
	ServerStateFile,
	ServerToAgentMessage,
	WebSession,
} from "../web/protocol.js";
import { WEB_STATE_VERSION } from "../web/protocol.js";
import { expandSlashCommand, isSkillSlashCommand } from "../web/slash-commands.js";
import { formatWorktreeCreateCommandArgs } from "../web/worktree-command.js";
import { readWebTailscaleSetting, writeWebTailscaleSetting } from "./web-settings.js";
import {
	consumeWorktreeReplacement,
	replacementFromEntries,
	runWorktreeCommand,
	type WorktreeSessionReplacement,
} from "./worktree.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = join(PACKAGE_ROOT, "web", "server", "index.ts");
const STATE_FILE = process.env.PI_WEB_STATE_FILE
	? resolve(process.env.PI_WEB_STATE_FILE)
	: join(getAgentDir(), "web", "server.json");
const FOOTER_KEY = "web-session";
const MAX_RECONNECT_DELAY_MS = 10_000;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function modelThinkingLevels(model: { reasoning?: boolean; thinkingLevelMap?: Partial<Record<string, string | null>> }): string[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null);
}

export function isScopedModelAllowed(
	scopedModels: readonly { model: { provider: string; id: string } }[],
	provider: string,
	modelId: string,
): boolean {
	return scopedModels.length === 0 || scopedModels.some(({ model }) => model.provider === provider && model.id === modelId);
}

function bridgeCommandList(pi: ExtensionAPI) {
	const commands = pi.getCommands()
		.filter((command) => command.source === "prompt" || command.source === "skill" || command.name === "worktree")
		.map((command) => ({
			name: command.name,
			description: command.description,
			source: command.source,
			location: command.sourceInfo.scope,
		}));
	if (!commands.some((command) => command.name === "reload")) {
		commands.unshift({ name: "reload", description: "Reload extensions, skills, prompts, themes, and context files", source: "extension", location: "temporary" });
	}
	return commands;
}

export function splitWebWorktreeCommandArgs(args: string): { token: string; worktreeArgs: string } {
	const trimmed = args.trim();
	const separator = trimmed.search(/\s/);
	return separator < 0
		? { token: trimmed, worktreeArgs: "" }
		: { token: trimmed.slice(0, separator), worktreeArgs: trimmed.slice(separator + 1) };
}

/** Abort the main session and wait for subagent abort operations registered through waitUntil. */
export async function abortSessionAndSubagents(options: {
	sessionId: string;
	abortMain(): void;
	emit(request: SubagentAbortRequest): void;
}): Promise<void> {
	const operations: Promise<unknown>[] = [];
	const request: SubagentAbortRequest = {
		sessionId: options.sessionId,
		waitUntil(operation) {
			operations.push(operation);
		},
	};
	try {
		options.emit(request);
	} catch {
		// A broken optional listener must never prevent the main Stop request.
	}
	options.abortMain();
	await Promise.allSettled(operations);
}

/** Apply a route change and roll it back if the matching settings write fails. */
export async function applyTailscaleSettingTransaction<TSetting, TStatus>(options: {
	current: TSetting;
	next: TSetting;
	apply: (setting: TSetting) => Promise<TStatus>;
	persist: (setting: TSetting) => Promise<void>;
}): Promise<TStatus> {
	const status = await options.apply(options.next);
	try {
		await options.persist(options.next);
		return status;
	} catch (persistError) {
		try {
			await options.apply(options.current);
		} catch (rollbackError) {
			throw new AggregateError(
				[persistError, rollbackError],
				`Could not persist Tailscale settings and route rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
			);
		}
		throw persistError;
	}
}
const START_TIMEOUT_MS = 8_000;
const FORK_TIMEOUT_MS = 30_000;
const WORKTREE_TIMEOUT_MS = 10 * 60_000;
type ForkResult = { cancelled: boolean; sessionId?: string };
type WorktreeResult = { cancelled: boolean; sessionId?: string; path?: string; branch?: string };
type PendingFork = {
	owner: BridgeState;
	expectingReplacement: boolean;
	timer: ReturnType<typeof setTimeout>;
	resolve: (result: ForkResult) => void;
	reject: (error: Error) => void;
};
const PENDING_FORKS_KEY = Symbol.for("@vessup/pi-kit/web-pending-forks");
type PendingForkGlobal = typeof globalThis & { [PENDING_FORKS_KEY]?: Map<string, PendingFork> };
const pendingForks = ((globalThis as PendingForkGlobal)[PENDING_FORKS_KEY] ??= new Map<string, PendingFork>());
const PENDING_RELOADS_KEY = Symbol.for("@vessup/pi-kit/web-pending-reloads");
type PendingReloadGlobal = typeof globalThis & { [PENDING_RELOADS_KEY]?: Set<string> };
const pendingReloads = ((globalThis as PendingReloadGlobal)[PENDING_RELOADS_KEY] ??= new Set<string>());
const WEB_RELOAD_GENERATION = crypto.randomUUID();

type SocketLike = WebSocket;
type BridgeState = {
	ctx: ExtensionContext;
	session: WebSession;
	replacement?: BridgeState;
	server?: ServerStateFile;
	socket?: SocketLike;
	closed: boolean;
	reconnectTimer?: ReturnType<typeof setTimeout>;
	reconnectAttempt: number;
	pending: AgentToServerMessage[];
	metrics: Pick<WebSession, "usage" | "contextUsage">;
	sourceReplacement?: WorktreeSessionReplacement;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function parseState(value: unknown): ServerStateFile | undefined {
	if (!isRecord(value)) return undefined;
	if (
		value.version !== WEB_STATE_VERSION ||
		typeof value.pid !== "number" ||
		typeof value.port !== "number" ||
		typeof value.startedAt !== "number"
	) return undefined;
	return value as unknown as ServerStateFile;
}

async function readServerState(): Promise<ServerStateFile | undefined> {
	try {
		return parseState(JSON.parse(await readFile(STATE_FILE, "utf8")));
	} catch {
		return undefined;
	}
}

function serverBase(state: ServerStateFile): string {
	return `http://127.0.0.1:${state.port}`;
}

function publishedServerBase(state: ServerStateFile): string {
	return state.tailscale?.published && state.tailscale.url ? state.tailscale.url : serverBase(state);
}

async function updateTailscaleServer(
	state: ServerStateFile,
	setting: { enabled: boolean; httpsPort: number; serviceName?: string },
	currentSetting?: { enabled: boolean; httpsPort: number; serviceName?: string },
): Promise<NonNullable<ServerStateFile["tailscale"]>> {
	const url = new URL("/api/tailscale", serverBase(state));
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", origin: serverBase(state) },
		body: JSON.stringify({ ...setting, ...(currentSetting ? { current: currentSetting } : {}) }),
		signal: AbortSignal.timeout(10_000),
	});
	const payload: unknown = await response.json().catch(() => undefined);
	if (!response.ok) {
		const message = isRecord(payload) && typeof payload.error === "string" ? payload.error : response.statusText;
		throw new Error(message || "Could not update Tailscale Serve");
	}
	if (!isRecord(payload) || !isRecord(payload.tailscale)) throw new Error("Pi web returned an invalid Tailscale response");
	return payload.tailscale as NonNullable<ServerStateFile["tailscale"]>;
}

async function isHealthy(state: ServerStateFile): Promise<boolean> {
	try {
		const url = new URL("/api/health", serverBase(state));
		const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
		if (!response.ok) return false;
		const payload: unknown = await response.json();
		return isRecord(payload) && payload.ok === true && payload.pid === state.pid;
	} catch {
		return false;
	}
}

async function ensureServer(): Promise<ServerStateFile> {
	const current = await readServerState();
	if (current && await isHealthy(current)) return current;

	const child = spawn("bun", ["run", SERVER_ENTRY], {
		cwd: PACKAGE_ROOT,
		detached: true,
		stdio: "ignore",
		env: {
			...process.env,
			PI_WEB_ROOT: PACKAGE_ROOT,
			PI_WEB_STATE_FILE: STATE_FILE,
		},
	});
	child.unref();

	const deadline = Date.now() + START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await delay(100);
		const state = await readServerState();
		if (state && await isHealthy(state)) return state;
	}
	throw new Error("Pi web server did not become ready. Make sure Bun is installed and web assets are built.");
}

function zeroWebUsage(): NonNullable<WebSession["usage"]> {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addWebUsage(target: NonNullable<WebSession["usage"]>, value: unknown): void {
	if (!isRecord(value)) return;
	const number = (key: string) => typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] as number : 0;
	target.input += number("input");
	target.output += number("output");
	target.cacheRead += number("cacheRead");
	target.cacheWrite += number("cacheWrite");
	target.totalTokens += number("totalTokens");
	if (!isRecord(value.cost)) return;
	const cost = value.cost;
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
		if (typeof cost[key] === "number" && Number.isFinite(cost[key])) target.cost[key] += cost[key];
	}
}

function sessionMetrics(ctx: ExtensionContext): Pick<WebSession, "usage" | "contextUsage"> {
	const usage = zeroWebUsage();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
			addWebUsage(usage, entry.message.usage);
		} else if (entry.type === "branch_summary" || entry.type === "compaction") {
			addWebUsage(usage, entry.usage);
		}
	}
	const contextUsage = ctx.getContextUsage();
	return {
		usage,
		contextUsage: contextUsage ? { ...contextUsage } : ctx.model ? { tokens: null, contextWindow: ctx.model.contextWindow, percent: null } : undefined,
	};
}

function safeClone(value: unknown): Record<string, unknown> {
	try {
		const cloned: unknown = JSON.parse(JSON.stringify(value));
		return isRecord(cloned) ? cloned : { value: cloned };
	} catch (error) {
		return { type: "serialization_error", error: error instanceof Error ? error.message : String(error) };
	}
}

function sessionUrl(state: ServerStateFile, sessionId: string): string {
	const url = new URL("/", publishedServerBase(state));
	url.hash = `/sessions/${encodeURIComponent(sessionId)}`;
	return url.toString();
}

function hyperlink(url: string, label: string): string {
	return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

function renderGlobe(theme: Theme, url: string): string {
	return hyperlink(url, theme.fg("accent", "🌐"));
}

function publishFooter(pi: ExtensionAPI, state: BridgeState): void {
	const server = state.server;
	const contribution: FooterContribution = {
		sessionId: state.session.id,
		key: FOOTER_KEY,
		identityPrefix: server ? (theme) => renderGlobe(theme, sessionUrl(server, state.session.id)) : undefined,
		onBranchChange: () => { void refreshGitMetadata(pi, state); },
	};
	pi.events.emit(FOOTER_CONTRIBUTION_EVENT, contribution);
}

function removeFooter(pi: ExtensionAPI, sessionId: string): void {
	pi.events.emit(FOOTER_CONTRIBUTION_EVENT, {
		sessionId,
		key: FOOTER_KEY,
		remove: true,
	} satisfies FooterContribution);
}

function send(state: BridgeState, message: AgentToServerMessage): void {
	if (state.socket?.readyState === WebSocket.OPEN) {
		state.socket.send(JSON.stringify(message));
		return;
	}
	state.pending.push(message);
	if (state.pending.length > 500) state.pending.splice(0, state.pending.length - 500);
}

function sendSourceReplacement(state: BridgeState, replacement: WorktreeSessionReplacement): void {
	state.sourceReplacement = replacement;
	send(state, { type: "agent.session_replaced", ...replacement } satisfies AgentSessionReplacedMessage);
}

function flush(state: BridgeState): void {
	if (state.socket?.readyState !== WebSocket.OPEN) return;
	for (const message of state.pending.splice(0)) state.socket.send(JSON.stringify(message));
}

function statusForContext(ctx: ExtensionContext): WebSession["status"] {
	return ctx.isIdle() ? "idle" : "working";
}

async function findPullRequest(pi: ExtensionAPI, cwd: string): Promise<WebSession["pullRequest"]> {
	try {
		const result = await pi.exec("gh", ["pr", "view", "--json", "number,url"], { cwd, timeout: 10_000 });
		if (result.code !== 0) return undefined;
		const value: unknown = JSON.parse(result.stdout);
		if (!isRecord(value) || !Number.isInteger(value.number) || typeof value.url !== "string") return undefined;
		const url = new URL(value.url);
		if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
		return { number: value.number as number, url: url.toString() };
	} catch {
		return undefined;
	}
}

async function refreshGitMetadata(pi: ExtensionAPI, state: BridgeState): Promise<void> {
	let branch: string | undefined;
	try {
		const result = await pi.exec("git", ["branch", "--show-current"], { cwd: state.ctx.cwd });
		if (result.code === 0) branch = result.stdout.trim() || undefined;
	} catch {
		// Non-git working directories are valid sessions.
	}
	const pullRequest = branch ? await findPullRequest(pi, state.ctx.cwd) : undefined;
	if (!state.closed) updateSession(state, { branch, pullRequest });
}

function updateSession(state: BridgeState, patch: Partial<WebSession> = {}, refreshMetrics = false): void {
	if (refreshMetrics) state.metrics = sessionMetrics(state.ctx);
	state.session = {
		...state.session,
		...state.metrics,
		...patch,
		status: patch.status ?? statusForContext(state.ctx),
		updatedAt: Date.now(),
	};
	// Subagent transcripts use their own incremental channel. Omitting them here
	// prevents unrelated session updates from retransmitting the retained corpus.
	const { subagents: _subagents, subagentUsage: _subagentUsage, ...session } = state.session;
	send(state, { type: "agent.update", session } satisfies AgentUpdateMessage);
}

function respond(state: BridgeState, requestId: string, success: boolean, data?: unknown, error?: string): void {
	while (state.closed && state.replacement) state = state.replacement;
	send(state, {
		type: "agent.response",
		requestId,
		success,
		data,
		error,
	} satisfies AgentResponseMessage);
}

function startBridgeCompaction(state: BridgeState, reason: "manual" | "threshold" | "overflow", willRetry: boolean): void {
	const compaction = { reason, startedAt: Date.now() };
	updateSession(state, { status: "working", compaction });
	send(state, {
		type: "agent.event",
		sessionId: state.session.id,
		event: { type: "compaction_start", ...compaction, willRetry },
	} satisfies AgentEventMessage);
}

function endBridgeCompaction(
	state: BridgeState,
	options: { aborted: boolean; willRetry: boolean; errorMessage?: string; tokensBefore?: number },
): void {
	const compaction = state.session.compaction;
	if (!compaction) return;
	send(state, {
		type: "agent.event",
		sessionId: state.session.id,
		event: { type: "compaction_end", reason: compaction.reason, ...options },
	} satisfies AgentEventMessage);
	updateSession(state, { compaction: undefined });
}

function replacePendingForkOwners(owner: BridgeState, replacement: BridgeState): void {
	for (const pending of pendingForks.values()) {
		if (pending.owner === owner && pending.expectingReplacement) pending.owner = replacement;
	}
}

function rejectPendingForks(owner: BridgeState, reason: string, preserveExpectedReplacement = false): void {
	for (const [token, pending] of pendingForks) {
		if (pending.owner !== owner || (preserveExpectedReplacement && pending.expectingReplacement)) continue;
		pendingForks.delete(token);
		clearTimeout(pending.timer);
		pending.reject(new Error(reason));
	}
}

async function requestFork(pi: ExtensionAPI, state: BridgeState, message: string): Promise<ForkResult> {
	const token = crypto.randomUUID();
	return await new Promise<ForkResult>((resolveFork, rejectFork) => {
		const finish = (error?: Error, result?: ForkResult) => {
			const pending = pendingForks.get(token);
			if (!pending) return;
			pendingForks.delete(token);
			clearTimeout(pending.timer);
			if (error) rejectFork(error);
			else resolveFork(result ?? { cancelled: true });
		};
		const timer = setTimeout(() => finish(new Error("Pi session fork timed out")), FORK_TIMEOUT_MS);
		timer.unref?.();
		pendingForks.set(token, {
			owner: state,
			expectingReplacement: false,
			timer,
			resolve: (result) => finish(undefined, result),
			reject: (error) => finish(error),
		});
		try {
			pi.sendUserMessage(`${message} ${token}`);
		} catch (error) {
			finish(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

async function executeAgentCommand(
	pi: ExtensionAPI,
	state: BridgeState,
	requestId: string,
	command: AgentCommand | RpcSessionCommand,
): Promise<void> {
	try {
		switch (command.type) {
				case "prompt": {
				const message = await expandSlashCommand(pi.getCommands(), command.message, { rejectExtensionCommands: true });
				pi.sendUserMessage(
					command.images?.length
						? [
							...(message ? [{ type: "text" as const, text: message }] : []),
							...command.images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
						]
						: message,
					state.ctx.isIdle() ? undefined : { deliverAs: command.streamingBehavior ?? "steer" },
				);
				respond(state, requestId, true);
				return;
			}
			case "abort":
				await abortSessionAndSubagents({
					sessionId: state.session.id,
					abortMain: () => state.ctx.abort(),
					emit: (request) => pi.events.emit(SUBAGENT_ABORT_EVENT, request),
				});
				respond(state, requestId, true);
				return;
			case "replace_queue":
				respond(state, requestId, true);
				return;
			case "get_session_options": {
				const models = (state.ctx.scopedModels.length > 0
					? state.ctx.scopedModels.map((item) => item.model)
					: state.ctx.modelRegistry.getAvailable()
				).map((model) => ({
					provider: model.provider,
					id: model.id,
					name: model.name,
					reasoning: model.reasoning,
					thinkingLevels: modelThinkingLevels(model),
				}));
				const commands = bridgeCommandList(pi);
				respond(state, requestId, true, { models, thinkingLevels: modelThinkingLevels(state.ctx.model ?? {}), commands });
				return;
			}
			case "get_commands": {
				const commands = bridgeCommandList(pi);
				respond(state, requestId, true, { commands });
				return;
			}
			case "set_model": {
				if (!isScopedModelAllowed(state.ctx.scopedModels, command.provider, command.modelId)) {
					throw new Error(`Model is outside this session's configured scope: ${command.provider}/${command.modelId}`);
				}
				const model = state.ctx.modelRegistry.find(command.provider, command.modelId);
				if (!model) throw new Error(`Model not found: ${command.provider}/${command.modelId}`);
				if (!await pi.setModel(model)) throw new Error(`No credentials available for ${command.provider}/${command.modelId}`);
				updateSession(state, { model: `${model.provider}/${model.id}` });
				respond(state, requestId, true);
				return;
			}
			case "set_thinking_level":
				pi.setThinkingLevel(command.level as Parameters<typeof pi.setThinkingLevel>[0]);
				updateSession(state, { thinkingLevel: pi.getThinkingLevel() });
				respond(state, requestId, true);
				return;
			case "shutdown":
				respond(state, requestId, true);
				state.ctx.shutdown();
				return;
			case "reload":
				if (!state.ctx.isIdle()) throw new Error("Wait for Pi to become idle before reloading");
				pi.sendUserMessage(`/web-reload ${requestId}`);
				return;
			case "create_worktree":
			case "create_worktree_v2": {
				if (!state.ctx.isIdle()) throw new Error("Wait for Pi to become idle before creating a worktree");
				const token = crypto.randomUUID();
				const result = await new Promise<WorktreeResult>((resolveWorktree, rejectWorktree) => {
					const finish = (error?: Error, value?: WorktreeResult) => {
						const pending = pendingForks.get(token);
						if (!pending) return;
						pendingForks.delete(token);
						clearTimeout(pending.timer);
						if (error) rejectWorktree(error);
						else resolveWorktree(value ?? { cancelled: true });
					};
					const timer = setTimeout(() => finish(new Error("Pi worktree switch timed out")), WORKTREE_TIMEOUT_MS);
					timer.unref?.();
					pendingForks.set(token, {
						owner: state,
						expectingReplacement: false,
						timer,
						resolve: (value) => finish(undefined, value),
						reject: (error) => finish(error),
					});
					try {
						const worktreeCommand = "existing" in command
							? `--existing ${JSON.stringify(command.existing)}`
							: formatWorktreeCreateCommandArgs(command);
						pi.sendUserMessage(`/web-worktree ${token} ${worktreeCommand}`);
					} catch (error) {
						finish(error instanceof Error ? error : new Error(String(error)));
					}
				});
				respond(state, requestId, true, result);
				return;
			}
			case "set_session_name":
				pi.setSessionName(command.name);
				updateSession(state, { name: command.name || undefined });
				respond(state, requestId, true);
				return;
			case "compact":
				state.ctx.compact({
					customInstructions: command.customInstructions,
					onComplete: (result) => respond(state, requestId, true, result),
					onError: (error) => {
						endBridgeCompaction(state, { aborted: false, willRetry: false, errorMessage: error.message });
						respond(state, requestId, false, undefined, error.message);
					},
				});
				return;
			case "bash": {
				const shell = process.env.SHELL || "/bin/sh";
				const result = await pi.exec(shell, ["-lc", command.command], { cwd: state.ctx.cwd });
				const output = `${result.stdout}${result.stderr}`;
				pi.sendMessage({
					customType: "web-bash",
					content: `Ran \`${command.command}\`\n\n\`\`\`\n${output}\n\`\`\``,
					display: true,
				}, { triggerTurn: false });
				send(state, {
					type: "agent.event",
					sessionId: state.session.id,
					event: { type: "bash_execution_update", id: requestId, delta: output },
				} satisfies AgentEventMessage);
				respond(state, requestId, true, {
					output,
					exitCode: result.code,
					cancelled: false,
					truncated: false,
				});
				return;
			}
			case "get_fork_messages": {
				const messages = state.ctx.sessionManager.getEntries().flatMap((entry) => {
					if (entry.type !== "message" || entry.message.role !== "user") return [];
					const content = entry.message.content;
					const text = typeof content === "string"
						? content
						: content.filter((part) => part.type === "text").map((part) => part.text).join("");
					return text ? [{ entryId: entry.id, id: entry.id, text }] : [];
				});
				respond(state, requestId, true, { messages });
				return;
			}
			case "clone": {
				if (!state.ctx.isIdle()) throw new Error("Wait for Pi to become idle before cloning");
				respond(state, requestId, true, await requestFork(pi, state, "/web-clone"));
				return;
			}
			case "fork": {
				if (!state.ctx.isIdle()) throw new Error("Wait for Pi to become idle before forking");
				respond(state, requestId, true, await requestFork(pi, state, `/web-fork ${command.entryId}`));
				return;
			}
		}
		throw new Error("Unknown Pi web command");
	} catch (error) {
		respond(state, requestId, false, undefined, error instanceof Error ? error.message : String(error));
	}
}

function drainPendingReloads(state: BridgeState): void {
	for (const requestId of pendingReloads) {
		pendingReloads.delete(requestId);
		respond(state, requestId, true, { reloaded: true });
	}
}

function scheduleReconnect(pi: ExtensionAPI, state: BridgeState): void {
	if (state.closed || state.reconnectTimer) return;
	const delayMs = Math.min(500 * 2 ** state.reconnectAttempt, MAX_RECONNECT_DELAY_MS);
	state.reconnectAttempt += 1;
	state.reconnectTimer = setTimeout(() => {
		state.reconnectTimer = undefined;
		void connect(pi, state).catch(() => scheduleReconnect(pi, state));
	}, delayMs);
}

async function connect(pi: ExtensionAPI, state: BridgeState): Promise<void> {
	if (state.closed) return;
	const server = await ensureServer();
	if (state.closed) return;
	state.server = server;
	publishFooter(pi, state);

	const url = new URL("/ws/agent", serverBase(server));
	url.protocol = "ws:";
	const socket = new WebSocket(url);
	state.socket = socket;

	socket.onmessage = (event) => {
		try {
			const message: unknown = JSON.parse(String(event.data));
			if (!isRecord(message) || message.type !== "agent.command" || typeof message.requestId !== "string" || !isRecord(message.command)) return;
			void executeAgentCommand(
				pi,
				state,
				message.requestId,
				message.command as unknown as AgentCommand | RpcSessionCommand,
			);
		} catch {
			// Ignore malformed server frames. The server remains localhost-only
			// except for its explicitly configured tailnet Service.
		}
	};

	await new Promise<void>((resolveOpen, rejectOpen) => {
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (error) {
				if (state.socket === socket) state.socket = undefined;
				socket.close();
				rejectOpen(error);
			} else {
				resolveOpen();
			}
		};
		const timeout = setTimeout(() => finish(new Error("Timed out connecting to Pi web server")), 3_000);
		socket.onopen = () => {
			if (state.closed || state.socket !== socket) {
				finish(new Error("Pi web connection was superseded"));
				return;
			}
			state.reconnectAttempt = 0;
			const hello: AgentHelloMessage = {
				type: "agent.hello",
				session: state.session,
				// The server can read JSONL history from session.file. Sending every
				// entry here makes large sessions exceed WebSocket frame limits and
				// prevents the native bridge from registering after a daemon restart.
				entries: [],
			};
			socket.send(JSON.stringify(hello));
			if (state.sourceReplacement) {
				socket.send(JSON.stringify({ type: "agent.session_replaced", ...state.sourceReplacement } satisfies AgentSessionReplacedMessage));
			}
			flush(state);
			finish();
		};
		socket.onerror = () => finish(new Error("Could not connect to Pi web server"));
	});

	drainPendingReloads(state);
	socket.onclose = () => {
		if (state.socket === socket) state.socket = undefined;
		scheduleReconnect(pi, state);
	};
}

function makeSession(ctx: ExtensionContext, branch: string | undefined): WebSession {
	const entries = ctx.sessionManager.getEntries();
	const header = ctx.sessionManager.getHeader();
	const firstUser = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
	let preview: string | undefined;
	if (firstUser?.type === "message" && firstUser.message.role === "user") {
		preview = typeof firstUser.message.content === "string"
			? firstUser.message.content.slice(0, 180)
			: firstUser.message.content.filter((item) => item.type === "text").map((item) => item.text).join("").slice(0, 180);
	}
	return {
		id: ctx.sessionManager.getSessionId(),
		file: ctx.sessionManager.getSessionFile(),
		cwd: ctx.cwd,
		name: ctx.sessionManager.getSessionName(),
		branch,
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		thinkingLevel: ctx.thinkingLevel,
		status: statusForContext(ctx),
		source: "tui",
		createdAt: header ? Date.parse(header.timestamp) || Date.now() : Date.now(),
		updatedAt: Date.now(),
		messageCount: entries.filter((entry) => entry.type === "message").length,
		preview,
		parentSession: header?.parentSession,
		...sessionMetrics(ctx),
	};
}

export default function webSessions(pi: ExtensionAPI): void {
	let bridge: BridgeState | undefined;

	// RPC mode normally expands /skill:name before the agent sees it. Pi Web keeps
	// skill invocations as user-authored text so the agent follows the advertised
	// progressive-disclosure contract and loads SKILL.md with read when needed.
	pi.on("input", (event) => {
		if (process.env.PI_WEB_MANAGED !== "1" || event.source !== "rpc" || !isSkillSlashCommand(pi.getCommands(), event.text)) {
			return { action: "continue" };
		}
		pi.sendUserMessage(
			event.images?.length
				? [{ type: "text" as const, text: event.text }, ...event.images]
				: event.text,
			event.streamingBehavior ? { deliverAs: event.streamingBehavior } : undefined,
		);
		return { action: "handled" };
	});

	pi.events.on(SUBAGENT_STATUS_EVENT, (value) => {
		const event = value as SubagentStatusEvent;
		if (!bridge || event.sessionId !== bridge.session.id) return;
		send(bridge, {
			type: "agent.subagents",
			sessionId: event.sessionId,
			agents: event.remove ? [] : event.agents,
			usage: event.usage,
		} satisfies AgentSubagentsMessage);
	});

	const forward = (event: unknown, ctx: ExtensionContext, status?: WebSession["status"], refreshMetrics = false): void => {
		if (!bridge || bridge.closed || ctx.sessionManager.getSessionId() !== bridge.session.id) return;
		send(bridge, {
			type: "agent.event",
			sessionId: bridge.session.id,
			event: safeClone(event),
		} satisfies AgentEventMessage);
		updateSession(bridge, {
			status,
			messageCount: refreshMetrics
				? ctx.sessionManager.getEntries().filter((entry) => entry.type === "message").length
				: bridge.session.messageCount,
		}, refreshMetrics);
	};

	pi.registerCommand("web", {
		description: "Show the current session in the Pi web app",
		handler: async (_args, ctx) => {
			try {
				const server = bridge?.server ?? await ensureServer();
				ctx.ui.notify(sessionUrl(server, ctx.sessionManager.getSessionId()), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("web-reload", {
		description: `Internal web reload ${WEB_RELOAD_GENERATION}`,
		handler: async (args, ctx) => {
			const token = args.trim();
			if (token) pendingReloads.add(token);
			try {
				await ctx.waitForIdle();
				await ctx.reload();
				return;
			} catch (error) {
				if (token) pendingReloads.delete(token);
				const state = bridge;
				if (token && state) respond(state, token, false, undefined, error instanceof Error ? error.message : String(error));
				else throw error;
			}
		},
	});

	pi.registerCommand("web-tailscale", {
		description: "Enable, disable, or inspect tailnet publishing for Pi web",
		handler: async (args, ctx) => {
			const [rawAction = "", rawServiceName] = args.trim().split(/\s+/, 2);
			const action = rawAction.toLowerCase();
			if (!action || action === "status") {
				const setting = await readWebTailscaleSetting();
				const current = await readServerState();
				if (current?.tailscale?.published && current.tailscale.url) {
					ctx.ui.notify(`Pi web is published at ${current.tailscale.url}`, "info");
				} else if (current?.tailscale?.error) {
					ctx.ui.notify(current.tailscale.error, "warning");
				} else {
					ctx.ui.notify(`Tailnet publishing is ${setting.enabled ? "enabled; restart the Pi web server to retry" : "disabled"}.`, "info");
				}
				return;
			}
			if (action !== "on" && action !== "off") {
				ctx.ui.notify("Usage: /web-tailscale [on [service-name]|off|status]", "warning");
				return;
			}
			const setting = await readWebTailscaleSetting();
			const serviceName = rawServiceName?.trim().replace(/^svc:/, "") || setting.serviceName;
			const nextSetting = {
				...setting,
				enabled: action === "on",
				...(serviceName ? { serviceName } : {}),
			};
			const server = bridge?.server ?? await ensureServer();
			let appliedSetting = setting;
			const status = await applyTailscaleSettingTransaction({
				current: setting,
				next: nextSetting,
				apply: async (target) => {
					const applied = await updateTailscaleServer(server, target, appliedSetting);
					if ((target.enabled && !applied.published) || applied.error) {
						throw new Error(applied.error ?? "Tailscale Serve did not publish Pi web");
					}
					appliedSetting = target;
					return applied;
				},
				persist: writeWebTailscaleSetting,
			});
			server.tailscale = status;
			if (bridge) {
				bridge.server = server;
				publishFooter(pi, bridge);
			}
			if (status.published && status.url) {
				ctx.ui.notify(`Pi web is now published at ${status.url}`, "info");
			} else if (status.error) {
				ctx.ui.notify(status.error, "warning");
			} else {
				ctx.ui.notify("Tailnet publishing disabled.", "info");
			}
		},
	});

	pi.registerCommand("web-clone", {
		description: "Clone the current branch for the web session manager",
		handler: async (args, ctx) => {
			const token = args.trim();
			const pending = pendingForks.get(token);
			try {
				await ctx.waitForIdle();
				const leaf = ctx.sessionManager.getLeafId();
				if (!leaf) throw new Error("Current session has no entries to clone");
				let sessionId: string | undefined;
				if (pending) pending.expectingReplacement = true;
				const result = await ctx.fork(leaf, {
					position: "at",
					withSession: async (replacement) => { sessionId = replacement.sessionManager.getSessionId(); },
				});
				pending?.resolve({ cancelled: result.cancelled, sessionId });
			} catch (error) {
				pending?.reject(error instanceof Error ? error : new Error(String(error)));
				if (!pending) throw error;
			} finally {
				if (pending) pendingForks.delete(token);
			}
		},
	});

	pi.registerCommand("web-worktree", {
		description: "Create and activate a worktree for the web session manager",
		handler: async (args, ctx) => {
			const { token, worktreeArgs } = splitWebWorktreeCommandArgs(args);
			const pending = pendingForks.get(token);
			try {
				if (pending) pending.expectingReplacement = true;
				const result = await runWorktreeCommand(worktreeArgs, ctx);
				if (result.replacedSession && bridge) sendSourceReplacement(bridge, result.replacedSession);
				pending?.resolve({
					...result,
					sessionId: result.cancelled ? undefined : pending.owner.session.id,
					path: result.path ?? pending.owner.session.cwd,
					branch: result.branch ?? pending.owner.session.branch,
				} as WorktreeResult);
			} catch (error) {
				pending?.reject(error instanceof Error ? error : new Error(String(error)));
				if (!pending) throw error;
			}
		},
	});

	pi.registerCommand("web-fork", {
		description: "Fork from an entry for the web session manager",
		handler: async (args, ctx) => {
			const [entryId = "", token = ""] = args.trim().split(/\s+/, 2);
			const pending = pendingForks.get(token);
			try {
				if (!entryId || !ctx.sessionManager.getEntry(entryId)) throw new Error("Unknown session entry");
				await ctx.waitForIdle();
				let sessionId: string | undefined;
				if (pending) pending.expectingReplacement = true;
				const result = await ctx.fork(entryId, {
					withSession: async (replacement) => { sessionId = replacement.sessionManager.getSessionId(); },
				});
				pending?.resolve({ cancelled: result.cancelled, sessionId });
			} catch (error) {
				pending?.reject(error instanceof Error ? error : new Error(String(error)));
				if (!pending) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			} finally {
				if (pending) pendingForks.delete(token);
			}
		},
	});

	pi.on("session_start", async (event, ctx) => {
		if (process.env.PI_WEB_MANAGED === "1") return;
		const previous = bridge;
		const session = makeSession(ctx, undefined);
		const worktreeReplacement = consumeWorktreeReplacement(session.id);
		// The in-memory replacement token exists before activation verification.
		// Advertise deletion only from the durable marker written after verification.
		const persistedReplacement = replacementFromEntries(ctx.sessionManager.getEntries());
		const sourceReplacement = persistedReplacement?.replacementSessionId === session.id
			? persistedReplacement
			: undefined;
		const state: BridgeState = {
			ctx,
			session,
			closed: false,
			reconnectAttempt: 0,
			pending: [],
			metrics: { usage: session.usage, contextUsage: session.contextUsage },
			sourceReplacement,
		};
		if (previous) {
			previous.closed = true;
			previous.replacement = state;
			replacePendingForkOwners(previous, state);
			rejectPendingForks(previous, "Pi session changed before the fork completed", true);
			previous.socket?.close();
			if (previous.reconnectTimer) clearTimeout(previous.reconnectTimer);
			removeFooter(pi, previous.session.id);
		}
		bridge = state;
		if (worktreeReplacement && !sourceReplacement) {
			const deadline = Date.now() + WORKTREE_TIMEOUT_MS;
			const poll = setInterval(() => {
				if (state.closed || Date.now() >= deadline) {
					clearInterval(poll);
					return;
				}
				if (!worktreeReplacement.activated) return;
				clearInterval(poll);
				sendSourceReplacement(state, worktreeReplacement.activated);
			}, 10);
			poll.unref?.();
		}
		for (const pending of pendingForks.values()) {
			if (!pending.expectingReplacement) continue;
			if (
				pending.owner === previous ||
				pending.owner.session.file === event.previousSessionFile ||
				pending.owner.session.id === worktreeReplacement?.previousSessionId
			) pending.owner = state;
		}
		void refreshGitMetadata(pi, state);
		try {
			await connect(pi, state);
		} catch (error) {
			ctx.ui.notify(`Pi web unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
			scheduleReconnect(pi, state);
		}
	});

	pi.on("session_info_changed", (event, ctx) => {
		if (bridge) updateSession(bridge, { name: event.name });
		forward(event, ctx);
	});
	pi.on("model_select", (event, ctx) => {
		if (bridge) updateSession(bridge, { model: `${event.model.provider}/${event.model.id}` });
		forward(event, ctx);
	});
	pi.on("thinking_level_select", (event, ctx) => {
		if (bridge) updateSession(bridge, { thinkingLevel: event.level });
		forward(event, ctx);
	});
	pi.on("agent_start", (event, ctx) => forward(event, ctx, "working"));
	// The visible run is complete at agent_end. agent_settled remains the
	// authoritative point for queue delivery and teardown, but the session must
	// not keep presenting itself as working while those final hooks drain.
	pi.on("agent_end", (event, ctx) => forward(event, ctx, "idle"));
	pi.on("agent_settled", (event, ctx) => {
		if (bridge?.session.compaction) {
			endBridgeCompaction(bridge, { aborted: false, willRetry: false, errorMessage: "Compaction stopped before completion" });
		}
		forward(event, ctx, "idle");
	});
	pi.on("turn_start", (event, ctx) => forward(event, ctx, "working"));
	pi.on("turn_end", (event, ctx) => forward(event, ctx));
	pi.on("message_start", (event, ctx) => forward(event, ctx));
	pi.on("message_update", (event, ctx) => forward(event, ctx));
	pi.on("message_end", (event, ctx) => forward(event, ctx, undefined, true));
	pi.on("tool_execution_start", (event, ctx) => forward(event, ctx));
	pi.on("tool_execution_update", (event, ctx) => forward(event, ctx));
	pi.on("tool_execution_end", (event, ctx) => forward(event, ctx));
	pi.on("session_before_compact", (event, ctx) => {
		if (!bridge || bridge.closed || ctx.sessionManager.getSessionId() !== bridge.session.id) return;
		startBridgeCompaction(bridge, event.reason, event.willRetry);
		const startedAt = bridge.session.compaction?.startedAt;
		event.signal.addEventListener("abort", () => {
			if (!bridge || bridge.session.compaction?.startedAt !== startedAt) return;
			endBridgeCompaction(bridge, { aborted: true, willRetry: event.willRetry });
		}, { once: true });
	});
	pi.on("session_compact", (event, ctx) => {
		if (bridge) updateSession(bridge, {}, true);
		if (bridge && ctx.sessionManager.getSessionId() === bridge.session.id) {
			endBridgeCompaction(bridge, {
				aborted: false,
				willRetry: event.willRetry,
				tokensBefore: event.compactionEntry.tokensBefore,
			});
		}
		forward(event, ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const state = bridge;
		if (!state || state.session.id !== ctx.sessionManager.getSessionId()) return;
		state.closed = true;
		// Expected replacement requests survive extension-runtime reload and are
		// rebound by the next session_start through the module-global pending map.
		rejectPendingForks(state, "Pi session closed before the fork completed", true);
		if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
		state.socket?.close();
		removeFooter(pi, state.session.id);
		bridge = undefined;
	});
}
