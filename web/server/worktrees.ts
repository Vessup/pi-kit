import { accessSync, closeSync, constants, mkdirSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";

export const WORKTREE_SESSION_ENTRY = "vessup-managed-worktree";

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
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	if (result.status !== 0) {
		const error = result.stderr?.trim() || result.error?.message || `git ${args.join(" ")} failed`;
		throw new Error(error);
	}
	return result.stdout?.trim() ?? "";
}

/** Require the Git features used for absolute paths and NUL-delimited worktree records. */
export function validateGitVersion(versionOutput: string): void {
	const match = versionOutput.trim().match(/^git version (\d+)\.(\d+)\.(\d+)(?:\D|$)/);
	if (!match) throw new Error(`Could not determine Git version from: ${versionOutput.trim() || "empty output"}`);
	const version = match.slice(1, 4).map(Number);
	if (version[0]! < 2 || (version[0] === 2 && version[1]! < 36)) {
		throw new Error(`Git 2.36.0 or newer is required (found ${version.slice(0, 3).join(".")})`);
	}
}

function ensureSupportedGit(): void {
	const result = spawnSync("git", ["--version"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr?.trim() || result.error?.message || "Could not run git --version");
	validateGitVersion(result.stdout ?? "");
}

export type WorktreeRef = { kind: "branch" | "detached"; value: string };
export type ExistingWebWorktree = { path: string; repoRoot: string; ref: WorktreeRef };
export type CreatedWebWorktree = { path: string; repoRoot: string; branch: string; setupRan: boolean };
export type ManagedWorktree = Pick<CreatedWebWorktree, "path" | "repoRoot" | "branch">;

export const WORKTREE_SETUP_TIMEOUT_MS = 5 * 60_000;

export function runWorktreeSetup(command: string, args: string[], cwd: string, timeoutMs = WORKTREE_SETUP_TIMEOUT_MS): Promise<void> {
	return new Promise((resolveSetup, rejectSetup) => {
		const detached = process.platform !== "win32";
		const child = spawn(command, args, { cwd, stdio: "inherit", detached });
		let timedOut = false;
		let forceTimer: ReturnType<typeof setTimeout> | undefined;
		const kill = (signal: NodeJS.Signals) => {
			try {
				if (detached && child.pid) process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch {
				// The process may have exited between the timeout and termination.
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill("SIGTERM");
			forceTimer = setTimeout(() => kill("SIGKILL"), 1_000);
		}, timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timer);
			if (forceTimer) clearTimeout(forceTimer);
			rejectSetup(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			if (forceTimer) clearTimeout(forceTimer);
			if (timedOut) rejectSetup(new Error(`setup.sh timed out after ${timeoutMs}ms`));
			else if (code === 0) resolveSetup();
			else rejectSetup(new Error(`setup.sh exited with code ${code ?? `signal ${signal ?? "unknown"}`}`));
		});
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Read the newest ownership marker inherited by the selected session branch. */
export function managedWorktreeFromEntries(entries: readonly unknown[]): ManagedWorktree | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== WORKTREE_SESSION_ENTRY || !isRecord(entry.data)) continue;
		if (entry.data.managed === false) return undefined;
		const { path, repoRoot, branch } = entry.data;
		if (typeof path === "string" && typeof repoRoot === "string" && typeof branch === "string") {
			return { path, repoRoot, branch };
		}
	}
	return undefined;
}

function samePath(left: string, right: string): boolean {
	try {
		return realpathSync(left) === realpathSync(right);
	} catch {
		return resolve(left) === resolve(right);
	}
}

function primaryRepositoryGitDir(cwd: string): string {
	return realpathSync(resolve(cwd, gitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])));
}

