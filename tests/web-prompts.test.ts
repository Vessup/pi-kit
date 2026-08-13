import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
