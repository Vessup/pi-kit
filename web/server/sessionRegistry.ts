import {
  buildContextEntries,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { boundedWebHistory, webHistoryByteLength } from "../history.js";
import { compareWebSessions, type WebSession } from "../protocol.js";
import type { MissingSessions } from "./missingSessions.js";
import { resolveSessionProject } from "./projects.js";
import type {
  AgentSocketData,
  ClientSocketData,
  SessionFileCatalog,
  SessionKind,
  SessionRecord,
} from "./server-types.js";
import type { WebServerConfig } from "./serverConfig.js";
import type { ServerRuntimeState } from "./serverRuntimeState.js";
import type { ServerStores } from "./serverStores.js";
import type { SessionHistory } from "./sessionHistory.js";
import { managedWorktreeFromEntries } from "./worktrees.js";

/**
 * Owns the live session catalog: the id- and file-keyed record maps, record
 * construction from scans, and the projected client payload.
 */
export function createSessionRegistry(options: {
  state: ServerRuntimeState;
  config: WebServerConfig;
  catalog: SessionFileCatalog;
  stores: ServerStores;
  history: SessionHistory;
  missingSessions: MissingSessions;
  /** Late-bound so session deletion can depend on the registry. */
  reconcileMissingSessions: () => void;
}) {
  const { state: runtime, catalog, stores, history, missingSessions } = options;
  const { sessionsDir } = options.config;
  const { normalizePath, scanSavedSessions } = catalog;
  const { persistedQueues } = stores;
  const { isMissingInactiveSession } = missingSessions;
  const { replaceRecordHistory } = history;

  function sessionToClientPayload(
    session: WebSession,
    includeSubagentTranscripts = false,
  ): WebSession {
    const project = resolveSessionProject(session.cwd);
    const subagents = includeSubagentTranscripts
      ? session.subagents
      : session.subagents?.map(
          ({
            transcript: _transcript,
            streamingText: _streamingText,
            ...agent
          }) => agent,
        );
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
      managedWorktree:
        "managedWorktree" in session ? session.managedWorktree : undefined,
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
    const displayHistory = boundedWebHistory(
      kind === "saved"
        ? buildContextEntries(history as SessionEntry[])
        : history,
    );
    const historyManagedWorktree = managedWorktreeFromEntries(history);
    const record = runtime.sessions.get(session.id) ?? {
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
      externalRequestTargets: new Map(),
      externalPending: new Map(),
      queue: (persistedQueues.get(session.id) ?? []).map((item) => ({
        ...item,
        images: item.images?.map((image) => ({ ...image })),
      })),
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
      : (historyManagedWorktree ??
        session.managedWorktree ??
        record.managedWorktree);
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
    const existing = runtime.sessions.get(session.id);
    const record =
      existing ??
      makeSessionRecord(session, kind, history, managedWorktreeScanned);
    const historyManagedWorktree =
      history.length > 0 ? managedWorktreeFromEntries(history) : undefined;
    Object.assign(record, session);
    record.kind = kind;
    if (history.length > 0)
      replaceRecordHistory(
        record,
        kind === "saved"
          ? buildContextEntries(history as SessionEntry[])
          : history,
      );
    record.managedWorktree = managedWorktreeScanned
      ? session.managedWorktree
      : (historyManagedWorktree ??
        session.managedWorktree ??
        record.managedWorktree);
    if (managedWorktreeScanned) record.managedWorktreeScanned = true;
    if (kind !== "saved") record.active = true;
    runtime.sessions.set(record.id, record);
    if (record.file)
      runtime.sessionsByFile.set(normalizePath(record.file), record);
    return record;
  }

  function activeSessionFiles(): Set<string> {
    return new Set(
      [...runtime.sessions.values()].flatMap((record) =>
        record.active && record.file ? [normalizePath(record.file)] : [],
      ),
    );
  }

  function sessionSnapshot(): WebSession[] {
    options.reconcileMissingSessions();
    const merged = new Map<string, WebSession>();
    for (const record of runtime.sessions.values()) {
      if (record.catalogReady === false || isMissingInactiveSession(record))
        continue;
      const key = record.file ? normalizePath(record.file) : record.id;
      merged.set(key, sessionToClientPayload(record));
    }
    for (const scan of scanSavedSessions(sessionsDir, activeSessionFiles())) {
      const key = scan.session.file
        ? normalizePath(scan.session.file)
        : scan.session.id;
      const live =
        runtime.sessionsByFile.get(key) ??
        runtime.sessions.get(scan.session.id);
      if (!live?.active || live.status === "offline")
        merged.set(key, sessionToClientPayload(scan.session));
    }
    return sortSessions(Array.from(merged.values()));
  }

  return {
    sessionToClientPayload,
    sortSessions,
    makeSessionRecord,
    upsertSession,
    activeSessionFiles,
    sessionSnapshot,
  };
}

export type SessionRegistry = ReturnType<typeof createSessionRegistry>;
