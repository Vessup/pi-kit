import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { truncateChars } from "./format.js";
import type { SubagentManager } from "./manager.js";
import {
	DEFAULT_READ_WAIT_SECONDS,
	MAX_SUBAGENTS,
	THINKING_LEVELS,
	type ToolDetails,
	type Usage,
} from "./types.js";

function toolResult(manager: SubagentManager, text: string): { content: [{ type: "text"; text: string }]; details: ToolDetails; usage?: Usage } {
	const usage = manager.claimUnaccountedUsage();
	return {
		content: [{ type: "text", text }],
		details: { agents: manager.webSnapshots() },
		...(usage ? { usage } : {}),
	};
}

function stringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values,
		...(options?.description ? { description: options.description } : {}),
		...(options?.default ? { default: options.default } : {}),
	});
}

const EffortSchema = stringEnum(THINKING_LEVELS, {
	description: "Reasoning effort. The selected model may clamp unsupported levels.",
});

const CreateParams = Type.Object({
	prompt: Type.String({ description: "Complete task prompt for the new isolated subagent" }),
	name: Type.Optional(Type.String({ description: "Short stable name used to address the subagent" })),
	model: Type.Optional(Type.String({ description: "Exact provider/model-id or exact unambiguous model id. Omit to inherit the current model; never use a shortened family alias." })),
	effort: Type.Optional(EffortSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory, relative to the main session unless absolute" })),
});

const ReadParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Subagent id. Omit to read all subagents." })),
	wait_seconds: Type.Optional(
		Type.Integer({
			description: `Wait for meaningful new activity before returning. Default ${DEFAULT_READ_WAIT_SECONDS}, maximum 30.`,
			minimum: 0,
			maximum: 30,
		}),
	),
	include_transcript: Type.Optional(Type.Boolean({ description: "Include the full retained transcript instead of only latest output" })),
});

const SendParams = Type.Object({
	id: Type.String({ description: "Subagent id" }),
	message: Type.String({ description: "Instruction to send" }),
	urgency: stringEnum(["normal", "urgent"] as const, {
		description: "urgent steers after the current tool batch; normal queues until the current run finishes",
	}),
});

const ConfigureParams = Type.Object({
	id: Type.String({ description: "Subagent id" }),
	model: Type.Optional(Type.String({ description: "Exact new provider/model-id or exact unambiguous model id. Omit to retain the current model; never use a shortened family alias." })),
	effort: Type.Optional(EffortSchema),
});

const TerminateParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Subagent id. Omit with all=true to terminate every subagent." })),
	all: Type.Optional(Type.Boolean({ description: "Terminate every subagent" })),
	remove: Type.Optional(Type.Boolean({ description: "Also remove terminated records from the footer and manager" })),
});


