import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import autoRouter from "../extensions/auto-router.ts";
import type { AutoRouterSettings } from "../extensions/auto-router-settings.ts";

const ENV_VAR = "PI_CODING_AGENT_DIR";
let previousEnv: string | undefined;
let agentDir: string | undefined;

beforeEach(async () => {
  previousEnv = process.env[ENV_VAR];
  agentDir = await mkdtemp(join(tmpdir(), "pi-kit-auto-router-agent-"));
  process.env[ENV_VAR] = agentDir;
});

afterEach(async () => {
  if (previousEnv === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = previousEnv;
  if (agentDir) await rm(agentDir, { recursive: true, force: true });
  agentDir = undefined;
});

async function writeConfig(settings: AutoRouterSettings): Promise<void> {
  if (!agentDir) throw new Error("agentDir not set");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ autoRouter: settings }),
  );
}

function model(provider: string, id: string): Model<Api> {
  return { provider, id } as unknown as Model<Api>;
}

type FakeHandler = (event: unknown, ctx: unknown) => unknown;

type FakePi = {
  pi: ExtensionAPI;
  fire: (event: string, payload: unknown, ctx: unknown) => Promise<unknown>;
  runCommand: (name: string, args: string, ctx: unknown) => Promise<void>;
  setModelCalls: Model<Api>[];
  thinkingLevelCalls: string[];
  appendedEntries: Array<{ type: string; data: unknown }>;
};

function createFakePi(): FakePi {
  const handlers = new Map<string, FakeHandler>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const setModelCalls: Model<Api>[] = [];
  const thinkingLevelCalls: string[] = [];
  const appendedEntries: Array<{ type: string; data: unknown }> = [];

  const pi = {
    registerProvider: () => undefined,
    on: (event: string, handler: FakeHandler) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, options);
    },
    appendEntry: (type: string, data: unknown) => {
      appendedEntries.push({ type, data });
    },
    events: { emit: () => undefined, on: () => () => undefined },
    setModel: async (m: Model<Api>) => {
      setModelCalls.push(m);
      return true;
    },
    setThinkingLevel: async (level: string) => {
      thinkingLevelCalls.push(level);
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    fire: async (event, payload, ctx) => {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`no handler registered for ${event}`);
      return handler(payload, ctx);
    },
    runCommand: async (name, args, ctx) => {
      const command = commands.get(name);
      if (!command) throw new Error(`no command registered: ${name}`);
      await command.handler(args, ctx as ExtensionCommandContext);
    },
    setModelCalls,
    thinkingLevelCalls,
    appendedEntries,
  };
}

type FakeRegistryOptions = {
  models: Model<Api>[];
  unavailable?: Model<Api>[];
  classify?: (prompt: string) => string;
};

function fakeModelRegistry({ models, unavailable = [], classify }: FakeRegistryOptions) {
  const unavailableKeys = new Set(unavailable.map((m) => `${m.provider}/${m.id}`));
  return {
    find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: (m: Model<Api>) => !unavailableKeys.has(`${m.provider}/${m.id}`),
    getApiKeyForProvider: async () => undefined,
    complete: async (_model: Model<Api>, context: { messages: Array<{ content: Array<{ text?: string }> }> }) => {
      const prompt = context.messages[0]?.content?.[0]?.text ?? "";
      const level = classify ? classify(prompt) : "medium";
      return { content: [{ type: "text", text: level }], usage: undefined };
    },
  };
}

function fakeCtx(options: {
  modelRegistry: ReturnType<typeof fakeModelRegistry>;
  model?: Model<Api>;
  thinkingLevel?: string;
  entries?: unknown[];
}) {
  const notifications: Array<{ message: string; type?: string }> = [];
  const statuses = new Map<string, string | undefined>();
  return {
    hasUI: true,
    mode: "rpc",
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    modelRegistry: options.modelRegistry,
    sessionManager: {
      getSessionId: () => "session-1",
      getEntries: () => options.entries ?? [],
    },
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
      setStatus: (_key: string, text: string | undefined) => statuses.set(_key, text),
      custom: async () => undefined,
    },
    notifications,
    statuses,
  } as unknown as ExtensionContext & { notifications: typeof notifications; statuses: typeof statuses };
}

test("selecting Auto immediately routes to the first available medium-tier model", async () => {
  const a = model("prov", "model-a");
  const b = model("prov", "model-b");
  await writeConfig({ efforts: { medium: { models: [{ provider: "prov", id: "model-a" }, { provider: "prov", id: "model-b" }] } } });

  const fake = createFakePi();
  autoRouter(fake.pi);
  const ctx = fakeCtx({ modelRegistry: fakeModelRegistry({ models: [a, b] }) });

  await fake.fire("session_start", {}, ctx);
  await fake.fire(
    "model_select",
    { model: { provider: "auto", id: "auto" }, previousModel: undefined, source: "set" },
    ctx,
  );

  expect(fake.setModelCalls).toEqual([a]);
  expect(fake.thinkingLevelCalls).toEqual(["medium"]);
});

test("before_agent_start classifies the turn and routes to the matching tier", async () => {
  const medium = model("prov", "medium-model");
  const high = model("prov", "high-model");
  await writeConfig({
    efforts: {
      medium: { models: [{ provider: "prov", id: "medium-model" }] },
      high: { models: [{ provider: "prov", id: "high-model" }] },
    },
  });

  const fake = createFakePi();
  autoRouter(fake.pi);
  const registry = fakeModelRegistry({
    models: [medium, high],
    classify: (prompt) => (prompt.includes("refactor") ? "high" : "medium"),
  });
  const ctx = fakeCtx({ modelRegistry: registry });

  await fake.fire("session_start", {}, ctx);
  await fake.fire("model_select", { model: { provider: "auto", id: "auto" }, previousModel: undefined, source: "set" }, ctx);
  fake.setModelCalls.length = 0;
  fake.thinkingLevelCalls.length = 0;

  await fake.fire("before_agent_start", { prompt: "please refactor this multi-file module" }, ctx);

  expect(fake.setModelCalls).toEqual([high]);
  expect(fake.thinkingLevelCalls).toEqual(["high"]);
});