function parseRegisteredWorktrees(cwd: string): Array<{ path: string; head?: string; branch?: string; detached: boolean }> {
	ensureSupportedGit();
	const records: Array<{ path: string; head?: string; branch?: string; detached: boolean }> = [];
	let current: { path: string; head?: string; branch?: string; detached: boolean } | undefined;
	const result = spawnSync("git", ["-C", cwd, "worktree", "list", "--porcelain", "-z"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr?.trim() || result.error?.message || "git worktree list failed");
	for (const field of (result.stdout ?? "").split("\0")) {
		if (!field) {
			if (current) records.push(current);
			current = undefined;
			continue;
		}
		const separator = field.indexOf(" ");
		const key = separator < 0 ? field : field.slice(0, separator);
		const value = separator < 0 ? "" : field.slice(separator + 1);
		if (key === "worktree") {
			if (current) records.push(current);
			current = { path: value, detached: false };
		} else if (current && key === "HEAD") current.head = value;
		else if (current && key === "branch") current.branch = value;
		else if (current && key === "detached") current.detached = true;
	}
	if (current) records.push(current);
	return records;
}

/** Resolve and validate an existing worktree without changing its checkout or branch. */
export function inspectExistingWorktree(currentCwd: string, requestedPath: string): ExistingWebWorktree {
	ensureSupportedGit();
	let path: string;
	try {
		path = realpathSync(requestedPath);
	} catch (error) {
		throw new Error(`Existing worktree path does not exist: ${requestedPath} (${error instanceof Error ? error.message : String(error)})`);
	}
	if (!statSync(path).isDirectory()) throw new Error(`Existing worktree path is not a directory: ${path}`);

	let currentGitDir: string;
	let targetGitDir: string;
	try {
		currentGitDir = primaryRepositoryGitDir(currentCwd);
	} catch (error) {
		throw new Error(`Current CWD is not in a Git repository: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		targetGitDir = primaryRepositoryGitDir(path);
	} catch (error) {
		throw new Error(`Target is not a Git worktree: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (currentGitDir !== targetGitDir) throw new Error("Target worktree belongs to a different primary repository");

	const registered = parseRegisteredWorktrees(currentCwd).find((entry) => {
		try {
			return realpathSync(entry.path) === path;
		} catch {
			return false;
		}
	});
	if (!registered) throw new Error(`Target is not a registered Git worktree: ${path}`);
	let ref: WorktreeRef;
	if (registered.branch?.startsWith("refs/heads/")) {
		ref = { kind: "branch", value: registered.branch.slice("refs/heads/".length) };
	} else if (registered.detached && registered.head && /^[0-9a-fA-F]{40,64}$/.test(registered.head)) {
		ref = { kind: "detached", value: registered.head.toLowerCase() };
	} else {
		throw new Error(`Target worktree has no valid checked-out branch or detached HEAD: ${path}`);
	}
	const repoRoot = dirname(currentGitDir);
	return { path, repoRoot, ref };
}

/** Read the checked-out branch or detached commit without modifying the worktree. */
export function currentWorktreeRef(cwd: string): WorktreeRef {
	const symbolic = spawnSync("git", ["-C", cwd, "symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" });
	if (symbolic.status === 0 && symbolic.stdout.trim()) return { kind: "branch", value: symbolic.stdout.trim() };
	const head = gitOutput(cwd, ["rev-parse", "--verify", "HEAD"]);
	if (!/^[0-9a-fA-F]{40,64}$/.test(head)) throw new Error(`Invalid detached HEAD: ${head}`);
	return { kind: "detached", value: head.toLowerCase() };
}

const MAX_SESSION_HEADER_BYTES = 64 * 1024;

function readSessionHeader(file: string): unknown {
	const descriptor = openSync(file, "r");
	try {
		// Read one extra byte so an unterminated oversized header is rejected without
		// loading the transcript that follows it.
		const buffer = Buffer.allocUnsafe(MAX_SESSION_HEADER_BYTES + 1);
		const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
		const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
		if (newline < 0 && bytesRead > MAX_SESSION_HEADER_BYTES) return undefined;
		const end = newline >= 0 && newline < bytesRead ? newline : bytesRead;
		if (end === 0) return undefined;
		const line = buffer.subarray(0, end).toString("utf8").replace(/\r$/, "");
		return JSON.parse(line) as unknown;
	} finally {
		closeSync(descriptor);
	}
}

/**
 * Conservatively detect another persisted conversation rooted in this worktree.
 * A worktree is removed only when its final saved session is deleted.
 */
export function hasOtherSessionInWorktree(sessionsRoot: string, currentSessionFile: string, worktreePath: string): boolean {
	const stack = [sessionsRoot];
	while (stack.length > 0) {
		const directory = stack.pop();
		if (!directory) continue;
		let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
		try {
			entries = readdirSync(directory, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
		} catch {
			continue;
		}
		for (const entry of entries) {
			const file = join(directory, entry.name);
			if (entry.isDirectory()) {
				stack.push(file);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".jsonl") || samePath(file, currentSessionFile)) continue;
			try {
				const header = readSessionHeader(file);
				if (isRecord(header) && typeof header.cwd === "string" && samePath(header.cwd, worktreePath)) return true;
			} catch {
				// An unreadable or malformed unrelated session is not evidence that it
				// owns this worktree. Normal session deletion handles that file itself.
			}
		}
	}
	return false;
}

function verifiedManagedWorktree(worktree: ManagedWorktree): ManagedWorktree {
	ensureSupportedGit();
	const name = validateWorktreeName(worktree.branch);
	if (basename(worktree.path) !== name) throw new Error("Refusing to remove a worktree whose path and branch marker disagree");
	const repoRoot = realpathSync(worktree.repoRoot);
	let managedRoot = join(repoRoot, ".pi", "worktrees");
	try {
		managedRoot = realpathSync(managedRoot);
	} catch {
		managedRoot = resolve(managedRoot);
	}
	const path = realpathSync(worktree.path);
	if (dirname(path) !== managedRoot) throw new Error(`Refusing to remove worktree outside ${managedRoot}`);
	const commonDir = resolve(gitOutput(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
	const primaryGitDir = resolve(gitOutput(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
	if (!samePath(commonDir, primaryGitDir)) throw new Error("Refusing to remove a worktree owned by another repository");
	const topLevel = gitOutput(path, ["rev-parse", "--show-toplevel"]);
	if (!samePath(topLevel, path)) throw new Error("Refusing to remove a worktree whose Git root differs from its ownership marker");
	return { path, repoRoot, branch: name };
}

/** Remove a verified Pi-managed checkout. A branch warning does not leave a worktree behind. */
export function removeManagedWorktree(worktree: ManagedWorktree): { branchWarning?: string } {
	const verified = verifiedManagedWorktree(worktree);
	gitOutput(verified.repoRoot, ["worktree", "remove", "--force", verified.path]);
	try {
		gitOutput(verified.repoRoot, ["branch", "-D", verified.branch]);
		return {};
	} catch (error) {
		return { branchWarning: error instanceof Error ? error.message : String(error) };
	}
}

/** Explicitly remove a created worktree and branch; startup failures retain them for inspection. */
export function rollbackWebWorktree(worktree: CreatedWebWorktree): void {
	gitOutput(worktree.repoRoot, ["worktree", "remove", "--force", worktree.path]);
	gitOutput(worktree.repoRoot, ["branch", "-D", worktree.branch]);
}

/** Create a new branch/worktree under the primary repository's .pi directory. */
export async function createWebWorktree(cwd: string, requestedName: string): Promise<CreatedWebWorktree> {
	ensureSupportedGit();
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
			let executable = false;
			try {
				accessSync(setup, constants.X_OK);
				executable = true;
			} catch {
				// A mode bit alone is insufficient when this process lacks that group.
			}
			const [command, ...args] = executable ? [setup] : ["sh", setup];
			await runWorktreeSetup(command!, args, path);
			worktree.setupRan = true;
		} catch (error) {
			throw new Error(`${error instanceof Error ? error.message : String(error)}; worktree retained at ${path} for inspection`);
		}
	}
	return worktree;
}
