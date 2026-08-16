export const WEB_HISTORY_MAX_BYTES = 8 * 1024 * 1024;
export const WEB_HISTORY_MAX_ENTRIES = 600;
const MAX_HISTORY_STRING_CHARS = 256 * 1024;
const MAX_HISTORY_IMAGE_CHARS = 4 * 1024 * 1024;
const encoder = new TextEncoder();

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null;
}

function sanitizedEntry(
  entry: unknown,
  maxBytes: number,
): { entry: unknown; bytes: number } | undefined {
  const serialize = (
    omitImages: boolean,
  ): { json: string; hadImages: boolean } | undefined => {
    let hadImages = false;
    try {
      const json = JSON.stringify(entry, (key, value: unknown) => {
        if (
          isRecord(value) &&
          value.type === "image" &&
          typeof value.data === "string"
        ) {
          hadImages = true;
          if (omitImages || value.data.length > MAX_HISTORY_IMAGE_CHARS) {
            return {
              type: "text",
              text: `[Pi Web omitted an oversized ${typeof value.mimeType === "string" ? value.mimeType : "image"} attachment]`,
            };
          }
        }
        if (typeof value !== "string") return value;
        if (key === "data")
          return value.length <= MAX_HISTORY_IMAGE_CHARS ? value : undefined;
        if (value.length <= MAX_HISTORY_STRING_CHARS) return value;
        return `${value.slice(0, MAX_HISTORY_STRING_CHARS)}\n\n[Pi Web truncated ${value.length - MAX_HISTORY_STRING_CHARS} characters]`;
      });
      return { json, hadImages };
    } catch {
      return undefined;
    }
  };
  let serialized = serialize(false);
  if (!serialized) return undefined;
  let bytes = encoder.encode(serialized.json).byteLength;
  // Several individually valid images can exceed the aggregate history budget.
  // Keep the authored message and replace its attachments instead of dropping it.
  if (bytes > maxBytes && serialized.hadImages) {
    serialized = serialize(true);
    if (!serialized) return undefined;
    bytes = encoder.encode(serialized.json).byteLength;
  }
  try {
    return { entry: JSON.parse(serialized.json) as unknown, bytes };
  } catch {
    return undefined;
  }
}

export function compactionSummaryHistoryEntry(
  entry: unknown,
  fallbackIndex = 0,
): unknown | undefined {
  if (
    !isRecord(entry) ||
    entry.type !== "compaction" ||
    typeof entry.summary !== "string"
  )
    return undefined;
  const timestamp =
    typeof entry.timestamp === "string"
      ? entry.timestamp
      : new Date().toISOString();
  const timestampMs = Date.parse(timestamp);
  return {
    type: "message",
    id: `web-compaction-${typeof entry.id === "string" ? entry.id : fallbackIndex}`,
    parentId: null,
    timestamp,
    message: {
      role: "assistant",
      content: [
        { type: "text", text: `**Context compacted**\n\n${entry.summary}` },
      ],
      timestamp: Number.isFinite(timestampMs) ? timestampMs : Date.now(),
    },
  };
}

export function boundedWebHistory(
  entries: readonly unknown[],
  options: { maxBytes?: number; maxEntries?: number } = {},
): unknown[] {
  const maxBytes = options.maxBytes ?? WEB_HISTORY_MAX_BYTES;
  const maxEntries = options.maxEntries ?? WEB_HISTORY_MAX_ENTRIES;
  let source = entries;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (isRecord(entry) && entry.type === "compaction") {
      source = [entry, ...entries.slice(index + 1)];
      break;
    }
  }
  const visible = source.flatMap((entry, index) => {
    if (isRecord(entry) && entry.type === "compaction") {
      const summary = compactionSummaryHistoryEntry(entry, index);
      return summary ? [summary] : [];
    }
    return isRecord(entry) && entry.type === "message" ? [entry] : [];
  });
  const summary = visible.find(
    (entry) =>
      isRecord(entry) &&
      typeof entry.id === "string" &&
      entry.id.startsWith("web-compaction-"),
  );
  const sanitizedSummary = summary
    ? sanitizedEntry(summary, maxBytes)
    : undefined;
  const selected: unknown[] = [];
  let bytes =
    2 +
    (sanitizedSummary && sanitizedSummary.bytes + 2 <= maxBytes
      ? sanitizedSummary.bytes + 1
      : 0);
  const availableEntries =
    maxEntries -
    (sanitizedSummary && sanitizedSummary.bytes + 2 <= maxBytes ? 1 : 0);
  for (
    let index = visible.length - 1;
    index >= 0 && selected.length < availableEntries;
    index -= 1
  ) {
    const entry = visible[index];
    if (entry === summary) continue;
    const sanitized = sanitizedEntry(entry, maxBytes);
    if (!sanitized || sanitized.bytes + bytes > maxBytes) continue;
    selected.push(sanitized.entry);
    bytes += sanitized.bytes + 1;
  }
  selected.reverse();
  if (sanitizedSummary && sanitizedSummary.bytes + 2 <= maxBytes)
    selected.unshift(sanitizedSummary.entry);
  return selected;
}

export function webHistoryByteLength(entries: readonly unknown[]): number {
  try {
    return encoder.encode(JSON.stringify(entries)).byteLength;
  } catch {
    return WEB_HISTORY_MAX_BYTES;
  }
}

export function messagesToWebHistory(messages: readonly unknown[]): unknown[] {
  return boundedWebHistory(
    messages.flatMap<unknown>((message, index) => {
      if (!isRecord(message) || typeof message.role !== "string") return [];
      if (
        message.role === "compactionSummary" &&
        typeof message.summary === "string"
      ) {
        return [
          {
            type: "compaction",
            id: `rpc-compaction-${index}`,
            parentId: null,
            timestamp:
              typeof message.timestamp === "number"
                ? new Date(message.timestamp).toISOString()
                : new Date().toISOString(),
            summary: message.summary,
          },
        ];
      }
      if (
        message.role === "branchSummary" ||
        (message.role === "custom" && message.display !== true)
      )
        return [];
      if (
        ![
          "user",
          "assistant",
          "toolResult",
          "bashExecution",
          "custom",
        ].includes(message.role)
      )
        return [];
      return [
        {
          type: "message",
          id: `rpc-context-${typeof message.timestamp === "number" ? message.timestamp : index}-${index}`,
          parentId: null,
          timestamp:
            typeof message.timestamp === "number"
              ? new Date(message.timestamp).toISOString()
              : new Date().toISOString(),
          message,
        },
      ];
    }),
  );
}
