export type WebModelStatus = {
  /** The runtime model currently assigned to the session. */
  model?: string;
  thinkingLevel?: string;
  /** The model the user selected; differs from `model` only while Auto routes. */
  selectedModel?: string;
  /** The last concrete runtime model used for an Auto selection. */
  lastModel?: string;
};

export type WebModelIdentity = { provider: string; id: string };

/** Find the last concrete model that Auto actually routed to. */
export function lastAutoRoutedModelFromEntries(
  entries: readonly unknown[],
): string | undefined {
  let autoActive = false;
  let pendingRoute: string | undefined;
  let lastModel: string | undefined;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    if (value.type === "model_change") {
      if (
        typeof value.provider !== "string" ||
        value.provider.length === 0 ||
        typeof value.modelId !== "string" ||
        value.modelId.length === 0
      )
        continue;
      const model = `${value.provider}/${value.modelId}`;
      if (isAutoModelReference(model)) {
        if (pendingRoute) lastModel = pendingRoute;
        pendingRoute = undefined;
      } else if (autoActive) {
        pendingRoute = model;
      }
      continue;
    }
    if (
      value.type !== "custom" ||
      value.customType !== "vessup:auto-router:active"
    )
      continue;
    const data = value.data;
    const enabled =
      typeof data === "object" &&
      data !== null &&
      (data as Record<string, unknown>).enabled === true;
    autoActive = enabled;
    if (!enabled) {
      pendingRoute = undefined;
      lastModel = undefined;
    }
  }
  return lastModel ?? pendingRoute;
}

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

/** Identify Auto's placeholder-to-concrete runtime swap, not a later manual change. */
export function isAutoRuntimeModelSwap(
  selectedModel: string | undefined,
  previousModel: string | undefined,
  runtimeModel: string,
): boolean {
  return (
    isAutoModelReference(selectedModel) &&
    isAutoModelReference(previousModel) &&
    !isAutoModelReference(runtimeModel)
  );
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

  const next: WebModelStatus = {
    ...status,
    model: runtimeModel,
    ...(runtimeThinkingLevel !== undefined
      ? { thinkingLevel: runtimeThinkingLevel }
      : {}),
    selectedModel: preservingAutoSelection ? selectedModel : runtimeModel,
  };
  if (preservingAutoSelection) next.lastModel = runtimeModel;
  else if (!isAutoModelReference(runtimeModel)) delete next.lastModel;
  return next;
}
