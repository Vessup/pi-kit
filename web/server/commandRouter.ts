import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { isPrivateWebSessionCommand } from "../compact-command.js";
import type {
  ClientCommandMessage,
  RpcSessionCommand,
  ServerEventMessage,
  ServerSessionMessage,
} from "../protocol.js";
import { hasActiveWebSubagents } from "../protocol.js";
import { expandSlashCommand } from "../slash-commands.js";
import { formatWorktreeCreateCommandArgs } from "../worktree-command.js";
import type { ClientBroadcast } from "./clientBroadcast.js";
import type { GitMetadata } from "./gitMetadata.js";
import {
  CommandDeliveryUncertainError,
  isUncertainRpcDeliveryCommand,
} from "./managed-rpc-session.js";
import type { ManagedSessionRefresh } from "./managedSessionRefresh.js";
import { modelSelectionBlocksPrompts } from "./model-selection-gate.js";
import {
  filterModelsByScopePatterns,
  readEnabledModelPatterns,
} from "./modelScope.js";
import type { RpcSessionFactory } from "./rpcSessions.js";
import type {
  ExternalPendingRequest,
  SessionFileCatalog,
  SessionQueueCoordinator,
  SessionRecord,
} from "./server-types.js";
import type { WebServerConfig } from "./serverConfig.js";
import { LONG_RUNNING_COMMAND_TIMEOUT_MS } from "./serverConfig.js";
import type { SessionRegistry } from "./sessionRegistry.js";
import { SlashCommandService } from "./slash-command-service.js";
import {
  hasOtherSessionInWorktree,
  managedWorktreeFromEntries,
  removeManagedWorktree,
} from "./worktrees.js";

export function shouldDeferManagedModelSelection(
  record: Pick<
    SessionRecord,
    | "agentRunning"
    | "settlingGeneration"
    | "compaction"
    | "applyingModelSelection"
  >,
): boolean {
  return Boolean(
    record.agentRunning ||
      record.settlingGeneration !== undefined ||
      record.compaction ||
      record.applyingModelSelection,
  );
}

/**
 * Routes client commands to the right transport: the managed RPC runtime,
 * the external agent socket, or an ad-hoc RPC session for saved sessions.
 * Also owns the daemon-wide slash command discovery service.
 */
