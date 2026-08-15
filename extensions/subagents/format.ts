import { MAX_TOOL_OUTPUT_BYTES, type SubagentStatus } from "./types.js";

export function formatTokens(count: number): string {
	if (count < 1_000) return `${count}`;
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatClock(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function sanitizeName(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
}

export function stringifyCompact(value: unknown, max = 200): string {
	let text: string;
	try {
		text = JSON.stringify(value);
	} catch {
		text = String(value);
	}
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function truncateChars(text: string, maximum: number): string {
	return text.length <= maximum ? text : `${text.slice(0, maximum)}\n[… ${text.length - maximum} characters omitted]`;
}

export function statusIcon(status: SubagentStatus): string {
	switch (status) {
		case "creating":
		case "working":
		case "terminating":
			return "◐";
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "terminated":
			return "■";
	}
}

export function statusColor(status: SubagentStatus): "warning" | "success" | "error" | "muted" {
	switch (status) {
		case "creating":
		case "working":
		case "terminating":
			return "warning";
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "terminated":
			return "muted";
	}
}

export function truncateToolOutput(text: string): string {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= MAX_TOOL_OUTPUT_BYTES) return text;
	let output = text.slice(0, MAX_TOOL_OUTPUT_BYTES);
	while (Buffer.byteLength(output, "utf8") > MAX_TOOL_OUTPUT_BYTES) output = output.slice(0, -1);
	return `${output}\n\n[Output truncated: ${bytes - Buffer.byteLength(output, "utf8")} bytes omitted. Re-read a specific subagent or use the transcript modal for details.]`;
}

export function modelName(model: { provider: string; id: string } | undefined): string {
	return model ? `${model.provider}/${model.id}` : "no-model";
}
