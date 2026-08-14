import { beforeEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import worktreeExtension, {
	clearWorktreeToolRequests,
	inheritedWorktreeOwnership,
	installWorktreeCommandDispatchCompatibility,
	queueWorktreeToolRequest,
	runWorktreeCommand,
	takeWorktreeToolRequest,
	withWorktreeOperation,
} from "../extensions/worktree.ts";
import { WORKTREE_SESSION_ENTRY } from "../web/server/worktrees.ts";
import { parseWorktreeCommandArgs, parseWorktreeInvocation } from "../web/worktree-command.ts";

beforeEach(() => clearWorktreeToolRequests());

function registeredWorktreeTool() {
	let tool: {
		name: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		execute: (...args: any[]) => Promise<any>;
	} | undefined;
	const sent: Array<{ message: string; options: unknown }> = [];
	worktreeExtension({
		registerTool: (definition: unknown) => { tool = definition as typeof tool; },
		registerCommand: () => undefined,
		on: () => undefined,
		sendUserMessage: (message: string, options: unknown) => { sent.push({ message, options }); },
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
		extensionFactories: [{
			name: "worktree-dispatch-test",
			factory: (pi) => {
				api = pi;
				installWorktreeCommandDispatchCompatibility();
				pi.registerCommand("worktree", {
					handler: async (args) => { dispatchedArgs = args; },
				});
			},
		}],
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
		api.sendUserMessage("/worktree --tool-request eeeeeeee-eeee-eeee-eeee", { deliverAs: "followUp" });
		for (let index = 0; index < 50 && dispatchedArgs === undefined; index += 1) await Bun.sleep(10);
		expect(dispatchedArgs).toBe("--tool-request eeeeeeee-eeee-eeee-eeee");
	} finally {
		session.dispose();
	}
});

test("worktree tool queues a correlated create command and terminates the old run", async () => {
	const { tool, sent } = registeredWorktreeTool();
	expect(tool.name).toBe("worktree");
	expect(tool.promptSnippet).toContain("move this conversation");
	expect(tool.promptGuidelines?.join(" ")).toContain("do not run git worktree directly");
	const result = await tool.execute("call-1", {
		name: "feature one",
		repository: "~/Source/my repo",
		continuation: "Resume implementing the requested feature.",
	}, undefined, undefined, {
		sessionManager: { getSessionId: () => "source-session" },
	});
	expect(result.terminate).toBe(true);
	expect(sent).toHaveLength(1);
	expect(sent[0]?.options).toEqual({ deliverAs: "followUp" });
	expect(sent[0]?.message).toMatch(/^\/worktree --tool-request [0-9a-f-]+$/);
	const token = sent[0]!.message.split(" ").at(-1)!;
	expect(takeWorktreeToolRequest(token, "source-session")).toMatchObject({
		commandArgs: '"feature one" --repo "~/Source/my repo"',
		continuation: "Resume implementing the requested feature.",
	});
});

test("worktree tool queues the existing-worktree form without shell interpolation", async () => {
	const { tool, sent } = registeredWorktreeTool();
	await tool.execute("call-2", {
		existing: '@../linked checkout; echo "unsafe"',
		continuation: "Continue in the existing checkout.",
	}, undefined, undefined, {
		sessionManager: { getSessionId: () => "source-session" },
	});
	const token = sent[0]!.message.split(" ").at(-1)!;
	expect(takeWorktreeToolRequest(token, "source-session").commandArgs).toBe('--existing "../linked checkout; echo \\"unsafe\\""');
});

test("worktree tool correlation is session-bound, concurrent, and cleaned on failure", () => {
	const sent: string[] = [];
	const first = queueWorktreeToolRequest({
		sessionId: "session-a",
		input: { name: "one", continuation: "one next" },
		token: "aaaaaaaa-aaaa-aaaa-aaaa",
		now: 100,
		sendUserMessage: (message) => { sent.push(message); },
	});
	const second = queueWorktreeToolRequest({
		sessionId: "session-a",
		input: { existing: "/repo/two", continuation: "two next" },
		token: "bbbbbbbb-bbbb-bbbb-bbbb",
		now: 101,
		sendUserMessage: (message) => { sent.push(message); },
	});
	expect(sent).toEqual([
		"/worktree --tool-request aaaaaaaa-aaaa-aaaa-aaaa",
		"/worktree --tool-request bbbbbbbb-bbbb-bbbb-bbbb",
	]);
	expect(() => takeWorktreeToolRequest(first.token, "session-b", 102)).toThrow("different session");
	expect(takeWorktreeToolRequest(second.token, "session-a", 102).continuation).toBe("two next");
	expect(takeWorktreeToolRequest(first.token, "session-a", 102).continuation).toBe("one next");

	expect(() => queueWorktreeToolRequest({
		sessionId: "session-a",
		input: { name: "failed", continuation: "never" },
		token: "cccccccc-cccc-cccc-cccc",
		sendUserMessage: () => { throw new Error("queue failed"); },
	})).toThrow("queue failed");
	expect(() => takeWorktreeToolRequest("cccccccc-cccc-cccc-cccc", "session-a")).toThrow("missing or expired");

	queueWorktreeToolRequest({
		sessionId: "session-a",
		input: { name: "cleanup", continuation: "never" },
		token: "dddddddd-dddd-dddd-dddd",
		sendUserMessage: () => undefined,
	});
	clearWorktreeToolRequests("session-a");
	expect(() => takeWorktreeToolRequest("dddddddd-dddd-dddd-dddd", "session-a")).toThrow("missing or expired");
});

test("worktree replacement is single-flight per source session", async () => {
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	const first = withWorktreeOperation("source-session", async () => {
		await blocked;
		return "done";
	});
	await expect(withWorktreeOperation("source-session", async () => "wrong")).rejects.toThrow("already in progress");
	expect(await withWorktreeOperation("other-session", async () => "other")).toBe("other");
	release();
	expect(await first).toBe("done");
	expect(await withWorktreeOperation("source-session", async () => "again")).toBe("again");
});

test("worktree command parses safe quoted repository arguments", () => {
	expect(parseWorktreeCommandArgs('feature-one --repo "~/Source/my repo"')).toEqual({
		name: "feature-one",
		repository: "~/Source/my repo",
	});
	expect(parseWorktreeCommandArgs("feature-two -C /tmp/repo")).toEqual({
		name: "feature-two",
		repository: "/tmp/repo",
	});
});

test("worktree command parses existing checkout paths exclusively", () => {
	expect(parseWorktreeCommandArgs('--existing "../repo worktree"')).toEqual({
		existing: "../repo worktree",
	});
	expect(parseWorktreeCommandArgs("--existing=/tmp/repo-worktree")).toEqual({
		existing: "/tmp/repo-worktree",
	});
	expect(() => parseWorktreeCommandArgs("--existing")).toThrow("requires a worktree path");
	expect(() => parseWorktreeCommandArgs("feature --existing /tmp/worktree")).toThrow("Usage");
	expect(() => parseWorktreeCommandArgs("--existing /tmp/worktree --repo /tmp/repo")).toThrow("Usage");
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
		writeFileSync(sourceFile, `${JSON.stringify({ type: "session", version: 3, id: source.getSessionId(), timestamp: new Date().toISOString(), cwd: sourceCwd })}\n`);
		source.setSessionFile(sourceFile);
		source.appendMessage({ role: "user", content: "retained", timestamp: Date.now() });
		let activeFile = sourceFile;
		let rollbackRequested = false;
		const notifications: string[] = [];
		const continuations: string[] = [];
		const ctx = {
			cwd: sourceCwd,
			hasUI: true,
			sessionManager: source,
			waitForIdle: async () => undefined,
			ui: {
				input: async () => undefined,
				notify: (message: string) => { notifications.push(message); },
			},
			switchSession: async (sessionPath: string, options?: { withSession?: (next: ExtensionCommandContext) => Promise<void> }) => {
				activeFile = sessionPath;
				const nextManager = SessionManager.open(sessionPath);
				await options?.withSession?.({
					...ctx,
					cwd: nextManager.getCwd(),
					sessionManager: nextManager,
					sendUserMessage: async (message: string) => { continuations.push(message); },
					switchSession: async (rollbackPath: string) => {
						rollbackRequested = true;
						activeFile = rollbackPath;
						return { cancelled: false };
					},
				} as ExtensionCommandContext);
				return { cancelled: false };
			},
		} as unknown as ExtensionCommandContext;
		const dependencies = {
			inspectExisting: () => ({ path: canonicalTargetCwd, repoRoot: sourceCwd, ref: { kind: "branch", value: "feature" } as const }),
			readCurrentRef: () => ({ kind: "branch", value: "feature" } as const),
			createReplacement: (_ctx: ExtensionCommandContext, target: { path: string }, previousFile: string) => {
				// Keep forked test sessions inside this fixture. Using the production default
				// writes them into ~/.pi/agent/sessions, where Pi Web discovers them later.
				const replacement = SessionManager.forkFrom(previousFile, target.path, join(directory, "sessions"));
				return { sessionId: replacement.getSessionId(), sessionFile: replacement.getSessionFile()! };
			},
		};
		const result = await runWorktreeCommand(`--existing ${JSON.stringify(targetCwd)}`, ctx, dependencies, "Resume in the verified replacement.");
		expect(result.cancelled).toBe(false);
		expect(SessionManager.open(activeFile).getCwd()).toBe(canonicalTargetCwd);
		expect(SessionManager.open(activeFile).getHeader().parentSession).toBe(sourceFile);
		expect(existsSync(sourceFile)).toBe(true);
		expect(rollbackRequested).toBe(false);
		expect(continuations).toEqual(["Resume in the verified replacement."]);

		dependencies.readCurrentRef = () => ({ kind: "branch", value: "changed" } as const);
		const rolledBack = await runWorktreeCommand(`--existing ${JSON.stringify(targetCwd)}`, ctx, dependencies, "Must not run after rollback.");
		expect(rolledBack.cancelled).toBe(true);
		expect(activeFile).toBe(sourceFile);
		expect(rollbackRequested).toBe(true);
		expect(notifications.at(-1)).toContain("Returning to the original session");
		expect(continuations).toEqual(["Resume in the verified replacement."]);
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
		const marker = { path: owned, repoRoot: directory, branch: "feature" };
		const entries = [{ type: "custom", customType: WORKTREE_SESSION_ENTRY, data: marker }];

		expect(inheritedWorktreeOwnership(entries, owned)).toEqual(marker);
		expect(inheritedWorktreeOwnership(entries, unrelated)).toBeUndefined();
		expect(inheritedWorktreeOwnership([
			...entries,
			{ type: "custom", customType: WORKTREE_SESSION_ENTRY, data: { managed: false } },
		], owned)).toBeUndefined();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("worktree invocation only matches the extension command", () => {
	expect(parseWorktreeInvocation('/worktree "feature one" --repo /tmp/repo')).toEqual({
		name: "feature one",
		repository: "/tmp/repo",
	});
	expect(parseWorktreeInvocation("please create a worktree")).toBeUndefined();
	expect(() => parseWorktreeCommandArgs("one two")).toThrow("Usage");
	expect(() => parseWorktreeCommandArgs("one --bad")).toThrow("Unknown");
});
