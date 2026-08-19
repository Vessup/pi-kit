import type { DaemonHealth } from "./daemon-process.js";
import {
  incumbentDisposition,
  isPidAlive,
  isPiWebDaemonPid,
  terminatePiWebDaemon,
  waitForDaemonHealth,
} from "./daemon-process.js";
import type { WebServerConfig } from "./serverConfig.js";
import type { ServerRuntimeState } from "./serverRuntimeState.js";
import { readStateFile } from "./stateFileStore.js";

/**
 * Decide whether this process may own machine-wide discovery (state file and
 * Tailscale Serve route). A healthy daemon that already exists is deferred to;
 * a daemon whose checkout no longer exists is replaced. Without this, a
 * side-port daemon steals the shared Serve route and a daemon from a deleted
 * checkout serves 404s forever while still passing /api/health.
 */
export type DaemonOwnership =
  | { action: "own" }
  | { action: "abort"; reason: string }
  | { action: "defer"; owner: DaemonHealth; republished: boolean };

export function createDaemonOwnership(options: {
  config: WebServerConfig;
  state: ServerRuntimeState;
}) {
  const { config, state: runtime } = options;

  async function ownershipForIncumbent(
    health: DaemonHealth,
    republished: boolean,
  ): Promise<DaemonOwnership> {
    switch (incumbentDisposition(health)) {
      case "serve":
      case "keep":
        // Defer to the incumbent (keep = failed build over an existing
        // checkout; respawning from the same checkout would fail identically).
        return { action: "defer", owner: health, republished };
      case "evict": {
        const stopped = await terminatePiWebDaemon(health.pid);
        if (stopped) return { action: "own" };
        // The incumbent still holds the port; never race it for the listener.
        return {
          action: "abort",
          reason: `pid ${health.pid} still holds port ${health.port} and could not be stopped`,
        };
      }
    }
  }

  async function resolveDaemonOwnership(): Promise<DaemonOwnership> {
    const existing = readStateFile(config.stateFilePath);
    if (existing && existing.pid !== process.pid && isPidAlive(existing.pid)) {
      // Only a verified Pi web daemon may be probed or stopped; a recycled pid
      // naming an unrelated process must never be signaled.
      if (await isPiWebDaemonPid(existing.pid)) {
        const health = await waitForDaemonHealth(
          existing.port,
          existing.pid,
          3_000,
        );
        if (!health) {
          // Verified daemon that never answers: wedged. Replace it, but only
          // claim ownership when it actually stopped; otherwise another process
          // still holds the port and Bun.serve would fail to listen.
          if (await terminatePiWebDaemon(existing.pid))
            return { action: "own" };
          return {
            action: "abort",
            reason: `pid ${existing.pid} still holds port ${existing.port} and could not be stopped`,
          };
        }
        // The state file already names the incumbent, so it needs no rewrite.
        return ownershipForIncumbent(health, false);
      }
      return { action: "own" };
    }
    // Discovery state is missing or points at a dead pid. When the intended
    // port already has a healthy daemon, adopt it by restoring its state file
    // instead of racing it for the port; evict it only when provably broken.
    if (runtime.port !== 0) {
      const health = await waitForDaemonHealth(runtime.port, undefined, 1_500);
      if (
        health &&
        isPidAlive(health.pid) &&
        (await isPiWebDaemonPid(health.pid))
      ) {
        return ownershipForIncumbent(health, true);
      }
    }
    return { action: "own" };
  }

  return { resolveDaemonOwnership };
}

export type DaemonOwnershipResolver = ReturnType<typeof createDaemonOwnership>;
