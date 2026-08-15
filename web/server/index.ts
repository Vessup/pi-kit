import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { buildContextEntries, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
	AgentEventMessage,
	AgentHelloMessage,
	AgentHistoryMessage,
	AgentResponseMessage,
	AgentSessionReplacedMessage,
	AgentSubagentsMessage,
	AgentToServerMessage,
	AgentUpdateMessage,
	ClientCommandMessage,
	ClientToServerMessage,
	CreateSessionRequest,
	ResumeSessionRequest,
	RpcSessionCommand,
	ServerEventMessage,
	ServerHistoryMessage,
	ServerResponseMessage,
	ServerSessionMessage,
	ServerSessionRemovedMessage,
	ServerSnapshotMessage,
	ServerStateFile,
	ServerToClientMessage,
	WebSession,
} from "../protocol.js";
import { compareWebSessions, DEFAULT_WEB_PORT, hasActiveWebSubagents, mergeWebSubagentUpdates, WEB_STATE_VERSION } from "../protocol.js";
import { expandSlashCommand } from "../slash-commands.js";
import { parseWebCompactCommand } from "../compact-command.js";
import { isWebReloadCommand } from "../reload-command.js";
import { formatWorktreeCreateCommandArgs, parseWorktreeInvocation, WORKTREE_USAGE } from "../worktree-command.js";
import { replacementFromEntries } from "../worktree-replacement.js";
import { resolveSessionProject } from "./projects.js";
import { badRequest, internalError, isTrustedBrowserOrigin, jsonResponse, notFound, textResponse } from "./http-utils.js";
import { createSessionFileCatalog } from "./session-file-catalog.js";
import { createSessionQueueCoordinator } from "./session-queue-coordinator.js";
import type { AgentSocketData, ClientSocketData, ExternalPendingRequest, SessionKind, SessionRecord, SocketData } from "./server-types.js";
import { SlashCommandService } from "./slash-command-service.js";
import { createStaticAssetResponder } from "./static-assets.js";
import { resolveWebCwd } from "./paths.js";
import {
	createWebWorktree,
	hasOtherSessionInWorktree,
	inheritManagedBranchOwnership,
	managedWorktreeFromEntries,
	removeManagedWorktree,
	removeManagedWorktreeAsync,
	WORKTREE_SESSION_ENTRY,
} from "./worktrees.js";
import { CoalescedQueueStoreWriter, readQueueStore } from "./queue-store.js";
import { ManagedSessionStore } from "./managed-session-store.js";
import { preserveRetryAroundQuiescence, quiesceQueueMutations } from "./queue-mutation.js";
import { runManagedRefresh, serializeManagedRefresh } from "./refresh-policy.js";
import { shouldContinueManagedShutdownWait, shouldRejectDuringShutdown, shouldWaitForManagedShutdown } from "./shutdown-policy.js";
import { isConfirmedMissingPath } from "./file-presence.js";
import { normalizeLegacySessionUpdate } from "./session-lifecycle.js";
import { boundedWebHistory, messagesToWebHistory, WEB_HISTORY_MAX_BYTES, WEB_HISTORY_MAX_ENTRIES, webHistoryByteLength } from "../history.js";
import { agentEndTerminalNotice, assistantTerminalNotice } from "../assistant-message.js";
import { CommandDeliveryUncertainError, CommandRejectedError, isUncertainRpcDeliveryCommand, ManagedRpcSession, type ManagedRpcSessionOptions } from "./managed-rpc-session.js";
import {
	disableTailscaleServe,
	ensureTailscaleServe,
	readTailscaleWebSettings,
	replaceTailscaleServe,
	type TailscaleStatus,
	type TailscaleWebSettings,
} from "../tailscale.js";

const decoder = new TextDecoder();
const rootDir = resolve(process.env.PI_WEB_ROOT ? (isAbsolute(process.env.PI_WEB_ROOT) ? process.env.PI_WEB_ROOT : join(process.cwd(), process.env.PI_WEB_ROOT)) : process.cwd());
const distDir = join(rootDir, "web", "dist");
const staticAssetResponse = createStaticAssetResponder(distDir);
const stateFilePath = resolve(
	process.env.PI_WEB_STATE_FILE
		? isAbsolute(process.env.PI_WEB_STATE_FILE)
			? process.env.PI_WEB_STATE_FILE
			: join(process.cwd(), process.env.PI_WEB_STATE_FILE)
		: join(homedir(), ".pi", "agent", "web", "server.json"),
);
const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
const settingsPath = join(agentDir, "settings.json");
const sessionsDir = join(agentDir, "sessions");
const queueStorePath = join(dirname(stateFilePath), "queues.json");
const managedSessionStorePath = join(dirname(stateFilePath), "managed-sessions.json");
const persistedQueues = readQueueStore(queueStorePath);
const queueStoreWriter = new CoalescedQueueStoreWriter(queueStorePath);
const managedSessionStore = new ManagedSessionStore(managedSessionStorePath);
const configuredPort = Number(process.env.PI_WEB_PORT ?? `${DEFAULT_WEB_PORT}`);
let port = Number.isInteger(configuredPort) && configuredPort >= 0 && configuredPort <= 65_535 ? configuredPort : DEFAULT_WEB_PORT;
const host = "127.0.0.1";
const LONG_RUNNING_COMMAND_TIMEOUT_MS = 10 * 60_000;
const MISSING_SESSION_RECONCILE_INTERVAL_MS = 1_000;
// Accept one legacy agent.hello containing a large session until running Pi
// processes reload the bridge that sends metadata-only hello frames.
const MAX_WEBSOCKET_PAYLOAD_BYTES = 32 * 1024 * 1024;
// Preserve at least one complete addon-sized image in reconnect snapshots.

const sessions = new Map<string, SessionRecord>();
const sessionsByFile = new Map<string, SessionRecord>();
const connectedClientSockets = new Set<Bun.ServerWebSocket<ClientSocketData>>();
const managedSessionStarts = new Map<string, Promise<SessionRecord>>();
const missingSessionReconciliations = new Set<SessionRecord>();
let server: Bun.Server<any> | undefined;
let missingSessionReconcileTimer: ReturnType<typeof setInterval> | undefined;
let shutdownStarted = false;
let webState: ServerStateFile;
let tailscaleStatus: TailscaleStatus = {
	installed: false,
	enabled: false,
	available: false,
	published: false,
};

function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true });
}

function readStateFile(path: string): ServerStateFile | undefined {
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<ServerStateFile>;
		if (
			parsed &&
			parsed.version === WEB_STATE_VERSION &&
			typeof parsed.pid === "number" &&
			typeof parsed.port === "number" &&
			typeof parsed.startedAt === "number"
		) {
			return parsed as ServerStateFile;
		}
	} catch {
		// ignore
	}
	return undefined;
}

function writeStateFileAtomic(path: string, state: ServerStateFile): void {
	ensureDir(dirname(path));
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	renameSync(tempPath, path);
}

function publishTailscaleStatus(status: TailscaleStatus): void {
	tailscaleStatus = status;
	webState = { ...webState, tailscale: status };
	writeStateFileAtomic(stateFilePath, webState);
}

async function configureTailscaleServe(settings?: TailscaleWebSettings, currentSettings?: TailscaleWebSettings): Promise<TailscaleStatus> {
	const resolvedSettings = settings ?? await readTailscaleWebSettings(settingsPath);
	const status = currentSettings
		? await replaceTailscaleServe({ currentSettings, nextSettings: resolvedSettings, localPort: port })
		: await ensureTailscaleServe({ settings: resolvedSettings, localPort: port });
	publishTailscaleStatus(status);
	return status;
}

async function removeTailscaleServe(settings: TailscaleWebSettings): Promise<TailscaleStatus> {
	const status = await disableTailscaleServe({ settings, localPort: port });
	publishTailscaleStatus(status);
	return status;
}

function getOrCreateWebState(): ServerStateFile {
	return {
		pid: process.pid,
		port,
		startedAt: Date.now(),
		version: WEB_STATE_VERSION,
	};
}

const {
	normalizePath, sessionFileKey, isManagedSessionFile, replaceManagedSessionFile, deleteManagedSessionFile,
	isWithinDir, canonicalSessionFile, isRecord, persistInitialSession, toNumber, zeroWebUsage, addWebUsage,
	extractTextContent, compactionEntryFromEvent, extractPreviewFromHistory,
	readManagedWorktreePrefix, parseSessionFile, parseSessionMetadataFile, parseSessionHistoryFile, listSavedSessionFiles,
	scanSavedSessions, deriveForkMessages,
} = createSessionFileCatalog({ sessionsDir, managedSessionStore });

function createRpcSession(options: Omit<ManagedRpcSessionOptions, "runtimeDirectory" | "replacementForSessionFile">): ManagedRpcSession {
	return new ManagedRpcSession({
		...options,
		runtimeDirectory: dirname(stateFilePath),
		replacementForSessionFile: (file) => parseSessionMetadataFile(file)?.replacement,
	});
}

const slashCommands = new SlashCommandService(normalizePath, (cwd) => createRpcSession({
	cwd,
	noSession: true,
	onEvent: () => undefined,
	onExit: () => undefined,
}));

function sessionToClientPayload(session: WebSession, includeSubagentTranscripts = false): WebSession {
	const project = resolveSessionProject(session.cwd);
	const subagents = includeSubagentTranscripts
		? session.subagents
		: session.subagents?.map(({ transcript: _transcript, streamingText: _streamingText, ...agent }) => agent);
	return {
		id: session.id,
		file: session.file,
		cwd: session.cwd,
		name: session.name,
		branch: session.branch,
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		status: session.status,
		source: session.source,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		messageCount: session.messageCount,
		preview: session.preview,
		parentSession: session.parentSession,
		projectId: project.id,
		projectName: project.name,
		repositoryRoot: project.root,
		managedWorktree: "managedWorktree" in session ? session.managedWorktree : undefined,
		pullRequest: session.pullRequest,
		subagents,
		subagentUsage: session.subagentUsage,
		usage: session.usage,
		contextUsage: session.contextUsage,
		compaction: session.compaction,
	};
}

function sortSessions(list: WebSession[]): WebSession[] {
	return list.sort(compareWebSessions);
}

function makeSessionRecord(
	session: WebSession,
	kind: SessionKind,
	history: unknown[] = [],
	managedWorktreeScanned = false,
): SessionRecord {
	const displayHistory = boundedWebHistory(kind === "saved" ? buildContextEntries(history as SessionEntry[]) : history);
	const historyManagedWorktree = managedWorktreeFromEntries(history);
	const record = sessions.get(session.id) ?? {
		...session,
		kind,
		history: displayHistory,
		historyReady: history.length > 0,
		historyBytes: webHistoryByteLength(displayHistory),
		active: kind !== "saved",
		agentRunning: session.status === "working",
		managedWorktreeScanned,
		agentSockets: new Set<Bun.ServerWebSocket<AgentSocketData>>(),
		clientSockets: new Set<Bun.ServerWebSocket<ClientSocketData>>(),
		externalRequestTargets: new Map<string, Bun.ServerWebSocket<AgentSocketData>>(),
		externalPending: new Map(),
		queue: (persistedQueues.get(session.id) ?? []).map((item) => ({ ...item, images: item.images?.map((image) => ({ ...image })) })),
	};
	Object.assign(record, session);
	record.kind = kind;
	if (history.length > 0) {
		record.history = displayHistory;
		record.historyReady = true;
		record.historyBytes = webHistoryByteLength(record.history);
	}
	record.managedWorktree = managedWorktreeScanned
		? session.managedWorktree
		: historyManagedWorktree ?? session.managedWorktree ?? record.managedWorktree;
	if (managedWorktreeScanned) record.managedWorktreeScanned = true;
	record.active = kind !== "saved" || record.active;
	if (kind === "saved") record.active = false;
	return record;
}

function upsertSession(
	session: WebSession,
	kind: SessionKind,
	history: unknown[] = [],
	managedWorktreeScanned = false,
): SessionRecord {
	const existing = sessions.get(session.id);
	const record = existing ?? makeSessionRecord(session, kind, history, managedWorktreeScanned);
	const historyManagedWorktree = history.length > 0 ? managedWorktreeFromEntries(history) : undefined;
	Object.assign(record, session);
	record.kind = kind;
	if (history.length > 0) replaceRecordHistory(record, kind === "saved" ? buildContextEntries(history as SessionEntry[]) : history);
	record.managedWorktree = managedWorktreeScanned
		? session.managedWorktree
		: historyManagedWorktree ?? session.managedWorktree ?? record.managedWorktree;
	if (managedWorktreeScanned) record.managedWorktreeScanned = true;
	if (kind !== "saved") record.active = true;
	sessions.set(record.id, record);
	if (record.file) sessionsByFile.set(normalizePath(record.file), record);
	return record;
}

function broadcast(sessionId: string, message: ServerToClientMessage): void {
	const record = sessions.get(sessionId);
	if (!record) return;
	const payload = JSON.stringify(message);
	for (const socket of record.clientSockets) {
		try {
			socket.send(payload);
		} catch {
			// ignore
		}
	}
}

