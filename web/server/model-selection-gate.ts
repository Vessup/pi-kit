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
