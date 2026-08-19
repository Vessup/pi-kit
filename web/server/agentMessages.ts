import { randomUUID } from "node:crypto";
import {
  agentEndTerminalNotice,
  assistantTerminalNotice,
} from "../assistant-message.js";
import { boundedWebHistory } from "../history.js";
import {
  type AgentEventMessage,
  type AgentHelloMessage,
  type AgentHistoryMessage,
  type AgentResponseMessage,
  type AgentScopeMessage,
  type AgentSessionReplacedMessage,
  type AgentSubagentsMessage,
  type AgentToServerMessage,
  type AgentUpdateMessage,
  hasActiveWebSubagents,
  mergeWebSubagentUpdates,
  type ServerEventMessage,
  type ServerHistoryMessage,
  type ServerSessionMessage,
} from "../protocol.js";
import type { ClientBroadcast } from "./clientBroadcast.js";
import type { CompactionNotice } from "./compactionNotice.js";
import type { GitMetadata } from "./gitMetadata.js";
import { CommandRejectedError } from "./managed-rpc-session.js";
import type { RecordSync } from "./recordSync.js";
import type {
  AgentSocketData,
  SessionFileCatalog,
  SessionKind,
  SessionQueueCoordinator,
} from "./server-types.js";
import type { ServerRuntimeState } from "./serverRuntimeState.js";
import { normalizeLegacySessionUpdate } from "./session-lifecycle.js";
import type { SessionHistory } from "./sessionHistory.js";
import type { SessionRegistry } from "./sessionRegistry.js";
import type { SessionReplacement } from "./sessionReplacement.js";
import { managedWorktreeFromEntries } from "./worktrees.js";

