export type WebModelStatus = {
  /** The runtime model currently assigned to the session. */
  model?: string;
  thinkingLevel?: string;
  /** The model the user selected; differs from `model` only while Auto routes. */
  selectedModel?: string;
};

export type WebModelIdentity = { provider: string; id: string };

/** Format a provider/model pair for the Web session protocol. */
export function webModelReference(model: WebModelIdentity): string {
  return `${model.provider}/${model.id}`;
}

/** Return whether a protocol model reference names one of Auto Router's placeholders. */
export function isAutoModelReference(reference: string | undefined): boolean {
  return reference?.startsWith("auto/") === true;
}

/** Resolve the user selection, falling back to the runtime model for old payloads. */
export function selectedModelReference(
  status: Pick<WebModelStatus, "model" | "selectedModel">,
): string | undefined {
  return status.selectedModel ?? status.model;
}

/**
 * Keep the user's selected Auto placeholder separate from the concrete runtime
 * model used for the active turn. Ordinary model changes update both values.
 */
export function applyRuntimeModelStatus(
  status: WebModelStatus,
  runtimeModel: string,
  runtimeThinkingLevel: string | undefined,
  autoTurnActive: boolean,
): WebModelStatus {
  const selectedModel = selectedModelReference(status);
  const preservingAutoSelection =
    autoTurnActive &&
    isAutoModelReference(selectedModel) &&
    !isAutoModelReference(runtimeModel);

  return {
    ...status,
    model: runtimeModel,
    ...(runtimeThinkingLevel !== undefined
      ? { thinkingLevel: runtimeThinkingLevel }
      : {}),
    selectedModel: preservingAutoSelection ? selectedModel : runtimeModel,
  };
}
