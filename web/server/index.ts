import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
	AgentEventMessage,
	AgentHelloMessage,
	AgentResponseMessage,
	AgentSessionReplacedMessage,
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
import { compareWebSessions, DEFAULT_WEB_PORT, hasActiveWebSubagents, mergeWebSubagentUpdates, WEB_STATE_VERSION } from "../protocol.js";
import { expandSlashCommand, type ExpandableSlashCommand } from "../slash-commands.js";
import { isWebReloadCommand } from "../reload-command.js";
import { formatWorktreeCreateCommandArgs, parseWorktreeInvocation, WORKTREE_USAGE } from "../worktree-command.js";
import { replacementFromEntries } from "../worktree-replacement.js";
import { resolveSessionProject } from "./projects.js";
import { resolveWebCwd } from "./paths.js";
import {
	createWebWorktree,
	hasOtherSessionInWorktree,
	managedWorktreeFromEntries,
	removeManagedWorktree,
	WORKTREE_SESSION_ENTRY,
	type ManagedWorktree,
} from "./worktrees.js";
import { CoalescedQueueStoreWriter, readQueueStore } from "./queue-store.js";
import { ManagedSessionStore } from "./managed-session-store.js";
import { persistPreDeliveryTransition, queueDeliveryFailureDisposition } from "./queue-delivery.js";
import { preserveRetryAroundQuiescence, quiesceQueueMutations, serializeQueueMutation, transactionalQueueMutation } from "./queue-mutation.js";
import { DirtySnapshotRetryWorker } from "./dirty-snapshot-worker.js";
import { runManagedRefresh, serializeManagedRefresh } from "./refresh-policy.js";
import { shouldContinueManagedShutdownWait, shouldWaitForManagedShutdown } from "./shutdown-policy.js";
import { isConfirmedMissingPath } from "./file-presence.js";
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

type ExternalPendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	surviveDisconnect?: boolean;
	commandType?: ClientCommandMessage["command"]["type"];
	owner?: SessionRecord;
};

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
	/** Last authoritative agent lifecycle state; guards against stale bridge updates. */
	agentRunning?: boolean;
	agentStartGeneration?: number;
	/** RPC runtime used only for saved-session management operations. */
	managed?: ManagedRpcSession;
	agentSockets: Set<Bun.ServerWebSocket<AgentSocketData>>;
	clientSockets: Set<Bun.ServerWebSocket<ClientSocketData>>;
	externalRequestTargets: Map<string, Bun.ServerWebSocket<AgentSocketData>>;
	externalPending: Map<string, ExternalPendingRequest>;
	queue: WebQueuedMessage[];
	queueMutationTail?: Promise<void>;
	queueMutationsQuiesced?: boolean;
	queueDeliveryActive?: string;
	queueDeliveryAttempts?: { itemId: string; count: number };
	queueTransitionAttempts?: { itemId: string; count: number };
	queueRetryTimer?: ReturnType<typeof setTimeout>;
	queueSettleFallbackTimer?: ReturnType<typeof setTimeout>;
	queueDirtyWorker?: DirtySnapshotRetryWorker;
	managedRefreshTail?: Promise<void>;
	managedIdentityOperation?: ClientCommandMessage["command"]["type"];
	managedWorktree?: ManagedWorktree;
	pendingWorktreeSourceDeletion?: { sessionId: string; sessionFile: string };
};

type SessionFileScan = {
	session: WebSession;
	file: string;
	history: unknown[];
	entries: unknown[];
	header?: Record<string, unknown>;
	managedWorktreeScanned?: boolean;
	replacement?: ReturnType<typeof replacementFromEntries>;
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
const managedSessionStorePath = join(dirname(stateFilePath), "managed-sessions.json");
const persistedQueues = readQueueStore(queueStorePath);
const queueStoreWriter = new CoalescedQueueStoreWriter(queueStorePath);
const managedSessionStore = new ManagedSessionStore(managedSessionStorePath);
const configuredPort = Number(process.env.PI_WEB_PORT ?? `${DEFAULT_WEB_PORT}`);
let port = Number.isInteger(configuredPort) && configuredPort >= 0 && configuredPort <= 65_535 ? configuredPort : DEFAULT_WEB_PORT;
const host = "127.0.0.1";
const configuredRpcTimeout = Number(process.env.PI_WEB_RPC_TIMEOUT_MS ?? "30000");
const RPC_REQUEST_TIMEOUT_MS = Number.isFinite(configuredRpcTimeout) && configuredRpcTimeout > 0
	? Math.floor(configuredRpcTimeout)
	: 30_000;
const LONG_RUNNING_COMMAND_TIMEOUT_MS = 10 * 60_000;
const MISSING_SESSION_RECONCILE_INTERVAL_MS = 1_000;
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
const managedSessionStarts = new Map<string, Promise<SessionRecord>>();
const missingSessionReconciliations = new Set<SessionRecord>();
const slashCommandCache = new Map<string, { loadedAt: number; commands: DiscoveredSlashCommand[] }>();
let server: Bun.Server<any> | undefined;
let missingSessionReconcileTimer: ReturnType<typeof setInterval> | undefined;
let shutdownStarted = false;
let forceShutdownRequested = false;
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
	const resolved = normalize(resolve(path));
	try { return realpathSync(resolved); } catch { return resolved; }
}

