import { randomUUID } from "node:crypto";
import { isAutoModelReference } from "../model-status.js";
import {
  agentEndTerminalNotice,
  assistantTerminalNotice,
} from "../assistant-message.js";
import { messagesToWebHistory } from "../history.js";
import type {
  ServerEventMessage,
  ServerHistoryMessage,
  ServerSessionMessage,
} from "../protocol.js";
import type { ClientBroadcast } from "./clientBroadcast.js";
import type { CompactionNotice } from "./compactionNotice.js";
import type { GitMetadata } from "./gitMetadata.js";
import type { ManagedSessionRefresh } from "./managedSessionRefresh.js";
import {
  preserveRetryAroundQuiescence,
  quiesceQueueMutations,
} from "./queue-mutation.js";
import type { RecordSync } from "./recordSync.js";
import type { RpcSessionFactory } from "./rpcSessions.js";
import type {
  SessionFileCatalog,
  SessionQueueCoordinator,
  SessionRecord,
} from "./server-types.js";
import type { ServerRuntimeState } from "./serverRuntimeState.js";
import type { ServerStores } from "./serverStores.js";
import type { SessionHistory } from "./sessionHistory.js";
import type { SessionRegistry } from "./sessionRegistry.js";

/**
 * Starts managed RPC sessions (web-owned Pi runtimes), including the live
 * event handler that keeps the record, history, and queue in sync, plus
 * daemon-restart restoration of previously active managed sessions.
 */
