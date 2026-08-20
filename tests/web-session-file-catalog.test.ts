import { afterEach, expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
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

test("metadata cache results have fresh arrays and current ownership", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-session-metadata-cache-"));
  const sessionsDir = join(tempDir, "sessions");
  const file = join(sessionsDir, "saved.jsonl");
  const store = new ManagedSessionStore(join(tempDir, "managed.json"));
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({ type: "session", id: "saved", cwd: tempDir })}\n`,
  );
  const catalog = createSessionFileCatalog({
    sessionsDir,
    managedSessionStore: store,
  });

  const first = catalog.parseSessionMetadataFile(file);
  if (!first) throw new Error("parseSessionMetadataFile returned undefined");
  first.history.push("pollution");
  first.entries.push("pollution");
  store.add(file);
  const second = catalog.parseSessionMetadataFile(file);
  if (!second) throw new Error("parseSessionMetadataFile returned undefined");
  expect(second.history).toEqual([]);
  expect(second.entries).toEqual([]);
  expect(second.session.source).toBe("web");
});

test("metadata scans retain bounded incremental Auto routing state", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-session-auto-metadata-"));
  const sessionsDir = join(tempDir, "sessions");
  const file = join(sessionsDir, "auto.jsonl");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({ type: "session", id: "auto", cwd: tempDir })}\n${JSON.stringify({
      type: "custom",
      customType: "vessup:auto-router:active",
      data: { enabled: true, pinnedTier: "high" },
    })}\n`,
  );
  const catalog = createSessionFileCatalog({
    sessionsDir,
    managedSessionStore: new ManagedSessionStore(join(tempDir, "managed.json")),
  });

  expect(catalog.parseSessionMetadataFile(file)?.session).toMatchObject({
    selectedModel: "auto/auto-high",
    lastModel: undefined,
  });
  await appendFile(
    file,
    `${JSON.stringify({ type: "model_change", provider: "provider", modelId: "a" })}\n`,
  );
  expect(catalog.parseSessionMetadataFile(file)?.session.lastModel).toBe(
    "provider/a",
  );
  await appendFile(
    file,
    `${JSON.stringify({ type: "model_change", provider: "auto", modelId: "auto-high" })}\n`,
  );
  expect(catalog.parseSessionMetadataFile(file)?.session.lastModel).toBe(
    "provider/a",
  );
  await appendFile(
    file,
    `${JSON.stringify({ type: "model_change", provider: "provider", modelId: "b" })}\n`,
  );
  expect(catalog.parseSessionMetadataFile(file)?.session.lastModel).toBe(
    "provider/b",
  );
  await appendFile(
    file,
    `${JSON.stringify({ type: "model_change", provider: "auto", modelId: "auto-high" })}\n${JSON.stringify({
      type: "custom",
      customType: "vessup:auto-router:active",
      data: { enabled: false },
    })}\n`,
  );
  expect(catalog.parseSessionMetadataFile(file)?.session).toMatchObject({
    selectedModel: undefined,
    lastModel: undefined,
  });
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
  await writeFile(
    file,
    `${[
      JSON.stringify({ type: "session", id: "large", cwd: tempDir }),
      JSON.stringify({
        type: "custom",
        customType: WORKTREE_SESSION_ENTRY,
        data: worktree,
      }),
    ].join("\n")}\n`,
  );
  await truncate(file, 64 * 1024 * 1024);

  const catalog = createSessionFileCatalog({
    sessionsDir,
    managedSessionStore: new ManagedSessionStore(join(tempDir, "managed.json")),
  });
  expect(catalog.readManagedWorktreePrefix(file)).toEqual(worktree);
});
