import { expect, test } from "bun:test";
import { createRecordSync } from "../web/server/recordSync.ts";
import type {
  SessionFileCatalog,
  SessionRecord,
} from "../web/server/server-types.ts";
import type { ServerRuntimeState } from "../web/server/serverRuntimeState.ts";

function recordSync() {
  const catalog = {
    isRecord: (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null,
    normalizePath: (value: string) => value,
    parseSessionMetadataFile: () => undefined,
    toNumber: (value: unknown, fallback = 0) =>
      typeof value === "number" ? value : fallback,
    zeroWebUsage: () => ({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    }),
  } as unknown as SessionFileCatalog;
  const state = {
    sessionsByFile: new Map(),
  } as unknown as ServerRuntimeState;
  return createRecordSync({ catalog, state });
}

test("a stale refresh cannot cancel Auto tracking for a newer turn", () => {
  const sync = recordSync();
  const record = {
    id: "session-1",
    model: "openai-codex/routed",
    selectedModel: "auto/auto",
    thinkingLevel: "high",
    modelTurnGeneration: 2,
    autoTurnActive: true,
    autoTurnSettling: false,
    name: "before",
  } as unknown as SessionRecord;

  sync.updateRecordFromState(
    record,
    {
      model: { provider: "auto", id: "auto" },
      thinkingLevel: "off",
      sessionName: "after",
    },
    1,
  );

  expect(record).toMatchObject({
    model: "openai-codex/routed",
    selectedModel: "auto/auto",
    thinkingLevel: "high",
    modelTurnGeneration: 2,
    autoTurnActive: true,
    name: "after",
  });
});
