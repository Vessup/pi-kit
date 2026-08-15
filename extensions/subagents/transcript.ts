import { stringifyCompact, truncateChars } from "./format.js";
import {
	MAX_TRANSCRIPT_ENTRY_CHARS,
	MAX_WEB_STREAMING_CHARS,
	MAX_WEB_TRANSCRIPT_CHARS,
	type ManagedSubagent,
	type TranscriptItem,
	type Usage,
} from "./types.js";

export function appendBoundedStreamingText(current: string, delta: string): string {
	const combined = current + delta;
	return combined.length <= MAX_WEB_STREAMING_CHARS
		? combined
		: combined.slice(-MAX_WEB_STREAMING_CHARS);
}

export function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const item = block as Record<string, unknown>;
		if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
		else if (item.type === "thinking" && typeof item.thinking === "string") parts.push(`[thinking]\n${item.thinking}`);
		else if (item.type === "toolCall" && typeof item.name === "string") {
			parts.push(`→ ${item.name} ${stringifyCompact(item.arguments)}`);
		} else if (item.type === "image") {
			parts.push("[image]");
		}
	}
	return parts.join("\n");
}

export function messageToTranscript(message: unknown): TranscriptItem | undefined {
	if (!message || typeof message !== "object") return undefined;
	const item = message as Record<string, unknown>;
	if (typeof item.role !== "string") return undefined;
	const text = truncateChars(contentToText(item.content), MAX_TRANSCRIPT_ENTRY_CHARS).trim();
	if (!text) return undefined;
	return {
		timestamp: typeof item.timestamp === "number" ? item.timestamp : Date.now(),
		role: item.role,
		text,
	};
}

export function messageUsage(message: unknown): Usage | undefined {
	if (!message || typeof message !== "object") return undefined;
	const usage = (message as Record<string, unknown>).usage;
	if (!usage || typeof usage !== "object") return undefined;
	return usage as Usage;
}

export function messageRole(message: unknown): string | undefined {
	return message && typeof message === "object" && typeof (message as Record<string, unknown>).role === "string"
		? ((message as Record<string, unknown>).role as string)
		: undefined;
}

export function messageStopReason(message: unknown): string | undefined {
	return message && typeof message === "object" && typeof (message as Record<string, unknown>).stopReason === "string"
		? ((message as Record<string, unknown>).stopReason as string)
		: undefined;
}

export function messageError(message: unknown): string | undefined {
	return message && typeof message === "object" && typeof (message as Record<string, unknown>).errorMessage === "string"
		? ((message as Record<string, unknown>).errorMessage as string)
		: undefined;
}

export function finalAssistantText(agent: ManagedSubagent): string {
	for (let index = agent.transcript.length - 1; index >= 0; index--) {
		const item = agent.transcript[index];
		if (item?.role === "assistant") return item.text;
	}
	return agent.streamingText.trim();
}

export function boundedWebTranscript(items: readonly TranscriptItem[]): TranscriptItem[] {
	const retained: TranscriptItem[] = [];
	let characters = 0;
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (!item) continue;
		const remaining = MAX_WEB_TRANSCRIPT_CHARS - characters;
		if (remaining <= 0 && retained.length > 0) break;
		const text = truncateChars(item.text, Math.max(1, remaining));
		retained.push({ ...item, text });
		characters += text.length;
	}
	return retained.reverse();
}

export function webTranscript(agent: ManagedSubagent): TranscriptItem[] {
	return boundedWebTranscript(agent.transcript);
}
