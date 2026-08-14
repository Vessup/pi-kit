const HIDDEN_TOOL_ARGUMENTS = new Set(["path", "command", "content", "edits", "name", "id"]);

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Whether expanding a tool card reveals arguments rendered by ArgumentDetails. */
export function toolHasArgumentDetails(name: string, input: unknown): boolean {
	const args = record(input);
	if (name === "bash") return true;
	if (name === "write") return typeof args.content === "string";
	if (name === "edit") return Array.isArray(args.edits);
	return Object.keys(args).some((key) => !HIDDEN_TOOL_ARGUMENTS.has(key));
}
