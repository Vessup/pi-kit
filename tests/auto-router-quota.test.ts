import { expect, test } from "bun:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  type QuotaFetchDependencies,
  reconcileProviderQuota,
} from "../extensions/auto-router-quota.ts";

function fakeRegistry(apiKey: string | undefined): ModelRegistry {
  return {
    getApiKeyForProvider: async () => apiKey,
  } as unknown as ModelRegistry;
}

function fakeDeps(
  handler: (url: string) => Response,
  {
    accountId,
    minimaxCli,
  }: { accountId?: string; minimaxCli?: (args: string[]) => Promise<string | undefined> } = {
    accountId: "acct-1",
  },
): QuotaFetchDependencies {
  return {
    fetchImpl: (async (url: string | URL) => handler(url.toString())) as typeof fetch,
    readCodexAccountId: async () => accountId,
    runMinimaxCli: minimaxCli ?? (async () => undefined),
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

test("reconcileProviderQuota returns undefined for providers without a known fetcher", async () => {
  const result = await reconcileProviderQuota(
    "totally-unsupported-provider",
    fakeRegistry("key"),
    fakeDeps(() => jsonResponse({})),
  );
  expect(result).toBeUndefined();
});

test("reconcileProviderQuota returns undefined without credentials, never calling fetch", async () => {
  let called = false;
  const deps = fakeDeps(() => {
    called = true;
    return jsonResponse({});
  });
  const result = await reconcileProviderQuota("anthropic", fakeRegistry(undefined), deps);
  expect(result).toBeUndefined();
  expect(called).toBe(false);
});

test("reconcileProviderQuota(anthropic) skips a raw API key without calling fetch", async () => {
  let called = false;
  const deps = fakeDeps(() => {
    called = true;
    return jsonResponse({});
  });
  const result = await reconcileProviderQuota("anthropic", fakeRegistry("sk-ant-api03-abc"), deps);
  expect(result).toBeUndefined();
  expect(called).toBe(false);
});

test("reconcileProviderQuota(anthropic) reports exhaustion from an OAuth token's usage window", async () => {
  const resetsAt = "2030-01-01T00:00:00Z";
  const deps = fakeDeps(() =>
    jsonResponse({ five_hour: { utilization: 100, resets_at: resetsAt } }),
  );
  const result = await reconcileProviderQuota("anthropic", fakeRegistry("oauth-token"), deps);
  expect(result).toEqual({ exhausted: true, resetsAt: Date.parse(resetsAt) });
});

test("reconcileProviderQuota(anthropic) reports headroom when utilization is low", async () => {
  const deps = fakeDeps(() => jsonResponse({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } }));
  const result = await reconcileProviderQuota("anthropic", fakeRegistry("oauth-token"), deps);
  expect(result).toEqual({ exhausted: false });
});

test("reconcileProviderQuota(openai-codex) returns undefined without a discoverable account id", async () => {
  const deps = fakeDeps(() => jsonResponse({}), { accountId: undefined });
  const result = await reconcileProviderQuota("openai-codex", fakeRegistry("token"), deps);
  expect(result).toBeUndefined();
});

test("reconcileProviderQuota(openai-codex) reports exhaustion when the spend cap is reached", async () => {
  const deps = fakeDeps(() => jsonResponse({ spend_control: { reached: true } }));
  const result = await reconcileProviderQuota("openai-codex", fakeRegistry("token"), deps);
  expect(result).toEqual({ exhausted: true });
});

test("reconcileProviderQuota(openai-codex) reports exhaustion when a rate-limit window is depleted", async () => {
  const deps = fakeDeps(() =>
    jsonResponse({ rate_limit: { primary_window: { percent_left: 0, reset_at: "2030-06-01T00:00:00Z" } } }),
  );
  const result = await reconcileProviderQuota("openai-codex", fakeRegistry("token"), deps);
  expect(result).toEqual({ exhausted: true, resetsAt: Date.parse("2030-06-01T00:00:00Z") });
});

test("reconcileProviderQuota(zai) reports exhaustion from a TOKENS_LIMIT entry", async () => {
  const deps = fakeDeps(() =>
    jsonResponse({ data: { limits: [{ type: "TOKENS_LIMIT", percentage: 100, nextResetTime: 4_102_444_800_000 }] } }),
  );
  const result = await reconcileProviderQuota("zai", fakeRegistry("key"), deps);
  expect(result).toEqual({ exhausted: true, resetsAt: 4_102_444_800_000 });
});

test("reconcileProviderQuota(kimi-coding) reports exhaustion when used reaches the weekly limit", async () => {
  const deps = fakeDeps(() => jsonResponse({ usage: { limit: 100, used: 100, resetTime: "2030-01-01T00:00:00Z" } }));
  const result = await reconcileProviderQuota("kimi-coding", fakeRegistry("key"), deps);
  expect(result).toEqual({ exhausted: true, resetsAt: Date.parse("2030-01-01T00:00:00Z") });
});

test("reconcileProviderQuota(minimax) reports headroom from the mmx CLI's general bucket", async () => {
  const deps = fakeDeps(() => jsonResponse({}), {
    minimaxCli: async () =>
      JSON.stringify({
        model_remains: [
          { model_name: "general", current_interval_remaining_percent: 84, current_weekly_remaining_percent: 89 },
          { model_name: "video", current_interval_remaining_percent: 100, current_weekly_remaining_percent: 100 },
        ],
      }),
  });
  const result = await reconcileProviderQuota("minimax", fakeRegistry(undefined), deps);
  expect(result).toEqual({ exhausted: false });
});

test("reconcileProviderQuota(minimax) reports exhaustion when the interval bucket is depleted", async () => {
  const deps = fakeDeps(() => jsonResponse({}), {
    minimaxCli: async () =>
      JSON.stringify({
        model_remains: [
          {
            model_name: "general",
            current_interval_remaining_percent: 0,
            current_weekly_remaining_percent: 50,
            end_time: 4_102_444_800_000,
          },
        ],
      }),
  });
  const result = await reconcileProviderQuota("minimax", fakeRegistry(undefined), deps);
  expect(result).toEqual({ exhausted: true, resetsAt: 4_102_444_800_000 });
});

test("reconcileProviderQuota(minimax) reports exhaustion when only the weekly bucket is depleted", async () => {
  const deps = fakeDeps(() => jsonResponse({}), {
    minimaxCli: async () =>
      JSON.stringify({
        model_remains: [
          {
            model_name: "general",
            current_interval_remaining_percent: 60,
            current_weekly_remaining_percent: 0.2,
            weekly_end_time: 4_102_444_800_000,
          },
        ],
      }),
  });
  const result = await reconcileProviderQuota("minimax", fakeRegistry(undefined), deps);
  expect(result).toEqual({ exhausted: true, resetsAt: 4_102_444_800_000 });
});

test("reconcileProviderQuota(minimax) degrades gracefully when the CLI is missing or not logged in", async () => {
  const deps = fakeDeps(() => jsonResponse({}), { minimaxCli: async () => undefined });
  const result = await reconcileProviderQuota("minimax", fakeRegistry(undefined), deps);
  expect(result).toBeUndefined();
});

test("reconcileProviderQuota(minimax) degrades gracefully on unparseable CLI output", async () => {
  const deps = fakeDeps(() => jsonResponse({}), { minimaxCli: async () => "not json" });
  const result = await reconcileProviderQuota("minimax", fakeRegistry(undefined), deps);
  expect(result).toBeUndefined();
});

test("reconcileProviderQuota degrades gracefully on network/HTTP failure", async () => {
  const deps = fakeDeps(() => jsonResponse({}, 500));
  const result = await reconcileProviderQuota("anthropic", fakeRegistry("oauth-token"), deps);
  expect(result).toBeUndefined();
});

test("reconcileProviderQuota degrades gracefully when the fetcher throws", async () => {
  const deps: QuotaFetchDependencies = {
    fetchImpl: (async () => {
      throw new Error("network down");
    }) as typeof fetch,
    readCodexAccountId: async () => "acct-1",
    runMinimaxCli: async () => undefined,
  };
  const result = await reconcileProviderQuota("anthropic", fakeRegistry("oauth-token"), deps);
  expect(result).toBeUndefined();
});
