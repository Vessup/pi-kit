import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedSessionStore } from "../web/server/managed-session-store.ts";
import { createSessionFileCatalog } from "../web/server/session-file-catalog.ts";
import { WORKTREE_SESSION_ENTRY } from "../web/server/worktrees.ts";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

test("deletion reads worktree ownership from a bounded session prefix", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-session-prefix-"));
  const sessionsDir = join(tempDir, "sessions");
  const file = join(sessionsDir, "large.jsonl");
  const worktree = {
    path: join(tempDir, "repo", ".pi", "worktrees", "topic"),
    repoRoot: join(tempDir, "repo"),
    name: "topic",
    branch: "topic",
    branchCreated: true,
  };
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(file, [
    JSON.stringify({ type: "session", id: "large", cwd: tempDir }),
    JSON.stringify({ type: "custom", customType: WORKTREE_SESSION_ENTRY, data: worktree }),
  ].join("\n") + "\n");
  await truncate(file, 64 * 1024 * 1024);

  const catalog = createSessionFileCatalog({
    sessionsDir,
    managedSessionStore: new ManagedSessionStore(join(tempDir, "managed.json")),
  });
  expect(catalog.readManagedWorktreePrefix(file)).toEqual(worktree);
});
