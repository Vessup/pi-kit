function parseWords(input: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const char of input.trim()) {
		if (escaped) {
			current += char;
			escaped = false;
		} else if (char === "\\" && quote !== "'") {
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

export type WorktreeCommandArgs = { name?: string; repository?: string; existing?: string };

const WORKTREE_USAGE = "Usage: /worktree <name> [--repo <path>] | /worktree --existing <worktree-path>";

/** Parse the create and existing-worktree forms without invoking a shell. */
export function parseWorktreeCommandArgs(input: string): WorktreeCommandArgs {
	const words = parseWords(input);
	let name: string | undefined;
	let repository: string | undefined;
	let existing: string | undefined;
	for (let index = 0; index < words.length; index += 1) {
		const word = words[index]!;
		if (word === "--repo" || word === "-C") {
			repository = words[index + 1];
			if (!repository) throw new Error(`${word} requires a repository path`);
			index += 1;
		} else if (word.startsWith("--repo=")) {
			repository = word.slice("--repo=".length);
			if (!repository) throw new Error("--repo requires a repository path");
		} else if (word === "--existing") {
			existing = words[index + 1];
			if (!existing) throw new Error("--existing requires a worktree path");
			index += 1;
		} else if (word.startsWith("--existing=")) {
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
	if (existing && (name || repository)) throw new Error(WORKTREE_USAGE);
	return { name, repository, existing };
}

/** Return undefined for ordinary prompts and parsed arguments for `/worktree`. */
export function parseWorktreeInvocation(text: string): WorktreeCommandArgs | undefined {
	const match = text.match(/^\/worktree(?:\s+([\s\S]*))?$/);
	return match ? parseWorktreeCommandArgs(match[1] ?? "") : undefined;
}
