import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyFailure,
  applyQuotaResult,
  applySuccess,
  AutoRouterHealthStore,
  type AutoRouterHealthState,
  isHealthy,
  modelKey,
  parseRetryAfterMs,
  pickHealthy,
  SAVE_DEBOUNCE_MS,
} from "../extensions/auto-router-health.ts";

const NOW = 1_000_000_000_000;

const ENV_VAR = "PI_CODING_AGENT_DIR";
let agentDir: string | undefined;
const usedDirs: string[] = [];

// AutoRouterHealthStore debounces its writes (~2s after the last record call), so a save
// scheduled by one test can fire well after that test's own teardown - if `afterEach` restored
// PI_CODING_AGENT_DIR to its prior (usually unset) value in the meantime, that late write would
// land in the real global agent directory instead of a test's temp one. So the env var is never
// restored to anything other than a temp dir for the whole run - only ever moved to a new one -
// and every temp dir used stays on disk until all tests finish, so even a very late write can
// only ever land somewhere harmless.
beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "pi-kit-auto-router-health-"));
  usedDirs.push(agentDir);
  process.env[ENV_VAR] = agentDir;
});

afterAll(async () => {
  // The debounced save timer is unref'd, so it never blocks the process from exiting - but if
  // this suite's own run happens to keep the process alive past SAVE_DEBOUNCE_MS anyway (e.g. a
  // larger `bun test` invocation still running other files), a timer scheduled by one of this
  // file's last tests can still fire *after* this hook would otherwise have already deleted
  // PI_CODING_AGENT_DIR and removed its temp dir - at which point `statePath()` falls back to the
  // real default `~/.pi/agent`, and the save actually corrupts the developer's real global
  // auto-router-state.json with this suite's fixture data (verified: it happened - twice, since
  // this file duplicates the same env-var isolation as auto-router-extension.test.ts but didn't
  // get this fix the first time). Waiting out the debounce window here first, before touching the
  // env var or any directory, guarantees every such timer fires while it's still pointed at a
  // real (about-to-be-removed) temp dir.
  await new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MS + 500));
  delete process.env[ENV_VAR];
  await Promise.all(usedDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("modelKey joins provider and id", () => {
  expect(modelKey({ provider: "openai", id: "gpt-5.3-codex" })).toBe("openai/gpt-5.3-codex");
});

test("parseRetryAfterMs reads a numeric seconds header", () => {
  expect(parseRetryAfterMs({ "retry-after": "30" }, NOW)).toBe(30_000);
});

test("parseRetryAfterMs reads an HTTP-date header", () => {
  const future = new Date(NOW + 60_000).toUTCString();
  expect(parseRetryAfterMs({ "retry-after": future }, NOW)).toBeCloseTo(60_000, -2);
});

test("parseRetryAfterMs finds the header regardless of casing", () => {
  expect(parseRetryAfterMs({ "RETRY-AFTER": "30" }, NOW)).toBe(30_000);
  expect(parseRetryAfterMs({ "Retry-After": "30" }, NOW)).toBe(30_000);
});

test("parseRetryAfterMs returns undefined when the header is missing or unparseable", () => {
  expect(parseRetryAfterMs(undefined, NOW)).toBeUndefined();
  expect(parseRetryAfterMs({}, NOW)).toBeUndefined();
  expect(parseRetryAfterMs({ "retry-after": "not-a-value" }, NOW)).toBeUndefined();
});

test("applySuccess resets failure state and accumulates usage totals", () => {
  let state: AutoRouterHealthState = {};
  state = applyFailure(state, "m", 500, undefined, NOW);
  state = applyFailure(state, "m", 500, undefined, NOW);
  state = applyFailure(state, "m", 500, undefined, NOW);
  expect(state.m.cooldownUntil).toBeDefined();

  state = applySuccess(state, "m", { input: 10, output: 5, cost: 0.01 });
  expect(state.m.consecutiveFailures).toBe(0);
  expect(state.m.cooldownUntil).toBeUndefined();
  expect(state.m.totals).toEqual({ requests: 1, input: 10, output: 5, cost: 0.01 });

  state = applySuccess(state, "m", { input: 3, output: 2, cost: 0.001 });
  expect(state.m.totals).toEqual({ requests: 2, input: 13, output: 7, cost: 0.011 });
});

test("applyFailure on 429 honors retry-after when present", () => {
  const state = applyFailure({}, "m", 429, { "retry-after": "120" }, NOW);
  expect(state.m.cooldownUntil).toBe(NOW + 120_000);
});

test("applyFailure on 429 backs off exponentially without retry-after, capped", () => {
  let state: AutoRouterHealthState = {};
  const cooldowns: number[] = [];
  for (let i = 0; i < 8; i++) {
    state = applyFailure(state, "m", 429, undefined, NOW);
    cooldowns.push((state.m.cooldownUntil ?? NOW) - NOW);
  }
  // Strictly increasing until it hits the cap, then flat.
  for (let i = 1; i < cooldowns.length; i++) {
    expect(cooldowns[i]).toBeGreaterThanOrEqual(cooldowns[i - 1]);
  }
  expect(Math.max(...cooldowns)).toBe(60 * 60_000);
});

test("applyFailure on 401/403 sets a fixed auth cooldown immediately", () => {
  const state401 = applyFailure({}, "m", 401, undefined, NOW);
  expect(state401.m.cooldownUntil).toBe(NOW + 30 * 60_000);
  const state403 = applyFailure({}, "m", 403, undefined, NOW);
  expect(state403.m.cooldownUntil).toBe(NOW + 30 * 60_000);
});

test("applyFailure on 5xx only cools down after crossing the consecutive-failure threshold", () => {
  let state: AutoRouterHealthState = {};
  state = applyFailure(state, "m", 500, undefined, NOW);
  expect(state.m.cooldownUntil).toBeUndefined();
  state = applyFailure(state, "m", 500, undefined, NOW);
  expect(state.m.cooldownUntil).toBeUndefined();
  state = applyFailure(state, "m", 500, undefined, NOW);
  expect(state.m.cooldownUntil).toBe(NOW + 2 * 60_000);
});

test("applyFailure on other 4xx codes eventually applies a generic cooldown", () => {
  let state: AutoRouterHealthState = {};
  for (let i = 0; i < 4; i++) {
    state = applyFailure(state, "m", 400, undefined, NOW);
    expect(state.m.cooldownUntil).toBeUndefined();
  }
  state = applyFailure(state, "m", 400, undefined, NOW);
  expect(state.m.cooldownUntil).toBe(NOW + 5 * 60_000);
});

test("applyQuotaResult sets a cooldown to the real reset time even without a local 429", () => {
  const state = applyQuotaResult({}, "m", { exhausted: true, resetsAt: NOW + 90_000 }, NOW);
  expect(state.m.cooldownUntil).toBe(NOW + 90_000);
  expect(state.m.verifiedAt).toBe(NOW);
});

test("applyQuotaResult without a reset time falls back to a short default cooldown", () => {
  const state = applyQuotaResult({}, "m", { exhausted: true }, NOW);
  expect(state.m.cooldownUntil).toBe(NOW + 5 * 60_000);
});

test("applyQuotaResult with confirmed headroom clears a stale local cooldown outright", () => {
  let state: AutoRouterHealthState = applyFailure({}, "m", 429, undefined, NOW);
  expect(state.m.cooldownUntil).toBeDefined();
  state = applyQuotaResult(state, "m", { exhausted: false }, NOW + 1);
  expect(state.m.cooldownUntil).toBeUndefined();
  expect(state.m.consecutiveFailures).toBe(0);
  expect(state.m.verifiedAt).toBe(NOW + 1);
});

test("isHealthy/pickHealthy skip models in cooldown and pick the first healthy candidate", () => {
  const a = { provider: "p", id: "a" };
  const b = { provider: "p", id: "b" };
  let state: AutoRouterHealthState = {};
  state = applyFailure(state, modelKey(a), 401, undefined, NOW);

  expect(isHealthy(state, modelKey(a), NOW)).toBe(false);
  expect(isHealthy(state, modelKey(b), NOW)).toBe(true);
  expect(pickHealthy(state, [a, b], NOW)).toEqual(b);
});

test("pickHealthy returns undefined once every candidate is in cooldown", () => {
  const a = { provider: "p", id: "a" };
  const b = { provider: "p", id: "b" };
  let state: AutoRouterHealthState = {};
  state = applyFailure(state, modelKey(a), 401, undefined, NOW);
  state = applyFailure(state, modelKey(b), 401, undefined, NOW);
  expect(pickHealthy(state, [a, b], NOW)).toBeUndefined();
});

test("a cooldown clears once its expiry has passed", () => {
  const a = { provider: "p", id: "a" };
  const state = applyFailure({}, modelKey(a), 401, undefined, NOW);
  expect(isHealthy(state, modelKey(a), NOW + 30 * 60_000 - 1)).toBe(false);
  expect(isHealthy(state, modelKey(a), NOW + 30 * 60_000 + 1)).toBe(true);
});

function statePath(): string {
  if (!agentDir) throw new Error("agentDir not set");
  return join(agentDir, "auto-router-state.json");
}

test("AutoRouterHealthStore round-trips model health and classification log through flush/load, without ever persisting prompt content", async () => {
  const store = new AutoRouterHealthStore();
  const model = { provider: "prov", id: "a" };
  store.recordSuccess(modelKey(model), { input: 10, output: 20, cost: 0.01 });
  store.recordClassification(
    { reply: "high complexity", level: "high", tier: "high", effort: "high", model },
    NOW,
  );
  await store.flush();

  // The prompt itself (which can contain source code, credentials, or personal data) must
  // never reach the plaintext state file on disk - only routing metadata does.
  const onDisk = await readFile(statePath(), "utf8");
  expect(onDisk).not.toContain("prompt");

  const reloaded = new AutoRouterHealthStore();
  await reloaded.load();
  expect(reloaded.getEntry(modelKey(model))?.totals).toEqual({
    requests: 1,
    input: 10,
    output: 20,
    cost: 0.01,
  });
  expect(reloaded.getClassifications()).toEqual([
    {
      timestamp: NOW,
      reply: "high complexity",
      level: "high",
      tier: "high",
      effort: "high",
      model,
    },
  ]);
});

test("AutoRouterHealthStore.load reads a pre-classification-log file (flat model-keyed record) as model health with an empty log", async () => {
  const model = { provider: "prov", id: "a" };
  await writeFile(
    statePath(),
    JSON.stringify({
      [modelKey(model)]: {
        consecutiveFailures: 0,
        totals: { requests: 3, input: 1, output: 2, cost: 0.001 },
      },
    }),
  );
  const store = new AutoRouterHealthStore();
  await store.load();
  expect(store.getEntry(modelKey(model))?.totals.requests).toBe(3);
  expect(store.getClassifications()).toEqual([]);
});

test("AutoRouterHealthStore.recordClassification truncates long text and caps the log at the most recent 20 entries", async () => {
  const store = new AutoRouterHealthStore();
  const model = { provider: "prov", id: "a" };
  const longReply = "x".repeat(500);
  for (let i = 0; i < 25; i++) {
    store.recordClassification(
      {
        reply: i === 24 ? longReply : `reply ${i}`,
        level: "medium",
        tier: "medium",
        effort: "medium",
        model,
      },
      NOW + i,
    );
  }
  const entries = store.getClassifications();
  expect(entries).toHaveLength(20);
  expect(entries[0]?.reply).toBe("reply 5");
  expect(entries.at(-1)?.reply.length).toBeLessThanOrEqual(201);
  expect(entries.at(-1)?.reply.endsWith("…")).toBe(true);
});
