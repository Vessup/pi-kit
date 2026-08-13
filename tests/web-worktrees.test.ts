import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebWorktree, rollbackWebWorktree, validateWorktreeName } from "../web/server/worktrees.ts";

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

	const result = createWebWorktree(repository, "feature-one");
	expect(await realpath(result.path)).toBe(await realpath(join(repository, ".pi", "worktrees", "feature-one")));
	expect(result.branch).toBe("feature-one");
	expect((await Bun.$`git -C ${result.path} branch --show-current`.text()).trim()).toBe("feature-one");

	await writeFile(join(repository, "README.md"), "second\n");
	await Bun.$`git -C ${repository} commit -am second -q`;
	const linked = join(directory, "existing-worktree");
	await Bun.$`git -C ${repository} worktree add -q -b existing-branch ${linked} HEAD~1`;
	const linkedHead = (await Bun.$`git -C ${linked} rev-parse HEAD`.text()).trim();
	const fromLinked = createWebWorktree(linked, "from-linked");
	expect((await Bun.$`git -C ${fromLinked.path} rev-parse HEAD`.text()).trim()).toBe(linkedHead);
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

	const result = createWebWorktree(repository, "with-setup");
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

	expect(() => createWebWorktree(repository, "setup-fails")).toThrow("worktree retained");
	expect((await stat(join(repository, ".pi", "worktrees", "setup-fails"))).isDirectory()).toBe(true);
	expect((await Bun.$`git -C ${repository} branch --list --format=%\(refname:short\) setup-fails`.text()).trim()).toBe("setup-fails");
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

	const result = createWebWorktree(repository, "rollback-me");
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
