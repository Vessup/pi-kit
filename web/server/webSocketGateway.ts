import type {
  AgentToServerMessage,
  ClientToServerMessage,
  ServerResponseMessage,
} from "../protocol.js";
import type { AgentMessages } from "./agentMessages.js";
import type { ClientBroadcast } from "./clientBroadcast.js";
import type { ClientMessages } from "./clientMessages.js";
import {
  CommandDeliveryUncertainError,
  isUncertainRpcDeliveryCommand,
} from "./managed-rpc-session.js";
import type {
  AgentSocketData,
  ClientSocketData,
  SessionFileCatalog,
  SocketData,
} from "./server-types.js";
import type { ServerRuntimeState } from "./serverRuntimeState.js";

const decoder = new TextDecoder();

/** WebSocket endpoint behavior for browser clients and Pi bridge agents. */
export function createWebSocketGateway(options: {
  state: ServerRuntimeState;
  catalog: SessionFileCatalog;
  broadcast: ClientBroadcast;
  clientMessages: ClientMessages;
  agentMessages: AgentMessages;
}) {
  const {
    state: runtime,
    catalog,
    broadcast,
    clientMessages,
    agentMessages,
  } = options;
  const { isRecord } = catalog;
  const { broadcastSessionToAll } = broadcast;
  const { handleClientMessage } = clientMessages;
  const { handleAgentMessage } = agentMessages;


  function parseSocketMessage<T>(data: string | Uint8Array): T | undefined {
    const text = typeof data === "string" ? data : decoder.decode(data);
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  }

  function handleWebSocketOpen(): void {
    return;
  }

  async function handleWebSocketMessage(
    socket: Bun.ServerWebSocket<SocketData>,
    data: string | Uint8Array,
  ): Promise<void> {
    const parsed = parseSocketMessage<
      ClientToServerMessage | AgentToServerMessage
    >(data);
    if (!parsed) {
      socket.close(1003, "Invalid JSON");
      return;
    }
    try {
      if (socket.data.kind === "client")
        await handleClientMessage(
          socket as Bun.ServerWebSocket<ClientSocketData>,
          parsed as ClientToServerMessage,
        );
      else
        await handleAgentMessage(
          socket as Bun.ServerWebSocket<AgentSocketData>,
          parsed as AgentToServerMessage,
        );
    } catch (error) {
      try {
        const frame: unknown = parsed;
        const requestId =
          isRecord(frame) && typeof frame.requestId === "string"
            ? frame.requestId
            : undefined;
        if (socket.data.kind === "client" && requestId) {
          socket.send(
            JSON.stringify({
              type: "server.response",
              requestId,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            } satisfies ServerResponseMessage),
          );
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
      runtime.connectedClientSockets.delete(
        socket as Bun.ServerWebSocket<ClientSocketData>,
      );
      for (const record of runtime.sessions.values()) {
        if (
          !record.clientSockets.delete(
            socket as Bun.ServerWebSocket<ClientSocketData>,
          )
        )
          continue;
      }
      return;
    }
    for (const record of runtime.sessions.values()) {
      if (
        !record.agentSockets.delete(
          socket as Bun.ServerWebSocket<AgentSocketData>,
        )
      )
        continue;
      for (const [
        requestId,
        target,
      ] of record.externalRequestTargets.entries()) {
        if (target !== socket) continue;
        record.externalRequestTargets.delete(requestId);
        const pending = record.externalPending.get(requestId);
        if (pending?.surviveDisconnect) continue;
        if (pending) {
          record.externalPending.delete(requestId);
          pending.reject(
            pending.commandType &&
              isUncertainRpcDeliveryCommand(pending.commandType)
              ? new CommandDeliveryUncertainError(
                  `Agent socket closed before ${pending.commandType} acknowledgement`,
                )
              : new Error("Agent socket closed"),
          );
        }
      }
      if (record.agentSockets.size === 0 && record.kind === "external") {
        record.status = "offline";
        record.active = false;
        broadcastSessionToAll(record);
      }
    }
  }

  return {
    handleWebSocketOpen,
    handleWebSocketMessage,
    handleWebSocketClose,
  };
}

export type WebSocketGateway = ReturnType<typeof createWebSocketGateway>;
