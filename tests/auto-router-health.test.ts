import { expect, test } from "bun:test";
import {
  applyFailure,
  applyQuotaResult,
  applySuccess,
  type AutoRouterHealthState,
  isHealthy,
  modelKey,
  parseRetryAfterMs,
  pickHealthy,
} from "../extensions/auto-router-health.ts";

const NOW = 1_000_000_000_000;

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
