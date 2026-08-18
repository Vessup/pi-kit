import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import autoRouter, { escapeTableCell } from "../extensions/auto-router.ts";
import { SAVE_DEBOUNCE_MS } from "../extensions/auto-router-health.ts";
import type { AutoRouterSettings } from "../extensions/auto-router-settings.ts";

test("escapeTableCell neutralizes both pipes and line breaks, so one bad reply can't break the rest of the table", () => {
  expect(escapeTableCell("a | b")).toBe("a \\| b");
  expect(escapeTableCell("line one\nline two")).toBe("line one line two");
  expect(escapeTableCell("windows\r\nstyle")).toBe("windows style");
  expect(escapeTableCell("multi\n\n\nblank\nlines")).toBe("multi blank lines");
});

const ENV_VAR = "PI_CODING_AGENT_DIR";
let agentDir: string | undefined;
const usedDirs: string[] = [];

// The extension's internal AutoRouterHealthStore debounces its writes (~2s after the last
// record call), so a save scheduled by one test can fire well after that test's own teardown -
// if `afterEach` restored PI_CODING_AGENT_DIR to its prior (usually unset) value in the
// meantime, that late write would land in the real global agent directory instead of a test's
// temp one. So the env var is never restored to anything other than a temp dir for the whole
// run - only ever moved to a new one - and every temp dir used stays on disk until all tests
// finish, so even a very late write can only ever land somewhere harmless.
beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "pi-kit-auto-router-agent-"));
  usedDirs.push(agentDir);
  process.env[ENV_VAR] = agentDir;
});

afterAll(async () => {
  // The debounced save timer is unref'd, so it never blocks the process from exiting - but if
  // this suite's own run happens to keep the process alive past SAVE_DEBOUNCE_MS anyway (e.g.
  // a larger `bun test` invocation still running other files), a timer scheduled by one of this
  // file's last tests can still fire *after* this hook would otherwise have already deleted
  // PI_CODING_AGENT_DIR and removed its temp dir - at which point `statePath()` falls back to
  // the real default `~/.pi/agent`, and the save actually corrupts the developer's real global
  // auto-router-state.json with this suite's fixture data (verified: it happened). Waiting out
  // the debounce window here first, before touching the env var or any directory, guarantees
  // every such timer fires while it's still pointed at a real (about-to-be-removed) temp dir.
  await new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MS + 500));
  delete process.env[ENV_VAR];
  await Promise.all(usedDirs.map((dir) => rm(dir, { recursive: true, force: true })));
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

const AUTO_PLACEHOLDER = model("auto", "auto");

type FakeHandler = (event: unknown, ctx: unknown) => unknown;
type ModelRef = { value: Model<Api> | undefined };

type FakePi = {
  pi: ExtensionAPI;
  fire: (event: string, payload: unknown, ctx: unknown) => Promise<unknown>;
  runCommand: (name: string, args: string, ctx: unknown) => Promise<void>;
  setModelCalls: Model<Api>[];
  thinkingLevelCalls: string[];
  appendedEntries: Array<{ type: string; data: unknown }>;
  footerEvents: unknown[];
  currentModel: ModelRef;
};

function createFakePi(): FakePi {
  const handlers = new Map<string, FakeHandler>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const setModelCalls: Model<Api>[] = [];
  const thinkingLevelCalls: string[] = [];
  const appendedEntries: Array<{ type: string; data: unknown }> = [];
  const footerEvents: unknown[] = [];
  const currentModel: ModelRef = { value: undefined };

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
    events: { emit: (_event: string, value: unknown) => footerEvents.push(value), on: () => () => undefined },
    setModel: async (m: Model<Api>) => {
      setModelCalls.push(m);
      currentModel.value = m;
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
    footerEvents,
    currentModel,
  };
}

const FAKE_THEME = { fg: (_kind: string, text: string) => text } as unknown as Theme;

function lastFooterBadge(footerEvents: unknown[]): string | undefined {
  const last = footerEvents.at(-1) as { identitySuffix?: (theme: Theme) => string | undefined } | undefined;
  return last?.identitySuffix?.(FAKE_THEME);
}

type FakeRegistryOptions = {
  models: Model<Api>[];
  unavailable?: Model<Api>[];
  classify?: (prompt: string) => string;
};

