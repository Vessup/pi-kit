import type { SessionRecord } from "./server-types.js";
import type { ServerRuntimeState } from "./serverRuntimeState.js";

export function isSuccessfulCompactionEnd(
  event: Record<string, unknown>,
): boolean {
  return event.aborted !== true && typeof event.errorMessage !== "string";
}

/**
 * A managed bridge can replace compacted history after the compaction_end
 * event settles. Wait for that trailing snapshot so the completion notice is
 * not immediately wiped by the authoritative history replacement.
 */
export function createCompactionNotice(options: {
  state: ServerRuntimeState;
  broadcastCompactionComplete: (record: SessionRecord) => void;
}) {
  const { state: runtime, broadcastCompactionComplete } = options;

  function broadcastCompactionNotice(record: SessionRecord): void {
    const refresh = record.compactionHistoryRefresh;
    const deliver = () => {
      if (runtime.sessions.get(record.id) !== record) return;
      broadcastCompactionComplete(record);
    };
    if (refresh)
      void refresh.then(deliver, () => {
        deliver();
      });
    else deliver();
  }

  return { broadcastCompactionNotice };
}

export type CompactionNotice = ReturnType<typeof createCompactionNotice>;
