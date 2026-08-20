import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SubagentManager } from "../extensions/subagents/manager.ts";
import {
  stringifyCompact,
  subagentFooterSummary,
  truncateChars,
  truncateToolOutput,
} from "../extensions/subagents/format.ts";
import { MAX_TOOL_OUTPUT_BYTES } from "../extensions/subagents/types.ts";
import {
  AgentDetailDialog,
  FooterNavigationEditor,
} from "../extensions/subagents/ui.ts";
import subagentsExtension, {
  abortRunningSubagentSessions,
  countsAgainstSubagentLimit,
  filterModelsToScope,
  inheritedSubagentModel,
  isFailedStopReason,
  isTerminalSubagentStatus,
  parsePersistedUsageState,
  shouldArchiveTerminalSubagent,
  subagentModelGuidance,
  subagentModelRuntime,
} from "../extensions/subagents.ts";
import type { ManagedSubagent } from "../extensions/subagents/types.ts";
test("subagent entrypoint preserves its tool, command, and lifecycle registrations", () => {
  const tools: string[] = [];
  const commands: string[] = [];
  const hooks: string[] = [];
  const events: string[] = [];
  const pi = {
    events: {
      on(name: string) {
        events.push(name);
      },
      emit() {},
    },
    on(name: string) {
      hooks.push(name);
    },
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    getActiveTools() {
      return [];
    },
  };

  subagentsExtension(pi as never);

  assert.deepEqual(tools, [
    "subagent_create",
    "subagent_read",
    "subagent_send",
    "subagent_configure",
    "subagent_terminate",
  ]);
  assert.deepEqual(commands, ["subagents", "subagents-cleanup"]);
  assert.deepEqual(hooks, [
    "before_agent_start",
    "session_start",
    "input",
    "agent_start",
    "agent_settled",
    "session_shutdown",
  ]);
  assert.deepEqual(events, ["vessup:subagents:abort"]);
});

const usage = {
  input: 10,
  output: 4,
  cacheRead: 3,
  cacheWrite: 2,
  totalTokens: 19,
  cost: {
    input: 0.1,
    output: 0.2,
    cacheRead: 0.01,
    cacheWrite: 0.02,
    total: 0.33,
  },
};

function makeManagedAgent(
  override: Partial<ManagedSubagent> = {},
): ManagedSubagent {
  const now = Date.now();
  return {
    id: "worker",
    prompt: "task",
    cwd: "/tmp",
    createdAt: now - 1_000,
    updatedAt: now,
    status: "completed",
    model: "provider/model",
    effort: "medium",
    turns: 1,
    queuedSteering: 0,
    queuedFollowUp: 0,
    activity: [{ timestamp: now - 10, text: "assistant finished" }],
    lastReadActivity: 0,
    transcript: [
      {
        timestamp: now - 5,
        role: "assistant",
        text: "Subagent summary of work completed.",
      },
    ],
    streamingText: "",
    lastStreamActivityAt: 0,
    usage: usage,
    waiters: new Set(),
    ...override,
  };
}

test("compact formatting handles non-JSON values and preserves Unicode code points", () => {
  assert.equal(stringifyCompact(undefined), "undefined");
  assert.equal(stringifyCompact(Symbol("value")), "Symbol(value)");
  assert.equal(stringifyCompact("🙂", 2), '"🙂…');
  assert.equal(truncateChars("a🙂b", 2), "a🙂\n[… 1 characters omitted]");
});

test("subagent footer summary uses the modal status icon state", () => {
  assert.deepEqual(subagentFooterSummary([]), undefined);
  assert.deepEqual(subagentFooterSummary(["completed"]), {
    text: "1 subagent • 1 done",
    status: "completed",
  });
  assert.deepEqual(
    subagentFooterSummary(["working", "completed", "terminated"]),
    {
      text: "3 subagents • 1 working • 1 done • 1 stopped",
      status: "working",
    },
  );
  assert.deepEqual(
    subagentFooterSummary(["working", "completed", "failed"]),
    {
      text: "3 subagents • 1 working • 1 done • 1 failed",
      status: "failed",
    },
  );
});

test("subagent tool output truncates at a valid UTF-8 byte boundary", () => {
  const source = `a${"🙂".repeat(Math.ceil(MAX_TOOL_OUTPUT_BYTES / 4) + 10)}`;
  const result = truncateToolOutput(source);
  const output = result.split("\n\n[Output truncated:", 1)[0] ?? "";
  assert.ok(Buffer.byteLength(output, "utf8") <= MAX_TOOL_OUTPUT_BYTES);
  assert.equal(output.endsWith("�"), false);
  assert.match(
    result,
    new RegExp(
      `Output truncated: ${Buffer.byteLength(source, "utf8") - Buffer.byteLength(output, "utf8")} bytes omitted`,
    ),
  );
});

