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

function entryText(entry: SemanticEntry): string {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        Boolean(part) &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
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
    .map((entry) => ({ text: entryText(entry), time: entryTime(entry) }))
    .filter(({ text }) => Boolean(text));
  const local = previous.filter((entry) => {
    if (isLocalCommandEntry(entry))
      return !entry.id || !incomingIds.has(entry.id);
    if (!isOptimisticPromptEntry(entry)) return false;
    const text = entryText(entry);
    const time = entryTime(entry);
    return (
      !text ||
      !incomingUsers.some(
        (candidate) =>
          candidate.text === text &&
          (time === undefined ||
            candidate.time === undefined ||
            candidate.time >= time),
      )
    );
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
