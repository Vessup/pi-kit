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
  expect(result).toEqual({
    default: { exhausted: true, resetsAt: Date.parse(resetsAt), detail: "5h 100% used" },
  });
});

test("reconcileProviderQuota(anthropic) reports headroom, with the most-used window as detail", async () => {
  const deps = fakeDeps(() => jsonResponse({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } }));
  const result = await reconcileProviderQuota("anthropic", fakeRegistry("oauth-token"), deps);
  expect(result).toEqual({ default: { exhausted: false, detail: "7d 20% used" } });
});

test("reconcileProviderQuota(openai-codex) returns undefined without a discoverable account id", async () => {
  const deps = fakeDeps(() => jsonResponse({}), { accountId: undefined });
  const result = await reconcileProviderQuota("openai-codex", fakeRegistry("token"), deps);
  expect(result).toBeUndefined();
});

test("reconcileProviderQuota(openai-codex) reports exhaustion when the spend cap is reached", async () => {
  const deps = fakeDeps(() => jsonResponse({ spend_control: { reached: true } }));
  const result = await reconcileProviderQuota("openai-codex", fakeRegistry("token"), deps);
  expect(result).toEqual({ default: { exhausted: true, detail: "spend cap reached" } });
});

test("reconcileProviderQuota(openai-codex) applies the account-wide rate_limit.limit_reached flag only to models without their own additional_rate_limits entry", async () => {
  // Shape verified against a real exhausted account, *and* the model-specific behavior verified
  // directly by the user: the account-wide flag was true, a per-model entry under
  // additional_rate_limits for the model actually in use was healthy, and that model kept
  // working normally despite the account-wide flag. The two are independent quota tracks -
  // the account-wide flag governs the "default" bucket (models with no specific entry below),
  // not every model under the provider.
  const deps = fakeDeps(() =>
    jsonResponse({
      rate_limit: {
        allowed: false,
        limit_reached: true,
        primary_window: { used_percent: 100, limit_window_seconds: 604_800, reset_at: 1787197007 },
        secondary_window: null,
      },
      additional_rate_limits: [
        {
          limit_name: "GPT-5.3-Codex-Spark",
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: { used_percent: 5, limit_window_seconds: 604_800 },
          },
        },
      ],
      spend_control: { reached: false },
    }),
  );
  const result = await reconcileProviderQuota("openai-codex", fakeRegistry("token"), deps);
  expect(result).toEqual({
    // Applies to any configured model with no specific additional_rate_limits entry. The
    // window's own limit_window_seconds (604800 = 7 days) labels it, not a vague "account".
    default: { exhausted: true, resetsAt: 1787197007 * 1000, detail: "7d 100% used" },
    // This model has its own entry, so it's unaffected by the account-wide flag.
    perModel: { gpt53codexspark: { exhausted: false, detail: "7d 5% used" } },
  });
});

test("reconcileProviderQuota(openai-codex) reports exhaustion when a rate-limit window is depleted (percent_left)", async () => {
  const deps = fakeDeps(() =>
    jsonResponse({ rate_limit: { primary_window: { percent_left: 0, reset_at: "2030-06-01T00:00:00Z" } } }),
  );
  const result = await reconcileProviderQuota("openai-codex", fakeRegistry("token"), deps);
  expect(result).toEqual({
    default: { exhausted: true, resetsAt: Date.parse("2030-06-01T00:00:00Z"), detail: "account 100% used" },
  });
});

test("reconcileProviderQuota(openai-codex) reports exhaustion when a rate-limit window is depleted (used_percent)", async () => {
  const deps = fakeDeps(() =>
    jsonResponse({ rate_limit: { primary_window: { used_percent: 100, reset_at: "2030-06-01T00:00:00Z" } } }),
  );
  const result = await reconcileProviderQuota("openai-codex", fakeRegistry("token"), deps);
  expect(result).toEqual({
    default: { exhausted: true, resetsAt: Date.parse("2030-06-01T00:00:00Z"), detail: "account 100% used" },
  });
});

test("reconcileProviderQuota(openai-codex) reports headroom when used_percent is low", async () => {
  const deps = fakeDeps(() => jsonResponse({ rate_limit: { primary_window: { used_percent: 12 } } }));
  const result = await reconcileProviderQuota("openai-codex", fakeRegistry("token"), deps);
  expect(result).toEqual({ default: { exhausted: false, detail: "account 12% used" } });
});

test("reconcileProviderQuota(openai-codex) can report a model exhausted independently of a healthy account", async () => {
  const deps = fakeDeps(() =>
    jsonResponse({
      rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 10 } },
      additional_rate_limits: [
        {
          limit_name: "GPT-5.6-Sol",
          rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, reset_at: "2030-06-01T00:00:00Z" } },
        },
      ],
    }),
  );
  const result = await reconcileProviderQuota("openai-codex", fakeRegistry("token"), deps);
  expect(result?.default).toEqual({ exhausted: false, detail: "account 10% used" });
  expect(result?.perModel?.gpt56sol).toEqual({
    exhausted: true,
    resetsAt: Date.parse("2030-06-01T00:00:00Z"),
    detail: "100% used",
  });
});

test("reconcileProviderQuota(zai) reports exhaustion from a TOKENS_LIMIT entry", async () => {
  const deps = fakeDeps(() =>
    jsonResponse({
      data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 100, nextResetTime: 4_102_444_800_000 }] },
    }),
  );
  const result = await reconcileProviderQuota("zai", fakeRegistry("key"), deps);
  expect(result).toEqual({
    default: { exhausted: true, resetsAt: 4_102_444_800_000, detail: "5h 100% used" },
  });
});

