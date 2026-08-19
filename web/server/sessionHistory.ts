import {
  buildContextEntries,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  boundedWebHistory,
  WEB_HISTORY_MAX_BYTES,
  WEB_HISTORY_MAX_ENTRIES,
  webHistoryByteLength,
} from "../history.js";
import type { SessionFileCatalog, SessionRecord } from "./server-types.js";

/**
 * Bounded semantic history maintained per record.
 * sessionHistoryForRecord lazily hydrates file-backed records and mutates
 * record.history, record.historyReady, and record.historyBytes through
 * replaceRecordHistory.
 */
export function createSessionHistory(options: { catalog: SessionFileCatalog }) {
  const { parseSessionFile, isRecord } = options.catalog;

  function replaceRecordHistory(
    record: SessionRecord,
    entries: readonly unknown[],
  ): void {
    record.history = boundedWebHistory(entries);
    record.historyReady = true;
    record.historyBytes = webHistoryByteLength(record.history);
  }

  function appendRecordHistory(record: SessionRecord, entry: unknown): void {
    const appended = boundedWebHistory([entry], { maxEntries: 1 });
    if (appended.length === 0) return;
    record.history.push(appended[0]);
    record.historyReady = true;
    record.historyBytes =
      (record.historyBytes ??
        webHistoryByteLength(record.history.slice(0, -1))) +
      webHistoryByteLength(appended);
    while (
      record.history.length > 0 &&
      (record.history.length > WEB_HISTORY_MAX_ENTRIES ||
        record.historyBytes > WEB_HISTORY_MAX_BYTES)
    ) {
      const first = record.history[0];
      const preserveSummary =
        isRecord(first) &&
        typeof first.id === "string" &&
        first.id.startsWith("web-compaction-");
      const removeIndex = preserveSummary && record.history.length > 1 ? 1 : 0;
      const [removed] = record.history.splice(removeIndex, 1);
      record.historyBytes = Math.max(
        2,
        record.historyBytes - webHistoryByteLength([removed]),
      );
    }
  }

  function sessionHistoryForRecord(record: SessionRecord): unknown[] {
    if (record.active || record.historyReady) return [...record.history];
    if (record.file) {
      const scan = parseSessionFile(record.file);
      if (scan) {
        replaceRecordHistory(
          record,
          buildContextEntries(scan.history as SessionEntry[]),
        );
        return [...record.history];
      }
    }
    return [...record.history];
  }

  return { replaceRecordHistory, appendRecordHistory, sessionHistoryForRecord };
}

export type SessionHistory = ReturnType<typeof createSessionHistory>;
