export type WebModelStatus = {
  /** The runtime model currently assigned to the session. */
  model?: string;
  thinkingLevel?: string;
  /** The model the user selected; differs from `model` only while Auto routes. */
  selectedModel?: string;
  /** The last concrete runtime model used for an Auto selection. */
  lastModel?: string | null;
};

export type WebModelIdentity = { provider: string; id: string };

export const AUTO_ROUTER_ACTIVE_ENTRY = "vessup:auto-router:active";

const AUTO_ROUTER_EFFORTS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export type AutoRoutingState = {
  active: boolean;
  selectedModel?: string;
  currentPlaceholder?: string;
  pendingRoute?: string;
  lastModel?: string;
};

function selectedAutoModelFromData(data: unknown): string | undefined {
  if (
    !data ||
    typeof data !== "object" ||
    (data as Record<string, unknown>).enabled !== true
  )
    return undefined;
  const pinnedTier = (data as Record<string, unknown>).pinnedTier;
  return typeof pinnedTier === "string" && AUTO_ROUTER_EFFORTS.has(pinnedTier)
    ? `auto/auto-${pinnedTier}`
    : "auto/auto";
}

/** Incrementally fold durable Auto selection and routed-model transitions. */
export function autoRoutingStateFromEntries(
  entries: readonly unknown[],
  initial: AutoRoutingState = { active: false },
): AutoRoutingState {
  const state: AutoRoutingState = { ...initial };
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
        if (
          state.active &&
          state.currentPlaceholder &&
          state.currentPlaceholder !== model
        ) {
          state.pendingRoute = undefined;
          state.lastModel = undefined;
        } else if (state.pendingRoute) {
          state.lastModel = state.pendingRoute;
          state.pendingRoute = undefined;
        }
        state.currentPlaceholder = model;
      } else if (state.active) {
        state.pendingRoute = model;
      }
      continue;
    }
    if (
      value.type !== "custom" ||
      value.customType !== AUTO_ROUTER_ACTIVE_ENTRY
    )
      continue;
    const selectedModel = selectedAutoModelFromData(value.data);
    if (!selectedModel) {
      state.active = false;
      state.selectedModel = undefined;
      state.currentPlaceholder = undefined;
      state.pendingRoute = undefined;
      state.lastModel = undefined;
      continue;
    }
    if (!state.active) {
      state.currentPlaceholder = selectedModel;
    } else if (
      state.selectedModel &&
      state.selectedModel !== selectedModel
    ) {
      state.pendingRoute = undefined;
      state.lastModel = undefined;
      state.currentPlaceholder = selectedModel;
    }
    state.active = true;
    state.selectedModel = selectedModel;
    state.currentPlaceholder ??= selectedModel;
    if (
      value.data &&
      typeof value.data === "object" &&
      (value.data as Record<string, unknown>).resetRoute === true
    ) {
      state.pendingRoute = undefined;
      const restoreRoute = (value.data as Record<string, unknown>).restoreRoute;
      state.lastModel =
        typeof restoreRoute === "string" && restoreRoute.length > 0
          ? restoreRoute
          : undefined;
    }
  }
  return state;
}

export function selectedAutoModelFromState(
  state: AutoRoutingState,
): string | undefined {
  return state.active ? state.selectedModel : undefined;
}

export function lastAutoRoutedModelFromState(
  state: AutoRoutingState,
): string | undefined {
  return state.active ? (state.pendingRoute ?? state.lastModel) : undefined;
}

/** Reconstruct the durable Auto placeholder selected for a saved session. */
export function selectedAutoModelFromEntries(
  entries: readonly unknown[],
): string | undefined {
  return selectedAutoModelFromState(autoRoutingStateFromEntries(entries));
}

/** Find the most recent concrete model that Auto actually routed to. */
export function lastAutoRoutedModelFromEntries(
  entries: readonly unknown[],
): string | undefined {
  return lastAutoRoutedModelFromState(autoRoutingStateFromEntries(entries));
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
  else if (
    !isAutoModelReference(runtimeModel) ||
    (isAutoModelReference(selectedModel) && selectedModel !== runtimeModel)
  )
    delete next.lastModel;
  return next;
}

/** Pull the Auto tier label out of an `auto/auto-<tier>` reference (or `"auto"` for the adaptive one). */
export function autoTierFromReference(reference: string | undefined): string | undefined {
  if (reference === undefined) return undefined;
  if (!isAutoModelReference(reference)) return undefined;
  if (reference === "auto/auto") return "auto";
  const PREFIX = "auto/auto-";
  return reference.startsWith(PREFIX) ? reference.slice(PREFIX.length) : "auto";
}
