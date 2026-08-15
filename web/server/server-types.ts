import type { ClientCommandMessage, WebQueuedMessage, WebSession } from "../protocol.js";
import type { DirtySnapshotRetryWorker } from "./dirty-snapshot-worker.js";
import type { ManagedRpcSession } from "./managed-rpc-session.js";
import type { ManagedWorktree } from "./worktrees.js";

export type WebSocketKind = "client" | "agent";
export type SessionSource = WebSession["source"];
export type SessionStatus = WebSession["status"];
export type SessionKind = "managed" | "external" | "saved";

export type ClientSocketData = {
	kind: "client";
	id: string;
	authed: boolean;
	sessionId?: string;
};

export type AgentSocketData = { kind: "agent"; id: string; authed: boolean };
export type SocketData = ClientSocketData | AgentSocketData;

export type ExternalPendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	surviveDisconnect?: boolean;
	commandType?: ClientCommandMessage["command"]["type"];
	owner?: SessionRecord;
};

export type SessionRecord = {
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
	historyReady?: boolean;
	historyBytes?: number;
	active: boolean;
	agentRunning?: boolean;
	agentStartGeneration?: number;
	activityGeneration?: number;
	settlingGeneration?: number;
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
	catalogReady?: boolean;
	gitMetadataGeneration?: number;
};
