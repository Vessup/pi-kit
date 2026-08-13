import { readFile } from "node:fs/promises";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";

export type ExpandableSlashCommand = {
	name: string;
	source: "extension" | "prompt" | "skill";
	sourceInfo: { path: string; baseDir?: string };
};

function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	for (const char of argsString) {
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
		} else if (char === "'" || char === '"') {
			quote = char;
		} else if (/\s/.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}
	if (current) args.push(current);
	return args;
}

function substitutePromptArgs(content: string, args: string[]): string {
	const allArgs = args.join(" ");
	return content.replace(
		/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		(_match, defaultTarget: string | undefined, defaultValue: string | undefined, sliceStart: string | undefined, sliceLength: string | undefined, simple: string | undefined) => {
			if (defaultTarget) {
				const value = defaultTarget === "@" || defaultTarget === "ARGUMENTS" ? allArgs : args[Number(defaultTarget) - 1];
				return value || defaultValue || "";
			}
			if (sliceStart) {
				const start = Math.max(0, Number(sliceStart) - 1);
				return sliceLength ? args.slice(start, start + Number(sliceLength)).join(" ") : args.slice(start).join(" ");
			}
			if (simple === "@" || simple === "ARGUMENTS") return allArgs;
			return simple ? args[Number(simple) - 1] ?? "" : "";
		},
	);
}

function matchedSlashCommand(
	commands: readonly ExpandableSlashCommand[],
	text: string,
): { command: ExpandableSlashCommand; argsString: string } | undefined {
	const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	if (!match) return undefined;
	const command = commands.find((item) => item.name === match[1]);
	return command ? { command, argsString: match[2] ?? "" } : undefined;
}

/** Whether text invokes a discovered skill while preserving any user arguments. */
export function isSkillSlashCommand(commands: readonly ExpandableSlashCommand[], text: string): boolean {
	return matchedSlashCommand(commands, text)?.command.source === "skill";
}

/** Expand prompt templates, but preserve skill invocations for agent-side progressive disclosure. */
export async function expandSlashCommand(
	commands: readonly ExpandableSlashCommand[],
	text: string,
	options: { rejectExtensionCommands?: boolean } = {},
): Promise<string> {
	const matched = matchedSlashCommand(commands, text);
	if (!matched) return text;
	const { command, argsString } = matched;
	if (command.source === "extension") {
		if (options.rejectExtensionCommands) throw new Error(`Extension command /${command.name} is only available in Pi's native TUI`);
		return text;
	}
	if (command.source === "skill") return text;
	const raw = await readFile(command.sourceInfo.path, "utf8");
	return substitutePromptArgs(stripFrontmatter(raw), parseCommandArgs(argsString));
}
