import { expect, test } from "bun:test";
import { boundedWebHistory, messagesToWebHistory } from "../web/history.ts";

function message(id: string, text: string) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "assistant", content: text, timestamp: 1 },
	};
}

test("web history drops entries before the latest compaction boundary", () => {
	const history = boundedWebHistory([
		message("old", "old transcript"),
		{ type: "compaction", id: "compact", parentId: "old", timestamp: "2026-01-01T00:01:00.000Z", summary: "summary" },
		message("new", "new transcript"),
	]);
	expect(history).toHaveLength(2);
	expect(history[0]).toMatchObject({ id: "web-compaction-compact", message: { role: "assistant" } });
	expect(JSON.stringify(history)).toContain("summary");
	expect(JSON.stringify(history)).not.toContain("old transcript");
	expect(JSON.stringify(history)).toContain("new transcript");
});

test("web history reserves space for the compaction summary", () => {
	const history = boundedWebHistory([
		{ type: "compaction", id: "compact", timestamp: "2026-01-01T00:01:00.000Z", summary: "required summary" },
		message("one", "one"),
		message("two", "two"),
	], { maxEntries: 2 });
	expect(history.map((entry) => (entry as { id?: string }).id)).toEqual(["web-compaction-compact", "two"]);
});

test("web history remains byte bounded and truncates oversized content", () => {
	const history = boundedWebHistory([message("large", "x".repeat(400_000))], { maxBytes: 400_000 });
	expect(history).toHaveLength(1);
	const serialized = JSON.stringify(history);
	expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(400_000);
	expect(serialized).toContain("Pi Web truncated");
});

test("oversized history images become explicit omission markers", () => {
	const history = boundedWebHistory([{
		type: "message",
		id: "image",
		message: { role: "user", content: [{ type: "image", mimeType: "image/png", data: "x".repeat(4 * 1024 * 1024 + 1) }] },
	}]);
	expect(JSON.stringify(history)).toContain("omitted an oversized image/png attachment");
});

test("managed context messages become bounded semantic history", () => {
	const history = messagesToWebHistory([
		{ role: "compactionSummary", summary: "prior work", tokensBefore: 100, timestamp: 1 },
		{ role: "custom", customType: "hidden", display: false, content: "not visible", timestamp: 2 },
		{ role: "branchSummary", summary: "not previously rendered", timestamp: 3 },
		{ role: "user", content: "continue", timestamp: 4 },
	]);
	expect(history).toHaveLength(2);
	expect(history[0]).toMatchObject({ message: { role: "assistant" } });
	expect(history[1]).toMatchObject({ message: { role: "user", content: "continue" } });
});
