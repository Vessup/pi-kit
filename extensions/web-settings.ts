import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TailscaleWebSettings } from "../web/tailscale.js";

const SETTINGS_PATH = join(getAgentDir(), "settings.json");
type ReleaseLock = () => Promise<void>;
type LockSettingsFile = (
  path: string,
  options: {
    realpath: boolean;
    retries: { retries: number; minTimeout: number; maxTimeout: number };
  },
) => Promise<ReleaseLock>;
const lockfile = createRequire(import.meta.url)("proper-lockfile") as {
  lock: LockSettingsFile;
};

type SettingsWriteDependencies = {
  lock: LockSettingsFile;
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  rename: typeof rename;
  rm: typeof rm;
  randomUUID: typeof randomUUID;
};

const defaultWriteDependencies: SettingsWriteDependencies = {
  lock: lockfile.lock,
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  randomUUID,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configuredPort(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65_535
    ? value
    : 8443;
}

export async function readWebTailscaleSetting(): Promise<TailscaleWebSettings> {
  try {
    const root: unknown = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
    const web = isRecord(root) && isRecord(root.web) ? root.web : {};
    const tailscale = isRecord(web.tailscale) ? web.tailscale : {};
    const serviceName =
      typeof tailscale.serviceName === "string"
        ? tailscale.serviceName.trim().replace(/^svc:/, "") || undefined
        : undefined;
    return {
      enabled: tailscale.enabled === true,
      httpsPort: configuredPort(tailscale.httpsPort),
      serviceName,
    };
  } catch {
    return { enabled: false, httpsPort: 8443 };
  }
}

/** Persist one package-specific setting without dropping keys owned by Pi or other extensions. */
export async function writeWebTailscaleSettingFile(
  settingsPath: string,
  setting: TailscaleWebSettings,
  dependencies: Partial<SettingsWriteDependencies> = {},
): Promise<void> {
  const io = { ...defaultWriteDependencies, ...dependencies };
  const settingsDir = dirname(settingsPath);
  await io.mkdir(settingsDir, { recursive: true });
  // Match Pi's FileSettingsStorage protocol: proper-lockfile on settings.json,
  // with realpath disabled so the first writer can lock a not-yet-created file.
  const release = await io.lock(settingsPath, {
    realpath: false,
    retries: { retries: 9, minTimeout: 20, maxTimeout: 20 },
  });
  try {
    let root: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(
        await io.readFile(settingsPath, "utf8"),
      );
      if (isRecord(parsed)) root = parsed;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        // First global setting write.
      } else {
        throw new Error(
          `Could not read ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const web = isRecord(root.web) ? { ...root.web } : {};
    web.tailscale = {
      enabled: setting.enabled,
      httpsPort: configuredPort(setting.httpsPort),
      ...(setting.serviceName
        ? { serviceName: setting.serviceName.replace(/^svc:/, "") }
        : {}),
    };
    root.web = web;
    const tempPath = join(
      settingsDir,
      `.settings.${process.pid}.${io.randomUUID()}.tmp`,
    );
    try {
      await io.writeFile(tempPath, `${JSON.stringify(root, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await io.rename(tempPath, settingsPath);
    } finally {
      await io.rm(tempPath, { force: true }).catch(() => undefined);
    }
  } finally {
    await release();
  }
}

/** Persist the package-specific global Pi setting without dropping unknown keys. */
export async function writeWebTailscaleSetting(
  setting: TailscaleWebSettings,
): Promise<void> {
  await writeWebTailscaleSettingFile(SETTINGS_PATH, setting);
}
