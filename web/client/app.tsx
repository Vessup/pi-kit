import {
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import { agentEndTerminalNotice } from "../assistant-message";
import {
  includeWebCompactCommand,
  parseWebCompactCommand,
} from "../compact-command";
import {
  type ClientPromptMessage,
  type CreateSessionRequest,
  mergeWebSubagentUpdates,
  moveWebSessionRelative,
  type SemanticImage,
  type WebQueuedMessage,
  type WebQueueReplacement,
  type WebSession,
  type WebSessionOptions,
  type WebSlashCommand,
  type WebSubagentUpdate,
  type WebUsage,
} from "../protocol";
import { includeWebReloadCommand, isWebReloadCommand } from "../reload-command";
import {
  cloneSessionViaCommand,
  compactSessionViaCommand,
  createSession,
  deleteSession,
  forkSessionViaCommand,
  listSessions,
  openSessionSocket,
  renameSessionViaCommand,
  resumeSession,
  sendSessionCommand,
} from "./api";
import {
  messageText,
  preserveOptimisticAttachments,
  upsertActiveTool,
  waitForVisibleBrowserPaint,
} from "./app-message-state";
import {
  COLLAPSED_PROJECTS_KEY,
  hashSessionId,
  LAST_SESSION_KEY,
  loadCollapsedProjects,
  loadLastSessionId,
  loadSessionOrder,
  loadSessionSort,
  SESSION_ORDER_KEY,
  SESSION_SORT_KEY,
  savePreference,
  setHashSessionId,
} from "./app-preferences";
import { NewSessionDialog } from "./components/new-session-dialog";
import {
  isQueuedFollowUpResponse,
  shouldShowOptimisticPrompt,
} from "./composer-send";
import {
  DeleteSessionDialog,
  ForkSessionDialog,
  RenameSessionDialog,
} from "./components/session-dialogs";
import {
  SessionListItem,
  SessionSidebarList,
  SidebarFilterButton,
} from "./components/session-sidebar";
import { Button } from "./components/ui/button";
import { assertClientPromptPayloadFits } from "./image-payload";
import { cn } from "./lib/utils";
import {
  localCommandEntryId,
  localHistoryBaselineIdentities,
  preserveLocalCommandEntries,
  reconcileOptimisticQueueEntries,
} from "./local-command";
import {
  mergeSemanticHistory,
  preserveSemanticEntryKeys,
  semanticHistoriesEqual,
} from "./semantic-history";
import {
  type ActiveTool,
  type SemanticEntry,
  SemanticSession,
  updateStreamingMessage,
} from "./semantic-session";
import {
  preserveSessionsTelemetry,
  preserveSessionTelemetry,
} from "./session-telemetry";
import {
  type SessionSort,
  sessionMatches,
  sortSessions,
  sortSessionsForSidebar,
} from "./session-utils";
import type { SessionSocket } from "./ws";

export function App() {
  const [sessions, setSessions] = React.useState<WebSession[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(
    () => hashSessionId() ?? loadLastSessionId(),
  );
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [newSessionOpen, setNewSessionOpen] = React.useState(false);
  const [newSessionRepository, setNewSessionRepository] = React.useState<
    string | undefined
  >(undefined);
  const openNewSession = React.useCallback((repository?: string) => {
    setNewSessionRepository(repository);
    setNewSessionOpen(true);
  }, []);
  const [renameCandidate, setRenameCandidate] =
    React.useState<WebSession | null>(null);
  const [deleteCandidate, setDeleteCandidate] =
    React.useState<WebSession | null>(null);
  const [forkCandidate, setForkCandidate] = React.useState<WebSession | null>(
    null,
  );
  const [currentSession, setCurrentSession] = React.useState<WebSession | null>(
    null,
  );
  const [sessionOrder, setSessionOrder] =
    React.useState<string[]>(loadSessionOrder);
  const [sessionSort, setSessionSort] =
    React.useState<SessionSort>(loadSessionSort);
  const [collapsedProjects, setCollapsedProjects] = React.useState<string[]>(
    loadCollapsedProjects,
  );
  const [filterQuery, setFilterQuery] = React.useState("");
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const sessionSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const [entries, setEntries] = React.useState<SemanticEntry[]>([]);
  const entriesRef = React.useRef<SemanticEntry[]>([]);
  const [historyRevision, setHistoryRevision] = React.useState(0);
  const [streamingMessage, setStreamingMessage] = React.useState<Record<
    string,
    unknown
  > | null>(null);
  const [streamingMessageKey, setStreamingMessageKey] = React.useState<
    string | null
  >(null);
  const streamingMessageKeyRef = React.useRef<string | null>(null);
  const activeSessionIdRef = React.useRef<string | null>(null);
  const [activeTools, setActiveTools] = React.useState<ActiveTool[]>([]);
  const [connected, setConnected] = React.useState(false);
  const [transcriptLoading, setTranscriptLoading] = React.useState(
    Boolean(selectedId),
  );
  const [queuedMessages, setQueuedMessages] = React.useState<
    WebQueuedMessage[]
  >([]);
  const queuedMessagesRef = React.useRef<WebQueuedMessage[]>([]);
  React.useEffect(() => {
    queuedMessagesRef.current = queuedMessages;
  }, [queuedMessages]);
  const [sessionOptions, setSessionOptions] = React.useState<WebSessionOptions>(
    { models: [], thinkingLevels: [], commands: [] },
  );
  const socketRef = React.useRef<SessionSocket | null>(null);
  const selectedIdRef = React.useRef<string | null>(selectedId);
  const initialSessionResolvedRef = React.useRef(false);
  const sessionsRequestGenerationRef = React.useRef(0);
  const reconnectTimerRef = React.useRef<number | null>(null);
  const queueSyncRef = React.useRef<{
    requestId: string;
    sessionId: string;
    socket: SessionSocket;
    timer: number;
  } | null>(null);
  const connectionGenerationRef = React.useRef(0);
  const optionsGenerationRef = React.useRef(0);
  const optimisticWorkingSessionsRef = React.useRef(
    new Map<string, WebSession["status"]>(),
  );
  const pendingRequestsRef = React.useRef(
    new Map<
      string,
      {
        socket: SessionSocket;
        optimisticId: string;
        resolve: (data?: unknown) => void;
        reject: (error: Error) => void;
      }
    >(),
  );

  React.useEffect(() => {
    savePreference(SESSION_ORDER_KEY, JSON.stringify(sessionOrder));
  }, [sessionOrder]);
  React.useEffect(() => {
    savePreference(SESSION_SORT_KEY, sessionSort);
  }, [sessionSort]);
  React.useEffect(() => {
    savePreference(COLLAPSED_PROJECTS_KEY, JSON.stringify(collapsedProjects));
  }, [collapsedProjects]);
  React.useEffect(() => {
    selectedIdRef.current = selectedId;
    // Only persist after the initial selection has been validated against
    // the session list; otherwise a stale hash or stored id could overwrite
    // the previously persisted value before we know whether it exists.
    if (initialSessionResolvedRef.current && selectedId)
      savePreference(LAST_SESSION_KEY, selectedId);
  }, [selectedId]);
  React.useEffect(() => {
    if (
      deleteCandidate &&
      !sessions.some((session) => session.id === deleteCandidate.id)
    )
      setDeleteCandidate(null);
  }, [deleteCandidate, sessions]);

  const loadAllSessions = React.useCallback(async () => {
    // Only the most recent request may apply results; a stale response
    // (e.g. issued before the URL hash changed mid-flight) must not
    // resolve the initial session selection.
    const generation = ++sessionsRequestGenerationRef.current;
    try {
      setLoading(true);
      const snapshot = sortSessions(await listSessions()).map((session) =>
        optimisticWorkingSessionsRef.current.has(session.id) &&
        session.status !== "working"
          ? { ...session, status: "working" as const }
          : session,
      );
      if (generation !== sessionsRequestGenerationRef.current) return;
      setSessions((previous) => preserveSessionsTelemetry(previous, snapshot));
      setError(null);
      if (snapshot.length > 0) {
        if (!initialSessionResolvedRef.current) {
          // On first load, honor the hash or the persisted last session only
          // if it still exists; otherwise fall back to the first session.
          // Read the id from the ref so a hash change during the request is
          // still honored, then persist whichever id ends up selected.
          initialSessionResolvedRef.current = true;
          const initialId = selectedIdRef.current;
          const acceptedId =
            initialId && snapshot.some((item) => item.id === initialId)
              ? initialId
              : snapshot[0].id;
          savePreference(LAST_SESSION_KEY, acceptedId);
          if (acceptedId !== initialId) setSelectedId(acceptedId);
        } else if (!selectedIdRef.current) {
          setSelectedId(snapshot[0].id);
        }
      }
    } catch (cause) {
      if (generation === sessionsRequestGenerationRef.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === sessionsRequestGenerationRef.current)
        setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadAllSessions();
  }, [loadAllSessions]);
  React.useEffect(() => {
    const interval = connected ? 60_000 : 5_000;
    const timer = window.setInterval(() => void loadAllSessions(), interval);
    return () => window.clearInterval(timer);
  }, [connected, loadAllSessions]);

  React.useEffect(() => {
    const onHashChange = () => {
      const next = hashSessionId();
      if (next !== selectedIdRef.current) setSelectedId(next);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  React.useEffect(() => {
    if (!selectedId) {
      setCurrentSession(null);
      return;
    }
    const session = sessions.find((item) => item.id === selectedId) ?? null;
    setCurrentSession(session);
  }, [selectedId, sessions]);

  const rejectPendingForSocket = React.useCallback(
    (socket: SessionSocket, error: Error) => {
      const optimisticIds = new Set<string>();
      for (const [requestId, pending] of pendingRequestsRef.current) {
        if (pending.socket !== socket) continue;
        pendingRequestsRef.current.delete(requestId);
        optimisticIds.add(pending.optimisticId);
        pending.reject(error);
      }
      if (optimisticIds.size > 0) {
        const next = entriesRef.current.filter(
          (entry) => !entry.id || !optimisticIds.has(entry.id),
        );
        entriesRef.current = next;
        setEntries(next);
      }
    },
    [],
  );

  const connect = React.useCallback(
    async (sessionId: string) => {
      const generation = ++connectionGenerationRef.current;
      if (queueSyncRef.current) {
        window.clearTimeout(queueSyncRef.current.timer);
        queueSyncRef.current = null;
      }
      const previousSessionId = activeSessionIdRef.current;
      const switchingSessions = previousSessionId !== sessionId;
      if (switchingSessions && previousSessionId)
        optimisticWorkingSessionsRef.current.delete(previousSessionId);
      const previousSocket = socketRef.current;
      socketRef.current = null;
      if (previousSocket) {
        rejectPendingForSocket(
          previousSocket,
          new Error("Session connection was replaced"),
        );
        previousSocket.close();
      }
      if (reconnectTimerRef.current)
        window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      setConnected(false);
      setTranscriptLoading(true);
      if (switchingSessions) {
        entriesRef.current = [];
        setEntries([]);
        setStreamingMessage(null);
        setStreamingMessageKey(null);
        streamingMessageKeyRef.current = null;
        setActiveTools([]);
        setQueuedMessages([]);
      }
      const socket = await openSessionSocket((message) => {
        if (
          generation !== connectionGenerationRef.current ||
          selectedIdRef.current !== sessionId
        )
          return;
        if (!message || typeof message !== "object" || !("type" in message))
          return;
        const type = String((message as { type?: unknown }).type);
        if (type === "server.snapshot") {
          const snapshot = message as { sessions?: WebSession[] };
          if (snapshot.sessions) {
            const sessions = snapshot.sessions.map((session) =>
              optimisticWorkingSessionsRef.current.has(session.id) &&
              session.status !== "working"
                ? { ...session, status: "working" as const }
                : session,
            );
            setSessions((previous) =>
              preserveSessionsTelemetry(previous, sortSessions(sessions)),
            );
          }
          return;
        }
        if (type === "server.session") {
          const payload = message as unknown as { session: WebSession };
          const incoming =
            optimisticWorkingSessionsRef.current.has(payload.session.id) &&
            payload.session.status !== "working"
              ? { ...payload.session, status: "working" as const }
              : payload.session;
          if (incoming.id === selectedIdRef.current) {
            setCurrentSession((current) =>
              preserveSessionTelemetry(current ?? undefined, incoming),
            );
          }
          setSessions((previous) => {
            const session = preserveSessionTelemetry(
              previous.find((item) => item.id === incoming.id),
              incoming,
            );
            return sortSessions([
              ...previous.filter((item) => item.id !== session.id),
              session,
            ]);
          });
          return;
        }
        if (type === "server.session_removed") {
          const payload = message as unknown as {
            sessionId: string;
            replacementSessionId?: string;
          };
          setSessions((prev) => prev.filter((s) => s.id !== payload.sessionId));
          if (payload.sessionId === selectedIdRef.current) {
            setSelectedId(payload.replacementSessionId ?? null);
            if (payload.replacementSessionId)
              setHashSessionId(payload.replacementSessionId);
          }
          return;
        }
        if (type === "server.history") {
          const payload = message as unknown as {
            sessionId: string;
            entries?: SemanticEntry[];
            replace?: boolean;
          };
          if (payload.sessionId === selectedIdRef.current) {
            const incoming = payload.entries;
            const replacement =
              incoming && (payload.replace || switchingSessions)
                ? preserveSemanticEntryKeys(
                    entriesRef.current,
                    preserveLocalCommandEntries(entriesRef.current, incoming),
                  )
                : incoming;
            const transcriptChanged = Boolean(
              payload.replace &&
                replacement &&
                (switchingSessions ||
                  !semanticHistoriesEqual(entriesRef.current, replacement)),
            );
            if (replacement) {
              if (payload.replace || switchingSessions) {
                entriesRef.current = replacement;
                setEntries(replacement);
              } else {
                const next = mergeSemanticHistory(
                  entriesRef.current,
                  replacement,
                );
                entriesRef.current = next;
                setEntries(next);
              }
            }
            if (payload.replace) {
              // A reconnect snapshot still clears transient stream/tool state, but an
              // identical transcript must not eject a reader from their scroll anchor.
              setStreamingMessage(null);
              setStreamingMessageKey(null);
              streamingMessageKeyRef.current = null;
              setActiveTools([]);
            }
            if (transcriptChanged)
              setHistoryRevision((revision) => revision + 1);
            setTranscriptLoading(false);
          }
          return;
        }
        if (type === "server.response") {
          const payload = message as unknown as {
            requestId?: string;
            success: boolean;
            error?: string;
            data?: unknown;
          };
          if (!payload.requestId) return;
          const pending = pendingRequestsRef.current.get(payload.requestId);
          if (!pending) return;
          pendingRequestsRef.current.delete(payload.requestId);
          if (payload.success) pending.resolve(payload.data);
          else {
            const next = entriesRef.current.filter(
              (entry) => entry.id !== pending.optimisticId,
            );
            entriesRef.current = next;
            setEntries(next);
            pending.reject(new Error(payload.error ?? "Request failed"));
          }
          return;
        }
        if (type !== "server.event") return;
        const payload = message as unknown as {
          sessionId: string;
          event: Record<string, unknown>;
        };
        if (payload.sessionId !== selectedIdRef.current) return;
        const event = payload.event;
        const eventType = String(event.type ?? "");
        if (
          eventType === "agent_start" ||
          eventType === "turn_start" ||
          eventType === "agent_end" ||
          eventType === "agent_settled"
        ) {
          optimisticWorkingSessionsRef.current.delete(payload.sessionId);
          const terminalNotice =
            eventType === "agent_end"
              ? agentEndTerminalNotice(event)
              : undefined;
          const applyLifecycle = (session: WebSession): WebSession => {
            if (eventType === "agent_start" || eventType === "turn_start")
              return { ...session, status: "working" };
            if (eventType === "agent_end" && session.compaction) return session;
            if (
              terminalNotice?.kind === "error" ||
              (eventType === "agent_settled" && session.status === "error")
            )
              return { ...session, status: "error" };
            return { ...session, status: "idle" };
          };
          setCurrentSession((current) =>
            current?.id === payload.sessionId
              ? applyLifecycle(current)
              : current,
          );
          setSessions((previous) =>
            previous.map((session) =>
              session.id === payload.sessionId
                ? applyLifecycle(session)
                : session,
            ),
          );
          if (eventType === "agent_end" || eventType === "agent_settled")
            setActiveTools([]);
        }
        if (eventType === "model_selection_error") {
          const previousOptimisticStatus =
            optimisticWorkingSessionsRef.current.get(payload.sessionId);
          optimisticWorkingSessionsRef.current.delete(payload.sessionId);
          if (previousOptimisticStatus) {
            setCurrentSession((current) =>
              current?.id === payload.sessionId
                ? { ...current, status: previousOptimisticStatus }
                : current,
            );
            setSessions((previous) =>
              previous.map((session) =>
                session.id === payload.sessionId
                  ? { ...session, status: previousOptimisticStatus }
                  : session,
              ),
            );
          }
          setError(
            typeof event.message === "string"
              ? event.message
              : "Could not switch models",
          );
        }
        if (eventType === "subagents_update") {
          const updates = Array.isArray(event.agents)
            ? (event.agents as WebSubagentUpdate[])
            : [];
          const usage = event.usage as WebUsage | undefined;
          const applyUpdate = (session: WebSession): WebSession => ({
            ...session,
            subagents: mergeWebSubagentUpdates(session.subagents, updates),
            subagentUsage: usage ?? session.subagentUsage,
          });
          setCurrentSession((current) =>
            current?.id === payload.sessionId ? applyUpdate(current) : current,
          );
          setSessions((previous) =>
            previous.map((session) =>
              session.id === payload.sessionId ? applyUpdate(session) : session,
            ),
          );
        } else if (eventType === "web_queue_update") {
          if (
            typeof event.syncRequestId === "string" &&
            queueSyncRef.current?.requestId === event.syncRequestId
          ) {
            window.clearTimeout(queueSyncRef.current.timer);
            queueSyncRef.current = null;
          }
          setQueuedMessages(
            Array.isArray(event.queue)
              ? event.queue.filter(
                  (item): item is WebQueuedMessage =>
                    Boolean(item) &&
                    typeof item === "object" &&
                    typeof (item as WebQueuedMessage).id === "string" &&
                    typeof (item as WebQueuedMessage).message === "string",
                )
              : [],
          );
        } else if (
          eventType === "web_queue_delivery" &&
          event.item &&
          typeof event.item === "object"
        ) {
          const item = event.item as WebQueuedMessage;
          if (typeof item.id !== "string" || typeof item.message !== "string")
            return;
          const immediateOptimisticId = `optimistic-${item.id}`;
          const optimisticId =
            parseWebCompactCommand(item.message) !== undefined
              ? localCommandEntryId(item.id)
              : entriesRef.current.some(
                    (entry) => entry.id === immediateOptimisticId,
                  )
                ? immediateOptimisticId
                : `optimistic-queued-${item.id}`;
          if (event.phase === "started") {
            // Atomically move the follow-up out of the editable queue and into the
            // normal transcript before the server asks Pi to begin its turn.
            setQueuedMessages((previous) =>
              previous.filter((queued) => queued.id !== item.id),
            );
            if (
              !entriesRef.current.some((entry) => entry.id === optimisticId)
            ) {
              const next = [
                ...entriesRef.current,
                {
                  id: optimisticId,
                  type: "message" as const,
                  timestamp: new Date().toISOString(),
                  localHistoryBaselineIdentities:
                    localHistoryBaselineIdentities(entriesRef.current),
                  message: {
                    role: "user",
                    timestamp: Date.now(),
                    content: [
                      ...(item.message
                        ? [{ type: "text", text: item.message }]
                        : []),
                      ...(item.images ?? []).map((image) => ({ ...image })),
                    ],
                  },
                },
              ];
              entriesRef.current = next;
              setEntries(next);
            }
          } else if (event.phase === "failed") {
            const next = entriesRef.current.filter(
              (entry) => entry.id !== optimisticId,
            );
            entriesRef.current = next;
            setEntries(next);
          }
        } else if (
          eventType === "message_start" &&
          event.message &&
          typeof event.message === "object" &&
          (event.message as Record<string, unknown>).role === "assistant"
        ) {
          const assistant = event.message as Record<string, unknown>;
          const key = String(
            assistant.id ??
              assistant.timestamp ??
              `streaming-${crypto.randomUUID()}`,
          );
          streamingMessageKeyRef.current = key;
          setStreamingMessageKey(key);
          setStreamingMessage(assistant);
        } else if (eventType === "message_update") {
          if (event.message && typeof event.message === "object") {
            if (!streamingMessageKeyRef.current) {
              const partial = event.message as Record<string, unknown>;
              const key = String(
                partial.id ??
                  partial.timestamp ??
                  `streaming-${crypto.randomUUID()}`,
              );
              streamingMessageKeyRef.current = key;
              setStreamingMessageKey(key);
            }
            // Pi includes the authoritative partial assistant message on every
            // update. Rendering it directly avoids reconstructing streams from
            // provider-specific deltas (especially tool-call deltas).
            setStreamingMessage(event.message as Record<string, unknown>);
          } else if (
            event.assistantMessageEvent &&
            typeof event.assistantMessageEvent === "object"
          ) {
            setStreamingMessage((current) =>
              updateStreamingMessage(
                current,
                event.assistantMessageEvent as Record<string, unknown>,
              ),
            );
          }
        } else if (
          eventType === "message_end" &&
          event.message &&
          typeof event.message === "object"
        ) {
          const finalized = event.message as Record<string, unknown>;
          const finalizedStreamingKey = streamingMessageKeyRef.current;
          const stableAssistantId =
            finalized.role === "assistant"
              ? (finalizedStreamingKey ??
                String(
                  finalized.id ?? finalized.timestamp ?? crypto.randomUUID(),
                ))
              : crypto.randomUUID();
          const entry: SemanticEntry = {
            id: stableAssistantId,
            type: "message",
            timestamp: new Date().toISOString(),
            message: finalized,
          };
          let next: SemanticEntry[];
          if (finalized.role === "user") {
            const confirmedText = messageText(finalized);
            let optimisticIndex = entriesRef.current.findIndex(
              (item) =>
                item.id?.startsWith("optimistic-") &&
                item.message &&
                messageText(item.message) === confirmedText,
            );
            if (optimisticIndex < 0)
              optimisticIndex = entriesRef.current.findIndex((item) =>
                item.id?.startsWith("optimistic-"),
              );
            if (optimisticIndex >= 0) {
              next = [...entriesRef.current];
              const previous = entriesRef.current[optimisticIndex];
              if (previous) {
                next[optimisticIndex] = {
                  ...entry,
                  message: preserveOptimisticAttachments(finalized, previous),
                };
              } else {
                next = [...entriesRef.current, entry];
              }
            } else {
              next = [...entriesRef.current, entry];
            }
          } else {
            next = [...entriesRef.current, entry];
          }
          entriesRef.current = next;
          setEntries(next);
          if (finalized.role === "assistant") {
            setStreamingMessage(null);
            setStreamingMessageKey(null);
            streamingMessageKeyRef.current = null;
          }
        } else if (eventType === "tool_execution_start") {
          const id = String(event.toolCallId ?? crypto.randomUUID());
          setActiveTools((previous) => [
            ...previous.filter((tool) => tool.id !== id),
            {
              id,
              name: String(event.toolName ?? "tool"),
              args: event.args,
              running: true,
            },
          ]);
        } else if (eventType === "tool_execution_update") {
          setActiveTools((previous) =>
            upsertActiveTool(previous, event, {
              result: event.partialResult,
              running: true,
            }),
          );
        } else if (eventType === "tool_execution_end") {
          setActiveTools((previous) =>
            upsertActiveTool(previous, event, {
              result: event.result,
              isError: event.isError === true,
              running: false,
            }),
          );
        } else if (eventType === "agent_settled") {
          setActiveTools([]);
        }
      }).catch(() => {
        if (
          generation === connectionGenerationRef.current &&
          selectedIdRef.current === sessionId
        ) {
          reconnectTimerRef.current = window.setTimeout(() => {
            if (
              generation === connectionGenerationRef.current &&
              selectedIdRef.current === sessionId
            )
              void connect(sessionId);
          }, 2500);
        }
        return null;
      });
      if (!socket) return;
      if (
        generation !== connectionGenerationRef.current ||
        selectedIdRef.current !== sessionId
      ) {
        socket.close();
        return;
      }
      socket.onClose(() => {
        rejectPendingForSocket(socket, new Error("Session connection closed"));
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        setConnected(false);
        if (
          generation === connectionGenerationRef.current &&
          selectedIdRef.current === sessionId
        ) {
          reconnectTimerRef.current = window.setTimeout(() => {
            if (
              generation === connectionGenerationRef.current &&
              selectedIdRef.current === sessionId
            )
              void connect(sessionId);
          }, 2500);
        }
      });
      socket.send({ type: "client.subscribe", sessionId });
      socketRef.current = socket;
      activeSessionIdRef.current = sessionId;
      setConnected(true);
    },
    [rejectPendingForSocket],
  );

  const syncSelectedQueue = React.useCallback(() => {
    const sessionId = selectedIdRef.current;
    if (!sessionId) return;
    const socket = socketRef.current;
    if (!socket) {
      if (!reconnectTimerRef.current) void connect(sessionId);
      return;
    }
    const pending = queueSyncRef.current;
    if (pending?.sessionId === sessionId && pending.socket === socket) return;
    if (pending) window.clearTimeout(pending.timer);
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      if (queueSyncRef.current?.requestId !== requestId) return;
      queueSyncRef.current = null;
      if (selectedIdRef.current === sessionId && socketRef.current === socket)
        void connect(sessionId);
    }, 5_000);
    queueSyncRef.current = { requestId, sessionId, socket, timer };
    try {
      socket.send({ type: "client.sync_queue", requestId, sessionId });
    } catch {
      window.clearTimeout(timer);
      if (queueSyncRef.current?.requestId === requestId)
        queueSyncRef.current = null;
      if (!reconnectTimerRef.current) void connect(sessionId);
    }
  }, [connect]);

  React.useEffect(() => {
    const syncWhenVisible = () => {
      if (document.visibilityState === "visible") syncSelectedQueue();
    };
    const interval = window.setInterval(syncWhenVisible, 60_000);
    document.addEventListener("visibilitychange", syncWhenVisible);
    window.addEventListener("focus", syncWhenVisible);
    window.addEventListener("online", syncWhenVisible);
    window.addEventListener("pageshow", syncWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", syncWhenVisible);
      window.removeEventListener("focus", syncWhenVisible);
      window.removeEventListener("online", syncWhenVisible);
      window.removeEventListener("pageshow", syncWhenVisible);
    };
  }, [syncSelectedQueue]);

  React.useEffect(() => {
    if (!selectedId) return;
    setHashSessionId(selectedId);
    void connect(selectedId);
    return () => {
      connectionGenerationRef.current += 1;
      if (reconnectTimerRef.current)
        window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      if (queueSyncRef.current) window.clearTimeout(queueSyncRef.current.timer);
      queueSyncRef.current = null;
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        rejectPendingForSocket(socket, new Error("Session changed"));
        socket.close();
      }
    };
  }, [connect, selectedId, rejectPendingForSocket]);

  const selectedSession =
    currentSession?.id === selectedId
      ? currentSession
      : (sessions.find((session) => session.id === selectedId) ?? null);
  const selectedModelOptionKey =
    selectedSession?.selectedModel ?? selectedSession?.model;

  const loadSessionOptions = React.useCallback(
    async (sessionId: string, generation = optionsGenerationRef.current) => {
      try {
        const options = (await sendSessionCommand(sessionId, {
          type: "get_session_options",
        })) as Partial<WebSessionOptions>;
        if (
          selectedIdRef.current !== sessionId ||
          optionsGenerationRef.current !== generation
        )
          return;
        setSessionOptions((current) => ({
          models: Array.isArray(options.models) ? options.models : [],
          thinkingLevels: Array.isArray(options.thinkingLevels)
            ? options.thinkingLevels
            : [],
          commands: includeWebCompactCommand(
            includeWebReloadCommand(
              Array.isArray(options.commands)
                ? options.commands
                : current.commands,
            ),
          ),
        }));
      } catch {
        if (
          selectedIdRef.current === sessionId &&
          optionsGenerationRef.current === generation
        )
          setSessionOptions((current) => ({
            ...current,
            models: [],
            thinkingLevels: [],
          }));
      }
    },
    [],
  );

  const loadSessionCommands = React.useCallback(
    async (sessionId: string, generation = optionsGenerationRef.current) => {
      try {
        const response = (await sendSessionCommand(sessionId, {
          type: "get_commands",
        })) as { commands?: WebSlashCommand[] } | undefined;
        if (
          selectedIdRef.current !== sessionId ||
          optionsGenerationRef.current !== generation
        )
          return;
        setSessionOptions((current) => ({
          ...current,
          commands: includeWebCompactCommand(
            includeWebReloadCommand(
              Array.isArray(response?.commands) ? response.commands : [],
            ),
          ),
        }));
      } catch {
        if (
          selectedIdRef.current === sessionId &&
          optionsGenerationRef.current === generation
        ) {
          setSessionOptions((current) => ({
            ...current,
            commands: includeWebCompactCommand(
              includeWebReloadCommand(current.commands),
            ),
          }));
        }
      }
    },
    [],
  );

  // Refire when the session identity, status, or explicit model selection
  // changes, not on every agent update (which churns the selectedSession
  // reference). The model key refreshes thinking levels after a deferred
  // mid-turn selection is finally applied.
  React.useEffect(() => {
    const sessionId = selectedSession?.id;
    const status = selectedSession?.status;
    const generation = ++optionsGenerationRef.current;
    if (!sessionId || status === "offline") {
      setSessionOptions({ models: [], thinkingLevels: [], commands: [] });
      return;
    }
    // Reading the explicit selection makes this effect refresh the supported
    // effort list when a deferred model change is finally applied.
    void selectedModelOptionKey;
    // get_session_options already includes commands; avoid a second connection
    // and native get_commands process spawn on every session selection.
    void loadSessionOptions(sessionId, generation);
  }, [
    loadSessionOptions,
    selectedModelOptionKey,
    selectedSession?.id,
    selectedSession?.status,
  ]);

  const selectModel = React.useCallback(
    async (provider: string, modelId: string) => {
      const sessionId = selectedIdRef.current;
      if (!sessionId) return;
      await sendSessionCommand(sessionId, {
        type: "set_model",
        provider,
        modelId,
      });
    },
    [],
  );

  const selectThinkingLevel = React.useCallback(async (level: string) => {
    const sessionId = selectedIdRef.current;
    if (!sessionId) return;
    await sendSessionCommand(sessionId, { type: "set_thinking_level", level });
  }, []);

  const orderedSessions = React.useMemo(
    () => sortSessionsForSidebar(sessions, sessionSort, sessionOrder),
    [sessionOrder, sessionSort, sessions],
  );
  const filteredSessions = React.useMemo(
    () =>
      orderedSessions.filter((session) => sessionMatches(session, filterQuery)),
    [filterQuery, orderedSessions],
  );

  const sendSemanticPrompt = React.useCallback(
    async (
      message: string,
      images: SemanticImage[],
      streamingBehavior?: "steer" | "followUp",
      onDispatched?: () => void,
    ) => {
      const sessionId = selectedIdRef.current;
      const socket = socketRef.current;
      if (!sessionId || !socket) throw new Error("Session is disconnected");
      const requestId = crypto.randomUUID();
      const promptFrame = {
        type: "client.prompt",
        requestId,
        sessionId,
        message,
        images,
        streamingBehavior,
      } satisfies ClientPromptMessage;
      assertClientPromptPayloadFits(promptFrame);
      const showOptimisticPrompt = shouldShowOptimisticPrompt(
        streamingBehavior,
        selectedSession?.status,
      );
      const queuedFollowUp = !showOptimisticPrompt;
      const worktreeCommand = /^\/worktree(?:\s|$)/.test(message.trim());
      const compactCommand = parseWebCompactCommand(message);
      const controlCommand =
        isWebReloadCommand(message) ||
        compactCommand !== undefined ||
        worktreeCommand;
      const optimisticallyWorking =
        !queuedFollowUp &&
        !controlCommand &&
        selectedSession?.status !== "working";
      const previousStatus = selectedSession?.status;
      if (optimisticallyWorking) {
        optimisticWorkingSessionsRef.current.set(
          sessionId,
          previousStatus ?? "idle",
        );
        setCurrentSession((current) =>
          current?.id === sessionId
            ? { ...current, status: "working" }
            : current,
        );
        setSessions((previous) =>
          previous.map((session) =>
            session.id === sessionId
              ? { ...session, status: "working" }
              : session,
          ),
        );
      }
      const optimisticId =
        compactCommand !== undefined
          ? localCommandEntryId(requestId)
          : `optimistic-${requestId}`;
      const optimistic: SemanticEntry = {
        id: optimisticId,
        type: "message",
        timestamp: new Date().toISOString(),
        localHistoryBaselineIdentities: localHistoryBaselineIdentities(
          entriesRef.current,
        ),
        message: {
          role: "user",
          timestamp: Date.now(),
          content: [
            ...(message ? [{ type: "text", text: message }] : []),
            ...images.map((image) => ({
              type: "image",
              data: image.data,
              mimeType: image.mimeType,
            })),
          ],
        },
      };
      if (showOptimisticPrompt) {
        const next = [...entriesRef.current, optimistic];
        entriesRef.current = next;
        setEntries(next);
        // Immediate prompts paint before routing starts. Explicit follow-ups
        // remain only in the queue until delivery actually begins.
        if (!controlCommand) await waitForVisibleBrowserPaint();
      }
      let responseData: unknown;
      try {
        responseData = await new Promise<unknown>((resolve, reject) => {
          pendingRequestsRef.current.set(requestId, {
            socket,
            optimisticId,
            resolve,
            reject,
          });
          try {
            socket.send(promptFrame);
            onDispatched?.();
          } catch (cause) {
            pendingRequestsRef.current.delete(requestId);
            const next = entriesRef.current.filter(
              (entry) => entry.id !== optimisticId,
            );
            entriesRef.current = next;
            setEntries(next);
            reject(cause instanceof Error ? cause : new Error(String(cause)));
          }
        });
      } catch (cause) {
        const shouldRestoreStatus =
          optimisticallyWorking &&
          previousStatus &&
          optimisticWorkingSessionsRef.current.delete(sessionId);
        if (shouldRestoreStatus) {
          setCurrentSession((current) =>
            current?.id === sessionId
              ? { ...current, status: previousStatus }
              : current,
          );
          setSessions((previous) =>
            previous.map((session) =>
              session.id === sessionId
                ? { ...session, status: previousStatus }
                : session,
            ),
          );
        }
        throw cause;
      }
      if (
        responseData &&
        typeof responseData === "object" &&
        "queued" in responseData &&
        responseData.queued === true
      ) {
        if (isQueuedFollowUpResponse(responseData)) {
          const next = entriesRef.current.filter(
            (entry) => entry.id !== optimisticId,
          );
          entriesRef.current = next;
          setEntries(next);
          if (
            optimisticallyWorking &&
            previousStatus &&
            optimisticWorkingSessionsRef.current.delete(sessionId)
          ) {
            setCurrentSession((current) =>
              current?.id === sessionId
                ? { ...current, status: previousStatus }
                : current,
            );
            setSessions((previous) =>
              previous.map((session) =>
                session.id === sessionId
                  ? { ...session, status: previousStatus }
                  : session,
              ),
            );
          }
        }
        // A model-selection gate represents an immediate prompt still being
        // routed, so its bubble remains optimistic. Explicit follow-ups stay
        // exclusively in the queue until web_queue_delivery starts.
        return;
      }
      if (isWebReloadCommand(message)) {
        const next = entriesRef.current.filter(
          (entry) => entry.id !== optimisticId,
        );
        entriesRef.current = next;
        setEntries(next);
        const generation = ++optionsGenerationRef.current;
        await Promise.all([
          loadSessionOptions(sessionId, generation),
          loadSessionCommands(sessionId, generation),
        ]);
        return;
      }
      if (worktreeCommand && responseData && typeof responseData === "object") {
        const replacementId = (responseData as { sessionId?: unknown })
          .sessionId;
        if (typeof replacementId === "string") {
          setSelectedId(replacementId);
          setHashSessionId(replacementId);
        }
      }
    },
    [loadSessionCommands, loadSessionOptions, selectedSession?.status],
  );

  const replaceQueuedMessages = React.useCallback(
    async (queue: WebQueueReplacement[]) => {
      const sessionId = selectedIdRef.current;
      if (!sessionId) throw new Error("No session selected");
      const previousQueue = queuedMessagesRef.current;
      // Keep the visible queue authoritative: the subscribed socket applies the
      // server's web_queue_update only after replace_queue has been accepted.
      await sendSessionCommand(sessionId, { type: "replace_queue", queue });
      const next = reconcileOptimisticQueueEntries(
        entriesRef.current,
        previousQueue,
        queue,
      );
      if (next !== entriesRef.current) {
        entriesRef.current = next;
        setEntries(next);
      }
    },
    [],
  );

  const steerQueuedMessage = React.useCallback(async (itemId: string) => {
    const sessionId = selectedIdRef.current;
    if (!sessionId) throw new Error("No session selected");
    await sendSessionCommand(sessionId, { type: "steer_queue_item", itemId });
  }, []);

  const reconcileQueuedMessage = React.useCallback(
    async (itemId: string, action: "discard" | "resubmit") => {
      const sessionId = selectedIdRef.current;
      if (!sessionId) throw new Error("No session selected");
      await sendSessionCommand(sessionId, {
        type: "reconcile_queue",
        itemId,
        action,
      });
    },
    [],
  );

  const abortSemanticSession = React.useCallback(async () => {
    const sessionId = selectedIdRef.current;
    if (!sessionId) return;
    await sendSessionCommand(sessionId, { type: "abort" });
  }, []);

  const handleCreate = React.useCallback(
    async (request: CreateSessionRequest) => {
      const session = await createSession(request);
      setSessions((prev) =>
        sortSessions([...prev.filter((s) => s.id !== session.id), session]),
      );
      setSelectedId(session.id);
      setHashSessionId(session.id);
    },
    [],
  );

  const handleResume = React.useCallback(async (session: WebSession) => {
    if (!session.file) return;
    const resumed = await resumeSession({ file: session.file });
    setSessions((prev) =>
      sortSessions([...prev.filter((s) => s.id !== resumed.id), resumed]),
    );
    setSelectedId(resumed.id);
    setHashSessionId(resumed.id);
  }, []);

  const handleDelete = React.useCallback(async (session: WebSession) => {
    try {
      await deleteSession(session.id);
    } catch (cause) {
      // A proxy can time out after the daemon has already durably deleted the
      // session. Reconcile before reporting a false failure or leaving the modal.
      let latest: WebSession[] | undefined;
      try {
        latest = await listSessions();
      } catch {
        throw cause;
      }
      if (latest.some((item) => item.id === session.id)) throw cause;
      setSessions(sortSessions(latest));
    }
    setSessions((prev) => prev.filter((s) => s.id !== session.id));
    setSessionOrder((previous) => previous.filter((id) => id !== session.id));
    if (selectedIdRef.current === session.id) setSelectedId(null);
  }, []);

  const handleRename = React.useCallback(
    async (session: WebSession, name: string) => {
      await renameSessionViaCommand(session.id, name);
      const nextName = name || undefined;
      setSessions((previous) =>
        previous.map((item) =>
          item.id === session.id ? { ...item, name: nextName } : item,
        ),
      );
      if (selectedIdRef.current === session.id)
        setCurrentSession((current) =>
          current ? { ...current, name: nextName } : current,
        );
    },
    [],
  );

  const handleCompact = React.useCallback(
    async (session: WebSession) => {
      const next = window.prompt(
        "Compact with custom instructions (optional)",
        "",
      );
      if (next === null) return;
      await compactSessionViaCommand(session.id, next.trim() || undefined);
      await loadAllSessions();
    },
    [loadAllSessions],
  );

  const handleClone = React.useCallback(
    async (session: WebSession) => {
      const result = (await cloneSessionViaCommand(session.id)) as
        | { cancelled?: boolean; sessionId?: string }
        | undefined;
      if (result?.cancelled) return;
      await loadAllSessions();
      if (result?.sessionId) {
        setSelectedId(result.sessionId);
        setHashSessionId(result.sessionId);
      }
    },
    [loadAllSessions],
  );

  const handleForkOpen = React.useCallback((session: WebSession) => {
    setForkCandidate(session);
  }, []);

  const handleFork = React.useCallback(
    async (session: WebSession, entryId: string) => {
      const result = (await forkSessionViaCommand(session.id, entryId)) as
        | { cancelled?: boolean; sessionId?: string }
        | undefined;
      if (result?.cancelled) return;
      await loadAllSessions();
      if (result?.sessionId) {
        setSelectedId(result.sessionId);
        setHashSessionId(result.sessionId);
      }
    },
    [loadAllSessions],
  );

  const handleSelect = React.useCallback(
    async (session: WebSession) => {
      if (session.status === "offline" || session.source === "saved") {
        await handleResume(session);
      } else {
        setSelectedId(session.id);
        setHashSessionId(session.id);
      }
      setSidebarOpen(false);
    },
    [handleResume],
  );

  const toggleProject = React.useCallback((key: string) => {
    setCollapsedProjects((previous) =>
      previous.includes(key)
        ? previous.filter((item) => item !== key)
        : [...previous, key],
    );
  }, []);

  const sessionCollisionDetection = React.useCallback<CollisionDetection>(
    (args) => {
      const activeSession = sessions.find(
        (session) => session.id === String(args.active.id),
      );
      if (!activeSession) return [];
      const projectId = activeSession.projectId ?? `dir:${activeSession.cwd}`;
      const allowedIds = new Set(
        sessions
          .filter(
            (session) =>
              (session.projectId ?? `dir:${session.cwd}`) === projectId,
          )
          .map((session) => session.id),
      );
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((container) =>
          allowedIds.has(String(container.id)),
        ),
      });
    },
    [sessions],
  );

  const handleSessionDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      setDraggingId(null);
      const activeId = String(event.active.id);
      const overId = event.over ? String(event.over.id) : null;
      if (!overId || activeId === overId) return;
      const activeSession = sessions.find((session) => session.id === activeId);
      const overSession = sessions.find((session) => session.id === overId);
      if (!activeSession || !overSession) return;
      if (
        (activeSession.projectId ?? `dir:${activeSession.cwd}`) !==
        (overSession.projectId ?? `dir:${overSession.cwd}`)
      )
        return;
      const orderedIds = orderedSessions.map((session) => session.id);
      const activeIndex = orderedIds.indexOf(activeId);
      const overIndex = orderedIds.indexOf(overId);
      if (activeIndex < 0 || overIndex < 0) return;
      const placement =
        activeIndex < overIndex ? { afterId: overId } : { beforeId: overId };
      setSessionOrder((previous) =>
        moveWebSessionRelative(
          sessions,
          sessionSort === "custom" ? previous : orderedIds,
          activeId,
          placement,
        ),
      );
      setSessionSort("custom");
    },
    [orderedSessions, sessionSort, sessions],
  );

  return (
    <div className="pi-web-shell bg-[#09090b] text-zinc-100">
      <NewSessionDialog
        open={newSessionOpen}
        initialRepository={newSessionRepository}
        onOpenChange={setNewSessionOpen}
        onCreate={handleCreate}
      />
      <RenameSessionDialog
        session={renameCandidate}
        onOpenChange={(open) => {
          if (!open) setRenameCandidate(null);
        }}
        onRename={handleRename}
      />
      <DeleteSessionDialog
        session={deleteCandidate}
        onOpenChange={(open) => {
          if (!open) setDeleteCandidate(null);
        }}
        onDelete={handleDelete}
      />
      <ForkSessionDialog
        session={forkCandidate}
        onOpenChange={(open) => {
          if (!open) setForkCandidate(null);
        }}
        onFork={handleFork}
      />
      <DndContext
        sensors={sessionSensors}
        collisionDetection={sessionCollisionDetection}
        onDragStart={(event) => setDraggingId(String(event.active.id))}
        onDragCancel={() => setDraggingId(null)}
        onDragEnd={handleSessionDragEnd}
      >
        <div className="flex h-full overflow-hidden">
          {sidebarOpen && (
            <button
              type="button"
              aria-label="Close sessions sidebar"
              className="fixed inset-0 z-20 bg-black/60 xl:hidden"
              onClick={() => setSidebarOpen(false)}
            />
          )}
          <aside
            className={cn(
              "pi-web-sidebar fixed z-30 w-[min(340px,calc(100vw-24px))] flex-col border-r border-zinc-800 bg-zinc-950/95 p-4 backdrop-blur xl:static xl:w-[340px]",
              sidebarOpen ? "flex" : "hidden",
              sidebarCollapsed ? "xl:hidden" : "xl:flex",
            )}
          >
            <div className="mb-4 flex gap-2">
              <Button
                className="h-9 min-w-0 flex-1 justify-start"
                onClick={() => openNewSession()}
              >
                <Plus className="h-4 w-4" /> New session
              </Button>
              <SidebarFilterButton
                query={filterQuery}
                onQueryChange={setFilterQuery}
                sort={sessionSort}
                onSortChange={setSessionSort}
                hasCustomOrder={sessionOrder.length > 0}
                onResetOrder={() => {
                  setSessionOrder([]);
                  setSessionSort("newest");
                }}
              />
              <Button
                title="Collapse sidebar"
                aria-label="Collapse sidebar"
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={() => {
                  setSidebarCollapsed(true);
                  setSidebarOpen(false);
                }}
              >
                <PanelLeftClose className="h-4 w-4" />
              </Button>
            </div>
            <div className="-mr-4 min-h-0 flex-1 overflow-y-auto pr-4">
              {filteredSessions.length > 0 ? (
                <SessionSidebarList
                  sessions={filteredSessions}
                  selectedId={selectedId}
                  collapsedProjects={collapsedProjects}
                  onToggleProject={toggleProject}
                  onNewSession={openNewSession}
                  onSelect={(session) => void handleSelect(session)}
                  onResume={(session) => void handleResume(session)}
                  onClone={(session) => void handleClone(session)}
                  onFork={handleForkOpen}
                  onRename={setRenameCandidate}
                  onCompact={(session) => void handleCompact(session)}
                  onDelete={setDeleteCandidate}
                />
              ) : (
                <p className="px-1 py-3 text-xs text-zinc-600">
                  No sessions match.
                </p>
              )}
            </div>
          </aside>

          <main className="relative min-w-0 flex-1 bg-[#09090b]">
            <Button
              aria-label="Open sessions sidebar"
              variant="secondary"
              size="icon"
              className={cn(
                "absolute left-2 top-2 z-20 shadow-xl",
                !sidebarCollapsed && "xl:hidden",
                sidebarOpen && "hidden",
              )}
              onClick={() => {
                setSidebarCollapsed(false);
                setSidebarOpen(true);
              }}
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
            <SemanticSession
              key={selectedSession?.id ?? "no-session"}
              session={selectedSession}
              entries={entries}
              historyRevision={historyRevision}
              streamingMessage={streamingMessage}
              streamingMessageKey={streamingMessageKey}
              tools={activeTools}
              sessionError={error}
              onDismissSessionError={() => setError(null)}
              connected={connected}
              transcriptLoading={transcriptLoading}
              queuedMessages={queuedMessages}
              sessionOptions={sessionOptions}
              onSelectModel={selectModel}
              onSelectThinkingLevel={selectThinkingLevel}
              onSend={sendSemanticPrompt}
              onReplaceQueue={replaceQueuedMessages}
              onSteerQueuedMessage={steerQueuedMessage}
              onReconcileQueue={reconcileQueuedMessage}
              onAbort={abortSemanticSession}
            />
            {!selectedSession && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-zinc-500">
                {loading
                  ? "Loading sessions…"
                  : (error ?? "Select or create a session.")}
              </div>
            )}
          </main>
        </div>
        {createPortal(
          <DragOverlay dropAnimation={null}>
            {draggingId
              ? (() => {
                  const session = sessions.find(
                    (item) => item.id === draggingId,
                  );
                  return session ? (
                    <div className="w-[308px]">
                      <SessionListItem
                        session={session}
                        selected={session.id === selectedId}
                        overlay
                        onSelect={() => undefined}
                        onResume={() => void handleResume(session)}
                        onClone={() => void handleClone(session)}
                        onFork={() => handleForkOpen(session)}
                        onRename={() => setRenameCandidate(session)}
                        onCompact={() => void handleCompact(session)}
                        onDelete={() => setDeleteCandidate(session)}
                      />
                    </div>
                  ) : null;
                })()
              : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    </div>
  );
}
