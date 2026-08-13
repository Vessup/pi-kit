import { basename, dirname, normalize, resolve } from "node:path";

export type SessionProject = {
	id: string;
	name: string;
};

const projectCache = new Map<string, SessionProject>();

function fallbackProject(cwd: string): SessionProject {
	const path = normalize(resolve(cwd));
	return {
		id: `dir:${path}`,
		name: basename(path) || path,
	};
}

function projectNameFromCommonDir(commonDir: string): string {
	const base = basename(commonDir);
	if (base === ".git") return basename(dirname(commonDir));
	return base.endsWith(".git") ? base.slice(0, -4) : base;
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
