import { randomUUID } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ServerStateFile, WEB_STATE_VERSION } from "../protocol.js";
import type { TailscaleStatus } from "../tailscale.js";
import type { DaemonOwnershipResolver } from "./daemonOwnership.js";
import type { DiscoveryState } from "./discoveryState.js";
import { internalError, isTrustedBrowserOrigin } from "./http-utils.js";
import type { HttpApi } from "./httpApi.js";
import type { ManagedSessionLauncher } from "./managedSessionCreate.js";
import type { ManagedSessionRefresh } from "./managedSessionRefresh.js";
import { quiesceQueueMutations } from "./queue-mutation.js";
import type {
  SessionFileCatalog,
  SessionQueueCoordinator,
  SessionRecord,
  SocketData,
} from "./server-types.js";

const WEB_BUILD_TIMEOUT_MS = 10_000;

import type { WebServerConfig } from "./serverConfig.js";
import {
  MAX_WEBSOCKET_PAYLOAD_BYTES,
  MISSING_SESSION_RECONCILE_INTERVAL_MS,
} from "./serverConfig.js";
import type { ServerRuntimeState } from "./serverRuntimeState.js";
import type { SessionDeletion } from "./sessionDeletion.js";
import {
  shouldContinueManagedShutdownWait,
  shouldWaitForManagedShutdown,
} from "./shutdown-policy.js";
import {
  ensureDir,
  getOrCreateWebState,
  readStateFile,
  writeStateFileAtomic,
} from "./stateFileStore.js";
import type { WebSocketGateway } from "./webSocketGateway.js";

