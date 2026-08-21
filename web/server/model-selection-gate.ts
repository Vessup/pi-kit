import type { SessionRecord } from "./server-types.js";

/** Model-dependent prompts must wait until the requested selection is usable. */
export function modelSelectionBlocksPrompts(
  record: Pick<
    SessionRecord,
    | "pendingModelSelection"
    | "modelSelectionTarget"
    | "applyingModelSelection"
    | "modelSelectionFlush"
    | "modelSelectionError"
  >,
): boolean {
  return Boolean(
    record.pendingModelSelection ||
      record.modelSelectionTarget ||
      record.applyingModelSelection ||
      record.modelSelectionFlush ||
      record.modelSelectionError,
  );
}

export async function drainPendingModelSelections(
  record: Pick<SessionRecord, "pendingModelSelection" | "modelSelectionError">,
  apply: (selection: { provider: string; modelId: string }) => Promise<void>,
  onError?: (message: string) => void,
): Promise<void> {
  while (record.pendingModelSelection) {
    const selection = record.pendingModelSelection;
    record.pendingModelSelection = undefined;
    try {
      await apply(selection);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record.modelSelectionError = message;
      onError?.(message);
    }
  }
  if (record.modelSelectionError) throw new Error(record.modelSelectionError);
}

export function queuedModelDependencyBlocksDelivery(
  record: Pick<SessionRecord, "queue" | "selectedModel" | "model">,
): boolean {
  const required = record.queue[0]?.requiredModel;
  if (!required) return false;
  return (
    (record.selectedModel ?? record.model) !==
    `${required.provider}/${required.modelId}`
  );
}