function fakeModelRegistry({ models, unavailable = [], classify }: FakeRegistryOptions) {
  // Real Pi always has our registered "auto" placeholder findable, same as any other provider.
  const allModels = [...models, AUTO_PLACEHOLDER];
  const unavailableKeys = new Set(unavailable.map((m) => `${m.provider}/${m.id}`));
  return {
    find: (provider: string, id: string) =>
      // Real Pi also has every registered "auto-<tier>" pinned placeholder findable, the same
      // way it has the bare "auto" one - synthesize rather than requiring every test to list them.
      provider === "auto" && id.startsWith("auto-")
        ? model(provider, id)
        : allModels.find((m) => m.provider === provider && m.id === id),
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
  currentModel?: ModelRef;
  model?: Model<Api>;
  thinkingLevel?: string;
  entries?: unknown[];
}) {
  const notifications: Array<{ message: string; type?: string }> = [];
  const modelRef = options.currentModel ?? { value: options.model };
  return {
    hasUI: true,
    mode: "rpc",
    get model() {
      return modelRef.value;
    },
    thinkingLevel: options.thinkingLevel,
    modelRegistry: options.modelRegistry,
    sessionManager: {
      getSessionId: () => "session-1",
      getEntries: () => options.entries ?? [],
    },
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
      setStatus: () => undefined,
      custom: async () => undefined,
    },
    notifications,
  } as unknown as ExtensionContext & { notifications: typeof notifications };
}

function selectAuto(fake: FakePi, ctx: unknown): Promise<unknown> {
  return fake.fire("model_select", { model: { provider: "auto", id: "auto" }, previousModel: undefined, source: "set" }, ctx);
}

function pinnedPlaceholder(tier: string): Model<Api> {
  return model("auto", `auto-${tier}`);
}

function selectPinned(fake: FakePi, ctx: unknown, tier: string): Promise<unknown> {
  return fake.fire(
    "model_select",
    { model: { provider: "auto", id: `auto-${tier}` }, previousModel: undefined, source: "set" },
    ctx,
  );
}

test("selecting Auto marks it active without eagerly routing, showing the adaptive footer badge", async () => {
  const a = model("prov", "model-a");
  await writeConfig({ efforts: { medium: { models: [{ provider: "prov", id: "model-a" }] } } });

  const fake = createFakePi();
  await autoRouter(fake.pi);
  const ctx = fakeCtx({ modelRegistry: fakeModelRegistry({ models: [a] }), currentModel: fake.currentModel });

  await fake.fire("session_start", {}, ctx);
  await selectAuto(fake, ctx);

  expect(fake.setModelCalls).toEqual([]);
  expect(fake.thinkingLevelCalls).toEqual([]);
  expect(lastFooterBadge(fake.footerEvents)).toBe("🔀 Auto (auto)");
});

test("selecting a pinned Auto (<tier>) entry shows that tier in the footer immediately, before any turn runs", async () => {
  const a = model("prov", "model-a");
  await writeConfig({ efforts: { high: { models: [{ provider: "prov", id: "model-a" }] } } });

  const fake = createFakePi();
  await autoRouter(fake.pi);
  const ctx = fakeCtx({ modelRegistry: fakeModelRegistry({ models: [a] }), currentModel: fake.currentModel });

  await fake.fire("session_start", {}, ctx);
  await selectPinned(fake, ctx, "high");

  expect(fake.setModelCalls).toEqual([]);
  expect(lastFooterBadge(fake.footerEvents)).toBe("🔀 Auto (high)");
});

test("a pinned Auto (<tier>) entry routes directly within that tier, skipping classification entirely", async () => {
  const medium = model("prov", "medium-model");
  const high = model("prov", "high-model");
  let classifyCalls = 0;
  await writeConfig({
    efforts: {
      medium: { models: [{ provider: "prov", id: "medium-model" }] },
      high: { models: [{ provider: "prov", id: "high-model" }] },
    },
  });

  const fake = createFakePi();
  await autoRouter(fake.pi);
  const registry = fakeModelRegistry({
    models: [medium, high],
    // If classification ran, it would say "medium" - proving the pinned tier (high) wins
    // regardless, and that this classifier was never actually asked.
    classify: () => {
      classifyCalls++;
      return "medium";
    },
  });
  const ctx = fakeCtx({ modelRegistry: registry, currentModel: fake.currentModel });

  await fake.fire("session_start", {}, ctx);
  await selectPinned(fake, ctx, "high");
  await fake.fire("before_agent_start", { prompt: "anything, complexity doesn't matter here" }, ctx);

  expect(fake.setModelCalls).toEqual([high]);
  expect(fake.thinkingLevelCalls).toEqual(["high"]);
  expect(classifyCalls).toBe(0);
});

