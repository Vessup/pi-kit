import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorConfirmsMissingPath, isConfirmedMissingPath } from "../web/server/file-presence.ts";

test("missing-path reconciliation requires an explicit ENOENT", () => {
	expect(errorConfirmsMissingPath(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe(true);
	expect(errorConfirmsMissingPath(Object.assign(new Error("forbidden"), { code: "EACCES" }))).toBe(false);
	expect(errorConfirmsMissingPath(Object.assign(new Error("not a directory"), { code: "ENOTDIR" }))).toBe(false);
	expect(errorConfirmsMissingPath(Object.assign(new Error("I/O failure"), { code: "EIO" }))).toBe(false);
	expect(errorConfirmsMissingPath(new Error("unknown filesystem failure"))).toBe(false);
});

test("path probing distinguishes present and absent files", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-kit-path-presence-"));
	const path = join(directory, "session.jsonl");
	try {
		expect(isConfirmedMissingPath(path)).toBe(true);
		await writeFile(path, "session\n");
		expect(isConfirmedMissingPath(path)).toBe(false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
