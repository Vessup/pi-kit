import type { SemanticEntry } from "./semantic-session";

export function semanticEntryIdentity(entry: SemanticEntry): string | undefined {
  const message = entry.message;
  if (typeof message?.id === "string") return `id:${message.id}`;
  const role = typeof message?.role === "string" ? message.role : "";
  const timestamp = typeof message?.timestamp === "number" || typeof message?.timestamp === "string" ? String(message.timestamp) : "";
  if (timestamp) return `${role}:${timestamp}`;
  if (entry.id && !entry.id.startsWith("optimistic-")) return `entry:${entry.id}`;
  return undefined;
}

export function preserveSemanticEntryKeys(previous: SemanticEntry[], incoming: SemanticEntry[]): SemanticEntry[] {
  const previousIds = new Map<string, string>();
  for (const entry of previous) {
    const identity = semanticEntryIdentity(entry);
    if (identity && entry.id && !entry.id.startsWith("optimistic-")) previousIds.set(identity, entry.id);
  }
  return incoming.map((entry) => {
    const identity = semanticEntryIdentity(entry);
    const id = identity ? previousIds.get(identity) : undefined;
    return id ? { ...entry, id } : entry;
  });
}

export function mergeSemanticHistory(previous: SemanticEntry[], incoming: SemanticEntry[]): SemanticEntry[] {
  const reconciled = preserveSemanticEntryKeys(previous, incoming);
  const incomingIdentities = new Set(reconciled.map(semanticEntryIdentity).filter((identity): identity is string => Boolean(identity)));
  const retained = previous.filter((entry) => {
    const identity = semanticEntryIdentity(entry);
    return identity ? !incomingIdentities.has(identity) : false;
  });
  return [...reconciled, ...retained];
}

export function semanticHistoriesEqual(previous: SemanticEntry[], incoming: SemanticEntry[]): boolean {
  if (previous.length !== incoming.length) return false;
  return previous.every((entry, index) => {
    const next = incoming[index];
    if (!next || semanticEntryIdentity(entry) !== semanticEntryIdentity(next)) return false;
    try {
      return JSON.stringify({ type: entry.type, message: entry.message }) === JSON.stringify({ type: next.type, message: next.message });
    } catch {
      return false;
    }
  });
}
