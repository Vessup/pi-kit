import { accessSync, closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

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

const GIT_COMMAND_TIMEOUT_MS = 30_000;
const GIT_WORKTREE_MUTATION_TIMEOUT_MS = 10 * 60_000;

export function gitCommandTimeoutMs(args: readonly string[]): number {
	const commandIndex = args[0] === "-C" ? 2 : 0;
	return args[commandIndex] === "worktree" && (args[commandIndex + 1] === "add" || args[commandIndex + 1] === "remove")
		? GIT_WORKTREE_MUTATION_TIMEOUT_MS
		: GIT_COMMAND_TIMEOUT_MS;
}

function spawnGit(args: string[]) {
	const timeout = gitCommandTimeoutMs(args);
	const result = spawnSync("git", args, {
		encoding: "utf8",
		timeout,
		killSignal: "SIGKILL",
	});
	if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || result.signal) {
		throw new Error(`git ${args.join(" ")} did not finish within ${timeout}ms`);
	}
	return result;
}

/** Validate a short local branch name while allowing namespaced branches such as owner/topic. */
export function validateLocalBranchName(input: string): string {
	const branch = input.trim();
	if (!branch) throw new Error("Missing local branch name");
	if (branch.includes("\0")) throw new Error("Local branch name contains a NUL byte");
	if (branch.startsWith("refs/")) throw new Error("Local branch must be a short branch name, not a refs/... path");
	const result = spawnGit(["check-ref-format", "--branch", branch]);
	if (result.status !== 0) {
		throw new Error(`Invalid local branch name ${JSON.stringify(branch)}: ${result.stderr?.trim() || result.error?.message || "git check-ref-format rejected it"}`);
	}
	return branch;
}

function gitOutput(cwd: string, args: string[]): string {
	const result = spawnGit(["-C", cwd, ...args]);
	if (result.status !== 0) {
		const error = result.stderr?.trim() || result.error?.message || `git ${args.join(" ")} failed`;
		throw new Error(error);
	}
	return result.stdout?.trim() ?? "";
}

function gitOutputAsync(cwd: string, args: string[]): Promise<string> {
	const fullArgs = ["-C", cwd, ...args];
	const timeout = gitCommandTimeoutMs(fullArgs);
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn("git", fullArgs, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeout);
		child.once("error", (error) => {
			clearTimeout(timer);
			rejectPromise(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			if (timedOut || signal) {
				rejectPromise(new Error(`git ${fullArgs.join(" ")} did not finish within ${timeout}ms`));
				return;
			}
			if (code !== 0) {
				rejectPromise(new Error(stderr.trim() || `git ${args.join(" ")} failed`));
				return;
			}
			resolvePromise(stdout.trim());
		});
	});
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
	const result = spawnGit(["--version"]);
	if (result.status !== 0) throw new Error(result.stderr?.trim() || result.error?.message || "Could not run git --version");
	validateGitVersion(result.stdout ?? "");
}

export type WorktreeRef = { kind: "branch" | "detached"; value: string };
export type ExistingWebWorktree = { path: string; repoRoot: string; ref: WorktreeRef };
export type CreateWebWorktreeOptions = { branch?: string; startPoint?: string };
export type CreatedWebWorktree = {
	path: string;
	repoRoot: string;
	/** Safe directory segment below .pi/worktrees. */
	name: string;
	/** Local branch checked out in the managed worktree. */
	branch: string;
	/** Whether this operation created the local branch and therefore owns its cleanup. */
	branchCreated: boolean;
	/** Commit/ref used to initialize a newly created branch. */
	startPoint: string;
	/** Initial branch OID, used to avoid deleting commits made before rollback. */
	initialCommit?: string;
	/** Remote-tracking branch configured as upstream when one was requested. */
	upstream?: string;
	setupRan: boolean;
};
export type ManagedWorktree = Pick<CreatedWebWorktree, "path" | "repoRoot" | "name" | "branch" | "branchCreated">;

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
		const forceKillTimedOutGroup = () => {
			if (!timedOut || !forceTimer) return;
			clearTimeout(forceTimer);
			forceTimer = undefined;
			kill("SIGKILL");
		};
		child.once("error", (error) => {
			clearTimeout(timer);
			forceKillTimedOutGroup();
			rejectSetup(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			forceKillTimedOutGroup();
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
			const name = typeof entry.data.name === "string" ? entry.data.name : basename(path);
			const branchCreated = typeof entry.data.branchCreated === "boolean" ? entry.data.branchCreated : name === branch;
			return { path, repoRoot, name, branch, branchCreated };
		}
	}
	return undefined;
}

