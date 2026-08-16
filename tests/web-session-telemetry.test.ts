import { expect, test } from "bun:test";
import {
  preserveSessionsTelemetry,
  preserveSessionTelemetry,
} from "../web/client/session-telemetry.ts";
import {
  mergeWebSubagentUpdates,
  type WebSession,
  type WebSubagentUpdate,
  type WebUsage,
} from "../web/protocol.ts";

const usage = (input: number): WebUsage => ({
  input,
  output: input / 2,
  cacheRead: input * 2,
  cacheWrite: 0,
  totalTokens: input * 3.5,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, total: 6 },
});

const session = (id: string, input?: number): WebSession => ({
  id,
  cwd: "/tmp",
  status: "idle",
  source: "web",
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0,
  usage: input === undefined ? undefined : usage(input),
});

test("session telemetry survives partial and transient zero-valued snapshots", () => {
  const previous = {
    ...session("one", 100),
    contextUsage: { tokens: 25, contextWindow: 1_000, percent: 2.5 },
  };
  const partial = { ...session("one", 0), status: "working" as const };
  const merged = preserveSessionTelemetry(previous, partial);
  expect(merged.status).toBe("working");
  expect(merged.usage).toEqual(previous.usage);
  expect(merged.contextUsage).toEqual(previous.contextUsage);
});

test("an explicit empty subagent snapshot clears stale managed-runtime telemetry", () => {
  const previous = {
    ...session("one", 100),
    subagents: [
      {
        id: "old-worker",
        status: "working" as const,
        model: "test/model",
        effort: "high",
        turns: 1,
        queued: 0,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  };
  expect(
    preserveSessionTelemetry(previous, {
      ...session("one", 100),
      subagents: [],
    }).subagents,
  ).toEqual([]);
  expect(
    preserveSessionTelemetry(previous, {
      ...session("one", 100),
      status: "offline",
      source: "saved",
    }).subagents,
  ).toEqual([]);
});

test("new authoritative telemetry replaces the preserved snapshot per session", () => {
  const previous = [session("one", 100), session("two", 200)];
  const next = preserveSessionsTelemetry(previous, [
    session("one", 300),
    session("two"),
  ]);
  expect(next[0]?.usage?.input).toBe(300);
  expect(next[1]?.usage?.input).toBe(200);
});

test("subagent transcript and streaming deltas merge without retransmitting prior content", () => {
  const base: WebSubagentUpdate = {
    id: "worker",
    status: "working",
    model: "test/model",
    effort: "high",
    turns: 1,
    currentTool: null,
    queued: 0,
    createdAt: 1,
    updatedAt: 2,
    completedAt: null,
    error: null,
    usage: usage(1),
    transcriptReset: true,
    transcriptDelta: [{ timestamp: 1, role: "user", text: "first" }],
    streamingTextReset: true,
    streamingTextDelta: "hel",
  };
  const initial = mergeWebSubagentUpdates(undefined, [base]);
  const updated = mergeWebSubagentUpdates(initial, [
    {
      ...base,
      updatedAt: 3,
      transcriptReset: false,
      transcriptDelta: [{ timestamp: 2, role: "assistant", text: "done" }],
      streamingTextReset: false,
      streamingTextDelta: "lo",
    },
  ]);
  expect(updated[0]?.transcript?.map((item) => item.text)).toEqual([
    "first",
    "done",
  ]);
  expect(updated[0]?.streamingText).toBe("hello");

  const reset = mergeWebSubagentUpdates(updated, [
    {
      ...base,
      updatedAt: 4,
      transcriptReset: true,
      transcriptDelta: [
        { timestamp: 3, role: "assistant", text: "retained tail" },
      ],
      streamingTextReset: true,
      streamingTextDelta: "",
    },
  ]);
  expect(reset[0]?.transcript?.map((item) => item.text)).toEqual([
    "retained tail",
  ]);
  expect(reset[0]?.streamingText).toBeUndefined();
  expect(mergeWebSubagentUpdates(reset, [])).toEqual([]);
});
