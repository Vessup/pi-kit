import type { WebQueueReplacement } from "../protocol";
import { semanticEntryIdentity } from "./semantic-history";
import type { SemanticEntry } from "./semantic-session";

const LOCAL_COMMAND_PREFIX = "local-command-";

export function localCommandEntryId(requestId: string): string {
  return `${LOCAL_COMMAND_PREFIX}${requestId}`;
}

export function isLocalCommandEntry(entry: SemanticEntry): boolean {
  return Boolean(entry.id?.startsWith(LOCAL_COMMAND_PREFIX));
}

/** Keep model-gated optimistic bubbles synchronized with accepted queue edits. */
export function reconcileOptimisticQueueEntries(
  entries: SemanticEntry[],
  previousQueue: readonly WebQueueReplacement[],
  nextQueue: readonly WebQueueReplacement[],
): SemanticEntry[] {
  const optimisticIds = new Map(
    previousQueue.map((item) => [`optimistic-${item.id}`, item.id]),
  );
  const replacements = new Map(nextQueue.map((item) => [item.id, item]));
  return entries.flatMap((entry) => {
    const queueId = entry.id ? optimisticIds.get(entry.id) : undefined;
    if (!queueId) return [entry];
    const replacement = replacements.get(queueId);
    if (!replacement) return [];
    return [
      {
        ...entry,
        message: {
          ...entry.message,
          role: "user" as const,
          content: [
            ...(replacement.message
              ? [{ type: "text" as const, text: replacement.message }]
              : []),
            ...(replacement.images ?? []).map((image) => ({ ...image })),
          ],
        },
      },
    ];
  });
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

function isBrowserLocalEntry(entry: SemanticEntry): boolean {
  return isLocalCommandEntry(entry) || isOptimisticPromptEntry(entry);
}

export function localHistoryBaselineIdentities(
  entries: readonly SemanticEntry[],
): string[] {
  return entries.flatMap((entry) => {
    if (isBrowserLocalEntry(entry)) return [];
    const identity = semanticEntryIdentity(entry);
    return identity ? [identity] : [];
  });
}

function mergeLocalEntriesByHistoryOrder(
  previous: SemanticEntry[],
  incoming: SemanticEntry[],
  local: SemanticEntry[],
  confirmationIdentities: ReadonlyMap<SemanticEntry, string>,
): SemanticEntry[] {
  const result = [...incoming];
  const incomingIdentities = new Set(
    incoming
      .map(semanticEntryIdentity)
      .filter((identity): identity is string => Boolean(identity)),
  );
  const inserted = new Set<SemanticEntry>();
  const previousIndexes = new Map(
    previous.map((entry, index) => [entry, index]),
  );

  // Insert in reverse so multiple local entries after one authoritative anchor
  // retain their original order without consulting either machine's clock.
  for (let localIndex = local.length - 1; localIndex >= 0; localIndex -= 1) {
    const entry = local[localIndex];
    if (!entry) continue;
    const previousIndex = previousIndexes.get(entry) ?? previous.length;
    let priorAnchorIdentity: string | undefined;
    for (let index = previousIndex - 1; index >= 0; index -= 1) {
      const candidate = previous[index];
      const confirmationIdentity = candidate
        ? confirmationIdentities.get(candidate)
        : undefined;
      if (confirmationIdentity) {
        priorAnchorIdentity = confirmationIdentity;
        break;
      }
      const candidateIdentity = candidate
        ? semanticEntryIdentity(candidate)
        : undefined;
      if (
        candidate &&
        candidateIdentity &&
        !isBrowserLocalEntry(candidate) &&
        incomingIdentities.has(candidateIdentity)
      ) {
        priorAnchorIdentity = candidateIdentity;
        break;
      }
    }
    if (priorAnchorIdentity) {
      const anchorIndex = result.findIndex(
        (candidate) =>
          semanticEntryIdentity(candidate) === priorAnchorIdentity,
      );
      result.splice(anchorIndex + 1, 0, entry);
      inserted.add(entry);
      continue;
    }

    let nextAnchorIdentity: string | undefined;
    for (let index = previousIndex + 1; index < previous.length; index += 1) {
      const candidate = previous[index];
      const confirmationIdentity = candidate
        ? confirmationIdentities.get(candidate)
        : undefined;
      if (confirmationIdentity) {
        nextAnchorIdentity = confirmationIdentity;
        break;
      }
      const candidateIdentity = candidate
        ? semanticEntryIdentity(candidate)
        : undefined;
      if (
        candidate &&
        candidateIdentity &&
        !isBrowserLocalEntry(candidate) &&
        incomingIdentities.has(candidateIdentity)
      ) {
        nextAnchorIdentity = candidateIdentity;
        break;
      }
    }
    if (nextAnchorIdentity) {
      let anchorIndex = result.findIndex(
        (candidate) =>
          semanticEntryIdentity(candidate) === nextAnchorIdentity,
      );
      while (
        anchorIndex > 0 &&
        result[anchorIndex - 1] &&
        inserted.has(result[anchorIndex - 1])
      )
        anchorIndex -= 1;
      result.splice(anchorIndex, 0, entry);
    } else {
      result.unshift(entry);
    }
    inserted.add(entry);
  }
  return result;
}

/** Keep submitted browser work visible until authoritative history includes it. */
export function preserveLocalCommandEntries(
  previous: SemanticEntry[],
  incoming: SemanticEntry[],
): SemanticEntry[] {
  const incomingIds = new Set(
    incoming.map((entry) => entry.id).filter((id): id is string => Boolean(id)),
  );
  const previousAuthoritativeIdentities =
    localHistoryBaselineIdentities(previous);
  const incomingUsers = incoming
    .filter((entry) => entry.message?.role === "user")
    .map((entry) => ({
      historyIdentity: semanticEntryIdentity(entry),
      contentIdentity: entryContentIdentity(entry),
      consumed: false,
    }))
    .filter(
      (
        candidate,
      ): candidate is typeof candidate & {
        historyIdentity: string;
        contentIdentity: string;
      } =>
        candidate.historyIdentity !== undefined &&
        candidate.contentIdentity !== undefined,
    );
  const confirmationIdentities = new Map<SemanticEntry, string>();
  const local = previous.filter((entry) => {
    if (isLocalCommandEntry(entry))
      return !entry.id || !incomingIds.has(entry.id);
    if (!isOptimisticPromptEntry(entry)) return false;
    const identity = entryContentIdentity(entry);
    if (!identity) return true;
    const baseline = new Set(
      entry.localHistoryBaselineIdentities ??
        previousAuthoritativeIdentities,
    );
    const confirmation = incomingUsers.find(
      (candidate) =>
        !candidate.consumed &&
        candidate.contentIdentity === identity &&
        !baseline.has(candidate.historyIdentity),
    );
    if (!confirmation) return true;
    confirmation.consumed = true;
    confirmationIdentities.set(entry, confirmation.historyIdentity);
    return false;
  });
  if (local.length === 0) return incoming;
  return mergeLocalEntriesByHistoryOrder(
    previous,
    incoming,
    local,
    confirmationIdentities,
  );
}
