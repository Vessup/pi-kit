import { existsSync } from "node:fs";
import type { AgentSessionReplacedMessage } from "../protocol.js";
import { replacementFromEntries } from "../worktree-replacement.js";
import type { ClientBroadcast } from "./clientBroadcast.js";
import { quiesceQueueMutations } from "./queue-mutation.js";
import type {
  AgentSocketData,
  SessionFileCatalog,
  SessionQueueCoordinator,
} from "./server-types.js";
import type { ServerRuntimeState } from "./serverRuntimeState.js";
import type { ServerStores } from "./serverStores.js";

/**
 * Commits an external (native bridge) session replacement reported over the
 * agent socket: merges queues, migrates sockets and pending requests, and
 * retires the source record.
 */
export function createSessionReplacement(options: {
  state: ServerRuntimeState;
  catalog: SessionFileCatalog;
  stores: ServerStores;
  queue: SessionQueueCoordinator;
  broadcast: ClientBroadcast;
}) {
  const { state: runtime, catalog, stores, queue, broadcast } = options;
  const { normalizePath } = catalog;
  const { persistedQueues, queueStoreWriter } = stores;
  const {
    cloneWebQueue,
    webQueueEvent,
    cancelWebQueueWork,
    scheduleQueueSettleFallback,
  } = queue;
  const { broadcast: broadcastToSessionClients, sendSessionRemoved } =
    broadcast;

  async function completeExternalSessionReplacement(
    socket: Bun.ServerWebSocket<AgentSocketData>,
    replacement: AgentSessionReplacedMessage,
  ): Promise<void> {
    if (replacement.previousSessionId === replacement.replacementSessionId)
      throw new Error("Replacement session must differ from its source");
    const next = runtime.sessions.get(replacement.replacementSessionId);
    if (!next || !next.agentSockets.has(socket))
      throw new Error("Replacement session is not bound to this agent socket");
    const durableReplacement = next.file
      ? catalog.parseSessionMetadataFile(next.file)?.replacement
      : replacementFromEntries(next.history);
    if (
      !durableReplacement ||
      durableReplacement.previousSessionId !== replacement.previousSessionId ||
      normalizePath(durableReplacement.previousSessionFile) !==
        normalizePath(replacement.previousSessionFile) ||
      durableReplacement.replacementSessionId !==
        replacement.replacementSessionId
    )
      throw new Error(
        "Replacement activation does not match the durable session marker",
      );
    const previous = runtime.sessions.get(replacement.previousSessionId);
    if (
      previous &&
      (!previous.file ||
        normalizePath(previous.file) !==
          normalizePath(replacement.previousSessionFile))
    ) {
      throw new Error(
        "Replacement source file does not match the registered source session",
      );
    }

    if (!previous) {
      if (existsSync(replacement.previousSessionFile)) return;
      const orphaned = persistedQueues.get(replacement.previousSessionId);
      if (orphaned?.length) {
        const ids = new Set<string>();
        const mergedQueue = [
          ...cloneWebQueue(orphaned),
          ...cloneWebQueue(next.queue),
        ].filter((item) => {
          if (ids.has(item.id)) return false;
          ids.add(item.id);
          return true;
        });
        await queueStoreWriter.mutate(persistedQueues, (queues) => {
          queues.delete(replacement.previousSessionId);
          if (mergedQueue.length > 0) queues.set(next.id, mergedQueue);
        });
        next.queue = mergedQueue;
        broadcastToSessionClients(next.id, webQueueEvent(next));
        if (next.status === "idle" && next.agentRunning !== true)
          scheduleQueueSettleFallback(next);
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
    const mergedQueue = [
      ...cloneWebQueue(previous.queue),
      ...cloneWebQueue(next.queue),
    ].filter((item) => {
      if (ids.has(item.id)) return false;
      ids.add(item.id);
      return true;
    });
    try {
      await queueStoreWriter.mutate(persistedQueues, (queues) => {
        queues.delete(previous.id);
        if (mergedQueue.length > 0) queues.set(next.id, mergedQueue);
        else queues.delete(next.id);
      });
    } catch (error) {
      previous.queueMutationsQuiesced = false;
      throw error;
    }
    next.queue = mergedQueue;
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
    runtime.sessions.delete(previous.id);
    if (previous.file)
      runtime.sessionsByFile.delete(normalizePath(previous.file));
    for (const agent of previous.agentSockets) {
      if (agent === socket) continue;
      try {
        agent.close();
      } catch {
        /* ignore */
      }
    }
    broadcastToSessionClients(next.id, webQueueEvent(next));
    sendSessionRemoved(previous.id, next.id);
    if (
      next.status === "idle" &&
      next.agentRunning !== true &&
      next.queue.length > 0
    )
      scheduleQueueSettleFallback(next);
  }

  return { completeExternalSessionReplacement };
}

export type SessionReplacement = ReturnType<typeof createSessionReplacement>;
