import type { WebSession, WebUsage } from "../protocol";

function hasUsage(value: WebUsage | undefined): boolean {
	return Boolean(value && (value.input || value.output || value.cacheRead || value.cacheWrite || value.totalTokens));
}

function preserveSubagentTelemetry(previous: WebSession["subagents"], next: WebSession["subagents"]): WebSession["subagents"] {
	if (next === undefined) return previous;
	const priorById = new Map((previous ?? []).map((agent) => [agent.id, agent]));
	return next.map((agent) => {
		const prior = priorById.get(agent.id);
		return {
			...agent,
			transcript: agent.transcript ?? prior?.transcript,
			streamingText: agent.streamingText ?? prior?.streamingText,
		};
	});
}

/**
 * Polling and bridge updates can briefly omit supplementary telemetry. Keep the
 * last complete values so the composer does not disappear or resize between
 * authoritative metrics refreshes.
 */
export function preserveSessionTelemetry(previous: WebSession | undefined, next: WebSession): WebSession {
	if (!previous || previous.id !== next.id) return next;
	return {
		...next,
		subagents: preserveSubagentTelemetry(previous.subagents, next.subagents),
		subagentUsage: next.subagentUsage ?? previous.subagentUsage,
		usage: hasUsage(next.usage) || !hasUsage(previous.usage) ? next.usage : previous.usage,
		contextUsage: next.contextUsage ?? previous.contextUsage,
	};
}

export function preserveSessionsTelemetry(previous: readonly WebSession[], next: readonly WebSession[]): WebSession[] {
	const priorById = new Map(previous.map((session) => [session.id, session]));
	return next.map((session) => preserveSessionTelemetry(priorById.get(session.id), session));
}
