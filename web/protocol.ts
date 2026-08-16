export type SessionStatus =
  | "idle"
  | "working"
  | "offline"
  | "starting"
  | "error";
export type SessionSource = "tui" | "web" | "saved";

export type WebUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

export type WebSubagentTranscriptItem = {
  timestamp: number;
  role: string;
  text: string;
};

export type WebSubagent = {
  id: string;
  status:
    | "creating"
    | "working"
    | "completed"
    | "failed"
    | "terminating"
    | "terminated";
  model: string;
  effort: string;
  turns: number;
  currentTool?: string;
  queued: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;
  usage?: WebUsage;
  transcript?: WebSubagentTranscriptItem[];
  streamingText?: string;
};

export function hasActiveWebSubagents(
  subagents: readonly WebSubagent[] | undefined,
): boolean {
  return Boolean(
    subagents?.some(
      (agent) =>
        agent.status === "creating" ||
        agent.status === "working" ||
        agent.status === "terminating",
    ),
  );
}

/** Incremental subagent telemetry; the full retained transcript is sent only in subscribe snapshots. */
export type WebSubagentUpdate = Omit<
  WebSubagent,
  "currentTool" | "completedAt" | "error" | "transcript" | "streamingText"
> & {
  currentTool: string | null;
  completedAt: number | null;
  error: string | null;
  transcriptDelta?: WebSubagentTranscriptItem[];
  transcriptReset?: boolean;
  streamingTextDelta?: string;
  streamingTextReset?: boolean;
};

const MAX_WEB_SUBAGENT_TRANSCRIPT_CHARS = 100_000;

function trimWebSubagentTranscript(
  items: WebSubagentTranscriptItem[],
): WebSubagentTranscriptItem[] {
  const retained: WebSubagentTranscriptItem[] = [];
  let characters = 0;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!item) continue;
    const remaining = MAX_WEB_SUBAGENT_TRANSCRIPT_CHARS - characters;
    if (remaining <= 0 && retained.length > 0) break;
    const text = item.text.slice(0, Math.max(1, remaining));
    retained.push({ ...item, text });
    characters += text.length;
  }
  return retained.reverse();
}

/** Merge wire deltas while dropping agents absent from the authoritative update list. */
export function mergeWebSubagentUpdates(
  previous: readonly WebSubagent[] | undefined,
  updates: readonly WebSubagentUpdate[],
): WebSubagent[] {
  const priorById = new Map((previous ?? []).map((agent) => [agent.id, agent]));
  return updates.map((update) => {
    const prior = priorById.get(update.id);
    let transcript = prior?.transcript;
    if (update.transcriptReset) transcript = update.transcriptDelta ?? [];
    else if (update.transcriptDelta)
      transcript = [...(transcript ?? []), ...update.transcriptDelta];
    if (transcript) transcript = trimWebSubagentTranscript(transcript);

    let streamingText = prior?.streamingText;
    if (update.streamingTextReset)
      streamingText = update.streamingTextDelta || undefined;
    else if (update.streamingTextDelta !== undefined)
      streamingText =
        `${streamingText ?? ""}${update.streamingTextDelta}` || undefined;

    return {
      id: update.id,
      status: update.status,
      model: update.model,
      effort: update.effort,
      turns: update.turns,
      currentTool: update.currentTool ?? undefined,
      queued: update.queued,
      createdAt: update.createdAt,
      updatedAt: update.updatedAt,
      completedAt: update.completedAt ?? undefined,
      error: update.error ?? undefined,
      usage: update.usage,
      transcript,
      streamingText,
    };
  });
}

export type WebPullRequest = { number: number; url: string };
export type WebCompaction = {
  reason: "manual" | "threshold" | "overflow";
  startedAt: number;
};

export type WebSession = {
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
  /** Stable repository/directory identity used by the web sidebar. */
  projectId?: string;
  projectName?: string;
  /** Primary repository checkout used when creating another linked worktree. */
  repositoryRoot?: string;
  /** Present only for a checkout created and owned by pi-kit. */
  managedWorktree?: {
    path: string;
    repoRoot: string;
    name: string;
    branch: string;
    branchCreated: boolean;
  };
  pullRequest?: WebPullRequest;
  subagents?: WebSubagent[];
  subagentUsage?: WebUsage;
  usage?: WebUsage;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
  compaction?: WebCompaction;
};

/**
 * Keep sessions in stable newest-created-first order. updatedAt changes for
 * every TUI redraw, so it must never influence sidebar position.
 */
