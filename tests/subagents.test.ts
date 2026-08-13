import assert from "node:assert/strict";
import test from "node:test";
import {
	abortRunningSubagentSessions,
	appendBoundedStreamingText,
	countsAgainstSubagentLimit,
	filterModelsToScope,
	isFailedStopReason,
	MAX_WEB_STREAMING_CHARS,
	parsePersistedUsageState,
} from "../extensions/subagents.ts";

const usage = {
	input: 10,
	output: 4,
	cacheRead: 3,
	cacheWrite: 2,
	totalTokens: 19,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
};

test("creating agents reserve capacity before their session exists", () => {
	assert.equal(countsAgainstSubagentLimit({ status: "creating" }), true);
	assert.equal(countsAgainstSubagentLimit({ status: "completed", session: {} }), true);
	assert.equal(countsAgainstSubagentLimit({ status: "failed" }), false);
	assert.equal(countsAgainstSubagentLimit({ status: "terminated" }), false);
});

test("aborting the main run aborts every running subagent and leaves completed agents alone", async () => {
	const aborted: string[] = [];
	const agents = [
		{ status: "working" as const, session: { async abort() { aborted.push("working"); } } },
		{ status: "creating" as const, session: { async abort() { aborted.push("creating"); } } },
		{ status: "completed" as const, session: { async abort() { aborted.push("completed"); } } },
		{ status: "failed" as const },
	];
	const results = await abortRunningSubagentSessions(agents);
	assert.deepEqual(aborted.sort(), ["creating", "working"]);
	assert.equal(results.length, 2);
	assert.equal(results.every((result) => result.error === undefined), true);
});

test("terminal provider errors are classified as failures", () => {
	assert.equal(isFailedStopReason("error"), true);
	assert.equal(isFailedStopReason("aborted"), true);
	assert.equal(isFailedStopReason("stop"), false);
	assert.equal(isFailedStopReason(undefined), false);
});

test("available subagent models honor a configured scope", () => {
	const available = [
		{ provider: "openai", id: "large" },
		{ provider: "openai", id: "small" },
		{ provider: "anthropic", id: "large" },
	];
	assert.deepEqual(
		filterModelsToScope(available, [{ model: { provider: "openai", id: "small" } }]),
		[{ provider: "openai", id: "small" }],
	);
	assert.equal(filterModelsToScope(available, []), available);
});

test("streaming subagent output remains bounded to its newest text", () => {
	const prefix = "a".repeat(MAX_WEB_STREAMING_CHARS - 2);
	assert.equal(appendBoundedStreamingText(prefix, "bc"), `${prefix}bc`);
	assert.equal(appendBoundedStreamingText(prefix, "012345"), `${prefix.slice(4)}012345`);
});

test("persisted usage checkpoints reject malformed data", () => {
	assert.deepEqual(parsePersistedUsageState({ total: usage, accounted: usage }), {
		total: usage,
		accounted: usage,
	});
	assert.equal(parsePersistedUsageState({ total: usage, accounted: { ...usage, output: "4" } }), undefined);
	assert.equal(parsePersistedUsageState(null), undefined);
});
