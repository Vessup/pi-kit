import { expect, test } from "bun:test";
import { resolveWebCwd } from "../web/server/paths.ts";

test("web cwd resolution expands shell-style home shortcuts", () => {
  expect(resolveWebCwd("~", { homeDir: "/Users/test", baseDir: "/app" })).toBe(
    "/Users/test",
  );
  expect(
    resolveWebCwd("~/projects/pi-kit", {
      homeDir: "/Users/test",
      baseDir: "/app",
    }),
  ).toBe("/Users/test/projects/pi-kit");
  expect(
    resolveWebCwd("  ~/projects/../work  ", {
      homeDir: "/Users/test",
      baseDir: "/app",
    }),
  ).toBe("/Users/test/work");
});

test("web cwd resolution keeps absolute paths and resolves relative paths from the server root", () => {
  expect(
    resolveWebCwd("/tmp/project", { homeDir: "/Users/test", baseDir: "/app" }),
  ).toBe("/tmp/project");
  expect(
    resolveWebCwd("projects/pi-kit", {
      homeDir: "/Users/test",
      baseDir: "/app",
    }),
  ).toBe("/app/projects/pi-kit");
});

test("web cwd resolution rejects unsupported named-user shortcuts", () => {
  expect(() =>
    resolveWebCwd("~someone/project", {
      homeDir: "/Users/test",
      baseDir: "/app",
    }),
  ).toThrow("Only ~ and ~/path");
});
