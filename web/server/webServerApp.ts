import { createAgentMessages } from "./agentMessages.js";
import { createClientBroadcast } from "./clientBroadcast.js";
import { createClientMessages } from "./clientMessages.js";
import { createCommandRouter } from "./commandRouter.js";
import { createCompactionNotice } from "./compactionNotice.js";
import { createDaemonOwnership } from "./daemonOwnership.js";
import { createDiscoveryState } from "./discoveryState.js";
import { createGitMetadata } from "./gitMetadata.js";
import { createHttpApi } from "./httpApi.js";
import { createManagedSessionLauncher } from "./managedSessionCreate.js";
import { createManagedSessionRefresh } from "./managedSessionRefresh.js";
import { createMissingSessions } from "./missingSessions.js";
import { createRecordSync } from "./recordSync.js";
import { createRpcSessionFactory } from "./rpcSessions.js";
import type { SessionQueueCoordinator } from "./server-types.js";
import {
  resolveWebServerConfig,
  type WebServerConfig,
} from "./serverConfig.js";
import { createServerLifecycle } from "./serverLifecycle.js";
import type { ServerRuntimeState } from "./serverRuntimeState.js";
import { createServerRuntimeState } from "./serverRuntimeState.js";
import { createServerStores } from "./serverStores.js";
import { createSessionFileCatalog } from "./session-file-catalog.js";
import { createSessionQueueCoordinator } from "./session-queue-coordinator.js";
import { createSessionDeletion } from "./sessionDeletion.js";
import { createSessionHistory } from "./sessionHistory.js";
import { createSessionRegistry } from "./sessionRegistry.js";
import { createSessionReplacement } from "./sessionReplacement.js";
import { createStaticAssetResponder } from "./static-assets.js";
import { createWebSocketGateway } from "./webSocketGateway.js";

/**
 * Composition root for the web daemon. Wires the feature modules together in
 * dependency order; the two genuine cycles (queue coordinator ↔ command
 * router, registry ↔ deletion) are resolved with late-bound references.
 */
export function createWebServerApp() {
  const config: WebServerConfig = resolveWebServerConfig();
  const state: ServerRuntimeState = createServerRuntimeState(config);
  const stores = createServerStores(config);
  const catalog = createSessionFileCatalog({
    sessionsDir: config.sessionsDir,
    managedSessionStore: stores.managedSessionStore,
  });
  const missingSessions = createMissingSessions({
    sessionsDir: config.sessionsDir,
    catalog,
  });
  const history = createSessionHistory({ catalog });
  const recordSync = createRecordSync({ catalog, state });

  let reconcileMissingSessions: () => void | Promise<void> = () => {
    throw new Error("Session registry called before initialization");
  };
  const registry = createSessionRegistry({
    state,
    config,
    catalog,
    stores,
    history,
    missingSessions,
    reconcileMissingSessions: () => reconcileMissingSessions(),
  });

  const broadcast = createClientBroadcast({ state, registry, history });
  const git = createGitMetadata({ state, catalog, broadcast });
  const rpcSessions = createRpcSessionFactory({ config, catalog });

  let router: ReturnType<typeof createCommandRouter> | undefined;
  const queue: SessionQueueCoordinator = createSessionQueueCoordinator({
    persistedQueues: stores.persistedQueues,
    queueStoreWriter: stores.queueStoreWriter,
    currentRecord: (id) => state.sessions.get(id),
    isShutdownStarted: () => state.shutdownStarted,
    broadcast: broadcast.broadcast,
    deliverCommand: (record, command) => {
      if (!router) throw new Error("Command router used before initialization");
      return router.routeCommand(record, command);
    },
    projectSession: registry.sessionToClientPayload,
  });

  const compactionNotice = createCompactionNotice({
    state,
    broadcastCompactionComplete: queue.broadcastCompactionComplete,
  });
  const refresh = createManagedSessionRefresh({
    state,
    config,
    catalog,
    stores,
    history,
    recordSync,
    queue,
    broadcast,
  });
  const replacement = createSessionReplacement({
    state,
    catalog,
    stores,
    queue,
    broadcast,
  });
  router = createCommandRouter({
    config,
    catalog,
    queue,
    registry,
    broadcast,
    refresh,
    git,
    rpcSessions,
  });

  const deletion = createSessionDeletion({
    state,
    config,
    catalog,
    stores,
    queue,
    registry,
    missingSessions,
    broadcast,
    router,
  });
  reconcileMissingSessions = () => void deletion.reconcileMissingSessionFiles();

  const launcher = createManagedSessionLauncher({
    state,
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
    router,
  });
  const clientMessages = createClientMessages({
    state,
    sessionsDir: config.sessionsDir,
    catalog,
    registry,
    queue,
    broadcast,
    router,
    refresh,
  });
  const agentMessages = createAgentMessages({
    state,
    catalog,
    registry,
    history,
    recordSync,
    queue,
    broadcast,
    git,
    compactionNotice,
    replacement,
  });
  const discovery = createDiscoveryState({ config, state });
  const httpApi = createHttpApi({
    config,
    state,
    discovery,
    catalog,
    registry,
    missingSessions,
    launcher,
    deletion,
  });
  const gateway = createWebSocketGateway({
    state,
    catalog,
    broadcast,
    clientMessages,
    agentMessages,
  });
  const ownership = createDaemonOwnership({ config, state });
  const staticAssetResponse = createStaticAssetResponder(config.distDir);
  const lifecycle = createServerLifecycle({
    config,
    state,
    catalog,
    discovery,
    ownership,
    httpApi,
    gateway,
    launcher,
    refresh,
    deletion,
    queue,
    staticAssetResponse,
  });

  return {
    config,
    state,
    discovery,
    deletion,
    launcher,
    refresh,
    httpApi,
    gateway,
    ownership,
    queue,
    lifecycle,
    staticAssetResponse,
  };
}

export type WebServerApp = ReturnType<typeof createWebServerApp>;
