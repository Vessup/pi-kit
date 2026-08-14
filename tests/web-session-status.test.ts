import { expect, test } from "bun:test";
import { displaySessionStatus } from "../web/client/session-status.ts";

test("only dormant terminal sessions are labeled inactive", () => {
	expect(displaySessionStatus({ source: "web", status: "offline" })).toBe("idle");
	expect(displaySessionStatus({ source: "saved", status: "offline" })).toBe("inactive");
	expect(displaySessionStatus({ source: "tui", status: "offline" })).toBe("inactive");
	expect(displaySessionStatus({ source: "web", status: "working" })).toBe("working");
	const subagent = { id: "worker", model: "test/model", effort: "high", turns: 1, queued: 0, createdAt: 1, updatedAt: 2 };
	for (const status of ["creating", "working", "terminating"] as const) {
		expect(displaySessionStatus({ source: "web", status: "idle", subagents: [{ ...subagent, status }] })).toBe("working");
	}
	for (const status of ["completed", "failed", "terminated"] as const) {
		expect(displaySessionStatus({ source: "web", status: "idle", subagents: [{ ...subagent, status }] })).toBe("idle");
	}
});