test("routing escalates to a higher tier when the classified tier is entirely unhealthy", async () => {
  const c = model("prov", "high-model");
  const d = model("prov", "xhigh-model");
  const medium = model("prov", "medium-model");
  await writeConfig({
    efforts: {
      medium: { models: [{ provider: "prov", id: "medium-model" }] },
      high: { models: [{ provider: "prov", id: "high-model" }] },
      xhigh: { models: [{ provider: "prov", id: "xhigh-model" }] },
    },
  });

  const fake = createFakePi();
  autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [medium, c, d], classify: () => "high" });
  const ctx = fakeCtx({ modelRegistry: registry });

  await fake.fire("session_start", {}, ctx);
  await fake.fire("model_select", { model: { provider: "auto", id: "auto" }, previousModel: undefined, source: "set" }, ctx);
  fake.setModelCalls.length = 0;

  // First turn classifies "high" and routes to the high-tier model, making it current.
  await fake.fire("before_agent_start", { prompt: "anything" }, ctx);
  expect(fake.setModelCalls).toEqual([c]);

  // That model then takes a hard auth failure.
  await fake.fire("after_provider_response", { status: 401, headers: {} }, ctx);
  fake.setModelCalls.length = 0;
  fake.thinkingLevelCalls.length = 0;

  // Same classification again should now escalate past the unhealthy high tier.
  await fake.fire("before_agent_start", { prompt: "anything" }, ctx);

  expect(fake.setModelCalls).toEqual([d]);
  expect(fake.thinkingLevelCalls).toEqual(["xhigh"]);
});

test("routing falls back to the classified tier's model as a last resort when nothing anywhere is healthy, and warns", async () => {
  const only = model("prov", "only-model");
  await writeConfig({ efforts: { medium: { models: [{ provider: "prov", id: "only-model" }] } } });

  const fake = createFakePi();
  autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [only] });
  const ctx = fakeCtx({ modelRegistry: registry });

  await fake.fire("session_start", {}, ctx);
  await fake.fire("model_select", { model: { provider: "auto", id: "auto" }, previousModel: undefined, source: "set" }, ctx);
  fake.setModelCalls.length = 0;

  await fake.fire("after_provider_response", { status: 401, headers: {} }, ctx);
  await fake.fire("before_agent_start", { prompt: "anything" }, ctx);

  expect(fake.setModelCalls).toEqual([only]);
  expect(ctx.notifications.some((n) => n.type === "warning" && n.message.includes("unavailable"))).toBe(true);
});

test("a recorded failure fails over to the next configured model in the same tier", async () => {
  const a = model("prov", "model-a");
  const b = model("prov", "model-b");
  await writeConfig({
    efforts: {
      medium: {
        models: [
          { provider: "prov", id: "model-a" },
          { provider: "prov", id: "model-b" },
        ],
      },
    },
  });

  const fake = createFakePi();
  autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [a, b] });
  const ctx = fakeCtx({ modelRegistry: registry });

  await fake.fire("session_start", {}, ctx);
  await fake.fire("model_select", { model: { provider: "auto", id: "auto" }, previousModel: undefined, source: "set" }, ctx);
  expect(fake.setModelCalls).toEqual([a]);

  // model-a gets rate limited.
  await fake.fire("after_provider_response", { status: 429, headers: {} }, ctx);
  fake.setModelCalls.length = 0;

  await fake.fire("before_agent_start", { prompt: "anything" }, ctx);
  expect(fake.setModelCalls).toEqual([b]);
});

test("manually picking a real model while Auto is active turns Auto off", async () => {
  const a = model("prov", "model-a");
  const manual = model("prov", "manual-model");
  await writeConfig({ efforts: { medium: { models: [{ provider: "prov", id: "model-a" }] } } });

  const fake = createFakePi();
  autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [a, manual] });
  const ctx = fakeCtx({ modelRegistry: registry });

  await fake.fire("session_start", {}, ctx);
  await fake.fire("model_select", { model: { provider: "auto", id: "auto" }, previousModel: undefined, source: "set" }, ctx);
  await fake.fire("model_select", { model: manual, previousModel: a, source: "set" }, ctx);
  fake.setModelCalls.length = 0;

  await fake.fire("before_agent_start", { prompt: "anything" }, ctx);
  expect(fake.setModelCalls).toEqual([]);
});

test("/usage with no configured models notifies instead of throwing", async () => {
  const fake = createFakePi();
  autoRouter(fake.pi);
  const ctx = fakeCtx({ modelRegistry: fakeModelRegistry({ models: [] }) });

  await fake.runCommand("usage", "", ctx);
  expect(ctx.notifications.some((n) => n.message.includes("no configured models"))).toBe(true);
});

test("session_start restores an active Auto session without re-routing", async () => {
  const already = model("prov", "already-selected");
  await writeConfig({ efforts: { medium: { models: [{ provider: "prov", id: "already-selected" }] } } });

  const fake = createFakePi();
  autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [already] });
  const ctx = fakeCtx({
    modelRegistry: registry,
    model: already,
    thinkingLevel: "medium",
    entries: [{ type: "custom", customType: "vessup:auto-router:active", data: { enabled: true } }],
  });

  await fake.fire("session_start", {}, ctx);

  expect(fake.setModelCalls).toEqual([]);
  expect(ctx.statuses.get("auto-router")).toContain("already-selected");
});
