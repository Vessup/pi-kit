import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type {
	AgentEventMessage,
	AgentHelloMessage,
	AgentResponseMessage,
	AgentSubagentsMessage,
	AgentToServerMessage,
	AgentUpdateMessage,
	ClientCommandMessage,
	ClientSubscribeMessage,
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
	WebQueuedMessage,
	WebSession,
} from "../protocol.js";
import { compareWebSessions, DEFAULT_WEB_PORT, mergeWebSubagentUpdates, WEB_STATE_VERSION } from "../protocol.js";
import { expandSlashCommand, type ExpandableSlashCommand } from "../slash-commands.js";
import { resolveSessionProject } from "./projects.js";
import { resolveWebCwd } from "./paths.js";
import { createWebWorktree } from "./worktrees.js";
import { CoalescedQueueStoreWriter, readQueueStore } from "./queue-store.js";
import { persistPreDeliveryTransition, queueDeliveryFailureDisposition } from "./queue-delivery.js";
import { preserveRetryAroundQuiescence, quiesceQueueMutations, serializeQueueMutation, transactionalQueueMutation } from "./queue-mutation.js";
import { DirtySnapshotRetryWorker } from "./dirty-snapshot-worker.js";
import { runManagedRefresh, serializeManagedRefresh } from "./refresh-policy.js";
import {
	disableTailscaleServe,
	ensureTailscaleServe,
	readTailscaleWebSettings,
	replaceTailscaleServe,
	type TailscaleStatus,
	type TailscaleWebSettings,
} from "../tailscale.js";

type WebSocketKind = "client" | "agent";
type SessionSource = WebSession["source"];
type SessionStatus = WebSession["status"];
type SessionKind = "managed" | "external" | "saved";

type ClientSocketData = {
	kind: "client";
	id: string;
	authed: boolean;
	sessionId?: string;
};
type AgentSocketData = { kind: "agent"; id: string; authed: boolean };
type SocketData = ClientSocketData | AgentSocketData;

type RpcResponse<T = unknown> =
	| { id?: string; type: "response"; success: true; command: string; data?: T }
	| { id?: string; type: "response"; success: false; command: string; error: string };

type RpcEvent = Record<string, unknown> & { type?: string; id?: string };

type SessionRecord = {
	id: string;
	file?: string;
	cwd: string;
	name?: string;
	branch?: string;
	model?: string;
	thinkingLevel?: string;
	status: SessionStatus;
	source: SessionSource;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	preview?: string;
	parentSession?: string;
	pullRequest?: WebSession["pullRequest"];
	subagents?: WebSession["subagents"];
	subagentUsage?: WebSession["subagentUsage"];
	usage?: WebSession["usage"];
	contextUsage?: WebSession["contextUsage"];
	compaction?: WebSession["compaction"];
	kind: SessionKind;
	history: unknown[];
	active: boolean;
	/** RPC runtime used only for saved-session management operations. */
	managed?: ManagedRpcSession;
	agentSockets: Set<Bun.ServerWebSocket<AgentSocketData>>;
	clientSockets: Set<Bun.ServerWebSocket<ClientSocketData>>;
	externalRequestTargets: Map<string, Bun.ServerWebSocket<AgentSocketData>>;
	externalPending: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
	queue: WebQueuedMessage[];
	queueMutationTail?: Promise<void>;
	queueMutationsQuiesced?: boolean;
	queueDeliveryActive?: string;
	queueDeliveryAttempts?: { itemId: string; count: number };
	queueTransitionAttempts?: { itemId: string; count: number };
	queueRetryTimer?: ReturnType<typeof setTimeout>;
	queueDirtyWorker?: DirtySnapshotRetryWorker;
	managedRefreshTail?: Promise<void>;
};

type SessionFileScan = {
	session: WebSession;
	file: string;
	history: unknown[];
	entries: unknown[];
	header?: Record<string, unknown>;
};

type ManagedRpcSessionOptions = {
	cwd: string;
	name?: string;
	sessionFile?: string;
	noSession?: boolean;
	onEvent: (event: RpcEvent) => void;
	onExit: (exitCode: number | null, signal: string | null) => void;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type DiscoveredSlashCommand = ExpandableSlashCommand & {
	description?: string;
	sourceInfo: ExpandableSlashCommand["sourceInfo"] & { scope?: "user" | "project" | "temporary" };
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const rootDir = resolve(process.env.PI_WEB_ROOT ? (isAbsolute(process.env.PI_WEB_ROOT) ? process.env.PI_WEB_ROOT : join(process.cwd(), process.env.PI_WEB_ROOT)) : process.cwd());
const distDir = join(rootDir, "web", "dist");
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
const persistedQueues = readQueueStore(queueStorePath);
const queueStoreWriter = new CoalescedQueueStoreWriter(queueStorePath);
const port = Number(process.env.PI_WEB_PORT ?? `${DEFAULT_WEB_PORT}`) || DEFAULT_WEB_PORT;
const host = "127.0.0.1";
const configuredRpcTimeout = Number(process.env.PI_WEB_RPC_TIMEOUT_MS ?? "30000");
const RPC_REQUEST_TIMEOUT_MS = Number.isFinite(configuredRpcTimeout) && configuredRpcTimeout > 0
	? Math.floor(configuredRpcTimeout)
	: 30_000;
const LONG_RUNNING_COMMAND_TIMEOUT_MS = 10 * 60_000;
// Accept one legacy agent.hello containing a large session until running Pi
// processes reload the bridge that sends metadata-only hello frames.
const MAX_WEBSOCKET_PAYLOAD_BYTES = 32 * 1024 * 1024;
// Preserve at least one complete addon-sized image in reconnect snapshots.
const IMAGE_EXTENSIONS = new Map([
	["image/png", "png"],
	["image/jpeg", "jpg"],
	["image/gif", "gif"],
	["image/webp", "webp"],
	["image/bmp", "bmp"],
]);

const sessions = new Map<string, SessionRecord>();
const sessionsByFile = new Map<string, SessionRecord>();
const savedSessionMetadataCache = new Map<string, { mtimeMs: number; size: number; scan: SessionFileScan }>();
const slashCommandCache = new Map<string, { loadedAt: number; commands: DiscoveredSlashCommand[] }>();
let server: Bun.Server<any> | undefined;
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

function normalizePath(path: string): string {
	return normalize(resolve(path));
}

function isWithinDir(child: string, parent: string): boolean {
	const normalizedChild = normalizePath(child);
	const normalizedParent = normalizePath(parent);
	if (normalizedChild === normalizedParent) return true;
	return normalizedChild.startsWith(`${normalizedParent}${sep}`);
}

function canonicalSessionFile(path: string): string {
	const canonicalRoot = realpathSync(sessionsDir);
	const canonicalFile = realpathSync(path);
	if (!isWithinDir(canonicalFile, canonicalRoot)) throw new Error("Session file must be under ~/.pi/agent/sessions");
	if (!lstatSync(canonicalFile).isFile()) throw new Error("Session path must be a regular file");
	return canonicalFile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}


function toNumber(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) target[key] += toNumber(value[key]);
	if (!isRecord(value.cost)) return;
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) target.cost[key] += toNumber(value.cost[key]);
}

function usageFromEntries(entries: readonly unknown[]): NonNullable<WebSession["usage"]> {
	const usage = zeroWebUsage();
	for (const raw of entries) {
		if (!isRecord(raw)) continue;
		if (raw.type === "message" && isRecord(raw.message) && (raw.message.role === "assistant" || raw.message.role === "toolResult")) {
			addWebUsage(usage, raw.message.usage);
		} else if (raw.type === "branch_summary" || raw.type === "compaction") {
			addWebUsage(usage, raw.usage);
		}
	}
	return usage;
}

function extractTextContent(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const item of content) {
		if (item && typeof item === "object" && "type" in item && (item as { type?: string }).type === "text" && typeof (item as { text?: string }).text === "string") {
			parts.push((item as { text: string }).text);
		}
	}
	return parts.length > 0 ? parts.join("") : undefined;
}

function extractPreviewFromHistory(entries: unknown[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i] as Record<string, unknown> | undefined;
		if (!entry) continue;
		if (entry.type === "message") {
			const message = entry.message as Record<string, unknown> | undefined;
			if (!message) continue;
			const role = typeof message.role === "string" ? message.role : undefined;
			if (role !== "user" && role !== "assistant") continue;
			const preview = extractTextContent(message.content);
			if (preview) return preview.slice(0, 180);
		}
	}
	return undefined;
}

