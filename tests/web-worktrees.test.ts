import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createWebWorktree,
	currentWorktreeRef,
	gitCommandTimeoutMs,
	hasOtherSessionInWorktree,
	inspectExistingWorktree,
	managedWorktreeFromEntries,
	removeManagedWorktree,
	rollbackWebWorktree,
	runWorktreeSetup,
	validateGitVersion,
	validateLocalBranchName,
	validateWorktreeName,
	WORKTREE_SESSION_ENTRY,
} from "../web/server/worktrees.ts";

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

test("checkout-producing Git commands use the long-running operation bound", () => {
	expect(gitCommandTimeoutMs(["-C", "/repo", "worktree", "add", "/checkout", "branch"])).toBe(10 * 60_000);
	expect(gitCommandTimeoutMs(["-C", "/repo", "worktree", "remove", "/checkout"])).toBe(10 * 60_000);
	expect(gitCommandTimeoutMs(["-C", "/repo", "worktree", "list", "--porcelain"])).toBe(30_000);
	expect(gitCommandTimeoutMs(["check-ref-format", "--branch", "topic"])).toBe(30_000);
});

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
	await expect(createWebWorktree(repository, "feature-one")).rejects.toThrow(`Worktree path already exists: ${result.path}`);
	expect(result).toMatchObject({ name: "feature-one", branch: "feature-one", branchCreated: true });
	expect((await Bun.$`git -C ${result.path} branch --show-current`.text()).trim()).toBe("feature-one");

	await writeFile(join(repository, "README.md"), "second\n");
	await Bun.$`git -C ${repository} commit -am second -q`;
	const linked = join(directory, "existing-worktree");
	await Bun.$`git -C ${repository} worktree add -q -b existing-branch ${linked} HEAD~1`;
	const linkedHead = (await Bun.$`git -C ${linked} rev-parse HEAD`.text()).trim();
	const fromLinked = await createWebWorktree(linked, "from-linked");
	expect((await Bun.$`git -C ${fromLinked.path} rev-parse HEAD`.text()).trim()).toBe(linkedHead);
});

test("managed directory, local branch, remote start point, and upstream are independent", async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-kit-web-worktree-remote-"));
	const repository = join(directory, "repo");
	const remote = join(directory, "origin.git");
	await Bun.$`git init -q --bare ${remote}`;
	await Bun.$`git init -q ${repository}`;
	await Bun.$`git -C ${repository} config user.name test`;
	await Bun.$`git -C ${repository} config user.email test@example.com`;
	await writeFile(join(repository, "README.md"), "main\n");
	await Bun.$`git -C ${repository} add README.md`;
	await Bun.$`git -C ${repository} commit -qm initial`;
	await Bun.$`git -C ${repository} branch -M main`;
	await Bun.$`git -C ${repository} remote add origin ${remote}`;
	await Bun.$`git -C ${repository} push -q -u origin main`;
	await Bun.$`git -C ${repository} switch -q -c tembo/cancel-builds`;
	await writeFile(join(repository, "PR.md"), "pull request head\n");
	await Bun.$`git -C ${repository} add PR.md`;
	await Bun.$`git -C ${repository} commit -qm pr-head`;
	await Bun.$`git -C ${repository} push -q -u origin tembo/cancel-builds`;
	const remoteHead = (await Bun.$`git -C ${repository} rev-parse origin/tembo/cancel-builds`.text()).trim();
	await Bun.$`git -C ${repository} switch -q main`;
	await Bun.$`git -C ${repository} branch -D tembo/cancel-builds`;
	await writeFile(join(repository, "README.md"), "source checkout moved\n");
	await Bun.$`git -C ${repository} commit -am source-moved -q`;
	const sourceHead = (await Bun.$`git -C ${repository} rev-parse HEAD`.text()).trim();
	expect(sourceHead).not.toBe(remoteHead);

	const result = await createWebWorktree(repository, "pr-30", {
		branch: "tembo/cancel-builds",
		startPoint: "origin/tembo/cancel-builds",
	});
	expect(result).toMatchObject({
		path: await realpath(join(repository, ".pi", "worktrees", "pr-30")),
		name: "pr-30",
		branch: "tembo/cancel-builds",
		branchCreated: true,
		startPoint: "origin/tembo/cancel-builds",
		upstream: "origin/tembo/cancel-builds",
	});
	expect((await Bun.$`git -C ${result.path} rev-parse HEAD`.text()).trim()).toBe(remoteHead);
	expect((await Bun.$`git -C ${result.path} rev-parse --abbrev-ref --symbolic-full-name '@{upstream}'`.text()).trim()).toBe("origin/tembo/cancel-builds");
	expect((await Bun.$`git -C ${repository} branch --list pr-30`.text()).trim()).toBe("");

	removeManagedWorktree(result);
	await expect(stat(result.path)).rejects.toThrow();
	expect((await Bun.$`git -C ${repository} branch --list tembo/cancel-builds`.text()).trim()).toBe("");
});

