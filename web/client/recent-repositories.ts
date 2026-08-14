import type { WebSession } from "../protocol";

export type RecentRepository = {
	id: string;
	name: string;
	path: string;
	lastUsedAt: number;
};

/** Deduplicate session history into repositories ordered by latest activity. */
export function recentRepositories(sessions: readonly WebSession[]): RecentRepository[] {
	const recent = new Map<string, RecentRepository>();
	for (const session of sessions) {
		const path = session.repositoryRoot ?? session.cwd;
		const id = session.projectId ?? `dir:${path}`;
		const candidate: RecentRepository = {
			id,
			name: session.projectName ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path,
			path,
			lastUsedAt: session.updatedAt,
		};
		const previous = recent.get(id);
		if (!previous || candidate.lastUsedAt > previous.lastUsedAt) recent.set(id, candidate);
	}
	return [...recent.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.name.localeCompare(b.name));
}