/** Handles messages from Pi bridge WebSocket agents (native TUI sessions). */
export function createAgentMessages(options: {
  state: ServerRuntimeState;
  catalog: SessionFileCatalog;
  registry: SessionRegistry;
  history: SessionHistory;
  recordSync: RecordSync;
  queue: SessionQueueCoordinator;
  broadcast: ClientBroadcast;
  git: GitMetadata;
  compactionNotice: CompactionNotice;
  replacement: SessionReplacement;
}) {
  const {
    state: runtime,
    catalog,
    registry,
    history,
    recordSync,
    queue,
    broadcast,
    git,
    compactionNotice,
    replacement,
  } = options;
  const {
    normalizePath,
    extractPreviewFromHistory,
    parseSessionHistoryFile,
    isRecord,
    zeroWebUsage,
    addWebUsage,
    extractTextContent,
  } = catalog;
  const { upsertSession, sessionToClientPayload } = registry;
  const { replaceRecordHistory, appendRecordHistory } = history;
  const { updateSubagentsFromToolEvent, catalogSessionChanged } = recordSync;
  const {
    markAgentActivity,
    markAgentSettling,
    isCurrentAgentSettlement,
    cancelQueueSettleFallback,
    scheduleQueueSettleFallback,
    flushWebQueue,
    broadcastQueueDelivery,
  } = queue;
  const { broadcast: broadcastToSessionClients, broadcastSessionToAll } =
    broadcast;
  const { hydrateGitMetadata } = git;
  const { broadcastCompactionNotice } = compactionNotice;
  const { completeExternalSessionReplacement } = replacement;

  async function handleAgentMessage(
    socket: Bun.ServerWebSocket<AgentSocketData>,
    message: AgentToServerMessage,
    ): Promise<void> {
    // Trust the /ws/agent upgrade (local-only and rejected when forwarded by
    // Tailscale Serve) plus per-session socket ownership. agent.hello is the
    // session-binding handshake: only mark the socket authenticated after the
    // session record is created or updated and the socket is bound to it.
    if (message.type === "agent.hello") {
      const hello = message as AgentHelloMessage;
      const kind: SessionKind =
        hello.session.source === "saved"
          ? "saved"
          : hello.session.source === "web"
            ? "managed"
            : "external";
      const helloManagedWorktree =
        hello.session.managedWorktree ??
        managedWorktreeFromEntries(hello.entries ?? []);
      const helloHistory = boundedWebHistory(hello.entries ?? []);
      const authoritativeHistory =
        hello.historyMode === "replace" || helloHistory.length > 0;
      const record = upsertSession(
        hello.session,
        kind,
        authoritativeHistory ? helloHistory : [],
      );
      if (!record) return;
      socket.data.authed = true;
      if (authoritativeHistory) replaceRecordHistory(record, helloHistory);
      else if (!record.historyReady && record.file) {
        // Bridges loaded before historyMode existed reconnect with an empty hello.
        // Restore a bounded disk suffix without hydrating the full JSONL archive.
        replaceRecordHistory(record, parseSessionHistoryFile(record.file));
      }
      record.preview =
        extractPreviewFromHistory(record.history) ?? record.preview;
      record.managedWorktree = helloManagedWorktree ?? record.managedWorktree;
      // Carry the agent's --models scope onto the record so the model picker
      // mirrors what the TUI would show. Empty array means no scope.
      record.scopedModels = Array.isArray(hello.scopedModels)
        ? hello.scopedModels
        : undefined;
      record.agentSockets.add(socket);
      record.active = true;
      record.status = hello.session.status;
      record.agentRunning = hello.session.status === "working";
      record.updatedAt = hello.session.updatedAt;
      for (const uncertain of record.queue.filter(
        (item) => item.deliveryState === "delivering",
      )) {
        broadcastQueueDelivery(
          record,
          uncertain,
          "uncertain",
          "Delivery was interrupted by a daemon restart; edit or remove this item explicitly before resubmitting.",
        );
      }
      if (record.file)
        runtime.sessionsByFile.set(normalizePath(record.file), record);
      broadcastSessionToAll(record);
      void hydrateGitMetadata(record);
      // Native sessions use the same bounded semantic history as managed sessions;
      // no browser connection asks Pi to paint an additional TUI viewport.
      broadcastToSessionClients(record.id, {
        type: "server.history",
        sessionId: record.id,
        entries: record.history,
        replace: true,
      } satisfies ServerHistoryMessage);
      void flushWebQueue(record);
      return;
    }
    if (!socket.data.authed)
      throw new Error("Agent must send agent.hello first");
    if (message.type === "agent.scope") {
      const update = message as AgentScopeMessage;
      const record = runtime.sessions.get(update.sessionId);
      if (!record || !record.agentSockets.has(socket)) return;
      record.scopedModels = update.scopedModels;
      return;
    }
    if (message.type === "agent.history") {
      const update = message as AgentHistoryMessage;
      const record = runtime.sessions.get(update.sessionId);
      if (!record || !record.agentSockets.has(socket)) return;
      replaceRecordHistory(record, update.entries);
      broadcastToSessionClients(record.id, {
        type: "server.history",
        sessionId: record.id,
        entries: record.history,
        replace: true,
      } satisfies ServerHistoryMessage);
      return;
    }
    if (message.type === "agent.session_replaced") {
      await completeExternalSessionReplacement(
        socket,
        message as AgentSessionReplacedMessage,
      );
      return;
    }
    if (message.type === "agent.event") {
      const event = message as AgentEventMessage;
      const record = runtime.sessions.get(event.sessionId);
      if (!record || !record.agentSockets.has(socket)) return;
      record.updatedAt = Date.now();
      let lifecycleChanged = false;
      if (
        event.event.type === "agent_start" ||
        event.event.type === "turn_start"
      ) {
        record.agentStartGeneration = (record.agentStartGeneration ?? 0) + 1;
        markAgentActivity(record);
        cancelQueueSettleFallback(record);
        record.status = "working";
        record.agentRunning = true;
        lifecycleChanged = true;
      }
      if (event.event.type === "agent_end" && !record.compaction) {
        markAgentSettling(record);
        record.status =
          agentEndTerminalNotice(event.event)?.kind === "error"
            ? "error"
            : "idle";
        record.agentRunning = false;
        scheduleQueueSettleFallback(record);
        lifecycleChanged = true;
      }
      if (event.event.type === "compaction_start") {
        markAgentSettling(record);
        record.status = "working";
        record.agentRunning = true;
        record.compaction = {
          reason:
            event.event.reason === "manual" || event.event.reason === "overflow"
              ? event.event.reason
              : "threshold",
          startedAt:
            typeof event.event.startedAt === "number"
              ? event.event.startedAt
              : Date.now(),
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
        if (event.event.aborted !== true) {
          broadcastCompactionNotice(record);
        }
      }
      if (
        event.event.type === "agent_settled" &&
        isCurrentAgentSettlement(record)
      ) {
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
      const subagentsChanged = updateSubagentsFromToolEvent(
        record,
        event.event,
      );
      let sessionMetadataChanged = false;
      if (event.event.type === "session_info_changed") {
        record.name =
          typeof event.event.name === "string" && event.event.name
            ? event.event.name
            : undefined;
        sessionMetadataChanged = true;
      }
      if (
        event.event.type === "message_end" &&
        isRecord(event.event.message)
      ) {
        appendRecordHistory(record, {
          type: "message",
          id: randomUUID(),
          parentId: null,
          timestamp: new Date().toISOString(),
          message: event.event.message,
        });
        record.messageCount += 1;
        if (
          event.event.message.role === "assistant" ||
          event.event.message.role === "toolResult"
        ) {
          record.usage ??= zeroWebUsage();
          addWebUsage(record.usage, event.event.message.usage);
        }
        if (
          event.event.message.role === "user" ||
          event.event.message.role === "assistant"
        ) {
          const preview = extractTextContent(event.event.message.content);
          const terminalNotice = assistantTerminalNotice(event.event.message);
          if (preview) record.preview = preview.slice(0, 180);
          else if (terminalNotice)
            record.preview =
              `${terminalNotice.title}: ${terminalNotice.detail}`.slice(
                0,
                180,
              );
        }
        sessionMetadataChanged = true;
      }
      broadcastToSessionClients(event.sessionId, {
        type: "server.event",
        sessionId: event.sessionId,
        event: event.event,
      } satisfies ServerEventMessage);
      if (
        sessionMetadataChanged ||
        lifecycleChanged ||
        event.event.type === "compaction_start" ||
        event.event.type === "compaction_end"
      ) {
        broadcastSessionToAll(record);
      } else if (subagentsChanged) {
        broadcastToSessionClients(record.id, {
          type: "server.session",
          session: sessionToClientPayload(record),
        } satisfies ServerSessionMessage);
      }
      // PRs are commonly opened during an agent run without changing branches.
      // Refresh after completion so the catalog does not retain the pre-PR lookup.
      if (event.event.type === "agent_end") void hydrateGitMetadata(record);
      return;
    }
    if (message.type === "agent.subagents") {
      const update = message as AgentSubagentsMessage;
      const record = runtime.sessions.get(update.sessionId);
      if (!record || !record.agentSockets.has(socket)) return;
      record.subagents = mergeWebSubagentUpdates(
        record.subagents,
        update.agents,
      );
      record.subagentUsage = update.usage;
      record.updatedAt = Date.now();
      broadcastToSessionClients(record.id, {
        type: "server.event",
        sessionId: record.id,
        event: {
          type: "subagents_update",
          agents: update.agents,
          usage: update.usage,
        },
      } satisfies ServerEventMessage);
      if (
        record.status === "idle" &&
        !hasActiveWebSubagents(record.subagents) &&
        record.queue.length > 0
      )
        void flushWebQueue(record);
      return;
    }
    if (message.type === "agent.update") {
      const update = message as AgentUpdateMessage;
      const existing = runtime.sessions.get(update.session.id);
      if (!existing || !existing.agentSockets.has(socket)) return;
      // Older bridge runtimes reported `working` again immediately after their
      // authoritative agent_end event. Preserve the lifecycle event until a new
      // agent_start arrives so completed runs cannot get stuck visually working.
      const lifecycleSession = normalizeLegacySessionUpdate(
        existing,
        update.session,
      );
      // Older native bridges keep reporting their initial preview. Preserve
      // message_end/file-derived metadata after hello during rolling upgrades.
      const session = existing
        ? { ...lifecycleSession, preview: existing.preview }
        : lifecycleSession;
      const catalogChanged = catalogSessionChanged(existing, session);
      const gitContextChanged =
        existing?.cwd !== session.cwd || existing?.branch !== session.branch;
      const record = upsertSession(
        session,
        "external",
        existing?.history ?? [],
      );
      record.agentSockets.add(socket);
      record.updatedAt = update.session.updatedAt;
      if (catalogChanged) broadcastSessionToAll(record);
      else
        broadcastToSessionClients(update.session.id, {
          type: "server.session",
          session: sessionToClientPayload(record),
        } satisfies ServerSessionMessage);
      if (gitContextChanged) void hydrateGitMetadata(record);
      return;
    }
    if (message.type === "agent.response") {
      const response = message as AgentResponseMessage;
      const record = Array.from(runtime.sessions.values()).find((candidate) =>
        candidate.externalPending.has(response.requestId),
      );
      if (!record) return;
      if (!record.agentSockets.has(socket)) return;
      if (
        record.externalRequestTargets.get(response.requestId) !== undefined &&
        record.externalRequestTargets.get(response.requestId) !== socket
      )
        return;
      const pending = record.externalPending.get(response.requestId);
      if (!pending) return;
      record.externalPending.delete(response.requestId);
      record.externalRequestTargets.delete(response.requestId);
      if (response.success) pending.resolve(response.data);
      else
        pending.reject(
          new CommandRejectedError(response.error ?? "Agent command failed"),
        );
    }
  }

  return { handleAgentMessage };
}

export type AgentMessages = ReturnType<typeof createAgentMessages>;