test("subagent footer editor preserves key-release preferences", () => {
  const base = { focused: false, wantsKeyRelease: true };
  const editor = new FooterNavigationEditor(
    base as never,
    {} as never,
    {} as never,
    () => {},
  );
  assert.equal(editor.wantsKeyRelease, true);
  editor.wantsKeyRelease = false;
  assert.equal(base.wantsKeyRelease, false);
});

test("subagent detail rendering caches wrapped transcript lines", () => {
  let contentFormats = 0;
  const agent = {
    id: "worker",
    status: "completed",
    model: "provider/model",
    effort: "medium",
    createdAt: Date.now(),
    prompt: "task",
    usage,
    transcript: [{ timestamp: Date.now(), role: "assistant", text: "hello" }],
    streamingText: "",
  };
  const theme = {
    fg(_color: string, text: string) {
      if (text === "hello") contentFormats++;
      return text;
    },
  };
  const dialog = new AgentDetailDialog(
    agent as never,
    { requestRender() {} } as never,
    theme as never,
    {} as never,
    () => {},
  );
  try {
    dialog.render(80);
    dialog.render(80);
    assert.equal(contentFormats, 1);
    agent.streamingText = "streaming";
    dialog.render(80);
    assert.equal(contentFormats, 2);
    dialog.render(79);
    assert.equal(contentFormats, 3);
    agent.transcript.push({
      timestamp: Date.now(),
      role: "assistant",
      text: "next",
    });
    dialog.render(79);
    assert.equal(contentFormats, 4);
  } finally {
    dialog.dispose();
  }
});

test("creating agents reserve capacity before their session exists", () => {
  assert.equal(countsAgainstSubagentLimit({ status: "creating" }), true);
  assert.equal(
    countsAgainstSubagentLimit({ status: "completed", session: {} }),
    true,
  );
  assert.equal(countsAgainstSubagentLimit({ status: "failed" }), false);
  assert.equal(countsAgainstSubagentLimit({ status: "terminated" }), false);
});

test("aborting the main run aborts every running subagent and leaves completed agents alone", async () => {
  const aborted: string[] = [];
  const agents = [
    {
      status: "working" as const,
      session: {
        async abort() {
          aborted.push("working");
        },
      },
    },
    {
      status: "creating" as const,
      session: {
        async abort() {
          aborted.push("creating");
        },
      },
    },
    {
      status: "completed" as const,
      session: {
        async abort() {
          aborted.push("completed");
        },
      },
    },
    { status: "failed" as const },
  ];
  const results = await abortRunningSubagentSessions(agents);
  assert.deepEqual(aborted.sort(), ["creating", "working"]);
  assert.equal(results.length, 2);
  assert.equal(
    results.every((result) => result.error === undefined),
    true,
  );
});

test("terminal provider errors are classified as failures", () => {
  assert.equal(isFailedStopReason("error"), true);
  assert.equal(isFailedStopReason("aborted"), true);
  assert.equal(isFailedStopReason("stop"), false);
  assert.equal(isFailedStopReason(undefined), false);
});

test("terminal cleanup classification preserves live subagents and archives unread output", () => {
  assert.equal(isTerminalSubagentStatus("completed"), true);
  assert.equal(isTerminalSubagentStatus("failed"), true);
  assert.equal(isTerminalSubagentStatus("terminated"), true);
  assert.equal(isTerminalSubagentStatus("creating"), false);
  assert.equal(isTerminalSubagentStatus("working"), false);
  assert.equal(isTerminalSubagentStatus("terminating"), false);
  assert.equal(
    shouldArchiveTerminalSubagent({
      status: "completed",
      lastReadActivity: 1,
      activity: [{}, {}],
    }),
    true,
  );
  assert.equal(
    shouldArchiveTerminalSubagent({
      status: "failed",
      lastReadActivity: 2,
      activity: [{}, {}],
    }),
    false,
  );
  assert.equal(
    shouldArchiveTerminalSubagent({
      status: "working",
      lastReadActivity: 0,
      activity: [{}],
    }),
    false,
  );
});

test("available subagent models honor a configured scope", () => {
  const available = [
    { provider: "openai", id: "large" },
    { provider: "openai", id: "small" },
    { provider: "anthropic", id: "large" },
  ];
  assert.deepEqual(
    filterModelsToScope(available, [
      { model: { provider: "openai", id: "small" } },
    ]),
    [{ provider: "openai", id: "small" }],
  );
  assert.equal(filterModelsToScope(available, []), available);
  assert.deepEqual(
    inheritedSubagentModel(available[0], undefined),
    { provider: "openai", id: "large" },
    "omitted model inherits the host model even when an explicit-override scope excludes it",
  );
});

