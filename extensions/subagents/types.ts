import type {
  AgentSession,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { FooterUsage } from "../footer-events.js";
import type { SubagentWebSnapshot } from "../subagent-events.js";

export const MAX_SUBAGENTS = 8;
export const MAX_ACTIVITY_ITEMS = 500;
export const MAX_TRANSCRIPT_ITEMS = 500;
export const MAX_TRANSCRIPT_ENTRY_CHARS = 100_000;
export const MAX_TRANSCRIPT_CHARS = 1_000_000;
export const MAX_WEB_TRANSCRIPT_CHARS = 100_000;
export const MAX_WEB_STREAMING_CHARS = 20_000;
export const WEB_STATUS_PUBLISH_INTERVAL_MS = 1_000;
export const MAX_TOOL_OUTPUT_BYTES = 50 * 1024;
export const DEFAULT_READ_WAIT_SECONDS = 15;
export const DETAIL_VIEW_LINES = 22;
export const USAGE_STATE_ENTRY = "vessup-subagent-usage";
export const SUBAGENT_SYSTEM_PROMPT = [
  "You are a subagent working for a main coding agent.",
  "Work independently on the delegated task in the current working directory.",
  "Use tools when useful, keep changes scoped to the task, and finish with a concise report of findings, changes, tests, and remaining risks.",
  "Messages received after the initial task are instructions from the main agent; urgent steering messages supersede your current approach.",
].join(" ");

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type SubagentEffort = (typeof THINKING_LEVELS)[number];
export type SubagentStatus =
  | "creating"
  | "working"
  | "completed"
  | "failed"
  | "terminating"
  | "terminated";
export type MessageUrgency = "normal" | "urgent";

export type ActivityItem = {
  timestamp: number;
  text: string;
};

export type TranscriptItem = {
  timestamp: number;
  role: string;
  text: string;
};

export type ManagedSubagent = {
  id: string;
  prompt: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  status: SubagentStatus;
  model: string;
  effort: SubagentEffort;
  currentTool?: string;
  error?: string;
  lastStopReason?: string;
  turns: number;
  queuedSteering: number;
  queuedFollowUp: number;
  activity: ActivityItem[];
  lastReadActivity: number;
  transcript: TranscriptItem[];
  streamingText: string;
  lastStreamActivityAt: number;
  usage: Usage;
  session?: AgentSession;
  unsubscribe?: () => void;
  runPromise?: Promise<void>;
  waiters: Set<() => void>;
};

export type AgentSnapshot = {
  id: string;
  status: SubagentStatus;
  model: string;
  effort: SubagentEffort;
  turns: number;
  currentTool?: string;
  queued: number;
};

export type ToolDetails = {
  agents: SubagentWebSnapshot[];
};

export type Usage = FooterUsage;
export type AgentModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
export type PersistedUsageState = { total: Usage; accounted: Usage };

export type ManagerDialogResult =
  | { action: "close" }
  | { action: "view"; id: string }
  | { action: "back" }
  | { action: "model"; id: string }
  | { action: "effort"; id: string }
  | { action: "urgent"; id: string }
  | { action: "queue"; id: string }
  | { action: "terminate"; id: string };
