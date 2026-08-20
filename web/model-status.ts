export type WebModelStatus = {
  /** The runtime model currently assigned to the session. */
  model?: string;
  thinkingLevel?: string;
  /** The model the user selected; differs from `model` only while Auto routes. */
  selectedModel?: string;
};

export type WebModelIdentity = { provider: string; id: string };

export function webModelReference(model: WebModelIdentity): string {
  return `${model.provider}/${model.id}`;
}

export function isAutoModelReference(reference: string | undefined): boolean {
  return reference?.startsWith("auto/") === true;
}

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
