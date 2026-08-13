import { mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function validateWorktreeName(input: string): string {
	const name = input.trim();
	if (!name) throw new Error("Missing worktree name");
	if (name === "." || name === ".." || name.includes("..") || name.includes("/") || name.includes("\\")) {
		throw new Error("Worktree name must be one safe path segment without '..', '/' or '\\'");
	}
	if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Worktree name may contain only letters, numbers, '.', '_' and '-'");
	return name;
}

function gitOutput(cwd: string, args: string[]): string {
	const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args], stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		const error = result.stderr.toString().trim() || `git ${args.join(" ")} failed`;
		throw new Error(error);
	}
	return result.stdout.toString().trim();
}

export type CreatedWebWorktree = { path: string; repoRoot: string; branch: string; setupRan: boolean };

/** Explicitly remove a created worktree and branch; startup failures retain them for inspection. */
export function rollbackWebWorktree(worktree: CreatedWebWorktree): void {
	gitOutput(worktree.repoRoot, ["worktree", "remove", "--force", worktree.path]);
	gitOutput(worktree.repoRoot, ["branch", "-D", worktree.branch]);
}

/** Create a new branch/worktree under the primary repository's .pi directory. */
export function createWebWorktree(cwd: string, requestedName: string): CreatedWebWorktree {
	const name = validateWorktreeName(requestedName);
	const commonDir = resolve(gitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
	const startPoint = gitOutput(cwd, ["rev-parse", "HEAD"]);
	const repoRoot = dirname(commonDir);
	const path = join(repoRoot, ".pi", "worktrees", name);
	try {
		statSync(path);
		throw new Error(`Worktree path already exists: ${path}`);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Worktree path already exists:")) throw error;
	}
	mkdirSync(dirname(path), { recursive: true });
	gitOutput(repoRoot, ["worktree", "add", "-b", name, path, startPoint]);
	const worktree = { path, repoRoot, branch: name, setupRan: false };
	const setup = join(repoRoot, ".pi", "worktrees", "setup.sh");
	let setupInfo: ReturnType<typeof statSync> | undefined;
	try {
		setupInfo = statSync(setup);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(`${error instanceof Error ? error.message : String(error)}; worktree retained at ${path} for inspection`);
		}
	}
	if (setupInfo?.isFile()) {
		try {
			const command = (Number(setupInfo.mode) & 0o111) !== 0 ? [setup] : ["sh", setup];
			const result = Bun.spawnSync({ cmd: command, cwd: path, stdout: "inherit", stderr: "inherit" });
			if (result.exitCode !== 0) throw new Error(`setup.sh exited with code ${result.exitCode}`);
			worktree.setupRan = true;
		} catch (error) {
			throw new Error(`${error instanceof Error ? error.message : String(error)}; worktree retained at ${path} for inspection`);
		}
	}
	return worktree;
}
