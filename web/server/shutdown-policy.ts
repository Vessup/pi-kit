import { hasActiveWebSubagents, type WebSession } from "../protocol.js";

export type ManagedShutdownState = Pick<WebSession, "status" | "subagents"> & {
	managed?: unknown;
	active: boolean;
	agentRunning?: boolean;
	compaction?: unknown;
};

export function shouldContinueManagedShutdownWait(busyCount: number): boolean {
	return busyCount > 0;
}

/** A graceful daemon restart must not abort work owned by a managed RPC child. */
export function shouldWaitForManagedShutdown(record: ManagedShutdownState): boolean {
	return Boolean(record.managed && record.active && (
		record.agentRunning === true ||
		record.status === "working" ||
		record.compaction ||
		hasActiveWebSubagents(record.subagents)
	));
}
