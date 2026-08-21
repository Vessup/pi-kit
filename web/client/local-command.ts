import type { SemanticEntry } from "./semantic-session";

const LOCAL_COMMAND_PREFIX = "local-command-";

export function localCommandEntryId(requestId: string): string {
  return `${LOCAL_COMMAND_PREFIX}${requestId}`;
}

export function isLocalCommandEntry(entry: SemanticEntry): boolean {
  return Boolean(entry.id?.startsWith(LOCAL_COMMAND_PREFIX));
}

function isOptimisticPromptEntry(entry: SemanticEntry): boolean {
  return Boolean(entry.id?.startsWith("optimistic-"));
}

function entryContentIdentity(entry: SemanticEntry): string | undefined {
  const content = entry.message?.content;
  if (typeof content === "string") return JSON.stringify([["text", content]]);
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const value = part as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string")
      return [["text", value.text]];
    if (value.type === "image")
      return [
        [
          "image",
          typeof value.mimeType === "string" ? value.mimeType : "",
          typeof value.data === "string" ? value.data : "",
          value.source ?? null,
        ],
      ];
    return [];
  });
  return parts.length > 0 ? JSON.stringify(parts) : undefined;
}

function entryTime(entry: SemanticEntry): number | undefined {
  if (entry.timestamp) {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  const timestamp = entry.message?.timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp))
    return timestamp;
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Keep submitted browser work visible until authoritative history includes it. */
export function preserveLocalCommandEntries(
  previous: SemanticEntry[],
  incoming: SemanticEntry[],
): SemanticEntry[] {
  const incomingIds = new Set(
    incoming.map((entry) => entry.id).filter((id): id is string => Boolean(id)),
  );
  const incomingUsers = incoming
    .filter((entry) => entry.message?.role === "user")
    .map((entry) => ({
      identity: entryContentIdentity(entry),
      time: entryTime(entry),
      consumed: false,
    }))
    .filter(
      (candidate): candidate is typeof candidate & { identity: string } =>
        candidate.identity !== undefined,
    );
  const local = previous.filter((entry) => {
    if (isLocalCommandEntry(entry))
      return !entry.id || !incomingIds.has(entry.id);
    if (!isOptimisticPromptEntry(entry)) return false;
    const identity = entryContentIdentity(entry);
    const time = entryTime(entry);
    if (!identity) return true;
    const confirmation = incomingUsers.find(
      (candidate) =>
        !candidate.consumed &&
        candidate.identity === identity &&
        (time === undefined ||
          candidate.time === undefined ||
          candidate.time >= time),
    );
    if (!confirmation) return true;
    confirmation.consumed = true;
    return false;
  });
  if (local.length === 0) return incoming;
  return [...incoming, ...local]
    .map((entry, index) => ({ entry, index, time: entryTime(entry) }))
    .sort((left, right) => {
      if (
        left.time === undefined ||
        right.time === undefined ||
        left.time === right.time
      )
        return left.index - right.index;
      return left.time - right.time;
    })
    .map(({ entry }) => entry);
}
