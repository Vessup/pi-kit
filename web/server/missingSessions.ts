import { readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { isConfirmedMissingPath } from "./file-presence.js";
import type { SessionFileCatalog, SessionRecord } from "./server-types.js";
import type { SessionFileScan } from "./session-file-catalog.js";

/**
 * Predicates for sessions whose backing file disappeared without a durable
 * replacement marker. Used to hide records from the catalog and reap leftovers.
 */
export function createMissingSessions(options: {
  sessionsDir: string;
  catalog: SessionFileCatalog;
}) {
  const { sessionsDir, catalog } = options;
  const { sessionFileKey, scanSavedSessions } = catalog;

  function hasStagedOrDurableReplacement(
    record: SessionRecord,
    scans: readonly SessionFileScan[] = scanSavedSessions(sessionsDir),
  ): boolean {
    const sourceFile = record.file;
    if (!sourceFile) return false;
    try {
      const sourceName = basename(sourceFile);
      if (
        readdirSync(dirname(sourceFile)).some(
          (entry) =>
            entry.startsWith(`${sourceName}.replaced-`) &&
            entry.endsWith(".tmp"),
        )
      )
        return true;
    } catch {
      // The containing session directory may itself have been removed.
    }
    const sourceKey = sessionFileKey(sourceFile);
    for (const scan of scans) {
      if (sessionFileKey(scan.file) === sourceKey) continue;
      const replacement = scan.replacement;
      if (
        replacement?.previousSessionId === record.id &&
        sessionFileKey(replacement.previousSessionFile) === sourceKey
      )
        return true;
    }
    return false;
  }

  function isMissingInactiveSession(
    record: SessionRecord,
    scans?: readonly SessionFileScan[],
  ): boolean {
    return Boolean(
      record.file &&
        !record.active &&
        !record.managed &&
        record.agentSockets.size === 0 &&
        isConfirmedMissingPath(record.file) &&
        !hasStagedOrDurableReplacement(record, scans),
    );
  }

  return { hasStagedOrDurableReplacement, isMissingInactiveSession };
}

export type MissingSessions = ReturnType<typeof createMissingSessions>;
