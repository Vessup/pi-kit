import { basename, dirname, normalize, resolve } from "node:path";

export type SessionProject = {
	id: string;
	name: string;
	root: string;
};

const projectCache = new Map<string, SessionProject>();

function fallbackProject(cwd: string): SessionProject {
	const path = normalize(resolve(cwd));
	return {
		id: `dir:${path}`,
		name: basename(path) || path,
		root: path,
	};
}

function projectNameFromCommonDir(commonDir: string): string {
	const base = basename(commonDir);
	if (base === ".git") return basename(dirname(commonDir));
	return base.endsWith(".git") ? base.slice(0, -4) : base;
}

function projectRoot(path: string, commonDir: string): string {
	const result = Bun.spawnSync({
		cmd: ["git", "-C", path, "rev-parse", "--path-format=absolute", "--show-toplevel"],
		stdout: "pipe",
		stderr: "ignore",
	});
	if (result.exitCode !== 0) return commonDir; // A bare repository has no working-tree root.
	const output = result.stdout.toString().trim();
	if (!output) return commonDir;
	const checkoutRoot = normalize(resolve(output));
	return basename(commonDir) === ".git" ? dirname(commonDir) : checkoutRoot;
}

/** Resolve linked Git worktrees to the same project via --git-common-dir. */
export function resolveSessionProject(cwd: string): SessionProject {
	const path = normalize(resolve(cwd));
	const cached = projectCache.get(path);
	if (cached) return cached;

	let project = fallbackProject(path);
	try {
		const result = Bun.spawnSync({
			cmd: ["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"],
			stdout: "pipe",
			stderr: "ignore",
		});
		if (result.exitCode === 0) {
			const commonDir = normalize(resolve(result.stdout.toString().trim()));
			if (commonDir) {
				project = {
					id: `git:${commonDir}`,
					name: projectNameFromCommonDir(commonDir) || basename(path) || path,
					root: projectRoot(path, commonDir),
				};
			}
		}
	} catch {
		// A missing Git binary or deleted cwd simply falls back to the directory.
	}
	projectCache.set(path, project);
	return project;
}

export function clearSessionProjectCache(): void {
	projectCache.clear();
}
