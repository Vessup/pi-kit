import { expect, test } from "bun:test";
import { shouldContinueManagedShutdownWait, shouldWaitForManagedShutdown } from "../web/server/shutdown-policy.ts";

const base = { managed: {}, active: true, status: "idle" as const };

test("graceful shutdown waits without a deadline until managed work settles", () => {
	expect(shouldContinueManagedShutdownWait(1)).toBe(true);
	expect(shouldContinueManagedShutdownWait(0)).toBe(false);
});

test("graceful daemon shutdown waits for managed main-agent work", () => {
	expect(shouldWaitForManagedShutdown({ ...base, status: "working", agentRunning: true })).toBe(true);
	expect(shouldWaitForManagedShutdown({ ...base, status: "idle", agentRunning: true })).toBe(true);
	expect(shouldWaitForManagedShutdown({ ...base, status: "idle", compaction: {} })).toBe(true);
});

test("graceful daemon shutdown waits for active managed subagents", () => {
	expect(shouldWaitForManagedShutdown({
		...base,
		subagents: [{ id: "worker", status: "working", model: "test/model", effort: "high", turns: 1, queued: 0, createdAt: 1, updatedAt: 2 }],
	})).toBe(true);
	expect(shouldWaitForManagedShutdown({
		...base,
		subagents: [{ id: "worker", status: "completed", model: "test/model", effort: "high", turns: 1, queued: 0, createdAt: 1, updatedAt: 2 }],
	})).toBe(false);
});

test("idle, stopped, and external sessions do not delay daemon shutdown", () => {
	expect(shouldWaitForManagedShutdown(base)).toBe(false);
	expect(shouldWaitForManagedShutdown({ ...base, active: false, status: "working", agentRunning: true })).toBe(false);
	expect(shouldWaitForManagedShutdown({ ...base, managed: undefined, status: "working", agentRunning: true })).toBe(false);
});
