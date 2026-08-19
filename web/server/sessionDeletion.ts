import { existsSync, rmSync } from "node:fs";
import type { ClientBroadcast } from "./clientBroadcast.js";
import type { CommandRouter } from "./commandRouter.js";
import type { MissingSessions } from "./missingSessions.js";
import {
  preserveRetryAroundQuiescence,
  quiesceQueueMutations,
} from "./queue-mutation.js";
import type {
  SessionFileCatalog,
  SessionQueueCoordinator,
  SessionRecord,
} from "./server-types.js";
import type { WebServerConfig } from "./serverConfig.js";
import type { ServerRuntimeState } from "./serverRuntimeState.js";
import type { ServerStores } from "./serverStores.js";
import type { SessionRegistry } from "./sessionRegistry.js";
import {
  hasOtherSessionInWorktree,
  removeManagedWorktree,
  removeManagedWorktreeAsync,
} from "./worktrees.js";

/**
 * Durable session deletion (queues first, then file, then registrations),
 * external-deletion reconciliation, and best-effort managed worktree cleanup.
 */
export function createSessionDeletion(options: {
  state: ServerRuntimeState;
  config: WebServerConfig;
  catalog: SessionFileCatalog;
  stores: ServerStores;
  queue: SessionQueueCoordinator;
  registry: SessionRegistry;
  missingSessions: MissingSessions;
  broadcast: ClientBroadcast;
  router: CommandRouter;
}) {
  const {
    state: runtime,
    catalog,
    stores,
    queue,
    registry,
    missingSessions,
    broadcast,
    router,
  } = options;
  const { sessionsDir } = options.config;
  const {
    normalizePath,
    sessionFileKey,
    canonicalSessionFile,
    isManagedSessionFile,
    deleteManagedSessionFile,
    scanSavedSessions,
    readManagedWorktreePrefix,
  } = catalog;
  const {
    persistWebQueue,
    markWebQueueSnapshotDirty,
    cancelWebQueueWork,
    scheduleWebQueueRetry,
  } = queue;
  const { queueStoreWriter, persistedQueues } = stores;
  const { upsertSession } = registry;
  const { isMissingInactiveSession } = missingSessions;
  const { sendSessionRemoved } = broadcast;
  const { routeCommand } = router;

  async function deleteSessionRecord(
    record: SessionRecord,
    file?: string,
    shouldCommit: () => boolean = () => true,
  ): Promise<boolean> {
    const finishQueueQuiescence = preserveRetryAroundQuiescence({
      isArmed: () => record.queueRetryTimer !== undefined,
      cancel: () => {
        if (record.queueRetryTimer) clearTimeout(record.queueRetryTimer);
        record.queueRetryTimer = undefined;
      },
      reopen: () => {
        record.queueMutationsQuiesced = false;
      },
      resume: () => scheduleWebQueueRetry(record),
    });
    try {
      await quiesceQueueMutations(record);
      if (record.queueDirtyWorker) {
        await record.queueDirtyWorker.cancelAndDrain();
        record.queueDirtyWorker = undefined;
      }
      if (!shouldCommit()) {
        finishQueueQuiescence();
        return false;
      }
      // Make queue removal durable before deleting the file, maps, or sockets.
      // A failed store write leaves the complete session available for retry.
      await queueStoreWriter.mutate(persistedQueues, (queues) => {
        queues.delete(record.id);
      });
    } catch (error) {
      finishQueueQuiescence();
      throw error;
    }

    // Queue persistence yields to the event loop. If an agent reconnected while it
    // was in flight, restore its queue instead of deleting the newly live record.
    if (!shouldCommit()) {
      // The durable delete completed, but the record became live again. Restore
      // its retained queue through the retrying worker so a transient rollback
      // write failure cannot leave an active session with no durable snapshot.
      markWebQueueSnapshotDirty(record);
      finishQueueQuiescence();
      return false;
    }

    if (file) {
      try {
        rmSync(file, { force: true });
      } catch (error) {
        // Restore a non-empty queue before making the failed deletion usable again.
        let restoreError: unknown;
        try {
          await persistWebQueue(record);
        } catch (cause) {
          restoreError = cause;
        }
        finishQueueQuiescence();
        const message = error instanceof Error ? error.message : String(error);
        if (restoreError) {
          throw new Error(
            `Failed to delete session file: ${message}; queue rollback failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          );
        }
        throw new Error(`Failed to delete session file: ${message}`);
      }
    }

    cancelWebQueueWork(record);
    runtime.sessions.delete(record.id);
    if (record.file) runtime.sessionsByFile.delete(normalizePath(record.file));
    // Notify sockets subscribed only to the removed session; once the record leaves
    // the maps, a catalog-wide broadcast cannot find them. Keep browser sockets open
    // so they can subscribe to a surviving session without reconnecting.
    sendSessionRemoved(record.id, undefined, record.clientSockets);
    for (const socket of record.clientSockets)
      socket.data.sessionId = undefined;
    record.clientSockets.clear();
    for (const socket of record.agentSockets) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
    return true;
  }

  async function stopRecord(record: SessionRecord): Promise<void> {
    if (record.managed) {
      await record.managed.shutdown();
      record.managed = undefined;
    }
    record.active = false;
    record.status = "offline";
  }

  async function reconcileMissingSessionFiles(): Promise<void> {
    if (runtime.shutdownStarted) return;
    const scans = scanSavedSessions(sessionsDir);
    const candidates = [...runtime.sessions.values()].filter(
      (record) =>
        !runtime.missingSessionReconciliations.has(record) &&
        isMissingInactiveSession(record, scans),
    );
    await Promise.all(
      candidates.map(async (record) => {
        runtime.missingSessionReconciliations.add(record);
        const sessionFile = record.file;
        try {
          if (
            !sessionFile ||
            runtime.sessions.get(record.id) !== record ||
            !isMissingInactiveSession(record, scans)
          )
            return;
          const managed = isManagedSessionFile(sessionFile);
          let managedWorktree = record.managedWorktree;
          if (
            managedWorktree &&
            hasOtherSessionInWorktree(
              sessionsDir,
              sessionFile,
              managedWorktree.path,
            )
          ) {
            managedWorktree = undefined;
          }
          const deleted = await deleteSessionRecord(
            record,
            undefined,
            () =>
              runtime.sessions.get(record.id) === record &&
              isMissingInactiveSession(record, scans),
          );
          if (!deleted) return;
          if (managed) {
            try {
              deleteManagedSessionFile(sessionFile);
            } catch (error) {
              console.warn(
                `Externally deleted session ${record.id} was removed from Pi web, but managed ownership cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          if (
            managedWorktree &&
            existsSync(managedWorktree.path) &&
            !hasOtherSessionInWorktree(
              sessionsDir,
              sessionFile,
              managedWorktree.path,
            )
          ) {
            try {
              const result = removeManagedWorktree(managedWorktree);
              if (result.branchWarning)
                console.warn(
                  `Removed externally deleted session worktree ${managedWorktree.path}, but could not delete branch ${managedWorktree.branch}: ${result.branchWarning}`,
                );
            } catch (error) {
              console.warn(
                `Externally deleted session ${record.id} was removed from Pi web, but managed worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        } catch (error) {
          console.warn(
            `Could not remove externally deleted session ${record.id} from Pi web: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          runtime.missingSessionReconciliations.delete(record);
        }
      }),
    );
  }

  function scheduleManagedWorktreeCleanup(
    sessionId: string,
    sessionFile: string,
    managedWorktree: NonNullable<SessionRecord["managedWorktree"]>,
  ): void {
    const timer = setTimeout(() => {
      void (async () => {
        // A new session may claim this checkout after durable deletion yields.
        if (
          hasOtherSessionInWorktree(
            sessionsDir,
            sessionFile,
            managedWorktree.path,
          )
        )
          return;
        try {
          const result = await removeManagedWorktreeAsync(managedWorktree);
          if (result.branchWarning)
            console.warn(
              `Removed worktree ${managedWorktree.path}, but could not delete branch ${managedWorktree.branch}: ${result.branchWarning}`,
            );
        } catch (error) {
          console.warn(
            `Session ${sessionId} was deleted, but managed worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })();
    }, 0);
    timer.unref?.();
  }

  async function deleteSession(sessionId: string): Promise<void> {
    let record =
      runtime.sessions.get(sessionId) ??
      runtime.sessionsByFile.get(normalizePath(sessionId)) ??
      (() => {
        const scan = scanSavedSessions(sessionsDir).find(
          (item) =>
            item.session.id === sessionId ||
            normalizePath(item.file) === normalizePath(sessionId),
        );
        return scan
          ? upsertSession(
              scan.session,
              "saved",
              scan.history,
              scan.managedWorktreeScanned,
            )
          : undefined;
      })();
    if (!record) throw new Error(`Unknown session: ${sessionId}`);
    if (record.file) {
      // Map keys are written with normalizePath (via sessionFileKey, which is the
      // shared key helper) in managedSessionCreate.ts; reuse it here so we await
      // in-flight starts and stale records even if path normalization varies.
      const fileKey = sessionFileKey(record.file);
      const pendingStart = runtime.managedSessionStarts.get(fileKey);
      if (pendingStart) {
        await pendingStart.catch(() => undefined);
        record =
          runtime.sessions.get(sessionId) ??
          runtime.sessionsByFile.get(fileKey) ??
          record;
      }
    }
    const sessionFile = record.file;
    let managedWorktree = record.managedWorktree;
    if (!managedWorktree && sessionFile && !record.managedWorktreeScanned) {
      managedWorktree = readManagedWorktreePrefix(sessionFile);
      record.managedWorktreeScanned = true;
    }
    if (
      managedWorktree &&
      sessionFile &&
      hasOtherSessionInWorktree(sessionsDir, sessionFile, managedWorktree.path)
    ) {
      managedWorktree = undefined;
    }
    if (record.kind === "external" && record.agentSockets.size > 0) {
      if (record.status === "working")
        throw new Error(
          "Abort or wait for the active session before deleting it",
        );
      await routeCommand(record, { type: "shutdown" });
      const deadline = Date.now() + 3_000;
      while (record.agentSockets.size > 0 && Date.now() < deadline)
        await Bun.sleep(50);
      if (record.agentSockets.size > 0)
        throw new Error("The active Pi process did not shut down in time");
    }
    await stopRecord(record);
    let file: string | undefined;
    if (record.file) {
      try {
        file = canonicalSessionFile(record.file);
      } catch (error) {
        if (
          !(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          throw new Error(
            `Refusing to delete unsafe session path: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    await deleteSessionRecord(record, file);
    if (sessionFile && isManagedSessionFile(sessionFile)) {
      try {
        deleteManagedSessionFile(sessionFile);
      } catch (error) {
        console.warn(
          `Session ${sessionId} was deleted, but managed ownership cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // Native shutdown and durable queue deletion may yield long enough for another
    // Pi process to create a session in this checkout. Ownership can only be
    // revoked here; never enable cleanup that was not part of the original request.
    if (
      managedWorktree &&
      sessionFile &&
      hasOtherSessionInWorktree(sessionsDir, sessionFile, managedWorktree.path)
    ) {
      managedWorktree = undefined;
    }
    // Durable deletion and client notification are complete before best-effort
    // worktree cleanup. Run slow checkout removal outside the HTTP request so a
    // reverse proxy cannot report a false failure after the session is gone.
    if (managedWorktree && sessionFile)
      scheduleManagedWorktreeCleanup(sessionId, sessionFile, managedWorktree);
  }

  /**
   * Drop a not-yet-activated initial session file and its registrations.
   * Map keys are produced with `sessionFileKey` (= normalizePath) so the lookup
   * matches the writers in managedSessionCreate.ts.
   */
  function cleanupInitialSessionFile(initialSessionFile?: string): void {
    if (!initialSessionFile) return;
    const key = sessionFileKey(initialSessionFile);
    const stale = runtime.sessionsByFile.get(key);
    if (stale?.file && sessionFileKey(stale.file) === key) {
      runtime.sessions.delete(stale.id);
      runtime.sessionsByFile.delete(key);
    }
    if (isManagedSessionFile(initialSessionFile)) {
      try {
        deleteManagedSessionFile(initialSessionFile);
      } catch {
        /* preserve the original startup error */
      }
    }
    rmSync(initialSessionFile, { force: true });
  }

  return {
    deleteSession,
    deleteSessionRecord,
    stopRecord,
    reconcileMissingSessionFiles,
    cleanupInitialSessionFile,
  };
}

export type SessionDeletion = ReturnType<typeof createSessionDeletion>;
