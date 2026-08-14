import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	abortRunningSubagentSessions,
	appendBoundedStreamingText,
	countsAgainstSubagentLimit,
	filterModelsToScope,
	inheritedSubagentModel,
	isFailedStopReason,
	isTerminalSubagentStatus,
	MAX_WEB_STREAMING_CHARS,
	parsePersistedUsageState,
	subagentModelGuidance,
	subagentModelRuntime,
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

test("terminal cleanup classification preserves live subagents", () => {
	assert.equal(isTerminalSubagentStatus("completed"), true);
	assert.equal(isTerminalSubagentStatus("failed"), true);
	assert.equal(isTerminalSubagentStatus("terminated"), true);
	assert.equal(isTerminalSubagentStatus("creating"), false);
	assert.equal(isTerminalSubagentStatus("working"), false);
	assert.equal(isTerminalSubagentStatus("terminating"), false);
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
	assert.deepEqual(
		inheritedSubagentModel(available[0], undefined),
		{ provider: "openai", id: "large" },
		"omitted model inherits the host model even when an explicit-override scope excludes it",
	);
});

test("inherited subagents reuse headers-only temporary host authentication", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-kit-subagent-auth-"));
	const previousAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
	const previousGatewayId = process.env.CLOUDFLARE_GATEWAY_ID;
	process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
	process.env.CLOUDFLARE_GATEWAY_ID = "test-gateway";
	try {
		const hostRuntime = await ModelRuntime.create({
			authPath: join(directory, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		});
		await hostRuntime.setRuntimeApiKey("cloudflare-ai-gateway", "session-only-key");
		assert.deepEqual(hostRuntime.getProviderAuthStatus("cloudflare-ai-gateway"), {
			configured: true,
			source: "runtime",
		});

		const inheritedRuntime = subagentModelRuntime(new ModelRegistry(hostRuntime));
		assert.equal(inheritedRuntime, hostRuntime, "host and child share credential refresh state");
		const resolved = await inheritedRuntime.getAuth("cloudflare-ai-gateway");
		assert.ok(resolved);
		assert.equal(resolved.auth.apiKey, undefined);
		assert.equal(resolved.auth.headers?.["cf-aig-authorization"], "Bearer session-only-key");
		assert.deepEqual(resolved.env, {
			CLOUDFLARE_ACCOUNT_ID: "test-account",
			CLOUDFLARE_GATEWAY_ID: "test-gateway",
		});
	} finally {
		if (previousAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
		else process.env.CLOUDFLARE_ACCOUNT_ID = previousAccountId;
		if (previousGatewayId === undefined) delete process.env.CLOUDFLARE_GATEWAY_ID;
		else process.env.CLOUDFLARE_GATEWAY_ID = previousGatewayId;
		await rm(directory, { recursive: true, force: true });
	}
});

test("subagent model guidance exposes exact choices and inheritance", () => {
	const guidance = subagentModelGuidance(
		{ provider: "openai-codex", id: "gpt-5.6-sol" },
		[
			{ provider: "openai-codex", id: "gpt-5.6-luna" },
			{ provider: "openai-codex", id: "gpt-5.6-sol" },
			{ provider: "openai-codex", id: "gpt-5.6-sol" },
		],
	);
	assert.match(guidance, /inherits openai-codex\/gpt-5\.6-sol when model is omitted/);
	assert.match(guidance, /openai-codex\/gpt-5\.6-luna, openai-codex\/gpt-5\.6-sol/);
	assert.doesNotMatch(guidance, /gpt-5\.6-sol, openai-codex\/gpt-5\.6-sol/);
	assert.match(guidance, /Never shorten, generalize, or invent a model ID/);
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
