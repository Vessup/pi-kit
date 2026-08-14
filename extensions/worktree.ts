import { existsSync, realpathSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
	AgentSession,
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
	createWebWorktree,
	currentWorktreeRef,
	inspectExistingWorktree,
	managedWorktreeFromEntries,
	WORKTREE_SESSION_ENTRY,
	type CreatedWebWorktree,
	type ExistingWebWorktree,
	type ManagedWorktree,
	type WorktreeRef,
} from "../web/server/worktrees.js";
import { parseWorktreeCommandArgs } from "../web/worktree-command.js";

type WorktreeReplacement = {
	previousSessionId: string;
	previousSessionFile: string;
	worktreePath: string;
};

const REPLACEMENTS_KEY = Symbol.for("@vessup/pi-kit/worktree-replacements");
const TOOL_REQUESTS_KEY = Symbol.for("@vessup/pi-kit/worktree-tool-requests");
const OPERATIONS_KEY = Symbol.for("@vessup/pi-kit/worktree-operations");
const COMMAND_DISPATCH_PATCH_KEY = Symbol.for("@vessup/pi-kit/worktree-command-dispatch-patch");
const INTERNAL_TOOL_OPTION = "--tool-request";
const TOOL_REQUEST_TTL_MS = 30 * 60_000;

export const WorktreeToolParameters = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1, description: "Safe worktree and branch name to create" })),
	repository: Type.Optional(Type.String({ minLength: 1, description: "Repository path for a managed worktree; defaults to the current CWD" })),
	existing: Type.Optional(Type.String({ minLength: 1, description: "Path to an existing registered worktree in the current primary repository" })),
	continuation: Type.String({ minLength: 1, description: "Self-contained instruction for the agent to resume automatically in the replacement session" }),
}, { additionalProperties: false });

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
	return scope[REPLACEMENTS_KEY] ??= new Map();
}

function toolRequests(): Map<string, PendingWorktreeToolRequest> {
	const scope = globalThis as ReplacementGlobal;
	return scope[TOOL_REQUESTS_KEY] ??= new Map();
}

function operations(): Map<string, Promise<unknown>> {
	const scope = globalThis as ReplacementGlobal;
	return scope[OPERATIONS_KEY] ??= new Map();
}

