import {
  applyRuntimeModelStatus,
  isAutoModelReference,
  selectedModelReference,
} from "../model-status.js";
import type { WebSession } from "../protocol.js";
import type { SessionFileCatalog, SessionRecord } from "./server-types.js";
import type { ServerRuntimeState } from "./serverRuntimeState.js";

/**
 * Applies runtime state, usage stats, and subagent tool events onto live
 * session records.
 */
export function createRecordSync(options: {
  catalog: SessionFileCatalog;
  state: ServerRuntimeState;
}) {
  const { catalog, state: runtime } = options;
  const {
    isRecord,
    normalizePath,
    parseSessionMetadataFile,
    toNumber,
    zeroWebUsage,
  } = catalog;

  function updateRecordFromState(
    record: SessionRecord,
    state: unknown,
    expectedModelTurnGeneration?: number,
  ): void {
    const s = state as Record<string, unknown> | undefined;
    if (!s) return;
    const modelStateIsCurrent =
      expectedModelTurnGeneration === undefined ||
      (record.modelTurnGeneration ?? 0) === expectedModelTurnGeneration;
    const model = s.model as Record<string, unknown> | null | undefined;
    if (modelStateIsCurrent && model && typeof model.id === "string") {
      const runtimeModel =
        typeof model.provider === "string" && model.provider
          ? `${model.provider}/${model.id}`
          : model.id;
      const selectedModel = selectedModelReference(record);
      const preservingAutoSelection =
        record.autoTurnActive === true &&
        isAutoModelReference(selectedModel) &&
        !isAutoModelReference(runtimeModel);
      // The settlement refresh can race Auto's asynchronous placeholder
      // restore. While settling, retain the placeholder for any concrete
      // snapshot and clear this phase only when the runtime reports Auto.
      const preservingSettledAutoSelection =
        record.autoTurnSettling === true &&
        isAutoModelReference(selectedModel) &&
        !isAutoModelReference(runtimeModel);
      if (preservingSettledAutoSelection) {
        record.model = selectedModel;
        record.selectedModel = selectedModel;
        if (typeof s.thinkingLevel === "string")
          record.thinkingLevel = s.thinkingLevel;
      } else {
        const next = applyRuntimeModelStatus(
          record,
          runtimeModel,
          typeof s.thinkingLevel === "string" ? s.thinkingLevel : undefined,
          preservingAutoSelection,
        );
        record.model = next.model;
        record.thinkingLevel = next.thinkingLevel;
        record.selectedModel = next.selectedModel;
        if (record.autoTurnSettling === true)
          record.autoTurnSettling = false;
      }
      if (!preservingAutoSelection) record.autoTurnActive = false;
    } else if (modelStateIsCurrent && typeof s.thinkingLevel === "string") {
      record.thinkingLevel = s.thinkingLevel;
    }
    if (typeof s.sessionFile === "string") {
      record.file = s.sessionFile;
      runtime.sessionsByFile.set(normalizePath(s.sessionFile), record);
      const scan = parseSessionMetadataFile(s.sessionFile);
      if (scan?.session.cwd) record.cwd = scan.session.cwd;
      if (scan?.managedWorktreeScanned)
        record.managedWorktree = scan.session.managedWorktree;
    }
    if (typeof s.sessionId === "string") record.id = s.sessionId;
    record.name =
      typeof s.sessionName === "string" && s.sessionName
        ? s.sessionName
        : undefined;
    if (typeof s.messageCount === "number")
      record.messageCount = s.messageCount;
    if (s.isCompacting === true) {
      record.compaction ??= { reason: "threshold", startedAt: Date.now() };
      record.status = "working";
    } else if (s.isCompacting === false) {
      record.compaction = undefined;
      if (s.isStreaming === false && record.status !== "error")
        record.status = "idle";
    }
    record.updatedAt = Date.now();
  }

  function beginTurnModelTracking(record: SessionRecord): number {
    const generation = (record.modelTurnGeneration ?? 0) + 1;
    record.modelTurnGeneration = generation;
    record.autoTurnSettling = false;
    record.autoTurnActive = isAutoModelReference(
      selectedModelReference(record),
    );
    if (!record.autoTurnActive) record.selectedModel ??= record.model;
    return generation;
  }

  function finishTurnModelTracking(record: SessionRecord): void {
    record.modelTurnGeneration = (record.modelTurnGeneration ?? 0) + 1;
    const selectedModel = selectedModelReference(record);
    // Keep the preservation flag through the first settlement refresh. The
    // Auto extension may still be finishing its asynchronous placeholder
    // restore when that get_state request is answered.
    if (record.autoTurnActive && isAutoModelReference(selectedModel)) {
      record.model = selectedModel;
      record.autoTurnSettling = true;
      return;
    }
    record.autoTurnActive = false;
    record.autoTurnSettling = false;
    record.selectedModel ??= record.model;
  }

  function updateRecordFromStats(record: SessionRecord, value: unknown): void {
    if (!isRecord(value)) return;
    if (isRecord(value.tokens)) {
      const usage = record.usage ?? zeroWebUsage();
      usage.input = toNumber(value.tokens.input);
      usage.output = toNumber(value.tokens.output);
      usage.cacheRead = toNumber(value.tokens.cacheRead);
      usage.cacheWrite = toNumber(value.tokens.cacheWrite);
      usage.totalTokens = toNumber(value.tokens.total);
      usage.cost.total = toNumber(value.cost, usage.cost.total);
      record.usage = usage;
    }
    if (isRecord(value.contextUsage)) {
      record.contextUsage = {
        tokens:
          value.contextUsage.tokens === null
            ? null
            : toNumber(value.contextUsage.tokens),
        contextWindow: toNumber(value.contextUsage.contextWindow),
        percent:
          value.contextUsage.percent === null
            ? null
            : toNumber(value.contextUsage.percent),
      };
    }
  }

  function updateSubagentsFromToolEvent(
    record: SessionRecord,
    event: Record<string, unknown>,
  ): boolean {
    if (
      event.type !== "tool_execution_end" ||
      typeof event.toolName !== "string" ||
      !event.toolName.startsWith("subagent_")
    )
      return false;
    const result = isRecord(event.result) ? event.result : undefined;
    const details =
      result && isRecord(result.details) ? result.details : undefined;
    if (!details || !Array.isArray(details.agents)) return false;
    const previous = new Map(
      (record.subagents ?? []).map((agent) => [agent.id, agent]),
    );
    const now = Date.now();
    record.subagents = details.agents.flatMap((value) => {
      if (
        !isRecord(value) ||
        typeof value.id !== "string" ||
        typeof value.status !== "string"
      )
        return [];
      const prior = previous.get(value.id);
      return [
        {
          id: value.id,
          status: value.status as NonNullable<
            WebSession["subagents"]
          >[number]["status"],
          model:
            typeof value.model === "string"
              ? value.model
              : (prior?.model ?? "unknown model"),
          effort:
            typeof value.effort === "string"
              ? value.effort
              : (prior?.effort ?? "off"),
          turns:
            typeof value.turns === "number" ? value.turns : (prior?.turns ?? 0),
          currentTool:
            typeof value.currentTool === "string"
              ? value.currentTool
              : undefined,
          queued:
            typeof value.queued === "number"
              ? value.queued
              : (prior?.queued ?? 0),
          createdAt: prior?.createdAt ?? now,
          updatedAt: now,
          completedAt:
            value.status === "completed" ||
            value.status === "failed" ||
            value.status === "terminated"
              ? now
              : prior?.completedAt,
          error: typeof value.error === "string" ? value.error : prior?.error,
          usage: isRecord(value.usage)
            ? (value.usage as NonNullable<
                WebSession["subagents"]
              >[number]["usage"])
            : prior?.usage,
          transcript: Array.isArray(value.transcript)
            ? value.transcript.flatMap((entry) => {
                if (
                  !isRecord(entry) ||
                  typeof entry.timestamp !== "number" ||
                  typeof entry.role !== "string" ||
                  typeof entry.text !== "string"
                )
                  return [];
                return [
                  {
                    timestamp: entry.timestamp,
                    role: entry.role,
                    text: entry.text,
                  },
                ];
              })
            : prior?.transcript,
          streamingText:
            typeof value.streamingText === "string"
              ? value.streamingText
              : prior?.streamingText,
        },
      ];
    });
    return true;
  }

  function catalogSessionChanged(
    previous: WebSession | undefined,
    next: WebSession,
  ): boolean {
    if (!previous) return true;
    return (
      previous.file !== next.file ||
      previous.cwd !== next.cwd ||
      previous.name !== next.name ||
      previous.branch !== next.branch ||
      previous.model !== next.model ||
      previous.thinkingLevel !== next.thinkingLevel ||
      previous.selectedModel !== next.selectedModel ||
      previous.status !== next.status ||
      previous.source !== next.source ||
      previous.messageCount !== next.messageCount ||
      previous.preview !== next.preview ||
      previous.parentSession !== next.parentSession ||
      previous.pullRequest?.number !== next.pullRequest?.number ||
      previous.pullRequest?.url !== next.pullRequest?.url ||
      previous.compaction?.reason !== next.compaction?.reason ||
      previous.compaction?.startedAt !== next.compaction?.startedAt
    );
  }

  return {
    updateRecordFromState,
    beginTurnModelTracking,
    finishTurnModelTracking,
    updateRecordFromStats,
    updateSubagentsFromToolEvent,
    catalogSessionChanged,
  };
}

export type RecordSync = ReturnType<typeof createRecordSync>;
