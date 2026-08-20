import type { WebModelOption } from "../protocol.js";

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