export async function withWorktreeOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
	if (operations().has(sessionId)) throw new Error("A worktree switch is already in progress for this session");
	const reservation = Promise.resolve();
	operations().set(sessionId, reservation);
	let running: Promise<T> | undefined;
	try {
		running = operation();
		operations().set(sessionId, running);
		return await running;
	} finally {
		const active = operations().get(sessionId);
		if (active === reservation || active === running) operations().delete(sessionId);
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
	AgentSession.prototype.sendUserMessage = async function (content, options): Promise<void> {
		if (typeof content === "string" && /^\/worktree --tool-request [0-9a-f-]{16,}$/i.test(content)) {
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
		if (now - request.createdAt > TOOL_REQUEST_TTL_MS) toolRequests().delete(token);
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
	const name = input.name?.trim();
	const repository = input.repository?.trim();
	const existing = input.existing?.trim();
	if (!input.continuation.trim()) throw new Error("worktree requires a continuation prompt");
	if (existing) {
		if (name || repository) throw new Error("Specify existing by itself, or name with an optional repository");
		return `--existing ${quoteCommandArgument(normalizeToolPath(existing))}`;
	}
	if (!name) throw new Error("Specify a worktree name or an existing worktree path");
	return `${quoteCommandArgument(name)}${repository ? ` --repo ${quoteCommandArgument(normalizeToolPath(repository))}` : ""}`;
}

export function queueWorktreeToolRequest(options: {
	sessionId: string;
	input: WorktreeToolInput;
	sendUserMessage: (message: string, options: { deliverAs: "followUp" }) => void;
	token?: string;
	now?: number;
}): PendingWorktreeToolRequest {
	const now = options.now ?? Date.now();
	pruneToolRequests(now);
	const token = options.token ?? crypto.randomUUID();
	if (!/^[0-9a-f-]{16,}$/i.test(token) || toolRequests().has(token)) throw new Error("Could not allocate a unique worktree request token");
	const request: PendingWorktreeToolRequest = {
		token,
		sourceSessionId: options.sessionId,
		commandArgs: worktreeToolCommandArgs(options.input),
		continuation: options.input.continuation,
		createdAt: now,
	};
	toolRequests().set(token, request);
	try {
		options.sendUserMessage(`/worktree ${INTERNAL_TOOL_OPTION} ${token}`, { deliverAs: "followUp" });
	} catch (error) {
		toolRequests().delete(token);
		throw error;
	}
	return request;
}

export function takeWorktreeToolRequest(token: string, sessionId: string, now = Date.now()): PendingWorktreeToolRequest {
	pruneToolRequests(now);
	const request = toolRequests().get(token);
	if (!request) throw new Error("Worktree tool request is missing or expired");
	if (request.sourceSessionId !== sessionId) throw new Error("Worktree tool request belongs to a different session");
	toolRequests().delete(token);
	return request;
}

export function clearWorktreeToolRequests(sessionId?: string): void {
	for (const [token, request] of toolRequests()) {
		if (!sessionId || request.sourceSessionId === sessionId) toolRequests().delete(token);
	}
}

function internalToolRequestToken(args: string): string | undefined {
	const trimmed = args.trim();
	if (!trimmed.startsWith(INTERNAL_TOOL_OPTION)) return undefined;
	const match = trimmed.match(/^--tool-request\s+([0-9a-f-]{16,})$/i);
	if (!match) throw new Error("Invalid internal worktree tool request");
	return match[1];
}

/** Consumed by the web bridge after Pi has rebound the replacement session. */
export function consumeWorktreeReplacement(sessionId: string): WorktreeReplacement | undefined {
	const replacement = replacements().get(sessionId);
	if (replacement) replacements().delete(sessionId);
	return replacement;
}

function resolveRepository(input: string, cwd: string): string {
	const expanded = input === "~" ? homedir() : input.startsWith("~/") ? resolve(homedir(), input.slice(2)) : input;
	return realpathSync(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
}

type WorktreeSelection =
	| { mode: "create"; name: string; repository: string }
	| { mode: "existing"; path: string };

type WorktreeTarget = {
	path: string;
	repoRoot: string;
	ref: WorktreeRef;
	managed?: CreatedWebWorktree;
};

/** Preserve ownership only when re-entering the checkout owned by this session. */
export function inheritedWorktreeOwnership(entries: readonly unknown[], targetPath: string): ManagedWorktree | undefined {
	const inherited = managedWorktreeFromEntries(entries);
	if (!inherited) return undefined;
	try {
		return realpathSync(inherited.path) === realpathSync(targetPath) ? inherited : undefined;
	} catch {
		return undefined;
	}
}

async function collectArguments(args: string, ctx: ExtensionCommandContext): Promise<WorktreeSelection | undefined> {
	const parsed = parseWorktreeCommandArgs(args);
	if (parsed.existing) return { mode: "existing", path: resolveRepository(parsed.existing, ctx.cwd) };
	let repository = parsed.repository;
	let name = parsed.name;
	if (!repository) repository = ctx.cwd;
	if (!name && ctx.hasUI) {
		name = await ctx.ui.input("New worktree", "Worktree and branch name");
	}
	if (!name) {
		ctx.ui.notify("Usage: /worktree <name> [--repo <path>] | /worktree --existing <worktree-path>", "warning");
		return undefined;
	}
	return { mode: "create", name, repository: resolveRepository(repository, ctx.cwd) };
}

function createReplacementSession(
	ctx: ExtensionCommandContext,
	target: WorktreeTarget,
	previousSessionFile: string,
): { sessionId: string; sessionFile: string } {
	let sourceFile = previousSessionFile;
	let temporaryBranchFile: string | undefined;
	const activeLeaf = ctx.sessionManager.getLeafId();
	try {
		const diskSession = SessionManager.open(previousSessionFile);
		if (activeLeaf && diskSession.getLeafId() !== activeLeaf && diskSession.getEntry(activeLeaf)) {
			temporaryBranchFile = diskSession.createBranchedSession(activeLeaf);
			if (temporaryBranchFile) sourceFile = temporaryBranchFile;
		}
		const replacement = SessionManager.forkFrom(sourceFile, target.path);
		const ownership = target.managed ?? inheritedWorktreeOwnership(ctx.sessionManager.getEntries(), target.path);
		if (ownership) {
			replacement.appendCustomEntry(WORKTREE_SESSION_ENTRY, {
				path: ownership.path,
				repoRoot: ownership.repoRoot,
				branch: ownership.branch,
			});
		} else {
			// forkFrom copies extension entries. Explicitly clear ownership when
			// entering an unrelated existing checkout, while retaining it when this
			// command merely replaces a session inside its current managed worktree.
			replacement.appendCustomEntry(WORKTREE_SESSION_ENTRY, { managed: false });
		}
		const sessionFile = replacement.getSessionFile();
		if (!sessionFile || !existsSync(sessionFile)) throw new Error("Pi did not create the replacement session file");
		return { sessionId: replacement.getSessionId(), sessionFile };
	} finally {
		if (temporaryBranchFile) {
			try { unlinkSync(temporaryBranchFile); } catch { /* best-effort cleanup */ }
		}
	}
}

export type WorktreeCommandResult = {
	cancelled: boolean;
	sessionId?: string;
	path?: string;
	branch?: string;
};

type WorktreeCommandDependencies = {
	createWorktree?: typeof createWebWorktree;
	inspectExisting?: typeof inspectExistingWorktree;
	readCurrentRef?: typeof currentWorktreeRef;
	createReplacement?: typeof createReplacementSession;
};

async function runWorktreeCommandUnlocked(
	args: string,
	ctx: ExtensionCommandContext,
	dependencies: WorktreeCommandDependencies,
	continuation?: string,
): Promise<WorktreeCommandResult> {
	const createWorktree = dependencies.createWorktree ?? createWebWorktree;
	const inspectExisting = dependencies.inspectExisting ?? inspectExistingWorktree;
	const readCurrentRef = dependencies.readCurrentRef ?? currentWorktreeRef;
	const createReplacement = dependencies.createReplacement ?? createReplacementSession;
	await ctx.waitForIdle();
	const input = await collectArguments(args, ctx);
	if (!input) return { cancelled: true };

	const previousSessionId = ctx.sessionManager.getSessionId();
	const previousSessionFile = ctx.sessionManager.getSessionFile();
	if (!previousSessionFile || !existsSync(previousSessionFile)) {
		throw new Error("The current conversation is not persisted yet. Wait for the first assistant response, then retry /worktree.");
	}

	let target: WorktreeTarget;
	try {
		if (input.mode === "existing") {
			const existing: ExistingWebWorktree = inspectExisting(ctx.cwd, input.path);
			target = { path: existing.path, repoRoot: existing.repoRoot, ref: existing.ref };
		} else {
			const created = await createWorktree(input.repository, input.name);
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

	let replacement: { sessionId: string; sessionFile: string };
	try {
		replacement = createReplacement(ctx, target, previousSessionFile);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(target.managed ? `${message}; initialized worktree retained at ${target.path} for inspection` : message);
	}

	if (process.env.PI_WEB_MANAGED !== "1") {
		replacements().set(replacement.sessionId, {
			previousSessionId,
			previousSessionFile,
			worktreePath: target.path,
		});
	}

	let switched = false;
	try {
		let verifiedSessionId: string | undefined;
		const result = await ctx.switchSession(replacement.sessionFile, {
			withSession: async (next) => {
				switched = true;
				const actualCwd = realpathSync(next.cwd);
				const rollback = async (message: string) => {
					replacements().delete(replacement.sessionId);
					next.ui.notify(`${message} Returning to the original session.`, "error");
					await next.switchSession(previousSessionFile);
				};
				if (actualCwd !== target.path) {
					await rollback(`Replacement session opened in ${actualCwd}, not ${target.path}.`);
					return;
				}
				let actualRef: WorktreeRef;
				try {
					actualRef = readCurrentRef(actualCwd);
				} catch (error) {
					await rollback(`Worktree ref verification failed: ${error instanceof Error ? error.message : String(error)}.`);
					return;
				}
				if (actualRef.kind !== target.ref.kind || actualRef.value !== target.ref.value) {
					await rollback(`Worktree ref verification failed. Expected ${target.ref.kind} ${target.ref.value}, found ${actualRef.kind} ${actualRef.value}.`);
					return;
				}
				verifiedSessionId = next.sessionManager.getSessionId();
				const refLabel = target.ref.kind === "branch" ? target.ref.value : `detached ${target.ref.value}`;
				// Preserve the source session: another Pi runtime may still have it open.
				// The replacement records it as parent, so users can remove it explicitly.
				next.ui.notify(`Switched this conversation to ${target.path} (${refLabel}).`, "info");
				if (continuation) await next.sendUserMessage(continuation);
			},
		});
		if (result.cancelled || !verifiedSessionId) {
			replacements().delete(replacement.sessionId);
			return { cancelled: true };
		}
		return {
			cancelled: false,
			sessionId: verifiedSessionId,
			path: target.path,
			branch: target.ref.kind === "branch" ? target.ref.value : undefined,
		};
	} catch (error) {
		replacements().delete(replacement.sessionId);
		if (switched) throw new Error(`${error instanceof Error ? error.message : String(error)}; Pi switched sessions before reporting the failure`);
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
	return await withWorktreeOperation(
		sourceSessionId,
		() => runWorktreeCommandUnlocked(args, ctx, dependencies, continuation),
	);
}

export default function worktreeExtension(pi: ExtensionAPI): void {
	installWorktreeCommandDispatchCompatibility();

	pi.registerTool({
		name: "worktree",
		label: "Worktree",
		description: "Create a managed Git worktree or enter an existing registered worktree, replace this Pi session, and automatically continue the task there. Use this instead of running git worktree directly.",
		promptSnippet: "Create or enter a Git worktree, move this conversation there, and automatically resume the task",
		promptGuidelines: [
			"Use the worktree tool whenever the user asks to create, enter, or switch to a worktree; do not run git worktree directly or ask the user to type /worktree.",
			"Call the worktree tool as the final tool for the current run and provide a self-contained continuation prompt for the replacement session.",
		],
		parameters: WorktreeToolParameters,
		async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
			const request = queueWorktreeToolRequest({
				sessionId: ctx.sessionManager.getSessionId(),
				input,
				sendUserMessage: (message, options) => pi.sendUserMessage(message, options),
			});
			return {
				content: [{ type: "text", text: "Queued the worktree session switch. This agent run will stop, and the task will resume automatically after the replacement is verified." }],
				details: { token: request.token, commandArgs: request.commandArgs },
				terminate: true,
			};
		},
	});

	pi.registerCommand("worktree", {
		description: "Create or enter a repository worktree and move this conversation into it",
		handler: async (args, ctx) => {
			const token = internalToolRequestToken(args);
			const request = token ? takeWorktreeToolRequest(token, ctx.sessionManager.getSessionId()) : undefined;
			const result = await runWorktreeCommand(request?.commandArgs ?? args, ctx, {}, request?.continuation);
			if (process.env.PI_WEB_MANAGED === "1" && result.cancelled) throw new Error("Worktree switch cancelled");
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