test("an unused existing local branch is reused and preserved by rollback", async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-kit-web-worktree-reuse-"));
	const repository = join(directory, "repo");
	await Bun.$`git init -q ${repository}`;
	await Bun.$`git -C ${repository} config user.name test`;
	await Bun.$`git -C ${repository} config user.email test@example.com`;
	await writeFile(join(repository, "README.md"), "initial\n");
	await Bun.$`git -C ${repository} add README.md`;
	await Bun.$`git -C ${repository} commit -qm initial`;
	await Bun.$`git -C ${repository} branch reusable/topic`;
	const branchHead = (await Bun.$`git -C ${repository} rev-parse reusable/topic`.text()).trim();
	await writeFile(join(repository, "README.md"), "main moved\n");
	await Bun.$`git -C ${repository} commit -am main-moved -q`;

	const result = await createWebWorktree(repository, "local-copy", { branch: "reusable/topic" });
	expect(result).toMatchObject({ name: "local-copy", branch: "reusable/topic", branchCreated: false });
	expect((await Bun.$`git -C ${result.path} rev-parse HEAD`.text()).trim()).toBe(branchHead);
	rollbackWebWorktree(result);
	await expect(stat(result.path)).rejects.toThrow();
	expect((await Bun.$`git -C ${repository} rev-parse reusable/topic`.text()).trim()).toBe(branchHead);
	await expect(createWebWorktree(repository, "conflicting-start", {
		branch: "reusable/topic",
		startPoint: "HEAD",
	})).rejects.toThrow("omit --start-point");
});

test("managed creation rejects branches checked out in another worktree", async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-kit-web-worktree-checked-out-"));
	const repository = join(directory, "repo");
	const linked = join(directory, "linked");
	await Bun.$`git init -q ${repository}`;
	await Bun.$`git -C ${repository} config user.name test`;
	await Bun.$`git -C ${repository} config user.email test@example.com`;
	await writeFile(join(repository, "README.md"), "initial\n");
	await Bun.$`git -C ${repository} add README.md`;
	await Bun.$`git -C ${repository} commit -qm initial`;
	await Bun.$`git -C ${repository} worktree add -q -b occupied/topic ${linked}`;

	try {
		await createWebWorktree(repository, "duplicate", { branch: "occupied/topic" });
		throw new Error("expected occupied branch rejection");
	} catch (error) {
		expect(error instanceof Error ? error.message : String(error)).toContain(`already checked out at ${await realpath(linked)}`);
	}
	const sourceBranch = (await Bun.$`git -C ${repository} branch --show-current`.text()).trim();
	try {
		await createWebWorktree(repository, "duplicate-source", { branch: sourceBranch });
		throw new Error("expected source branch rejection");
	} catch (error) {
		expect(error instanceof Error ? error.message : String(error)).toContain("already checked out");
	}
});