function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function samePath(left: string, right: string): boolean {
	return canonicalPath(left) === canonicalPath(right);
}

function pathIsWithin(path: string, root: string): boolean {
	const relation = relative(canonicalPath(root), canonicalPath(path));
	return relation === "" || (relation !== ".." && !relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(relation));
}

function primaryRepositoryGitDir(cwd: string): string {
	return realpathSync(resolve(cwd, gitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])));
}

function parseRegisteredWorktrees(cwd: string): Array<{ path: string; head?: string; branch?: string; detached: boolean }> {
	ensureSupportedGit();
	const records: Array<{ path: string; head?: string; branch?: string; detached: boolean }> = [];
	let current: { path: string; head?: string; branch?: string; detached: boolean } | undefined;
	const result = spawnGit(["-C", cwd, "worktree", "list", "--porcelain", "-z"]);
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

function primaryRepositoryRoot(cwd: string): string {
	const primary = parseRegisteredWorktrees(cwd)[0];
	if (!primary) throw new Error("Git repository has no registered primary worktree");
	return realpathSync(primary.path);
}

type ResolvedStartPoint = { value: string; commit: string; upstream?: string };

function localBranchExists(cwd: string, branch: string): boolean {
	const result = spawnGit(["-C", cwd, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
	if (result.status === 0) return true;
	if (result.status === 1) return false;
	throw new Error(result.stderr?.trim() || result.error?.message || `Could not inspect local branch ${branch}`);
}

function resolveStartPoint(cwd: string, input: string): ResolvedStartPoint {
	const value = input.trim();
	if (!value) throw new Error("Missing worktree start point");
	if (value.includes("\0")) throw new Error("Worktree start point contains a NUL byte");
	if (value.startsWith("-")) throw new Error(`Invalid worktree start point: ${value}`);
	let commit: string;
	try {
		commit = gitOutput(cwd, ["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`]).toLowerCase();
	} catch (error) {
		throw new Error(`Worktree start point does not resolve to a commit: ${value} (${error instanceof Error ? error.message : String(error)})`);
	}
	if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`Worktree start point resolved to an invalid commit: ${value}`);

	const symbolic = spawnGit(["-C", cwd, "rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", value]);
	const fullRef = symbolic.status === 0 ? symbolic.stdout?.trim() ?? "" : "";
	const remoteMatch = fullRef.match(/^refs\/remotes\/([^/]+)\/(.+)$/);
	const upstream = remoteMatch && remoteMatch[2] !== "HEAD" ? `${remoteMatch[1]}/${remoteMatch[2]}` : undefined;
	return { value, commit, upstream };
}

function checkedOutBranchPath(cwd: string, branch: string): string | undefined {
	const fullRef = `refs/heads/${branch}`;
	return parseRegisteredWorktrees(cwd).find((entry) => entry.branch === fullRef)?.path;
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
	const repoRoot = primaryRepositoryRoot(currentCwd);
	return { path, repoRoot, ref };
}

/** Read the checked-out branch or detached commit without modifying the worktree. */
export function currentWorktreeRef(cwd: string): WorktreeRef {
	const symbolic = spawnGit(["-C", cwd, "symbolic-ref", "--quiet", "--short", "HEAD"]);
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
				if (isRecord(header) && typeof header.cwd === "string" && pathIsWithin(header.cwd, worktreePath)) return true;
			} catch {
				// An unreadable or malformed unrelated session is not evidence that it
				// owns this worktree. Normal session deletion handles that file itself.
			}
		}
	}
	return false;
}

function verifiedManagedWorktreeLocation(worktree: ManagedWorktree): ManagedWorktree {
	ensureSupportedGit();
	const name = validateWorktreeName(worktree.name);
	const branch = validateLocalBranchName(worktree.branch);
	if (basename(worktree.path) !== name) throw new Error("Refusing to remove a worktree whose path and directory-name marker disagree");
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
	return { path, repoRoot, name, branch, branchCreated: worktree.branchCreated === true };
}

function verifiedManagedWorktree(worktree: ManagedWorktree): ManagedWorktree {
	const verified = verifiedManagedWorktreeLocation(worktree);
	const actualRef = currentWorktreeRef(verified.path);
	if (actualRef.kind !== "branch" || actualRef.value !== verified.branch) {
		throw new Error(`Refusing to remove a worktree whose checked-out branch differs from its ownership marker (${verified.branch})`);
	}
	return verified;
}

/** Remove a verified Pi-managed checkout, deleting only a branch created by Pi. */
export function removeManagedWorktree(worktree: ManagedWorktree): { branchWarning?: string } {
	const verified = verifiedManagedWorktree(worktree);
	gitOutput(verified.repoRoot, ["worktree", "remove", "--force", verified.path]);
	if (!verified.branchCreated) return {};
	try {
		gitOutput(verified.repoRoot, ["branch", "-D", verified.branch]);
		return {};
	} catch (error) {
		return { branchWarning: error instanceof Error ? error.message : String(error) };
	}
}

/** Remove a managed checkout without blocking the web server event loop. */
export async function removeManagedWorktreeAsync(worktree: ManagedWorktree): Promise<{ branchWarning?: string }> {
	const verified = verifiedManagedWorktree(worktree);
	await gitOutputAsync(verified.repoRoot, ["worktree", "remove", "--force", verified.path]);
	if (!verified.branchCreated) return {};
	try {
		await gitOutputAsync(verified.repoRoot, ["branch", "-D", verified.branch]);
		return {};
	} catch (error) {
		return { branchWarning: error instanceof Error ? error.message : String(error) };
	}
}

/** Remove an operation-owned checkout and only the local branch created with it. */
export function rollbackWebWorktree(worktree: CreatedWebWorktree): void {
	const verified = verifiedManagedWorktreeLocation(worktree);
	const dirty = gitOutput(verified.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	if (dirty) throw new Error(`Refusing to roll back managed worktree with uncommitted or untracked changes: ${verified.path}`);
	const branchAdvanced = verified.branchCreated && worktree.initialCommit !== undefined
		&& gitOutput(verified.repoRoot, ["rev-parse", "--verify", `refs/heads/${verified.branch}^{commit}`]).toLowerCase() !== worktree.initialCommit;
	gitOutput(verified.repoRoot, ["worktree", "remove", verified.path]);
	if (verified.branchCreated && !branchAdvanced) {
		if (worktree.initialCommit) {
			// Delete only if the branch still points at the commit we created. update-ref's
			// expected-old check closes the race between verification and deletion.
			gitOutput(verified.repoRoot, ["update-ref", "-d", `refs/heads/${verified.branch}`, worktree.initialCommit]);
		} else {
			gitOutput(verified.repoRoot, ["branch", "-D", verified.branch]);
		}
	}
}

/** Create or reuse a local branch in a managed worktree directory. */
export async function createWebWorktree(
	cwd: string,
	requestedName: string,
	options: CreateWebWorktreeOptions = {},
): Promise<CreatedWebWorktree> {
	ensureSupportedGit();
	const name = validateWorktreeName(requestedName);
	const branch = validateLocalBranchName(options.branch?.trim() || name);
	gitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const repoRoot = primaryRepositoryRoot(cwd);
	const path = join(repoRoot, ".pi", "worktrees", name);
	let pathExists = false;
	try {
		lstatSync(path);
		pathExists = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(`Could not inspect worktree path ${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (pathExists) throw new Error(`Worktree path already exists: ${path}`);

	const explicitStart = options.startPoint === undefined ? undefined : resolveStartPoint(repoRoot, options.startPoint);
	const branchExists = localBranchExists(repoRoot, branch);
	if (branchExists) {
		if (explicitStart) throw new Error(`Local branch ${branch} already exists; omit --start-point to reuse it without moving it`);
		const checkedOutAt = checkedOutBranchPath(repoRoot, branch);
		if (checkedOutAt) throw new Error(`Local branch ${branch} is already checked out at ${checkedOutAt}`);
	}
	const branchStart = branchExists
		? gitOutput(repoRoot, ["rev-parse", "--verify", "--end-of-options", `refs/heads/${branch}^{commit}`]).toLowerCase()
		: explicitStart?.commit ?? gitOutput(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]).toLowerCase();
	const startPoint = branchExists ? `refs/heads/${branch}` : explicitStart?.value ?? branchStart;
	const worktree: CreatedWebWorktree = {
		path,
		repoRoot,
		name,
		branch,
		branchCreated: !branchExists,
		startPoint,
		initialCommit: branchStart,
		upstream: !branchExists ? explicitStart?.upstream : undefined,
		setupRan: false,
	};

	mkdirSync(dirname(path), { recursive: true });
	let branchProvisioned = false;
	try {
		if (!branchExists) {
			// Create from the already-resolved OID so a moving ref cannot change the
			// checked-out commit between validation and mutation.
			gitOutput(repoRoot, ["branch", branch, branchStart]);
			branchProvisioned = true;
			if (explicitStart?.upstream) {
				gitOutput(repoRoot, ["branch", `--set-upstream-to=${explicitStart.upstream}`, branch]);
			}
		}
		gitOutput(repoRoot, ["worktree", "add", path, branch]);
	} catch (error) {
		const cleanupErrors: string[] = [];
		let registered: boolean | undefined;
		try {
			registered = parseRegisteredWorktrees(repoRoot).some((entry) => samePath(entry.path, path));
		} catch (inspectionError) {
			cleanupErrors.push(`could not inspect partial worktree registration: ${inspectionError instanceof Error ? inspectionError.message : String(inspectionError)}`);
		}
		// A competing Pi process can register the same path after our preflight
		// checks. A registration observed after a failed add therefore has ambiguous
		// ownership and must be retained rather than removing another session's worktree.
		if (registered) cleanupErrors.push(`worktree registration retained because ownership is ambiguous: ${path}`);
		if (registered === false && branchProvisioned) {
			try {
				gitOutput(repoRoot, ["branch", "-D", branch]);
			} catch (cleanupError) {
				cleanupErrors.push(`could not remove created branch ${branch}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
			}
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(cleanupErrors.length > 0 ? `${message}; ${cleanupErrors.join("; ")}` : message);
	}
	try {
		const actualRef = currentWorktreeRef(path);
		if (actualRef.kind !== "branch" || actualRef.value !== branch) {
			throw new Error(`Created worktree checked out ${actualRef.kind} ${actualRef.value}, expected branch ${branch}`);
		}
		const actualHead = gitOutput(path, ["rev-parse", "--verify", "HEAD^{commit}"]).toLowerCase();
		if (actualHead !== branchStart) throw new Error(`Created worktree HEAD ${actualHead} does not match requested start ${branchStart}`);
		if (explicitStart?.upstream && !branchExists) {
			const upstreamResult = spawnGit(["-C", path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
			const actualUpstream = upstreamResult.status === 0 ? upstreamResult.stdout?.trim() ?? "" : "";
			if (actualUpstream !== explicitStart.upstream) {
				throw new Error(`Created branch upstream ${actualUpstream || "none"} does not match ${explicitStart.upstream}`);
			}
		}
	} catch (error) {
		try {
			rollbackWebWorktree(worktree);
		} catch (rollbackError) {
			throw new Error(`${error instanceof Error ? error.message : String(error)}; worktree rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
		}
		throw error;
	}

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
				if (process.platform !== "win32") accessSync(setup, constants.X_OK);
				executable = process.platform !== "win32";
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
