function hasWindowsPathPrefix(value: string): boolean {
	return /^[A-Za-z]:/.test(value)
		|| value.startsWith("\\")
		|| value.includes(" ")
		|| value === "."
		|| value.startsWith(".\\")
		|| value === ".."
		|| value.startsWith("..\\");
}

function parseWords(input: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	const source = input.trim();
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index]!;
		if (escaped) {
			const startsRootRelativeWindowsPath = quote === '"' && !current && /^[A-Za-z.]$/.test(char);
			if (quote === '"' && (hasWindowsPathPrefix(current) || startsRootRelativeWindowsPath) && char !== "\\" && char !== '"') {
				current += `\\${char}`;
			} else if (quote === '"' && char === "u" && /^[0-9a-fA-F]{4}$/.test(source.slice(index + 1, index + 5))) {
				current += String.fromCharCode(Number.parseInt(source.slice(index + 1, index + 5), 16));
				index += 4;
			} else {
				const jsonEscape = quote === '"' ? { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[char] : undefined;
				current += jsonEscape ?? char;
			}
			escaped = false;
		} else if (char === "\\" && quote === '"' && !current && source[index + 1] === "\\" && source[index + 2] !== "\\") {
			current = "\\\\";
			index += 1;
		} else if (char === "\\" && (quote === '"' || (!quote && /\s/.test(source[index + 1] ?? "")))) {
			escaped = true;
		} else if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
		} else if (char === "'" || char === '"') {
			quote = char;
		} else if (/\s/.test(char)) {
			if (current) words.push(current);
			current = "";
		} else {
			current += char;
		}
	}
	if (escaped) current += "\\";
	if (quote) throw new Error("Unterminated quote in /worktree arguments");
	if (current) words.push(current);
	return words;
}

export type WorktreeCommandArgs = {
	name?: string;
	repository?: string;
	branch?: string;
	startPoint?: string;
	existing?: string;
};

export const WORKTREE_USAGE = "Usage: /worktree <name> [--repo <path>] [--branch <local-branch>] [--start-point <ref>] | /worktree --existing <worktree-path>";

/** Parse the create and existing-worktree forms without invoking a shell. */
export function parseWorktreeCommandArgs(input: string): WorktreeCommandArgs {
	const words = parseWords(input);
	let name: string | undefined;
	let repository: string | undefined;
	let branch: string | undefined;
	let startPoint: string | undefined;
	let existing: string | undefined;
	for (let index = 0; index < words.length; index += 1) {
		const word = words[index]!;
		if (word === "--repo" || word === "-C") {
			if (repository !== undefined) throw new Error("Duplicate /worktree repository option");
			repository = words[index + 1];
			if (!repository) throw new Error(`${word} requires a repository path`);
			index += 1;
		} else if (word.startsWith("--repo=")) {
			if (repository !== undefined) throw new Error("Duplicate /worktree repository option");
			repository = word.slice("--repo=".length);
			if (!repository) throw new Error("--repo requires a repository path");
		} else if (word === "--branch" || word === "-b") {
			if (branch !== undefined) throw new Error("Duplicate /worktree branch option");
			branch = words[index + 1];
			if (!branch) throw new Error(`${word} requires a local branch name`);
			index += 1;
		} else if (word.startsWith("--branch=")) {
			if (branch !== undefined) throw new Error("Duplicate /worktree branch option");
			branch = word.slice("--branch=".length);
			if (!branch) throw new Error("--branch requires a local branch name");
		} else if (word === "--start-point" || word === "--start") {
			if (startPoint !== undefined) throw new Error("Duplicate /worktree start-point option");
			startPoint = words[index + 1];
			if (!startPoint) throw new Error(`${word} requires a Git ref or commit`);
			index += 1;
		} else if (word.startsWith("--start-point=")) {
			if (startPoint !== undefined) throw new Error("Duplicate /worktree start-point option");
			startPoint = word.slice("--start-point=".length);
			if (!startPoint) throw new Error("--start-point requires a Git ref or commit");
		} else if (word === "--existing") {
			if (existing !== undefined) throw new Error("Duplicate /worktree existing option");
			existing = words[index + 1];
			if (!existing) throw new Error("--existing requires a worktree path");
			index += 1;
		} else if (word.startsWith("--existing=")) {
			if (existing !== undefined) throw new Error("Duplicate /worktree existing option");
			existing = word.slice("--existing=".length);
			if (!existing) throw new Error("--existing requires a worktree path");
		} else if (word.startsWith("-")) {
			throw new Error(`Unknown /worktree option: ${word}`);
		} else if (!name) {
			name = word;
		} else {
			throw new Error(WORKTREE_USAGE);
		}
	}
	if (existing && (name || repository || branch || startPoint)) throw new Error(WORKTREE_USAGE);
	return { name, repository, branch, startPoint, existing };
}

/** Serialize create-mode arguments without shell interpolation. */
export function formatWorktreeCreateCommandArgs(input: {
	name: string;
	repository: string;
	branch?: string;
	startPoint?: string;
}): string {
	return [
		JSON.stringify(input.name),
		`--repo ${JSON.stringify(input.repository)}`,
		input.branch ? `--branch ${JSON.stringify(input.branch)}` : undefined,
		input.startPoint ? `--start-point ${JSON.stringify(input.startPoint)}` : undefined,
	].filter((value): value is string => value !== undefined).join(" ");
}

/** Return undefined for ordinary prompts and parsed arguments for `/worktree`. */
export function parseWorktreeInvocation(text: string): WorktreeCommandArgs | undefined {
	const match = text.match(/^\/worktree(?:\s+([\s\S]*))?$/);
	return match ? parseWorktreeCommandArgs(match[1] ?? "") : undefined;
}
