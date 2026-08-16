import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  AgentSession,
  type ExtensionAPI,
  type ExtensionCommandContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
  type CreatedWebWorktree,
  createWebWorktree,
  currentWorktreeRef,
  type ExistingWebWorktree,
  hasOtherSessionInWorktree,
  inspectExistingWorktree,
  type ManagedWorktree,
  managedWorktreeFromEntries,
  removeManagedWorktree,
  rollbackWebWorktree,
  validateLocalBranchName,
  validateWorktreeName,
  WORKTREE_SESSION_ENTRY,
  type WorktreeRef,
} from "../web/server/worktrees.js";
import {
  parseWorktreeCommandArgs,
  WORKTREE_USAGE,
} from "../web/worktree-command.js";
import {
  WORKTREE_REPLACEMENT_ENTRY,
  type WorktreeSessionReplacement,
} from "../web/worktree-replacement.js";

export type { WorktreeSessionReplacement } from "../web/worktree-replacement.js";
export {
  replacementFromEntries,
  WORKTREE_REPLACEMENT_ENTRY,
} from "../web/worktree-replacement.js";

type WorktreeReplacement = WorktreeSessionReplacement & {
  worktreePath: string;
  activated?: WorktreeSessionReplacement;
};

const REPLACEMENTS_KEY = Symbol.for("@vessup/pi-kit/worktree-replacements");
const TOOL_REQUESTS_KEY = Symbol.for("@vessup/pi-kit/worktree-tool-requests");
const OPERATIONS_KEY = Symbol.for("@vessup/pi-kit/worktree-operations");
const COMMAND_DISPATCH_PATCH_KEY = Symbol.for(
  "@vessup/pi-kit/worktree-command-dispatch-patch",
);
const INTERNAL_TOOL_OPTION = "--tool-request";
const TOOL_REQUEST_TOKEN_SOURCE = "[0-9a-f-]{16,}";
const TOOL_REQUEST_TOKEN_PATTERN = new RegExp(
  `^${TOOL_REQUEST_TOKEN_SOURCE}$`,
  "i",
);
const INTERNAL_TOOL_MESSAGE_PATTERN = new RegExp(
  `^/worktree ${INTERNAL_TOOL_OPTION} ${TOOL_REQUEST_TOKEN_SOURCE}$`,
  "i",
);
const INTERNAL_TOOL_ARGUMENT_PATTERN = new RegExp(
  `^${INTERNAL_TOOL_OPTION}\\s+(${TOOL_REQUEST_TOKEN_SOURCE})$`,
  "i",
);
const TOOL_REQUEST_TTL_MS = 30 * 60_000;
const MAX_SESSION_HEADER_BYTES = 64 * 1024;

export const WorktreeToolParameters = Type.Object(
  {
    name: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Safe directory name below <repo>/.pi/worktrees; defaults as the local branch only when branch is omitted",
      }),
    ),
    repository: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Repository path for a managed worktree; defaults to the current CWD",
      }),
    ),
    branch: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Local branch to reuse or create; may contain slashes and defaults to name",
      }),
    ),
    startPoint: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Git ref or commit for a new local branch, such as origin/owner/topic; a remote-tracking ref configures upstream",
      }),
    ),
    existing: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Path to an existing registered worktree in the current primary repository",
      }),
    ),
    continuation: Type.String({
      minLength: 1,
      description:
        "Self-contained instruction for the agent to resume automatically in the replacement session",
    }),
  },
  { additionalProperties: false },
);

export type WorktreeToolInput = Static<typeof WorktreeToolParameters>;

export type PendingWorktreeToolRequest = {
  token: string;
  sourceSessionId: string;
  commandArgs: string;
  continuation: string;
  createdAt: number;
};

type ReplacementGlobal = typeof globalThis & {
  [REPLACEMENTS_KEY]?: Map<string, WorktreeReplacement>;
  [TOOL_REQUESTS_KEY]?: Map<string, PendingWorktreeToolRequest>;
  [OPERATIONS_KEY]?: Map<string, Promise<unknown>>;
  [COMMAND_DISPATCH_PATCH_KEY]?: boolean;
};

