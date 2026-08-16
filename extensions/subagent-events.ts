import type { FooterUsage } from "./footer-events.js";

export const SUBAGENT_STATUS_EVENT = "vessup:subagents:status";
export const SUBAGENT_ABORT_EVENT = "vessup:subagents:abort";

/** Synchronous event-bus request used to join subagent aborts to a main-session Stop. */
export type SubagentAbortRequest = {
  sessionId: string;
  waitUntil(operation: Promise<unknown>): void;
};

export function parseSubagentAbortRequest(
  value: unknown,
): SubagentAbortRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const request = value as Partial<SubagentAbortRequest>;
  return typeof request.sessionId === "string" &&
    typeof request.waitUntil === "function"
    ? (request as SubagentAbortRequest)
    : undefined;
}

export type SubagentWebStatus =
  | "creating"
  | "working"
  | "completed"
  | "failed"
  | "terminating"
  | "terminated";

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

export type SubagentWebUpdate = Omit<
  SubagentWebSnapshot,
  "currentTool" | "completedAt" | "error" | "transcript" | "streamingText"
> & {
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
