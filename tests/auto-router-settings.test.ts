import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allConfiguredModels,
  AUTO_MODEL_SCOPE_PATTERN,
  type AutoRouterSettings,
  ensureAutoModelScoped,
  escalationTiers,
  parseAutoRouterSettings,
  resolveEffortTier,
  writeAutoRouterSettingsFile,
} from "../extensions/auto-router-settings.ts";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function settingsPath(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), "pi-kit-auto-router-settings-"));
  return join(directory, "settings.json");
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

const EXAMPLE: AutoRouterSettings = {
  efforts: {
    medium: {
      models: [
        { provider: "minimax", id: "m3" },
        { provider: "openai", id: "gpt-5.3-codex" },
      ],
    },
    high: {
      models: [
        { provider: "moonshot", id: "kimi-k3-max" },
        { provider: "zhipu", id: "glm-5.3-max" },
      ],
    },
    xhigh: { models: [{ provider: "openai", id: "sol-5.6-xhigh" }] },
  },
};

test("parseAutoRouterSettings accepts a well-formed config", () => {
  expect(parseAutoRouterSettings(EXAMPLE)).toEqual(EXAMPLE);
});

test("parseAutoRouterSettings drops unknown effort levels", () => {
  const parsed = parseAutoRouterSettings({
    efforts: {
      medium: { models: [{ provider: "a", id: "b" }] },
      turbo: { models: [{ provider: "a", id: "b" }] },
    },
  });
  expect(Object.keys(parsed.efforts)).toEqual(["medium"]);
});

test("parseAutoRouterSettings drops malformed model refs and empty tiers", () => {
  const parsed = parseAutoRouterSettings({
    efforts: {
      medium: {
        models: [{ provider: "a", id: "b" }, { provider: "a" }, { id: "b" }, "nope", 42],
      },
      high: { models: [] },
      xhigh: { models: [{ provider: "", id: "b" }] },
    },
  });
  expect(parsed.efforts.medium?.models).toEqual([{ provider: "a", id: "b" }]);
  expect(parsed.efforts.high).toBeUndefined();
  expect(parsed.efforts.xhigh).toBeUndefined();
});

test("parseAutoRouterSettings tolerates garbage input", () => {
  expect(parseAutoRouterSettings(null)).toEqual({ efforts: {} });
  expect(parseAutoRouterSettings("nope")).toEqual({ efforts: {} });
  expect(parseAutoRouterSettings({})).toEqual({ efforts: {} });
});

test("resolveEffortTier returns the level itself when configured", () => {
  expect(resolveEffortTier(EXAMPLE, "high")).toBe("high");
  expect(resolveEffortTier(EXAMPLE, "xhigh")).toBe("xhigh");
});

test("resolveEffortTier falls back toward medium when the classified level is unconfigured", () => {
  // low is unset; steps up to medium, matching the request's own example.
  expect(resolveEffortTier(EXAMPLE, "low")).toBe("medium");
  expect(resolveEffortTier(EXAMPLE, "minimal")).toBe("medium");
  expect(resolveEffortTier(EXAMPLE, "off")).toBe("medium");
});

test("resolveEffortTier never overshoots past medium to a configured higher tier", () => {
  const onlyXhigh: AutoRouterSettings = {
    efforts: { xhigh: { models: [{ provider: "a", id: "b" }] } },
  };
  // high is unconfigured; walking toward medium never considers xhigh even though it exists.
  expect(resolveEffortTier(onlyXhigh, "high")).toBe("medium");
});

test("escalationTiers walks strictly upward through configured tiers only", () => {
  expect(escalationTiers(EXAMPLE, "medium")).toEqual(["high", "xhigh"]);
  expect(escalationTiers(EXAMPLE, "high")).toEqual(["xhigh"]);
  expect(escalationTiers(EXAMPLE, "xhigh")).toEqual([]);
});

test("escalationTiers skips tiers below fromTier even if configured", () => {
  const settings: AutoRouterSettings = {
    efforts: {
      medium: { models: [{ provider: "a", id: "b" }] },
      xhigh: { models: [{ provider: "c", id: "d" }] },
    },
  };
  expect(escalationTiers(settings, "high")).toEqual(["xhigh"]);
});

