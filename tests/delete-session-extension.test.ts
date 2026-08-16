import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import deleteSessionExtension from "../extensions/delete-session.ts";
import { WORKTREE_SESSION_ENTRY } from "../web/server/worktrees.ts";

test("delete-session rechecks managed worktree ownership after confirmation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-kit-delete-session-"));
  try {
    const sessionDir = join(directory, "current");
    const sessionFile = join(sessionDir, "session.jsonl");
    const worktreePath = join(directory, "managed-worktree");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", cwd: worktreePath })}\n`,
    );

    let handler:
      | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
      | undefined;
    deleteSessionExtension({
      registerCommand: (
        _name: string,
        command: { handler: typeof handler },
      ) => {
        handler = command.handler;
      },
    } as unknown as ExtensionAPI);
    if (!handler) throw new Error("delete-session command was not registered");

    const notifications: string[] = [];
    let shutdown = false;
    await handler("", {
      hasUI: true,
      waitForIdle: async () => undefined,
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionDir: () => sessionDir,
        getEntries: () => [
          {
            type: "custom",
            customType: WORKTREE_SESSION_ENTRY,
            data: {
              path: worktreePath,
              repoRoot: directory,
              name: "managed-worktree",
              branch: "topic",
              branchCreated: true,
            },
          },
        ],
      },
      ui: {
        confirm: async (_title: string, message: string) => {
          expect(message).toContain("managed worktree");
          await writeFile(
            join(directory, "other.jsonl"),
            `${JSON.stringify({ type: "session", cwd: worktreePath })}\n`,
          );
          return true;
        },
        notify: (message: string) => {
          notifications.push(message);
        },
      },
      shutdown: () => {
        shutdown = true;
      },
    } as unknown as ExtensionCommandContext);

    expect(existsSync(sessionFile)).toBe(false);
    expect(shutdown).toBe(true);
    expect(
      notifications.some((message) =>
        message.includes("worktree cleanup failed"),
      ),
    ).toBe(false);
    expect(existsSync(worktreePath)).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
