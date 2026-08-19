import type { ServerStateFile } from "../protocol.js";
import type { TailscaleStatus } from "../tailscale.js";
import type { ClientSocketData, SessionRecord } from "./server-types.js";
import type { WebServerConfig } from "./serverConfig.js";

/**
 * Mutable daemon-wide runtime state shared by the server feature modules.
 * Everything here was module-scope state in the original single-file server;
 * grouping it keeps the feature factories testable and avoids hidden globals.
 */
export type ServerRuntimeState = {
  /** Effective port; updated after `Bun.serve` binds (port 0 picks one). */
  port: number;
  webState: ServerStateFile;
  tailscaleStatus: TailscaleStatus;
  shutdownStarted: boolean;
  server?: Bun.Server<unknown>;
  missingSessionReconcileTimer?: ReturnType<typeof setInterval>;
  sessions: Map<string, SessionRecord>;
  sessionsByFile: Map<string, SessionRecord>;
  connectedClientSockets: Set<Bun.ServerWebSocket<ClientSocketData>>;
  managedSessionStarts: Map<string, Promise<SessionRecord>>;
  missingSessionReconciliations: Set<SessionRecord>;
};

export function createServerRuntimeState(
  config: WebServerConfig,
): ServerRuntimeState {
  return {
    port: config.initialPort,
    // Assigned in serverStartup once this process wins daemon ownership.
    webState: undefined as unknown as ServerStateFile,
    tailscaleStatus: {
      installed: false,
      enabled: false,
      available: false,
      published: false,
    },
    shutdownStarted: false,
    sessions: new Map(),
    sessionsByFile: new Map(),
    connectedClientSockets: new Set(),
    managedSessionStarts: new Map(),
    missingSessionReconciliations: new Set(),
  };
}
