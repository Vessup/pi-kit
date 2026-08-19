import { boundedWebHistory } from "../history.js";
import type {
  ServerHistoryMessage,
  ServerSessionMessage,
  ServerSessionRemovedMessage,
  ServerSnapshotMessage,
  ServerToClientMessage,
} from "../protocol.js";
import type { ClientSocketData, SessionRecord } from "./server-types.js";
import type { ServerRuntimeState } from "./serverRuntimeState.js";
import type { SessionHistory } from "./sessionHistory.js";
import type { SessionRegistry } from "./sessionRegistry.js";

/** Fan-out of server frames to browser sockets, per-session or catalog-wide. */
export function createClientBroadcast(options: {
  state: ServerRuntimeState;
  registry: SessionRegistry;
  history: SessionHistory;
}) {
  const { state: runtime, registry, history } = options;
  const { sessionToClientPayload, sessionSnapshot } = registry;
  const { sessionHistoryForRecord } = history;

  function broadcast(sessionId: string, message: ServerToClientMessage): void {
    const record = runtime.sessions.get(sessionId);
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
    for (const socket of runtime.connectedClientSockets) {
      try {
        socket.send(payload);
      } catch {
        // ignore
      }
    }
  }

  function broadcastSessionToAll(record: SessionRecord): void {
    if (
      record.catalogReady === false ||
      runtime.sessions.get(record.id) !== record
    )
      return;
    broadcastToAll({
      type: "server.session",
      session: sessionToClientPayload(record),
    } satisfies ServerSessionMessage);
  }

  function sendSessionSnapshot(
    socket: Bun.ServerWebSocket<ClientSocketData>,
  ): void {
    const payload: ServerSnapshotMessage = {
      type: "server.snapshot",
      sessions: sessionSnapshot(),
    };
    socket.send(JSON.stringify(payload));
  }

  function sendSessionHistory(
    socket: Bun.ServerWebSocket<ClientSocketData>,
    record: SessionRecord,
  ): void {
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

  function sendSessionRemoved(
    sessionId: string,
    replacementSessionId?: string,
    additionalSockets: Iterable<Bun.ServerWebSocket<ClientSocketData>> = [],
  ): void {
    const payload: ServerSessionRemovedMessage = {
      type: "server.session_removed",
      sessionId,
      replacementSessionId,
    };
    const message = JSON.stringify(payload);
    const notified = new Set<Bun.ServerWebSocket<ClientSocketData>>();
    for (const socket of runtime.connectedClientSockets) {
      notified.add(socket);
      try {
        socket.send(message);
      } catch {
        /* ignore */
      }
    }
    for (const socket of additionalSockets) {
      if (notified.has(socket)) continue;
      notified.add(socket);
      try {
        socket.send(message);
      } catch {
        /* ignore */
      }
    }
  }

  return {
    broadcast,
    broadcastToAll,
    broadcastSessionToAll,
    sendSessionSnapshot,
    sendSessionHistory,
    sendSessionRemoved,
  };
}

export type ClientBroadcast = ReturnType<typeof createClientBroadcast>;