function extractSessionMetadataFromEntries(entries: unknown[]): Partial<WebSession> {
	let name: string | undefined;
	let model: string | undefined;
	let thinkingLevel: string | undefined;
	let parentSession: string | undefined;
	let messageCount = 0;
	for (const raw of entries) {
		const entry = raw as Record<string, unknown> | undefined;
		if (!entry || typeof entry.type !== "string") continue;
		if (entry.type === "message") messageCount += 1;
		if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name;
		if (entry.type === "model_change" && typeof entry.modelId === "string") model = entry.modelId;
		if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") thinkingLevel = entry.thinkingLevel;
		if (entry.type === "session" && typeof entry.parentSession === "string") parentSession = entry.parentSession;
	}
	return { name, model, thinkingLevel, parentSession, messageCount };
}

function parseSessionFile(file: string): SessionFileScan | undefined {
	try {
		const text = readFileSync(file, "utf8");
		const lines = text.split(/\n/).map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line)).filter((line) => line.length > 0);
		if (lines.length === 0) return undefined;
		const header = JSON.parse(lines[0] ?? "null") as Record<string, unknown> | null;
		const rawEntries: unknown[] = [];
		for (const line of lines.slice(1)) {
			try {
				rawEntries.push(JSON.parse(line));
			} catch {
				// ignore malformed trailing lines
			}
		}
		const meta = extractSessionMetadataFromEntries(rawEntries);
		const stats = statSync(file);
		const id = typeof header?.id === "string" ? header.id : basename(file, ".jsonl");
		const cwd = typeof header?.cwd === "string" && header.cwd ? header.cwd : dirname(file);
		const session: WebSession = {
			id,
			file,
			cwd,
			name: meta.name,
			branch: meta.branch,
			model: meta.model,
			thinkingLevel: meta.thinkingLevel,
			status: "offline",
			source: "saved",
			createdAt: typeof header?.timestamp === "string" ? Date.parse(header.timestamp) || stats.birthtimeMs : stats.birthtimeMs,
			updatedAt: stats.mtimeMs,
			messageCount: meta.messageCount ?? 0,
			preview: extractPreviewFromHistory(rawEntries),
			parentSession: typeof header?.parentSession === "string" ? header.parentSession : undefined,
			usage: usageFromEntries(rawEntries),
		};
		return { session, file, history: rawEntries, entries: rawEntries, header: header ?? undefined };
	} catch {
		return undefined;
	}
}

function parseSessionMetadataFile(file: string): SessionFileScan | undefined {
	try {
		const stats = statSync(file);
		const cached = savedSessionMetadataCache.get(file);
		if (cached?.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.scan;

		const text = readFileSync(file, "utf8");
		const lines = text.split(/\n/).map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line)).filter(Boolean);
		if (lines.length === 0) return undefined;
		const header = JSON.parse(lines[0] ?? "null") as Record<string, unknown> | null;
		let name: string | undefined;
		let model: string | undefined;
		let thinkingLevel: string | undefined;
		let messageCount = 0;
		let preview: string | undefined;
		const usage = zeroWebUsage();
		for (const line of lines.slice(1)) {
			let entry: Record<string, unknown> | undefined;
			try {
				const parsed: unknown = JSON.parse(line);
				entry = isRecord(parsed) ? parsed : undefined;
			} catch {
				continue;
			}
			if (!entry || typeof entry.type !== "string") continue;
			if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name;
			if (entry.type === "model_change" && typeof entry.modelId === "string") model = entry.modelId;
			if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") thinkingLevel = entry.thinkingLevel;
			if (entry.type === "message") {
				messageCount += 1;
				const message = isRecord(entry.message) ? entry.message : undefined;
				if (message && (message.role === "assistant" || message.role === "toolResult")) addWebUsage(usage, message.usage);
				if (message && (message.role === "user" || message.role === "assistant")) {
					const textPreview = extractTextContent(message.content);
					if (textPreview) preview = textPreview.slice(0, 180);
				}
			}
			if (entry.type === "branch_summary" || entry.type === "compaction") addWebUsage(usage, entry.usage);
		}
		const id = typeof header?.id === "string" ? header.id : basename(file, ".jsonl");
		const cwd = typeof header?.cwd === "string" && header.cwd ? header.cwd : dirname(file);
		const session: WebSession = {
			id,
			file,
			cwd,
			name,
			model,
			thinkingLevel,
			status: "offline",
			source: "saved",
			createdAt: typeof header?.timestamp === "string" ? Date.parse(header.timestamp) || stats.birthtimeMs : stats.birthtimeMs,
			updatedAt: stats.mtimeMs,
			messageCount,
			preview,
			parentSession: typeof header?.parentSession === "string" ? header.parentSession : undefined,
			usage,
		};
		const scan = { session, file, history: [], entries: [], header: header ?? undefined };
		savedSessionMetadataCache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, scan });
		return scan;
	} catch {
		return undefined;
	}
}

function scanSavedSessions(dir: string): SessionFileScan[] {
	const files: string[] = [];
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		let entries: Array<{ isDirectory(): boolean; isFile(): boolean; name: string }>;
		try {
			entries = readdirSync(current, { withFileTypes: true }) as Array<{ isDirectory(): boolean; isFile(): boolean; name: string }>;
		} catch {
			continue;
		}
		for (const entry of entries) {
			const fullPath = join(current, entry.name);
			if (entry.isDirectory()) stack.push(fullPath);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
		}
	}
	const scans: SessionFileScan[] = [];
	const discovered = new Set(files);
	for (const file of files) {
		const scan = parseSessionMetadataFile(file);
		if (scan) scans.push(scan);
	}
	for (const file of savedSessionMetadataCache.keys()) {
		if (isWithinDir(file, dir) && !discovered.has(file)) savedSessionMetadataCache.delete(file);
	}
	return scans;
}

function deriveForkMessages(entries: unknown[]): Array<{ entryId: string; text: string }> {
	const result: Array<{ entryId: string; text: string }> = [];
	for (const raw of entries) {
		const entry = raw as Record<string, unknown> | undefined;
		if (!entry || entry.type !== "message") continue;
		const id = typeof entry.id === "string" ? entry.id : undefined;
		const message = entry.message as Record<string, unknown> | undefined;
		if (!id || !message || message.role !== "user") continue;
		const text = extractTextContent(message.content);
		if (text) result.push({ entryId: id, text });
	}
	return result;
}

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

function jsonResponse(value: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(value), {
		status: init?.status ?? 200,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...(init?.headers ?? {}),
		},
	});
}

function textResponse(value: string, init?: ResponseInit): Response {
	return new Response(value, {
		status: init?.status ?? 200,
		headers: init?.headers,
	});
}

function notFound(): Response {
	return textResponse("Not found", { status: 404 });
}

function badRequest(message: string): Response {
	return jsonResponse({ error: message }, { status: 400 });
}

function internalError(message: string): Response {
	return jsonResponse({ error: message }, { status: 500 });
}

function isTrustedBrowserOrigin(request: Request): boolean {
	const rawOrigin = request.headers.get("origin");
	if (!rawOrigin) return false;
	try {
		const origin = new URL(rawOrigin);
		if (origin.protocol !== "http:" && origin.protocol !== "https:") return false;
		const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
		if (forwardedHost) {
			if (!tailscaleStatus.published || !tailscaleStatus.url) return false;
			const published = new URL(tailscaleStatus.url);
			return origin.origin === published.origin && forwardedHost === published.host.toLowerCase();
		}
		const hostname = origin.hostname.toLowerCase();
		if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]") return false;
		const requestHost = (request.headers.get("host") || new URL(request.url).host).toLowerCase();
		return origin.host.toLowerCase() === requestHost;
	} catch {
		return false;
	}
}