test("after a turn settles, /model reverts to the same pinned entry that was selected, not the adaptive one", async () => {
  const high = model("prov", "high-model");
  await writeConfig({ efforts: { high: { models: [{ provider: "prov", id: "high-model" }] } } });

  const fake = createFakePi();
  await autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [high] });
  const ctx = fakeCtx({ modelRegistry: registry, currentModel: fake.currentModel });

  await fake.fire("session_start", {}, ctx);
  await selectPinned(fake, ctx, "high");
  await fake.fire("before_agent_start", { prompt: "anything" }, ctx);
  await fake.fire("agent_settled", {}, ctx);

  expect(ctx.model).toEqual(pinnedPlaceholder("high"));
});

test("session_start restores a pinned tier from a persisted entry and reverts to that specific placeholder", async () => {
  const already = model("prov", "already-selected");
  await writeConfig({ efforts: { xhigh: { models: [{ provider: "prov", id: "already-selected" }] } } });

  const fake = createFakePi();
  await autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [already] });
  fake.currentModel.value = already;
  const ctx = fakeCtx({
    modelRegistry: registry,
    currentModel: fake.currentModel,
    thinkingLevel: "xhigh",
    entries: [
      {
        type: "custom",
        customType: "vessup:auto-router:active",
        data: { enabled: true, pinnedTier: "xhigh" },
      },
    ],
  });

  await fake.fire("session_start", {}, ctx);

  expect(fake.setModelCalls).toEqual([pinnedPlaceholder("xhigh")]);
  expect(ctx.model).toEqual(pinnedPlaceholder("xhigh"));
  expect(lastFooterBadge(fake.footerEvents)).toBe("🔀 Auto (xhigh)");
});

test("before_agent_start self-heals into the correct pinned tier when ctx.model is already that pinned placeholder", async () => {
  const max = model("prov", "max-model");
  await writeConfig({ efforts: { max: { models: [{ provider: "prov", id: "max-model" }] } } });

  const fake = createFakePi();
  await autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [max] });
  // Simulates defaultModel/defaultProvider being set to a pinned "auto-max" entry globally -
  // no model_select, no session entries, exactly like the earlier defaultModel=auto bug.
  fake.currentModel.value = pinnedPlaceholder("max");
  const ctx = fakeCtx({ modelRegistry: registry, currentModel: fake.currentModel, entries: [] });

  await fake.fire("before_agent_start", { prompt: "anything" }, ctx);

  expect(fake.setModelCalls).toEqual([max]);
  expect(fake.thinkingLevelCalls).toEqual(["max"]);
});

test("before_agent_start routes to the classified tier, and the picker shows Auto again once the turn settles", async () => {
  const medium = model("prov", "medium-model");
  const high = model("prov", "high-model");
  await writeConfig({
    efforts: {
      medium: { models: [{ provider: "prov", id: "medium-model" }] },
      high: { models: [{ provider: "prov", id: "high-model" }] },
    },
  });

  const fake = createFakePi();
  await autoRouter(fake.pi);
  const registry = fakeModelRegistry({
    models: [medium, high],
    classify: (prompt) => (prompt.includes("refactor") ? "high" : "medium"),
  });
  const ctx = fakeCtx({ modelRegistry: registry, currentModel: fake.currentModel });

  await fake.fire("session_start", {}, ctx);
  await selectAuto(fake, ctx);

  await fake.fire("before_agent_start", { prompt: "please refactor this multi-file module" }, ctx);
  expect(fake.setModelCalls).toEqual([high]);
  expect(fake.thinkingLevelCalls).toEqual(["high"]);
  // The footer badge reflects the adaptive selection itself, not which tier this particular
  // turn classified to - that's what /usage is for.
  expect(lastFooterBadge(fake.footerEvents)).toBe("🔀 Auto (auto)");
  // Mid-turn, /model would show the real routed model, not "Auto".
  expect(ctx.model).toEqual(high);

  await fake.fire("agent_settled", {}, ctx);

  // Once the turn settles, /model shows Auto selected again...
  expect(ctx.model).toEqual(AUTO_PLACEHOLDER);
  expect(fake.setModelCalls.at(-1)).toEqual(AUTO_PLACEHOLDER);
  // ...and the footer badge is unchanged, since the selection never changed.
  expect(lastFooterBadge(fake.footerEvents)).toBe("🔀 Auto (auto)");
});