function replacements(): Map<string, WorktreeReplacement> {
  const scope = globalThis as ReplacementGlobal;
  return (scope[REPLACEMENTS_KEY] ??= new Map());
}

function toolRequests(): Map<string, PendingWorktreeToolRequest> {
  const scope = globalThis as ReplacementGlobal;
  return (scope[TOOL_REQUESTS_KEY] ??= new Map());
}

function operations(): Map<string, Promise<unknown>> {
  const scope = globalThis as ReplacementGlobal;
  return (scope[OPERATIONS_KEY] ??= new Map());
}

export async function withWorktreeOperation<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (operations().has(sessionId))
    throw new Error(
      "A worktree switch is already in progress for this session",
    );
  const reservation = Promise.resolve();
  operations().set(sessionId, reservation);
  let running: Promise<T> | undefined;
  try {
    running = operation();
    operations().set(sessionId, running);
    return await running;
  } finally {
    const active = operations().get(sessionId);
    if (active === reservation || active === running)
      operations().delete(sessionId);
  }
}

/**
 * Pi 0.84.1's ExtensionAPI.sendUserMessage path disables command expansion,
 * despite the documented tool-to-follow-up-command pattern. Limit the
 * compatibility behavior to this extension's unforgeable, correlated message;
 * all normal user and extension messages retain the host's original semantics.
 */
export function installWorktreeCommandDispatchCompatibility(): void {
  const scope = globalThis as ReplacementGlobal;
  if (scope[COMMAND_DISPATCH_PATCH_KEY]) return;
  const original = AgentSession.prototype.sendUserMessage;
  AgentSession.prototype.sendUserMessage = async function (
    content,
    options,
  ): Promise<void> {
    if (
      typeof content === "string" &&
      INTERNAL_TOOL_MESSAGE_PATTERN.test(content)
    ) {
      await this.prompt(content, {
        expandPromptTemplates: true,
        streamingBehavior: options?.deliverAs,
        source: "extension",
      });
      return;
    }
    await original.call(this, content, options);
  };
  scope[COMMAND_DISPATCH_PATCH_KEY] = true;
}

function pruneToolRequests(now = Date.now()): void {
  for (const [token, request] of toolRequests()) {
    if (now - request.createdAt > TOOL_REQUEST_TTL_MS)
      toolRequests().delete(token);
  }
}

function quoteCommandArgument(value: string): string {
  return JSON.stringify(value);
}