test("allConfiguredModels lists every model in tier order, deduplicated", () => {
  const settings: AutoRouterSettings = {
    efforts: {
      medium: { models: [{ provider: "a", id: "b" }] },
      high: {
        models: [
          { provider: "a", id: "b" },
          { provider: "c", id: "d" },
        ],
      },
    },
  };
  expect(allConfiguredModels(settings)).toEqual([
    { provider: "a", id: "b" },
    { provider: "c", id: "d" },
  ]);
});

test("auto router settings write preserves unrelated Pi and extension keys", async () => {
  const path = await settingsPath();
  await writeFile(
    path,
    JSON.stringify({ theme: "dark", web: { tailscale: { enabled: true } } }),
  );
  await writeAutoRouterSettingsFile(path, EXAMPLE);
  expect(await readSettings(path)).toEqual({
    theme: "dark",
    web: { tailscale: { enabled: true } },
    autoRouter: EXAMPLE,
  });
});

test("concurrent auto router settings updates remain valid and retain unrelated keys", async () => {
  const path = await settingsPath();
  await writeFile(path, JSON.stringify({ theme: "light" }));
  const other: AutoRouterSettings = { efforts: { medium: { models: [{ provider: "x", id: "y" }] } } };
  await Promise.all([
    writeAutoRouterSettingsFile(path, EXAMPLE),
    writeAutoRouterSettingsFile(path, other),
  ]);
  const result = (await readSettings(path)) as { theme?: string; autoRouter?: AutoRouterSettings };
  expect(result.theme).toBe("light");
  expect([EXAMPLE, other]).toContainEqual(result.autoRouter);
});

test("malformed settings reject without leaking the cross-process lock", async () => {
  const path = await settingsPath();
  await writeFile(path, "{broken");
  await expect(writeAutoRouterSettingsFile(path, EXAMPLE)).rejects.toThrow("Could not read");
  await writeFile(path, JSON.stringify({ recovered: true }));
  await writeAutoRouterSettingsFile(path, EXAMPLE);
  expect(await readSettings(path)).toEqual({ recovered: true, autoRouter: EXAMPLE });
});

test("ensureAutoModelScoped adds Auto's pattern when scoping is configured", async () => {
  const path = await settingsPath();
  await writeFile(path, JSON.stringify({ enabledModels: ["claude-*", "gpt-4o"] }));
  await ensureAutoModelScoped(path);
  expect(await readSettings(path)).toEqual({
    enabledModels: ["claude-*", "gpt-4o", AUTO_MODEL_SCOPE_PATTERN],
  });
});

test("ensureAutoModelScoped is a no-op when Auto's pattern is already present", async () => {
  const path = await settingsPath();
  await writeFile(path, JSON.stringify({ enabledModels: ["claude-*", AUTO_MODEL_SCOPE_PATTERN] }));
  await ensureAutoModelScoped(path);
  expect(await readSettings(path)).toEqual({
    enabledModels: ["claude-*", AUTO_MODEL_SCOPE_PATTERN],
  });
});

test("ensureAutoModelScoped is a no-op when no scoping is configured", async () => {
  const path = await settingsPath();
  await writeFile(path, JSON.stringify({ theme: "dark" }));
  await ensureAutoModelScoped(path);
  expect(await readSettings(path)).toEqual({ theme: "dark" });
});

test("ensureAutoModelScoped is a no-op when enabledModels is an empty array", async () => {
  const path = await settingsPath();
  await writeFile(path, JSON.stringify({ enabledModels: [] }));
  await ensureAutoModelScoped(path);
  expect(await readSettings(path)).toEqual({ enabledModels: [] });
});

test("ensureAutoModelScoped preserves unrelated keys", async () => {
  const path = await settingsPath();
  await writeFile(
    path,
    JSON.stringify({ theme: "dark", enabledModels: ["gpt-4o"], autoRouter: EXAMPLE }),
  );
  await ensureAutoModelScoped(path);
  expect(await readSettings(path)).toEqual({
    theme: "dark",
    enabledModels: ["gpt-4o", AUTO_MODEL_SCOPE_PATTERN],
    autoRouter: EXAMPLE,
  });
});
