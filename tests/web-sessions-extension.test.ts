import { expect, test } from "bun:test";
import { abortSessionAndSubagents, applyTailscaleSettingTransaction, isScopedModelAllowed } from "../extensions/web-sessions.ts";

test("web Stop aborts the main session and waits for subagent propagation", async () => {
	let releaseSubagents!: () => void;
	const subagents = new Promise<void>((resolve) => { releaseSubagents = resolve; });
	let mainAborted = false;
	let settled = false;
	const operation = abortSessionAndSubagents({
		sessionId: "session-1",
		abortMain: () => { mainAborted = true; },
		emit: (request) => request.waitUntil(subagents),
	}).then(() => { settled = true; });
	expect(mainAborted).toBe(true);
	expect(settled).toBe(false);
	releaseSubagents();
	await operation;
	expect(settled).toBe(true);
});

test("web Stop still aborts when an optional subagent listener fails", async () => {
	let mainAborted = false;
	await abortSessionAndSubagents({
		sessionId: "session-1",
		abortMain: () => { mainAborted = true; },
		emit: () => { throw new Error("listener failed"); },
	});
	expect(mainAborted).toBe(true);
});

test("web model selection honors the session model scope", () => {
	const scoped = [
		{ model: { provider: "anthropic", id: "allowed" } },
		{ model: { provider: "openai", id: "also-allowed" } },
	];
	expect(isScopedModelAllowed(scoped, "anthropic", "allowed")).toBe(true);
	expect(isScopedModelAllowed(scoped, "anthropic", "excluded")).toBe(false);
	expect(isScopedModelAllowed(scoped, "openai", "allowed")).toBe(false);
	expect(isScopedModelAllowed([], "any", "model")).toBe(true);
});

test("Tailscale setting persistence failure rolls the live route back", async () => {
	const current = { enabled: false, httpsPort: 8443 };
	const next = { enabled: true, httpsPort: 443 };
	const applied: typeof current[] = [];
	await expect(applyTailscaleSettingTransaction({
		current,
		next,
		apply: async (setting) => {
			applied.push(setting);
			return { published: setting.enabled };
		},
		persist: async () => { throw new Error("settings rename failed"); },
	})).rejects.toThrow("settings rename failed");
	expect(applied).toEqual([next, current]);
});

test("Tailscale setting transaction reports a failed route rollback", async () => {
	let applications = 0;
	await expect(applyTailscaleSettingTransaction({
		current: "old",
		next: "new",
		apply: async () => {
			applications += 1;
			if (applications === 2) throw new Error("rollback failed");
			return "published";
		},
		persist: async () => { throw new Error("disk failed"); },
	})).rejects.toThrow("route rollback failed: rollback failed");
});
