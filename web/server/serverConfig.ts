import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DEFAULT_WEB_PORT } from "../protocol.js";

export type WebServerConfig = {
  /** Repository root serving the web client and running `webBuild`. */
  rootDir: string;
  /** Built browser assets served by the static responder. */
  distDir: string;
  /** Machine-wide daemon discovery state file. */
  stateFilePath: string;
  agentDir: string;
  settingsPath: string;
  sessionsDir: string;
  queueStorePath: string;
  managedSessionStorePath: string;
  host: string;
  /** Port requested via env before `Bun.serve` reports the bound port. */
  initialPort: number;
};

export const LONG_RUNNING_COMMAND_TIMEOUT_MS = 10 * 60_000;
export const MISSING_SESSION_RECONCILE_INTERVAL_MS = 1_000;
// Accept one legacy agent.hello containing a large session until running Pi
// processes reload the bridge that sends metadata-only hello frames.
export const MAX_WEBSOCKET_PAYLOAD_BYTES = 32 * 1024 * 1024;

function envPath(name: string, fallback: string): string {
  const value = process.env[name];
  return resolve(
    value ? (isAbsolute(value) ? value : join(process.cwd(), value)) : fallback,
  );
}

/** Resolve daemon-wide paths and settings from the process environment. */
export function resolveWebServerConfig(): WebServerConfig {
  const rootDir = resolve(
    process.env.PI_WEB_ROOT
      ? isAbsolute(process.env.PI_WEB_ROOT)
        ? process.env.PI_WEB_ROOT
        : join(process.cwd(), process.env.PI_WEB_ROOT)
      : process.cwd(),
  );
  const stateFilePath = envPath(
    "PI_WEB_STATE_FILE",
    join(homedir(), ".pi", "agent", "web", "server.json"),
  );
  const agentDir = resolve(
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  );
  const configuredPort = Number(
    process.env.PI_WEB_PORT ?? `${DEFAULT_WEB_PORT}`,
  );
  return {
    rootDir,
    distDir: join(rootDir, "web", "dist"),
    stateFilePath,
    agentDir,
    settingsPath: join(agentDir, "settings.json"),
    sessionsDir: join(agentDir, "sessions"),
    queueStorePath: join(dirname(stateFilePath), "queues.json"),
    managedSessionStorePath: join(
      dirname(stateFilePath),
      "managed-sessions.json",
    ),
    host: "127.0.0.1",
    initialPort:
      Number.isInteger(configuredPort) &&
      configuredPort >= 0 &&
      configuredPort <= 65_535
        ? configuredPort
        : DEFAULT_WEB_PORT,
  };
}