test("reconcileProviderQuota(zai) also reports usage from a CREDIT_LIMIT entry (a different plan tier's shape)", async () => {
  // Verified directly against a real "pro" plan account: entries carry `type: "CREDIT_LIMIT"`
  // (with absolute usage/currentValue/remaining alongside it) rather than "TOKENS_LIMIT", but
  // the same `percentage` field either way.
  const deps = fakeDeps(() =>
    jsonResponse({
      data: {
        limits: [
          { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 12000, currentValue: 12023, remaining: 0, percentage: 100 },
          { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 60000, currentValue: 12023, remaining: 47976, percentage: 20 },
        ],
      },
    }),
  );
  const result = await reconcileProviderQuota("zai", fakeRegistry("key"), deps);
  // The 5h window (100%) is more used than the 7d window (20%), so it wins as "most used".
  expect(result).toEqual({ default: { exhausted: true, detail: "5h 100% used" } });
});

test("reconcileProviderQuota(kimi-coding) reports exhaustion when used reaches the weekly limit", async () => {
  const deps = fakeDeps(() => jsonResponse({ usage: { limit: 100, used: 100, resetTime: "2030-01-01T00:00:00Z" } }));
  const result = await reconcileProviderQuota("kimi-coding", fakeRegistry("key"), deps);
  expect(result).toEqual({
    default: { exhausted: true, resetsAt: Date.parse("2030-01-01T00:00:00Z"), detail: "100/100 this week" },
  });
});

test("reconcileProviderQuota(minimax) labels the short window from its real start/end times (observed 5h), not a vague 'interval'", async () => {
  const deps = fakeDeps(() => jsonResponse({}), {
    minimaxCli: async () =>
      JSON.stringify({
        model_remains: [
          {
            model_name: "general",
            start_time: 1_000_000_000_000,
            end_time: 1_000_000_000_000 + 5 * 60 * 60 * 1000,
            current_interval_remaining_percent: 84,
            current_weekly_remaining_percent: 89,
          },
          { model_name: "video", current_interval_remaining_percent: 100, current_weekly_remaining_percent: 100 },
        ],
      }),
  });
  const result = await reconcileProviderQuota("minimax", fakeRegistry(undefined), deps);
  expect(result).toEqual({
    default: { exhausted: false, detail: "5h 16% used, weekly 11% used" },
  });
});

test("reconcileProviderQuota(minimax) falls back to 'interval' when start/end times aren't present", async () => {
  const deps = fakeDeps(() => jsonResponse({}), {
    minimaxCli: async () =>
      JSON.stringify({
        model_remains: [
          { model_name: "general", current_interval_remaining_percent: 84, current_weekly_remaining_percent: 89 },
        ],
      }),
  });
  const result = await reconcileProviderQuota("minimax", fakeRegistry(undefined), deps);
  expect(result).toEqual({
    default: { exhausted: false, detail: "interval 16% used, weekly 11% used" },
  });
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
  expect(result).toEqual({
    default: { exhausted: true, resetsAt: 4_102_444_800_000, detail: "interval 100% used, weekly 50% used" },
  });
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
  expect(result).toEqual({
    default: { exhausted: true, resetsAt: 4_102_444_800_000, detail: "interval 40% used, weekly 99.8% used" },
  });
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

test("reconcileProviderQuota(opencode-go) reports headroom with the most-used window as detail", async () => {
  const deps = fakeDeps(() =>
    jsonResponse({
      usage: {
        rolling: { status: "ok", percent: 0, resetsAt: "2030-01-01T00:00:00Z" },
        weekly: { status: "ok", percent: 0, resetsAt: "2030-01-08T00:00:00Z" },
        monthly: { status: "ok", percent: 20, resetsAt: "2030-02-01T00:00:00Z" },
      },
    }),
  );
  const result = await reconcileProviderQuota("opencode-go", fakeRegistry("key"), deps);
  expect(result).toEqual({ default: { exhausted: false, detail: "monthly 20% used" } });
});

test("reconcileProviderQuota(opencode-go) reports exhaustion when a window's percent crosses the threshold", async () => {
  const deps = fakeDeps(() =>
    jsonResponse({
      usage: { monthly: { status: "ok", percent: 100, resetsAt: "2030-02-01T00:00:00Z" } },
    }),
  );
  const result = await reconcileProviderQuota("opencode-go", fakeRegistry("key"), deps);
  expect(result).toEqual({
    default: { exhausted: true, resetsAt: Date.parse("2030-02-01T00:00:00Z"), detail: "monthly 100% used" },
  });
});

test("reconcileProviderQuota(opencode-go) reports exhaustion from a non-ok status even at low percent", async () => {
  const deps = fakeDeps(() =>
    jsonResponse({
      usage: { rolling: { status: "limited", percent: 10, resetsAt: "2030-01-01T00:00:00Z" } },
    }),
  );
  const result = await reconcileProviderQuota("opencode-go", fakeRegistry("key"), deps);
  expect(result).toEqual({
    default: { exhausted: true, resetsAt: Date.parse("2030-01-01T00:00:00Z"), detail: "rolling 10% used" },
  });
});

test("reconcileProviderQuota(opencode-go) returns undefined without credentials, never calling fetch", async () => {
  let called = false;
  const deps = fakeDeps(() => {
    called = true;
    return jsonResponse({});
  });
  const result = await reconcileProviderQuota("opencode-go", fakeRegistry(undefined), deps);
  expect(result).toBeUndefined();
  expect(called).toBe(false);
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
