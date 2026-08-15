import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	parseSubagentAbortRequest,
	SUBAGENT_ABORT_EVENT,
} from "./subagent-events.js";
import { SubagentManager } from "./subagents/manager.js";
import {
	filterModelsToScope,
	subagentModelGuidance,
} from "./subagents/models.js";
import { registerSubagentTools } from "./subagents/tools.js";
import {
	FooterNavigationEditor,
	showManager,
	type AppEditorComponent,
} from "./subagents/ui.js";

export {
	abortRunningSubagentSessions,
	countsAgainstSubagentLimit,
	isFailedStopReason,
	isTerminalSubagentStatus,
	shouldArchiveTerminalSubagent,
} from "./subagents/lifecycle.js";
export {
	filterModelsToScope,
	inheritedSubagentModel,
	subagentModelGuidance,
	subagentModelRuntime,
} from "./subagents/models.js";
export { appendBoundedStreamingText } from "./subagents/transcript.js";
export { MAX_WEB_STREAMING_CHARS, THINKING_LEVELS } from "./subagents/types.js";
export type {
	MessageUrgency,
	SubagentEffort,
	SubagentStatus,
} from "./subagents/types.js";
export { parsePersistedUsageState } from "./subagents/usage.js";

export default function subagentsExtension(pi: ExtensionAPI): void {
	const manager = new SubagentManager(pi);
	let managerOpen = false;
	let mainAbortSignal: AbortSignal | undefined;
	let onMainAbort: (() => void) | undefined;
	let explicitAbortInProgress = false;

	pi.events.on(SUBAGENT_ABORT_EVENT, (value) => {
		const request = parseSubagentAbortRequest(value);
		if (!request) return;
		explicitAbortInProgress = true;
		const operation = manager.abortAll().finally(() => {
			explicitAbortInProgress = false;
		});
		request.waitUntil(operation);
	});

	const openManager = (ctx: ExtensionContext) => {
		if (managerOpen) return;
		managerOpen = true;
		manager.setFooterSelected(false);
		void showManager(manager, ctx).finally(() => {
			managerOpen = false;
		});
	};

	pi.on("before_agent_start", (event, ctx) => {
		if (!pi.getActiveTools().includes("subagent_create")) return;
		// Prompt construction must not trigger provider authentication or OAuth
		// refreshes. The host registry already maintains an authoritative snapshot.
		const available = filterModelsToScope(ctx.modelRegistry.getAvailable(), ctx.scopedModels);
		return { systemPrompt: `${event.systemPrompt}\n\n${subagentModelGuidance(ctx.model, available)}` };
	});

	registerSubagentTools(pi, manager);

	pi.registerCommand("subagents", {
		description: "Open the subagent manager",
		handler: async (_args, ctx) => openManager(ctx),
	});

	pi.registerCommand("subagents-cleanup", {
		description: "Terminate and remove all subagents",
		handler: async (_args, ctx) => {
			await manager.terminateAll(true);
			ctx.ui.notify("All subagents terminated and removed", "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		manager.setContext(ctx);
		if (ctx.mode !== "tui") return;
		const previousFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const base = (previousFactory?.(tui, theme, keybindings) ??
				new CustomEditor(tui, theme, keybindings)) as AppEditorComponent;
			return new FooterNavigationEditor(base, keybindings, manager, () => openManager(ctx));
		});
	});

	pi.on("input", async () => {
		await manager.clearTerminalAgents();
		return { action: "continue" };
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!ctx.signal) return;
		if (mainAbortSignal && onMainAbort) mainAbortSignal.removeEventListener("abort", onMainAbort);
		mainAbortSignal = ctx.signal;
		onMainAbort = () => {
			if (!explicitAbortInProgress) void manager.abortAll();
		};
		mainAbortSignal.addEventListener("abort", onMainAbort, { once: true });
	});

	pi.on("agent_settled", () => {
		if (mainAbortSignal && onMainAbort) mainAbortSignal.removeEventListener("abort", onMainAbort);
		mainAbortSignal = undefined;
		onMainAbort = undefined;
	});

	pi.on("session_shutdown", async () => {
		if (mainAbortSignal && onMainAbort) mainAbortSignal.removeEventListener("abort", onMainAbort);
		mainAbortSignal = undefined;
		onMainAbort = undefined;
		manager.setFooterSelected(false);
		try {
			await manager.terminateAll(false);
		} finally {
			manager.persistUsage();
			manager.clearContext();
		}
	});
}