test("a model's `effort` override sets its own thinking level, independent of the tier that routed to it", async () => {
  const high = model("opencode-go", "kimi-k3");
  await writeConfig({
    efforts: {
      high: {
        models: [{ provider: "opencode-go", id: "kimi-k3", effort: "max" }],
      },
    },
  });

  const fake = createFakePi();
  await autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [high], classify: () => "high" });
  const ctx = fakeCtx({ modelRegistry: registry, currentModel: fake.currentModel });

  await fake.fire("session_start", {}, ctx);
  await selectAuto(fake, ctx);
  await fake.fire("before_agent_start", { prompt: "anything" }, ctx);

  expect(fake.setModelCalls).toEqual([high]);
  // Routed via the "high" tier (that's what got classified and what /usage groups it under),
  // but dispatched at "max" thinking level per the model's own override.
  expect(fake.thinkingLevelCalls).toEqual(["max"]);
  // The footer badge still just says "Auto (auto)" - the adaptive selection, not the tier or
  // effort this turn happened to land on (that mismatch, e.g. "Auto (max)" next to a model
  // actually running at a lower effort, is exactly what this badge no longer claims).
  expect(lastFooterBadge(fake.footerEvents)).toBe("🔀 Auto (auto)");

  await fake.runCommand("usage", "", ctx);
  const notified = ctx.notifications.at(-1)?.message ?? "";
  expect(notified).toContain("high"); // still grouped under its configured tier
  expect(notified).toContain("at max effort"); // classification log shows the real applied effort
});

test("a routed turn's classification is logged and shows up in /usage, so a routing decision can be checked against what the classifier actually said", async () => {
  const medium = model("prov", "medium-model");
  const high = model("prov", "high-model");
  await writeConfig({
    efforts: {
      medium: { models: [{ provider: "prov", id: "medium-model" }] },
      high: { models: [{ provider: "prov", id: "high-model" }] },
    },
  });

  const fake = createFakePi();
  await autoRouter(fake.pi);
  const registry = fakeModelRegistry({
    models: [medium, high],
    classify: (prompt) => (prompt.includes("refactor") ? "high" : "medium"),
  });
  const ctx = fakeCtx({ modelRegistry: registry, currentModel: fake.currentModel });

  await fake.fire("session_start", {}, ctx);
  await selectAuto(fake, ctx);
  await fake.fire("before_agent_start", { prompt: "please refactor this multi-file module" }, ctx);

  await fake.runCommand("usage", "", ctx);
  const notified = ctx.notifications.at(-1)?.message ?? "";
  expect(notified).toContain("Recent classifications");
  expect(notified).toContain("high");
  expect(notified).toContain("prov/high-model");
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
  await autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [medium, c, d], classify: () => "high" });
  const ctx = fakeCtx({ modelRegistry: registry, currentModel: fake.currentModel });

  await fake.fire("session_start", {}, ctx);
  await selectAuto(fake, ctx);

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
  await autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [only] });
  const ctx = fakeCtx({ modelRegistry: registry, currentModel: fake.currentModel });

  await fake.fire("session_start", {}, ctx);
  await selectAuto(fake, ctx);

  await fake.fire("before_agent_start", { prompt: "anything" }, ctx);
  await fake.fire("after_provider_response", { status: 401, headers: {} }, ctx);
  fake.setModelCalls.length = 0;

  await fake.fire("before_agent_start", { prompt: "anything" }, ctx);

  expect(fake.setModelCalls).toEqual([only]);
  expect(ctx.notifications.some((n) => n.type === "warning" && n.message.includes("unavailable"))).toBe(true);
});

