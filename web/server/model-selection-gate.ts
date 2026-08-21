import type { SessionRecord } from "./server-types.js";

/** Model-dependent prompts must wait until the requested selection is usable. */
export function modelSelectionBlocksPrompts(
  record: Pick<
    SessionRecord,
    | "pendingModelSelection"
    | "applyingModelSelection"
    | "modelSelectionFlush"
    | "modelSelectionError"
  >,
): boolean {
  return Boolean(
    record.pendingModelSelection ||
      record.applyingModelSelection ||
      record.modelSelectionFlush ||
      record.modelSelectionError,
  );
}
