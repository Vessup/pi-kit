export type AssistantTerminalNotice = {
	kind: "error" | "stopped";
	title: string;
	detail: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function assistantTerminalNotice(message: unknown): AssistantTerminalNotice | undefined {
	if (!isRecord(message) || message.role !== "assistant") return undefined;
	const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
	if (stopReason !== "error" && stopReason !== "aborted") return undefined;
	const detail = typeof message.errorMessage === "string" && message.errorMessage.trim()
		? message.errorMessage.trim()
		: stopReason === "aborted" ? "The operation was aborted before Pi could finish." : "Pi stopped before completing the response.";
	return stopReason === "aborted"
		? { kind: "stopped", title: "Run stopped", detail }
		: { kind: "error", title: "Run failed", detail };
}

export function agentEndTerminalNotice(event: unknown): AssistantTerminalNotice | undefined {
	if (!isRecord(event) || event.type !== "agent_end" || !Array.isArray(event.messages)) return undefined;
	for (let index = event.messages.length - 1; index >= 0; index -= 1) {
		const notice = assistantTerminalNotice(event.messages[index]);
		if (notice) return notice;
	}
	return undefined;
}