test("the last-resort fallback labels the model with the tier it actually belongs to, not the (unconfigured) resolved tier", async () => {
  // Only "high" is configured; "medium" has nothing. resolveEffortTier falls back to the
  // literal "medium" when nothing between the classified level and medium has models, so
  // pickForTier can be called with a tier that itself has zero configured entries. When that
  // happens and the only real fallback model comes from a *different* tier (high), the
  // returned tier must reflect that model's real tier - otherwise the wrong thinking level
  // gets applied to it.
  const high = model("prov", "high-model");
  await writeConfig({ efforts: { high: { models: [{ provider: "prov", id: "high-model" }] } } });

  const fake = createFakePi();
  await autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [high], classify: () => "high" });
  const ctx = fakeCtx({ modelRegistry: registry, currentModel: fake.currentModel });

  await fake.fire("session_start", {}, ctx);
  await selectAuto(fake, ctx);

  // First turn: classified "high", routes normally to the only configured model.
  await fake.fire("before_agent_start", { prompt: "anything" }, ctx);
  expect(fake.setModelCalls).toEqual([high]);
  expect(fake.thinkingLevelCalls).toEqual(["high"]);

  // It then fails, which also makes it unhealthy as the classifier - so the next turn's level
  // defaults straight to "medium" without even running classification, and with nothing above
  // it healthy either (high is now the only tier and it just failed), forcing the cross-tier
  // last-resort fallback.
  await fake.fire("after_provider_response", { status: 401, headers: {} }, ctx);
  fake.setModelCalls.length = 0;
  fake.thinkingLevelCalls.length = 0;

  await fake.fire("before_agent_start", { prompt: "anything" }, ctx);

  expect(fake.setModelCalls).toEqual([high]);
  // Must be labeled "high" (where the model actually lives), not "medium" (the resolved-but-
  // unconfigured tier that triggered the fallback).
  expect(fake.thinkingLevelCalls).toEqual(["high"]);
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
  await autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [a, b] });
  const ctx = fakeCtx({ modelRegistry: registry, currentModel: fake.currentModel });

  await fake.fire("session_start", {}, ctx);
  await selectAuto(fake, ctx);

  await fake.fire("before_agent_start", { prompt: "anything" }, ctx);
  expect(fake.setModelCalls).toEqual([a]);

  // model-a gets rate limited.
  await fake.fire("after_provider_response", { status: 429, headers: {} }, ctx);
  fake.setModelCalls.length = 0;

  await fake.fire("before_agent_start", { prompt: "anything" }, ctx);
  expect(fake.setModelCalls).toEqual([b]);
});

test("a message-level provider error (no distinct HTTP failure status) still fails over on the next turn", async () => {
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
  await autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [a, b] });
  const ctx = fakeCtx({ modelRegistry: registry, currentModel: fake.currentModel });

  await fake.fire("session_start", {}, ctx);
  await selectAuto(fake, ctx);

  await fake.fire("before_agent_start", { prompt: "anything" }, ctx);
  expect(fake.setModelCalls).toEqual([a]);

  // The HTTP response came back 200, so after_provider_response never fires as a failure -
  // the error only shows up once Pi finalizes the assistant message.
  await fake.fire(
    "message_end",
    {
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "Codex error: The usage limit has been reached",
      },
    },
    ctx,
  );
  fake.setModelCalls.length = 0;

  await fake.fire("before_agent_start", { prompt: "anything" }, ctx);
  expect(fake.setModelCalls).toEqual([b]);
});

test("an aborted (user-cancelled) message does not count as a provider failure", async () => {
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
  await autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [a, b] });
  const ctx = fakeCtx({ modelRegistry: registry, currentModel: fake.currentModel });

  await fake.fire("session_start", {}, ctx);
  await selectAuto(fake, ctx);

  await fake.fire("before_agent_start", { prompt: "anything" }, ctx);
  await fake.fire("message_end", { message: { role: "assistant", stopReason: "aborted" } }, ctx);
  fake.setModelCalls.length = 0;

  await fake.fire("before_agent_start", { prompt: "anything" }, ctx);
  expect(fake.setModelCalls).toEqual([a]);
});

