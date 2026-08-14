import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createWebWorktree,
	currentWorktreeRef,
	hasOtherSessionInWorktree,
	inspectExistingWorktree,
	managedWorktreeFromEntries,
	removeManagedWorktree,
	rollbackWebWorktree,
	runWorktreeSetup,
	validateWorktreeName,
	WORKTREE_SESSION_ENTRY,
} from "../web/server/worktrees.ts";

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

test("web worktrees are created under the primary repository .pi directory", async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-kit-web-worktree-"));
	const repository = join(directory, "repo");
	await Bun.$`git init -q ${repository}`;
	await Bun.$`git -C ${repository} config user.name test`;
	await Bun.$`git -C ${repository} config user.email test@example.com`;
	await writeFile(join(repository, "README.md"), "test\n");
	await Bun.$`git -C ${repository} add README.md`;
	await Bun.$`git -C ${repository} commit -qm initial`;

	const result = await createWebWorktree(repository, "feature-one");
	expect(await realpath(result.path)).toBe(await realpath(join(repository, ".pi", "worktrees", "feature-one")));
	expect(result.branch).toBe("feature-one");
	expect((await Bun.$`git -C ${result.path} branch --show-current`.text()).trim()).toBe("feature-one");

	await writeFile(join(repository, "README.md"), "second\n");
	await Bun.$`git -C ${repository} commit -am second -q`;
	const linked = join(directory, "existing-worktree");
	await Bun.$`git -C ${repository} worktree add -q -b existing-branch ${linked} HEAD~1`;
	const linkedHead = (await Bun.$`git -C ${linked} rev-parse HEAD`.text()).trim();
	const fromLinked = await createWebWorktree(linked, "from-linked");
	expect((await Bun.$`git -C ${fromLinked.path} rev-parse HEAD`.text()).trim()).toBe(linkedHead);
});

test("existing registered worktrees are resolved without modifying their branch", async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-kit-existing-worktree-"));
	const repository = join(directory, "repo");
	const worktree = join(directory, "linked checkout");
	await Bun.$`git init -q ${repository}`;
	await Bun.$`git -C ${repository} config user.name test`;
	await Bun.$`git -C ${repository} config user.email test@example.com`;
	await writeFile(join(repository, "README.md"), "test\n");
	await Bun.$`git -C ${repository} add README.md`;
	await Bun.$`git -C ${repository} commit -qm initial`;
	await Bun.$`git -C ${repository} worktree add -q -b existing-branch ${worktree}`;

	const beforeHead = (await Bun.$`git -C ${worktree} rev-parse HEAD`.text()).trim();
	const result = inspectExistingWorktree(repository, worktree);
	expect(result).toEqual({
		path: await realpath(worktree),
		repoRoot: await realpath(repository),
		ref: { kind: "branch", value: "existing-branch" },
	});
	expect(currentWorktreeRef(worktree)).toEqual({ kind: "branch", value: "existing-branch" });
	expect((await Bun.$`git -C ${worktree} rev-parse HEAD`.text()).trim()).toBe(beforeHead);
});

test("existing detached worktrees retain their exact HEAD", async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-kit-existing-detached-"));
	const repository = join(directory, "repo");
	const worktree = join(directory, "detached");
	await Bun.$`git init -q ${repository}`;
	await Bun.$`git -C ${repository} config user.name test`;
	await Bun.$`git -C ${repository} config user.email test@example.com`;
	await writeFile(join(repository, "README.md"), "test\n");
	await Bun.$`git -C ${repository} add README.md`;
	await Bun.$`git -C ${repository} commit -qm initial`;
	await Bun.$`git -C ${repository} worktree add -q --detach ${worktree} HEAD`;
	const head = (await Bun.$`git -C ${worktree} rev-parse HEAD`.text()).trim();
	expect(inspectExistingWorktree(repository, worktree).ref).toEqual({ kind: "detached", value: head });
	expect(currentWorktreeRef(worktree)).toEqual({ kind: "detached", value: head });
});

test("existing targets reject missing paths, unregistered checkouts, and other repositories", async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-kit-existing-invalid-"));
	const repository = join(directory, "repo");
	const other = join(directory, "other");
	await Bun.$`git init -q ${repository}`;
	await Bun.$`git -C ${repository} config user.name test`;
	await Bun.$`git -C ${repository} config user.email test@example.com`;
	await writeFile(join(repository, "README.md"), "test\n");
	await Bun.$`git -C ${repository} add README.md`;
	await Bun.$`git -C ${repository} commit -qm initial`;
	await Bun.$`git clone -q ${repository} ${other}`;

	expect(() => inspectExistingWorktree(repository, join(directory, "missing"))).toThrow("does not exist");
	const nested = join(repository, "nested");
	await mkdir(nested);
	expect(() => inspectExistingWorktree(repository, nested)).toThrow("not a registered Git worktree");
	expect(() => inspectExistingWorktree(repository, other)).toThrow("different primary repository");
});

