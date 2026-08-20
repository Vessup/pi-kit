import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { messagesToWebHistory } from "../history.js";
import { replacementFromEntries } from "../worktree-replacement.js";
import type { ClientBroadcast } from "./clientBroadcast.js";
import { preserveRetryAroundQuiescence } from "./queue-mutation.js";
import type { RecordSync } from "./recordSync.js";
import {
  runManagedRefresh,
  serializeManagedRefresh,
} from "./refresh-policy.js";
import type {
  SessionFileCatalog,
  SessionQueueCoordinator,
  SessionRecord,
} from "./server-types.js";
import type { WebServerConfig } from "./serverConfig.js";
import type { ServerRuntimeState } from "./serverRuntimeState.js";
import type { ServerStores } from "./serverStores.js";
import type { SessionHistory } from "./sessionHistory.js";
import {
  hasOtherSessionInWorktree,
  managedWorktreeFromEntries,
  removeManagedWorktree,
} from "./worktrees.js";

export type ManagedIdentityTransition = {
  rollback(): void;
  commit(): void;
};

function stageSourceSessionDeletion(
  previousFile: string,
  nextFile: string,
  sessionFileKey: (file: string) => string,
  canonicalSessionFile: (file: string) => string,
): ManagedIdentityTransition {
  const source = canonicalSessionFile(previousFile);
  if (sessionFileKey(source) === sessionFileKey(nextFile))
    throw new Error("Replacement session file must differ from its source");
  const tombstone = `${source}.replaced-${randomUUID()}.tmp`;
  renameSync(source, tombstone);
  return {
    rollback: () => {
      if (existsSync(source))
        throw new Error(
          `Refusing to overwrite a recreated source session: ${source}`,
        );
      if (existsSync(tombstone)) renameSync(tombstone, source);
      else throw new Error(`Missing staged source session ${tombstone}`);
    },
    commit: () => {
      try {
        rmSync(tombstone, { force: true });
      } catch (error) {
        console.warn(
          `Source session was removed, but its staged tombstone could not be cleaned: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

/**
 * Transactional identity refresh for managed RPC sessions (clone/fork/worktree
 * replacements) plus startup recovery of staged source-session deletions.
 */
export function createManagedSessionRefresh(options: {
  state: ServerRuntimeState;
  config: WebServerConfig;
  catalog: SessionFileCatalog;
  stores: ServerStores;
  history: SessionHistory;
  recordSync: RecordSync;
  queue: SessionQueueCoordinator;
  broadcast: ClientBroadcast;
}) {
  const {
    state: runtime,
    catalog,
    stores,
    history,
    recordSync,
    queue,
    broadcast,
  } = options;
  const { sessionsDir } = options.config;
  const {
    normalizePath,
    sessionFileKey,
    canonicalSessionFile,
    isManagedSessionFile,
    replaceManagedSessionFile,
    parseSessionMetadataFile,
    parseSessionFile,
    listSavedSessionFiles,
    isRecord,
  } = catalog;
  const { persistedQueues, queueStoreWriter, managedSessionStore } = stores;
  const { migratePersistedQueue, scheduleWebQueueRetry, cloneWebQueue } = queue;
  const { updateRecordFromState, updateRecordFromStats } = recordSync;
  const { replaceRecordHistory } = history;
  const { broadcastSessionToAll, sendSessionRemoved } = broadcast;

  async function refreshManagedSession(
    record: SessionRecord,
    suppressErrors = false,
    stageIdentityTransition?: (
      previousFile: string,
      nextFile: string,
    ) => ManagedIdentityTransition,
  ): Promise<void> {
    // A settlement refresh may finish after a queued prompt starts. Keep the
    // generation from request time so its model snapshot cannot cancel the
    // newer turn's Auto tracking.
    const modelTurnGeneration = record.modelTurnGeneration ?? 0;
    await runManagedRefresh(
      () =>
        serializeManagedRefresh(record, async () => {
          const managed = record.managed;
          if (!managed) return;
          let finishQueueMigration: (() => void) | undefined;
          let identityTransition: ManagedIdentityTransition | undefined;
          try {
            const oldId = record.id;
            const oldFile = record.file;
            const state = await managed.getState();
            const nextState = isRecord(state) ? { ...state } : state;
            const newId =
              isRecord(nextState) && typeof nextState.sessionId === "string"
                ? nextState.sessionId
                : oldId;
            const newFile =
              isRecord(nextState) && typeof nextState.sessionFile === "string"
                ? nextState.sessionFile
                : oldFile;
            const fileChanged = Boolean(
              newFile &&
                (!oldFile ||
                  sessionFileKey(newFile) !== sessionFileKey(oldFile)),
            );
            let ownershipMigrated = false;
            try {
              const pendingDeletion = record.pendingWorktreeSourceDeletion;
              let verifiedPendingDeletion = false;
              if (
                pendingDeletion &&
                pendingDeletion.sessionId === oldId &&
                oldFile &&
                newFile &&
                newId !== oldId &&
                sessionFileKey(pendingDeletion.sessionFile) ===
                  sessionFileKey(oldFile)
              ) {
                const marker = parseSessionMetadataFile(newFile)?.replacement;
                verifiedPendingDeletion = Boolean(
                  marker &&
                    marker.previousSessionId === oldId &&
                    sessionFileKey(marker.previousSessionFile) ===
                      sessionFileKey(oldFile) &&
                    marker.replacementSessionId === newId,
                );
              }
              if (
                pendingDeletion &&
                pendingDeletion.sessionId === oldId &&
                newId !== oldId &&
                !verifiedPendingDeletion
              ) {
                // session_start can be observed before the verified activation marker is
                // appended. Leave the old identity intact until the worktree callback commits.
                return;
              }
              const transitionFactory =
                stageIdentityTransition ??
                (verifiedPendingDeletion
                  ? (previousFile: string, nextFile: string) =>
                      stageSourceSessionDeletion(
                        previousFile,
                        nextFile,
                        sessionFileKey,
                        canonicalSessionFile,
                      )
                  : undefined);
              if (oldFile && newFile && newId !== oldId && transitionFactory) {
                identityTransition = transitionFactory(oldFile, newFile);
              }
              if (newFile) {
                ownershipMigrated =
                  fileChanged || !isManagedSessionFile(newFile);
                replaceManagedSessionFile(oldFile, newFile);
              }
              if (newId !== oldId) {
                finishQueueMigration = preserveRetryAroundQuiescence({
                  isArmed: () => record.queueRetryTimer !== undefined,
                  cancel: () => {
                    if (record.queueRetryTimer)
                      clearTimeout(record.queueRetryTimer);
                    record.queueRetryTimer = undefined;
                  },
                  reopen: () => {
                    record.queueMutationsQuiesced = false;
                  },
                  resume: () => scheduleWebQueueRetry(record),
                });
                await migratePersistedQueue(record, oldId, newId);
                if (isRecord(nextState)) delete nextState.sessionId;
              }
            } catch (transitionError) {
              const rollbackErrors: string[] = [];
              if (identityTransition) {
                try {
                  identityTransition.rollback();
                } catch (error) {
                  rollbackErrors.push(
                    `source-session rollback failed: ${error instanceof Error ? error.message : String(error)}`,
                  );
                }
                identityTransition = undefined;
              }
              if (oldFile && (fileChanged || newId !== oldId)) {
                try {
                  await managed.switchSession(oldFile);
                  const restored = await managed.getState();
                  if (
                    !isRecord(restored) ||
                    restored.sessionId !== oldId ||
                    typeof restored.sessionFile !== "string" ||
                    sessionFileKey(restored.sessionFile) !==
                      sessionFileKey(oldFile)
                  ) {
                    throw new Error(
                      "Pi did not restore the original session identity",
                    );
                  }
                } catch (error) {
                  rollbackErrors.push(
                    `runtime rollback failed: ${error instanceof Error ? error.message : String(error)}`,
                  );
                  await managed.shutdown().catch(() => undefined);
                  record.managed = undefined;
                  record.active = false;
                  record.status = "offline";
                }
              } else if (!oldFile && fileChanged) {
                await managed.shutdown().catch(() => undefined);
                record.managed = undefined;
                record.active = false;
                record.status = "offline";
              }
              if (ownershipMigrated && oldFile && newFile) {
                try {
                  replaceManagedSessionFile(newFile, oldFile);
                } catch (error) {
                  rollbackErrors.push(
                    `ownership rollback failed: ${error instanceof Error ? error.message : String(error)}`,
                  );
                }
              }
              finishQueueMigration?.();
              finishQueueMigration = undefined;
              const message =
                transitionError instanceof Error
                  ? transitionError.message
                  : String(transitionError);
              throw new Error(
                rollbackErrors.length > 0
                  ? `${message}; ${rollbackErrors.join("; ")}`
                  : message,
              );
            }

            updateRecordFromState(
              record,
              nextState,
              modelTurnGeneration,
            );
            try {
              replaceRecordHistory(
                record,
                messagesToWebHistory((await managed.getMessages()).messages),
              );
            } catch {
              // Keep the last complete bounded history snapshot.
            }
            try {
              updateRecordFromStats(record, await managed.getSessionStats());
            } catch {
              // Stats are supplementary; keep history-derived usage.
            }
            if (oldId !== newId) {
              record.id = newId;
              runtime.sessions.delete(oldId);
              runtime.sessions.set(newId, record);
              for (const socket of record.clientSockets)
                socket.data.sessionId = newId;
              finishQueueMigration?.();
              finishQueueMigration = undefined;
              sendSessionRemoved(oldId, newId);
            }
            if (oldFile && oldFile !== record.file)
              runtime.sessionsByFile.delete(normalizePath(oldFile));
            if (record.file)
              runtime.sessionsByFile.set(normalizePath(record.file), record);
            identityTransition?.commit();
            if (
              record.pendingWorktreeSourceDeletion?.sessionId === oldId &&
              oldId !== newId
            ) {
              record.pendingWorktreeSourceDeletion = undefined;
            }
            identityTransition = undefined;
            broadcastSessionToAll(record);
          } catch (error) {
            finishQueueMigration?.();
            if (identityTransition) {
              try {
                identityTransition.rollback();
              } catch (rollbackError) {
                throw new Error(
                  `${error instanceof Error ? error.message : String(error)}; source-session rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
                );
              }
            }
            throw error;
          }
        }),
      {
        suppressErrors,
        onBackgroundError: (error) =>
          console.error(
            `Could not refresh managed session ${record.id}:`,
            error,
          ),
      },
    );
  }

  async function recoverStagedSourceSessionDeletions(): Promise<void> {
    const tombstones: Array<{ tombstone: string; source: string }> = [];
    type RecursiveDirent = {
      parentPath?: string;
      path?: string;
      name: string;
      isFile(): boolean;
    };
    let entries: RecursiveDirent[] = [];
    try {
      entries = readdirSync(sessionsDir, {
        recursive: true,
        withFileTypes: true,
      }) as unknown as RecursiveDirent[];
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const basePath =
        entry.parentPath ?? (typeof entry.path === "string"
          ? entry.path
          : sessionsDir);
      const path = join(basePath, entry.name);
      const match = path.match(/^(.*\.jsonl)\.replaced-[0-9a-f-]+\.tmp$/i);
      if (match) tombstones.push({ tombstone: path, source: match[1] });
    }
    if (tombstones.length === 0) return;
    const saved = listSavedSessionFiles(sessionsDir).flatMap((file) => {
      const scan = parseSessionFile(file);
      return scan ? [scan] : [];
    });
    for (const staged of tombstones) {
      if (existsSync(staged.source)) {
        console.warn(
          `Retaining staged source session because its original path was recreated: ${staged.tombstone}`,
        );
        continue;
      }
      try {
        const sourceWasManaged = managedSessionStore.has(staged.source);
        const sourceScan = parseSessionFile(staged.tombstone);
        const sourceId = sourceScan?.session.id;
        const replacement = sourceId
          ? saved.find((candidate) => {
              const marker = replacementFromEntries(candidate.entries);
              return (
                marker?.previousSessionId === sourceId &&
                normalizePath(marker.previousSessionFile) ===
                  normalizePath(staged.source) &&
                marker.replacementSessionId === candidate.session.id
              );
            })
          : undefined;
        if (!sourceId || !replacement) {
          if (!existsSync(staged.source))
            renameSync(staged.tombstone, staged.source);
          continue;
        }
        // replacement is only defined when sourceId is, but the find callback
        // above loses that narrowing across the closure boundary.
        const sourceQueue = sourceId
          ? persistedQueues.get(sourceId)
          : undefined;
        const replacementQueue = persistedQueues.get(replacement.session.id);
        if (sourceQueue?.length) {
          const ids = new Set<string>();
          const queueItems = [
            ...cloneWebQueue(sourceQueue),
            ...cloneWebQueue(replacementQueue ?? []),
          ].filter((item) => {
            if (ids.has(item.id)) return false;
            ids.add(item.id);
            return true;
          });
          await queueStoreWriter.mutate(persistedQueues, (queues) => {
            if (sourceId) queues.delete(sourceId);
            queues.set(replacement.session.id, queueItems);
          });
        }
        const previousManagedWorktree = managedWorktreeFromEntries(
          sourceScan?.entries ?? [],
        );
        if (sourceWasManaged)
          replaceManagedSessionFile(staged.source, replacement.file);
        let worktreeCleanupFailed = false;
        if (
          previousManagedWorktree &&
          !hasOtherSessionInWorktree(
            sessionsDir,
            staged.source,
            previousManagedWorktree.path,
          )
        ) {
          try {
            const cleanup = removeManagedWorktree(previousManagedWorktree);
            if (cleanup.branchWarning)
              console.warn(
                `Recovered source deletion removed worktree ${previousManagedWorktree.path}, but branch cleanup failed: ${cleanup.branchWarning}`,
              );
          } catch (error) {
            worktreeCleanupFailed = true;
            console.warn(
              `Recovered source session deletion, but previous managed worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (!worktreeCleanupFailed) rmSync(staged.tombstone, { force: true });
      } catch (error) {
        console.warn(
          `Could not recover staged source session deletion ${staged.tombstone}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    try {
      managedSessionStore.recanonicalize();
    } catch (error) {
      console.warn(
        `Could not recanonicalize managed session ownership after source recovery: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    refreshManagedSession,
    recoverStagedSourceSessionDeletions,
  };
}

export type ManagedSessionRefresh = ReturnType<
  typeof createManagedSessionRefresh
>;
