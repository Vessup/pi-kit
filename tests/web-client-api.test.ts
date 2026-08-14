import { expect, test } from "bun:test";
import { commandHelloType, healthSupportsWorktreeRefs, sessionCommandTimeout } from "../web/client/api.ts";

test("one-shot commands fall back across an older daemon protocol", () => {
	expect(commandHelloType({ ok: true })).toBe("client.hello");
	expect(commandHelloType({ capabilities: { commandHello: false } })).toBe("client.hello");
	expect(commandHelloType({ capabilities: { commandHello: true } })).toBe("client.command_hello");
	expect(healthSupportsWorktreeRefs({ capabilities: { worktreeRefs: true } })).toBe(true);
	expect(healthSupportsWorktreeRefs({ capabilities: { commandHello: true } })).toBe(false);
});

test("clone and fork outlive the server's 30-second operation bound", () => {
	expect(sessionCommandTimeout({ type: "clone" })).toBeGreaterThan(30_000);
	expect(sessionCommandTimeout({ type: "fork", entryId: "entry-1" })).toBeGreaterThan(30_000);
	expect(sessionCommandTimeout({ type: "create_worktree", repository: "/repo", name: "feature" })).toBeGreaterThanOrEqual(10 * 60_000);
	expect(sessionCommandTimeout({ type: "create_worktree", existing: "/repo/worktree" })).toBeGreaterThanOrEqual(10 * 60_000);
	expect(sessionCommandTimeout({ type: "create_worktree_v2", repository: "/repo", name: "pr-30", branch: "owner/topic", startPoint: "origin/owner/topic" })).toBeGreaterThanOrEqual(10 * 60_000);
	expect(sessionCommandTimeout({ type: "reload" })).toBeGreaterThanOrEqual(10 * 60_000);
	expect(sessionCommandTimeout({ type: "abort" })).toBe(15_000);
});