export function registerSubagentTools(pi: ExtensionAPI, manager: SubagentManager): void {
	pi.registerTool({
		name: "subagent_create",
		label: "Create subagent",
		description: `Create a background subagent with an isolated context, model, and reasoning effort. Returns immediately after startup. Up to ${MAX_SUBAGENTS} live subagent sessions are allowed.`,
		promptSnippet: "Create a background subagent with a chosen prompt, model, and effort",
		promptGuidelines: [
			"When calling subagent_create, omit model to inherit the current model unless deliberately choosing one of the exact session-available provider/model IDs listed in the system prompt; never shorten or invent a model ID.",
			"After subagent_create returns, use subagent_read with its default wait roughly every 15–30 seconds while work continues; briefly tell the user about meaningful progress between polls without narrating every event.",
			"Wait for subagent_create to return before calling another subagent management tool for that id.",
			"Use subagent_send with urgent only when the current approach must change immediately; use normal for work that can wait until the current run finishes.",
			"Use subagent_terminate when delegated work is no longer needed, and clean up retained subagents before finishing when appropriate.",
		],
		parameters: CreateParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const agent = await manager.create(ctx, params, signal);
			return toolResult(
				manager,
				`Created ${agent.id} with ${agent.model} at ${agent.effort} effort. It is running in ${agent.cwd}. Use subagent_read to wait for and inspect progress.`,
			);
		},
		renderCall(args, theme) {
			const name = args.name ? ` ${theme.fg("accent", args.name)}` : "";
			const model = args.model ? ` · ${args.model}` : "";
			const effort = args.effort ? ` · ${args.effort}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent_create"))}${name}${theme.fg("muted", model + effort)}\n${theme.fg("dim", truncateChars(args.prompt, 180))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0];
			return new Text(theme.fg("toolOutput", text?.type === "text" ? text.text : "Created subagent"), 0, 0);
		},
	});

	pi.registerTool({
		name: "subagent_read",
		label: "Read subagents",
		description: "Wait for and read meaningful subagent activity, status, output, usage, or full transcripts. Omit id to monitor all subagents.",
		promptSnippet: "Read and monitor background subagent activity and output",
		parameters: ReadParams,
		async execute(_toolCallId, params, signal) {
			const agents = params.id ? [manager.getAgent(params.id)] : manager.list();
			await manager.waitForUpdates(agents, params.wait_seconds ?? DEFAULT_READ_WAIT_SECONDS, signal);
			if (signal?.aborted) throw new Error("Subagent read was cancelled");
			return toolResult(manager, manager.read(agents, params.include_transcript ?? false));
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("subagent_read")) +
					theme.fg("muted", ` ${args.id ?? "all"} · wait ${args.wait_seconds ?? DEFAULT_READ_WAIT_SECONDS}s`),
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const raw = result.content[0];
			const text = raw?.type === "text" ? raw.text : "(no output)";
			return new Text(theme.fg("toolOutput", expanded ? text : text.split("\n").slice(0, 14).join("\n")), 0, 0);
		},
	});

	pi.registerTool({
		name: "subagent_send",
		label: "Message subagent",
		description: "Send an urgent steering message to a running subagent or queue a normal follow-up message for it.",
		promptSnippet: "Steer a subagent urgently or queue a normal follow-up instruction",
		parameters: SendParams,
		async execute(_toolCallId, params) {
			await manager.send(params.id, params.message, params.urgency);
			return toolResult(
				manager,
				params.urgency === "urgent"
					? `Steering message sent to ${params.id}.`
					: `Follow-up message queued for ${params.id}.`,
			);
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent_send"))} ${theme.fg("accent", args.id)} ${theme.fg(args.urgency === "urgent" ? "warning" : "muted", args.urgency)}\n${theme.fg("dim", truncateChars(args.message, 180))}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "subagent_configure",
		label: "Configure subagent",
		description: "Change a retained subagent's model and/or reasoning effort. Changes apply to its next model request.",
		promptSnippet: "Change a subagent model or reasoning effort",
		parameters: ConfigureParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agent = await manager.configure(ctx, params.id, params);
			return toolResult(manager, `${agent.id} now uses ${agent.model} at ${agent.effort} effort.`);
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent_configure"))} ${theme.fg("accent", args.id)}${theme.fg("muted", `${args.model ? ` · ${args.model}` : ""}${args.effort ? ` · ${args.effort}` : ""}`)}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "subagent_terminate",
		label: "Terminate subagent",
		description: "Abort one or all subagents, dispose their sessions, and optionally remove their retained transcript records.",
		promptSnippet: "Terminate subagents and release their resources",
		parameters: TerminateParams,
		async execute(_toolCallId, params) {
			if (params.all) {
				await manager.terminateAll(params.remove ?? false);
				return toolResult(manager, "Terminated all subagents and released their session resources.");
			}
			if (!params.id) throw new Error("Specify id or all=true");
			await manager.terminate(params.id, params.remove ?? false);
			return toolResult(manager, `Terminated ${params.id} and released its session resources.`);
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent_terminate"))} ${theme.fg("warning", args.all ? "all" : (args.id ?? "?"))}`,
				0,
				0,
			);
		},
	});
}
