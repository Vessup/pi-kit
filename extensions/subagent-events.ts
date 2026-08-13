import type { FooterUsage } from "./footer-events.js";

export const SUBAGENT_STATUS_EVENT = "vessup:subagents:status";

export type SubagentWebStatus = "creating" | "working" | "completed" | "failed" | "terminating" | "terminated";

export type SubagentWebSnapshot = {
	id: string;
	status: SubagentWebStatus;
	model: string;
	effort: string;
	turns: number;
	currentTool?: string;
	queued: number;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
	error?: string;
	usage: FooterUsage;
	transcript: Array<{ timestamp: number; role: string; text: string }>;
	streamingText?: string;
};

export type SubagentWebUpdate = Omit<SubagentWebSnapshot, "currentTool" | "completedAt" | "error" | "transcript" | "streamingText"> & {
	currentTool: string | null;
	completedAt: number | null;
	error: string | null;
	transcriptDelta?: SubagentWebSnapshot["transcript"];
	transcriptReset?: boolean;
	streamingTextDelta?: string;
	streamingTextReset?: boolean;
};

export type SubagentStatusEvent = {
	sessionId: string;
	agents: SubagentWebUpdate[];
	usage: FooterUsage;
	remove?: boolean;
};