function broadcastToAll(message: ServerToClientMessage): void {
	const payload = JSON.stringify(message);
	for (const socket of connectedClientSockets) {
		try {
			socket.send(payload);
		} catch {
			// ignore
		}
	}
}

function broadcastSessionToAll(record: SessionRecord): void {
	if (record.catalogReady === false || sessions.get(record.id) !== record) return;
	broadcastToAll({ type: "server.session", session: sessionToClientPayload(record) } satisfies ServerSessionMessage);
}

function catalogSessionChanged(previous: WebSession | undefined, next: WebSession): boolean {
	if (!previous) return true;
	return previous.file !== next.file
		|| previous.cwd !== next.cwd
		|| previous.name !== next.name
		|| previous.branch !== next.branch
		|| previous.model !== next.model
		|| previous.thinkingLevel !== next.thinkingLevel
		|| previous.status !== next.status
		|| previous.source !== next.source
		|| previous.messageCount !== next.messageCount
		|| previous.preview !== next.preview
		|| previous.parentSession !== next.parentSession
		|| previous.pullRequest?.number !== next.pullRequest?.number
		|| previous.pullRequest?.url !== next.pullRequest?.url
		|| previous.compaction?.reason !== next.compaction?.reason
		|| previous.compaction?.startedAt !== next.compaction?.startedAt;
}

function activeSessionFiles(): Set<string> {
	return new Set([...sessions.values()].flatMap((record) => record.active && record.file ? [normalizePath(record.file)] : []));
}

function sessionSnapshot(): WebSession[] {
	void reconcileMissingSessionFiles();
	const merged = new Map<string, WebSession>();
	for (const record of sessions.values()) {
		if (record.catalogReady === false || isMissingInactiveSession(record)) continue;
		const key = record.file ? normalizePath(record.file) : record.id;
		merged.set(key, sessionToClientPayload(record));
	}
	for (const scan of scanSavedSessions(sessionsDir, activeSessionFiles())) {
		const key = scan.session.file ? normalizePath(scan.session.file) : scan.session.id;
		const live = sessionsByFile.get(key) ?? sessions.get(scan.session.id);
		if (!live?.active || live.status === "offline") merged.set(key, sessionToClientPayload(scan.session));
	}
	return sortSessions(Array.from(merged.values()));
}

function replaceRecordHistory(record: SessionRecord, entries: readonly unknown[]): void {
	record.history = boundedWebHistory(entries);
	record.historyReady = true;
	record.historyBytes = webHistoryByteLength(record.history);
}

function appendRecordHistory(record: SessionRecord, entry: unknown): void {
	const appended = boundedWebHistory([entry], { maxEntries: 1 });
	if (appended.length === 0) return;
	record.history.push(appended[0]);
	record.historyReady = true;
	record.historyBytes = (record.historyBytes ?? webHistoryByteLength(record.history.slice(0, -1))) + webHistoryByteLength(appended);
	while (record.history.length > WEB_HISTORY_MAX_ENTRIES || record.historyBytes > WEB_HISTORY_MAX_BYTES) {
		const first = record.history[0];
		const preserveSummary = isRecord(first) && typeof first.id === "string" && first.id.startsWith("web-compaction-");
		const removeIndex = preserveSummary && record.history.length > 1 ? 1 : 0;
		const [removed] = record.history.splice(removeIndex, 1);
		record.historyBytes = Math.max(2, record.historyBytes - webHistoryByteLength([removed]));
	}
}

function sessionHistoryForRecord(record: SessionRecord): unknown[] {
	if (record.active || record.historyReady) return [...record.history];
	if (record.file) {
		const scan = parseSessionFile(record.file);
		if (scan) {
			replaceRecordHistory(record, buildContextEntries(scan.history as SessionEntry[]));
			return [...record.history];
		}
	}
	return [...record.history];
}

function updateSubagentsFromToolEvent(record: SessionRecord, event: Record<string, unknown>): boolean {
	if (event.type !== "tool_execution_end" || typeof event.toolName !== "string" || !event.toolName.startsWith("subagent_")) return false;
	const result = isRecord(event.result) ? event.result : undefined;
	const details = result && isRecord(result.details) ? result.details : undefined;
	if (!details || !Array.isArray(details.agents)) return false;
	const previous = new Map((record.subagents ?? []).map((agent) => [agent.id, agent]));
	const now = Date.now();
	record.subagents = details.agents.flatMap((value) => {
		if (!isRecord(value) || typeof value.id !== "string" || typeof value.status !== "string") return [];
		const prior = previous.get(value.id);
		return [{
			id: value.id,
			status: value.status as NonNullable<WebSession["subagents"]>[number]["status"],
			model: typeof value.model === "string" ? value.model : prior?.model ?? "unknown model",
			effort: typeof value.effort === "string" ? value.effort : prior?.effort ?? "off",
			turns: typeof value.turns === "number" ? value.turns : prior?.turns ?? 0,
			currentTool: typeof value.currentTool === "string" ? value.currentTool : undefined,
			queued: typeof value.queued === "number" ? value.queued : prior?.queued ?? 0,
			createdAt: prior?.createdAt ?? now,
			updatedAt: now,
			completedAt: value.status === "completed" || value.status === "failed" || value.status === "terminated" ? now : prior?.completedAt,
			error: typeof value.error === "string" ? value.error : prior?.error,
			usage: isRecord(value.usage) ? value.usage as NonNullable<WebSession["subagents"]>[number]["usage"] : prior?.usage,
			transcript: Array.isArray(value.transcript) ? value.transcript.flatMap((entry) => {
				if (!isRecord(entry) || typeof entry.timestamp !== "number" || typeof entry.role !== "string" || typeof entry.text !== "string") return [];
				return [{ timestamp: entry.timestamp, role: entry.role, text: entry.text }];
			}) : prior?.transcript,
			streamingText: typeof value.streamingText === "string" ? value.streamingText : prior?.streamingText,
		}];
	});
	return true;
}

function updateRecordFromState(record: SessionRecord, state: unknown): void {
	const s = state as Record<string, unknown> | undefined;
	if (!s) return;
	const model = s.model as Record<string, unknown> | null | undefined;
	if (model && typeof model.id === "string") {
		record.model = typeof model.provider === "string" && model.provider
			? `${model.provider}/${model.id}`
			: model.id;
	}
	if (typeof s.thinkingLevel === "string") record.thinkingLevel = s.thinkingLevel;
	if (typeof s.sessionFile === "string") {
		record.file = s.sessionFile;
		sessionsByFile.set(normalizePath(s.sessionFile), record);
		const scan = parseSessionMetadataFile(s.sessionFile);
		if (scan?.session.cwd) record.cwd = scan.session.cwd;
		if (scan?.managedWorktreeScanned) record.managedWorktree = scan.session.managedWorktree;
	}
	if (typeof s.sessionId === "string") record.id = s.sessionId;
	record.name = typeof s.sessionName === "string" && s.sessionName ? s.sessionName : undefined;
	if (typeof s.messageCount === "number") record.messageCount = s.messageCount;
	if (s.isCompacting === true) {
		record.compaction ??= { reason: "threshold", startedAt: Date.now() };
		record.status = "working";
	} else if (s.isCompacting === false) {
		record.compaction = undefined;
		if (s.isStreaming === false && record.status !== "error") record.status = "idle";
	}
	record.updatedAt = Date.now();
}

async function commandOutput(command: string[], cwd: string, timeoutMs = 10_000): Promise<string | undefined> {
	let process: Bun.Subprocess | undefined;
	try {
		process = Bun.spawn({ cmd: command, cwd, stdout: "pipe", stderr: "ignore" });
		const stdout = process.stdout;
		if (!stdout || typeof stdout === "number") return undefined;
		const timeout = setTimeout(() => process?.kill(), timeoutMs);
		try {
			const [output, code] = await Promise.all([
				new Response(stdout as ReadableStream<Uint8Array>).text(),
				process.exited,
			]);
			return code === 0 ? output.trim() : undefined;
		} finally {
			clearTimeout(timeout);
		}
	} catch {
		return undefined;
	}
}

async function hydrateGitMetadata(record: SessionRecord): Promise<void> {
	const generation = (record.gitMetadataGeneration ?? 0) + 1;
	record.gitMetadataGeneration = generation;
	const cwd = record.cwd;
	const branch = await commandOutput(["git", "branch", "--show-current"], cwd);
	const raw = await commandOutput(["gh", "pr", "view", "--json", "number,url"], cwd);
	let pullRequest: WebSession["pullRequest"];
	if (raw) {
		try {
			const value: unknown = JSON.parse(raw);
			if (isRecord(value) && Number.isInteger(value.number) && typeof value.url === "string") {
				const url = new URL(value.url);
				if (url.protocol === "https:" || url.protocol === "http:") {
					pullRequest = { number: value.number as number, url: url.toString() };
				}
			}
		} catch {
			// A branch without an open PR is expected.
		}
	}
	if (record.gitMetadataGeneration !== generation || record.cwd !== cwd || sessions.get(record.id) !== record) return;
	if (branch) record.branch = branch;
	// A failed/no-match `gh pr view` is authoritative for the current branch and
	// must clear a PR cached before the TUI changed branches.
	record.pullRequest = pullRequest;
	broadcastSessionToAll(record);
}

async function runRpcSessionCommand(record: SessionRecord, command: RpcSessionCommand): Promise<unknown> {
	if (record.managed) {
		switch (command.type) {
			case "clone":
				return await record.managed.clone();
			case "fork":
				return await record.managed.fork(command.entryId);
			case "get_fork_messages":
				return await record.managed.getForkMessages();
			case "set_session_name":
				await record.managed.setSessionName(command.name);
				return undefined;
			case "compact":
				return await record.managed.compact(command.customInstructions);
			case "bash":
				return await record.managed.bash(command.command);
			case "extension_ui_response":
				return await record.managed.respondToExtensionUi(command);
		}
	}
	if (record.file && isWithinDir(record.file, sessionsDir)) {
		const scan = parseSessionMetadataFile(record.file);
		if (scan) {
			const temp = createRpcSession({
				cwd: scan.session.cwd,
				name: scan.session.name,
				sessionFile: record.file,
				onEvent: (event) => {
					if (typeof event === "object" && event && "type" in event) {
						broadcast(record.id, { type: "server.event", sessionId: record.id, event: event as Record<string, unknown> } satisfies ServerEventMessage);
					}
				},
				onExit: () => undefined,
			});
			await temp.start();
			try {
				switch (command.type) {
					case "clone":
						return await temp.clone();
					case "fork":
						return await temp.fork(command.entryId);
					case "get_fork_messages": {
						const response = await temp.getForkMessages();
						return response;
					}
					case "set_session_name":
						await temp.setSessionName(command.name);
						return undefined;
					case "compact":
						return await temp.compact(command.customInstructions);
					case "bash":
						return await temp.bash(command.command);
					case "extension_ui_response":
						throw new Error("No extension UI request is active for this saved session");
				}
			} finally {
				await temp.shutdown();
			}
		}
	}
	if (command.type === "get_fork_messages") {
		return { messages: deriveForkMessages(record.history) };
	}
	throw new Error(`Session ${record.id} is not managed`);
}

function sendSessionSnapshot(socket: Bun.ServerWebSocket<ClientSocketData>): void {
	const payload: ServerSnapshotMessage = { type: "server.snapshot", sessions: sessionSnapshot() };
	socket.send(JSON.stringify(payload));
}

function sendSessionHistory(socket: Bun.ServerWebSocket<ClientSocketData>, record: SessionRecord): void {
	// The web client is semantic for both managed and native sessions. Loading
	// transcript entries here avoids any second TUI render in the Pi process.
	const entries = sessionHistoryForRecord(record);
	// Bound initial payload size for very long sessions. Live events append from
	// this point; older history remains available in the native session file.
	const payload: ServerHistoryMessage = {
		type: "server.history",
		sessionId: record.id,
		entries: boundedWebHistory(entries),
		replace: true,
	};
	socket.send(JSON.stringify(payload));
}

const {
	webQueueEvent, cloneWebQueue, persistWebQueue, enqueueWebFollowUp, migratePersistedQueue,
	scheduleWebQueueRetry, markWebQueueSnapshotDirty, markAgentActivity, markAgentSettling,
	isCurrentAgentSettlement, cancelQueueSettleFallback, scheduleQueueSettleFallback, cancelWebQueueWork,
	broadcastQueueDelivery, broadcastReloadComplete, sendSessionState, flushWebQueue, routeQueueCommand,
} = createSessionQueueCoordinator({
	persistedQueues,
	queueStoreWriter,
	currentRecord: (id) => sessions.get(id),
	isShutdownStarted: () => shutdownStarted,
	broadcast,
	deliverCommand: (record, command) => routeCommand(record, command),
	projectSession: sessionToClientPayload,
});

