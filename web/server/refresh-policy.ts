export type ManagedRefreshState = { managedRefreshTail?: Promise<void> };

/** Serialize the complete state refresh/rekey transaction without poisoning later refreshes. */
export function serializeManagedRefresh<T>(
  state: ManagedRefreshState,
  task: () => Promise<T>,
): Promise<T> {
  const run = (state.managedRefreshTail ?? Promise.resolve())
    .catch(() => undefined)
    .then(task);
  state.managedRefreshTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Run reconciliation with explicit foreground/background failure semantics. */
export async function runManagedRefresh(
  task: () => Promise<void>,
  options?: {
    suppressErrors?: boolean;
    onBackgroundError?: (error: unknown) => void;
  },
): Promise<void> {
  try {
    await task();
  } catch (error) {
    if (!options?.suppressErrors) throw error;
    options.onBackgroundError?.(error);
  }
}
