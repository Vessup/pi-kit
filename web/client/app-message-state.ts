import type { ActiveTool, SemanticEntry } from "./semantic-session";

function messageContentParts(
  message: Record<string, unknown>,
): Array<Record<string, unknown>> {
  if (typeof message.content === "string")
    return [{ type: "text", text: message.content }];
  return Array.isArray(message.content)
    ? message.content.filter(
        (part): part is Record<string, unknown> =>
          Boolean(part) && typeof part === "object",
      )
    : [];
}

export function messageText(message: Record<string, unknown>): string {
  return messageContentParts(message)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function upsertActiveTool(
  tools: ActiveTool[],
  event: Record<string, unknown>,
  patch: Pick<ActiveTool, "running"> &
    Partial<Pick<ActiveTool, "result" | "isError">>,
): ActiveTool[] {
  const id = String(event.toolCallId ?? "");
  if (!id) return tools;
  const existing = tools.find((tool) => tool.id === id);
  const next: ActiveTool = {
    id,
    name:
      typeof event.toolName === "string"
        ? event.toolName
        : (existing?.name ?? "tool"),
    args: event.args ?? existing?.args,
    result: patch.result ?? existing?.result,
    isError: patch.isError ?? existing?.isError,
    running: patch.running,
  };
  return [...tools.filter((tool) => tool.id !== id), next];
}

export async function waitForVisibleBrowserPaint(): Promise<void> {
  if (document.visibilityState !== "visible") return;
  await Promise.race([
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    ),
    new Promise<void>((resolve) => window.setTimeout(resolve, 100)),
  ]);
}

export function preserveOptimisticAttachments(
  confirmed: Record<string, unknown>,
  optimistic: SemanticEntry,
): Record<string, unknown> {
  const confirmedParts = messageContentParts(confirmed);
  const confirmedHasImages = confirmedParts.some(
    (part) => part.type === "image",
  );
  if (confirmedHasImages || !optimistic.message) return confirmed;
  const attachments = messageContentParts(optimistic.message).filter(
    (part) => part.type === "image",
  );
  return attachments.length > 0
    ? { ...confirmed, content: [...confirmedParts, ...attachments] }
    : confirmed;
}
