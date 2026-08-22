export type AssistantTerminalNotice = {
  kind: "error" | "stopped";
  title: string;
  detail: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function assistantTerminalNotice(
  message: unknown,
): AssistantTerminalNotice | undefined {
  if (!isRecord(message) || message.role !== "assistant") return undefined;
  const stopReason =
    typeof message.stopReason === "string" ? message.stopReason : undefined;
  if (stopReason !== "error" && stopReason !== "aborted") return undefined;
  const rawDetail =
    typeof message.errorMessage === "string" && message.errorMessage.trim()
      ? message.errorMessage.trim()
      : undefined;
  // Pi's user-initiated Stop can surface as stopReason "error" with one of
  // these exact runtime messages. Do not infer cancellation from arbitrary
  // provider prose containing "abort", which could hide a genuine failure.
  const aborted =
    stopReason === "aborted" ||
    rawDetail === "This operation was aborted" ||
    rawDetail === "Request was aborted";
  const detail =
    rawDetail ??
    (aborted
      ? "The operation was aborted before Pi could finish."
      : "Pi stopped before completing the response.");
  return aborted
    ? { kind: "stopped", title: "Stopped", detail }
    : { kind: "error", title: "Run failed", detail };
}

export function agentEndTerminalNotice(
  event: unknown,
): AssistantTerminalNotice | undefined {
  if (
    !isRecord(event) ||
    event.type !== "agent_end" ||
    !Array.isArray(event.messages)
  )
    return undefined;
  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const notice = assistantTerminalNotice(event.messages[index]);
    if (notice) return notice;
  }
  return undefined;
}