export function createCommandRouter(options: {
  config: WebServerConfig;
  catalog: SessionFileCatalog;
  queue: SessionQueueCoordinator;
  registry: SessionRegistry;
  broadcast: ClientBroadcast;
  refresh: ManagedSessionRefresh;
  git: GitMetadata;
  rpcSessions: RpcSessionFactory;
}) {
  const { catalog, queue, registry, broadcast, refresh, git, rpcSessions } =
    options;
  const {
    normalizePath,
    canonicalSessionFile,
    isWithinDir,
    parseSessionMetadataFile,
    parseSessionFile,
    deriveForkMessages,
    isRecord,
  } = catalog;
  const { sessionsDir } = options.config;
  const {
    routeQueueCommand,
    flushWebQueue,
    markAgentActivity,
    cancelQueueSettleFallback,
    scheduleQueueSettleFallback,
  } = queue;
  const { sessionToClientPayload } = registry;
  const { broadcast: broadcastToSessionClients } = broadcast;
  const { refreshManagedSession } = refresh;
  const { hydrateGitMetadata } = git;
  const { createRpcSession } = rpcSessions;

  const slashCommands = new SlashCommandService(normalizePath, (cwd) =>
    createRpcSession({
      cwd,
      noSession: true,
      onEvent: () => undefined,
      onExit: () => undefined,
    }),
  );

  async function applyManagedModelSelection(
    record: SessionRecord,
    selection: { provider: string; modelId: string },
  ): Promise<void> {
    if (!record.managed) throw new Error(`Session ${record.id} is not managed`);
    await record.managed.setModel(selection.provider, selection.modelId);
    record.modelTurnGeneration = (record.modelTurnGeneration ?? 0) + 1;
    record.autoTurnActive = false;
    record.autoTurnSettling = false;
    record.lastModel = undefined;
    record.modelSelectionError = undefined;
    try {
      await refreshManagedSession(record);
    } catch (error) {
      // setModel already succeeded. A transient metadata refresh must not keep
      // prompts blocked as if the requested model had failed to apply.
      console.error(
        `Could not refresh ${record.id} after model selection: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function flushPendingModelSelection(
    record: SessionRecord,
  ): Promise<void> | undefined {
    if (record.modelSelectionFlush) return record.modelSelectionFlush;
    if (!record.managed || !record.pendingModelSelection) return undefined;
    record.applyingModelSelection = true;
    const operation = (async () => {
      try {
        while (record.pendingModelSelection && record.managed) {
          const selection = record.pendingModelSelection;
          record.pendingModelSelection = undefined;
          try {
            await applyManagedModelSelection(record, selection);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            record.modelSelectionError = message;
            console.error(
              `Could not apply deferred model selection for ${record.id}: ${message}`,
            );
            broadcastToSessionClients(record.id, {
              type: "server.event",
              sessionId: record.id,
              event: { type: "model_selection_error", message },
            } satisfies ServerEventMessage);
          }
        }
        if (record.modelSelectionError)
          throw new Error(record.modelSelectionError);
      } finally {
        record.applyingModelSelection = false;
      }
    })();
    record.modelSelectionFlush = operation;
    const clearOperation = () => {
      if (record.modelSelectionFlush === operation)
        record.modelSelectionFlush = undefined;
    };
    void operation.then(clearOperation, clearOperation);
    return operation;
  }

  async function runRpcSessionCommand(
    record: SessionRecord,
    command: RpcSessionCommand,
  ): Promise<unknown> {
    if (record.managed) {
      switch (command.type) {
        case "clone":
          return await record.managed.clone();
        case "fork":
          return await record.managed.fork(command.entryId);
        case "get_fork_messages":
          return await record.managed.getForkMessages();
        case "set_session_name":
          await record.managed.setSessionName(command.name);
          return undefined;
        case "compact":
          return await record.managed.compact(command.customInstructions);
        case "bash":
          return await record.managed.bash(command.command);
        case "extension_ui_response":
          return await record.managed.respondToExtensionUi(command);
      }
    }
    if (record.file && isWithinDir(record.file, sessionsDir)) {
      const scan = parseSessionMetadataFile(record.file);
      if (scan) {
        const temp = createRpcSession({
          cwd: scan.session.cwd,
          name: scan.session.name,
          sessionFile: record.file,
          onEvent: (event) => {
            if (typeof event === "object" && event && "type" in event) {
              broadcastToSessionClients(record.id, {
                type: "server.event",
                sessionId: record.id,
                event: event as Record<string, unknown>,
              } satisfies ServerEventMessage);
            }
          },
          onExit: () => undefined,
        });
        try {
          await temp.start();
          switch (command.type) {
            case "clone":
              return await temp.clone();
            case "fork":
              return await temp.fork(command.entryId);
            case "get_fork_messages": {
              const response = await temp.getForkMessages();
              return response;
            }
            case "set_session_name":
              await temp.setSessionName(command.name);
              return undefined;
            case "compact":
              return await temp.compact(command.customInstructions);
            case "bash":
              return await temp.bash(command.command);
            case "extension_ui_response":
              throw new Error(
                "No extension UI request is active for this saved session",
              );
          }
        } finally {
          await temp.shutdown();
        }
      }
    }
    if (command.type === "get_fork_messages") {
      return { messages: deriveForkMessages(record.history) };
    }
    throw new Error(`Session ${record.id} is not managed`);
  }

  async function routeCommand(
    record: SessionRecord,
    command: ClientCommandMessage["command"],
  ): Promise<unknown> {
    const changesManagedIdentity =
      Boolean(record.managed) &&
      (command.type === "clone" ||
        command.type === "fork" ||
        command.type === "create_worktree" ||
        command.type === "create_worktree_v2");
    if (changesManagedIdentity) {
      if (record.managedIdentityOperation)
        throw new Error(
          `Another session replacement is already in progress (${record.managedIdentityOperation})`,
        );
      record.managedIdentityOperation = command.type;
      try {
        return await routeCommandCore(record, command);
      } finally {
        record.managedIdentityOperation = undefined;
      }
    }
    if (command.type !== "prompt")
      return await routeCommandCore(record, command);

    const shouldMarkWorking =
      record.status !== "working" || record.agentRunning !== true;
    const previousStatus = record.status;
    const previousAgentRunning = record.agentRunning;
    const previousActivityGeneration = record.activityGeneration;
    const agentStartGeneration = record.agentStartGeneration ?? 0;
    if (shouldMarkWorking) {
      markAgentActivity(record);
      cancelQueueSettleFallback(record);
      record.status = "working";
      record.agentRunning = true;
      record.updatedAt = Date.now();
      broadcastToSessionClients(record.id, {
        type: "server.session",
        session: sessionToClientPayload(record),
      } satisfies ServerSessionMessage);
    }
    try {
      return await routeCommandCore(record, command);
    } catch (error) {
      if (
        shouldMarkWorking &&
        (record.agentStartGeneration ?? 0) === agentStartGeneration
      ) {
        record.status = previousStatus;
        record.agentRunning = previousAgentRunning;
        record.activityGeneration = previousActivityGeneration;
        broadcastToSessionClients(record.id, {
          type: "server.session",
          session: sessionToClientPayload(record),
        } satisfies ServerSessionMessage);
        if (
          record.status === "idle" &&
          record.agentRunning !== true &&
          record.queue.length > 0
        ) {
          scheduleQueueSettleFallback(record);
        }
      }
      throw error;
    }
  }

  async function routeCommandCore(
    record: SessionRecord,
    command: ClientCommandMessage["command"],
  ): Promise<unknown> {
    if (
      command.type === "create_worktree" ||
      command.type === "create_worktree_v2"
    ) {
      const value = command as unknown as Record<string, unknown>;
      if ("existing" in value) {
        if (typeof value.existing !== "string" || !value.existing.trim())
          throw new Error("create_worktree existing path is required");
        if (
          ["name", "repository", "branch", "startPoint"].some(
            (key) => value[key] !== undefined,
          )
        ) {
          throw new Error(
            "create_worktree existing mode cannot include create-mode fields",
          );
        }
      } else {
        if (typeof value.name !== "string" || !value.name.trim())
          throw new Error("create_worktree name is required");
        if (typeof value.repository !== "string" || !value.repository.trim())
          throw new Error("create_worktree repository is required");
        if (
          value.branch !== undefined &&
          (typeof value.branch !== "string" || !value.branch.trim())
        )
          throw new Error("create_worktree branch must be a non-empty string");
        if (
          value.startPoint !== undefined &&
          (typeof value.startPoint !== "string" || !value.startPoint.trim())
        )
          throw new Error(
            "create_worktree startPoint must be a non-empty string",
          );
      }
    }
    if (
      command.type === "steer_queue_item" ||
      command.type === "replace_queue" ||
      command.type === "reconcile_queue"
    ) {
      return await routeQueueCommand(record, command);
    }
    if (command.type === "reload" && record.managed) {
      const settled =
        (record.status === "idle" || record.status === "error") &&
        record.agentRunning !== true;
      if (!settled || hasActiveWebSubagents(record.subagents))
        throw new Error(
          "Wait for Pi and its subagents to become idle before reloading",
        );
      await record.managed.reload();
      await refreshManagedSession(record);
      record.status = "idle";
      broadcastToSessionClients(record.id, {
        type: "server.session",
        session: sessionToClientPayload(record),
      } satisfies ServerSessionMessage);
      slashCommands.invalidate(record.cwd);
      return { reloaded: true };
    }
    if (command.type === "reload" && hasActiveWebSubagents(record.subagents)) {
      throw new Error(
        "Wait for Pi and its subagents to become idle before reloading",
      );
    }
    if (command.type === "reload" && record.agentSockets.size === 0) {
      throw new Error(`Session ${record.id} is not active`);
    }
    if (command.type === "get_commands") {
      if (record.managed) {
        const { commands } = await record.managed.getCommands();
        return {
          commands: slashCommands.toWeb(slashCommands.parse(commands), true),
        };
      }
      return {
        commands: slashCommands.toWeb(await slashCommands.discover(record.cwd)),
      };
    }
    if (
      (command.type === "create_worktree" ||
        command.type === "create_worktree_v2") &&
      hasActiveWebSubagents(record.subagents)
    ) {
      throw new Error(
        "Wait for Pi and its subagents to become idle before creating a worktree",
      );
    }
    if (
      (command.type === "create_worktree" ||
        command.type === "create_worktree_v2") &&
      record.managed
    ) {
      if (record.status !== "idle")
        throw new Error(
          "Wait for Pi to become idle before creating a worktree",
        );
      const previousId = record.id;
      const previousFile = record.file
        ? canonicalSessionFile(record.file)
        : undefined;
      if (!previousFile)
        throw new Error("The current conversation is not persisted yet");
      const previousManagedWorktree =
        record.managedWorktree ??
        managedWorktreeFromEntries(
          parseSessionFile(previousFile)?.entries ?? [],
        );
      record.pendingWorktreeSourceDeletion = {
        sessionId: previousId,
        sessionFile: previousFile,
      };
      const invocation =
        "existing" in command
          ? `/worktree --existing ${JSON.stringify(command.existing)}`
          : `/worktree ${formatWorktreeCreateCommandArgs(command)}`;
      try {
        await record.managed.worktree(invocation);
        await refreshManagedSession(record);
        if (record.id === previousId)
          throw new Error("Pi did not switch to the worktree session");
        if (existsSync(previousFile))
          throw new Error(
            `Source session was not deleted after replacement: ${previousFile}`,
          );
      } catch (error) {
        if (record.id === previousId)
          record.pendingWorktreeSourceDeletion = undefined;
        throw error;
      }
      if (
        previousManagedWorktree &&
        !hasOtherSessionInWorktree(
          sessionsDir,
          previousFile,
          previousManagedWorktree.path,
        )
      ) {
        try {
          const cleanup = removeManagedWorktree(previousManagedWorktree);
          if (cleanup.branchWarning)
            console.warn(
              `Removed previous worktree ${previousManagedWorktree.path}, but could not delete branch ${previousManagedWorktree.branch}: ${cleanup.branchWarning}`,
            );
        } catch (error) {
          console.warn(
            `Source session was deleted, but previous managed worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      await hydrateGitMetadata(record);
      return {
        cancelled: false,
        sessionId: record.id,
        path: record.cwd,
        branch: record.branch,
      };
    }
    if (
      (command.type === "create_worktree" ||
        command.type === "create_worktree_v2") &&
      record.agentSockets.size === 0
    ) {
      throw new Error(`Session ${record.id} is not active`);
    }
    if (record.managed) {
      switch (command.type) {
        case "get_session_options": {
          const [{ models }, { levels }, { commands }] = await Promise.all([
            record.managed.getAvailableModels(),
            record.managed.getAvailableThinkingLevels(),
            record.managed.getCommands(),
          ]);
          const webCommands = commands.flatMap((command) => {
            const sourceInfo = isRecord(command.sourceInfo)
              ? command.sourceInfo
              : undefined;
            if (
              typeof command.name !== "string" ||
              isPrivateWebSessionCommand(command.name) ||
              (command.source !== "extension" &&
                command.source !== "prompt" &&
                command.source !== "skill")
            )
              return [];
            return [
              {
                name: command.name,
                description:
                  typeof command.description === "string"
                    ? command.description
                    : undefined,
                source: command.source,
                location:
                  sourceInfo &&
                  (sourceInfo.scope === "user" ||
                    sourceInfo.scope === "project" ||
                    sourceInfo.scope === "temporary")
                    ? sourceInfo.scope
                    : undefined,
              },
            ];
          });
          if (!webCommands.some((command) => command.name === "reload")) {
            webCommands.unshift({
              name: "reload",
              description:
                "Reload extensions, skills, prompts, themes, and context files",
              source: "extension",
              location: "temporary",
            });
          }
          // Managed sessions have no bridge to forward a resolved scope, so
          // their scope is whatever `enabledModels` says in the shared
          // settings file (the daemon spawns them without --models). Bridge
          // sessions instead carry their resolved scope on the record.
          const scopePatterns = record.scopedModels
            ? record.scopedModels.map(
                (model) => `${model.provider}/${model.id}`,
              )
            : await readEnabledModelPatterns(options.config.settingsPath);
          const modelOptions = models.map((model) => {
            const thinkingLevels = getSupportedThinkingLevels(
              model as unknown as Model<Api>,
            );
            return {
              provider: String(model.provider ?? ""),
              id: String(model.id ?? ""),
              name: String(model.name ?? model.id ?? ""),
              reasoning: model.reasoning === true,
              thinkingLevels: [...thinkingLevels],
            };
          });
          return {
            models: filterModelsByScopePatterns(modelOptions, scopePatterns),
            thinkingLevels: levels,
            commands: webCommands,
          };
        }
        case "set_model":
          if (shouldDeferManagedModelSelection(record)) {
            // Keep only the latest choice. Applying set_model while Pi is still
            // settling aborts the active run and surfaces a misleading failure.
            record.pendingModelSelection = {
              provider: command.provider,
              modelId: command.modelId,
            };
            return { deferred: true };
          }
          // A browser model change is explicit user selection, not the Auto
          // router's transient runtime swap. Only invalidate Auto tracking
          // after the runtime accepts the new model.
          {
            const releasesBlockedQueue = Boolean(record.modelSelectionError);
            await applyManagedModelSelection(record, command);
            if (releasesBlockedQueue && record.status !== "working")
              void flushWebQueue(record);
          }
          return;
        case "set_thinking_level":
          await record.managed.setThinkingLevel(command.level);
          await refreshManagedSession(record);
          return;
        case "prompt":
          return await record.managed.prompt(
            command.message,
            command.streamingBehavior,
            command.images,
          );
        case "abort":
          // Stop is accepted once its RPC request is written. Do not hold the web
          // response open while compaction and subagent teardown finish.
          await record.managed.abort();
          return { accepted: true };
        case "bash":
          return await record.managed.bash(command.command);
        case "clone": {
          const result = await record.managed.clone();
          await refreshManagedSession(record);
          return result;
        }
        case "fork": {
          const result = await record.managed.fork(command.entryId);
          await refreshManagedSession(record);
          return result;
        }
        case "get_fork_messages":
          return await record.managed.getForkMessages();
        case "set_session_name":
          await record.managed.setSessionName(command.name);
          return undefined;
        case "compact":
          return await record.managed.compact(command.customInstructions);
        case "extension_ui_response":
          return await record.managed.respondToExtensionUi(command);
      }
    }
    if (record.agentSockets.size > 0) {
      let externalCommand: ClientCommandMessage["command"] = command;
      if (
        command.type === "create_worktree" &&
        !("existing" in command) &&
        (command.branch || command.startPoint)
      ) {
        externalCommand = { ...command, type: "create_worktree_v2" };
      }
      if (command.type === "prompt" && command.message.startsWith("/")) {
        const commands = await slashCommands.discover(record.cwd);
        externalCommand = {
          ...command,
          message: await expandSlashCommand(commands, command.message, {
            rejectExtensionCommands: true,
          }),
        };
      }
      const target = Array.from(record.agentSockets)[0];
      const requestId = randomUUID();
      if (command.type === "abort") {
        // Socket delivery is the acknowledgement boundary. New bridges also reply
        // before teardown, but this keeps Stop responsive with older bridges.
        target.send(
          JSON.stringify({
            type: "agent.command",
            requestId,
            command: externalCommand,
          } satisfies {
            type: "agent.command";
            requestId: string;
            command: ClientCommandMessage["command"];
          }),
        );
        return { accepted: true };
      }
      const data = await new Promise<unknown>((resolve, reject) => {
        const timeoutMs =
          command.type === "compact" ||
          command.type === "bash" ||
          command.type === "create_worktree" ||
          command.type === "create_worktree_v2" ||
          command.type === "reload"
            ? LONG_RUNNING_COMMAND_TIMEOUT_MS
            : 30_000;
        let pendingRequest: ExternalPendingRequest;
        const timeout = setTimeout(() => {
          const owner = pendingRequest.owner ?? record;
          owner.externalPending.delete(requestId);
          owner.externalRequestTargets.delete(requestId);
          const message = "Pi session command timed out";
          reject(
            isUncertainRpcDeliveryCommand(command.type)
              ? new CommandDeliveryUncertainError(message)
              : new Error(message),
          );
        }, timeoutMs);
        pendingRequest = {
          owner: record,
          surviveDisconnect:
            command.type === "reload" ||
            command.type === "create_worktree" ||
            command.type === "create_worktree_v2",
          commandType: command.type,
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        };
        record.externalPending.set(requestId, pendingRequest);
        record.externalRequestTargets.set(requestId, target);
        try {
          target.send(
            JSON.stringify({
              type: "agent.command",
              requestId,
              command: externalCommand,
            } satisfies {
              type: "agent.command";
              requestId: string;
              command: ClientCommandMessage["command"];
            }),
          );
        } catch (error) {
          record.externalPending.delete(requestId);
          record.externalRequestTargets.delete(requestId);
          clearTimeout(timeout);
          const cause =
            error instanceof Error ? error : new Error(String(error));
          reject(
            isUncertainRpcDeliveryCommand(command.type)
              ? new CommandDeliveryUncertainError(cause.message)
              : cause,
          );
        }
      });
      if (command.type === "set_model") {
        if (isRecord(data) && data.deferred === true) {
          record.pendingModelSelection = {
            provider: command.provider,
            modelId: command.modelId,
          };
        } else {
          const releasesBlockedQueue = modelSelectionBlocksPrompts(record);
          record.pendingModelSelection = undefined;
          record.modelSelectionError = undefined;
          if (releasesBlockedQueue && record.status !== "working")
            void flushWebQueue(record);
        }
      }
      if (command.type === "get_session_options") {
        const options = isRecord(data) ? data : {};
        if (Array.isArray(options.commands)) return options;
        return {
          ...options,
          commands: slashCommands.toWeb(
            await slashCommands.discover(record.cwd),
          ),
        };
      }
      if (command.type === "reload") slashCommands.invalidate(record.cwd);
      return data;
    }
    if (command.type === "get_fork_messages")
      return await runRpcSessionCommand(record, command);
    if (
      command.type === "clone" ||
      command.type === "fork" ||
      command.type === "set_session_name" ||
      command.type === "compact"
    ) {
      if (!record.file) throw new Error(`Session ${record.id} is not active`);
      return await runRpcSessionCommand(record, command as RpcSessionCommand);
    }
    throw new Error(
      `Session ${record.id} does not support command ${command.type}`,
    );
  }

  return {
    routeCommand,
    flushPendingModelSelection,
    slashCommands,
  };
}

export type CommandRouter = ReturnType<typeof createCommandRouter>;