export function compareWebSessions(a: WebSession, b: WebSession): number {
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

/** Apply a saved manual order while placing newly discovered sessions first. */
export function orderWebSessions(
  sessions: WebSession[],
  customOrder: readonly string[],
): WebSession[] {
  const defaultOrder = [...sessions].sort(compareWebSessions);
  if (customOrder.length === 0) return defaultOrder;
  const rank = new Map(customOrder.map((id, index) => [id, index]));
  return defaultOrder.sort((a, b) => {
    const aRank = rank.get(a.id);
    const bRank = rank.get(b.id);
    if (aRank === undefined && bRank === undefined)
      return compareWebSessions(a, b);
    if (aRank === undefined) return -1;
    if (bRank === undefined) return 1;
    return aRank - bRank;
  });
}

export function moveWebSession(
  sessions: WebSession[],
  customOrder: readonly string[],
  sourceId: string,
  targetId: string,
): string[] {
  return moveWebSessionRelative(sessions, customOrder, sourceId, {
    beforeId: targetId,
  });
}

/** Move a session into an explicit insertion slot, including after the final card. */
export function moveWebSessionRelative(
  sessions: WebSession[],
  customOrder: readonly string[],
  sourceId: string,
  placement: { beforeId?: string; afterId?: string },
): string[] {
  const ids = orderWebSessions(sessions, customOrder).map(
    (session) => session.id,
  );
  const sourceIndex = ids.indexOf(sourceId);
  if (sourceIndex < 0) return ids;
  const [source] = ids.splice(sourceIndex, 1);
  if (!source) return ids;
  if (placement.beforeId && placement.beforeId !== sourceId) {
    const targetIndex = ids.indexOf(placement.beforeId);
    if (targetIndex >= 0) ids.splice(targetIndex, 0, source);
    else ids.push(source);
    return ids;
  }
  if (placement.afterId) {
    const targetIndex = ids.indexOf(placement.afterId);
    if (targetIndex >= 0) ids.splice(targetIndex + 1, 0, source);
    else ids.push(source);
    return ids;
  }
  ids.splice(Math.min(sourceIndex, ids.length), 0, source);
  return ids;
}

export type AgentHelloMessage = {
  type: "agent.hello";
  session: WebSession;
  entries: unknown[];
  historyMode?: "replace";
  /** Models the agent's session is scoped to. Empty array means no scope. */
  scopedModels?: WebScopedModel[];
};

export type AgentScopeMessage = {
  type: "agent.scope";
  sessionId: string;
  scopedModels: WebScopedModel[];
};

export type AgentSessionReplacedMessage = {
  type: "agent.session_replaced";
  previousSessionId: string;
  previousSessionFile: string;
  replacementSessionId: string;
};

export type AgentEventMessage = {
  type: "agent.event";
  sessionId: string;
  event: Record<string, unknown>;
};

export type AgentHistoryMessage = {
  type: "agent.history";
  sessionId: string;
  entries: unknown[];
};

export type AgentUpdateMessage = {
  type: "agent.update";
  session: WebSession;
};

export type AgentSubagentsMessage = {
  type: "agent.subagents";
  sessionId: string;
  agents: WebSubagentUpdate[];
  usage: WebUsage;
};

export type AgentResponseMessage = {
  type: "agent.response";
  requestId: string;
  success: boolean;
  error?: string;
  data?: unknown;
};

export type AgentToServerMessage =
  | AgentHelloMessage
  | AgentSessionReplacedMessage
  | AgentEventMessage
  | AgentHistoryMessage
  | AgentUpdateMessage
  | AgentSubagentsMessage
  | AgentScopeMessage
  | AgentResponseMessage;

export type SemanticImage = {
  type: "image";
  data: string;
  mimeType: string;
  name?: string;
};
export type WebModelOption = {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevels?: string[];
};

/** A model the agent's session is scoped to via --models. Forwarded by the agent on hello (and on scope changes) so the daemon can filter the model picker the same way the TUI does. Server-internal; never reaches the browser. */
export type WebScopedModel = {
  provider: string;
  id: string;
  thinkingLevel?: string;
};
export type WebSlashCommand = {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  location?: "user" | "project" | "temporary";
};
export type WebSessionOptions = {
  models: WebModelOption[];
  thinkingLevels: string[];
  commands: WebSlashCommand[];
};
export type WebQueueReplacement = {
  id: string;
  message: string;
  images?: SemanticImage[];
};

export type WebQueuedMessage = WebQueueReplacement & {
  /** Server-owned durable crash-recovery state. A delivering item requires explicit user reconciliation. */
  deliveryState?: "delivering";
};

/** Reorder an editable follow-up into an explicit insertion slot. */
export function moveWebQueuedMessage(
  queue: readonly WebQueuedMessage[],
  sourceId: string,
  placement: { beforeId?: string; afterId?: string },
): WebQueuedMessage[] {
  const next = queue.map((item) => ({
    ...item,
    images: item.images?.map((image) => ({ ...image })),
  }));
  const sourceIndex = next.findIndex((item) => item.id === sourceId);
  if (sourceIndex < 0) return next;
  const [source] = next.splice(sourceIndex, 1);
  if (!source) return next;
  if (placement.beforeId && placement.beforeId !== sourceId) {
    const targetIndex = next.findIndex(
      (item) => item.id === placement.beforeId,
    );
    next.splice(targetIndex < 0 ? next.length : targetIndex, 0, source);
    return next;
  }
  if (placement.afterId) {
    const targetIndex = next.findIndex((item) => item.id === placement.afterId);
    next.splice(targetIndex < 0 ? next.length : targetIndex + 1, 0, source);
    return next;
  }
  next.splice(Math.min(sourceIndex, next.length), 0, source);
  return next;
}

export type AgentCommand =
  | {
      type: "prompt";
      message: string;
      images?: SemanticImage[];
      streamingBehavior?: "steer" | "followUp";
    }
  | { type: "abort" }
  | { type: "replace_queue"; queue: WebQueueReplacement[] }
  | { type: "steer_queue_item"; itemId: string }
  | { type: "reconcile_queue"; itemId: string; action: "discard" | "resubmit" }
  | { type: "get_session_options" }
  | { type: "get_commands" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: string }
  | { type: "shutdown" }
  | { type: "reload" }
  | {
      type: "create_worktree";
      repository: string;
      name: string;
      branch?: string;
      startPoint?: string;
    }
  | { type: "create_worktree"; existing: string }
  /** Internal bridge version: old native bridges reject this instead of silently dropping branch/ref fields. */
  | {
      type: "create_worktree_v2";
      repository: string;
      name: string;
      branch?: string;
      startPoint?: string;
    };

export type ServerToAgentMessage = {
  type: "agent.command";
  requestId: string;
  command: AgentCommand | RpcSessionCommand;
};

export type ClientHelloMessage = { type: "client.hello" };
export type ClientCommandHelloMessage = { type: "client.command_hello" };
export type ClientSubscribeMessage = {
  type: "client.subscribe";
  sessionId: string;
};
export type ClientSyncQueueMessage = {
  type: "client.sync_queue";
  requestId: string;
  sessionId: string;
};
export type ClientPromptMessage = {
  type: "client.prompt";
  requestId: string;
  sessionId: string;
  message: string;
  images?: SemanticImage[];
  streamingBehavior?: "steer" | "followUp";
};
export type ClientCommandMessage = {
  type: "client.command";
  requestId: string;
  sessionId: string;
  command: AgentCommand | RpcSessionCommand;
};
export type ClientToServerMessage =
  | ClientHelloMessage
  | ClientCommandHelloMessage
  | ClientSubscribeMessage
  | ClientSyncQueueMessage
  | ClientPromptMessage
  | ClientCommandMessage;

export type RpcSessionCommand =
  | { type: "clone" }
  | { type: "fork"; entryId: string }
  | { type: "get_fork_messages" }
  | { type: "set_session_name"; name: string }
  | { type: "compact"; customInstructions?: string }
  | { type: "bash"; command: string }
  | {
      type: "extension_ui_response";
      id: string;
      value?: string;
      confirmed?: boolean;
      cancelled?: boolean;
    };

export type ServerHistoryMessage = {
  type: "server.history";
  sessionId: string;
  entries: unknown[];
  replace?: boolean;
};
export type ServerEventMessage = {
  type: "server.event";
  sessionId: string;
  event: Record<string, unknown>;
};
export type ServerResponseMessage = {
  type: "server.response";
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: string;
};

export type ServerSnapshotMessage = {
  type: "server.snapshot";
  sessions: WebSession[];
};
export type ServerSessionMessage = {
  type: "server.session";
  session: WebSession;
};
export type ServerSessionRemovedMessage = {
  type: "server.session_removed";
  sessionId: string;
  replacementSessionId?: string;
};
export type ServerToClientMessage =
  | ServerHistoryMessage
  | ServerEventMessage
  | ServerResponseMessage
  | ServerSnapshotMessage
  | ServerSessionMessage
  | ServerSessionRemovedMessage;
export type TailscaleWebStatus = {
  installed: boolean;
  enabled: boolean;
  available: boolean;
  published: boolean;
  url?: string;
  error?: string;
};

export type ServerStateFile = {
  pid: number;
  port: number;
  startedAt: number;
  version: 1;
  tailscale?: TailscaleWebStatus;
};

export type CreateSessionRequest = {
  /** Repository or directory in which to start the session. */
  cwd: string;
  name?: string;
  /** When present, create this managed worktree directory before starting the session. */
  worktreeName?: string;
  /** Local branch to reuse or create; defaults to worktreeName. */
  worktreeBranch?: string;
  /** Ref/commit for a newly created branch; remote-tracking refs configure upstream. */
  worktreeStartPoint?: string;
};
export type ResumeSessionRequest = { file: string };

export const DEFAULT_WEB_PORT = 31415;
export const WEB_STATE_VERSION = 1;