test("router-observed usage is tracked for a manually-selected configured model, not just ones Auto routed to", async () => {
  const a = model("prov", "model-a");
  await writeConfig({ efforts: { medium: { models: [{ provider: "prov", id: "model-a" }] } } });

  const fake = createFakePi();
  await autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [a] });
  const ctx = fakeCtx({ modelRegistry: registry, currentModel: fake.currentModel });

  await fake.fire("session_start", {}, ctx);
  // The user picks model-a straight from /model - Auto is never engaged.
  fake.currentModel.value = a;

  await fake.fire(
    "message_end",
    { message: { role: "assistant", stopReason: "stop", usage: { input: 10, output: 5, cost: { total: 0.01 } } } },
    ctx,
  );

  await fake.runCommand("usage", "", ctx);
  const notified = ctx.notifications.at(-1)?.message ?? "";
  expect(notified).toContain("1 req");
});

test("router-observed failures are tracked for a manually-selected configured model too", async () => {
  const a = model("prov", "model-a");
  await writeConfig({ efforts: { medium: { models: [{ provider: "prov", id: "model-a" }] } } });

  const fake = createFakePi();
  await autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [a] });
  const ctx = fakeCtx({ modelRegistry: registry, currentModel: fake.currentModel });

  await fake.fire("session_start", {}, ctx);
  fake.currentModel.value = a;

  await fake.fire("after_provider_response", { status: 429, headers: {} }, ctx);

  await fake.runCommand("usage", "", ctx);
  const notified = ctx.notifications.at(-1)?.message ?? "";
  expect(notified).toContain("cooldown");
});

test("usage from a model that isn't configured anywhere in autoRouter is not tracked", async () => {
  const a = model("prov", "model-a");
  const unrelated = model("other", "unrelated-model");
  await writeConfig({ efforts: { medium: { models: [{ provider: "prov", id: "model-a" }] } } });

  const fake = createFakePi();
  await autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [a, unrelated] });
  const ctx = fakeCtx({ modelRegistry: registry, currentModel: fake.currentModel });

  await fake.fire("session_start", {}, ctx);
  fake.currentModel.value = unrelated;

  await fake.fire(
    "message_end",
    { message: { role: "assistant", stopReason: "stop", usage: { input: 10, output: 5, cost: { total: 0.01 } } } },
    ctx,
  );

  await fake.runCommand("usage", "", ctx);
  const notified = ctx.notifications.at(-1)?.message ?? "";
  expect(notified).toContain("prov/model-a");
  expect(notified).not.toContain("unrelated-model");
});

test("manually picking a real model while Auto is active turns Auto off", async () => {
  const a = model("prov", "model-a");
  const manual = model("prov", "manual-model");
  await writeConfig({ efforts: { medium: { models: [{ provider: "prov", id: "model-a" }] } } });

  const fake = createFakePi();
  await autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [a, manual] });
  const ctx = fakeCtx({ modelRegistry: registry, currentModel: fake.currentModel });

  await fake.fire("session_start", {}, ctx);
  await selectAuto(fake, ctx);
  await fake.fire("model_select", { model: manual, previousModel: a, source: "set" }, ctx);
  fake.setModelCalls.length = 0;

  await fake.fire("before_agent_start", { prompt: "anything" }, ctx);
  expect(fake.setModelCalls).toEqual([]);
});

test("deactivating Auto removes its footer badge", async () => {
  const a = model("prov", "model-a");
  const manual = model("prov", "manual-model");
  await writeConfig({ efforts: { medium: { models: [{ provider: "prov", id: "model-a" }] } } });

  const fake = createFakePi();
  await autoRouter(fake.pi);
  const ctx = fakeCtx({ modelRegistry: fakeModelRegistry({ models: [a, manual] }), currentModel: fake.currentModel });

  await fake.fire("session_start", {}, ctx);
  await selectAuto(fake, ctx);
  expect(lastFooterBadge(fake.footerEvents)).toBe("🔀 Auto (auto)");

  await fake.fire("model_select", { model: manual, previousModel: a, source: "set" }, ctx);
  expect(fake.footerEvents.at(-1)).toMatchObject({ remove: true });
});

test("/usage with no configured models notifies instead of throwing", async () => {
  const fake = createFakePi();
  await autoRouter(fake.pi);
  const ctx = fakeCtx({ modelRegistry: fakeModelRegistry({ models: [] }) });

  await fake.runCommand("usage", "", ctx);
  expect(ctx.notifications.some((n) => n.message.includes("no configured models"))).toBe(true);
});

