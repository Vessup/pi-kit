import { expect, test } from "bun:test";
import { sessionCommandTimeout } from "../web/client/api.ts";

test("clone and fork outlive the server's 30-second operation bound", () => {
	expect(sessionCommandTimeout({ type: "clone" })).toBeGreaterThan(30_000);
	expect(sessionCommandTimeout({ type: "fork", entryId: "entry-1" })).toBeGreaterThan(30_000);
	expect(sessionCommandTimeout({ type: "abort" })).toBe(15_000);
});