test("executable worktree setup scripts run through their shebang", async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-kit-web-worktree-setup-"));
	const repository = join(directory, "repo");
	await Bun.$`git init -q ${repository}`;
	await Bun.$`git -C ${repository} config user.name test`;
	await Bun.$`git -C ${repository} config user.email test@example.com`;
	await writeFile(join(repository, "README.md"), "test\n");
	await Bun.$`git -C ${repository} add README.md`;
	await Bun.$`git -C ${repository} commit -qm initial`;
	const setup = join(repository, ".pi", "worktrees", "setup.sh");
	await mkdir(join(repository, ".pi", "worktrees"), { recursive: true });
	await Bun.write(setup, "#!/usr/bin/env bash\nvalues=(bash-shebang)\nprintf '%s' \"${values[0]}\" > setup-runtime.txt\n");
	await chmod(setup, 0o755);

	const result = await createWebWorktree(repository, "with-setup");
	expect(result.setupRan).toBe(true);
	expect(await readFile(join(result.path, "setup-runtime.txt"), "utf8")).toBe("bash-shebang");
});

test("failed setup retains the new checkout and branch for inspection", async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-kit-web-worktree-setup-failure-"));
	const repository = join(directory, "repo");
	await Bun.$`git init -q ${repository}`;
	await Bun.$`git -C ${repository} config user.name test`;
	await Bun.$`git -C ${repository} config user.email test@example.com`;
	await writeFile(join(repository, "README.md"), "test\n");
	await Bun.$`git -C ${repository} add README.md`;
	await Bun.$`git -C ${repository} commit -qm initial`;
	const setup = join(repository, ".pi", "worktrees", "setup.sh");
	await mkdir(join(repository, ".pi", "worktrees"), { recursive: true });
	await writeFile(setup, "#!/bin/sh\nexit 23\n");
	await chmod(setup, 0o755);

	await expect(createWebWorktree(repository, "setup-fails")).rejects.toThrow("worktree retained");
	expect((await stat(join(repository, ".pi", "worktrees", "setup-fails"))).isDirectory()).toBe(true);
	expect((await Bun.$`git -C ${repository} branch --list --format=%\(refname:short\) setup-fails`.text()).trim()).toBe("setup-fails");
});

test("worktree setup is terminated after its bounded timeout", async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-kit-web-worktree-timeout-"));
	const script = join(directory, "hang.sh");
	await writeFile(script, "#!/bin/sh\nwhile :; do sleep 1; done\n");
	await chmod(script, 0o755);
	const startedAt = Date.now();
	await expect(runWorktreeSetup(script, [], directory, 50)).rejects.toThrow("timed out after 50ms");
	expect(Date.now() - startedAt).toBeLessThan(2_000);
});

test("managed worktree metadata is parsed and cleanup removes its checkout and branch", async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-kit-web-worktree-cleanup-"));
	const repository = join(directory, "repo");
	await Bun.$`git init -q ${repository}`;
	await Bun.$`git -C ${repository} config user.name test`;
	await Bun.$`git -C ${repository} config user.email test@example.com`;
	await writeFile(join(repository, "README.md"), "test\n");
	await Bun.$`git -C ${repository} add README.md`;
	await Bun.$`git -C ${repository} commit -qm initial`;

	const created = await createWebWorktree(repository, "cleanup-me");
	const marker = managedWorktreeFromEntries([{
		type: "custom",
		customType: WORKTREE_SESSION_ENTRY,
		data: created,
	}]);
	expect(marker).toEqual({ path: created.path, repoRoot: created.repoRoot, branch: created.branch });
	expect(managedWorktreeFromEntries([
		{ type: "custom", customType: WORKTREE_SESSION_ENTRY, data: created },
		{ type: "custom", customType: WORKTREE_SESSION_ENTRY, data: { managed: false } },
	])).toBeUndefined();
	removeManagedWorktree(marker!);
	expect(stat(created.path)).rejects.toThrow();
	expect((await Bun.$`git -C ${repository} branch --list cleanup-me`.text()).trim()).toBe("");
});

test("worktree cleanup waits until the final saved session is deleted", async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-kit-web-worktree-session-ref-"));
	const sessions = join(directory, "sessions");
	const worktree = join(directory, "repo", ".pi", "worktrees", "shared");
	const current = join(sessions, "current.jsonl");
	const other = join(sessions, "nested", "other.jsonl");
	await mkdir(join(sessions, "nested"), { recursive: true });
	await writeFile(current, `${JSON.stringify({ type: "session", cwd: worktree })}\n`);
	await writeFile(other, `${JSON.stringify({ type: "session", cwd: worktree })}\n${"large transcript line\n".repeat(250_000)}`);
	expect(hasOtherSessionInWorktree(sessions, current, worktree)).toBe(true);
	await rm(other);
	expect(hasOtherSessionInWorktree(sessions, current, worktree)).toBe(false);
});

test("worktree rollback removes the checkout and its branch", async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-kit-web-worktree-rollback-"));
	const repository = join(directory, "repo");
	await Bun.$`git init -q ${repository}`;
	await Bun.$`git -C ${repository} config user.name test`;
	await Bun.$`git -C ${repository} config user.email test@example.com`;
	await writeFile(join(repository, "README.md"), "test\n");
	await Bun.$`git -C ${repository} add README.md`;
	await Bun.$`git -C ${repository} commit -qm initial`;

	const result = await createWebWorktree(repository, "rollback-me");
	rollbackWebWorktree(result);
	expect(stat(result.path)).rejects.toThrow();
	expect((await Bun.$`git -C ${repository} branch --list rollback-me`.text()).trim()).toBe("");
});

test("web worktree names reject traversal and nested paths", () => {
	for (const value of ["../escape", "nested/name", "nested\\name", "bad name", ".."] ) {
		expect(() => validateWorktreeName(value)).toThrow();
	}
	expect(validateWorktreeName("fix-123_example.test")).toBe("fix-123_example.test");
});