/** Daemon startup (ownership, assets, listener, tailscale) and shutdown. */
export function createServerLifecycle(options: {
  config: WebServerConfig;
  state: ServerRuntimeState;
  catalog: SessionFileCatalog;
  discovery: DiscoveryState;
  ownership: DaemonOwnershipResolver;
  httpApi: HttpApi;
  gateway: WebSocketGateway;
  launcher: ManagedSessionLauncher;
  refresh: ManagedSessionRefresh;
  deletion: SessionDeletion;
  queue: SessionQueueCoordinator;
  staticAssetResponse: (request: Request) => Response | undefined;
}) {
  const {
    config,
    state: runtime,
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
  } = options;
  const { isRecord } = catalog;
  const { cancelWebQueueWork } = queue;

  async function cleanupAndExit(code = 0): Promise<void> {
    const managedShutdownTimeoutMs = 15_000;
    // Repeated TERM/INT delivery is common during deploys. Never reinterpret it as
    // permission to abort managed work; an operator can still use SIGKILL for a
    // truly wedged process.
    if (runtime.shutdownStarted) return;
    runtime.shutdownStarted = true;
    if (runtime.missingSessionReconcileTimer)
      clearInterval(runtime.missingSessionReconcileTimer);
    runtime.missingSessionReconcileTimer = undefined;
    const busyNames = () =>
      [...runtime.sessions.values()]
        .filter(shouldWaitForManagedShutdown)
        .map((record) => record.name ?? record.id);
    const shutdownStartedAt = Date.now();
    let busy = busyNames();
    if (busy.length > 0)
      console.error(
        `Waiting for active managed sessions before restart: ${busy.join(", ")}`,
      );
    while (shouldContinueManagedShutdownWait(busy.length)) {
      if (Date.now() - shutdownStartedAt >= managedShutdownTimeoutMs) break;
      await Bun.sleep(100);
      busy = busyNames();
    }
    if (busy.length > 0)
      console.error(
        `Proceeding with shutdown while sessions remain active: ${busy.join(", ")}`,
      );
    // Stop admitting queue work and drain each per-session mutation tail before the
    // final snapshot. This prevents a late mutation from racing or following flush.
    const records: SessionRecord[] = [...runtime.sessions.values()];
    // A single rejected mutation tail must not skip the remaining cleanup or the
    // final exit; each step is individually best-effort.
    await Promise.all(
      records.map((record) =>
        quiesceQueueMutations(record).catch(() => undefined),
      ),
    );
    // Accepted queue items are removed in memory before their durable snapshot may
    // finish. Drain any existing write before the final write, all within one bound.
    await Promise.all(
      records.map(async (record) => {
        if (record.queueDirtyWorker)
          await record.queueDirtyWorker
            .flushAndCancel(1_000)
            .catch(() => undefined);
      }),
    );
    for (const record of runtime.sessions.values()) {
      cancelWebQueueWork(record);
      try {
        await deletion.stopRecord(record);
      } catch {
        // ignore
      }
    }
    try {
      runtime.server?.stop();
    } catch {
      // ignore
    }
    try {
      if (readStateFile(config.stateFilePath)?.pid === process.pid)
        rmSync(config.stateFilePath, { force: true });
    } catch {
      // ignore
    }
    setTimeout(() => process.exit(code), 25);
  }

  // Source and Git checkouts rebuild on every startup so a long-running server
  // serves assets matching their checked-out source. Registry packages ship the
  // prepack build without build-only devDependencies, so use those bundled assets.
  async function buildWebClientAssets(): Promise<void> {
    if (!existsSync(join(config.rootDir, ".git"))) {
      try {
        if (statSync(join(config.distDir, "index.html")).isFile()) return;
      } catch {
        // Incomplete/source archives have no .git or bundled build; try rebuilding.
      }
    }
    // Test suites opt out of the per-startup rebuild: they spawn ~30 daemons per
    // run and never exercise asset freshness, and each rebuild puts the state
    // file behind a full vite build. Skip only when assets already exist.
    if (process.env.PI_WEB_SKIP_ASSET_BUILD === "1") {
      try {
        if (statSync(join(config.distDir, "index.html")).isFile()) return;
      } catch {
        // No built assets yet; fall through and build them.
      }
    }
    console.log("Building web client assets...");
    const build = Bun.spawn({
      cmd: ["bun", "run", "webBuild"],
      cwd: config.rootDir,
      stdout: "inherit",
      stderr: "inherit",
      timeout: WEB_BUILD_TIMEOUT_MS,
    });
    const code = await build.exited;
    if (code !== 0)
      console.error(
        `webBuild exited with code ${code}; serving whatever assets already exist in ${config.distDir}.`,
      );
  }

  async function start(): Promise<void> {
    // Signals must be handled before ownership resolution: eviction can wait a
    // long time for the incumbent's graceful exit, and an interrupt during that
    // window would otherwise kill this process with default handlers mid-eviction.
    process.on("SIGINT", () => void cleanupAndExit(0));
    process.on("SIGTERM", () => void cleanupAndExit(0));
    process.on("exit", () => {
      try {
        if (readStateFile(config.stateFilePath)?.pid === process.pid)
          rmSync(config.stateFilePath, { force: true });
      } catch {
        // ignore
      }
    });
    const resolved = await ownership.resolveDaemonOwnership();
    if (resolved.action === "abort") {
      console.error(`pi web server could not start: ${resolved.reason}`);
      process.exit(1);
    }
    if (resolved.action === "defer") {
      // Another daemon already owns machine-wide discovery. Restoring its state
      // file (when missing) lets Pi sessions find it; never touch its Tailscale
      // Serve route, never race it for the port. Exit quietly instead.
      if (resolved.republished) {
        ensureDir(dirname(config.stateFilePath));
        const restored: ServerStateFile = {
          pid: resolved.owner.pid,
          port: resolved.owner.port,
          startedAt: Date.now(),
          version: WEB_STATE_VERSION,
          ...(isRecord(resolved.owner.tailscale)
            ? { tailscale: resolved.owner.tailscale as TailscaleStatus }
            : {}),
        };
        writeStateFileAtomic(config.stateFilePath, restored);
      }
      console.log(
        `pi web server already running (pid ${resolved.owner.pid} on port ${resolved.owner.port}); deferring`,
      );
      process.exit(0);
    }
    await buildWebClientAssets();
    await refresh.recoverStagedSourceSessionDeletions();
    discovery.setWebState(getOrCreateWebState(runtime.port));
    runtime.server = Bun.serve<unknown>({
      hostname: config.host,
      port: runtime.port,
      async fetch(request, serverInstance) {
        const url = new URL(request.url);
        if (url.pathname === "/ws/client") {
          // Browser WebSockets are not covered by CORS. Require the initiating
          // page to have the exact host served directly or forwarded by Tailscale.
          // This preserves tokenless iOS bookmarks while preventing arbitrary web
          // origins from driving shell-capable sessions.
          const tailscale = discovery.getTailscaleStatus();
          if (
            !isTrustedBrowserOrigin(
              request,
              tailscale.published ? tailscale.url : undefined,
            )
          )
            return new Response("Forbidden WebSocket origin", { status: 403 });
          const upgraded = serverInstance.upgrade(request, {
            data: {
              kind: "client",
              id: randomUUID(),
              authed: false,
            } as SocketData,
          });
          return upgraded
            ? undefined
            : new Response("Upgrade failed", { status: 400 });
        }
        if (url.pathname === "/ws/agent") {
          // The Pi bridge connects directly to localhost without Origin or proxy
          // headers. Tailscale Serve forwards this route too, so Origin absence alone
          // must not let a tailnet client impersonate an agent.
          const forwarded = [
            "forwarded",
            "x-forwarded-for",
            "x-forwarded-host",
            "x-forwarded-proto",
          ].some((header) => request.headers.has(header));
          if (request.headers.has("origin") || forwarded)
            return new Response("Forbidden agent WebSocket", { status: 403 });
          const upgraded = serverInstance.upgrade(request, {
            data: {
              kind: "agent",
              id: randomUUID(),
              authed: false,
            } as SocketData,
          });
          return upgraded
            ? undefined
            : new Response("Upgrade failed", { status: 400 });
        }
        try {
          const asset = staticAssetResponse(request);
          return asset ?? (await httpApi.handleApi(request));
        } catch (error) {
          return internalError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
      websocket: {
        maxPayloadLength: MAX_WEBSOCKET_PAYLOAD_BYTES,
        open() {
          gateway.handleWebSocketOpen();
        },
        message(socket, data) {
          void gateway.handleWebSocketMessage(
            socket as Bun.ServerWebSocket<SocketData>,
            data as string | Uint8Array,
          );
        },
        close(socket) {
          gateway.handleWebSocketClose(
            socket as Bun.ServerWebSocket<SocketData>,
          );
        },
      },
    });
    runtime.port = runtime.server.port ?? runtime.port;
    discovery.setWebState({ ...discovery.getWebState(), port: runtime.port });
    // Configure Serve only after localhost is listening, then publish discovery
    // state with the final tailnet URL. Simultaneous startup losers never acquire
    // the port and therefore cannot overwrite the winning server's state.
    await discovery.configureTailscaleServe();
    console.log(
      `pi web server listening on http://${config.host}:${runtime.port}`,
    );
    runtime.missingSessionReconcileTimer = setInterval(
      () => void deletion.reconcileMissingSessionFiles(),
      MISSING_SESSION_RECONCILE_INTERVAL_MS,
    );
    runtime.missingSessionReconcileTimer.unref?.();
    // Keep readiness independent from JSONL catalog work, then restore only the
    // browser-owned sessions that were active before the daemon stopped. Native
    // bridge sessions reconnect themselves and are never started in RPC mode here.
    setTimeout(() =>
      void launcher.restoreManagedSessions().catch((error) => {
        console.error("Could not restore managed web sessions:", error);
      }),
      250,
    );
  }

  return { start, cleanupAndExit };
}
