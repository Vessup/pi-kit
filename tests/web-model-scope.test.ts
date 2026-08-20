import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filterModelsByScopePatterns,
  modelMatchesScopePattern,
  readEnabledModelPatterns,
  type ScopeFilterModel,
} from "../web/server/modelScope";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

const catalog: ScopeFilterModel[] = [
  { provider: "zai", id: "glm-5.3", name: "GLM 5.3" },
  { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna" },
  { provider: "opencode-go", id: "glm-5.2", name: "GLM 5.2 (opencode)" },
  { provider: "auto", id: "auto", name: "Auto (auto)" },
  { provider: "auto", id: "auto-low", name: "Auto (low)" },
  { provider: "auto", id: "auto-max", name: "Auto (max)" },
];

test("empty pattern list keeps every model", () => {
  expect(filterModelsByScopePatterns(catalog, [])).toEqual(catalog);
});

test("exact provider/id patterns scope the list, case-insensitively", () => {
  const scoped = filterModelsByScopePatterns(catalog, [
    "zai/GLM-5.3",
    "openai-codex/gpt-5.6-luna",
  ]);
  expect(scoped.map((model) => `${model.provider}/${model.id}`)).toEqual([
    "zai/glm-5.3",
    "openai-codex/gpt-5.6-luna",
  ]);
});

test("auto/* glob keeps every Auto Router entry and excludes real providers", () => {
  const scoped = filterModelsByScopePatterns(catalog, ["auto/*"]);
  expect(scoped.map((model) => model.id)).toEqual([
    "auto",
    "auto-low",
    "auto-max",
  ]);
});

test("globs match the bare id but never cross a slash", () => {
  expect(
    modelMatchesScopePattern("*luna*", "openai-codex", {
      id: "gpt-5.6-luna",
    }),
  ).toBe(true);
  // `*` cannot cross the provider boundary in the full form, and the bare id
  // has no slash to protect it either way.
  expect(
    modelMatchesScopePattern("openai*", "openai-codex", { id: "gpt-5.6-luna" }),
  ).toBe(false);
  expect(
    modelMatchesScopePattern("openai-codex/*", "openai-codex", {
      id: "gpt-5.6-luna",
    }),
  ).toBe(true);
});

test("thinking-level suffix is stripped before matching", () => {
  expect(
    modelMatchesScopePattern("zai/glm-5.3:high", "zai", { id: "glm-5.3" }),
  ).toBe(true);
  // A colon that is not a thinking level stays part of the pattern.
  expect(
    modelMatchesScopePattern("zai/glm-5.3:not-a-level", "zai", {
      id: "glm-5.3",
    }),
  ).toBe(false);
});

test("non-glob patterns fall back to partial id and name containment", () => {
  expect(
    modelMatchesScopePattern("luna", "openai-codex", {
      id: "gpt-5.6-luna",
      name: "Luna",
    }),
  ).toBe(true);
  expect(
    modelMatchesScopePattern("GLM 5", "zai", {
      id: "glm-5.3",
      name: "GLM 5.3",
    }),
  ).toBe(true);
});

test("readEnabledModelPatterns reads enabledModels from a settings file", async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-model-scope-"));
  const settingsPath = join(directory, "settings.json");
  await writeFile(
    settingsPath,
    JSON.stringify({
      theme: "dark",
      enabledModels: ["zai/glm-5.3", "auto/*", 42, "  ", null],
    }),
  );
  expect(await readEnabledModelPatterns(settingsPath)).toEqual([
    "zai/glm-5.3",
    "auto/*",
  ]);
});

test("readEnabledModelPatterns returns no scope for missing, malformed, or unscoped settings", async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-model-scope-"));
  const missing = join(directory, "missing.json");
  expect(await readEnabledModelPatterns(missing)).toEqual([]);

  const malformed = join(directory, "malformed.json");
  await writeFile(malformed, "{not json");
  expect(await readEnabledModelPatterns(malformed)).toEqual([]);

  const unscoped = join(directory, "unscoped.json");
  await writeFile(unscoped, JSON.stringify({ theme: "dark" }));
  expect(await readEnabledModelPatterns(unscoped)).toEqual([]);
});