function makeSessionRecord(session: WebSession, kind: SessionKind, history: unknown[] = []): SessionRecord {
	const record = sessions.get(session.id) ?? {
		...session,
		kind,
		history: [...history],
		active: kind !== "saved",
		agentSockets: new Set<Bun.ServerWebSocket<AgentSocketData>>(),
		clientSockets: new Set<Bun.ServerWebSocket<ClientSocketData>>(),
		externalRequestTargets: new Map<string, Bun.ServerWebSocket<AgentSocketData>>(),
		externalPending: new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>(),
		queue: (persistedQueues.get(session.id) ?? []).map((item) => ({ ...item, images: item.images?.map((image) => ({ ...image })) })),
	};
	Object.assign(record, session);
	record.kind = kind;
	record.history = history.length > 0 ? [...history] : record.history;
	record.active = kind !== "saved" || record.active;
	if (kind === "saved") record.active = false;
	return record;
}

function upsertSession(session: WebSession, kind: SessionKind, history: unknown[] = []): SessionRecord {
	const existing = sessions.get(session.id);
	const record = existing ?? makeSessionRecord(session, kind, history);
	Object.assign(record, session);
	record.kind = kind;
	if (history.length > 0) record.history = [...history];
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
	for (const record of sessions.values()) {
		for (const socket of record.clientSockets) {
			try {
				socket.send(payload);
			} catch {
				// ignore
			}
		}
	}
}

function sessionSnapshot(): WebSession[] {
	const merged = new Map<string, WebSession>();
	for (const record of sessions.values()) {
		const key = record.file ? normalizePath(record.file) : record.id;
		merged.set(key, sessionToClientPayload(record));
	}
	for (const scan of scanSavedSessions(sessionsDir)) {
		const key = scan.session.file ? normalizePath(scan.session.file) : scan.session.id;
		const live = sessionsByFile.get(key) ?? sessions.get(scan.session.id);
		if (!live?.active || live.status === "offline") merged.set(key, sessionToClientPayload(scan.session));
	}
	return sortSessions(Array.from(merged.values()));
}

