import { ModelRuntime, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { modelName } from "./format.js";

export function filterModelsToScope<T extends { provider: string; id: string }>(
	available: readonly T[],
	scoped: ReadonlyArray<{ model: { provider: string; id: string } }>,
): readonly T[] {
	if (scoped.length === 0) return available;
	const allowed = new Set(scoped.map(({ model }) => `${model.provider}/${model.id}`));
	return available.filter((model) => allowed.has(`${model.provider}/${model.id}`));
}

export function inheritedSubagentModel<T extends { provider: string; id: string }>(
	current: T | undefined,
	runtimeModel: T | undefined,
): T | undefined {
	return runtimeModel ?? current;
}

export function subagentModelRuntime(modelRegistry: ModelRegistry): ModelRuntime {
	// ModelRegistry is the extension-facing compatibility facade around the
	// canonical runtime. Sharing that runtime preserves runtime-only keys and
	// provider-resolved headers/env/base URLs, while leaving stored OAuth in the
	// credential store so both host and child continue to refresh it normally.
	const runtime: unknown = Reflect.get(modelRegistry, "runtime");
	if (!(runtime instanceof ModelRuntime)) {
		throw new Error("The host model registry does not expose its canonical runtime");
	}
	return runtime;
}

export function subagentModelGuidance(
	current: { provider: string; id: string } | undefined,
	available: readonly { provider: string; id: string }[],
): string {
	const choices = [...new Set(available.map(modelName))];
	const inherited = modelName(current);
	return [
		"Subagent model selection for this session:",
		`- subagent_create inherits ${inherited} when model is omitted.`,
		"- Only pass model when intentionally overriding the inherited model.",
		`- Exact available provider/model IDs: ${choices.length > 0 ? choices.join(", ") : "none"}.`,
		"- Never shorten, generalize, or invent a model ID.",
	].join("\n");
}

export function unavailableModelMessage(
	requested: string,
	available: readonly { provider: string; id: string }[],
	current: { provider: string; id: string } | undefined,
	withinScope: boolean,
): string {
	const choices = [...new Set(available.map(modelName))];
	const scope = withinScope ? " within the session scope" : "";
	const allowed = choices.length > 0 ? choices.join(", ") : "none";
	const inherit = current ? ` Omit model to inherit ${modelName(current)}.` : "";
	return `Model is unavailable${scope}: ${requested}. Exact available models: ${allowed}.${inherit}`;
}