function sendSessionRemoved(
	sessionId: string,
	replacementSessionId?: string,
	additionalSockets: Iterable<Bun.ServerWebSocket<ClientSocketData>> = [],
): void {
	const payload: ServerSessionRemovedMessage = { type: "server.session_removed", sessionId, replacementSessionId };
	const message = JSON.stringify(payload);
	const notified = new Set<Bun.ServerWebSocket<ClientSocketData>>();
	for (const socket of connectedClientSockets) {
		notified.add(socket);
		try { socket.send(message); } catch { /* ignore */ }
	}
	for (const socket of additionalSockets) {
		if (notified.has(socket)) continue;
		notified.add(socket);
		try { socket.send(message); } catch { /* ignore */ }
	}
}

async function completeExternalSessionReplacement(
	socket: Bun.ServerWebSocket<AgentSocketData>,
	replacement: AgentSessionReplacedMessage,
): Promise<void> {
	if (replacement.previousSessionId === replacement.replacementSessionId) throw new Error("Replacement session must differ from its source");
	const next = sessions.get(replacement.replacementSessionId);
	if (!next || !next.agentSockets.has(socket)) throw new Error("Replacement session is not bound to this agent socket");
	const durableReplacement = next.file
		? parseSessionMetadataFile(next.file)?.replacement
		: replacementFromEntries(next.history);
	if (
		!durableReplacement ||
		durableReplacement.previousSessionId !== replacement.previousSessionId ||
		normalizePath(durableReplacement.previousSessionFile) !== normalizePath(replacement.previousSessionFile) ||
		durableReplacement.replacementSessionId !== replacement.replacementSessionId
	) throw new Error("Replacement activation does not match the durable session marker");
	const previous = sessions.get(replacement.previousSessionId);
	if (previous && (!previous.file || normalizePath(previous.file) !== normalizePath(replacement.previousSessionFile))) {
		throw new Error("Replacement source file does not match the registered source session");
	}

	if (!previous) {
		if (existsSync(replacement.previousSessionFile)) return;
		const orphaned = persistedQueues.get(replacement.previousSessionId);
		if (orphaned?.length) {
			const ids = new Set<string>();
			const queue = [...cloneWebQueue(orphaned), ...cloneWebQueue(next.queue)].filter((item) => {
				if (ids.has(item.id)) return false;
				ids.add(item.id);
				return true;
			});
			await queueStoreWriter.mutate(persistedQueues, (queues) => {
				queues.delete(replacement.previousSessionId);
				if (queue.length > 0) queues.set(next.id, queue);
			});
			next.queue = queue;
			broadcast(next.id, webQueueEvent(next));
			if (next.status === "idle" && next.agentRunning !== true) scheduleQueueSettleFallback(next);
		}
		sendSessionRemoved(replacement.previousSessionId, next.id);
		return;
	}

	// A durable marker can be written immediately before unlink. If Pi crashes in
	// that narrow window, retain both sessions rather than treating it as committed.
	if (existsSync(replacement.previousSessionFile)) return;
	await quiesceQueueMutations(previous);
	if (previous.queueDirtyWorker) {
		await previous.queueDirtyWorker.cancelAndDrain();
		previous.queueDirtyWorker = undefined;
	}
	const ids = new Set<string>();
	const queue = [...cloneWebQueue(previous.queue), ...cloneWebQueue(next.queue)].filter((item) => {
		if (ids.has(item.id)) return false;
		ids.add(item.id);
		return true;
	});
	try {
		await queueStoreWriter.mutate(persistedQueues, (queues) => {
			queues.delete(previous.id);
			if (queue.length > 0) queues.set(next.id, queue);
			else queues.delete(next.id);
		});
	} catch (error) {
		previous.queueMutationsQuiesced = false;
		throw error;
	}
	next.queue = queue;
	next.queueDeliveryAttempts ??= previous.queueDeliveryAttempts;
	next.queueTransitionAttempts ??= previous.queueTransitionAttempts;

	for (const client of previous.clientSockets) {
		next.clientSockets.add(client);
		client.data.sessionId = next.id;
	}
	for (const [requestId, pending] of previous.externalPending) {
		pending.owner = next;
		next.externalPending.set(requestId, pending);
		next.externalRequestTargets.set(requestId, socket);
	}
	previous.externalPending.clear();
	previous.externalRequestTargets.clear();
	cancelWebQueueWork(previous);
	sessions.delete(previous.id);
	if (previous.file) sessionsByFile.delete(normalizePath(previous.file));
	for (const agent of previous.agentSockets) {
		if (agent === socket) continue;
		try { agent.close(); } catch { /* ignore */ }
	}
	broadcast(next.id, webQueueEvent(next));
	sendSessionRemoved(previous.id, next.id);
	if (next.status === "idle" && next.agentRunning !== true && next.queue.length > 0) scheduleQueueSettleFallback(next);
}

function updateRecordFromStats(record: SessionRecord, value: unknown): void {
	if (!isRecord(value)) return;
	if (isRecord(value.tokens)) {
		const usage = record.usage ?? zeroWebUsage();
		usage.input = toNumber(value.tokens.input);
		usage.output = toNumber(value.tokens.output);
		usage.cacheRead = toNumber(value.tokens.cacheRead);
		usage.cacheWrite = toNumber(value.tokens.cacheWrite);
		usage.totalTokens = toNumber(value.tokens.total);
		usage.cost.total = toNumber(value.cost, usage.cost.total);
		record.usage = usage;
	}
	if (isRecord(value.contextUsage)) {
		record.contextUsage = {
			tokens: value.contextUsage.tokens === null ? null : toNumber(value.contextUsage.tokens),
			contextWindow: toNumber(value.contextUsage.contextWindow),
			percent: value.contextUsage.percent === null ? null : toNumber(value.contextUsage.percent),
		};
	}
}