test("session_start on a cleanly-idle Auto session leaves the placeholder selected", async () => {
  const already = model("prov", "already-selected");
  await writeConfig({ efforts: { medium: { models: [{ provider: "prov", id: "already-selected" }] } } });

  const fake = createFakePi();
  await autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [already] });
  fake.currentModel.value = AUTO_PLACEHOLDER;
  const ctx = fakeCtx({
    modelRegistry: registry,
    currentModel: fake.currentModel,
    entries: [{ type: "custom", customType: "vessup:auto-router:active", data: { enabled: true } }],
  });

  await fake.fire("session_start", {}, ctx);

  expect(fake.setModelCalls).toEqual([]);
  expect(lastFooterBadge(fake.footerEvents)).toBe("🔀 Auto (auto)");
});

test("a brand-new session whose defaultModel is auto/auto routes on the first turn with no prior /model pick or session entries", async () => {
  const medium = model("prov", "medium-model");
  await writeConfig({ efforts: { medium: { models: [{ provider: "prov", id: "medium-model" }] } } });

  const fake = createFakePi();
  await autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [medium] });
  // No `model_select` for Auto ever fired, and no session entries exist - this is what a
  // brand-new session looks like when `defaultProvider`/`defaultModel` are set to "auto" in
  // global settings rather than picked interactively.
  fake.currentModel.value = AUTO_PLACEHOLDER;
  const ctx = fakeCtx({ modelRegistry: registry, currentModel: fake.currentModel, entries: [] });

  await fake.fire("session_start", {}, ctx);
  await fake.fire("before_agent_start", { prompt: "anything" }, ctx);

  expect(fake.setModelCalls).toEqual([medium]);
  expect(ctx.model).toEqual(medium);
});

test("before_agent_start routes for real even if autoActive's own bookkeeping never saw the placeholder become active", async () => {
  const medium = model("prov", "medium-model");
  await writeConfig({ efforts: { medium: { models: [{ provider: "prov", id: "medium-model" }] } } });

  const fake = createFakePi();
  await autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [medium] });
  fake.currentModel.value = AUTO_PLACEHOLDER;
  // Deliberately no `session_start` and no `model_select` at all here - autoActive is stuck at
  // its initial `false`. Whatever caused that desync (a timing race, a code path we haven't
  // accounted for), `ctx.model` already being the inert placeholder right before dispatch is
  // itself proof a real request is about to fail, and that must be enough to route for real.
  const ctx = fakeCtx({ modelRegistry: registry, currentModel: fake.currentModel, entries: [] });

  await fake.fire("before_agent_start", { prompt: "anything" }, ctx);

  expect(fake.setModelCalls).toEqual([medium]);
  expect(ctx.model).toEqual(medium);
  expect(fake.appendedEntries).toContainEqual({
    type: "vessup:auto-router:active",
    data: { enabled: true },
  });

  // And the self-heal sticks: the next turn's placeholder-revert and routing both still work.
  await fake.fire("agent_settled", {}, ctx);
  expect(ctx.model).toEqual(AUTO_PLACEHOLDER);
});

test("session_start restored mid-turn (e.g. after a crash) reverts back to the Auto placeholder", async () => {
  const already = model("prov", "already-selected");
  await writeConfig({ efforts: { medium: { models: [{ provider: "prov", id: "already-selected" }] } } });

  const fake = createFakePi();
  await autoRouter(fake.pi);
  const registry = fakeModelRegistry({ models: [already] });
  fake.currentModel.value = already;
  const ctx = fakeCtx({
    modelRegistry: registry,
    currentModel: fake.currentModel,
    thinkingLevel: "medium",
    entries: [{ type: "custom", customType: "vessup:auto-router:active", data: { enabled: true } }],
  });

  await fake.fire("session_start", {}, ctx);

  expect(fake.setModelCalls).toEqual([AUTO_PLACEHOLDER]);
  expect(ctx.model).toEqual(AUTO_PLACEHOLDER);
  // Unpinned (no `pinnedTier` in the persisted entry), so the badge reflects the adaptive
  // selection, not `ctx.thinkingLevel` left over from whatever was mid-flight at the crash.
  expect(lastFooterBadge(fake.footerEvents)).toBe("🔀 Auto (auto)");
});