function sessionFileKey(path: string): string {
	return normalizePath(path);
}

function isManagedSessionFile(file: string): boolean {
	return managedSessionStore.has(sessionFileKey(file));
}

function replaceManagedSessionFile(previousFile: string | undefined, nextFile: string): void {
	managedSessionStore.replace(previousFile && sessionFileKey(previousFile), sessionFileKey(nextFile));
	if (previousFile) {
		savedSessionMetadataCache.delete(previousFile);
		savedSessionMetadataCache.delete(sessionFileKey(previousFile));
	}
	savedSessionMetadataCache.delete(nextFile);
	savedSessionMetadataCache.delete(sessionFileKey(nextFile));
}

function deleteManagedSessionFile(file: string): void {
	managedSessionStore.delete(sessionFileKey(file));
	savedSessionMetadataCache.delete(file);
	savedSessionMetadataCache.delete(sessionFileKey(file));
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

function persistInitialSession(manager: SessionManager): string {
	const file = manager.getSessionFile();
	if (!file) throw new Error("Pi did not allocate a session file");
	const header = manager.getHeader();
	if (!header) throw new Error("Pi did not initialize a session header");
	const entries = [header, ...manager.getEntries()];
	writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx", mode: 0o600 });
	return file;
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
			source: isManagedSessionFile(file) ? "web" : "saved",
			createdAt: typeof header?.timestamp === "string" ? Date.parse(header.timestamp) || stats.birthtimeMs : stats.birthtimeMs,
			updatedAt: stats.mtimeMs,
			messageCount: meta.messageCount ?? 0,
			preview: extractPreviewFromHistory(rawEntries),
			parentSession: typeof header?.parentSession === "string" ? header.parentSession : undefined,
			managedWorktree: managedWorktreeFromEntries(rawEntries),
			usage: usageFromEntries(rawEntries),
		};
		return {
			session,
			file,
			history: rawEntries,
			entries: rawEntries,
			header: header ?? undefined,
			managedWorktreeScanned: true,
			replacement: replacementFromEntries(rawEntries),
		};
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
		const metadataEntries: Record<string, unknown>[] = [];
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
			if (entry.type === "custom") metadataEntries.push(entry);
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
		// Resolve all markers together so malformed newer entries are skipped while
		// an explicit `{ managed: false }` still clears earlier ownership.
		const managedWorktree = managedWorktreeFromEntries(metadataEntries);
		const session: WebSession = {
			id,
			file,
			cwd,
			name,
			model,
			thinkingLevel,
			status: "offline",
			source: isManagedSessionFile(file) ? "web" : "saved",
			createdAt: typeof header?.timestamp === "string" ? Date.parse(header.timestamp) || stats.birthtimeMs : stats.birthtimeMs,
			updatedAt: stats.mtimeMs,
			messageCount,
			preview,
			parentSession: typeof header?.parentSession === "string" ? header.parentSession : undefined,
			managedWorktree,
			usage,
		};
		const scan: SessionFileScan = {
			session,
			file,
			history: [],
			entries: [],
			header: header ?? undefined,
			managedWorktreeScanned: true,
			replacement: replacementFromEntries(metadataEntries),
		};
		savedSessionMetadataCache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, scan });
		return scan;
	} catch {
		return undefined;
	}
}

function listSavedSessionFiles(dir: string): string[] {
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
	return files;
}

function removeMissingSessionMetadata(dir: string, files: readonly string[]): void {
	const discovered = new Set(files);
	for (const file of savedSessionMetadataCache.keys()) {
		if (isWithinDir(file, dir) && !discovered.has(file)) savedSessionMetadataCache.delete(file);
	}
}

