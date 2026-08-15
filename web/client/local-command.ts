import type { SemanticEntry } from "./semantic-session";

const LOCAL_COMMAND_PREFIX = "local-command-";

export function localCommandEntryId(requestId: string): string {
  return `${LOCAL_COMMAND_PREFIX}${requestId}`;
}

export function isLocalCommandEntry(entry: SemanticEntry): boolean {
  return Boolean(entry.id?.startsWith(LOCAL_COMMAND_PREFIX));
}

function entryTime(entry: SemanticEntry): number | undefined {
  if (entry.timestamp) {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  const timestamp = entry.message?.timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Keep browser-issued control commands visible across authoritative history refreshes. */
export function preserveLocalCommandEntries(previous: SemanticEntry[], incoming: SemanticEntry[]): SemanticEntry[] {
  const incomingIds = new Set(incoming.map((entry) => entry.id).filter((id): id is string => Boolean(id)));
  const local = previous.filter((entry) => isLocalCommandEntry(entry) && (!entry.id || !incomingIds.has(entry.id)));
  if (local.length === 0) return incoming;
  return [...incoming, ...local]
    .map((entry, index) => ({ entry, index, time: entryTime(entry) }))
    .sort((left, right) => {
      if (left.time === undefined || right.time === undefined || left.time === right.time) return left.index - right.index;
      return left.time - right.time;
    })
    .map(({ entry }) => entry);
}
