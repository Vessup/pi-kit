import { expect, test } from "bun:test";
import { createRecordSync } from "../web/server/recordSync.ts";
import { mergedLastModel } from "../web/server/sessionRegistry.ts";
import type {
  SessionFileCatalog,
  SessionRecord,
} from "../web/server/server-types.ts";
import type { ServerRuntimeState } from "../web/server/serverRuntimeState.ts";

function recordSync(
  parseSessionMetadataFile: SessionFileCatalog["parseSessionMetadataFile"] =
    () => undefined,
) {
  const catalog = {
    isRecord: (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null,
    normalizePath: (value: string) => value,
    parseSessionMetadataFile,
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

test("model refresh payloads preserve the authoritative session name", () => {
  const sync = recordSync();
  const record = {
    id: "session-1",
    name: "Named session",
    status: "idle",
  } as unknown as SessionRecord;

  sync.updateRecordFromState(record, {
    thinkingLevel: "high",
    sessionName: "Named session",
  });
  expect(record.name).toBe("Named session");

  sync.updateRecordFromState(record, { thinkingLevel: "high" });
  expect(record.name).toBeUndefined();
});

test("catalog comparisons normalize explicit last-model clears", () => {
  const sync = recordSync();
  const previous = {
    id: "session-1",
    lastModel: undefined,
  } as unknown as SessionRecord;
  const next = {
    id: "session-1",
    lastModel: null,
  } as unknown as SessionRecord;

  expect(sync.catalogSessionChanged(previous, next)).toBe(false);
  next.lastModel = "provider/routed";
  expect(sync.catalogSessionChanged(previous, next)).toBe(true);
});

test("session merges preserve only the current Auto selection's route", () => {
  const previous = {
    model: "auto/auto",
    selectedModel: "auto/auto",
    lastModel: "provider/previous",
  };
  expect(
    mergedLastModel(previous, {
      model: "auto/auto",
      selectedModel: "auto/auto",
      lastModel: undefined,
    }),
  ).toBe("provider/previous");
  expect(
    mergedLastModel(previous, {
      model: "auto/auto-high",
      selectedModel: "auto/auto-high",
      lastModel: undefined,
    }),
  ).toBeUndefined();
  expect(
    mergedLastModel(previous, {
      model: "provider/manual",
      selectedModel: "provider/manual",
      lastModel: undefined,
    }),
  ).toBeUndefined();
  expect(
    mergedLastModel(previous, {
      model: "auto/auto",
      selectedModel: "auto/auto",
      lastModel: null,
    }),
  ).toBeUndefined();
});

test("a stale turn-start snapshot recovers the routed model from session metadata", () => {
  const sync = recordSync(() => ({
    session: {
      selectedModel: "auto/auto",
      lastModel: "provider/routed",
    },
  }) as ReturnType<SessionFileCatalog["parseSessionMetadataFile"]>);
  const record = {
    id: "session-1",
    model: "auto/auto",
    selectedModel: "auto/auto",
    modelTurnGeneration: 2,
    autoTurnActive: true,
    autoTurnSettling: true,
    status: "idle",
  } as unknown as SessionRecord;

  sync.updateRecordFromState(
    record,
    {
      model: { provider: "auto", id: "auto" },
      sessionFile: "/tmp/session.jsonl",
    },
    1,
  );

  expect(record).toMatchObject({
    model: "auto/auto",
    selectedModel: "auto/auto",
    lastModel: "provider/routed",
    modelTurnGeneration: 2,
  });
});

test("durable recovery cannot replace a route from a newer turn", () => {
  const sync = recordSync(() => ({
    session: {
      selectedModel: "auto/auto",
      lastModel: "provider/older",
    },
  }) as ReturnType<SessionFileCatalog["parseSessionMetadataFile"]>);
  const record = {
    id: "session-1",
    model: "auto/auto",
    selectedModel: "auto/auto",
    lastModel: "provider/newer",
    modelTurnGeneration: 2,
    autoTurnActive: true,
    autoTurnSettling: false,
    status: "working",
  } as unknown as SessionRecord;

  sync.updateRecordFromState(
    record,
    {
      model: { provider: "auto", id: "auto" },
      sessionFile: "/tmp/session.jsonl",
    },
    1,
  );

  expect(record.lastModel).toBe("provider/newer");
});

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
    status: "working",
    name: "before",
  } as unknown as SessionRecord;

  sync.updateRecordFromState(
    record,
    {
      model: { provider: "auto", id: "auto" },
      thinkingLevel: "off",
      isCompacting: false,
      isStreaming: false,
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
    status: "working",
    name: "after",
  });
});