test("invalid branches and missing start points fail before creating resources", async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-kit-web-worktree-invalid-ref-"));
	const repository = join(directory, "repo");
	await Bun.$`git init -q ${repository}`;
	await Bun.$`git -C ${repository} config user.name test`;
	await Bun.$`git -C ${repository} config user.email test@example.com`;
	await writeFile(join(repository, "README.md"), "initial\n");
	await Bun.$`git -C ${repository} add README.md`;
	await Bun.$`git -C ${repository} commit -qm initial`;

	await expect(createWebWorktree(repository, "missing", { branch: "owner/missing", startPoint: "origin/does-not-exist" })).rejects.toThrow("does not resolve to a commit");
	await expect(createWebWorktree(repository, "invalid", { branch: "bad..branch" })).rejects.toThrow("Invalid local branch name");
	await expect(createWebWorktree(repository, "option", { branch: "owner/option", startPoint: "--all" })).rejects.toThrow("Invalid worktree start point");
	for (const name of ["missing", "invalid", "option"]) {
		await expect(stat(join(repository, ".pi", "worktrees", name))).rejects.toThrow();
	}
	expect((await Bun.$`git -C ${repository} branch --list owner/missing`.text()).trim()).toBe("");
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

test("worktree setup force-kills descendants after a timed-out leader exits", async () => {
	if (process.platform === "win32") return;
	directory = await mkdtemp(join(tmpdir(), "pi-kit-web-worktree-timeout-group-"));
	const script = join(directory, "hang-with-child.sh");
	const childPidFile = join(directory, "child.pid");
	await writeFile(script, "#!/bin/sh\nsh -c 'trap \"\" TERM; while :; do sleep 1; done' &\necho $! > \"$1\"\ntrap 'exit 0' TERM\nwait\n");
	await chmod(script, 0o755);
	await expect(runWorktreeSetup(script, [childPidFile], directory, 2_000)).rejects.toThrow("timed out after 2000ms");
	expect(await Bun.file(childPidFile).exists()).toBe(true);
	const childPid = Number((await readFile(childPidFile, "utf8")).trim());
	let alive = true;
	for (let attempt = 0; attempt < 30 && alive; attempt += 1) {
		await Bun.sleep(100);
		try { process.kill(childPid, 0); } catch { alive = false; }
	}
	if (alive) process.kill(childPid, "SIGKILL");
	expect(alive).toBe(false);
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
	expect(marker).toEqual({ path: created.path, repoRoot: created.repoRoot, name: created.name, branch: created.branch, branchCreated: true });
	expect(managedWorktreeFromEntries([{
		type: "custom",
		customType: WORKTREE_SESSION_ENTRY,
		data: { path: created.path, repoRoot: created.repoRoot, branch: created.branch },
	}])).toEqual({ path: created.path, repoRoot: created.repoRoot, name: "cleanup-me", branch: "cleanup-me", branchCreated: true });
	expect(managedWorktreeFromEntries([
		{ type: "custom", customType: WORKTREE_SESSION_ENTRY, data: created },
		{ type: "custom", customType: WORKTREE_SESSION_ENTRY, data: { managed: false } },
	])).toBeUndefined();
	removeManagedWorktree(marker!);
	await expect(stat(created.path)).rejects.toThrow();
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
	await writeFile(other, `${JSON.stringify({ type: "session", cwd: join(worktree, "packages", "app") })}\n${"large transcript line\n".repeat(250_000)}`);
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
	await expect(stat(result.path)).rejects.toThrow();
	expect((await Bun.$`git -C ${repository} branch --list rollback-me`.text()).trim()).toBe("");
});

test("rollback removes operation-owned resources after the checkout branch changes", async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-kit-web-worktree-rollback-ref-"));
	const repository = join(directory, "repo");
	await Bun.$`git init -q ${repository}`;
	await Bun.$`git -C ${repository} config user.name test`;
	await Bun.$`git -C ${repository} config user.email test@example.com`;
	await writeFile(join(repository, "README.md"), "test\n");
	await Bun.$`git -C ${repository} add README.md`;
	await Bun.$`git -C ${repository} commit -qm initial`;

	const result = await createWebWorktree(repository, "rollback-original");
	await Bun.$`git -C ${result.path} switch -q -c user-created`;
	rollbackWebWorktree(result);
	await expect(stat(result.path)).rejects.toThrow();
	expect((await Bun.$`git -C ${repository} branch --list rollback-original`.text()).trim()).toBe("");
	expect((await Bun.$`git -C ${repository} branch --list user-created`.text()).trim()).toBe("user-created");
});