function normalizeToolPath(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

/** Build only parser input; values are never interpolated into a shell command. */
export function worktreeToolCommandArgs(input: WorktreeToolInput): string {
  const requestedName = input.name?.trim();
  const name = requestedName ? validateWorktreeName(requestedName) : undefined;
  const repository = input.repository?.trim() ? input.repository : undefined;
  const branch = input.branch?.trim()
    ? validateLocalBranchName(input.branch)
    : undefined;
  const startPoint = input.startPoint?.trim() || undefined;
  const existing = input.existing?.trim() ? input.existing : undefined;
  if (!input.continuation.trim())
    throw new Error("worktree requires a continuation prompt");
  if (existing) {
    if (name || repository || branch || startPoint)
      throw new Error(
        "Specify existing by itself, or name with optional repository, branch, and startPoint values",
      );
    return `--existing ${quoteCommandArgument(normalizeToolPath(existing))}`;
  }
  if (!name)
    throw new Error("Specify a worktree name or an existing worktree path");
  return [
    quoteCommandArgument(name),
    repository
      ? `--repo ${quoteCommandArgument(normalizeToolPath(repository))}`
      : undefined,
    branch ? `--branch ${quoteCommandArgument(branch)}` : undefined,
    startPoint
      ? `--start-point ${quoteCommandArgument(startPoint)}`
      : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");
}

export function queueWorktreeToolRequest(options: {
  sessionId: string;
  input: WorktreeToolInput;
  sendUserMessage: (
    message: string,
    options: { deliverAs: "followUp" },
  ) => void;
  token?: string;
  now?: number;
}): PendingWorktreeToolRequest {
  const now = options.now ?? Date.now();
  pruneToolRequests(now);
  const token = options.token ?? crypto.randomUUID();
  if (!TOOL_REQUEST_TOKEN_PATTERN.test(token) || toolRequests().has(token))
    throw new Error("Could not allocate a unique worktree request token");
  const request: PendingWorktreeToolRequest = {
    token,
    sourceSessionId: options.sessionId,
    commandArgs: worktreeToolCommandArgs(options.input),
    continuation: options.input.continuation,
    createdAt: now,
  };
  toolRequests().set(token, request);
  try {
    options.sendUserMessage(`/worktree ${INTERNAL_TOOL_OPTION} ${token}`, {
      deliverAs: "followUp",
    });
  } catch (error) {
    toolRequests().delete(token);
    throw error;
  }
  return request;
}

export function takeWorktreeToolRequest(
  token: string,
  sessionId: string,
  now = Date.now(),
): PendingWorktreeToolRequest {
  pruneToolRequests(now);
  const request = toolRequests().get(token);
  if (!request) throw new Error("Worktree tool request is missing or expired");
  if (request.sourceSessionId !== sessionId)
    throw new Error("Worktree tool request belongs to a different session");
  toolRequests().delete(token);
  return request;
}

export function clearWorktreeToolRequests(sessionId?: string): void {
  for (const [token, request] of toolRequests()) {
    if (!sessionId || request.sourceSessionId === sessionId)
      toolRequests().delete(token);
  }
}

function internalToolRequestToken(args: string): string | undefined {
  const trimmed = args.trim();
  if (!trimmed.startsWith(INTERNAL_TOOL_OPTION)) return undefined;
  const match = trimmed.match(INTERNAL_TOOL_ARGUMENT_PATTERN);
  if (!match) throw new Error("Invalid internal worktree tool request");
  return match[1];
}

/** Consumed by the web bridge after Pi has rebound the replacement session. */
export function consumeWorktreeReplacement(
  sessionId: string,
): WorktreeReplacement | undefined {
  const replacement = replacements().get(sessionId);
  if (replacement) replacements().delete(sessionId);
  return replacement;
}

function resolveRepository(input: string, cwd: string): string {
  const expanded =
    input === "~"
      ? homedir()
      : input.startsWith("~/")
        ? resolve(homedir(), input.slice(2))
        : input;
  return realpathSync(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
}

type WorktreeSelection =
  | {
      mode: "create";
      name: string;
      repository: string;
      branch?: string;
      startPoint?: string;
    }
  | { mode: "existing"; path: string };

type WorktreeTarget = {
  path: string;
  repoRoot: string;
  ref: WorktreeRef;
  managed?: CreatedWebWorktree;
};

/** Preserve ownership only when re-entering the checkout owned by this session. */
export function inheritedWorktreeOwnership(
  entries: readonly unknown[],
  targetPath: string,
): ManagedWorktree | undefined {
  const inherited = managedWorktreeFromEntries(entries);
  if (!inherited) return undefined;
  try {
    return realpathSync(inherited.path) === realpathSync(targetPath)
      ? inherited
      : undefined;
  } catch {
    return undefined;
  }
}

async function collectArguments(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<WorktreeSelection | undefined> {
  const parsed = parseWorktreeCommandArgs(args);
  if (parsed.existing)
    return {
      mode: "existing",
      path: resolveRepository(parsed.existing, ctx.cwd),
    };
  let repository = parsed.repository;
  let name = parsed.name;
  if (!repository) repository = ctx.cwd;
  if (!name && ctx.hasUI) {
    name = await ctx.ui.input("New worktree", "Managed directory name");
  }
  if (!name) {
    ctx.ui.notify(WORKTREE_USAGE, "warning");
    return undefined;
  }
  return {
    mode: "create",
    name,
    repository: resolveRepository(repository, ctx.cwd),
    branch: parsed.branch,
    startPoint: parsed.startPoint,
  };
}

function writeAll(descriptor: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(
      descriptor,
      buffer,
      offset,
      buffer.length - offset,
    );
    if (written <= 0)
      throw new Error("Could not rewrite replacement session header");
    offset += written;
  }
}

/** Rewrite the bounded session header without loading its transcript. */
function rewriteSessionParent(
  sessionFile: string,
  parentSessionFile?: string,
): void {
  const input = openSync(sessionFile, "r");
  const temporary = `${sessionFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let output: number | undefined;
  try {
    const buffer = Buffer.allocUnsafe(MAX_SESSION_HEADER_BYTES);
    const firstRead = readSync(input, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, firstRead).indexOf(0x0a);
    if (newline < 0)
      throw new Error("Replacement session header is missing or too large");
    const header = JSON.parse(
      buffer.subarray(0, newline).toString("utf8"),
    ) as Record<string, unknown>;
    if (header.type !== "session")
      throw new Error("Replacement session has no valid header");
    if (parentSessionFile) header.parentSession = parentSessionFile;
    else delete header.parentSession;
    output = openSync(temporary, "wx", 0o600);
    writeAll(output, Buffer.from(`${JSON.stringify(header)}\n`));
    writeAll(output, buffer.subarray(newline + 1, firstRead));
    let position = firstRead;
    while (true) {
      const bytesRead = readSync(input, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      writeAll(output, buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    closeSync(output);
    output = undefined;
    renameSync(temporary, sessionFile);
  } finally {
    closeSync(input);
    if (output !== undefined) closeSync(output);
    try {
      unlinkSync(temporary);
    } catch {
      /* renamed or never created */
    }
  }
}

function verifiedSessionId(sessionFile: string): string {
  const descriptor = openSync(sessionFile, "r");
  try {
    const buffer = Buffer.allocUnsafe(MAX_SESSION_HEADER_BYTES);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0) throw new Error("Session header is missing or too large");
    const header = JSON.parse(
      buffer.subarray(0, newline).toString("utf8"),
    ) as Record<string, unknown>;
    if (header.type !== "session" || typeof header.id !== "string")
      throw new Error("Session has no valid header ID");
    return header.id;
  } finally {
    closeSync(descriptor);
  }
}

type SourceSessionSnapshot = { size: number; mtimeMs: number; ino: number };

function sourceSessionSnapshot(sessionFile: string): SourceSessionSnapshot {
  const stats = statSync(sessionFile);
  return { size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino };
}

function assertSourceSessionIsNotOpen(sessionFile: string): void {
  const result = spawnSync("lsof", ["-t", "--", sessionFile], {
    encoding: "utf8",
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    throw new Error(
      "Could not verify exclusive source-session ownership: lsof is required but was not found in PATH",
    );
  }
  if (result.error)
    throw new Error(
      `Could not verify exclusive source-session ownership: ${result.error.message}`,
    );
  if (result.status === 0 && result.stdout.trim()) {
    throw new Error(
      `Source session is still open by process ${result.stdout.trim().split(/\s+/).join(", ")}`,
    );
  }
  if (result.status !== 1)
    throw new Error(
      result.stderr.trim() ||
        `Could not verify exclusive source-session ownership (lsof exited ${result.status})`,
    );
}

function deleteVerifiedSourceSession(
  sessionFile: string,
  expectedSessionId: string,
  expected: SourceSessionSnapshot,
): void {
  const tombstone = `${sessionFile}.replaced-${crypto.randomUUID()}.tmp`;
  renameSync(sessionFile, tombstone);
  try {
    const current = sourceSessionSnapshot(tombstone);
    if (
      current.size !== expected.size ||
      current.mtimeMs !== expected.mtimeMs ||
      current.ino !== expected.ino
    ) {
      throw new Error(
        "Source session changed after the replacement snapshot was created",
      );
    }
    const actualSessionId = verifiedSessionId(tombstone);
    if (actualSessionId !== expectedSessionId) {
      throw new Error(
        `Source session identity changed (expected ${expectedSessionId}, found ${actualSessionId})`,
      );
    }
    if (existsSync(sessionFile))
      throw new Error("Source session path was recreated during deletion");
    const final = sourceSessionSnapshot(tombstone);
    if (
      final.size !== current.size ||
      final.mtimeMs !== current.mtimeMs ||
      final.ino !== current.ino
    ) {
      throw new Error(
        "Source session changed while deletion was being verified",
      );
    }
    assertSourceSessionIsNotOpen(tombstone);
    if (existsSync(sessionFile))
      throw new Error("Source session path was recreated during deletion");
    unlinkSync(tombstone);
  } catch (error) {
    if (!existsSync(sessionFile) && existsSync(tombstone))
      renameSync(tombstone, sessionFile);
    throw error;
  }
}

class ReplacementSessionCleanupError extends Error {}

function removeReplacementSession(sessionFile: string): string | undefined {
  try {
    unlinkSync(sessionFile);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return error instanceof Error ? error.message : String(error);
  }
}

export function createReplacementSession(
  ctx: ExtensionCommandContext,
  target: WorktreeTarget,
  previousSessionFile: string,
  sessionDir?: string,
): { sessionId: string; sessionFile: string } {
  let sourceFile = previousSessionFile;
  let temporaryBranchFile: string | undefined;
  let replacementSessionFile: string | undefined;
  const activeLeaf = ctx.sessionManager.getLeafId();
  try {
    const diskSession = SessionManager.open(previousSessionFile);
    if (
      activeLeaf &&
      diskSession.getLeafId() !== activeLeaf &&
      diskSession.getEntry(activeLeaf)
    ) {
      temporaryBranchFile = diskSession.createBranchedSession(activeLeaf);
      if (temporaryBranchFile) sourceFile = temporaryBranchFile;
    }
    const replacement = SessionManager.forkFrom(
      sourceFile,
      target.path,
      sessionDir,
    );
    const sessionFile = replacement.getSessionFile();
    if (!sessionFile || !existsSync(sessionFile))
      throw new Error("Pi did not create the replacement session file");
    replacementSessionFile = sessionFile;
    // The source file is deleted after verified activation, so the replacement
    // must be a self-contained root rather than retain a dangling parent path.
    rewriteSessionParent(sessionFile);
    const ownership =
      target.managed ??
      inheritedWorktreeOwnership(ctx.sessionManager.getEntries(), target.path);
    if (ownership) {
      replacement.appendCustomEntry(WORKTREE_SESSION_ENTRY, {
        path: ownership.path,
        repoRoot: ownership.repoRoot,
        name: ownership.name,
        branch: ownership.branch,
        branchCreated: ownership.branchCreated,
      });
    } else {
      // forkFrom copies extension entries. Explicitly clear ownership when
      // entering an unrelated existing checkout, while retaining it when this
      // command merely replaces a session inside its current managed worktree.
      replacement.appendCustomEntry(WORKTREE_SESSION_ENTRY, { managed: false });
    }
    return { sessionId: replacement.getSessionId(), sessionFile };
  } catch (error) {
    const cleanupError = replacementSessionFile
      ? removeReplacementSession(replacementSessionFile)
      : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (cleanupError)
      throw new ReplacementSessionCleanupError(
        `${message}; could not remove failed replacement session: ${cleanupError}`,
      );
    throw new Error(message);
  } finally {
    if (temporaryBranchFile) {
      try {
        unlinkSync(temporaryBranchFile);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

export type WorktreeCommandResult = {
  cancelled: boolean;
  sessionId?: string;
  path?: string;
  branch?: string;
  replacedSession?: WorktreeSessionReplacement;
};

type WorktreeCommandDependencies = {
  createWorktree?: typeof createWebWorktree;
  inspectExisting?: typeof inspectExistingWorktree;
  readCurrentRef?: typeof currentWorktreeRef;
  createReplacement?: typeof createReplacementSession;
  rollbackWorktree?: typeof rollbackWebWorktree;
  deleteSourceSession?: (sessionFile: string) => void;
};

async function runWorktreeCommandUnlocked(
  args: string,
  ctx: ExtensionCommandContext,
  dependencies: WorktreeCommandDependencies,
  continuation?: string,
): Promise<WorktreeCommandResult> {
  const createWorktree = dependencies.createWorktree ?? createWebWorktree;
  const inspectExisting =
    dependencies.inspectExisting ?? inspectExistingWorktree;
  const readCurrentRef = dependencies.readCurrentRef ?? currentWorktreeRef;
  const createReplacement =
    dependencies.createReplacement ?? createReplacementSession;
  const rollbackWorktree = dependencies.rollbackWorktree ?? rollbackWebWorktree;
  await ctx.waitForIdle();
  const input = await collectArguments(args, ctx);
  if (!input) return { cancelled: true };

  const previousSessionId = ctx.sessionManager.getSessionId();
  const previousSessionFile = ctx.sessionManager.getSessionFile();
  if (!previousSessionFile || !existsSync(previousSessionFile)) {
    throw new Error(
      "The current conversation is not persisted yet. Wait for the first assistant response, then retry /worktree.",
    );
  }
  const sourceSnapshot = sourceSessionSnapshot(previousSessionFile);
  const deleteSourceSession =
    dependencies.deleteSourceSession ??
    ((sessionFile: string) =>
      deleteVerifiedSourceSession(
        sessionFile,
        previousSessionId,
        sourceSnapshot,
      ));

  let target: WorktreeTarget;
  try {
    if (input.mode === "existing") {
      const existing: ExistingWebWorktree = inspectExisting(
        ctx.cwd,
        input.path,
      );
      target = {
        path: existing.path,
        repoRoot: existing.repoRoot,
        ref: existing.ref,
      };
    } else {
      const created = await createWorktree(input.repository, input.name, {
        branch: input.branch,
        startPoint: input.startPoint,
      });
      target = {
        path: created.path,
        repoRoot: created.repoRoot,
        ref: { kind: "branch", value: created.branch },
        managed: created,
      };
    }
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }

  let managedTargetRolledBack = false;
  const rollbackManagedTarget = (): string | undefined => {
    if (!target.managed || managedTargetRolledBack) return undefined;
    try {
      rollbackWorktree(target.managed);
      managedTargetRolledBack = true;
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  let replacement: { sessionId: string; sessionFile: string };
  try {
    replacement = createReplacement(ctx, target, previousSessionFile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rollbackError =
      error instanceof ReplacementSessionCleanupError
        ? undefined
        : rollbackManagedTarget();
    throw new Error(
      rollbackError
        ? `${message}; managed worktree rollback failed: ${rollbackError}`
        : message,
    );
  }

  const replacedSession: WorktreeSessionReplacement = {
    previousSessionId,
    previousSessionFile,
    replacementSessionId: replacement.sessionId,
  };
  const previousManagedWorktree = managedWorktreeFromEntries(
    ctx.sessionManager.getEntries(),
  );
  const shouldRemovePreviousWorktree =
    process.env.PI_WEB_MANAGED !== "1" &&
    Boolean(
      previousManagedWorktree &&
        !hasOtherSessionInWorktree(
          dirname(ctx.sessionManager.getSessionDir()),
          previousSessionFile,
          previousManagedWorktree.path,
        ),
    );
  let replacementState: WorktreeReplacement | undefined;
  if (process.env.PI_WEB_MANAGED !== "1") {
    replacementState = { ...replacedSession, worktreePath: target.path };
    replacements().set(replacement.sessionId, replacementState);
  }

  let switched = false;
  try {
    let verifiedSessionId: string | undefined;
    let rollbackCompleted = false;
    const result = await ctx.switchSession(replacement.sessionFile, {
      withSession: async (next) => {
        switched = true;
        const rollback = async (message: string) => {
          replacements().delete(replacement.sessionId);
          next.ui.notify(
            `${message} Returning to the original session.`,
            "error",
          );
          await next.switchSession(previousSessionFile);
          const cleanupError = removeReplacementSession(
            replacement.sessionFile,
          );
          if (cleanupError)
            next.ui.notify(
              `Could not remove failed replacement session ${replacement.sessionFile}: ${cleanupError}. Managed worktree retained so that session CWD remains valid.`,
              "warning",
            );
          const worktreeRollbackError = cleanupError
            ? undefined
            : rollbackManagedTarget();
          if (worktreeRollbackError)
            next.ui.notify(
              `Could not roll back managed worktree ${target.path}: ${worktreeRollbackError}`,
              "warning",
            );
          rollbackCompleted = true;
        };
        const actualSessionId = next.sessionManager.getSessionId();
        const actualSessionFile = next.sessionManager.getSessionFile();
        if (actualSessionId !== replacement.sessionId || !actualSessionFile) {
          await rollback(
            `Replacement session identity verification failed. Expected ${replacement.sessionId}, found ${actualSessionId}.`,
          );
          return;
        }
        try {
          if (
            realpathSync(actualSessionFile) !==
            realpathSync(replacement.sessionFile)
          ) {
            await rollback(
              `Replacement session file verification failed. Opened ${actualSessionFile}, not ${replacement.sessionFile}.`,
            );
            return;
          }
        } catch (error) {
          await rollback(
            `Replacement session file verification failed: ${error instanceof Error ? error.message : String(error)}.`,
          );
          return;
        }
        let actualCwd: string;
        try {
          actualCwd = realpathSync(next.cwd);
        } catch (error) {
          await rollback(
            `Replacement CWD verification failed: ${error instanceof Error ? error.message : String(error)}.`,
          );
          return;
        }
        if (actualCwd !== target.path) {
          await rollback(
            `Replacement session opened in ${actualCwd}, not ${target.path}.`,
          );
          return;
        }
        let actualRef: WorktreeRef;
        try {
          actualRef = readCurrentRef(actualCwd);
        } catch (error) {
          await rollback(
            `Worktree ref verification failed: ${error instanceof Error ? error.message : String(error)}.`,
          );
          return;
        }
        if (
          actualRef.kind !== target.ref.kind ||
          actualRef.value !== target.ref.value
        ) {
          await rollback(
            `Worktree ref verification failed. Expected ${target.ref.kind} ${target.ref.value}, found ${actualRef.kind} ${actualRef.value}.`,
          );
          return;
        }
        (next.sessionManager as unknown as SessionManager).appendCustomEntry(
          WORKTREE_REPLACEMENT_ENTRY,
          replacedSession,
        );
        if (process.env.PI_WEB_MANAGED !== "1") {
          try {
            deleteSourceSession(previousSessionFile);
          } catch (error) {
            await rollback(
              `Could not delete the source session: ${error instanceof Error ? error.message : String(error)}.`,
            );
            return;
          }
        }
        if (replacementState) replacementState.activated = replacedSession;
        verifiedSessionId = next.sessionManager.getSessionId();
        const refLabel =
          target.ref.kind === "branch"
            ? target.ref.value
            : `detached ${target.ref.value}`;
        next.ui.notify(
          `Switched this conversation to ${target.path} (${refLabel}).`,
          "info",
        );
        if (shouldRemovePreviousWorktree && previousManagedWorktree) {
          try {
            const cleanup = removeManagedWorktree(previousManagedWorktree);
            if (cleanup.branchWarning)
              next.ui.notify(
                `Previous worktree removed, but branch ${previousManagedWorktree.branch} could not be deleted: ${cleanup.branchWarning}`,
                "warning",
              );
          } catch (error) {
            next.ui.notify(
              `Source session deleted, but previous managed worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
              "warning",
            );
          }
        }
        if (continuation) {
          try {
            await next.sendUserMessage(continuation);
          } catch (error) {
            next.ui.notify(
              `Conversation moved successfully, but its continuation could not be sent: ${error instanceof Error ? error.message : String(error)}`,
              "warning",
            );
          }
        }
      },
    });
    if (result.cancelled || !verifiedSessionId) {
      replacements().delete(replacement.sessionId);
      const cleanupError = removeReplacementSession(replacement.sessionFile);
      if (cleanupError)
        ctx.ui.notify(
          `Could not remove cancelled replacement session ${replacement.sessionFile}: ${cleanupError}. Managed worktree retained so that session CWD remains valid.`,
          "warning",
        );
      if (!rollbackCompleted && !cleanupError) {
        const worktreeRollbackError = rollbackManagedTarget();
        if (worktreeRollbackError)
          ctx.ui.notify(
            `Could not roll back managed worktree ${target.path}: ${worktreeRollbackError}`,
            "warning",
          );
      }
      return { cancelled: true };
    }
    return {
      cancelled: false,
      sessionId: verifiedSessionId,
      path: target.path,
      branch: target.ref.kind === "branch" ? target.ref.value : undefined,
      replacedSession,
    };
  } catch (error) {
    replacements().delete(replacement.sessionId);
    if (switched)
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; Pi switched sessions before reporting the failure`,
      );
    const cleanupError = removeReplacementSession(replacement.sessionFile);
    const worktreeRollbackError = cleanupError
      ? undefined
      : rollbackManagedTarget();
    const message = error instanceof Error ? error.message : String(error);
    if (cleanupError || worktreeRollbackError) {
      throw new Error(
        [
          message,
          cleanupError
            ? `could not remove failed replacement session: ${cleanupError}`
            : undefined,
          worktreeRollbackError
            ? `managed worktree rollback failed: ${worktreeRollbackError}`
            : undefined,
        ]
          .filter((value): value is string => value !== undefined)
          .join("; "),
      );
    }
    throw error;
  }
}

export async function runWorktreeCommand(
  args: string,
  ctx: ExtensionCommandContext,
  dependencies: WorktreeCommandDependencies = {},
  continuation?: string,
): Promise<WorktreeCommandResult> {
  const sourceSessionId = ctx.sessionManager.getSessionId();
  return await withWorktreeOperation(sourceSessionId, () =>
    runWorktreeCommandUnlocked(args, ctx, dependencies, continuation),
  );
}

export default function worktreeExtension(pi: ExtensionAPI): void {
  installWorktreeCommandDispatchCompatibility();

  pi.registerTool({
    name: "worktree",
    label: "Worktree",
    description:
      "Create a managed Git worktree with an independent directory name, local branch, and optional start ref/upstream, or enter an existing registered worktree; replace this Pi session and continue there.",
    promptSnippet:
      "Create or enter a managed Git worktree on the requested branch/ref, move this conversation there, and resume the task",
    promptGuidelines: [
      "Use the worktree tool when the user asks to create and enter a managed worktree or to enter an existing registered worktree; do not ask the user to type /worktree.",
      "For a pull request URL, resolve its actual head branch and available remote-tracking ref first; pass a safe directory name (for example pr-30) and the local branch (for example tembo/cancel-builds), plus the remote startPoint (for example origin/tembo/cancel-builds) only when that local branch does not already exist. Never infer the branch from the PR number.",
      "When the user explicitly asks only to create a checkout without entering it, honor that as an ordinary Git operation without replacing the conversation.",
      "Call the worktree tool as the final tool for the current run and provide a self-contained continuation prompt for the replacement session.",
    ],
    parameters: WorktreeToolParameters,
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      const request = queueWorktreeToolRequest({
        sessionId: ctx.sessionManager.getSessionId(),
        input,
        sendUserMessage: (message, options) =>
          pi.sendUserMessage(message, options),
      });
      return {
        content: [
          {
            type: "text",
            text: "Queued the worktree session switch. This agent run will stop, and the task will resume automatically after the replacement is verified.",
          },
        ],
        details: { token: request.token, commandArgs: request.commandArgs },
        terminate: true,
      };
    },
  });

  pi.registerCommand("worktree", {
    description:
      "Create or enter a repository worktree on an optional branch/start ref and move this conversation into it",
    handler: async (args, ctx) => {
      const token = internalToolRequestToken(args);
      const request = token
        ? takeWorktreeToolRequest(token, ctx.sessionManager.getSessionId())
        : undefined;
      const result = await runWorktreeCommand(
        request?.commandArgs ?? args,
        ctx,
        {},
        request?.continuation,
      );
      if (process.env.PI_WEB_MANAGED === "1" && result.cancelled)
        throw new Error("Worktree switch cancelled");
    },
  });

  pi.on("agent_settled", (_event, ctx) => {
    // A correctly dispatched internal command consumes its request before waiting
    // for idle. Anything left now was never dispatched or lost a concurrent race.
    clearWorktreeToolRequests(ctx.sessionManager.getSessionId());
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearWorktreeToolRequests(ctx.sessionManager.getSessionId());
  });
}
