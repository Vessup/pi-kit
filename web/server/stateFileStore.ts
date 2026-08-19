import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type ServerStateFile, WEB_STATE_VERSION } from "../protocol.js";

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function readStateFile(path: string): ServerStateFile | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<ServerStateFile>;
    if (
      parsed &&
      parsed.version === WEB_STATE_VERSION &&
      typeof parsed.pid === "number" &&
      typeof parsed.port === "number" &&
      typeof parsed.startedAt === "number"
    ) {
      return parsed as ServerStateFile;
    }
  } catch {
    // ignore
  }
  return undefined;
}

export function writeStateFileAtomic(
  path: string,
  state: ServerStateFile,
): void {
  ensureDir(dirname(path));
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tempPath, path);
}

export function getOrCreateWebState(port: number): ServerStateFile {
  return {
    pid: process.pid,
    port,
    startedAt: Date.now(),
    version: WEB_STATE_VERSION,
  };
}
