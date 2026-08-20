import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sessionFooter from "../extensions/session-footer.ts";
import {
  FOOTER_CONTRIBUTION_EVENT,
  type FooterContribution,
} from "../extensions/footer-events.ts";

test("the shared footer places identity, routing, and activity in two rows", () => {
  const hooks = new Map<string, (event: unknown, ctx: unknown) => void>();
  const eventHandlers = new Map<string, (value: unknown) => void>();
  let footerFactory:
    | ((tui: unknown, theme: unknown, footerData: unknown) => {
        render(width: number): string[];
      })
    | undefined;
  const pi = {
    events: {
      on(name: string, handler: (value: unknown) => void) {
        eventHandlers.set(name, handler);
        return () => eventHandlers.delete(name);
      },
    },
    on(name: string, handler: (event: unknown, ctx: unknown) => void) {
      hooks.set(name, handler);
    },
  } as unknown as ExtensionAPI;

  sessionFooter(pi);
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const ctx = {
    mode: "tui",
    model: {
      provider: "provider",
      id: "model",
      reasoning: true,
      contextWindow: 100_000,
    },
    thinkingLevel: "high",
    getContextUsage: () => ({
      tokens: 25_000,
      contextWindow: 100_000,
      percent: 25,
    }),
    sessionManager: {
      getSessionId: () => "session-1",
      getCwd: () => `${home}/repo`,
      getSessionName: () => "Session",
      getEntries: () => [],
    },
    ui: {
      setFooter(factory: typeof footerFactory) {
        footerFactory = factory;
      },
    },
  };
  hooks.get("session_start")?.({}, ctx);

  const emit = (contribution: FooterContribution) =>
    eventHandlers.get(FOOTER_CONTRIBUTION_EVENT)?.(contribution);
  emit({
    sessionId: "session-1",
    key: "web",
    identityPrefix: () => "⧉ ",
  });
  emit({
    sessionId: "session-1",
    key: "pr",
    identitySuffix: () => "PR #17",
  });
  emit({
    sessionId: "session-1",
    key: "auto",
    modelPrefix: () => "Auto (auto)",
  });
  emit({
    sessionId: "session-1",
    key: "subagents",
    statsRight: () => "◐ 1 subagent • 1 working",
  });

  const component = footerFactory?.(
    { requestRender() {} },
    {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
    },
    {
      getGitBranch: () => "main",
      getAvailableProviderCount: () => 2,
      getExtensionStatuses: () => new Map(),
      onBranchChange: () => () => undefined,
    },
  );
  expect(component).toBeDefined();
  const lines = component?.render(100) ?? [];
  expect(lines).toHaveLength(2);
  expect(lines[0]).toStartWith("⧉  ~/repo (main) • Session • PR #17");
  expect(lines[0]).toEndWith(
    "Auto (auto) • (provider) model • high",
  );
  expect(lines[1]).toStartWith("25.0%/100k");
  expect(lines[1]).toEndWith("◐ 1 subagent • 1 working");
});
