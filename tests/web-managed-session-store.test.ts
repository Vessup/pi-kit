import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ManagedSessionStore } from "../web/server/managed-session-store.ts";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

test("managed web session ownership survives restart and follows replacement files", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-managed-session-store-"));
  const path = join(tempDir, "web", "managed-sessions.json");
  const original = join(tempDir, "sessions", "original.jsonl");
  const replacement = join(tempDir, "sessions", "replacement.jsonl");
  const store = new ManagedSessionStore(path);

  store.add(original);
  expect(new ManagedSessionStore(path).has(original)).toBe(true);
  store.replace(original, replacement);
  expect(store.has(original)).toBe(false);
  expect(store.has(replacement)).toBe(true);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    version: 1,
    files: [resolve(replacement)],
  });

  store.delete(replacement);
  expect(new ManagedSessionStore(path).list()).toEqual([]);
});

test("malformed managed session ownership fails closed", async () => {
  tempDir = await mkdtemp(
    join(tmpdir(), "pi-kit-managed-session-store-invalid-"),
  );
  const path = join(tempDir, "managed-sessions.json");
  await Bun.write(path, JSON.stringify({ version: 1, files: [42] }));
  expect(() => new ManagedSessionStore(path)).toThrow(
    "invalid managed session store",
  );
});