function scanSavedSessions(dir: string): SessionFileScan[] {
	const files = listSavedSessionFiles(dir);
	const scans: SessionFileScan[] = [];
	for (const file of files) {
		const scan = parseSessionMetadataFile(file);
		if (scan) scans.push(scan);
	}
	removeMissingSessionMetadata(dir, files);
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

function makeSessionRecord(
	session: WebSession,
	kind: SessionKind,
	history: unknown[] = [],
	managedWorktreeScanned = false,
): SessionRecord {
	const record = sessions.get(session.id) ?? {
		...session,
		kind,
		history: [...history],
		active: kind !== "saved",
		agentRunning: session.status === "working",
		agentSockets: new Set<Bun.ServerWebSocket<AgentSocketData>>(),
		clientSockets: new Set<Bun.ServerWebSocket<ClientSocketData>>(),
		externalRequestTargets: new Map<string, Bun.ServerWebSocket<AgentSocketData>>(),
		externalPending: new Map(),
		queue: (persistedQueues.get(session.id) ?? []).map((item) => ({ ...item, images: item.images?.map((image) => ({ ...image })) })),
	};
	Object.assign(record, session);
	record.kind = kind;
	record.history = history.length > 0 ? [...history] : record.history;
	record.managedWorktree = managedWorktreeScanned
		? session.managedWorktree
		: managedWorktreeFromEntries(record.history) ?? session.managedWorktree;
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
	Object.assign(record, session);
	record.kind = kind;
	if (history.length > 0) record.history = [...history];
	record.managedWorktree = managedWorktreeScanned
		? session.managedWorktree
		: managedWorktreeFromEntries(record.history) ?? session.managedWorktree;
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

function broadcastSessionToAll(record: SessionRecord): void {
	if (sessions.get(record.id) !== record) return;
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

function sessionSnapshot(): WebSession[] {
	void reconcileMissingSessionFiles();
	const merged = new Map<string, WebSession>();
	for (const record of sessions.values()) {
		if (isMissingInactiveSession(record)) continue;
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
		const scan = parseSessionFile(s.sessionFile);
		if (scan?.session.cwd) record.cwd = scan.session.cwd;
	}
	if (typeof s.sessionId === "string") record.id = s.sessionId;
	record.name = typeof s.sessionName === "string" && s.sessionName ? s.sessionName : undefined;
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
	broadcastSessionToAll(record);
}

class CommandRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CommandRejectedError";
	}
}

class CommandDeliveryUncertainError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CommandDeliveryUncertainError";
	}
}