test("inherited subagents reuse headers-only temporary host authentication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-kit-subagent-auth-"));
  const previousAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const previousGatewayId = process.env.CLOUDFLARE_GATEWAY_ID;
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  process.env.CLOUDFLARE_GATEWAY_ID = "test-gateway";
  try {
    const hostRuntime = await ModelRuntime.create({
      authPath: join(directory, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    await hostRuntime.setRuntimeApiKey(
      "cloudflare-ai-gateway",
      "session-only-key",
    );
    assert.deepEqual(
      hostRuntime.getProviderAuthStatus("cloudflare-ai-gateway"),
      {
        configured: true,
        source: "runtime",
      },
    );

    const inheritedRuntime = subagentModelRuntime(
      new ModelRegistry(hostRuntime),
    );
    assert.equal(
      inheritedRuntime,
      hostRuntime,
      "host and child share credential refresh state",
    );
    const resolved = await inheritedRuntime.getAuth("cloudflare-ai-gateway");
    assert.ok(resolved);
    assert.equal(resolved.auth.apiKey, undefined);
    assert.equal(
      resolved.auth.headers?.["cf-aig-authorization"],
      "Bearer session-only-key",
    );
    assert.deepEqual(resolved.env, {
      CLOUDFLARE_ACCOUNT_ID: "test-account",
      CLOUDFLARE_GATEWAY_ID: "test-gateway",
    });
  } finally {
    if (previousAccountId === undefined)
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = previousAccountId;
    if (previousGatewayId === undefined)
      delete process.env.CLOUDFLARE_GATEWAY_ID;
    else process.env.CLOUDFLARE_GATEWAY_ID = previousGatewayId;
    await rm(directory, { recursive: true, force: true });
  }
});

test("subagent model guidance exposes exact choices and inheritance", () => {
  const guidance = subagentModelGuidance(
    { provider: "openai-codex", id: "gpt-5.6-sol" },
    [
      { provider: "openai-codex", id: "gpt-5.6-luna" },
      { provider: "openai-codex", id: "gpt-5.6-sol" },
      { provider: "openai-codex", id: "gpt-5.6-sol" },
    ],
  );
  assert.match(
    guidance,
    /inherits openai-codex\/gpt-5\.6-sol when model is omitted/,
  );
  assert.match(
    guidance,
    /openai-codex\/gpt-5\.6-luna, openai-codex\/gpt-5\.6-sol/,
  );
  assert.doesNotMatch(guidance, /gpt-5\.6-sol, openai-codex\/gpt-5\.6-sol/);
  assert.match(guidance, /Never shorten, generalize, or invent a model ID/);
});

test("subagent read returns a concise completion summary and auto-releases terminal agents", async () => {
  const manager = new SubagentManager({
    events: { emit() {} },
  } as never);
  const agent = makeManagedAgent();

  (manager as { agents: Map<string, ManagedSubagent> }).agents.set(
    agent.id,
    agent,
  );

  const output = await manager.read([agent], false);

  assert.ok(output.includes("Completion summary:"));
  assert.equal(output.includes("Activity since last read:"), false);
  assert.equal(manager.list().length, 0);
});

test("subagent read includes transcript only when requested", async () => {
  const manager = new SubagentManager({
    events: { emit() {} },
  } as never);
  const withTranscript = makeManagedAgent({ id: "detailed" });

  (manager as { agents: Map<string, ManagedSubagent> }).agents.set(
    withTranscript.id,
    withTranscript,
  );

  const without = await manager.read([withTranscript], false);
  assert.equal(without.includes("Transcript:"), false);

  // Re-insert a completed agent for the detailed-read assertion.
  (manager as { agents: Map<string, ManagedSubagent> }).agents.set(
    withTranscript.id,
    {
      ...withTranscript,
      lastReadActivity: 0,
      status: "completed",
      waiters: new Set(),
    },
  );

  const withTranscriptOutput = await manager.read([withTranscript], true);
  assert.ok(withTranscriptOutput.includes("Transcript:"));
  assert.ok(withTranscriptOutput.includes(withTranscript.transcript[0]?.text));
});

test("persisted usage checkpoints reject malformed data", () => {
  assert.deepEqual(
    parsePersistedUsageState({ total: usage, accounted: usage }),
    {
      total: usage,
      accounted: usage,
    },
  );
  assert.equal(
    parsePersistedUsageState({
      total: usage,
      accounted: { ...usage, output: "4" },
    }),
    undefined,
  );
  assert.equal(parsePersistedUsageState(null), undefined);
});
