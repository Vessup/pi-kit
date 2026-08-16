import { beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import worktreeExtension, {
  clearWorktreeToolRequests,
  createReplacementSession,
  inheritedWorktreeOwnership,
  installWorktreeCommandDispatchCompatibility,
  queueWorktreeToolRequest,
  replacementFromEntries,
  runWorktreeCommand,
  takeWorktreeToolRequest,
  withWorktreeOperation,
  worktreeToolCommandArgs,
} from "../extensions/worktree.ts";
import { WORKTREE_SESSION_ENTRY } from "../web/server/worktrees.ts";
import {
  formatWorktreeCreateCommandArgs,
  parseWorktreeCommandArgs,
  parseWorktreeInvocation,
} from "../web/worktree-command.ts";

beforeEach(() => clearWorktreeToolRequests());

const lsofAvailable =
  (
    spawnSync("lsof", ["-v"], { stdio: "ignore" }).error as
      | NodeJS.ErrnoException
      | undefined
  )?.code !== "ENOENT";

function registeredWorktreeTool() {
  let tool:
    | {
        name: string;
        promptSnippet?: string;
        promptGuidelines?: string[];
        execute: (...args: unknown[]) => Promise<unknown>;
      }
    | undefined;
  const sent: Array<{ message: string; options: unknown }> = [];
  worktreeExtension({
    registerTool: (definition: unknown) => {
      tool = definition as typeof tool;
    },
    registerCommand: () => undefined,
    on: () => undefined,
    sendUserMessage: (message: string, options: unknown) => {
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI);
  if (!tool) throw new Error("worktree tool was not registered");
  return { tool, sent };
}

test("the queued internal worktree message dispatches an extension command on Pi 0.84", async () => {
  let api: ExtensionAPI | undefined;
  let dispatchedArgs: string | undefined;
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    settingsManager,
    extensionFactories: [
      {
        name: "worktree-dispatch-test",
        factory: (pi) => {
          api = pi;
          installWorktreeCommandDispatchCompatibility();
          pi.registerCommand("worktree", {
            handler: async (args) => {
              dispatchedArgs = args;
            },
          });
        },
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(process.cwd()),
  });
  try {
    if (!api) throw new Error("test extension did not load");
    api.sendUserMessage("/worktree --tool-request eeeeeeee-eeee-eeee-eeee", {
      deliverAs: "followUp",
    });
    for (let index = 0; index < 50 && dispatchedArgs === undefined; index += 1)
      await Bun.sleep(10);
    expect(dispatchedArgs).toBe("--tool-request eeeeeeee-eeee-eeee-eeee");
  } finally {
    session.dispose();
  }
});

test("worktree tool queues a correlated create command and terminates the old run", async () => {
  const { tool, sent } = registeredWorktreeTool();
  expect(tool.name).toBe("worktree");
  expect(tool.promptSnippet).toContain("move this conversation");
  expect(tool.promptGuidelines?.join(" ")).toContain(
    "resolve its actual head branch",
  );
  expect(tool.promptGuidelines?.join(" ")).toContain(
    "Never infer the branch from the PR number",
  );
  expect(tool.promptGuidelines?.join(" ")).toContain(
    "explicitly asks only to create",
  );
  const result = await tool.execute(
    "call-1",
    {
      name: "feature-one",
      repository: "~/Source/my repo",
      branch: "tembo/cancel-builds",
      startPoint: "origin/tembo/cancel-builds",
      continuation: "Resume implementing the requested feature.",
    },
    undefined,
    undefined,
    {
      sessionManager: { getSessionId: () => "source-session" },
    },
  );
  expect(result.terminate).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.options).toEqual({ deliverAs: "followUp" });
  expect(sent[0]?.message).toMatch(/^\/worktree --tool-request [0-9a-f-]+$/);
  const token = sent[0]?.message.split(" ").at(-1) ?? "";
  expect(takeWorktreeToolRequest(token, "source-session")).toMatchObject({
    commandArgs:
      '"feature-one" --repo "~/Source/my repo" --branch "tembo/cancel-builds" --start-point "origin/tembo/cancel-builds"',
    continuation: "Resume implementing the requested feature.",
  });
});

test("worktree tool queues the existing-worktree form without shell interpolation", async () => {
  const { tool, sent } = registeredWorktreeTool();
  await tool.execute(
    "call-2",
    {
      existing: '@../linked checkout; echo "unsafe"',
      continuation: "Continue in the existing checkout.",
    },
    undefined,
    undefined,
    {
      sessionManager: { getSessionId: () => "source-session" },
    },
  );
  const token = sent[0]?.message.split(" ").at(-1) ?? "";
  expect(takeWorktreeToolRequest(token, "source-session").commandArgs).toBe(
    '--existing "../linked checkout; echo \\"unsafe\\""',
  );
});

test("worktree tool correlation is session-bound, concurrent, and cleaned on failure", () => {
  const sent: string[] = [];
  const first = queueWorktreeToolRequest({
    sessionId: "session-a",
    input: { name: "one", continuation: "one next" },
    token: "aaaaaaaa-aaaa-aaaa-aaaa",
    now: 100,
    sendUserMessage: (message) => {
      sent.push(message);
    },
  });
  const second = queueWorktreeToolRequest({
    sessionId: "session-a",
    input: { existing: "/repo/two", continuation: "two next" },
    token: "bbbbbbbb-bbbb-bbbb-bbbb",
    now: 101,
    sendUserMessage: (message) => {
      sent.push(message);
    },
  });
  expect(sent).toEqual([
    "/worktree --tool-request aaaaaaaa-aaaa-aaaa-aaaa",
    "/worktree --tool-request bbbbbbbb-bbbb-bbbb-bbbb",
  ]);
  expect(() => takeWorktreeToolRequest(first.token, "session-b", 102)).toThrow(
    "different session",
  );
  expect(
    takeWorktreeToolRequest(second.token, "session-a", 102).continuation,
  ).toBe("two next");
  expect(
    takeWorktreeToolRequest(first.token, "session-a", 102).continuation,
  ).toBe("one next");

  expect(() =>
    queueWorktreeToolRequest({
      sessionId: "session-a",
      input: { name: "failed", continuation: "never" },
      token: "cccccccc-cccc-cccc-cccc",
      sendUserMessage: () => {
        throw new Error("queue failed");
      },
    }),
  ).toThrow("queue failed");
  expect(() =>
    takeWorktreeToolRequest("cccccccc-cccc-cccc-cccc", "session-a"),
  ).toThrow("missing or expired");

  queueWorktreeToolRequest({
    sessionId: "session-a",
    input: { name: "cleanup", continuation: "never" },
    token: "dddddddd-dddd-dddd-dddd",
    sendUserMessage: () => undefined,
  });
  clearWorktreeToolRequests("session-a");
  expect(() =>
    takeWorktreeToolRequest("dddddddd-dddd-dddd-dddd", "session-a"),
  ).toThrow("missing or expired");
});

test("worktree replacement is single-flight per source session", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = withWorktreeOperation("source-session", async () => {
    await blocked;
    return "done";
  });
  await expect(
    withWorktreeOperation("source-session", async () => "wrong"),
  ).rejects.toThrow("already in progress");
  expect(
    await withWorktreeOperation("other-session", async () => "other"),
  ).toBe("other");
  release();
  expect(await first).toBe("done");
  expect(
    await withWorktreeOperation("source-session", async () => "again"),
  ).toBe("again");
});

test("worktree command parses safe quoted repository arguments", () => {
  expect(
    parseWorktreeCommandArgs('feature-one --repo "~/Source/my repo"'),
  ).toEqual({
    name: "feature-one",
    repository: "~/Source/my repo",
  });
  expect(parseWorktreeCommandArgs("feature-two -C /tmp/repo")).toEqual({
    name: "feature-two",
    repository: "/tmp/repo",
  });
  expect(
    parseWorktreeCommandArgs(
      'pr-30 --repo "/tmp/my repo" --branch "tembo/cancel-builds" --start-point "origin/tembo/cancel-builds"',
    ),
  ).toEqual({
    name: "pr-30",
    repository: "/tmp/my repo",
    branch: "tembo/cancel-builds",
    startPoint: "origin/tembo/cancel-builds",
  });
  expect(
    parseWorktreeCommandArgs(
      "--branch=owner/topic --start-point=origin/owner/topic pr-31",
    ),
  ).toEqual({
    name: "pr-31",
    branch: "owner/topic",
    startPoint: "origin/owner/topic",
  });
});

test("quoted relative and root-relative Windows paths preserve separators", () => {
  expect(parseWorktreeCommandArgs(String.raw`--existing '.\foo\bar'`)).toEqual({
    existing: String.raw`.\foo\bar`,
  });
  expect(parseWorktreeCommandArgs(String.raw`--existing '..\foo\bar'`)).toEqual(
    { existing: String.raw`..\foo\bar` },
  );
  expect(parseWorktreeCommandArgs(String.raw`--existing '\foo\bar'`)).toEqual({
    existing: String.raw`\foo\bar`,
  });
  expect(
    parseWorktreeCommandArgs(String.raw`--existing 'project dir\nested'`),
  ).toEqual({ existing: String.raw`project dir\nested` });
  const jsonQuoted = JSON.stringify(String.raw`project dir\nested`);
  expect(parseWorktreeCommandArgs(`--existing ${jsonQuoted}`)).toEqual({
    existing: String.raw`project dir\nested`,
  });
});

test("double-quoted JSON control escapes decode after spaces", () => {
  expect(
    parseWorktreeCommandArgs(String.raw`--existing "dir with space\nchild"`),
  ).toEqual({ existing: "dir with space\nchild" });
});

test("formatted branch and start-point values round-trip without command interpolation", () => {
  const formatted = formatWorktreeCreateCommandArgs({
    name: "pr-30",
    repository: '/tmp/repo; echo "unsafe"',
    branch: "tembo/cancel-builds",
    startPoint: "origin/tembo/cancel-builds",
  });
  expect(parseWorktreeCommandArgs(formatted)).toEqual({
    name: "pr-30",
    repository: '/tmp/repo; echo "unsafe"',
    branch: "tembo/cancel-builds",
    startPoint: "origin/tembo/cancel-builds",
  });
});

test("tool-quoted worktree paths preserve JSON control escapes", () => {
  const repository =
    "repo\nwith\ttabs\rand\bcontrols\fplus\u0001unicode-escape";
  const command = worktreeToolCommandArgs({
    name: "feature",
    repository,
    continuation: "Continue.",
  });
  expect(parseWorktreeCommandArgs(command).repository).toBe(repository);
});

test("worktree command parses existing checkout paths exclusively", () => {
  expect(parseWorktreeCommandArgs('--existing "../repo worktree"')).toEqual({
    existing: "../repo worktree",
  });
  expect(parseWorktreeCommandArgs("--existing=/tmp/repo-worktree")).toEqual({
    existing: "/tmp/repo-worktree",
  });
  expect(() => parseWorktreeCommandArgs("--existing")).toThrow(
    "requires a worktree path",
  );
  expect(() =>
    parseWorktreeCommandArgs("feature --existing /tmp/worktree"),
  ).toThrow("Usage");
  expect(() =>
    parseWorktreeCommandArgs("--existing /tmp/worktree --repo /tmp/repo"),
  ).toThrow("Usage");
  expect(() =>
    parseWorktreeCommandArgs("--existing /tmp/worktree --branch topic"),
  ).toThrow("Usage");
  expect(() => parseWorktreeCommandArgs("feature --branch")).toThrow(
    "requires a local branch name",
  );
  expect(() => parseWorktreeCommandArgs("feature --start-point")).toThrow(
    "requires a Git ref or commit",
  );
  expect(() =>
    parseWorktreeCommandArgs("feature --branch one --branch two"),
  ).toThrow("Duplicate");
  expect(() =>
    worktreeToolCommandArgs({
      existing: "/tmp/worktree",
      branch: "topic",
      continuation: "Continue.",
    }),
  ).toThrow("Specify existing by itself");
  expect(() =>
    worktreeToolCommandArgs({ name: "nested/path", continuation: "Continue." }),
  ).toThrow("one safe path segment");
  expect(() =>
    worktreeToolCommandArgs({
      name: "safe",
      branch: "bad..branch",
      continuation: "Continue.",
    }),
  ).toThrow("Invalid local branch name");
});

test("branched replacements are self-contained before the source is deleted", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "pi-kit-worktree-branch-parent-"),
  );
  try {
    const sourceCwd = join(directory, "source");
    const targetCwd = join(directory, "target");
    const sourceSessions = join(directory, "source-sessions");
    const replacementSessions = join(directory, "replacement-sessions");
    await mkdir(sourceCwd, { recursive: true });
    await mkdir(targetCwd, { recursive: true });
    const source = SessionManager.create(sourceCwd, sourceSessions);
    source.appendMessage({
      role: "user",
      content: "first",
      timestamp: Date.now(),
    });
    const selectedLeaf = source.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    source.appendMessage({
      role: "user",
      content: "second",
      timestamp: Date.now(),
    });
    source.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "second answer" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    source.branch(selectedLeaf);
    const sourceFile = source.getSessionFile();
    if (!sourceFile)
      throw new Error("source.getSessionFile() returned undefined");
    const replacement = createReplacementSession(
      { sessionManager: source } as unknown as ExtensionCommandContext,
      {
        path: await realpath(targetCwd),
        repoRoot: sourceCwd,
        ref: { kind: "branch", value: "feature" },
      },
      sourceFile,
      replacementSessions,
    );
    const opened = SessionManager.open(replacement.sessionFile);
    expect(opened.getHeader()?.parentSession).toBeUndefined();
    expect(
      opened
        .getEntries()
        .some(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "user" &&
            entry.message.content === "second",
        ),
    ).toBe(false);
    expect(
      (await readdir(sourceSessions)).filter((file) => file.endsWith(".jsonl")),
    ).toEqual([sourceFile.split("/").at(-1)]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("existing worktree migration activates the replacement and rollback restores the source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-kit-worktree-migrate-"));
  try {
    const sourceCwd = join(directory, "source");
    const targetCwd = join(directory, "target");
    await Bun.$`mkdir -p ${sourceCwd} ${targetCwd}`;
    const canonicalTargetCwd = await realpath(targetCwd);
    const source = SessionManager.create(sourceCwd);
    const sourceFile = join(directory, "source-session.jsonl");
    writeFileSync(
      sourceFile,
      `${JSON.stringify({ type: "session", version: 3, id: source.getSessionId(), timestamp: new Date().toISOString(), cwd: sourceCwd })}\n`,
    );
    source.setSessionFile(sourceFile);
    source.appendMessage({
      role: "user",
      content: "retained",
      timestamp: Date.now(),
    });
    let activeFile = sourceFile;
    let rollbackRequested = false;
    let removeTargetBeforeVerification = false;
    let latestReplacementFile: string | undefined;
    let replacementIdOverride: string | undefined;
    const notifications: string[] = [];
    const continuations: string[] = [];
    const ctx = {
      cwd: sourceCwd,
      hasUI: true,
      sessionManager: source,
      waitForIdle: async () => undefined,
      ui: {
        input: async () => undefined,
        notify: (message: string) => {
          notifications.push(message);
        },
      },
      switchSession: async (
        sessionPath: string,
        options?: {
          withSession?: (next: ExtensionCommandContext) => Promise<void>;
        },
      ) => {
        activeFile = sessionPath;
        const nextManager = SessionManager.open(sessionPath);
        if (removeTargetBeforeVerification)
          await rm(targetCwd, { recursive: true, force: true });
        await options?.withSession?.({
          ...ctx,
          cwd: nextManager.getCwd(),
          sessionManager: nextManager,
          sendUserMessage: async (message: string) => {
            continuations.push(message);
          },
          switchSession: async (rollbackPath: string) => {
            rollbackRequested = true;
            activeFile = rollbackPath;
            return { cancelled: false };
          },
        } as ExtensionCommandContext);
        return { cancelled: false };
      },
    } as unknown as ExtensionCommandContext;
    let createOptions: { branch?: string; startPoint?: string } | undefined;
    const rolledBackWorktrees: Array<{
      name: string;
      branch: string;
      branchCreated: boolean;
    }> = [];
    const dependencies = {
      inspectExisting: () => ({
        path: canonicalTargetCwd,
        repoRoot: sourceCwd,
        ref: { kind: "branch", value: "feature" } as const,
      }),
      readCurrentRef: () => ({ kind: "branch", value: "feature" }) as const,
      createReplacement: (
        _ctx: ExtensionCommandContext,
        target: { path: string },
        previousFile: string,
      ) => {
        // Keep forked test sessions inside this fixture. Using the production default
        // writes them into ~/.pi/agent/sessions, where Pi Web discovers them later.
        const replacement = SessionManager.forkFrom(
          previousFile,
          target.path,
          join(directory, "sessions"),
        );
        const replacementFile = replacement.getSessionFile();
        if (!replacementFile)
          throw new Error("replacement.getSessionFile() returned undefined");
        latestReplacementFile = replacementFile;
        return {
          sessionId: replacementIdOverride ?? replacement.getSessionId(),
          sessionFile: latestReplacementFile,
        };
      },
      rollbackWorktree: (worktree: {
        name: string;
        branch: string;
        branchCreated: boolean;
      }) => {
        rolledBackWorktrees.push({
          name: worktree.name,
          branch: worktree.branch,
          branchCreated: worktree.branchCreated,
        });
      },
      // Preserve the shared source fixture for the rollback scenarios below.
      deleteSourceSession: () => undefined,
    };
    const result = await runWorktreeCommand(
      `--existing ${JSON.stringify(targetCwd)}`,
      ctx,
      dependencies,
      "Resume in the verified replacement.",
    );
    expect(result.cancelled).toBe(false);
    expect(SessionManager.open(activeFile).getCwd()).toBe(canonicalTargetCwd);
    expect(SessionManager.open(activeFile).getHeader().parentSession).toBe(
      sourceFile,
    );
    expect(existsSync(sourceFile)).toBe(true);
    expect(rollbackRequested).toBe(false);
    expect(continuations).toEqual(["Resume in the verified replacement."]);

    replacementIdOverride = "mismatched-replacement-id";
    const mismatchedIdentity = await runWorktreeCommand(
      `--existing ${JSON.stringify(targetCwd)}`,
      ctx,
      dependencies,
      "Must not run after identity mismatch.",
    );
    expect(mismatchedIdentity.cancelled).toBe(true);
    expect(rollbackRequested).toBe(true);
    expect(existsSync(sourceFile)).toBe(true);
    if (!latestReplacementFile)
      throw new Error("latestReplacementFile not set");
    expect(existsSync(latestReplacementFile)).toBe(false);
    replacementIdOverride = undefined;
    rollbackRequested = false;

    dependencies.readCurrentRef = () =>
      ({ kind: "branch", value: "changed" }) as const;
    const rolledBack = await runWorktreeCommand(
      `--existing ${JSON.stringify(targetCwd)}`,
      ctx,
      dependencies,
      "Must not run after rollback.",
    );
    expect(rolledBack.cancelled).toBe(true);
    expect(activeFile).toBe(sourceFile);
    expect(rollbackRequested).toBe(true);
    expect(notifications.at(-1)).toContain("Returning to the original session");
    if (!latestReplacementFile)
      throw new Error("latestReplacementFile not set");
    expect(existsSync(latestReplacementFile)).toBe(false);
    expect(continuations).toEqual(["Resume in the verified replacement."]);

    rollbackRequested = false;
    removeTargetBeforeVerification = true;
    await mkdir(targetCwd, { recursive: true });
    const missingTarget = await runWorktreeCommand(
      `--existing ${JSON.stringify(targetCwd)}`,
      ctx,
      dependencies,
      "Must not run when CWD disappears.",
    );
    expect(missingTarget.cancelled).toBe(true);
    expect(rollbackRequested).toBe(true);
    expect(notifications.at(-1)).toContain(
      "Replacement CWD verification failed",
    );
    if (!latestReplacementFile)
      throw new Error("latestReplacementFile not set");
    expect(existsSync(latestReplacementFile)).toBe(false);
    expect(continuations).toEqual(["Resume in the verified replacement."]);

    removeTargetBeforeVerification = false;
    rollbackRequested = false;
    await mkdir(targetCwd, { recursive: true });
    dependencies.createWorktree = async (
      _repository: string,
      _name: string,
      options: { branch?: string; startPoint?: string } = {},
    ) => {
      createOptions = options;
      return {
        path: await realpath(targetCwd),
        repoRoot: sourceCwd,
        name: "pr-30",
        branch: "tembo/cancel-builds",
        branchCreated: false,
        startPoint: "refs/heads/tembo/cancel-builds",
        setupRan: false,
      };
    };
    dependencies.readCurrentRef = () =>
      ({ kind: "branch", value: "tembo/cancel-builds" }) as const;
    const managed = await runWorktreeCommand(
      'pr-30 --branch "tembo/cancel-builds" --start-point "origin/tembo/cancel-builds"',
      ctx,
      dependencies,
      "Resume on the requested PR branch.",
    );
    expect(managed).toMatchObject({
      cancelled: false,
      path: await realpath(targetCwd),
      branch: "tembo/cancel-builds",
    });
    expect(createOptions).toEqual({
      branch: "tembo/cancel-builds",
      startPoint: "origin/tembo/cancel-builds",
    });
    expect(continuations.at(-1)).toBe("Resume on the requested PR branch.");
    expect(rolledBackWorktrees).toEqual([]);

    rollbackRequested = false;
    dependencies.readCurrentRef = () =>
      ({ kind: "branch", value: "wrong-branch" }) as const;
    const managedRollback = await runWorktreeCommand(
      'pr-30 --branch "tembo/cancel-builds" --start-point "origin/tembo/cancel-builds"',
      ctx,
      dependencies,
      "Must not run after managed rollback.",
    );
    expect(managedRollback.cancelled).toBe(true);
    expect(rollbackRequested).toBe(true);
    expect(rolledBackWorktrees).toEqual([
      { name: "pr-30", branch: "tembo/cancel-builds", branchCreated: false },
    ]);
    expect(notifications.at(-1)).toContain("Returning to the original session");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verified replacement deletes its source session and records a durable tombstone", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "pi-kit-worktree-source-delete-"),
  );
  try {
    const sourceCwd = join(directory, "source");
    const targetCwd = join(directory, "target");
    await mkdir(sourceCwd, { recursive: true });
    await mkdir(targetCwd, { recursive: true });
    const source = SessionManager.create(
      sourceCwd,
      join(directory, "source-sessions"),
    );
    const sourceFile = join(directory, "source.jsonl");
    writeFileSync(
      sourceFile,
      `${JSON.stringify({ type: "session", version: 3, id: source.getSessionId(), timestamp: new Date().toISOString(), cwd: sourceCwd })}\n`,
    );
    source.setSessionFile(sourceFile);
    source.appendMessage({
      role: "user",
      content: "move me",
      timestamp: Date.now(),
    });
    source.appendCustomEntry("vessup-replaced-session", {
      previousSessionId: "older-source",
      previousSessionFile: "/tmp/older-source.jsonl",
      replacementSessionId: source.getSessionId(),
    });
    let replacementFile: string | undefined;
    const notifications: string[] = [];
    const ctx = {
      cwd: sourceCwd,
      hasUI: true,
      sessionManager: source,
      waitForIdle: async () => undefined,
      ui: {
        input: async () => undefined,
        notify: (message: string) => {
          notifications.push(message);
        },
      },
      switchSession: async (
        sessionPath: string,
        options?: {
          withSession?: (next: ExtensionCommandContext) => Promise<void>;
        },
      ) => {
        const manager = SessionManager.open(sessionPath);
        await options?.withSession?.({
          ...ctx,
          cwd: manager.getCwd(),
          sessionManager: manager,
          sendUserMessage: async () => {
            throw new Error("continuation transport failed");
          },
        } as ExtensionCommandContext);
        return { cancelled: false };
      },
    } as unknown as ExtensionCommandContext;
    const result = await runWorktreeCommand(
      `--existing ${JSON.stringify(targetCwd)}`,
      ctx,
      {
        inspectExisting: () => ({
          path: realpathSync(targetCwd),
          repoRoot: sourceCwd,
          ref: { kind: "branch", value: "feature" },
        }),
        readCurrentRef: () => ({ kind: "branch", value: "feature" }),
        createReplacement: (_ctx, target, previousFile) => {
          const replacement = SessionManager.forkFrom(
            previousFile,
            target.path,
            join(directory, "replacement-sessions"),
          );
          const replacementFileValue = replacement.getSessionFile();
          if (!replacementFileValue)
            throw new Error("replacement.getSessionFile() returned undefined");
          replacementFile = replacementFileValue;
          return {
            sessionId: replacement.getSessionId(),
            sessionFile: replacementFile,
          };
        },
      },
      "Continue after replacement.",
    );
    expect(result.cancelled).toBe(false);
    expect(
      notifications.some((message) =>
        message.includes("continuation could not be sent"),
      ),
    ).toBe(true);
    expect(existsSync(sourceFile)).toBe(false);
    if (!replacementFile) throw new Error("replacementFile not set");
    expect(existsSync(replacementFile)).toBe(true);
    expect(result.replacedSession).toEqual({
      previousSessionId: source.getSessionId(),
      previousSessionFile: sourceFile,
      replacementSessionId: result.sessionId,
    });
    const replacementEntries =
      SessionManager.open(replacementFile).getEntries();
    expect(replacementFromEntries(replacementEntries)).toEqual(
      result.replacedSession,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

(lsofAvailable ? test : test.skip)(
  "an independently open source session rolls back and preserves the original",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "pi-kit-worktree-source-delete-failure-"),
    );
    try {
      const sourceCwd = join(directory, "source");
      const targetCwd = join(directory, "target");
      await mkdir(sourceCwd, { recursive: true });
      await mkdir(targetCwd, { recursive: true });
      const source = SessionManager.create(
        sourceCwd,
        join(directory, "source-sessions"),
      );
      const sourceFile = join(directory, "source.jsonl");
      writeFileSync(
        sourceFile,
        `${JSON.stringify({ type: "session", version: 3, id: source.getSessionId(), timestamp: new Date().toISOString(), cwd: sourceCwd })}\n`,
      );
      source.setSessionFile(sourceFile);
      let replacementFile: string | undefined;
      let rolledBack = false;
      const notifications: string[] = [];
      const ctx = {
        cwd: sourceCwd,
        hasUI: true,
        sessionManager: source,
        waitForIdle: async () => undefined,
        ui: {
          input: async () => undefined,
          notify: (message: string) => {
            notifications.push(message);
          },
        },
        switchSession: async (
          sessionPath: string,
          options?: {
            withSession?: (next: ExtensionCommandContext) => Promise<void>;
          },
        ) => {
          const manager = SessionManager.open(sessionPath);
          const openSource = openSync(sourceFile, "a");
          try {
            await options?.withSession?.({
              ...ctx,
              cwd: manager.getCwd(),
              sessionManager: manager,
              switchSession: async () => {
                rolledBack = true;
                return { cancelled: false };
              },
            } as ExtensionCommandContext);
          } finally {
            closeSync(openSource);
          }
          return { cancelled: false };
        },
      } as unknown as ExtensionCommandContext;
      const result = await runWorktreeCommand(
        `--existing ${JSON.stringify(targetCwd)}`,
        ctx,
        {
          inspectExisting: () => ({
            path: realpathSync(targetCwd),
            repoRoot: sourceCwd,
            ref: { kind: "branch", value: "feature" },
          }),
          readCurrentRef: () => ({ kind: "branch", value: "feature" }),
          createReplacement: (_ctx, target, previousFile) => {
            const replacement = SessionManager.forkFrom(
              previousFile,
              target.path,
              join(directory, "replacement-sessions"),
            );
            const replacementSessionFile = replacement.getSessionFile();
            if (!replacementSessionFile)
              throw new Error(
                "replacement.getSessionFile() returned undefined",
              );
            replacementFile = replacementSessionFile;
            return {
              sessionId: replacement.getSessionId(),
              sessionFile: replacementFile,
            };
          },
        },
      );
      expect(result.cancelled).toBe(true);
      expect(rolledBack).toBe(true);
      expect(
        notifications.some((message) =>
          message.includes("Source session is still open by process"),
        ),
      ).toBe(true);
      expect(existsSync(sourceFile)).toBe(true);
      if (!replacementFile) throw new Error("replacementFile not set");
      expect(existsSync(replacementFile)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("failed replacement-file cleanup retains the managed worktree CWD", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "pi-kit-worktree-cleanup-retain-"),
  );
  try {
    const sourceCwd = join(directory, "source");
    const targetCwd = join(directory, "target");
    await mkdir(sourceCwd, { recursive: true });
    await mkdir(targetCwd, { recursive: true });
    const source = SessionManager.create(
      sourceCwd,
      join(directory, "sessions"),
    );
    const sourceFile = join(directory, "source-session.jsonl");
    writeFileSync(
      sourceFile,
      `${JSON.stringify({ type: "session", version: 3, id: source.getSessionId(), timestamp: new Date().toISOString(), cwd: sourceCwd })}\n`,
    );
    source.setSessionFile(sourceFile);
    source.appendMessage({
      role: "user",
      content: "persist",
      timestamp: Date.now(),
    });
    const notifications: string[] = [];
    let worktreeRolledBack = false;
    const result = await runWorktreeCommand(
      "managed",
      {
        cwd: sourceCwd,
        hasUI: true,
        sessionManager: source,
        waitForIdle: async () => undefined,
        ui: {
          input: async () => undefined,
          notify: (message: string) => {
            notifications.push(message);
          },
        },
        switchSession: async () => ({ cancelled: true }),
      } as unknown as ExtensionCommandContext,
      {
        createWorktree: async () => ({
          path: await realpath(targetCwd),
          repoRoot: sourceCwd,
          name: "managed",
          branch: "managed",
          branchCreated: true,
          startPoint: "HEAD",
          setupRan: false,
        }),
        createReplacement: () => ({
          sessionId: "replacement",
          sessionFile: targetCwd,
        }),
        rollbackWorktree: () => {
          worktreeRolledBack = true;
        },
      },
    );
    expect(result.cancelled).toBe(true);
    expect(worktreeRolledBack).toBe(false);
    expect(notifications.at(-1)).toContain(
      "Managed worktree retained so that session CWD remains valid",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("existing selection preserves ownership only for the current managed worktree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-kit-worktree-ownership-"));
  try {
    const owned = join(directory, "owned");
    const unrelated = join(directory, "unrelated");
    await Bun.$`mkdir -p ${owned} ${unrelated}`;
    const marker = {
      path: owned,
      repoRoot: directory,
      name: "owned",
      branch: "feature",
      branchCreated: false,
    };
    const entries = [
      { type: "custom", customType: WORKTREE_SESSION_ENTRY, data: marker },
    ];

    expect(inheritedWorktreeOwnership(entries, owned)).toEqual(marker);
    expect(inheritedWorktreeOwnership(entries, unrelated)).toBeUndefined();
    expect(
      inheritedWorktreeOwnership(
        [
          ...entries,
          {
            type: "custom",
            customType: WORKTREE_SESSION_ENTRY,
            data: { managed: false },
          },
        ],
        owned,
      ),
    ).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("worktree invocation only matches the extension command", () => {
  expect(
    parseWorktreeInvocation(
      '/worktree "pr 30" --repo /tmp/repo --branch tembo/cancel-builds --start-point origin/tembo/cancel-builds',
    ),
  ).toEqual({
    name: "pr 30",
    repository: "/tmp/repo",
    branch: "tembo/cancel-builds",
    startPoint: "origin/tembo/cancel-builds",
  });
  expect(parseWorktreeInvocation("please create a worktree")).toBeUndefined();
  expect(() => parseWorktreeCommandArgs("one two")).toThrow("Usage");
  expect(() => parseWorktreeCommandArgs("one --bad")).toThrow("Unknown");
});
