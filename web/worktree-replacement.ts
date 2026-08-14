export const WORKTREE_REPLACEMENT_ENTRY = "vessup-replaced-session";

export type WorktreeSessionReplacement = {
	previousSessionId: string;
	previousSessionFile: string;
	replacementSessionId: string;
};

export function replacementFromEntries(entries: readonly unknown[]): WorktreeSessionReplacement | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!entry || typeof entry !== "object") continue;
		const value = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (value.type !== "custom" || value.customType !== WORKTREE_REPLACEMENT_ENTRY || !value.data || typeof value.data !== "object") continue;
		const data = value.data as Partial<WorktreeSessionReplacement>;
		if (typeof data.previousSessionId === "string" && typeof data.previousSessionFile === "string" && typeof data.replacementSessionId === "string") {
			return data as WorktreeSessionReplacement;
		}
	}
	return undefined;
}