class ManagedRpcSession {
	private readonly options: ManagedRpcSessionOptions;
	private process: Bun.Subprocess | undefined;
	private stdoutBuffer = "";
	private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; command: string }>();
	private stopped = false;
	private readonly requestPrefix = `web-${randomUUID()}`;
	private pendingStart: Promise<void> | undefined;
	private worktreeError: Error | undefined;
	private reloadError: Error | undefined;
	private reloadInFlight: Promise<void> | undefined;

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
		const reader = stream.getReader();
		try {
			// Keep the pipe drained so the child cannot block, but do not retain its
			// unbounded diagnostics for the lifetime of the managed session.
			while (!(await reader.read()).done) {
				// discarded
			}
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
		if (parsed.type === "extension_error" && typeof parsed.error === "string") {
			if (parsed.extensionPath === "command:worktree") this.worktreeError = new Error(parsed.error);
			if (parsed.extensionPath === "command:web-reload") this.reloadError = new Error(parsed.error);
		}
		if (parsed.type === "response") {
			const response = parsed as RpcResponse;
			const responseId = typeof response.id === "string" ? response.id : undefined;
			if (responseId && this.pending.has(responseId)) {
				const pending = this.pending.get(responseId)!;
				this.pending.delete(responseId);
				if (response.success) pending.resolve((response as RpcResponse & { data?: unknown }).data);
				else pending.reject(new CommandRejectedError(response.error));
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
				pending.reject(pending.command === "prompt"
					? new CommandDeliveryUncertainError(error.message)
					: error);
			} catch {
				// ignore
			}
		}
	}

	private async waitForPendingRequests(): Promise<void> {
		const deadline = Date.now() + RPC_REQUEST_TIMEOUT_MS;
		while (this.pending.size > 0) {
			if (Date.now() >= deadline) {
				const commands = [...this.pending.values()].map((pending) => pending.command).join(", ");
				throw new Error(`Could not reload while RPC commands are still pending: ${commands}`);
			}
			await Bun.sleep(10);
		}
	}

	async send<T = unknown>(
		command: Record<string, unknown>,
		timeoutMs: number | null = RPC_REQUEST_TIMEOUT_MS,
		bypassReloadBarrier = false,
	): Promise<T> {
		if (!bypassReloadBarrier && this.reloadInFlight) await this.reloadInFlight;
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
					const message = `RPC command ${pending.command} timed out after ${timeoutMs}ms`;
					pending.reject(pending.command === "prompt" ? new CommandDeliveryUncertainError(message) : new Error(message));
				}, timeoutMs);
			}
			void this.writeLine(`${JSON.stringify(payload)}\n`).catch((error: unknown) => {
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);
				const cause = error instanceof Error ? error : new Error(String(error));
				pending.reject(commandName === "prompt" ? new CommandDeliveryUncertainError(cause.message) : cause);
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

	async reload(): Promise<void> {
		if (this.reloadInFlight) return await this.reloadInFlight;
		const operation = (async () => {
			// Resource reload invalidates the current extension runner. Quiesce ordinary
			// RPC traffic first so model/command discovery cannot race that invalidation.
			await this.waitForPendingRequests();
			const commands = await this.send<{ commands: Array<Record<string, unknown>> }>({ type: "get_commands" }, RPC_REQUEST_TIMEOUT_MS, true);
			const generation = commands.commands.find((command) => command.name === "web-reload")?.description;
			if (typeof generation !== "string") throw new Error("The managed Pi runtime does not expose web reload support");
			this.reloadError = undefined;
			await this.send({ type: "prompt", message: "/web-reload" }, LONG_RUNNING_COMMAND_TIMEOUT_MS, true);
			const deadline = Date.now() + LONG_RUNNING_COMMAND_TIMEOUT_MS;
			while (Date.now() < deadline) {
				if (this.reloadError) throw this.reloadError;
				const nextCommands = await this.send<{ commands: Array<Record<string, unknown>> }>({ type: "get_commands" }, RPC_REQUEST_TIMEOUT_MS, true);
				const next = nextCommands.commands.find((command) => command.name === "web-reload")?.description;
				if (typeof next === "string" && next !== generation) return;
				await Bun.sleep(25);
			}
			throw new Error("Pi reload timed out");
		})();
		this.reloadInFlight = operation;
		try {
			await operation;
		} finally {
			if (this.reloadInFlight === operation) this.reloadInFlight = undefined;
		}
	}

	async prompt(
		message: string,
		streamingBehavior?: "steer" | "followUp",
		images?: Array<{ type: "image"; data: string; mimeType: string }>,
	): Promise<void> {
		await this.send({ type: "prompt", message, images, streamingBehavior });
	}

	async worktree(message: string): Promise<void> {
		const before = await this.getState() as { sessionId?: unknown };
		const previousId = typeof before.sessionId === "string" ? before.sessionId : undefined;
		this.worktreeError = undefined;
		// RPC acknowledges prompt preflight before an extension command's async
		// handler finishes, so wait for its replacement ID or extension error.
		await this.send({ type: "prompt", message }, LONG_RUNNING_COMMAND_TIMEOUT_MS);
		const deadline = Date.now() + LONG_RUNNING_COMMAND_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (this.worktreeError) throw this.worktreeError;
			const state = await this.getState() as { sessionId?: unknown };
			if (typeof state.sessionId === "string" && state.sessionId !== previousId) {
				const replacement = replacementFromEntries((await this.getEntries()).entries);
				if (
					replacement &&
					replacement.previousSessionId === previousId &&
					replacement.replacementSessionId === state.sessionId
				) return;
			}
			await Bun.sleep(25);
		}
		throw new Error("Pi worktree switch timed out");
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
		try {
			await this.send({ type: "abort" }, RPC_REQUEST_TIMEOUT_MS, true);
		} catch {
			// ignore
		}
		this.stopped = true;
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
	const visible = commands
		.filter((command) => command.name !== "web-reload" && (includeExtensions || command.source === "prompt" || command.source === "skill" || command.name === "worktree"))
		.map((command) => ({
			name: command.name,
			description: command.description,
			source: command.source,
			location: command.sourceInfo.scope,
		}));
	if (!visible.some((command) => command.name === "reload")) {
		visible.unshift({ name: "reload", description: "Reload extensions, skills, prompts, themes, and context files", source: "extension", location: "temporary" });
	}
	return visible;
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

async function enqueueWebFollowUp(record: SessionRecord, item: WebQueuedMessage): Promise<void> {
	await serializeQueueMutation(record, async () => {
		await transactionalQueueMutation({
			get: () => record.queue,
			set: (queue) => setWebQueueState(record, queue),
			clone: cloneWebQueue,
			mutate: (queue) => { queue.push(item); },
			persist: () => persistWebQueue(record),
		});
		broadcast(record.id, webQueueEvent(record));
		if (record.status === "idle" && record.agentRunning !== true) scheduleQueueSettleFallback(record);
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

function cancelQueueSettleFallback(record: SessionRecord): void {
	if (record.queueSettleFallbackTimer) clearTimeout(record.queueSettleFallbackTimer);
	record.queueSettleFallbackTimer = undefined;
}

function scheduleQueueSettleFallback(record: SessionRecord): void {
	if (record.queueSettleFallbackTimer || record.queue.length === 0) return;
	// Older native bridges did not forward agent_settled. Give Pi's extension
	// hooks time to finish, then advance the queue when no newer run has started.
	record.queueSettleFallbackTimer = setTimeout(() => {
		record.queueSettleFallbackTimer = undefined;
		if (sessions.get(record.id) !== record || record.agentRunning !== false) return;
		void flushWebQueue(record);
	}, 100);
	record.queueSettleFallbackTimer.unref?.();
}

function cancelWebQueueWork(record: SessionRecord): void {
	if (record.queueRetryTimer) clearTimeout(record.queueRetryTimer);
	record.queueRetryTimer = undefined;
	cancelQueueSettleFallback(record);
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

function broadcastReloadComplete(record: SessionRecord): void {
	broadcast(record.id, {
		type: "server.event",
		sessionId: record.id,
		event: {
			type: "message_end",
			message: {
				role: "assistant",
				timestamp: Date.now(),
				content: [{ type: "text", text: "Reload complete." }],
			},
		},
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
	if (shutdownStarted) return;
	return serializeQueueMutation(record, () => flushWebQueueLocked(record));
}

async function flushWebQueueLocked(record: SessionRecord): Promise<void> {
	if (record.queue.length === 0 || record.queueDeliveryActive || record.status !== "idle" || hasActiveWebSubagents(record.subagents)) return;
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
		if (isWebReloadCommand(item.message)) {
			if (item.images?.length) throw new Error("/reload does not accept image attachments");
			// Queued control commands execute through their dedicated route only after
			// the current run reaches idle; never turn /reload into an ordinary prompt.
			await routeCommand(record, { type: "reload" });
			broadcastReloadComplete(record);
		} else {
			await routeCommand(record, {
				type: "prompt",
				message: item.message,
				images: item.images,
				// If an older bridge reports agent_end before Pi fully settles, keep this
				// as a safe Pi follow-up rather than accidentally steering the completed run.
				streamingBehavior: "followUp",
			});
		}
		accepted = true;
	} catch (error) {
		if (error instanceof CommandDeliveryUncertainError) {
			const message = error.message;
			broadcastQueueDelivery(record, item, "uncertain", `${message}; delivery may already have been accepted, so explicitly discard or confirm resubmission.`);
			broadcast(record.id, webQueueEvent(record));
			return;
		}
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

function sendSessionRemoved(
	sessionId: string,
	replacementSessionId?: string,
	additionalSockets: Iterable<Bun.ServerWebSocket<ClientSocketData>> = [],
): void {
	const payload: ServerSessionRemovedMessage = { type: "server.session_removed", sessionId, replacementSessionId };
	const message = JSON.stringify(payload);
	const notified = new Set<Bun.ServerWebSocket<ClientSocketData>>();
	for (const record of sessions.values()) {
		for (const socket of record.clientSockets) {
			if (notified.has(socket)) continue;
			notified.add(socket);
			try { socket.send(message); } catch { /* ignore */ }
		}
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
	const durableReplacement = replacementFromEntries(
		next.file ? parseSessionFile(next.file)?.entries ?? [] : next.history,
	);
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
					const marker = replacementFromEntries((await managed.getEntries()).entries);
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
				record.history = (await managed.getEntries()).entries;
				record.managedWorktree = managedWorktreeFromEntries(record.history);
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

async function createManagedSessionUnlocked(cwd: string, name?: string, sessionFile?: string): Promise<SessionRecord> {
	const resumed = sessionFile ? parseSessionFile(sessionFile) : undefined;
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
		history: resumed?.history ?? [],
		active: true,
		agentSockets: new Set(),
		clientSockets: existingRecord?.clientSockets ?? new Set(),
		externalRequestTargets: new Map(),
		externalPending: new Map(),
		queue: cloneWebQueue(existingRecord?.queue ?? persistedQueues.get(resumed?.session.id ?? "") ?? []),
		// A newly started RPC runtime has no surviving subagents. An explicit empty
		// snapshot clears stale browser telemetry retained across daemon reconnects.
		subagents: [],
		managedWorktree: managedWorktreeFromEntries(resumed?.entries ?? []),
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
			if (event.type === "agent_start" || event.type === "turn_start") {
				record.agentStartGeneration = (record.agentStartGeneration ?? 0) + 1;
			}
			if (event.type === "agent_start" || event.type === "turn_start") {
				cancelQueueSettleFallback(record);
				record.status = "working";
				record.agentRunning = true;
			}
			if (event.type === "agent_end" && !record.compaction) {
				record.status = "idle";
				record.agentRunning = false;
				scheduleQueueSettleFallback(record);
			}
			if (event.type === "compaction_start") {
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
			if (event.type === "agent_settled") {
				cancelQueueSettleFallback(record);
				// A prompt may have been accepted during an agent_end compatibility
				// fallback. In that case this settlement belongs to the previous run.
				if (record.agentRunning !== true) {
					record.status = "idle";
					record.agentRunning = false;
					void refreshManagedSession(record, true);
					void flushWebQueue(record);
				}
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
			record.history = (await managed.getEntries()).entries;
			record.managedWorktree = managedWorktreeFromEntries(record.history);
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
			restoreExistingQueueIntake?.();
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
		const scan = parseSessionFile(file);
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
		if (message.type === "client.hello") sendSessionSnapshot(socket);
		return;
	}
	if (!socket.data.authed) throw new Error("Client must send a hello message first");
	if (shutdownStarted && (message.type === "client.prompt" || message.type === "client.command")) {
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
			await refreshManagedSession(record);
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
	const agentStartGeneration = record.agentStartGeneration ?? 0;
	if (shouldMarkWorking) {
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
	if (command.type === "steer_queue_item") {
		return serializeQueueMutation(record, async () => {
			if (record.queueDeliveryActive) throw new Error("Another queued message is already being delivered");
			const queued = record.queue.find((item) => item.id === command.itemId);
			if (!queued) throw new Error(`Unknown queue item ${command.itemId}`);
			if (queued.deliveryState === "delivering") throw new Error(`Queue item ${command.itemId} has uncertain delivery`);

			// Make the in-flight disposition durable before handing the item to Pi. If
			// the daemon exits after acceptance but before cleanup, restart recovery
			// leaves the item uncertain rather than silently sending it twice.
			await transactionalQueueMutation({
				get: () => record.queue,
				set: (queue) => setWebQueueState(record, queue),
				clone: cloneWebQueue,
				mutate: (queue) => {
					const item = queue.find((candidate) => candidate.id === command.itemId);
					if (!item) throw new Error(`Unknown queue item ${command.itemId}`);
					item.deliveryState = "delivering";
				},
				persist: () => persistWebQueue(record),
			});
			const item = record.queue.find((candidate) => candidate.id === command.itemId)!;
			record.queueDeliveryActive = item.id;
			broadcast(record.id, webQueueEvent(record));
			broadcastQueueDelivery(record, item, "started");
			try {
				await routeCommand(record, {
					type: "prompt",
					message: item.message,
					images: item.images,
					// If the previous run settled during the durable transition, start the
					// queued prompt immediately instead of steering a run that no longer exists.
					streamingBehavior: record.status === "working" ? "steer" : undefined,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (error instanceof CommandDeliveryUncertainError) {
					broadcastQueueDelivery(record, item, "uncertain", `${message}; delivery may already have been accepted, so explicitly discard or confirm resubmission.`);
					broadcast(record.id, webQueueEvent(record));
					throw error;
				}
				broadcastQueueDelivery(record, item, "failed", message);
				try {
					await transactionalQueueMutation({
						get: () => record.queue,
						set: (queue) => setWebQueueState(record, queue),
						clone: cloneWebQueue,
						mutate: (queue) => {
							const retryable = queue.find((candidate) => candidate.id === item.id);
							if (retryable) delete retryable.deliveryState;
						},
						persist: () => persistWebQueue(record),
					});
					broadcast(record.id, webQueueEvent(record));
				} catch (persistenceError) {
					const persistenceMessage = persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
					const uncertain = record.queue.find((candidate) => candidate.id === item.id);
					if (uncertain) {
						uncertain.deliveryState = "delivering";
						broadcastQueueDelivery(record, uncertain, "uncertain", `Could not persist steer failure: ${persistenceMessage}; explicitly discard or confirm resubmission.`);
						broadcast(record.id, webQueueEvent(record));
					}
					throw new Error(`${message}; could not persist queued-message recovery: ${persistenceMessage}`);
				}
				throw error;
			} finally {
				record.queueDeliveryActive = undefined;
			}

			// Pi accepted the steer. Remove it from memory immediately and persist the
			// accepted-removal snapshot in the bounded dirty worker; it is never retried.
			record.queue = record.queue.filter((candidate) => candidate.id !== item.id);
			broadcast(record.id, webQueueEvent(record));
			markWebQueueSnapshotDirty(record);
		});
	}
	if (command.type === "replace_queue") {
		return serializeQueueMutation(record, async () => {
		const uncertainById = new Map(record.queue
			.filter((item) => item.deliveryState === "delivering")
			.map((item) => [item.id, item]));
		const seenIds = new Set<string>();
		for (const replacement of command.queue) {
			if (seenIds.has(replacement.id)) throw new Error(`Duplicate queue item ${replacement.id}`);
			if (isWebReloadCommand(replacement.message) && replacement.images?.length) throw new Error("/reload does not accept image attachments");
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
		if (record.status === "idle" && record.agentRunning !== true && record.queue.length > 0) scheduleQueueSettleFallback(record);
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
	if (command.type === "reload" && record.managed) {
		if (record.status !== "idle" || hasActiveWebSubagents(record.subagents)) throw new Error("Wait for Pi and its subagents to become idle before reloading");
		await record.managed.reload();
		await refreshManagedSession(record);
		record.status = "idle";
		broadcast(record.id, { type: "server.session", session: sessionToClientPayload(record) } satisfies ServerSessionMessage);
		slashCommandCache.delete(normalizePath(record.cwd));
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
			return { commands: webSlashCommands(parseDiscoveredSlashCommands(commands), true) };
		}
		return { commands: webSlashCommands(await discoverSlashCommands(record.cwd)) };
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
				void record.managed.abort().catch((error) => {
					console.error(`Managed Stop failed after acknowledgement for ${record.id}: ${error instanceof Error ? error.message : String(error)}`);
				});
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
			const commands = await discoverSlashCommands(record.cwd);
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
				reject(command.type === "prompt" ? new CommandDeliveryUncertainError(message) : new Error(message));
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
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
		if (command.type === "get_session_options") {
			const options = isRecord(data) ? data : {};
			if (Array.isArray(options.commands)) return options;
			return { ...options, commands: webSlashCommands(await discoverSlashCommands(record.cwd)) };
		}
		if (command.type === "reload") slashCommandCache.delete(normalizePath(record.cwd));
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
		record.managedWorktree = managedWorktreeFromEntries(record.history);
		record.agentSockets.add(socket);
		record.active = true;
		record.status = hello.session.status;
		record.agentRunning = hello.session.status === "working";
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
		broadcastSessionToAll(record);
		// Native sessions use the same bounded semantic history as managed sessions;
		// no browser connection asks Pi to paint an additional TUI viewport.
		broadcast(record.id, { type: "server.history", sessionId: record.id, entries: record.history.slice(-600) } satisfies ServerHistoryMessage);
		void flushWebQueue(record);
		return;
	}
	if (!socket.data.authed) throw new Error("Agent must send agent.hello first");
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
			}
			if (event.event.type === "agent_start" || event.event.type === "turn_start") {
				cancelQueueSettleFallback(record);
				record.status = "working";
				record.agentRunning = true;
				lifecycleChanged = true;
			}
			if (event.event.type === "agent_end" && !record.compaction) {
				record.status = "idle";
				record.agentRunning = false;
				scheduleQueueSettleFallback(record);
				lifecycleChanged = true;
			}
			if (event.event.type === "compaction_start") {
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
			if (event.event.type === "agent_settled") {
				cancelQueueSettleFallback(record);
				lifecycleChanged = true;
				// Keep the newly admitted run authoritative when this settlement is
				// delayed from the run that emitted the preceding agent_end.
				if (record.agentRunning !== true) {
					record.status = "idle";
					record.agentRunning = false;
					void flushWebQueue(record);
				}
			}
			const subagentsChanged = updateSubagentsFromToolEvent(record, event.event);
			let sessionMetadataChanged = false;
			if (event.event.type === "session_info_changed") {
				record.name = typeof event.event.name === "string" && event.event.name ? event.event.name : undefined;
				sessionMetadataChanged = true;
			}
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
				broadcastSessionToAll(record);
			} else if (lifecycleChanged || subagentsChanged || event.event.type === "compaction_start" || event.event.type === "compaction_end") {
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
		const session = existing?.agentRunning === false && update.session.status === "working"
			? { ...update.session, status: "idle" as const }
			: update.session;
		const catalogChanged = catalogSessionChanged(existing, session);
		const record = upsertSession(session, "external", existing?.history ?? []);
		record.agentSockets.add(socket);
		record.updatedAt = update.session.updatedAt;
		if (catalogChanged) broadcastSessionToAll(record);
		else broadcast(update.session.id, { type: "server.session", session: sessionToClientPayload(record) } satisfies ServerSessionMessage);
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
	if (!managedWorktree && sessionFile) managedWorktree = managedWorktreeFromEntries(parseSessionFile(sessionFile)?.entries ?? []);
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
	// worktree cleanup, so cleanup failure cannot turn deletion into an error.
	if (managedWorktree) {
		try {
			const result = removeManagedWorktree(managedWorktree);
			if (result.branchWarning) console.warn(`Removed worktree ${managedWorktree.path}, but could not delete branch ${managedWorktree.branch}: ${result.branchWarning}`);
		} catch (error) {
			console.warn(`Session ${sessionId} was deleted, but managed worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
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
		const scans = scanSavedSessions(sessionsDir);
		for (const scan of scans) {
			const existing = sessions.get(scan.session.id) ?? sessionsByFile.get(normalizePath(scan.file));
			if (!existing || !existing.active || existing.status === "offline") {
				upsertSession(scan.session, "saved", scan.history, scan.managedWorktreeScanned);
			}
		}
		const merged = new Map<string, WebSession>();
		for (const scan of scans) merged.set(scan.session.file ? normalizePath(scan.session.file) : scan.session.id, sessionToClientPayload(scan.session));
		for (const item of sessions.values()) {
			if (isMissingInactiveSession(item)) continue;
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

function staticFileResponse(filePath: string, isAppShell = false): Response {
	const response = new Response(Bun.file(filePath));
	// The app shell points at content-hashed bundles and must always revalidate so
	// reopening Pi Web cannot strand a running tab on an obsolete client.
	if (isAppShell) response.headers.set("cache-control", "no-cache");
	return response;
}

function staticAssetResponse(request: Request): Response | undefined {
	const url = new URL(request.url);
	if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) return undefined;
	const pathname = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
	const filePath = resolve(distDir, pathname);
	if (!isWithinDir(filePath, distDir)) return new Response("Forbidden", { status: 403 });
	try {
		statSync(filePath);
		return staticFileResponse(filePath, pathname === "index.html");
	} catch {
		try {
			const appShellPath = join(distDir, "index.html");
			statSync(appShellPath);
			return staticFileResponse(appShellPath, true);
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
				pending.reject(pending.commandType === "prompt"
					? new CommandDeliveryUncertainError("Agent socket closed before prompt acknowledgement")
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
	if (shutdownStarted) {
		// A second termination request is an explicit escape hatch for a wedged run.
		forceShutdownRequested = true;
		return;
	}
	shutdownStarted = true;
	if (missingSessionReconcileTimer) clearInterval(missingSessionReconcileTimer);
	missingSessionReconcileTimer = undefined;
	const busyNames = () => [...sessions.values()]
		.filter(shouldWaitForManagedShutdown)
		.map((record) => record.name ?? record.id);
	let busy = busyNames();
	if (busy.length > 0) console.error(`Waiting for active managed sessions before restart: ${busy.join(", ")}`);
	while (shouldContinueManagedShutdownWait(busy.length, forceShutdownRequested)) {
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
				if (!isTrustedBrowserOrigin(request)) return new Response("Forbidden WebSocket origin", { status: 403 });
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
