import type { ServerStateFile } from "../protocol.js";
import {
  disableTailscaleServe,
  ensureTailscaleServe,
  readTailscaleWebSettings,
  replaceTailscaleServe,
  type TailscaleStatus,
  type TailscaleWebSettings,
} from "../tailscale.js";
import type { WebServerConfig } from "./serverConfig.js";
import type { ServerRuntimeState } from "./serverRuntimeState.js";
import { writeStateFileAtomic } from "./stateFileStore.js";

/**
 * Owns the published discovery state (`webState`) and the Tailscale Serve
 * route mirrored into it. `webState` is initialized by startup once this
 * process owns machine-wide discovery, exactly like the original server.
 */
export function createDiscoveryState(options: {
  config: WebServerConfig;
  state: ServerRuntimeState;
}) {
  const { config, state: runtime } = options;
  const { stateFilePath, settingsPath } = config;

  function publishTailscaleStatus(status: TailscaleStatus): void {
    runtime.tailscaleStatus = status;
    runtime.webState = { ...runtime.webState, tailscale: status };
    writeStateFileAtomic(stateFilePath, runtime.webState);
  }

  async function configureTailscaleServe(
    settings?: TailscaleWebSettings,
    currentSettings?: TailscaleWebSettings,
  ): Promise<TailscaleStatus> {
    const resolvedSettings =
      settings ?? (await readTailscaleWebSettings(settingsPath));
    if (!config.manageTailscaleServe) {
      const status: TailscaleStatus = {
        installed: false,
        enabled: resolvedSettings.enabled,
        available: false,
        published: false,
        ...(resolvedSettings.enabled
          ? {
              error:
                "Tailscale Serve is reserved for the canonical Pi web daemon; isolated state cannot publish it.",
            }
          : {}),
      };
      publishTailscaleStatus(status);
      return status;
    }
    const status = currentSettings
      ? await replaceTailscaleServe({
          currentSettings,
          nextSettings: resolvedSettings,
          localPort: runtime.port,
        })
      : await ensureTailscaleServe({
          settings: resolvedSettings,
          localPort: runtime.port,
        });
    publishTailscaleStatus(status);
    return status;
  }

  async function removeTailscaleServe(
    settings: TailscaleWebSettings,
  ): Promise<TailscaleStatus> {
    if (!config.manageTailscaleServe) {
      const status: TailscaleStatus = {
        installed: false,
        enabled: settings.enabled,
        available: false,
        published: false,
        error:
          "Tailscale Serve is reserved for the canonical Pi web daemon; isolated state cannot modify it.",
      };
      publishTailscaleStatus(status);
      return status;
    }
    const status = await disableTailscaleServe({
      settings,
      localPort: runtime.port,
    });
    publishTailscaleStatus(status);
    return status;
  }

  return {
    configureTailscaleServe,
    removeTailscaleServe,
    publishTailscaleStatus,
    getWebState(): ServerStateFile {
      return runtime.webState;
    },
    setWebState(next: ServerStateFile): void {
      runtime.webState = next;
    },
    getTailscaleStatus(): TailscaleStatus {
      return runtime.tailscaleStatus;
    },
  };
}

export type DiscoveryState = ReturnType<typeof createDiscoveryState>;
