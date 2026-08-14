import { expect, test } from "bun:test";
import { recentRepositories } from "../web/client/recent-repositories.ts";
import type { WebSession } from "../web/protocol.ts";

function session(overrides: Partial<WebSession> & Pick<WebSession, "id" | "cwd">): WebSession {
	return {
		status: "offline",
		source: "saved",
		createdAt: 1,
		updatedAt: 1,
		messageCount: 0,
		...overrides,
	};
}

test("recent repositories deduplicate worktrees and use the primary checkout path", () => {
	const result = recentRepositories([
		session({ id: "old", cwd: "/repo", projectId: "git:/repo/.git", projectName: "repo", repositoryRoot: "/repo", updatedAt: 10 }),
		session({ id: "worktree", cwd: "/repo/.pi/worktrees/feature", projectId: "git:/repo/.git", projectName: "repo", repositoryRoot: "/repo", updatedAt: 20 }),
		session({ id: "dir", cwd: "/tmp/plain", updatedAt: 15 }),
	]);

	expect(result.map(({ id, path }) => ({ id, path }))).toEqual([
		{ id: "git:/repo/.git", path: "/repo" },
		{ id: "dir:/tmp/plain", path: "/tmp/plain" },
	]);
});
