import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { includeWebCompactCommand, parseWebCompactCommand } from "../web/compact-command.ts";
import { includeWebReloadCommand, isWebReloadCommand } from "../web/reload-command.ts";
import { expandSlashCommand, isSkillSlashCommand } from "../web/slash-commands.ts";

let tempDir: string | undefined;

afterEach(async () => {
	if (tempDir) await rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

test("native web prompts expand Pi prompt templates with quoted arguments and defaults", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pi-kit-web-prompt-test-"));
	const path = join(tempDir, "address-pr.md");
	await writeFile(path, [
		"---",
		"description: Address a pull request",
		"---",
		"Target: $1",
		"All: $@",
		"Second: ${2:-fallback}",
		"Tail: ${@:2}",
	].join("\n"));
	const commands = [{
		name: "address-pr",
		source: "prompt" as const,
		sourceInfo: { path },
	}];

	expect(await expandSlashCommand(commands, "/address-pr \"owner/repo#42\""))
		.toBe("Target: owner/repo#42\nAll: owner/repo#42\nSecond: fallback\nTail: ");
});

test("prompt arguments preserve empty and escaped quoted values", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pi-kit-web-prompt-args-test-"));
	const path = join(tempDir, "args.md");
	await writeFile(path, "First: [$1]\nSecond: [$2]\nThird: [$3]\nAll: [$@]");
	const commands = [{ name: "args", source: "prompt" as const, sourceInfo: { path } }];

	expect(await expandSlashCommand(commands, '/args "" second "say \\"hi\\""'))
		.toBe('First: []\nSecond: [second]\nThird: [say "hi"]\nAll: [ second say "hi"]');
	expect(await expandSlashCommand(commands, `/args C:\\tmp\\file '\\d+' "say \\"hi\\""`))
		.toBe('First: [C:\\tmp\\file]\nSecond: [\\d+]\nThird: [say "hi"]\nAll: [C:\\tmp\\file \\d+ say "hi"]');
	await expect(expandSlashCommand(commands, '/args "unterminated'))
		.rejects.toThrow('Unterminated " quote');
});

test("web reload routing only accepts the exact built-in command", () => {
	expect(isWebReloadCommand("/reload")).toBe(true);
	expect(isWebReloadCommand("/reload   ")).toBe(true);
	expect(isWebReloadCommand("/reload now")).toBe(false);
	expect(isWebReloadCommand("please /reload")).toBe(false);
});

test("web compact routing accepts optional instructions without matching prose", () => {
	expect(parseWebCompactCommand("/compact")).toEqual({});
	expect(parseWebCompactCommand("/compact preserve file names ")).toEqual({ customInstructions: "preserve file names" });
	expect(parseWebCompactCommand("please /compact")).toBeUndefined();
	expect(parseWebCompactCommand("/compacted")).toBeUndefined();
});

test("the web slash menu exposes control commands across stale native metadata", () => {
	const commands = includeWebCompactCommand(includeWebReloadCommand([
		{ name: "web-reload", description: "internal", source: "extension", location: "temporary" },
		{ name: "address-pr", description: "Address a PR", source: "prompt", location: "user" },
	]));
	expect(commands.map((command) => command.name)).toEqual(["compact", "reload", "address-pr"]);
	expect(includeWebReloadCommand(commands).filter((command) => command.name === "reload")).toHaveLength(1);
	expect(includeWebCompactCommand(commands).filter((command) => command.name === "compact")).toHaveLength(1);
});

test("web skill commands stay intact with their arguments", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pi-kit-web-skill-test-"));
	const path = join(tempDir, "SKILL.md");
	await writeFile(path, [
		"---",
		"name: staff-loop",
		"description: Review repeatedly",
		"---",
		"These instructions must be loaded with read.",
	].join("\n"));
	const commands = [{
		name: "skill:staff-loop",
		source: "skill" as const,
		sourceInfo: { path, baseDir: tempDir },
	}];
	const invocation = "/skill:staff-loop owner/repo#42 4";

	expect(isSkillSlashCommand(commands, invocation)).toBe(true);
	expect(await expandSlashCommand(commands, invocation)).toBe(invocation);
});
