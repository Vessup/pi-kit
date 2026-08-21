import { parseWebCompactCommand } from "../compact-command.js";
import type {
  ClientToServerMessage,
  ServerResponseMessage,
} from "../protocol.js";
import { hasActiveWebSubagents } from "../protocol.js";
import { isWebReloadCommand } from "../reload-command.js";
import {
  parseWorktreeInvocation,
  WORKTREE_USAGE,
} from "../worktree-command.js";
import type { ClientBroadcast } from "./clientBroadcast.js";
import type { CommandRouter } from "./commandRouter.js";
import type { ManagedSessionRefresh } from "./managedSessionRefresh.js";
import { modelSelectionBlocksPrompts } from "./model-selection-gate.js";
import type {
  ClientSocketData,
  SessionFileCatalog,
  SessionQueueCoordinator,
} from "./server-types.js";
import type { ServerRuntimeState } from "./serverRuntimeState.js";
import type { SessionRegistry } from "./sessionRegistry.js";
import { shouldRejectDuringShutdown } from "./shutdown-policy.js";

/** Handles messages from browser WebSocket clients. */
export function createClientMessages(options: {
  state: ServerRuntimeState;
  sessionsDir: string;
  catalog: SessionFileCatalog;
  registry: SessionRegistry;
  queue: SessionQueueCoordinator;
  broadcast: ClientBroadcast;
  router: CommandRouter;
  refresh: ManagedSessionRefresh;
}) {
  const {
    state: runtime,
    sessionsDir,
    catalog,
    registry,
    queue,
    broadcast,
    router,
    refresh,
  } = options;
  const { normalizePath, scanSavedSessions, isRecord } = catalog;
  const { upsertSession } = registry;
  const {
    enqueueWebFollowUp,
    webQueueEvent,
    broadcastReloadComplete,
    sendSessionState,
  } = queue;
  const { sendSessionHistory, sendSessionSnapshot } = broadcast;
  const { routeCommand } = router;
  const { refreshManagedSession } = refresh;

  async function handleClientMessage(
    socket: Bun.ServerWebSocket<ClientSocketData>,
    message: ClientToServerMessage,
  ): Promise<void> {
    if (
      message.type === "client.hello" ||
      message.type === "client.command_hello"
    ) {
      socket.data.authed = true;
      if (message.type === "client.hello") {
        runtime.connectedClientSockets.add(socket);
        sendSessionSnapshot(socket);
      }
      return;
    }
    if (!socket.data.authed)
      throw new Error("Client must send a hello message first");
    if (runtime.shutdownStarted && shouldRejectDuringShutdown(message)) {
      throw new Error(
        "Pi Web is waiting for active sessions to finish before restarting",
      );
    }
    if (message.type === "client.subscribe") {
      const record =
        runtime.sessions.get(message.sessionId) ??
        (() => {
          const scan = scanSavedSessions(sessionsDir).find(
            (item) =>
              item.session.id === message.sessionId ||
              (item.file &&
                normalizePath(item.file) === normalizePath(message.sessionId)),
          );
          if (!scan) return undefined;
          return upsertSession(
            scan.session,
            "saved",
            scan.history,
            scan.managedWorktreeScanned,
          );
        })();
      if (!record) throw new Error(`Unknown session: ${message.sessionId}`);
      const previousSessionId = socket.data.sessionId;
      if (previousSessionId && previousSessionId !== record.id) {
        runtime.sessions.get(previousSessionId)?.clientSockets.delete(socket);
      }
      record.clientSockets.add(socket);
      socket.data.sessionId = record.id;
      sendSessionState(socket, record);
      sendSessionHistory(socket, record);
      return;
    }
    if (message.type === "client.sync_queue") {
      const record = runtime.sessions.get(message.sessionId);
      if (!record) throw new Error(`Unknown session: ${message.sessionId}`);
      const update = webQueueEvent(record);
      socket.send(
        JSON.stringify({
          ...update,
          event: { ...update.event, syncRequestId: message.requestId },
        }),
      );
      return;
    }
    if (message.type === "client.prompt") {
      const record = runtime.sessions.get(message.sessionId);
      try {
        if (!record) throw new Error(`Unknown session: ${message.sessionId}`);
        const normalizedPrompt = message.message.trim();
        const reload = isWebReloadCommand(normalizedPrompt);
        const compact = parseWebCompactCommand(normalizedPrompt);
        const worktree = parseWorktreeInvocation(message.message);
        let responseData: unknown;
        if (reload) {
          if (message.images?.length)
            throw new Error("/reload does not accept image attachments");
          if (
            message.streamingBehavior === "followUp" &&
            (record.status === "working" ||
              hasActiveWebSubagents(record.subagents))
          ) {
            await enqueueWebFollowUp(record, {
              id: message.requestId,
              message: message.message,
            });
            responseData = { queued: true, reason: "followUp" };
          } else {
            if (message.streamingBehavior === "steer")
              throw new Error("/reload must be queued or run while Pi is idle");
            responseData = await routeCommand(record, { type: "reload" });
            broadcastReloadComplete(record);
          }
        } else if (compact) {
          if (message.images?.length)
            throw new Error("/compact does not accept image attachments");
          if (
            message.streamingBehavior === "followUp" &&
            (record.status === "working" ||
              hasActiveWebSubagents(record.subagents))
          ) {
            await enqueueWebFollowUp(record, {
              id: message.requestId,
              message: message.message,
            });
            responseData = { queued: true, reason: "followUp" };
          } else {
            if (message.streamingBehavior === "steer")
              throw new Error(
                "/compact must be queued or run while Pi is idle",
              );
            responseData = await routeCommand(record, {
              type: "compact",
              customInstructions: compact.customInstructions,
            });
          }
        } else if (worktree) {
          if (message.images?.length)
            throw new Error("/worktree does not accept image attachments");
          if (message.streamingBehavior)
            throw new Error("/worktree must be run while Pi is idle");
          if (!worktree.name && !worktree.existing) {
            throw new Error(WORKTREE_USAGE);
          }
          responseData = await routeCommand(
            record,
            worktree.existing
              ? { type: "create_worktree", existing: worktree.existing }
              : {
                  type: "create_worktree",
                  name: worktree.name ?? "",
                  repository: worktree.repository ?? record.cwd,
                  branch: worktree.branch,
                  startPoint: worktree.startPoint,
                },
          );
        } else if (
          modelSelectionBlocksPrompts(record) ||
          (message.streamingBehavior === "followUp" &&
            record.status === "working")
        ) {
          const queueReason =
            message.streamingBehavior === "followUp"
              ? "followUp"
              : "modelSelection";
          await enqueueWebFollowUp(record, {
            id: message.requestId,
            message: message.message,
            images: message.images,
            ...(record.modelSelectionTarget
              ? { requiredModel: { ...record.modelSelectionTarget } }
              : {}),
          });
          responseData = { queued: true, reason: queueReason };
        } else {
          await routeCommand(record, {
            type: "prompt",
            message: message.message,
            images: message.images,
            streamingBehavior: message.streamingBehavior,
          });
        }
        socket.send(
          JSON.stringify({
            type: "server.response",
            requestId: message.requestId,
            success: true,
            data: responseData,
          } satisfies ServerResponseMessage),
        );
      } catch (error) {
        socket.send(
          JSON.stringify({
            type: "server.response",
            requestId: message.requestId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          } satisfies ServerResponseMessage),
        );
      }
      return;
    }
    if (message.type === "client.command") {
      const record =
        runtime.sessions.get(message.sessionId) ??
        runtime.sessionsByFile.get(normalizePath(message.sessionId));
      if (!record) {
        socket.send(
          JSON.stringify({
            type: "server.response",
            requestId: message.requestId,
            success: false,
            error: `Unknown session: ${message.sessionId}`,
          } satisfies ServerResponseMessage),
        );
        return;
      }
      try {
        const previousSessionId = record.id;
        const data = await routeCommand(record, message.command);
        if (message.command.type !== "abort")
          await refreshManagedSession(record);
        const responseData =
          record.id !== previousSessionId &&
          (message.command.type === "clone" ||
            message.command.type === "fork" ||
            message.command.type === "create_worktree" ||
            message.command.type === "create_worktree_v2")
            ? {
                ...(isRecord(data) ? data : {}),
                cancelled: isRecord(data) && data.cancelled === true,
                sessionId: record.id,
              }
            : data;
        socket.send(
          JSON.stringify({
            type: "server.response",
            requestId: message.requestId,
            success: true,
            data: responseData,
          } satisfies ServerResponseMessage),
        );
      } catch (error) {
        socket.send(
          JSON.stringify({
            type: "server.response",
            requestId: message.requestId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          } satisfies ServerResponseMessage),
        );
      }
    }
  }

  return { handleClientMessage };
}

export type ClientMessages = ReturnType<typeof createClientMessages>;
