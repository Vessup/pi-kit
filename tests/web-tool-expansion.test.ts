import { expect, test } from "bun:test";
import { toolHasArgumentDetails } from "../web/client/tool-expansion.ts";

test("Write and Edit cards auto-expand from their rendered arguments without tool output", () => {
	expect(toolHasArgumentDetails("write", { path: "file.ts", content: "export const value = 1;" })).toBe(true);
	expect(toolHasArgumentDetails("edit", { path: "file.ts", edits: [{ oldText: "1", newText: "2" }] })).toBe(true);
	expect(toolHasArgumentDetails("read", { path: "file.ts" })).toBe(false);
});