function stageSourceSessionDeletion(previousFile: string, nextFile: string): ManagedIdentityTransition {
	const source = canonicalSessionFile(previousFile);
	if (sessionFileKey(source) === sessionFileKey(nextFile)) throw new Error("Replacement session file must differ from its source");
	const tombstone = `${source}.replaced-${randomUUID()}.tmp`;
	renameSync(source, tombstone);
	return {
		rollback: () => {
			if (existsSync(source)) throw new Error(`Refusing to overwrite a recreated source session: ${source}`);
			if (existsSync(tombstone)) renameSync(tombstone, source);
			else throw new Error(`Missing staged source session ${tombstone}`);
		},
		commit: () => {
			try { rmSync(tombstone, { force: true }); } catch (error) {
				console.warn(`Source session was removed, but its staged tombstone could not be cleaned: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	};
}

type ManagedIdentityTransition = {
	rollback(): void;
	commit(): void;
};

async function refreshManagedSession(
	record: SessionRecord,
	suppressErrors = false,
	stageIdentityTransition?: (previousFile: string, nextFile: string) => ManagedIdentityTransition,
): Promise<void> {
	await runManagedRefresh(() => serializeManagedRefresh(record, async () => {
		const managed = record.managed;
		if (!managed) return;
		let finishQueueMigration: (() => void) | undefined;
		let identityTransition: ManagedIdentityTransition | undefined;
		try {
			const oldId = record.id;
			const oldFile = record.file;
			const state = await managed.getState();
			const nextState = isRecord(state) ? { ...state } : state;
			const newId = isRecord(nextState) && typeof nextState.sessionId === "string" ? nextState.sessionId : oldId;
			const newFile = isRecord(nextState) && typeof nextState.sessionFile === "string" ? nextState.sessionFile : oldFile;
			const fileChanged = Boolean(newFile && (!oldFile || sessionFileKey(newFile) !== sessionFileKey(oldFile)));
			let ownershipMigrated = false;
			try {
				const pendingDeletion = record.pendingWorktreeSourceDeletion;
				let verifiedPendingDeletion = false;
				if (pendingDeletion && pendingDeletion.sessionId === oldId && oldFile && newFile && newId !== oldId && sessionFileKey(pendingDeletion.sessionFile) === sessionFileKey(oldFile)) {
					const marker = parseSessionMetadataFile(newFile)?.replacement;
					verifiedPendingDeletion = Boolean(
						marker &&
						marker.previousSessionId === oldId &&
						sessionFileKey(marker.previousSessionFile) === sessionFileKey(oldFile) &&
						marker.replacementSessionId === newId
					);
				}
				if (pendingDeletion && pendingDeletion.sessionId === oldId && newId !== oldId && !verifiedPendingDeletion) {
					// session_start can be observed before the verified activation marker is
					// appended. Leave the old identity intact until the worktree callback commits.
					return;
				}
				const transitionFactory = stageIdentityTransition ?? (verifiedPendingDeletion ? stageSourceSessionDeletion : undefined);
				if (oldFile && newFile && newId !== oldId && transitionFactory) {
					identityTransition = transitionFactory(oldFile, newFile);
				}
				if (newFile) {
					ownershipMigrated = fileChanged || !isManagedSessionFile(newFile);
					replaceManagedSessionFile(oldFile, newFile);
				}
				if (newId !== oldId) {
					finishQueueMigration = preserveRetryAroundQuiescence({
						isArmed: () => record.queueRetryTimer !== undefined,
						cancel: () => {
							if (record.queueRetryTimer) clearTimeout(record.queueRetryTimer);
							record.queueRetryTimer = undefined;
						},
						reopen: () => { record.queueMutationsQuiesced = false; },
						resume: () => scheduleWebQueueRetry(record),
					});
					await migratePersistedQueue(record, oldId, newId);
					if (isRecord(nextState)) delete nextState.sessionId;
				}
			} catch (transitionError) {
				const rollbackErrors: string[] = [];
				if (identityTransition) {
					try { identityTransition.rollback(); } catch (error) {
						rollbackErrors.push(`source-session rollback failed: ${error instanceof Error ? error.message : String(error)}`);
					}
					identityTransition = undefined;
				}
				if (oldFile && (fileChanged || newId !== oldId)) {
					try {
						await managed.switchSession(oldFile);
						const restored = await managed.getState();
						if (!isRecord(restored) || restored.sessionId !== oldId || typeof restored.sessionFile !== "string" || sessionFileKey(restored.sessionFile) !== sessionFileKey(oldFile)) {
							throw new Error("Pi did not restore the original session identity");
						}
					} catch (error) {
						rollbackErrors.push(`runtime rollback failed: ${error instanceof Error ? error.message : String(error)}`);
						await managed.shutdown().catch(() => undefined);
						record.managed = undefined;
						record.active = false;
						record.status = "offline";
					}
				} else if (!oldFile && fileChanged) {
					await managed.shutdown().catch(() => undefined);
					record.managed = undefined;
					record.active = false;
					record.status = "offline";
				}
				if (ownershipMigrated && oldFile && newFile) {
					try { replaceManagedSessionFile(newFile, oldFile); } catch (error) {
						rollbackErrors.push(`ownership rollback failed: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
				finishQueueMigration?.();
				finishQueueMigration = undefined;
				const message = transitionError instanceof Error ? transitionError.message : String(transitionError);
				throw new Error(rollbackErrors.length > 0 ? `${message}; ${rollbackErrors.join("; ")}` : message);
			}

			updateRecordFromState(record, nextState);
			try {
				replaceRecordHistory(record, messagesToWebHistory((await managed.getMessages()).messages));
			} catch {
				// Keep the last complete bounded history snapshot.
			}
			try {
				updateRecordFromStats(record, await managed.getSessionStats());
			} catch {
				// Stats are supplementary; keep history-derived usage.
			}
			if (oldId !== newId) {
				record.id = newId;
				sessions.delete(oldId);
				sessions.set(newId, record);
				for (const socket of record.clientSockets) socket.data.sessionId = newId;
				finishQueueMigration?.();
				finishQueueMigration = undefined;
				sendSessionRemoved(oldId, newId);
			}
			if (oldFile && oldFile !== record.file) sessionsByFile.delete(normalizePath(oldFile));
			if (record.file) sessionsByFile.set(normalizePath(record.file), record);
			identityTransition?.commit();
			if (record.pendingWorktreeSourceDeletion?.sessionId === oldId && oldId !== newId) {
				record.pendingWorktreeSourceDeletion = undefined;
			}
			identityTransition = undefined;
			broadcastSessionToAll(record);
		} catch (error) {
			finishQueueMigration?.();
			if (identityTransition) {
				try { identityTransition.rollback(); } catch (rollbackError) {
					throw new Error(`${error instanceof Error ? error.message : String(error)}; source-session rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
				}
			}
			throw error;
		}
	}), {
		suppressErrors,
		onBackgroundError: (error) => console.error(`Could not refresh managed session ${record.id}:`, error),
	});
}

async function recoverStagedSourceSessionDeletions(): Promise<void> {
	const tombstones: Array<{ tombstone: string; source: string }> = [];
	const stack = [sessionsDir];
	while (stack.length > 0) {
		const directory = stack.pop()!;
		let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
		try {
			entries = readdirSync(directory, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
		} catch { continue; }
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) stack.push(path);
			else if (entry.isFile()) {
				const match = path.match(/^(.*\.jsonl)\.replaced-[0-9a-f-]+\.tmp$/i);
				if (match) tombstones.push({ tombstone: path, source: match[1] });
			}
		}
	}
	if (tombstones.length === 0) return;
	const saved = listSavedSessionFiles(sessionsDir).flatMap((file) => {
		const scan = parseSessionFile(file);
		return scan ? [scan] : [];
	});
	for (const staged of tombstones) {
		if (existsSync(staged.source)) {
			console.warn(`Retaining staged source session because its original path was recreated: ${staged.tombstone}`);
			continue;
		}
		try {
			const sourceWasManaged = managedSessionStore.has(staged.source);
			const sourceScan = parseSessionFile(staged.tombstone);
			const sourceId = sourceScan?.session.id;
			const replacement = sourceId ? saved.find((candidate) => {
				const marker = replacementFromEntries(candidate.entries);
				return marker?.previousSessionId === sourceId &&
					normalizePath(marker.previousSessionFile) === normalizePath(staged.source) &&
					marker.replacementSessionId === candidate.session.id;
			}) : undefined;
			if (!replacement) {
				if (!existsSync(staged.source)) renameSync(staged.tombstone, staged.source);
				continue;
			}
			const sourceQueue = persistedQueues.get(sourceId!);
			const replacementQueue = persistedQueues.get(replacement.session.id);
			if (sourceQueue?.length) {
				const ids = new Set<string>();
				const queue = [...cloneWebQueue(sourceQueue), ...cloneWebQueue(replacementQueue ?? [])].filter((item) => {
					if (ids.has(item.id)) return false;
					ids.add(item.id);
					return true;
				});
				await queueStoreWriter.mutate(persistedQueues, (queues) => {
					queues.delete(sourceId!);
					queues.set(replacement.session.id, queue);
				});
			}
			const previousManagedWorktree = managedWorktreeFromEntries(sourceScan?.entries ?? []);
			if (sourceWasManaged) replaceManagedSessionFile(staged.source, replacement.file);
			let worktreeCleanupFailed = false;
			if (previousManagedWorktree && !hasOtherSessionInWorktree(sessionsDir, staged.source, previousManagedWorktree.path)) {
				try {
					const cleanup = removeManagedWorktree(previousManagedWorktree);
					if (cleanup.branchWarning) console.warn(`Recovered source deletion removed worktree ${previousManagedWorktree.path}, but branch cleanup failed: ${cleanup.branchWarning}`);
				} catch (error) {
					worktreeCleanupFailed = true;
					console.warn(`Recovered source session deletion, but previous managed worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (!worktreeCleanupFailed) rmSync(staged.tombstone, { force: true });
		} catch (error) {
			console.warn(`Could not recover staged source session deletion ${staged.tombstone}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	try { managedSessionStore.recanonicalize(); } catch (error) {
		console.warn(`Could not recanonicalize managed session ownership after source recovery: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function createManagedSessionUnlocked(cwd: string, name?: string, sessionFile?: string): Promise<SessionRecord> {
	const resumed = sessionFile ? parseSessionMetadataFile(sessionFile) : undefined;
	const existingRecord = resumed
		? sessions.get(resumed.session.id) ?? sessionsByFile.get(normalizePath(resumed.file))
		: undefined;
	let restoreExistingQueueIntake: (() => void) | undefined;
	if (existingRecord) {
		restoreExistingQueueIntake = preserveRetryAroundQuiescence({
			isArmed: () => existingRecord.queueRetryTimer !== undefined,
			cancel: () => {
				if (existingRecord.queueRetryTimer) clearTimeout(existingRecord.queueRetryTimer);
				existingRecord.queueRetryTimer = undefined;
			},
			reopen: () => { existingRecord.queueMutationsQuiesced = false; },
			resume: () => scheduleWebQueueRetry(existingRecord),
		});
		await quiesceQueueMutations(existingRecord);
		if (existingRecord.queueDirtyWorker) {
			await existingRecord.queueDirtyWorker.cancelAndDrain();
			existingRecord.queueDirtyWorker = undefined;
		}
	}
	const record: SessionRecord = {
		id: resumed?.session.id ?? randomUUID(),
		file: sessionFile,
		cwd,
		name: name ?? resumed?.session.name,
		model: resumed?.session.model,
		thinkingLevel: resumed?.session.thinkingLevel,
		status: "starting",
		source: "web",
		createdAt: resumed?.session.createdAt ?? Date.now(),
		updatedAt: Date.now(),
		messageCount: resumed?.session.messageCount ?? 0,
		preview: resumed?.session.preview,
		parentSession: resumed?.session.parentSession,
		usage: resumed?.session.usage,
		contextUsage: resumed?.session.contextUsage,
		kind: "managed",
		history: existingRecord?.history ?? resumed?.history ?? [],
		historyReady: existingRecord?.historyReady ?? false,
		active: true,
		agentSockets: new Set(),
		clientSockets: existingRecord?.clientSockets ?? new Set(),
		externalRequestTargets: new Map(),
		externalPending: new Map(),
		queue: cloneWebQueue(existingRecord?.queue ?? persistedQueues.get(resumed?.session.id ?? "") ?? []),
		// A newly started RPC runtime has no surviving subagents. An explicit empty
		// snapshot clears stale browser telemetry retained across daemon reconnects.
		subagents: [],
		managedWorktree: resumed?.session.managedWorktree,
		catalogReady: false,
	};
	sessions.set(record.id, record);
	if (record.file) sessionsByFile.set(normalizePath(record.file), record);

	const managed = createRpcSession({
		cwd,
		name,
		sessionFile,
		onEvent: (event) => {
			record.updatedAt = Date.now();
			updateSubagentsFromToolEvent(record, event);
			if (event.type === "agent_start" || event.type === "turn_start") {
				record.agentStartGeneration = (record.agentStartGeneration ?? 0) + 1;
				markAgentActivity(record);
			}
			if (event.type === "agent_start" || event.type === "turn_start") {
				cancelQueueSettleFallback(record);
				record.status = "working";
				record.agentRunning = true;
			}
			if (event.type === "agent_end" && !record.compaction) {
				markAgentSettling(record);
				record.status = agentEndTerminalNotice(event)?.kind === "error" ? "error" : "idle";
				record.agentRunning = false;
				scheduleQueueSettleFallback(record);
			}
			if (event.type === "compaction_start") {
				markAgentSettling(record);
				record.status = "working";
				record.agentRunning = true;
				record.compaction = {
					reason: event.reason === "manual" || event.reason === "overflow" ? event.reason : "threshold",
					startedAt: typeof event.startedAt === "number" ? event.startedAt : Date.now(),
				};
			}
			if (event.type === "compaction_end") {
				record.compaction = undefined;
				if (event.aborted === true || event.willRetry === false) {
					record.status = "idle";
					record.agentRunning = false;
					scheduleQueueSettleFallback(record);
				}
			}
			if (event.type === "agent_settled" && isCurrentAgentSettlement(record)) {
				cancelQueueSettleFallback(record);
				record.settlingGeneration = undefined;
				// Pi emits agent_settled only when no retry, compaction, or internal
				// follow-up remains. It is authoritative even when an interrupted
				// overflow compaction last advertised willRetry=true.
				if (record.status !== "error") record.status = "idle";
				record.agentRunning = false;
				void refreshManagedSession(record, true);
				void flushWebQueue(record);
			}

			if (event.type === "message_end" && isRecord(event.message)) {
				if (event.message.role === "assistant" || event.message.role === "toolResult") {
					record.usage ??= zeroWebUsage();
					addWebUsage(record.usage, event.message.usage);
				}
				appendRecordHistory(record, {
					type: "message",
					id: randomUUID(),
					parentId: null,
					timestamp: new Date().toISOString(),
					message: event.message,
				});
				record.messageCount += 1;
				const terminalNotice = assistantTerminalNotice(event.message);
				if (terminalNotice && !extractTextContent(event.message.content)) {
					record.preview = `${terminalNotice.title}: ${terminalNotice.detail}`.slice(0, 180);
				}
			}
			const compactionEntry = compactionEntryFromEvent(event);
			if (compactionEntry) {
				replaceRecordHistory(record, [compactionEntry]);
				broadcast(record.id, { type: "server.history", sessionId: record.id, entries: record.history, replace: true } satisfies ServerHistoryMessage);
				const runtime = record.managed;
				if (runtime) {
					void runtime.getMessages().then(({ messages }) => {
						if (record.managed !== runtime || sessions.get(record.id) !== record) return;
						replaceRecordHistory(record, messagesToWebHistory(messages));
						broadcast(record.id, { type: "server.history", sessionId: record.id, entries: record.history, replace: true } satisfies ServerHistoryMessage);
					}).catch((error) => console.error(`Could not refresh compacted history for ${record.id}: ${error instanceof Error ? error.message : String(error)}`));
				}
			}
			broadcast(record.id, {
				type: "server.event",
				sessionId: record.id,
				event,
			} satisfies ServerEventMessage);
			const catalogChanged = event.type === "agent_start"
				|| event.type === "turn_start"
				|| event.type === "agent_end"
				|| event.type === "agent_settled"
				|| event.type === "compaction_start"
				|| event.type === "compaction_end"
				|| event.type === "message_end";
			if (catalogChanged) broadcastSessionToAll(record);
			else broadcast(record.id, { type: "server.session", session: sessionToClientPayload(record) } satisfies ServerSessionMessage);
		},
		onExit: () => {
			record.status = "offline";
			record.active = false;
			record.managed = undefined;
			broadcastSessionToAll(record);
		},
	});
	record.managed = managed;
	const provisionalId = record.id;
	try {
		await managed.start();
		const state = await managed.getState();
		updateRecordFromState(record, state);
		if (record.file) replaceManagedSessionFile(sessionFile, record.file);
		if (record.id !== provisionalId) {
			sessions.delete(provisionalId);
			sessions.set(record.id, record);
		}
		try {
			replaceRecordHistory(record, messagesToWebHistory((await managed.getMessages()).messages));
		} catch {
			// A failed context request must not publish a blank active resume. Read only
			// a bounded suffix instead of hydrating the append-only session archive.
			if (!record.historyReady && record.file) replaceRecordHistory(record, parseSessionHistoryFile(record.file));
		}
		try {
			updateRecordFromStats(record, await managed.getSessionStats());
		} catch {
			// Keep history-derived usage when stats are unavailable.
		}
		record.status = "idle";
		record.catalogReady = true;
		broadcastSessionToAll(record);
		void hydrateGitMetadata(record);
		for (const socket of record.clientSockets) {
			socket.data.sessionId = record.id;
			sendSessionState(socket, record);
			sendSessionHistory(socket, record);
		}
		void flushWebQueue(record);
		return record;
	} catch (error) {
		await managed.shutdown();
		if (sessions.get(provisionalId) === record) sessions.delete(provisionalId);
		if (sessions.get(record.id) === record) sessions.delete(record.id);
		for (const file of [sessionFile, record.file]) {
			if (file && sessionsByFile.get(normalizePath(file)) === record) sessionsByFile.delete(normalizePath(file));
		}
		if (existingRecord) {
			sessions.set(existingRecord.id, existingRecord);
			if (existingRecord.file) sessionsByFile.set(normalizePath(existingRecord.file), existingRecord);
			restoreExistingQueueIntake?.();
			broadcastSessionToAll(existingRecord);
		}
		throw error;
	}

}

async function createManagedSession(cwd: string, name?: string, sessionFile?: string): Promise<SessionRecord> {
	if (!sessionFile) return await createManagedSessionUnlocked(cwd, name);
	const key = normalizePath(sessionFile);
	const existing = managedSessionStarts.get(key);
	if (existing) return await existing;
	const start = createManagedSessionUnlocked(cwd, name, sessionFile);
	managedSessionStarts.set(key, start);
	try {
		return await start;
	} finally {
		if (managedSessionStarts.get(key) === start) managedSessionStarts.delete(key);
	}
}

async function restoreManagedSessions(): Promise<void> {
	for (const storedFile of managedSessionStore.list()) {
		let file: string;
		try {
			file = canonicalSessionFile(storedFile);
		} catch {
			try { deleteManagedSessionFile(storedFile); } catch (error) {
				console.error(`Could not remove missing managed session ${storedFile}:`, error);
			}
			continue;
		}
		const existing = sessionsByFile.get(normalizePath(file));
		if (existing?.active && existing.status !== "offline") continue;
		if (!isManagedSessionFile(file)) continue;
		const scan = parseSessionMetadataFile(file);
		if (!scan) {
			try { deleteManagedSessionFile(file); } catch (error) {
				console.error(`Could not remove invalid managed session ${file}:`, error);
			}
			continue;
		}
		try {
			await createManagedSession(scan.session.cwd, scan.session.name, file);
		} catch (error) {
			console.error(`Could not restore managed web session ${scan.session.id}:`, error);
		}
	}
}

function attachClientSocket(socket: Bun.ServerWebSocket<ClientSocketData>): void {
	socket.data = { kind: "client", id: randomUUID(), authed: false };
}

function attachAgentSocket(socket: Bun.ServerWebSocket<AgentSocketData>): void {
	socket.data = { kind: "agent", id: randomUUID(), authed: false };
}

function parseSocketMessage<T>(data: string | Uint8Array): T | undefined {
	const text = typeof data === "string" ? data : decoder.decode(data);
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

async function handleClientMessage(socket: Bun.ServerWebSocket<ClientSocketData>, message: ClientToServerMessage): Promise<void> {
	if (message.type === "client.hello" || message.type === "client.command_hello") {
		socket.data.authed = true;
		if (message.type === "client.hello") {
			connectedClientSockets.add(socket);
			sendSessionSnapshot(socket);
		}
		return;
	}
	if (!socket.data.authed) throw new Error("Client must send a hello message first");
	if (shutdownStarted && shouldRejectDuringShutdown(message)) {
		throw new Error("Pi Web is waiting for active sessions to finish before restarting");
	}
	if (message.type === "client.subscribe") {
		const record = sessions.get(message.sessionId) ?? (() => {
			const scan = scanSavedSessions(sessionsDir).find((item) => item.session.id === message.sessionId || (item.file && normalizePath(item.file) === normalizePath(message.sessionId)));
			if (!scan) return undefined;
			return upsertSession(scan.session, "saved", scan.history, scan.managedWorktreeScanned);
		})();
		if (!record) throw new Error(`Unknown session: ${message.sessionId}`);
		const previousSessionId = socket.data.sessionId;
		if (previousSessionId && previousSessionId !== record.id) {
			sessions.get(previousSessionId)?.clientSockets.delete(socket);
		}
		record.clientSockets.add(socket);
		socket.data.sessionId = record.id;
		sendSessionState(socket, record);
		sendSessionHistory(socket, record);
		return;
	}
	if (message.type === "client.sync_queue") {
		const record = sessions.get(message.sessionId);
		if (!record) throw new Error(`Unknown session: ${message.sessionId}`);
		const update = webQueueEvent(record);
		socket.send(JSON.stringify({ ...update, event: { ...update.event, syncRequestId: message.requestId } }));
		return;
	}
	if (message.type === "client.prompt") {
		const record = sessions.get(message.sessionId);
		try {
			if (!record) throw new Error(`Unknown session: ${message.sessionId}`);
			const normalizedPrompt = message.message.trim();
			const reload = isWebReloadCommand(normalizedPrompt);
			const compact = parseWebCompactCommand(normalizedPrompt);
			const worktree = parseWorktreeInvocation(message.message);
			let responseData: unknown;
			if (reload) {
				if (message.images?.length) throw new Error("/reload does not accept image attachments");
				if (message.streamingBehavior === "followUp" && (record.status === "working" || hasActiveWebSubagents(record.subagents))) {
					await enqueueWebFollowUp(record, { id: message.requestId, message: message.message });
				} else {
					if (message.streamingBehavior === "steer") throw new Error("/reload must be queued or run while Pi is idle");
					responseData = await routeCommand(record, { type: "reload" });
					broadcastReloadComplete(record);
				}
			} else if (compact) {
				if (message.images?.length) throw new Error("/compact does not accept image attachments");
				if (message.streamingBehavior === "followUp" && (record.status === "working" || hasActiveWebSubagents(record.subagents))) {
					await enqueueWebFollowUp(record, { id: message.requestId, message: message.message });
				} else {
					if (message.streamingBehavior === "steer") throw new Error("/compact must be queued or run while Pi is idle");
					responseData = await routeCommand(record, { type: "compact", customInstructions: compact.customInstructions });
				}
			} else if (worktree) {
				if (message.images?.length) throw new Error("/worktree does not accept image attachments");
				if (message.streamingBehavior) throw new Error("/worktree must be run while Pi is idle");
				if (!worktree.name && !worktree.existing) {
					throw new Error(WORKTREE_USAGE);
				}
				responseData = await routeCommand(record, worktree.existing
					? { type: "create_worktree", existing: worktree.existing }
					: {
						type: "create_worktree",
						name: worktree.name!,
						repository: worktree.repository ?? record.cwd,
						branch: worktree.branch,
						startPoint: worktree.startPoint,
					});
			} else if (message.streamingBehavior === "followUp" && record.status === "working") {
				await enqueueWebFollowUp(record, { id: message.requestId, message: message.message, images: message.images });
			} else {
				await routeCommand(record, {
					type: "prompt",
					message: message.message,
					images: message.images,
					streamingBehavior: message.streamingBehavior,
				});
			}
			socket.send(JSON.stringify({
				type: "server.response",
				requestId: message.requestId,
				success: true,
				data: responseData,
			} satisfies ServerResponseMessage));
		} catch (error) {
			socket.send(JSON.stringify({
				type: "server.response",
				requestId: message.requestId,
				success: false,
				error: error instanceof Error ? error.message : String(error),
			} satisfies ServerResponseMessage));
		}
		return;
	}
	if (message.type === "client.command") {
		const record = sessions.get(message.sessionId) ?? sessionsByFile.get(normalizePath(message.sessionId));
		if (!record) {
			socket.send(JSON.stringify({ type: "server.response", requestId: message.requestId, success: false, error: `Unknown session: ${message.sessionId}` } satisfies ServerResponseMessage));
			return;
		}
		try {
			const previousSessionId = record.id;
			const data = await routeCommand(record, message.command);
			if (message.command.type !== "abort") await refreshManagedSession(record);
			const responseData = record.id !== previousSessionId && (message.command.type === "clone" || message.command.type === "fork" || message.command.type === "create_worktree" || message.command.type === "create_worktree_v2")
				? { ...(isRecord(data) ? data : {}), cancelled: isRecord(data) && data.cancelled === true, sessionId: record.id }
				: data;
			socket.send(JSON.stringify({ type: "server.response", requestId: message.requestId, success: true, data: responseData } satisfies ServerResponseMessage));
		} catch (error) {
			socket.send(JSON.stringify({ type: "server.response", requestId: message.requestId, success: false, error: error instanceof Error ? error.message : String(error) } satisfies ServerResponseMessage));
		}
	}
}

async function routeCommand(record: SessionRecord, command: ClientCommandMessage["command"]): Promise<unknown> {
	const changesManagedIdentity = Boolean(record.managed) && (
		command.type === "clone" || command.type === "fork" || command.type === "create_worktree" || command.type === "create_worktree_v2"
	);
	if (changesManagedIdentity) {
		if (record.managedIdentityOperation) throw new Error(`Another session replacement is already in progress (${record.managedIdentityOperation})`);
		record.managedIdentityOperation = command.type;
		try {
			return await routeCommandCore(record, command);
		} finally {
			record.managedIdentityOperation = undefined;
		}
	}
	if (command.type !== "prompt") return await routeCommandCore(record, command);

	const shouldMarkWorking = record.status !== "working" || record.agentRunning !== true;
	const previousStatus = record.status;
	const previousAgentRunning = record.agentRunning;
	const previousActivityGeneration = record.activityGeneration;
	const agentStartGeneration = record.agentStartGeneration ?? 0;
	if (shouldMarkWorking) {
		markAgentActivity(record);
		cancelQueueSettleFallback(record);
		record.status = "working";
		record.agentRunning = true;
		record.updatedAt = Date.now();
		broadcast(record.id, { type: "server.session", session: sessionToClientPayload(record) } satisfies ServerSessionMessage);
	}
	try {
		return await routeCommandCore(record, command);
	} catch (error) {
		if (shouldMarkWorking && (record.agentStartGeneration ?? 0) === agentStartGeneration) {
			record.status = previousStatus;
			record.agentRunning = previousAgentRunning;
			record.activityGeneration = previousActivityGeneration;
			broadcast(record.id, { type: "server.session", session: sessionToClientPayload(record) } satisfies ServerSessionMessage);
			if (record.status === "idle" && record.agentRunning !== true && record.queue.length > 0) {
				scheduleQueueSettleFallback(record);
			}
		}
		throw error;
	}
}

async function routeCommandCore(record: SessionRecord, command: ClientCommandMessage["command"]): Promise<unknown> {
	if (command.type === "create_worktree" || command.type === "create_worktree_v2") {
		const value = command as unknown as Record<string, unknown>;
		if ("existing" in value) {
			if (typeof value.existing !== "string" || !value.existing.trim()) throw new Error("create_worktree existing path is required");
			if (["name", "repository", "branch", "startPoint"].some((key) => value[key] !== undefined)) {
				throw new Error("create_worktree existing mode cannot include create-mode fields");
			}
		} else {
			if (typeof value.name !== "string" || !value.name.trim()) throw new Error("create_worktree name is required");
			if (typeof value.repository !== "string" || !value.repository.trim()) throw new Error("create_worktree repository is required");
			if (value.branch !== undefined && (typeof value.branch !== "string" || !value.branch.trim())) throw new Error("create_worktree branch must be a non-empty string");
			if (value.startPoint !== undefined && (typeof value.startPoint !== "string" || !value.startPoint.trim())) throw new Error("create_worktree startPoint must be a non-empty string");
		}
	}
	if (command.type === "steer_queue_item" || command.type === "replace_queue" || command.type === "reconcile_queue") {
		return await routeQueueCommand(record, command);
	}
	if (command.type === "reload" && record.managed) {
		const settled = (record.status === "idle" || record.status === "error") && record.agentRunning !== true;
		if (!settled || hasActiveWebSubagents(record.subagents)) throw new Error("Wait for Pi and its subagents to become idle before reloading");
		await record.managed.reload();
		await refreshManagedSession(record);
		record.status = "idle";
		broadcast(record.id, { type: "server.session", session: sessionToClientPayload(record) } satisfies ServerSessionMessage);
		slashCommands.invalidate(record.cwd);
		return { reloaded: true };
	}
	if (command.type === "reload" && hasActiveWebSubagents(record.subagents)) {
		throw new Error("Wait for Pi and its subagents to become idle before reloading");
	}
	if (command.type === "reload" && record.agentSockets.size === 0) {
		throw new Error(`Session ${record.id} is not active`);
	}
	if (command.type === "get_commands") {
		if (record.managed) {
			const { commands } = await record.managed.getCommands();
			return { commands: slashCommands.toWeb(slashCommands.parse(commands), true) };
		}
		return { commands: slashCommands.toWeb(await slashCommands.discover(record.cwd)) };
	}
	if ((command.type === "create_worktree" || command.type === "create_worktree_v2") && hasActiveWebSubagents(record.subagents)) {
		throw new Error("Wait for Pi and its subagents to become idle before creating a worktree");
	}
	if ((command.type === "create_worktree" || command.type === "create_worktree_v2") && record.managed) {
		if (record.status !== "idle") throw new Error("Wait for Pi to become idle before creating a worktree");
		const previousId = record.id;
		const previousFile = record.file ? canonicalSessionFile(record.file) : undefined;
		if (!previousFile) throw new Error("The current conversation is not persisted yet");
		const previousManagedWorktree = record.managedWorktree ?? managedWorktreeFromEntries(parseSessionFile(previousFile)?.entries ?? []);
		record.pendingWorktreeSourceDeletion = { sessionId: previousId, sessionFile: previousFile };
		const invocation = "existing" in command
			? `/worktree --existing ${JSON.stringify(command.existing)}`
			: `/worktree ${formatWorktreeCreateCommandArgs(command)}`;
		try {
			await record.managed.worktree(invocation);
			await refreshManagedSession(record);
			if (record.id === previousId) throw new Error("Pi did not switch to the worktree session");
			if (existsSync(previousFile)) throw new Error(`Source session was not deleted after replacement: ${previousFile}`);
		} catch (error) {
			if (record.id === previousId) record.pendingWorktreeSourceDeletion = undefined;
			throw error;
		}
		if (previousManagedWorktree && !hasOtherSessionInWorktree(sessionsDir, previousFile, previousManagedWorktree.path)) {
			try {
				const cleanup = removeManagedWorktree(previousManagedWorktree);
				if (cleanup.branchWarning) console.warn(`Removed previous worktree ${previousManagedWorktree.path}, but could not delete branch ${previousManagedWorktree.branch}: ${cleanup.branchWarning}`);
			} catch (error) {
				console.warn(`Source session was deleted, but previous managed worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		await hydrateGitMetadata(record);
		return { cancelled: false, sessionId: record.id, path: record.cwd, branch: record.branch };
	}
	if ((command.type === "create_worktree" || command.type === "create_worktree_v2") && record.agentSockets.size === 0) {
		throw new Error(`Session ${record.id} is not active`);
	}
	if (record.managed) {
		switch (command.type) {
			case "get_session_options": {
				const [{ models }, { levels }, { commands }] = await Promise.all([
					record.managed.getAvailableModels(),
					record.managed.getAvailableThinkingLevels(),
					record.managed.getCommands(),
				]);
				const webCommands = commands.flatMap((command) => {
					const sourceInfo = isRecord(command.sourceInfo) ? command.sourceInfo : undefined;
					if (typeof command.name !== "string" || command.name === "web-reload" || (command.source !== "extension" && command.source !== "prompt" && command.source !== "skill")) return [];
					return [{
						name: command.name,
						description: typeof command.description === "string" ? command.description : undefined,
						source: command.source,
						location: sourceInfo && (sourceInfo.scope === "user" || sourceInfo.scope === "project" || sourceInfo.scope === "temporary") ? sourceInfo.scope : undefined,
					}];
				});
				if (!webCommands.some((command) => command.name === "reload")) {
					webCommands.unshift({ name: "reload", description: "Reload extensions, skills, prompts, themes, and context files", source: "extension", location: "temporary" });
				}
				return {
					models: models.map((model) => ({
						provider: String(model.provider ?? ""), id: String(model.id ?? ""),
						name: String(model.name ?? model.id ?? ""), reasoning: model.reasoning === true,
						thinkingLevels: levels,
					})),
					thinkingLevels: levels,
					commands: webCommands,
				};
			}
			case "set_model":
				await record.managed.setModel(command.provider, command.modelId);
				await refreshManagedSession(record);
				return;
			case "set_thinking_level":
				await record.managed.setThinkingLevel(command.level);
				await refreshManagedSession(record);
				return;
			case "prompt":
				return await record.managed.prompt(command.message, command.streamingBehavior, command.images);
			case "abort":
				// Stop is accepted once its RPC request is written. Do not hold the web
				// response open while compaction and subagent teardown finish.
				await record.managed.abort();
				return { accepted: true };
			case "bash":
				return await record.managed.bash(command.command);
			case "clone": {
				const result = await record.managed.clone();
				await refreshManagedSession(record);
				return result;
			}
			case "fork": {
				const result = await record.managed.fork(command.entryId);
				await refreshManagedSession(record);
				return result;
			}
			case "get_fork_messages":
				return await record.managed.getForkMessages();
			case "set_session_name":
				await record.managed.setSessionName(command.name);
				return undefined;
			case "compact":
				return await record.managed.compact(command.customInstructions);
			case "extension_ui_response":
				return await record.managed.respondToExtensionUi(command);
		}
	}
	if (record.agentSockets.size > 0) {
		let externalCommand: ClientCommandMessage["command"] = command;
		if (command.type === "create_worktree" && !("existing" in command) && (command.branch || command.startPoint)) {
			externalCommand = { ...command, type: "create_worktree_v2" };
		}
		if (command.type === "prompt" && command.message.startsWith("/")) {
			const commands = await slashCommands.discover(record.cwd);
			externalCommand = {
				...command,
				message: await expandSlashCommand(commands, command.message, { rejectExtensionCommands: true }),
			};
		}
		const target = Array.from(record.agentSockets)[0];
		const requestId = randomUUID();
		if (command.type === "abort") {
			// Socket delivery is the acknowledgement boundary. New bridges also reply
			// before teardown, but this keeps Stop responsive with older bridges.
			target.send(JSON.stringify({ type: "agent.command", requestId, command: externalCommand } satisfies { type: "agent.command"; requestId: string; command: ClientCommandMessage["command"] }));
			return { accepted: true };
		}
		const data = await new Promise<unknown>((resolve, reject) => {
			const timeoutMs = command.type === "compact" || command.type === "bash" || command.type === "create_worktree" || command.type === "create_worktree_v2" || command.type === "reload"
				? LONG_RUNNING_COMMAND_TIMEOUT_MS
				: 30_000;
			let pendingRequest: ExternalPendingRequest;
			const timeout = setTimeout(() => {
				const owner = pendingRequest.owner ?? record;
				owner.externalPending.delete(requestId);
				owner.externalRequestTargets.delete(requestId);
				const message = "Pi session command timed out";
				reject(isUncertainRpcDeliveryCommand(command.type) ? new CommandDeliveryUncertainError(message) : new Error(message));
			}, timeoutMs);
			pendingRequest = {
				owner: record,
				surviveDisconnect: command.type === "reload" || command.type === "create_worktree" || command.type === "create_worktree_v2",
				commandType: command.type,
				resolve: (value) => {
					clearTimeout(timeout);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			};
			record.externalPending.set(requestId, pendingRequest);
			record.externalRequestTargets.set(requestId, target);
			try {
				target.send(JSON.stringify({ type: "agent.command", requestId, command: externalCommand } satisfies { type: "agent.command"; requestId: string; command: ClientCommandMessage["command"] }));
			} catch (error) {
				record.externalPending.delete(requestId);
				record.externalRequestTargets.delete(requestId);
				clearTimeout(timeout);
				const cause = error instanceof Error ? error : new Error(String(error));
				reject(isUncertainRpcDeliveryCommand(command.type) ? new CommandDeliveryUncertainError(cause.message) : cause);
			}
		});
		if (command.type === "get_session_options") {
			const options = isRecord(data) ? data : {};
			if (Array.isArray(options.commands)) return options;
			return { ...options, commands: slashCommands.toWeb(await slashCommands.discover(record.cwd)) };
		}
		if (command.type === "reload") slashCommands.invalidate(record.cwd);
		return data;
	}
	if (command.type === "get_fork_messages") return await runRpcSessionCommand(record, command);
	if (command.type === "clone" || command.type === "fork" || command.type === "set_session_name" || command.type === "compact") {
		if (!record.file) throw new Error(`Session ${record.id} is not active`);
		return await runRpcSessionCommand(record, command as RpcSessionCommand);
	}
	throw new Error(`Session ${record.id} does not support command ${command.type}`);
}

async function handleAgentMessage(socket: Bun.ServerWebSocket<AgentSocketData>, message: AgentToServerMessage): Promise<void> {
	if (message.type === "agent.hello") {
		socket.data.authed = true;
		const hello = message as AgentHelloMessage;
		const kind: SessionKind = hello.session.source === "saved"
			? "saved"
			: hello.session.source === "web"
				? "managed"
				: "external";
		const helloManagedWorktree = hello.session.managedWorktree ?? managedWorktreeFromEntries(hello.entries ?? []);
		const helloHistory = boundedWebHistory(hello.entries ?? []);
		const authoritativeHistory = hello.historyMode === "replace" || helloHistory.length > 0;
		const record = upsertSession(hello.session, kind, authoritativeHistory ? helloHistory : []);
		if (authoritativeHistory) replaceRecordHistory(record, helloHistory);
		else if (!record.historyReady && record.file) {
			// Bridges loaded before historyMode existed reconnect with an empty hello.
			// Restore a bounded disk suffix without hydrating the full JSONL archive.
			replaceRecordHistory(record, parseSessionHistoryFile(record.file));
		}
		record.preview = extractPreviewFromHistory(record.history) ?? record.preview;
		record.managedWorktree = helloManagedWorktree ?? record.managedWorktree;
		record.agentSockets.add(socket);
		record.active = true;
		record.status = hello.session.status;
		record.agentRunning = hello.session.status === "working";
		record.updatedAt = hello.session.updatedAt;
		for (const uncertain of record.queue.filter((item) => item.deliveryState === "delivering")) {
			broadcastQueueDelivery(
				record,
				uncertain,
				"uncertain",
				"Delivery was interrupted by a daemon restart; edit or remove this item explicitly before resubmitting.",
			);
		}
		if (record.file) sessionsByFile.set(normalizePath(record.file), record);
		broadcastSessionToAll(record);
		void hydrateGitMetadata(record);
		// Native sessions use the same bounded semantic history as managed sessions;
		// no browser connection asks Pi to paint an additional TUI viewport.
		broadcast(record.id, { type: "server.history", sessionId: record.id, entries: record.history, replace: true } satisfies ServerHistoryMessage);
		void flushWebQueue(record);
		return;
	}
	if (!socket.data.authed) throw new Error("Agent must send agent.hello first");
	if (message.type === "agent.history") {
		const update = message as AgentHistoryMessage;
		const record = sessions.get(update.sessionId);
		if (!record || !record.agentSockets.has(socket)) return;
		replaceRecordHistory(record, update.entries);
		broadcast(record.id, { type: "server.history", sessionId: record.id, entries: record.history, replace: true } satisfies ServerHistoryMessage);
		return;
	}
	if (message.type === "agent.session_replaced") {
		await completeExternalSessionReplacement(socket, message as AgentSessionReplacedMessage);
		return;
	}
	if (message.type === "agent.event") {
		const event = message as AgentEventMessage;
		const record = sessions.get(event.sessionId);
		if (record) {
			record.updatedAt = Date.now();
			let lifecycleChanged = false;
			if (event.event.type === "agent_start" || event.event.type === "turn_start") {
				record.agentStartGeneration = (record.agentStartGeneration ?? 0) + 1;
				markAgentActivity(record);
			}
			if (event.event.type === "agent_start" || event.event.type === "turn_start") {
				cancelQueueSettleFallback(record);
				record.status = "working";
				record.agentRunning = true;
				lifecycleChanged = true;
			}
			if (event.event.type === "agent_end" && !record.compaction) {
				markAgentSettling(record);
				record.status = agentEndTerminalNotice(event.event)?.kind === "error" ? "error" : "idle";
				record.agentRunning = false;
				scheduleQueueSettleFallback(record);
				lifecycleChanged = true;
			}
			if (event.event.type === "compaction_start") {
				markAgentSettling(record);
				record.status = "working";
				record.agentRunning = true;
				record.compaction = {
					reason: event.event.reason === "manual" || event.event.reason === "overflow" ? event.event.reason : "threshold",
					startedAt: typeof event.event.startedAt === "number" ? event.event.startedAt : Date.now(),
				};
			}
			if (event.event.type === "compaction_end") {
				record.compaction = undefined;
				if (event.event.aborted === true || event.event.willRetry === false) {
					record.status = "idle";
					record.agentRunning = false;
					scheduleQueueSettleFallback(record);
					lifecycleChanged = true;
				}
			}
			if (event.event.type === "agent_settled" && isCurrentAgentSettlement(record)) {
				cancelQueueSettleFallback(record);
				record.settlingGeneration = undefined;
				lifecycleChanged = true;
				// Pi emits agent_settled only when no retry, compaction, or internal
				// follow-up remains. It is authoritative even when an interrupted
				// overflow compaction last advertised willRetry=true.
				if (record.status !== "error") record.status = "idle";
				record.agentRunning = false;
				void flushWebQueue(record);
			}
			const subagentsChanged = updateSubagentsFromToolEvent(record, event.event);
			let sessionMetadataChanged = false;
			if (event.event.type === "session_info_changed") {
				record.name = typeof event.event.name === "string" && event.event.name ? event.event.name : undefined;
				sessionMetadataChanged = true;
			}
			if (event.event.type === "message_end" && isRecord(event.event.message)) {
				appendRecordHistory(record, {
					type: "message",
					id: randomUUID(),
					parentId: null,
					timestamp: new Date().toISOString(),
					message: event.event.message,
				});
				record.messageCount += 1;
				if (event.event.message.role === "assistant" || event.event.message.role === "toolResult") {
					record.usage ??= zeroWebUsage();
					addWebUsage(record.usage, event.event.message.usage);
				}
				if (event.event.message.role === "user" || event.event.message.role === "assistant") {
					const preview = extractTextContent(event.event.message.content);
					const terminalNotice = assistantTerminalNotice(event.event.message);
					if (preview) record.preview = preview.slice(0, 180);
					else if (terminalNotice) record.preview = `${terminalNotice.title}: ${terminalNotice.detail}`.slice(0, 180);
				}
				sessionMetadataChanged = true;
			}
			broadcast(event.sessionId, { type: "server.event", sessionId: event.sessionId, event: event.event } satisfies ServerEventMessage);
			if (sessionMetadataChanged || lifecycleChanged || event.event.type === "compaction_start" || event.event.type === "compaction_end") {
				broadcastSessionToAll(record);
			} else if (subagentsChanged) {
				broadcast(record.id, { type: "server.session", session: sessionToClientPayload(record) } satisfies ServerSessionMessage);
			}
		}
		return;
	}
	if (message.type === "agent.subagents") {
		const update = message as AgentSubagentsMessage;
		const record = sessions.get(update.sessionId);
		if (!record) return;
		record.subagents = mergeWebSubagentUpdates(record.subagents, update.agents);
		record.subagentUsage = update.usage;
		record.updatedAt = Date.now();
		broadcast(record.id, {
			type: "server.event",
			sessionId: record.id,
			event: { type: "subagents_update", agents: update.agents, usage: update.usage },
		} satisfies ServerEventMessage);
		if (record.status === "idle" && !hasActiveWebSubagents(record.subagents) && record.queue.length > 0) void flushWebQueue(record);
		return;
	}
	if (message.type === "agent.update") {
		const update = message as AgentUpdateMessage;
		const existing = sessions.get(update.session.id);
		// Older bridge runtimes reported `working` again immediately after their
		// authoritative agent_end event. Preserve the lifecycle event until a new
		// agent_start arrives so completed runs cannot get stuck visually working.
		const lifecycleSession = normalizeLegacySessionUpdate(existing, update.session);
		// Older native bridges keep reporting their initial preview. Preserve
		// message_end/file-derived metadata after hello during rolling upgrades.
		const session = existing ? { ...lifecycleSession, preview: existing.preview } : lifecycleSession;
		const catalogChanged = catalogSessionChanged(existing, session);
		const gitContextChanged = existing?.cwd !== session.cwd || existing?.branch !== session.branch;
		const record = upsertSession(session, "external", existing?.history ?? []);
		record.agentSockets.add(socket);
		record.updatedAt = update.session.updatedAt;
		if (catalogChanged) broadcastSessionToAll(record);
		else broadcast(update.session.id, { type: "server.session", session: sessionToClientPayload(record) } satisfies ServerSessionMessage);
		if (gitContextChanged) void hydrateGitMetadata(record);
		return;
	}
	if (message.type === "agent.response") {
		const response = message as AgentResponseMessage;
		const record = Array.from(sessions.values()).find((candidate) => candidate.externalPending.has(response.requestId));
		if (!record) return;
		const pending = record.externalPending.get(response.requestId);
		if (!pending) return;
		record.externalPending.delete(response.requestId);
		record.externalRequestTargets.delete(response.requestId);
		if (response.success) pending.resolve(response.data);
		else pending.reject(new CommandRejectedError(response.error ?? "Agent command failed"));
	}
}

async function deleteSessionRecord(
	record: SessionRecord,
	file?: string,
	shouldCommit: () => boolean = () => true,
): Promise<boolean> {
	const finishQueueQuiescence = preserveRetryAroundQuiescence({
		isArmed: () => record.queueRetryTimer !== undefined,
		cancel: () => {
			if (record.queueRetryTimer) clearTimeout(record.queueRetryTimer);
			record.queueRetryTimer = undefined;
		},
		reopen: () => { record.queueMutationsQuiesced = false; },
		resume: () => scheduleWebQueueRetry(record),
	});
	try {
		await quiesceQueueMutations(record);
		if (record.queueDirtyWorker) {
			await record.queueDirtyWorker.cancelAndDrain();
			record.queueDirtyWorker = undefined;
		}
		if (!shouldCommit()) {
			finishQueueQuiescence();
			return false;
		}
		// Make queue removal durable before deleting the file, maps, or sockets.
		// A failed store write leaves the complete session available for retry.
		await queueStoreWriter.mutate(persistedQueues, (queues) => { queues.delete(record.id); });
	} catch (error) {
		finishQueueQuiescence();
		throw error;
	}

	// Queue persistence yields to the event loop. If an agent reconnected while it
	// was in flight, restore its queue instead of deleting the newly live record.
	if (!shouldCommit()) {
		// The durable delete completed, but the record became live again. Restore
		// its retained queue through the retrying worker so a transient rollback
		// write failure cannot leave an active session with no durable snapshot.
		markWebQueueSnapshotDirty(record);
		finishQueueQuiescence();
		return false;
	}

	if (file) {
		try {
			rmSync(file, { force: true });
		} catch (error) {
			// Restore a non-empty queue before making the failed deletion usable again.
			let restoreError: unknown;
			try {
				await persistWebQueue(record);
			} catch (cause) {
				restoreError = cause;
			}
			finishQueueQuiescence();
			const message = error instanceof Error ? error.message : String(error);
			if (restoreError) {
				throw new Error(`Failed to delete session file: ${message}; queue rollback failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
			}
			throw new Error(`Failed to delete session file: ${message}`);
		}
	}

	cancelWebQueueWork(record);
	sessions.delete(record.id);
	if (record.file) sessionsByFile.delete(normalizePath(record.file));
	// Notify sockets subscribed only to the removed session; once the record leaves
	// the maps, a catalog-wide broadcast cannot find them. Keep browser sockets open
	// so they can subscribe to a surviving session without reconnecting.
	sendSessionRemoved(record.id, undefined, record.clientSockets);
	for (const socket of record.clientSockets) socket.data.sessionId = undefined;
	record.clientSockets.clear();
	for (const socket of record.agentSockets) {
		try {
			socket.close();
		} catch {
			// ignore
		}
	}
	return true;
}

async function stopRecord(record: SessionRecord): Promise<void> {
	if (record.managed) {
		await record.managed.shutdown();
		record.managed = undefined;
	}
	record.active = false;
	record.status = "offline";
}

function hasStagedOrDurableReplacement(record: SessionRecord): boolean {
	const sourceFile = record.file;
	if (!sourceFile) return false;
	try {
		const sourceName = basename(sourceFile);
		if (readdirSync(dirname(sourceFile)).some((entry) =>
			entry.startsWith(`${sourceName}.replaced-`) && entry.endsWith(".tmp")
		)) return true;
	} catch {
		// The containing session directory may itself have been removed.
	}
	for (const scan of scanSavedSessions(sessionsDir)) {
		if (sessionFileKey(scan.file) === sessionFileKey(sourceFile)) continue;
		const replacement = scan.replacement;
		if (
			replacement?.previousSessionId === record.id &&
			sessionFileKey(replacement.previousSessionFile) === sessionFileKey(sourceFile)
		) return true;
	}
	return false;
}

function isMissingInactiveSession(record: SessionRecord): boolean {
	return Boolean(
		record.file &&
		!record.active &&
		!record.managed &&
		record.agentSockets.size === 0 &&
		isConfirmedMissingPath(record.file) &&
		!hasStagedOrDurableReplacement(record),
	);
}

async function reconcileMissingSessionFiles(): Promise<void> {
	if (shutdownStarted) return;
	const candidates = [...sessions.values()].filter((record) =>
		!missingSessionReconciliations.has(record) && isMissingInactiveSession(record)
	);
	await Promise.all(candidates.map(async (record) => {
		missingSessionReconciliations.add(record);
		const sessionFile = record.file;
		try {
			if (
				!sessionFile ||
				sessions.get(record.id) !== record ||
				!isMissingInactiveSession(record)
			) return;
			const managed = isManagedSessionFile(sessionFile);
			let managedWorktree = record.managedWorktree;
			if (managedWorktree && hasOtherSessionInWorktree(sessionsDir, sessionFile, managedWorktree.path)) {
				managedWorktree = undefined;
			}
			const deleted = await deleteSessionRecord(record, undefined, () =>
				sessions.get(record.id) === record && isMissingInactiveSession(record)
			);
			if (!deleted) return;
			if (managed) {
				try { deleteManagedSessionFile(sessionFile); } catch (error) {
					console.warn(`Externally deleted session ${record.id} was removed from Pi web, but managed ownership cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (
				managedWorktree &&
				existsSync(managedWorktree.path) &&
				!hasOtherSessionInWorktree(sessionsDir, sessionFile, managedWorktree.path)
			) {
				try {
					const result = removeManagedWorktree(managedWorktree);
					if (result.branchWarning) console.warn(`Removed externally deleted session worktree ${managedWorktree.path}, but could not delete branch ${managedWorktree.branch}: ${result.branchWarning}`);
				} catch (error) {
					console.warn(`Externally deleted session ${record.id} was removed from Pi web, but managed worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		} catch (error) {
			console.warn(`Could not remove externally deleted session ${record.id} from Pi web: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			missingSessionReconciliations.delete(record);
		}
	}));
}

function scheduleManagedWorktreeCleanup(sessionId: string, sessionFile: string, managedWorktree: NonNullable<SessionRecord["managedWorktree"]>): void {
	const timer = setTimeout(() => {
		void (async () => {
			// A new session may claim this checkout after durable deletion yields.
			if (hasOtherSessionInWorktree(sessionsDir, sessionFile, managedWorktree.path)) return;
			try {
				const result = await removeManagedWorktreeAsync(managedWorktree);
				if (result.branchWarning) console.warn(`Removed worktree ${managedWorktree.path}, but could not delete branch ${managedWorktree.branch}: ${result.branchWarning}`);
			} catch (error) {
				console.warn(`Session ${sessionId} was deleted, but managed worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		})();
	}, 0);
	timer.unref?.();
}

async function deleteSession(sessionId: string): Promise<void> {
	let record = sessions.get(sessionId) ?? sessionsByFile.get(normalizePath(sessionId)) ?? (() => {
		const scan = scanSavedSessions(sessionsDir).find((item) => item.session.id === sessionId || normalizePath(item.file) === normalizePath(sessionId));
		return scan ? upsertSession(scan.session, "saved", scan.history, scan.managedWorktreeScanned) : undefined;
	})();
	if (!record) throw new Error(`Unknown session: ${sessionId}`);
	if (record.file) {
		const pendingStart = managedSessionStarts.get(sessionFileKey(record.file));
		if (pendingStart) {
			await pendingStart.catch(() => undefined);
			record = sessions.get(sessionId) ?? sessionsByFile.get(sessionFileKey(record.file)) ?? record;
		}
	}
	const sessionFile = record.file;
	let managedWorktree = record.managedWorktree;
	if (!managedWorktree && sessionFile && !record.managedWorktreeScanned) {
		managedWorktree = readManagedWorktreePrefix(sessionFile);
		record.managedWorktreeScanned = true;
	}
	if (managedWorktree && sessionFile && hasOtherSessionInWorktree(sessionsDir, sessionFile, managedWorktree.path)) {
		managedWorktree = undefined;
	}
	if (record.kind === "external" && record.agentSockets.size > 0) {
		if (record.status === "working") throw new Error("Abort or wait for the active session before deleting it");
		await routeCommand(record, { type: "shutdown" });
		const deadline = Date.now() + 3_000;
		while (record.agentSockets.size > 0 && Date.now() < deadline) await Bun.sleep(50);
		if (record.agentSockets.size > 0) throw new Error("The active Pi process did not shut down in time");
	}
	await stopRecord(record);
	let file: string | undefined;
	if (record.file) {
		try {
			file = canonicalSessionFile(record.file);
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
				throw new Error(`Refusing to delete unsafe session path: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	await deleteSessionRecord(record, file);
	if (sessionFile && isManagedSessionFile(sessionFile)) {
		try {
			deleteManagedSessionFile(sessionFile);
		} catch (error) {
			console.warn(`Session ${sessionId} was deleted, but managed ownership cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	// Native shutdown and durable queue deletion may yield long enough for another
	// Pi process to create a session in this checkout. Ownership can only be
	// revoked here; never enable cleanup that was not part of the original request.
	if (managedWorktree && sessionFile && hasOtherSessionInWorktree(sessionsDir, sessionFile, managedWorktree.path)) {
		managedWorktree = undefined;
	}
	// Durable deletion and client notification are complete before best-effort
	// worktree cleanup. Run slow checkout removal outside the HTTP request so a
	// reverse proxy cannot report a false failure after the session is gone.
	if (managedWorktree && sessionFile) scheduleManagedWorktreeCleanup(sessionId, sessionFile, managedWorktree);
}

async function handleApi(request: Request): Promise<Response> {
	const url = new URL(request.url);
	if (
		url.pathname.startsWith("/api/") &&
		request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS" &&
		!isTrustedBrowserOrigin(request, tailscaleStatus.published ? tailscaleStatus.url : undefined)
	) {
		return textResponse("Forbidden origin", { status: 403 });
	}
	if (request.method === "GET" && url.pathname === "/api/health") {
		return jsonResponse({
			ok: true,
			pid: process.pid,
			port,
			stateFile: stateFilePath,
			capabilities: { commandHello: true, queueSteer: true, worktreeRefs: true },
			tailscale: tailscaleStatus,
		});
	}
	if (request.method === "POST" && url.pathname === "/api/tailscale") {
		const body = await request.json().catch(() => undefined) as { enabled?: unknown; httpsPort?: unknown; serviceName?: unknown; current?: unknown } | undefined;
		if (!body || typeof body.enabled !== "boolean") return badRequest("Missing enabled boolean");
		const persisted = await readTailscaleWebSettings(settingsPath);
		const suppliedCurrent = isRecord(body.current) ? body.current : undefined;
		const current: TailscaleWebSettings = suppliedCurrent && typeof suppliedCurrent.enabled === "boolean"
			? {
				enabled: suppliedCurrent.enabled,
				httpsPort: typeof suppliedCurrent.httpsPort === "number" && Number.isInteger(suppliedCurrent.httpsPort) && suppliedCurrent.httpsPort >= 1 && suppliedCurrent.httpsPort <= 65_535
					? suppliedCurrent.httpsPort
					: persisted.httpsPort,
				// The persisted route identity is authoritative; a browser may report
				// the previously applied port, but cannot select another Service to remove.
				serviceName: persisted.serviceName,
			}
			: persisted;
		const settings: TailscaleWebSettings = {
			enabled: body.enabled,
			httpsPort: typeof body.httpsPort === "number" && Number.isInteger(body.httpsPort) && body.httpsPort >= 1 && body.httpsPort <= 65_535
				? body.httpsPort
				: persisted.httpsPort,
			serviceName: typeof body.serviceName === "string"
				? body.serviceName.trim().replace(/^svc:/, "") || undefined
				: persisted.serviceName,
		};
		const status = settings.enabled
			? await configureTailscaleServe(settings, current)
			: await removeTailscaleServe(current);
		return jsonResponse({ tailscale: status });
	}
	if (request.method === "GET" && url.pathname === "/api/sessions") {
		await reconcileMissingSessionFiles();
		const scans = scanSavedSessions(sessionsDir, activeSessionFiles());
		for (const scan of scans) {
			const existing = sessions.get(scan.session.id) ?? sessionsByFile.get(normalizePath(scan.file));
			if (!existing || !existing.active || existing.status === "offline") {
				upsertSession(scan.session, "saved", scan.history, scan.managedWorktreeScanned);
			}
		}
		const merged = new Map<string, WebSession>();
		for (const scan of scans) {
			const live = sessions.get(scan.session.id) ?? sessionsByFile.get(normalizePath(scan.file));
			if (live?.catalogReady === false) continue;
			merged.set(scan.session.file ? normalizePath(scan.session.file) : scan.session.id, sessionToClientPayload(scan.session));
		}
		for (const item of sessions.values()) {
			if (item.catalogReady === false || isMissingInactiveSession(item)) continue;
			merged.set(item.file ? normalizePath(item.file) : item.id, sessionToClientPayload(item));
		}
		return jsonResponse({ sessions: sortSessions(Array.from(merged.values())) });
	}
	if (request.method === "POST" && url.pathname === "/api/sessions") {
		const body = (await request.json().catch(() => undefined)) as CreateSessionRequest | undefined;
		if (!body) return badRequest("Missing session request");
		const requestedCwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
		const worktreeName = typeof body.worktreeName === "string" ? body.worktreeName.trim() : "";
		const worktreeBranch = typeof body.worktreeBranch === "string" ? body.worktreeBranch.trim() : "";
		const worktreeStartPoint = typeof body.worktreeStartPoint === "string" ? body.worktreeStartPoint.trim() : "";
		if (!requestedCwd) return badRequest("Specify a repository or directory");
		if (!worktreeName && (worktreeBranch || worktreeStartPoint)) return badRequest("worktreeBranch and worktreeStartPoint require worktreeName");

		let cwd: string;
		try {
			cwd = resolveWebCwd(requestedCwd, { baseDir: rootDir });
		} catch (error) {
			return badRequest(error instanceof Error ? error.message : String(error));
		}
		try {
			if (!statSync(cwd).isDirectory()) return badRequest(`cwd is not a directory: ${cwd}`);
		} catch {
			return badRequest(`cwd does not exist: ${cwd}`);
		}

		let worktree: Awaited<ReturnType<typeof createWebWorktree>> | undefined;
		if (worktreeName) {
			if (!resolveSessionProject(cwd).id.startsWith("git:")) return badRequest("Worktree repository is not a Git repository");
			try {
				worktree = await createWebWorktree(cwd, worktreeName, {
					branch: worktreeBranch || undefined,
					startPoint: worktreeStartPoint || undefined,
				});
				worktree = inheritManagedBranchOwnership(
					worktree,
					[...sessions.values()].map((candidate) => candidate.managedWorktree),
				);
				cwd = worktree.path;
			} catch (error) {
				return badRequest(error instanceof Error ? error.message : String(error));
			}
		}
		let session: SessionRecord;
		let initialSessionFile: string | undefined;
		try {
			const manager = SessionManager.create(cwd);
			if (worktree) {
				manager.appendCustomEntry(WORKTREE_SESSION_ENTRY, {
					path: worktree.path,
					repoRoot: worktree.repoRoot,
					name: worktree.name,
					branch: worktree.branch,
					branchCreated: worktree.branchCreated,
				});
			}
			if (body.name?.trim()) manager.appendSessionInfo(body.name.trim());
			initialSessionFile = persistInitialSession(manager);
			session = await createManagedSession(cwd, body.name, initialSessionFile);
			if (worktree) session.managedWorktree = worktree;
		} catch (error) {
			if (worktree) {
				const startupMessage = error instanceof Error ? error.message : String(error);
				throw new Error(`${startupMessage}; initialized worktree retained at ${worktree.path} for inspection`);
			}
			if (initialSessionFile) {
				const key = sessionFileKey(initialSessionFile);
				const stale = sessionsByFile.get(key);
				if (stale && stale.file && sessionFileKey(stale.file) === key) {
					sessions.delete(stale.id);
					sessionsByFile.delete(key);
				}
				if (isManagedSessionFile(initialSessionFile)) {
					try { deleteManagedSessionFile(initialSessionFile); } catch { /* preserve startup error */ }
				}
				rmSync(initialSessionFile, { force: true });
			}
			throw error;
		}
		return jsonResponse({ session: sessionToClientPayload(session), worktree }, { status: 201 });
	}
	if (request.method === "POST" && url.pathname === "/api/sessions/resume") {
		const body = (await request.json().catch(() => undefined)) as ResumeSessionRequest | undefined;
		if (!body || typeof body.file !== "string" || !body.file.trim()) return badRequest("Missing file");
		let file: string;
		try {
			file = canonicalSessionFile(resolve(rootDir, body.file));
		} catch (error) {
			return badRequest(error instanceof Error ? error.message : "Session file does not exist");
		}
		const scan = parseSessionMetadataFile(file);
		if (!scan) return badRequest("Invalid session file");
		const existing = sessionsByFile.get(normalizePath(file));
		if (existing?.active && existing.status !== "offline") {
			return jsonResponse({ error: "Session is already active" }, { status: 409 });
		}
		const session = await createManagedSession(scan.session.cwd, scan.session.name, file);
		return jsonResponse({ session: sessionToClientPayload(session) }, { status: 201 });
	}
	if (request.method === "DELETE") {
		const pathname = url.pathname;
		const match = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
		if (!match) return notFound();
		try {
			await deleteSession(decodeURIComponent(match[1]));
			return jsonResponse({ ok: true });
		} catch (error) {
			return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
		}
	}
	return notFound();
}

function handleWebSocketOpen(socket: Bun.ServerWebSocket<SocketData>): void {
	if (socket.data.kind === "client") attachClientSocket(socket as Bun.ServerWebSocket<ClientSocketData>);
	else attachAgentSocket(socket as Bun.ServerWebSocket<AgentSocketData>);
}

async function handleWebSocketMessage(socket: Bun.ServerWebSocket<SocketData>, data: string | Uint8Array): Promise<void> {
	const parsed = parseSocketMessage<ClientToServerMessage | AgentToServerMessage>(data);
	if (!parsed) {
		socket.close(1003, "Invalid JSON");
		return;
	}
	try {
		if (socket.data.kind === "client") await handleClientMessage(socket as Bun.ServerWebSocket<ClientSocketData>, parsed as ClientToServerMessage);
		else await handleAgentMessage(socket as Bun.ServerWebSocket<AgentSocketData>, parsed as AgentToServerMessage);
	} catch (error) {
		try {
			const frame: unknown = parsed;
			const requestId = isRecord(frame) && typeof frame.requestId === "string" ? frame.requestId : undefined;
			if (socket.data.kind === "client" && requestId) {
				socket.send(JSON.stringify({
					type: "server.response",
					requestId,
					success: false,
					error: error instanceof Error ? error.message : String(error),
				} satisfies ServerResponseMessage));
			} else {
				console.error("Pi web agent message failed:", error);
				socket.close(1011, "WebSocket message failed");
			}
		} catch {
			// ignore
		}
	}
}

function handleWebSocketClose(socket: Bun.ServerWebSocket<SocketData>): void {
	if (socket.data.kind === "client") {
		connectedClientSockets.delete(socket as Bun.ServerWebSocket<ClientSocketData>);
		for (const record of sessions.values()) {
			if (!record.clientSockets.delete(socket as Bun.ServerWebSocket<ClientSocketData>)) continue;
		}
		return;
	}
	for (const record of sessions.values()) {
		if (!record.agentSockets.delete(socket as Bun.ServerWebSocket<AgentSocketData>)) continue;
		for (const [requestId, target] of record.externalRequestTargets.entries()) {
			if (target !== socket) continue;
			record.externalRequestTargets.delete(requestId);
			const pending = record.externalPending.get(requestId);
			if (pending?.surviveDisconnect) continue;
			if (pending) {
				record.externalPending.delete(requestId);
				pending.reject(pending.commandType && isUncertainRpcDeliveryCommand(pending.commandType)
					? new CommandDeliveryUncertainError(`Agent socket closed before ${pending.commandType} acknowledgement`)
					: new Error("Agent socket closed"));
			}
		}
		if (record.agentSockets.size === 0 && record.kind === "external") {
			record.status = "offline";
			record.active = false;
			broadcastSessionToAll(record);
		}
	}
}

async function cleanupAndExit(code = 0): Promise<void> {
	// Repeated TERM/INT delivery is common during deploys. Never reinterpret it as
	// permission to abort managed work; an operator can still use SIGKILL for a
	// truly wedged process.
	if (shutdownStarted) return;
	shutdownStarted = true;
	if (missingSessionReconcileTimer) clearInterval(missingSessionReconcileTimer);
	missingSessionReconcileTimer = undefined;
	const busyNames = () => [...sessions.values()]
		.filter(shouldWaitForManagedShutdown)
		.map((record) => record.name ?? record.id);
	let busy = busyNames();
	if (busy.length > 0) console.error(`Waiting for active managed sessions before restart: ${busy.join(", ")}`);
	while (shouldContinueManagedShutdownWait(busy.length)) {
		await Bun.sleep(100);
		busy = busyNames();
	}
	if (busy.length > 0) console.error(`Proceeding with shutdown while sessions remain active: ${busy.join(", ")}`);
	// Stop admitting queue work and drain each per-session mutation tail before the
	// final snapshot. This prevents a late mutation from racing or following flush.
	const records = [...sessions.values()];
	await Promise.all(records.map((record) => quiesceQueueMutations(record)));
	// Accepted queue items are removed in memory before their durable snapshot may
	// finish. Drain any existing write before the final write, all within one bound.
	await Promise.all(records.map(async (record) => {
		if (record.queueDirtyWorker) await record.queueDirtyWorker.flushAndCancel(1_000);
	}));
	for (const record of sessions.values()) {
		cancelWebQueueWork(record);
		try {
			await stopRecord(record);
		} catch {
			// ignore
		}
	}
	try {
		server?.stop();
	} catch {
		// ignore
	}
	try {
		if (readStateFile(stateFilePath)?.pid === process.pid) rmSync(stateFilePath, { force: true });
	} catch {
		// ignore
	}
	setTimeout(() => process.exit(code), 25).unref();
}

async function main(): Promise<void> {
	await recoverStagedSourceSessionDeletions();
	webState = getOrCreateWebState();
	server = Bun.serve<any>({
		hostname: host,
		port,
		async fetch(request, serverInstance) {
			const url = new URL(request.url);
			if (url.pathname === "/ws/client") {
				// Browser WebSockets are not covered by CORS. Require the initiating
				// page to have the exact host served directly or forwarded by Tailscale.
				// This preserves tokenless iOS bookmarks while preventing arbitrary web
				// origins from driving shell-capable sessions.
				if (!isTrustedBrowserOrigin(request, tailscaleStatus.published ? tailscaleStatus.url : undefined)) return new Response("Forbidden WebSocket origin", { status: 403 });
				const upgraded = serverInstance.upgrade(request, { data: { kind: "client", id: randomUUID(), authed: false } as any });
				return upgraded ? undefined : new Response("Upgrade failed", { status: 400 });
			}
			if (url.pathname === "/ws/agent") {
				// The Pi bridge connects directly to localhost without Origin or proxy
				// headers. Tailscale Serve forwards this route too, so Origin absence alone
				// must not let a tailnet client impersonate an agent.
				const forwarded = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]
					.some((header) => request.headers.has(header));
				if (request.headers.has("origin") || forwarded) return new Response("Forbidden agent WebSocket", { status: 403 });
				const upgraded = serverInstance.upgrade(request, { data: { kind: "agent", id: randomUUID(), authed: false } as any });
				return upgraded ? undefined : new Response("Upgrade failed", { status: 400 });
			}
			try {
				const asset = staticAssetResponse(request);
				return asset ?? (await handleApi(request));
			} catch (error) {
				return internalError(error instanceof Error ? error.message : String(error));
			}
		},
		websocket: {
			maxPayloadLength: MAX_WEBSOCKET_PAYLOAD_BYTES,
			open(socket) {
				handleWebSocketOpen(socket as any);
			},
			message(socket, data) {
				void handleWebSocketMessage(socket as any, data as string | Uint8Array);
			},
			close(socket) {
				handleWebSocketClose(socket as any);
			},
		},
	});
	port = server.port ?? port;
	webState = { ...webState, port };
	// Configure Serve only after localhost is listening, then publish discovery
	// state with the final tailnet URL. Simultaneous startup losers never acquire
	// the port and therefore cannot overwrite the winning server's state.
	await configureTailscaleServe();
	process.on("SIGINT", () => void cleanupAndExit(0));
	process.on("SIGTERM", () => void cleanupAndExit(0));
	process.on("exit", () => {
		try {
			if (readStateFile(stateFilePath)?.pid === process.pid) rmSync(stateFilePath, { force: true });
		} catch {
			// ignore
		}
	});
	console.log(`pi web server listening on http://${host}:${port}`);
	missingSessionReconcileTimer = setInterval(() => void reconcileMissingSessionFiles(), MISSING_SESSION_RECONCILE_INTERVAL_MS);
	missingSessionReconcileTimer.unref?.();
	// Keep readiness independent from JSONL catalog work, then restore only the
	// browser-owned sessions that were active before the daemon stopped. Native
	// bridge sessions reconnect themselves and are never started in RPC mode here.
	setTimeout(() => void restoreManagedSessions().catch((error) => {
		console.error("Could not restore managed web sessions:", error);
	}), 250).unref();
}

void main().catch((error) => {
	console.error(error);
	process.exit(1);
});
