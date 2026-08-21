import { expect, test } from "bun:test";
import { resolveWebCwd } from "../web/server/paths.ts";
import { canManageTailscaleServe } from "../web/server/serverConfig.ts";

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

test("only canonical daemon state may manage the machine-wide Tailscale route", () => {
  const agentDir = "/Users/test/.pi/agent";
  expect(
    canManageTailscaleServe("/Users/test/.pi/agent/web/server.json", agentDir),
  ).toBe(true);
  expect(canManageTailscaleServe("/tmp/isolate/server.json", agentDir)).toBe(
    false,
  );
});

test("web cwd resolution rejects unsupported named-user shortcuts", () => {
  expect(() =>
    resolveWebCwd("~someone/project", {
      homeDir: "/Users/test",
      baseDir: "/app",
    }),
  ).toThrow("Only ~ and ~/path");
});