test("rollback preserves commits made after a managed branch was created", async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-kit-web-worktree-rollback-advanced-"));
	const repository = join(directory, "repo");
	await Bun.$`git init -q ${repository}`;
	await Bun.$`git -C ${repository} config user.name test`;
	await Bun.$`git -C ${repository} config user.email test@example.com`;
	await writeFile(join(repository, "README.md"), "test\n");
	await Bun.$`git -C ${repository} add README.md`;
	await Bun.$`git -C ${repository} commit -qm initial`;

	const result = await createWebWorktree(repository, "rollback-advanced");
	await writeFile(join(result.path, "committed.txt"), "preserve me\n");
	await Bun.$`git -C ${result.path} add committed.txt`;
	await Bun.$`git -C ${result.path} commit -qm advanced`;
	const advancedHead = (await Bun.$`git -C ${result.path} rev-parse HEAD`.text()).trim();
	rollbackWebWorktree(result);
	await expect(stat(result.path)).rejects.toThrow();
	expect((await Bun.$`git -C ${repository} rev-parse rollback-advanced`.text()).trim()).toBe(advancedHead);
});

test("rollback preserves a changed checkout with uncommitted files", async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-kit-web-worktree-rollback-dirty-"));
	const repository = join(directory, "repo");
	await Bun.$`git init -q ${repository}`;
	await Bun.$`git -C ${repository} config user.name test`;
	await Bun.$`git -C ${repository} config user.email test@example.com`;
	await writeFile(join(repository, "README.md"), "test\n");
	await Bun.$`git -C ${repository} add README.md`;
	await Bun.$`git -C ${repository} commit -qm initial`;

	const result = await createWebWorktree(repository, "rollback-dirty");
	await Bun.$`git -C ${result.path} switch -q -c user-dirty`;
	await writeFile(join(result.path, "uncommitted.txt"), "preserve me\n");
	expect(() => rollbackWebWorktree(result)).toThrow("uncommitted or untracked changes");
	expect(await readFile(join(result.path, "uncommitted.txt"), "utf8")).toBe("preserve me\n");
	expect((await Bun.$`git -C ${repository} branch --list rollback-dirty`.text()).trim()).toBe("rollback-dirty");
});

test("worktree handling requires Git 2.36 or newer", () => {
	expect(() => validateGitVersion("git version 2.35.9")).toThrow("Git 2.36.0 or newer is required");
	expect(() => validateGitVersion("git version unknown")).toThrow("Could not determine Git version");
	expect(() => validateGitVersion("git version 2.36.0")).not.toThrow();
	expect(() => validateGitVersion("git version 3.0.0")).not.toThrow();
	expect(() => validateGitVersion("git version 2.39.5 (Apple Git-154)")).not.toThrow();
	expect(() => validateGitVersion("git version 2.43.0.windows.1")).not.toThrow();
});

test("web worktree names reject traversal and nested paths", () => {
	for (const value of ["../escape", "nested/name", "nested\\name", "bad name", ".."] ) {
		expect(() => validateWorktreeName(value)).toThrow();
	}
	expect(validateWorktreeName("fix-123_example.test")).toBe("fix-123_example.test");
	expect(validateLocalBranchName("tembo/cancel-builds")).toBe("tembo/cancel-builds");
	for (const value of ["bad..branch", "refs/heads/topic", "-option", "bad branch"]) {
		expect(() => validateLocalBranchName(value)).toThrow();
	}
	expect(() => validateLocalBranchName("topic\0injected")).toThrow("NUL byte");
});