export function createManagedSessionLauncher(options: {
  state: ServerRuntimeState;
  catalog: SessionFileCatalog;
  stores: ServerStores;
  history: SessionHistory;
  recordSync: RecordSync;
  queue: SessionQueueCoordinator;
  broadcast: ClientBroadcast;
  registry: SessionRegistry;
  refresh: ManagedSessionRefresh;
  git: GitMetadata;
  compactionNotice: CompactionNotice;
  rpcSessions: RpcSessionFactory;
}) {
  const {
    state: runtime,
    catalog,
    stores,
    history,
    recordSync,
    queue,
    broadcast,
    registry,
    refresh,
    git,
    compactionNotice,
    rpcSessions,
  } = options;
  const {
    normalizePath,
    canonicalSessionFile,
    isManagedSessionFile,
    deleteManagedSessionFile,
    replaceManagedSessionFile,
    parseSessionMetadataFile,
    parseSessionHistoryFile,
    isRecord,
    zeroWebUsage,
    addWebUsage,
    extractTextContent,
    compactionEntryFromEvent,
  } = catalog;
  const {
    cloneWebQueue,
    scheduleWebQueueRetry,
    markAgentActivity,
    markAgentSettling,
    isCurrentAgentSettlement,
    cancelQueueSettleFallback,
    scheduleQueueSettleFallback,
    flushWebQueue,
  } = queue;
  const { persistedQueues } = stores;
  const { replaceRecordHistory, appendRecordHistory } = history;
  const {
    updateRecordFromState,
    beginTurnModelTracking,
    finishTurnModelTracking,
    updateRecordFromStats,
    updateSubagentsFromToolEvent,
  } = recordSync;
  const {
    broadcast: broadcastToSessionClients,
    broadcastSessionToAll,
    sendSessionHistory,
  } = broadcast;
  const { sessionToClientPayload } = registry;
  const { sendSessionState } = queue;
  const { refreshManagedSession } = refresh;
  const { hydrateGitMetadata } = git;
  const { broadcastCompactionNotice } = compactionNotice;
  const { createRpcSession } = rpcSessions;

  async function createManagedSessionUnlocked(
    cwd: string,
    name?: string,
    sessionFile?: string,
  ): Promise<SessionRecord> {
    const resumed = sessionFile
      ? parseSessionMetadataFile(sessionFile)
      : undefined;
    const existingRecord = resumed
      ? (runtime.sessions.get(resumed.session.id) ??
        runtime.sessionsByFile.get(normalizePath(resumed.file)))
      : undefined;
    let restoreExistingQueueIntake: (() => void) | undefined;
    if (existingRecord) {
      restoreExistingQueueIntake = preserveRetryAroundQuiescence({
        isArmed: () => existingRecord.queueRetryTimer !== undefined,
        cancel: () => {
          if (existingRecord.queueRetryTimer)
            clearTimeout(existingRecord.queueRetryTimer);
          existingRecord.queueRetryTimer = undefined;
        },
        reopen: () => {
          existingRecord.queueMutationsQuiesced = false;
        },
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
      selectedModel: resumed?.session.selectedModel ?? resumed?.session.model,
      autoTurnActive: isAutoModelReference(
        resumed?.session.selectedModel ?? resumed?.session.model,
      ),
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
      queue: cloneWebQueue(
        existingRecord?.queue ??
          persistedQueues.get(resumed?.session.id ?? "") ??
          [],
      ),
      // A newly started RPC runtime has no surviving subagents. An explicit empty
      // snapshot clears stale browser telemetry retained across daemon reconnects.
      subagents: [],
      managedWorktree: resumed?.session.managedWorktree,
      catalogReady: false,
    };
    runtime.sessions.set(record.id, record);
    if (record.file)
      runtime.sessionsByFile.set(normalizePath(record.file), record);

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
          cancelQueueSettleFallback(record);
          record.status = "working";
          record.agentRunning = true;
        }
        if (event.type === "turn_start") {
          const generation = beginTurnModelTracking(record);
          const managedAtTurnStart = record.managed;
          if (record.autoTurnActive && managedAtTurnStart) {
            void managedAtTurnStart
              .getState()
              .then((state) => {
                if (
                  runtime.sessions.get(record.id) !== record ||
                  record.managed !== managedAtTurnStart ||
                  record.modelTurnGeneration !== generation ||
                  !record.autoTurnActive
                )
                  return;
                updateRecordFromState(record, state);
                broadcastSessionToAll(record);
              })
              .catch(() => undefined);
          }
        }
        if (event.type === "agent_end" && !record.compaction) {
          markAgentSettling(record);
          record.status =
            agentEndTerminalNotice(event)?.kind === "error" ? "error" : "idle";
          record.agentRunning = false;
          scheduleQueueSettleFallback(record);
        }
        if (event.type === "compaction_start") {
          markAgentSettling(record);
          record.status = "working";
          record.agentRunning = true;
          record.compaction = {
            reason:
              event.reason === "manual" || event.reason === "overflow"
                ? event.reason
                : "threshold",
            startedAt:
              typeof event.startedAt === "number"
                ? event.startedAt
                : Date.now(),
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
        if (
          event.type === "agent_settled" &&
          isCurrentAgentSettlement(record)
        ) {
          finishTurnModelTracking(record);
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
          if (
            event.message.role === "assistant" ||
            event.message.role === "toolResult"
          ) {
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
            record.preview =
              `${terminalNotice.title}: ${terminalNotice.detail}`.slice(0, 180);
          }
        }
        const compactionEntry = compactionEntryFromEvent(event);
        if (compactionEntry) {
          replaceRecordHistory(record, [compactionEntry]);
          broadcastToSessionClients(record.id, {
            type: "server.history",
            sessionId: record.id,
            entries: record.history,
            replace: true,
          } satisfies ServerHistoryMessage);
          const runtimeSession = record.managed;
          if (runtimeSession) {
            // Track the trailing authoritative snapshot so any compaction_end
            // notice can wait for it before broadcasting; otherwise the notice
            // would be wiped by this history replacement on subscribed clients.
            const refresh: Promise<void> = runtimeSession
              .getMessages()
              .then(({ messages }) => {
                if (
                  record.managed !== runtimeSession ||
                  runtime.sessions.get(record.id) !== record
                )
                  return;
                replaceRecordHistory(record, messagesToWebHistory(messages));
                broadcastToSessionClients(record.id, {
                  type: "server.history",
                  sessionId: record.id,
                  entries: record.history,
                  replace: true,
                } satisfies ServerHistoryMessage);
              })
              .catch((error) =>
                console.error(
                  `Could not refresh compacted history for ${record.id}: ${error instanceof Error ? error.message : String(error)}`,
                ),
              )
              .finally(() => {
                if (record.compactionHistoryRefresh === refresh)
                  record.compactionHistoryRefresh = undefined;
              });
            record.compactionHistoryRefresh = refresh;
          }
        }
        if (event.type === "compaction_end" && event.aborted !== true) {
          broadcastCompactionNotice(record);
        }
        broadcastToSessionClients(record.id, {
          type: "server.event",
          sessionId: record.id,
          event,
        } satisfies ServerEventMessage);
        const catalogChanged =
          event.type === "agent_start" ||
          event.type === "turn_start" ||
          event.type === "agent_end" ||
          event.type === "agent_settled" ||
          event.type === "compaction_start" ||
          event.type === "compaction_end" ||
          event.type === "message_end";
        if (catalogChanged) broadcastSessionToAll(record);
        else
          broadcastToSessionClients(record.id, {
            type: "server.session",
            session: sessionToClientPayload(record),
          } satisfies ServerSessionMessage);
        if (event.type === "agent_end") void hydrateGitMetadata(record);
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
        runtime.sessions.delete(provisionalId);
        runtime.sessions.set(record.id, record);
      }
      try {
        replaceRecordHistory(
          record,
          messagesToWebHistory((await managed.getMessages()).messages),
        );
      } catch {
        // A failed context request must not publish a blank active resume. Read only
        // a bounded suffix instead of hydrating the append-only session archive.
        if (!record.historyReady && record.file)
          replaceRecordHistory(record, parseSessionHistoryFile(record.file));
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
      if (runtime.sessions.get(provisionalId) === record)
        runtime.sessions.delete(provisionalId);
      if (runtime.sessions.get(record.id) === record)
        runtime.sessions.delete(record.id);
      for (const file of [sessionFile, record.file]) {
        if (file && runtime.sessionsByFile.get(normalizePath(file)) === record)
          runtime.sessionsByFile.delete(normalizePath(file));
      }
      if (existingRecord) {
        runtime.sessions.set(existingRecord.id, existingRecord);
        if (existingRecord.file)
          runtime.sessionsByFile.set(
            normalizePath(existingRecord.file),
            existingRecord,
          );
        restoreExistingQueueIntake?.();
        broadcastSessionToAll(existingRecord);
      }
      throw error;
    }
  }

  async function createManagedSession(
    cwd: string,
    name?: string,
    sessionFile?: string,
  ): Promise<SessionRecord> {
    if (!sessionFile) return await createManagedSessionUnlocked(cwd, name);
    // Use normalized paths for pending-start dedupe and in-flight start tracking.
    const key = normalizePath(sessionFile);
    const existing = runtime.managedSessionStarts.get(key);
    if (existing) return await existing;
    const start = createManagedSessionUnlocked(cwd, name, sessionFile);
    runtime.managedSessionStarts.set(key, start);
    try {
      return await start;
    } finally {
      if (runtime.managedSessionStarts.get(key) === start)
        runtime.managedSessionStarts.delete(key);
    }
  }

  async function restoreManagedSessions(): Promise<void> {
    for (const storedFile of stores.managedSessionStore.list()) {
      let file: string;
      try {
        file = canonicalSessionFile(storedFile);
      } catch {
        try {
          deleteManagedSessionFile(storedFile);
        } catch (error) {
          console.error(
            `Could not remove missing managed session ${storedFile}:`,
            error,
          );
        }
        continue;
      }
      const existing = runtime.sessionsByFile.get(normalizePath(file));
      if (existing?.active && existing.status !== "offline") continue;
      if (!isManagedSessionFile(file)) continue;
      const scan = parseSessionMetadataFile(file);
      if (!scan) {
        try {
          deleteManagedSessionFile(file);
        } catch (error) {
          console.error(
            `Could not remove invalid managed session ${file}:`,
            error,
          );
        }
        continue;
      }
      try {
        await createManagedSession(scan.session.cwd, scan.session.name, file);
      } catch (error) {
        console.error(
          `Could not restore managed web session ${scan.session.id}:`,
          error,
        );
      }
    }
  }

  return {
    createManagedSession,
    restoreManagedSessions,
  };
}

export type ManagedSessionLauncher = ReturnType<
  typeof createManagedSessionLauncher
>;