function sessionHistoryForRecord(record: SessionRecord): unknown[] {
	if (record.managed && record.active) return [...record.history];
	if (record.file) {
		const scan = parseSessionFile(record.file);
		if (scan) {
			record.history = scan.history;
			return [...scan.history];
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
	}
	if (typeof s.sessionId === "string") record.id = s.sessionId;
	if (typeof s.sessionName === "string") record.name = s.sessionName;
	if (typeof s.messageCount === "number") record.messageCount = s.messageCount;
	if (s.isCompacting === true) {
		record.compaction ??= { reason: "threshold", startedAt: Date.now() };
		record.status = "working";
	} else if (s.isCompacting === false) {
		record.compaction = undefined;
		if (s.isStreaming === false) record.status = "idle";
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
	const branch = await commandOutput(["git", "branch", "--show-current"], record.cwd);
	if (branch) record.branch = branch;
	const raw = await commandOutput(["gh", "pr", "view", "--json", "number,url"], record.cwd);
	if (raw) {
		try {
			const value: unknown = JSON.parse(raw);
			if (isRecord(value) && Number.isInteger(value.number) && typeof value.url === "string") {
				const url = new URL(value.url);
				if (url.protocol === "https:" || url.protocol === "http:") {
					record.pullRequest = { number: value.number as number, url: url.toString() };
				}
			}
		} catch {
			// A branch without an open PR is expected.
		}
	}
	broadcast(record.id, { type: "server.session", session: sessionToClientPayload(record) } satisfies ServerSessionMessage);
}

class ManagedRpcSession {
	private readonly options: ManagedRpcSessionOptions;
	private process: Bun.Subprocess | undefined;
	private stdoutBuffer = "";
	private stderrBuffer = "";
	private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; command: string }>();
	private stopped = false;
	private readonly requestPrefix = `web-${randomUUID()}`;
	private pendingStart: Promise<void> | undefined;

	constructor(options: ManagedRpcSessionOptions) {
		this.options = options;
	}

	async start(): Promise<void> {
		if (this.process) return;
		ensureDir(dirname(stateFilePath));
		const env = {
			...process.env,
			PI_WEB_MANAGED: "1",
		};
		const args = ["--mode", "rpc"];
		if (this.options.noSession) args.push("--no-session");
		if (this.options.name) args.push("--name", this.options.name);
		if (this.options.sessionFile) {
			// Start in the target cwd and switch to the existing session file immediately.
			// This keeps the spawned process managed while preserving the existing branch history.
		}
		const proc = Bun.spawn({
			cmd: ["pi", ...args],
			cwd: this.options.cwd,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.process = proc;
		this.pendingStart = this.pumpStdout(proc).catch((error) => {
			this.failAllPending(error instanceof Error ? error : new Error(String(error)));
		});
		this.pumpStderr(proc).catch(() => undefined);
		proc.exited.then((code: number) => {
			this.stopped = true;
			this.options.onExit(code, null);
			this.failAllPending(new Error(`RPC process exited with code ${code}`));
		}).catch((error: unknown) => {
			this.stopped = true;
			this.options.onExit(null, error instanceof Error ? error.message : String(error));
			this.failAllPending(error instanceof Error ? error : new Error(String(error)));
		});
		await this.send({ type: "get_state" });
		if (this.options.sessionFile) {
			await this.send({ type: "switch_session", sessionPath: this.options.sessionFile });
		}
	}

	private async pumpStdout(proc: Bun.Subprocess): Promise<void> {
		const stream = (proc as unknown as { stdout?: ReadableStream<Uint8Array> }).stdout;
		if (!stream) return;
		const streamDecoder = new TextDecoder();
		const reader = stream.getReader();
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				this.stdoutBuffer += streamDecoder.decode(value, { stream: true });
				let newlineIndex = this.stdoutBuffer.indexOf("\n");
				while (newlineIndex >= 0) {
					let line = this.stdoutBuffer.slice(0, newlineIndex);
					this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
					if (line.endsWith("\r")) line = line.slice(0, -1);
					if (line.length > 0) this.handleLine(line);
					newlineIndex = this.stdoutBuffer.indexOf("\n");
				}
			}
			const tail = `${this.stdoutBuffer}${streamDecoder.decode()}`;
			this.stdoutBuffer = "";
			if (tail.trim().length > 0) {
				const line = tail.endsWith("\r") ? tail.slice(0, -1) : tail;
				this.handleLine(line);
			}
		} finally {
			reader.releaseLock();
		}
	}

	private async pumpStderr(proc: Bun.Subprocess): Promise<void> {
		const stream = (proc as unknown as { stderr?: ReadableStream<Uint8Array> }).stderr;
		if (!stream) return;
		const streamDecoder = new TextDecoder();
		const reader = stream.getReader();
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				this.stderrBuffer += streamDecoder.decode(value, { stream: true });
			}
			this.stderrBuffer += streamDecoder.decode();
		} finally {
			reader.releaseLock();
		}
	}

	private handleLine(line: string): void {
		let parsed: RpcEvent;
		try {
			parsed = JSON.parse(line) as RpcEvent;
		} catch (error) {
			this.failAllPending(new Error(`Invalid JSONL from RPC child: ${error instanceof Error ? error.message : String(error)}`));
			return;
		}
		if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") return;
		if (parsed.type === "response") {
			const response = parsed as RpcResponse;
			const responseId = typeof response.id === "string" ? response.id : undefined;
			if (responseId && this.pending.has(responseId)) {
				const pending = this.pending.get(responseId)!;
				this.pending.delete(responseId);
				if (response.success) pending.resolve((response as RpcResponse & { data?: unknown }).data);
				else pending.reject(new Error(response.error));
			}
			return;
		}
		this.options.onEvent(parsed);
	}

	private async writeLine(line: string): Promise<void> {
		if (!this.process) throw new Error("RPC process is not running");
		const stdin = (this.process as unknown as { stdin?: { getWriter?: () => WritableStreamDefaultWriter<Uint8Array>; write?: (value: string | Uint8Array) => unknown } }).stdin;
		if (!stdin) throw new Error("RPC stdin unavailable");
		const payload = encoder.encode(line);
		if (typeof stdin.getWriter === "function") {
			const writer = stdin.getWriter();
			try {
				await writer.write(payload);
			} finally {
				writer.releaseLock();
			}
			return;
		}
		if (typeof stdin.write === "function") {
			await stdin.write(payload);
			return;
		}
		throw new Error("Unsupported RPC stdin sink");
	}

	private failAllPending(error: Error): void {
		for (const [id, pending] of this.pending.entries()) {
			this.pending.delete(id);
			try {
				pending.reject(error);
			} catch {
				// ignore
			}
		}
	}

	async send<T = unknown>(command: Record<string, unknown>, timeoutMs: number | null = RPC_REQUEST_TIMEOUT_MS): Promise<T> {
		if (this.stopped) throw new Error("RPC session stopped");
		if (!this.process) await this.start();
		const id = `${this.requestPrefix}-${randomUUID()}`;
		const payload = { id, ...command };
		const commandName = typeof command.type === "string" ? command.type : "unknown";
		return await new Promise<T>((resolve, reject) => {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const clearRequestTimeout = () => {
				if (timeout) clearTimeout(timeout);
			};
			this.pending.set(id, {
				resolve: (value) => {
					clearRequestTimeout();
					resolve(value as T);
				},
				reject: (error) => {
					clearRequestTimeout();
					reject(error);
				},
				command: commandName,
			});
			if (timeoutMs !== null) {
				timeout = setTimeout(() => {
					const pending = this.pending.get(id);
					if (!pending) return;
					this.pending.delete(id);
					pending.reject(new Error(`RPC command ${pending.command} timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			}
			void this.writeLine(`${JSON.stringify(payload)}\n`).catch((error: unknown) => {
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);
				pending.reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	async getState(): Promise<unknown> {
		return await this.send({ type: "get_state" });
	}

	async getAvailableModels(): Promise<{ models: Array<Record<string, unknown>> }> {
		return await this.send({ type: "get_available_models" });
	}

	async getAvailableThinkingLevels(): Promise<{ levels: string[] }> {
		return await this.send({ type: "get_available_thinking_levels" });
	}

	async getCommands(): Promise<{ commands: Array<Record<string, unknown>> }> {
		return await this.send({ type: "get_commands" });
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		await this.send({ type: "set_model", provider, modelId });
	}

	async setThinkingLevel(level: string): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
	}

	async getEntries(since?: string): Promise<{ entries: unknown[]; leafId: string | null }> {
		return await this.send({ type: "get_entries", since });
	}

	async getMessages(): Promise<{ messages: unknown[] }> {
		return await this.send({ type: "get_messages" });
	}

	async getSessionStats(): Promise<Record<string, unknown>> {
		return await this.send({ type: "get_session_stats" });
	}

	async getForkMessages(): Promise<{ messages: Array<{ entryId: string; text: string }> }> {
		return await this.send({ type: "get_fork_messages" });
	}

	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		return await this.send({ type: "fork", entryId });
	}

	async clone(): Promise<{ cancelled: boolean }> {
		return await this.send({ type: "clone" });
	}

	async compact(customInstructions?: string): Promise<unknown> {
		return await this.send({ type: "compact", customInstructions }, LONG_RUNNING_COMMAND_TIMEOUT_MS);
	}

	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	async prompt(
		message: string,
		streamingBehavior?: "steer" | "followUp",
		images?: Array<{ type: "image"; data: string; mimeType: string }>,
	): Promise<void> {
		await this.send({ type: "prompt", message, images, streamingBehavior });
	}

	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	async bash(command: string): Promise<unknown> {
		return await this.send({ type: "bash", command }, LONG_RUNNING_COMMAND_TIMEOUT_MS);
	}

	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	async respondToExtensionUi(command: Extract<RpcSessionCommand, { type: "extension_ui_response" }>): Promise<void> {
		if (this.stopped) throw new Error("RPC session stopped");
		if (!this.process) await this.start();
		await this.writeLine(`${JSON.stringify(command)}\n`);
	}

	async switchSession(sessionPath: string): Promise<void> {
		await this.send({ type: "switch_session", sessionPath });
	}

	async shutdown(): Promise<void> {
		if (!this.process || this.stopped) return;
		this.stopped = true;
		try {
			await this.send({ type: "abort" });
		} catch {
			// ignore
		}
		try {
			(this.process as unknown as { kill?: (signal?: string) => void }).kill?.("SIGTERM");
		} catch {
			// ignore
		}
	}
}

function parseDiscoveredSlashCommands(values: Array<Record<string, unknown>>): DiscoveredSlashCommand[] {
	return values.flatMap((value) => {
		if (typeof value.name !== "string" || (value.source !== "extension" && value.source !== "prompt" && value.source !== "skill")) return [];
		const sourceInfo = isRecord(value.sourceInfo) ? value.sourceInfo : undefined;
		if (!sourceInfo || typeof sourceInfo.path !== "string") return [];
		return [{
			name: value.name,
			description: typeof value.description === "string" ? value.description : undefined,
			source: value.source,
			sourceInfo: {
				path: sourceInfo.path,
				baseDir: typeof sourceInfo.baseDir === "string" ? sourceInfo.baseDir : undefined,
				scope: sourceInfo.scope === "user" || sourceInfo.scope === "project" || sourceInfo.scope === "temporary" ? sourceInfo.scope : undefined,
			},
		}];
	});
}

async function discoverSlashCommands(cwd: string): Promise<DiscoveredSlashCommand[]> {
	const key = normalizePath(cwd);
	const cached = slashCommandCache.get(key);
	if (cached && Date.now() - cached.loadedAt < 30_000) return cached.commands;
	const runtime = new ManagedRpcSession({
		cwd,
		noSession: true,
		onEvent: () => undefined,
		onExit: () => undefined,
	});
	try {
		await runtime.start();
		const { commands } = await runtime.getCommands();
		const parsed = parseDiscoveredSlashCommands(commands);
		slashCommandCache.set(key, { loadedAt: Date.now(), commands: parsed });
		return parsed;
	} finally {
		await runtime.shutdown();
	}
}

function webSlashCommands(commands: readonly DiscoveredSlashCommand[], includeExtensions = false): Array<Record<string, unknown>> {
	return commands
		.filter((command) => includeExtensions || command.source === "prompt" || command.source === "skill")
		.map((command) => ({
			name: command.name,
			description: command.description,
			source: command.source,
			location: command.sourceInfo.scope,
		}));
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
		const scan = parseSessionFile(record.file);
		if (scan) {
			const temp = new ManagedRpcSession({
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
		return { messages: deriveForkMessages(sessionHistoryForRecord(record)) };
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
		entries: entries.slice(-600),
	};
	socket.send(JSON.stringify(payload));
}

function webQueueEvent(record: SessionRecord): ServerEventMessage {
	return { type: "server.event", sessionId: record.id, event: { type: "web_queue_update", queue: record.queue } };
}

function cloneWebQueue(queue: WebQueuedMessage[]): WebQueuedMessage[] {
	return queue.map((item) => ({ ...item, images: item.images?.map((image) => ({ ...image })) }));
}

function setWebQueueState(record: SessionRecord, queue: WebQueuedMessage[]): void {
	record.queue = queue;
}

function persistWebQueue(record: SessionRecord): Promise<void> {
	const sessionId = record.id;
	const queue = cloneWebQueue(record.queue);
	return queueStoreWriter.mutate(persistedQueues, (queues) => {
		if (queue.length > 0) queues.set(sessionId, queue);
		else queues.delete(sessionId);
	});
}

async function migratePersistedQueue(record: SessionRecord, oldId: string, newId: string): Promise<void> {
	await quiesceQueueMutations(record);
	if (record.queueDirtyWorker) {
		await record.queueDirtyWorker.cancelAndDrain();
		record.queueDirtyWorker = undefined;
	}
	const queue = cloneWebQueue(record.queue);
	await queueStoreWriter.mutate(persistedQueues, (queues) => {
		queues.delete(oldId);
		if (queue.length > 0) queues.set(newId, queue);
		else queues.delete(newId);
	});
}

function scheduleWebQueueRetry(record: SessionRecord): void {
	if (record.queueRetryTimer || record.queue.length === 0) return;
	// Re-enter through the normal serialized flush only after intake has reopened.
	record.queueRetryTimer = setTimeout(() => {
		record.queueRetryTimer = undefined;
		if (sessions.get(record.id) === record) void flushWebQueue(record);
	}, 0);
	record.queueRetryTimer.unref?.();
}

function markWebQueueSnapshotDirty(record: SessionRecord): void {
	record.queueDirtyWorker ??= new DirtySnapshotRetryWorker({
		persist: () => persistWebQueue(record),
		onError: (error) => console.error(`Could not persist queue snapshot for ${record.id}:`, error),
	});
	record.queueDirtyWorker.markDirty();
}

function cancelWebQueueWork(record: SessionRecord): void {
	if (record.queueRetryTimer) clearTimeout(record.queueRetryTimer);
	record.queueRetryTimer = undefined;
	record.queueDirtyWorker?.cancel();
	record.queueDirtyWorker = undefined;
}

async function broadcastWebQueue(record: SessionRecord): Promise<void> {
	await persistWebQueue(record);
	broadcast(record.id, webQueueEvent(record));
}

function broadcastQueueDelivery(record: SessionRecord, item: WebQueuedMessage, phase: "started" | "failed" | "uncertain", error?: string): void {
	broadcast(record.id, {
		type: "server.event",
		sessionId: record.id,
		event: { type: "web_queue_delivery", phase, item, error },
	} satisfies ServerEventMessage);
}

function sendSessionState(socket: Bun.ServerWebSocket<ClientSocketData>, record: SessionRecord): void {
	// A newly subscribed client receives one bounded full transcript snapshot;
	// subsequent subagent updates arrive as deltas.
	const payload: ServerSessionMessage = { type: "server.session", session: sessionToClientPayload(record, true) };
	socket.send(JSON.stringify(payload));
	socket.send(JSON.stringify(webQueueEvent(record)));
	const uncertain = record.queue.find((item) => item.deliveryState === "delivering");
	if (uncertain) socket.send(JSON.stringify({ type: "server.event", sessionId: record.id, event: { type: "web_queue_delivery", phase: "uncertain", item: uncertain, error: "Delivery may already have been accepted; explicitly discard or confirm resubmission." } } satisfies ServerEventMessage));
}

async function flushWebQueue(record: SessionRecord): Promise<void> {
	return serializeQueueMutation(record, () => flushWebQueueLocked(record));
}

async function flushWebQueueLocked(record: SessionRecord): Promise<void> {
	if (record.queue.length === 0 || record.queueDeliveryActive || record.status !== "idle") return;
	let item = record.queue[0];
	if (!item || item.deliveryState === "delivering") return;
	// Persist the in-flight state before handing the prompt to Pi. A transient
	// storage failure is published and retried with a bounded policy; Pi is not
	// called until this transition is durable.
	const transitioned = await persistPreDeliveryTransition({
		persist: () => transactionalQueueMutation({
			get: () => record.queue, set: (queue) => setWebQueueState(record, queue), clone: cloneWebQueue,
			mutate: (queue) => { queue[0]!.deliveryState = "delivering"; },
			persist: () => persistWebQueue(record),
		}),
		previousAttempts: record.queueTransitionAttempts?.itemId === item.id ? record.queueTransitionAttempts.count : 0,
		publishError: (error, attempts, exhausted) => {
			record.queueTransitionAttempts = { itemId: item!.id, count: attempts };
			const message = error instanceof Error ? error.message : String(error);
			if (exhausted) {
				// Keep the cap terminal across every later flush trigger. This server-owned
				// uncertain state blocks delivery until explicit discard/resubmit, while the
				// coalesced worker keeps trying to make that disposition durable.
				// transactionalQueueMutation replaces the live queue when it rolls back;
				// mark that restored head, not the stale object captured before the write.
				const liveItem = record.queue.find((queued) => queued.id === item!.id);
				if (!liveItem) return;
				liveItem.deliveryState = "delivering";
				setWebQueueState(record, record.queue);
				item = liveItem;
				broadcastQueueDelivery(record, liveItem, "uncertain", `Could not persist delivery transition after ${attempts} attempts: ${message}; explicitly discard or confirm resubmission.`);
				broadcast(record.id, webQueueEvent(record));
				markWebQueueSnapshotDirty(record);
			} else {
				broadcastQueueDelivery(record, item!, "failed", `Could not persist delivery transition: ${message} (attempt ${attempts}; retrying)`);
			}
		},
		scheduleRetry: (delayMs) => {
			if (record.queueRetryTimer) return;
			record.queueRetryTimer = setTimeout(() => {
				record.queueRetryTimer = undefined;
				if (sessions.get(record.id) === record && record.queue[0]?.id === item!.id) void flushWebQueue(record);
			}, delayMs);
			record.queueRetryTimer.unref?.();
		},
	});
	if (!transitioned) return;
	record.queueTransitionAttempts = undefined;
	item = record.queue[0]!;
	record.queueDeliveryActive = item.id;
	let retryDelayMs: number | undefined;
	let persistenceError: unknown;
	let accepted = false;
	// Promote the follow-up into the transcript before asking Pi to start the
	// turn. The browser renders this as an optimistic user message and later
	// reconciles it with Pi's authoritative message_end event.
	broadcastQueueDelivery(record, item, "started");
	try {
		await routeCommand(record, { type: "prompt", message: item.message, images: item.images });
		accepted = true;
	} catch (error) {
		// A normal rejection proves Pi did not accept the command, so this item may
		// return to the retryable queued state. Process death between send/response
		// is represented by the durable delivering state across daemon restart.
		const uncertainSnapshot = cloneWebQueue(record.queue);
		delete item.deliveryState;
		const message = error instanceof Error ? error.message : String(error);
		const previousAttempts = record.queueDeliveryAttempts?.itemId === item.id
			? record.queueDeliveryAttempts.count
			: 0;
		const disposition = queueDeliveryFailureDisposition(previousAttempts);
		const attempts = disposition.attempts;
		record.queueDeliveryAttempts = { itemId: item.id, count: attempts };
		const exhausted = disposition.discard;
		broadcastQueueDelivery(
			record,
			item,
			"failed",
			exhausted ? `${message} (discarded after ${attempts} attempts)` : `${message} (attempt ${attempts}; retrying)`,
		);
		if (exhausted) {
			// Do not retain a poisoned queue head that can be submitted much later by
			// an unrelated settled/reconnect event. The failed delivery event is the
			// explicit disposition presented to subscribed clients.
			record.queue = record.queue.filter((queued) => queued.id !== item.id);
			record.queueDeliveryAttempts = undefined;
		} else if (!record.queueRetryTimer) {
			retryDelayMs = disposition.retryDelayMs!;
		}
		try {
			await broadcastWebQueue(record);
		} catch (error) {
			// The failed discard/retry-state write has unknown durability. Restore the
			// pre-mutation delivering snapshot so neither memory nor a later write can
			// silently authorize redelivery.
			setWebQueueState(record, uncertainSnapshot);
			persistenceError = error;
		}
		console.error(`Could not deliver queued message for ${record.id}:`, error);
	} finally {
		record.queueDeliveryActive = undefined;
	}
	if (persistenceError) {
		// Durable state may still say "delivering". Surface that uncertainty rather
		// than silently losing cleanup or retrying a prompt after a storage failure.
		const message = persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
		const uncertain = record.queue.find((queued) => queued.id === item.id);
		if (uncertain) {
			uncertain.deliveryState = "delivering";
			broadcastQueueDelivery(record, uncertain, "uncertain", `Could not persist delivery failure: ${message}; explicitly discard or confirm resubmission.`);
			broadcast(record.id, webQueueEvent(record));
		}
		return;
	}
	if (accepted) {
		// routeCommand accepted the prompt. From this point onward it must never be
		// retried, even when durable removal fails: retry only the persistence write.
		record.queue = record.queue.filter((queued) => queued.id !== item.id);
		record.queueDeliveryAttempts = undefined;
		broadcast(record.id, webQueueEvent(record));
		// One cancellable worker coalesces accepted removals and every later queue
		// mutation into current snapshots; accepted prompts are never redelivered.
		markWebQueueSnapshotDirty(record);
		return;
	}
	// Arm the retry only after durable persistence and active-delivery cleanup.
	// Otherwise a slow write can let the timer fire against the active guard and
	// consume the sole retry without another trigger.
	if (retryDelayMs !== undefined && !record.queueRetryTimer) {
		record.queueRetryTimer = setTimeout(() => {
			record.queueRetryTimer = undefined;
			if (sessions.get(record.id) === record && record.queue[0]?.id === item.id) {
				void flushWebQueue(record);
			}
		}, retryDelayMs);
		record.queueRetryTimer.unref?.();
	}
}

function sendSessionRemoved(sessionId: string): void {
	const payload: ServerSessionRemovedMessage = { type: "server.session_removed", sessionId };
	broadcastToAll(payload);
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

async function refreshManagedSession(record: SessionRecord, suppressErrors = false): Promise<void> {
	await runManagedRefresh(() => serializeManagedRefresh(record, async () => {
		const managed = record.managed;
		if (!managed) return;
		let finishQueueMigration: (() => void) | undefined;
		try {
			const oldId = record.id;
			const oldFile = record.file;
			const state = await managed.getState();
			const nextState = isRecord(state) ? { ...state } : state;
			const newId = isRecord(nextState) && typeof nextState.sessionId === "string" ? nextState.sessionId : oldId;
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
			updateRecordFromState(record, nextState);
			try {
				record.history = (await managed.getEntries()).entries;
				record.usage = usageFromEntries(record.history);
			} catch {
				// Keep the last complete history snapshot.
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
				sendSessionRemoved(oldId);
			}
			if (oldFile && oldFile !== record.file) sessionsByFile.delete(normalizePath(oldFile));
			if (record.file) sessionsByFile.set(normalizePath(record.file), record);
			const message = JSON.stringify({
				type: "server.session",
				session: sessionToClientPayload(record),
			} satisfies ServerSessionMessage);
			for (const socket of record.clientSockets) socket.send(message);
		} catch (error) {
			finishQueueMigration?.();
			throw error;
		}
	}), {
		suppressErrors,
		onBackgroundError: (error) => console.error(`Could not refresh managed session ${record.id}:`, error),
	});
}

function refreshTerminalMetadata(record: SessionRecord): void {
	let scan = record.file ? parseSessionFile(record.file) : undefined;
	if (!scan) {
		scan = scanSavedSessions(sessionsDir)
			.filter((candidate) => candidate.session.cwd === record.cwd && candidate.session.updatedAt >= record.createdAt - 2_000)
			.sort((a, b) => b.session.updatedAt - a.session.updatedAt)[0];
	}
	if (!scan) return;
	const oldFile = record.file;
	record.file = scan.file;
	record.name = scan.session.name ?? record.name;
	record.model = scan.session.model ?? record.model;
	record.thinkingLevel = scan.session.thinkingLevel ?? record.thinkingLevel;
	record.messageCount = scan.session.messageCount;
	record.preview = scan.session.preview;
	record.parentSession = scan.session.parentSession;
	record.usage = scan.session.usage ?? record.usage;
	record.contextUsage = scan.session.contextUsage ?? record.contextUsage;
	// Metadata polling deliberately does not load transcript history. History is
	// parsed only when a client subscribes or an operation explicitly needs it.
	if (oldFile && oldFile !== record.file) sessionsByFile.delete(normalizePath(oldFile));
	sessionsByFile.set(normalizePath(scan.file), record);
}

async function createManagedSession(cwd: string, name?: string, sessionFile?: string): Promise<SessionRecord> {
	const resumed = sessionFile ? parseSessionFile(sessionFile) : undefined;
	const existingRecord = resumed
		? sessions.get(resumed.session.id) ?? sessionsByFile.get(normalizePath(resumed.file))
		: undefined;
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
		history: resumed?.history ?? [],
		active: true,
		agentSockets: new Set(),
		clientSockets: existingRecord?.clientSockets ?? new Set(),
		externalRequestTargets: new Map(),
		externalPending: new Map(),
		queue: cloneWebQueue(existingRecord?.queue ?? persistedQueues.get(resumed?.session.id ?? "") ?? []),
	};
	sessions.set(record.id, record);
	if (record.file) sessionsByFile.set(normalizePath(record.file), record);
	void hydrateGitMetadata(record);

	const managed = new ManagedRpcSession({
		cwd,
		name,
		sessionFile,
		onEvent: (event) => {
			record.updatedAt = Date.now();
			updateSubagentsFromToolEvent(record, event);
			if (event.type === "agent_start" || event.type === "turn_start") record.status = "working";
			if (event.type === "compaction_start") {
				record.status = "working";
				record.compaction = {
					reason: event.reason === "manual" || event.reason === "overflow" ? event.reason : "threshold",
					startedAt: typeof event.startedAt === "number" ? event.startedAt : Date.now(),
				};
			}
			if (event.type === "compaction_end") record.compaction = undefined;
			if (event.type === "agent_settled") {
				record.status = "idle";
				void refreshManagedSession(record, true);
				void flushWebQueue(record);
			}

			if (event.type === "message_end" && isRecord(event.message)) {
				if (event.message.role === "assistant" || event.message.role === "toolResult") {
					record.usage ??= zeroWebUsage();
					addWebUsage(record.usage, event.message.usage);
				}
				record.history.push({
					type: "message",
					id: randomUUID(),
					parentId: null,
					timestamp: new Date().toISOString(),
					message: event.message,
				});
				record.messageCount += 1;
			}
			broadcast(record.id, {
				type: "server.event",
				sessionId: record.id,
				event,
			} satisfies ServerEventMessage);
			broadcast(record.id, { type: "server.session", session: sessionToClientPayload(record) } satisfies ServerSessionMessage);
		},
		onExit: () => {
			record.status = "offline";
			record.active = false;
			record.managed = undefined;
			broadcast(record.id, { type: "server.session", session: sessionToClientPayload(record) } satisfies ServerSessionMessage);
		},
	});
	record.managed = managed;
	const provisionalId = record.id;
	try {
		await managed.start();
		const state = await managed.getState();
		updateRecordFromState(record, state);
		if (record.id !== provisionalId) {
			sessions.delete(provisionalId);
			sessions.set(record.id, record);
		}
		try {
			record.history = (await managed.getEntries()).entries;
			record.usage = usageFromEntries(record.history);
		} catch {
			// Keep the parsed resume history until the RPC runtime reports entries.
		}
		try {
			updateRecordFromStats(record, await managed.getSessionStats());
		} catch {
			// Keep history-derived usage when stats are unavailable.
		}
		record.status = "idle";
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
		}
		throw error;
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
	if (message.type === "client.hello") {
		socket.data.authed = true;
		sendSessionSnapshot(socket);
		return;
	}
	if (!socket.data.authed) throw new Error("Client must send client.hello first");
	if (message.type === "client.subscribe") {
		const record = sessions.get(message.sessionId) ?? (() => {
			const scan = scanSavedSessions(sessionsDir).find((item) => item.session.id === message.sessionId || (item.file && normalizePath(item.file) === normalizePath(message.sessionId)));
			if (!scan) return undefined;
			return upsertSession(scan.session, "saved", scan.history);
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
	if (message.type === "client.prompt") {
		const record = sessions.get(message.sessionId);
		try {
			if (!record) throw new Error(`Unknown session: ${message.sessionId}`);
			if (message.streamingBehavior === "followUp" && record.status === "working") {
				await serializeQueueMutation(record, async () => {
					await transactionalQueueMutation({
						get: () => record.queue, set: (queue) => setWebQueueState(record, queue), clone: cloneWebQueue,
						mutate: (queue) => { queue.push({ id: message.requestId, message: message.message, images: message.images }); },
						persist: () => persistWebQueue(record),
					});
					broadcast(record.id, webQueueEvent(record));
				});
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
			await refreshManagedSession(record);
			const responseData = record.id !== previousSessionId && (message.command.type === "clone" || message.command.type === "fork")
				? { cancelled: isRecord(data) && data.cancelled === true, sessionId: record.id }
				: data;
			socket.send(JSON.stringify({ type: "server.response", requestId: message.requestId, success: true, data: responseData } satisfies ServerResponseMessage));
		} catch (error) {
			socket.send(JSON.stringify({ type: "server.response", requestId: message.requestId, success: false, error: error instanceof Error ? error.message : String(error) } satisfies ServerResponseMessage));
		}
	}
}

async function routeCommand(record: SessionRecord, command: ClientCommandMessage["command"]): Promise<unknown> {
	if (command.type === "replace_queue") {
		return serializeQueueMutation(record, async () => {
		const uncertainById = new Map(record.queue
			.filter((item) => item.deliveryState === "delivering")
			.map((item) => [item.id, item]));
		const seenIds = new Set<string>();
		for (const replacement of command.queue) {
			if (seenIds.has(replacement.id)) throw new Error(`Duplicate queue item ${replacement.id}`);
			seenIds.add(replacement.id);
			const uncertain = uncertainById.get(replacement.id);
			if ("deliveryState" in replacement && replacement.deliveryState !== undefined && !uncertain) {
				throw new Error(`Queue item ${replacement.id} cannot set server-owned delivery state`);
			}
			if (uncertain && (replacement.message !== uncertain.message || JSON.stringify(replacement.images ?? []) !== JSON.stringify(uncertain.images ?? []))) {
				throw new Error(`Uncertain queue item ${uncertain.id} requires explicit discard or resubmit`);
			}
		}
		for (const uncertain of uncertainById.values()) {
			if (!seenIds.has(uncertain.id)) throw new Error(`Uncertain queue item ${uncertain.id} requires explicit discard or resubmit`);
		}
		await transactionalQueueMutation({
			get: () => record.queue,
			set: (queue) => setWebQueueState(record, queue),
			clone: cloneWebQueue,
			mutate: (queue) => { queue.splice(0, queue.length, ...command.queue.map((replacement) => ({
				...replacement,
				images: replacement.images?.map((image) => ({ ...image })),
				...(uncertainById.has(replacement.id) ? { deliveryState: "delivering" as const } : {}),
			}))); },
			persist: () => persistWebQueue(record),
		});
		broadcast(record.id, webQueueEvent(record));
		});
	}
	if (command.type === "reconcile_queue") {
		return serializeQueueMutation(record, async () => {
		const item = record.queue.find((queued) => queued.id === command.itemId);
		if (!item || item.deliveryState !== "delivering") throw new Error(`Queue item ${command.itemId} is not uncertain`);
		await transactionalQueueMutation({
			get: () => record.queue,
			set: (queue) => setWebQueueState(record, queue),
			clone: cloneWebQueue,
			mutate: (queue) => {
				const index = queue.findIndex((queued) => queued.id === item.id);
				if (command.action === "discard") queue.splice(index, 1);
				else delete queue[index]!.deliveryState;
			},
			persist: () => persistWebQueue(record),
		});
		broadcast(record.id, webQueueEvent(record));
		if (command.action === "resubmit") setTimeout(() => void flushWebQueue(record), 0);
		});
	}
	if (command.type === "get_commands") {
		if (record.managed) {
			const { commands } = await record.managed.getCommands();
			return { commands: webSlashCommands(parseDiscoveredSlashCommands(commands), true) };
		}
		return { commands: webSlashCommands(await discoverSlashCommands(record.cwd)) };
	}
	if (record.managed) {
		switch (command.type) {
			case "get_session_options": {
				const [{ models }, { levels }, { commands }] = await Promise.all([
					record.managed.getAvailableModels(),
					record.managed.getAvailableThinkingLevels(),
					record.managed.getCommands(),
				]);
				return {
					models: models.map((model) => ({
						provider: String(model.provider ?? ""), id: String(model.id ?? ""),
						name: String(model.name ?? model.id ?? ""), reasoning: model.reasoning === true,
						thinkingLevels: levels,
					})),
					thinkingLevels: levels,
					commands: commands.flatMap((command) => {
						const sourceInfo = isRecord(command.sourceInfo) ? command.sourceInfo : undefined;
						if (typeof command.name !== "string" || (command.source !== "extension" && command.source !== "prompt" && command.source !== "skill")) return [];
						return [{
							name: command.name,
							description: typeof command.description === "string" ? command.description : undefined,
							source: command.source,
							location: sourceInfo && (sourceInfo.scope === "user" || sourceInfo.scope === "project" || sourceInfo.scope === "temporary") ? sourceInfo.scope : undefined,
						}];
					}),
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
				return await record.managed.abort();
			case "bash":
				return await record.managed.bash(command.command);
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
			case "extension_ui_response":
				return await record.managed.respondToExtensionUi(command);
		}
	}
	if (record.agentSockets.size > 0) {
		let externalCommand: ClientCommandMessage["command"] = command;
		if (command.type === "prompt" && command.message.startsWith("/")) {
			const commands = await discoverSlashCommands(record.cwd);
			externalCommand = {
				...command,
				message: await expandSlashCommand(commands, command.message, { rejectExtensionCommands: true }),
			};
		}
		const target = Array.from(record.agentSockets)[0];
		const requestId = randomUUID();
		const data = await new Promise<unknown>((resolve, reject) => {
			const timeoutMs = command.type === "compact" || command.type === "bash"
				? LONG_RUNNING_COMMAND_TIMEOUT_MS
				: 30_000;
			const timeout = setTimeout(() => {
				record.externalPending.delete(requestId);
				record.externalRequestTargets.delete(requestId);
				reject(new Error("Pi session command timed out"));
			}, timeoutMs);
			record.externalPending.set(requestId, {
				resolve: (value) => {
					clearTimeout(timeout);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});
			record.externalRequestTargets.set(requestId, target);
			try {
				target.send(JSON.stringify({ type: "agent.command", requestId, command: externalCommand } satisfies { type: "agent.command"; requestId: string; command: ClientCommandMessage["command"] }));
			} catch (error) {
				record.externalPending.delete(requestId);
				record.externalRequestTargets.delete(requestId);
				clearTimeout(timeout);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
		if (command.type === "get_session_options") {
			const options = isRecord(data) ? data : {};
			if (Array.isArray(options.commands)) return options;
			return { ...options, commands: webSlashCommands(await discoverSlashCommands(record.cwd)) };
		}
		return data;
	}
	if (command.type === "get_fork_messages") {
		return { messages: deriveForkMessages(sessionHistoryForRecord(record)) };
	}
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
		const helloHistory = hello.entries?.length ? hello.entries : undefined;
		const record = upsertSession(hello.session, kind, helloHistory ?? []);
		if (!helloHistory?.length && record.file) {
			const scan = parseSessionFile(record.file);
			if (scan) record.history = scan.history;
		}
		record.agentSockets.add(socket);
		record.active = true;
		record.status = hello.session.status;
		record.updatedAt = hello.session.updatedAt;
		const uncertain = record.queue.find((item) => item.deliveryState === "delivering");
		if (uncertain) {
			broadcastQueueDelivery(
				record,
				uncertain,
				"uncertain",
				"Delivery was interrupted by a daemon restart; edit or remove this item explicitly before resubmitting.",
			);
		}
		if (record.file) sessionsByFile.set(normalizePath(record.file), record);
		broadcast(record.id, { type: "server.session", session: sessionToClientPayload(hello.session) } satisfies ServerSessionMessage);
		// Native sessions use the same bounded semantic history as managed sessions;
		// no browser connection asks Pi to paint an additional TUI viewport.
		broadcast(record.id, { type: "server.history", sessionId: record.id, entries: record.history.slice(-600) } satisfies ServerHistoryMessage);
		void flushWebQueue(record);
		return;
	}
	if (!socket.data.authed) throw new Error("Agent must send agent.hello first");
	if (message.type === "agent.event") {
		const event = message as AgentEventMessage;
		const record = sessions.get(event.sessionId);
		if (record) {
			record.updatedAt = Date.now();
			if (event.event.type === "agent_start" || event.event.type === "turn_start") record.status = "working";
			if (event.event.type === "compaction_start") {
				record.status = "working";
				record.compaction = {
					reason: event.event.reason === "manual" || event.event.reason === "overflow" ? event.event.reason : "threshold",
					startedAt: typeof event.event.startedAt === "number" ? event.event.startedAt : Date.now(),
				};
			}
			if (event.event.type === "compaction_end") record.compaction = undefined;
			if (event.event.type === "agent_settled") {
				record.status = "idle";
				void flushWebQueue(record);
			}
			const subagentsChanged = updateSubagentsFromToolEvent(record, event.event);
			let sessionMetadataChanged = false;
			if (event.event.type === "message_end" && isRecord(event.event.message)) {
				record.history.push({
					type: "message",
					id: randomUUID(),
					parentId: null,
					timestamp: new Date().toISOString(),
					message: event.event.message,
				});
				record.history = record.history.slice(-600);
				record.messageCount += 1;
				if (event.event.message.role === "assistant" || event.event.message.role === "toolResult") {
					record.usage ??= zeroWebUsage();
					addWebUsage(record.usage, event.event.message.usage);
				}
				if (event.event.message.role === "user" || event.event.message.role === "assistant") {
					const preview = extractTextContent(event.event.message.content);
					if (preview) record.preview = preview.slice(0, 180);
				}
				sessionMetadataChanged = true;
			}
			broadcast(event.sessionId, { type: "server.event", sessionId: event.sessionId, event: event.event } satisfies ServerEventMessage);
			if (sessionMetadataChanged) {
				broadcastToAll({ type: "server.session", session: sessionToClientPayload(record) } satisfies ServerSessionMessage);
			} else if (subagentsChanged || event.event.type === "compaction_start" || event.event.type === "compaction_end") {
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
		return;
	}
	if (message.type === "agent.update") {
		const update = message as AgentUpdateMessage;
		const existing = sessions.get(update.session.id);
		const record = upsertSession(update.session, "external", existing?.history ?? []);
		record.agentSockets.add(socket);
		record.updatedAt = update.session.updatedAt;
		broadcast(update.session.id, { type: "server.session", session: sessionToClientPayload(update.session) } satisfies ServerSessionMessage);
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
		else pending.reject(new Error(response.error ?? "Agent command failed"));
	}
}

async function deleteSessionRecord(record: SessionRecord, file?: string): Promise<void> {
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
		// Make queue removal durable before deleting the file, maps, or sockets.
		// A failed store write leaves the complete session available for retry.
		await queueStoreWriter.mutate(persistedQueues, (queues) => { queues.delete(record.id); });
	} catch (error) {
		finishQueueQuiescence();
		throw error;
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
	for (const socket of record.clientSockets) {
		try {
			socket.close();
		} catch {
			// ignore
		}
	}
	for (const socket of record.agentSockets) {
		try {
			socket.close();
		} catch {
			// ignore
		}
	}
}

async function stopRecord(record: SessionRecord): Promise<void> {
	if (record.managed) {
		await record.managed.shutdown();
		record.managed = undefined;
	}
	record.active = false;
	record.status = "offline";
}

async function deleteSession(sessionId: string): Promise<void> {
	const record = sessions.get(sessionId) ?? sessionsByFile.get(normalizePath(sessionId));
	if (!record) throw new Error(`Unknown session: ${sessionId}`);
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
	sendSessionRemoved(sessionId);
}

async function handleApi(request: Request): Promise<Response> {
	const url = new URL(request.url);
	if (
		url.pathname.startsWith("/api/") &&
		request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS" &&
		!isTrustedBrowserOrigin(request)
	) {
		return textResponse("Forbidden origin", { status: 403 });
	}
	if (request.method === "GET" && url.pathname === "/api/health") {
		return jsonResponse({
			ok: true,
			pid: process.pid,
			port,
			stateFile: stateFilePath,
			tailscale: tailscaleStatus,
		});
	}
	if (request.method === "POST" && url.pathname === "/api/tailscale") {
		const body = await request.json().catch(() => undefined) as { enabled?: unknown; httpsPort?: unknown; serviceName?: unknown } | undefined;
		if (!body || typeof body.enabled !== "boolean") return badRequest("Missing enabled boolean");
		const current = await readTailscaleWebSettings(settingsPath);
		const settings: TailscaleWebSettings = {
			enabled: body.enabled,
			httpsPort: typeof body.httpsPort === "number" && Number.isInteger(body.httpsPort) && body.httpsPort >= 1 && body.httpsPort <= 65_535
				? body.httpsPort
				: current.httpsPort,
			serviceName: typeof body.serviceName === "string"
				? body.serviceName.trim().replace(/^svc:/, "") || undefined
				: current.serviceName,
		};
		const status = settings.enabled
			? await configureTailscaleServe(settings, current)
			: await removeTailscaleServe(current);
		return jsonResponse({ tailscale: status });
	}
	if (request.method === "GET" && url.pathname === "/api/sessions") {
		const scans = scanSavedSessions(sessionsDir);
		for (const scan of scans) {
			const existing = sessions.get(scan.session.id) ?? sessionsByFile.get(normalizePath(scan.file));
			if (!existing || !existing.active || existing.status === "offline") {
				upsertSession(scan.session, "saved", scan.history);
			}
		}
		const merged = new Map<string, WebSession>();
		for (const scan of scans) merged.set(scan.session.file ? normalizePath(scan.session.file) : scan.session.id, sessionToClientPayload(scan.session));
		for (const item of sessions.values()) merged.set(item.file ? normalizePath(item.file) : item.id, sessionToClientPayload(item));
		return jsonResponse({ sessions: sortSessions(Array.from(merged.values())) });
	}
	if (request.method === "POST" && url.pathname === "/api/sessions") {
		const body = (await request.json().catch(() => undefined)) as CreateSessionRequest | undefined;
		if (!body) return badRequest("Missing session request");
		const requestedCwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
		const worktreeName = typeof body.worktreeName === "string" ? body.worktreeName.trim() : "";
		if (Boolean(requestedCwd) === Boolean(worktreeName)) return badRequest("Specify either cwd or worktreeName, but not both");

		let cwd: string;
		let worktree: ReturnType<typeof createWebWorktree> | undefined;
		if (worktreeName) {
			const baseSessionId = typeof body.worktreeBaseSessionId === "string" ? body.worktreeBaseSessionId.trim() : "";
			const baseSession = baseSessionId ? sessions.get(baseSessionId) : undefined;
			if (!baseSession) return badRequest("Unknown worktree base session");
			if (!resolveSessionProject(baseSession.cwd).id.startsWith("git:")) return badRequest("Worktree base session is not in a Git repository");
			try {
				if (!statSync(baseSession.cwd).isDirectory()) return badRequest(`base session cwd is not a directory: ${baseSession.cwd}`);
				worktree = createWebWorktree(baseSession.cwd, worktreeName);
				cwd = worktree.path;
			} catch (error) {
				return badRequest(error instanceof Error ? error.message : String(error));
			}
		} else {
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
		}
		let session: SessionRecord;
		try {
			session = await createManagedSession(cwd, body.name);
		} catch (error) {
			if (worktree) {
				const startupMessage = error instanceof Error ? error.message : String(error);
				throw new Error(`${startupMessage}; initialized worktree retained at ${worktree.path} for inspection`);
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
		const scan = parseSessionFile(file);
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

function staticAssetResponse(request: Request): Response | undefined {
	const url = new URL(request.url);
	if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) return undefined;
	const pathname = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
	const filePath = resolve(distDir, pathname);
	if (!isWithinDir(filePath, distDir)) return new Response("Forbidden", { status: 403 });
	try {
		statSync(filePath);
		return new Response(Bun.file(filePath));
	} catch {
		try {
			statSync(join(distDir, "index.html"));
			return new Response(Bun.file(join(distDir, "index.html")));
		} catch {
			return notFound();
		}
	}
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
				socket.close(1011, "WebSocket message failed");
			}
		} catch {
			// ignore
		}
	}
}

function handleWebSocketClose(socket: Bun.ServerWebSocket<SocketData>): void {
	if (socket.data.kind === "client") {
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
			if (pending) {
				record.externalPending.delete(requestId);
				pending.reject(new Error("Agent socket closed"));
			}
		}
		if (record.agentSockets.size === 0 && record.kind === "external") {
			record.status = "offline";
			record.active = false;
			broadcast(record.id, { type: "server.session", session: sessionToClientPayload(record) } satisfies ServerSessionMessage);
		}
	}
}

async function cleanupAndExit(code = 0): Promise<void> {
	if (shutdownStarted) return;
	shutdownStarted = true;
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
	webState = getOrCreateWebState();
	for (const scan of scanSavedSessions(sessionsDir)) {
		upsertSession(scan.session, "saved", scan.history);
	}
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
				if (!isTrustedBrowserOrigin(request)) return new Response("Forbidden WebSocket origin", { status: 403 });
				const upgraded = serverInstance.upgrade(request, { data: { kind: "client", id: randomUUID(), authed: false } as any });
				return upgraded ? undefined : new Response("Upgrade failed", { status: 400 });
			}
			if (url.pathname === "/ws/agent") {
				// The Pi bridge is a non-browser localhost client and sends no Origin.
				// Reject every browser-originated attempt, including same-origin pages.
				if (request.headers.has("origin")) return new Response("Forbidden WebSocket origin", { status: 403 });
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
}

void main().catch((error) => {
	console.error(error);
	process.exit(1);
});
