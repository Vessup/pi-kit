import type { WebModelOption } from "../protocol.js";

export function visibleRoutedThinkingLevel(
  thinkingLevel: string | undefined,
): string {
  return thinkingLevel && thinkingLevel !== "off" ? thinkingLevel : "";
}

/** Return only the thinking levels advertised for the selected model. */
export function thinkingLevelsForSelectedModel(
  models: readonly WebModelOption[],
  selectedModelReference: string | undefined,
): string[] {
  if (!selectedModelReference) return [];

  const selectedModel = models.find(
    (model) => `${model.provider}/${model.id}` === selectedModelReference,
  );
  return selectedModel?.thinkingLevels
    ? [...selectedModel.thinkingLevels]
    : [];
}
