import { ManagedSessionStore } from "./managed-session-store.js";
import { CoalescedQueueStoreWriter, readQueueStore } from "./queue-store.js";
import type { WebServerConfig } from "./serverConfig.js";

/** Durable sidecar stores shared across session features. */
export function createServerStores(config: WebServerConfig) {
  return {
    persistedQueues: readQueueStore(config.queueStorePath),
    queueStoreWriter: new CoalescedQueueStoreWriter(config.queueStorePath),
    managedSessionStore: new ManagedSessionStore(
      config.managedSessionStorePath,
    ),
  };
}

export type ServerStores = ReturnType<typeof createServerStores>;
