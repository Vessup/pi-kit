import { unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	hasOtherSessionInWorktree,
	managedWorktreeFromEntries,
	removeManagedWorktree,
} from "../web/server/worktrees.js";

export default function deleteSessionExtension(pi: ExtensionAPI) {
	pi.registerCommand("delete-session", {
		description: "Delete the current session and quit pi",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("This session is not persisted, so there is no session file to delete.", "warning");
				return;
			}

			const managedWorktree = managedWorktreeFromEntries(ctx.sessionManager.getEntries());
			const sessionsRoot = dirname(ctx.sessionManager.getSessionDir());
			const shouldRemoveWorktree = Boolean(
				managedWorktree && !hasOtherSessionInWorktree(sessionsRoot, sessionFile, managedWorktree.path),
			);

			if (ctx.hasUI) {
				const confirmed = await ctx.ui.confirm(
					"Delete current session?",
					shouldRemoveWorktree
						? `This permanently deletes the current session, its managed worktree at ${managedWorktree!.path}, and quits pi.`
						: "This permanently deletes the current session and quits pi.",
				);
				if (!confirmed) return;
			}

			try {
				await unlink(sessionFile);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not delete the current session: ${message}`, "error");
				return;
			}

			const shouldRemoveWorktreeNow = Boolean(
				shouldRemoveWorktree
				&& managedWorktree
				&& !hasOtherSessionInWorktree(sessionsRoot, sessionFile, managedWorktree.path),
			);
			if (shouldRemoveWorktreeNow && managedWorktree) {
				try {
					const result = removeManagedWorktree(managedWorktree);
					if (result.branchWarning) ctx.ui.notify(`Worktree removed, but branch ${managedWorktree.branch} could not be deleted: ${result.branchWarning}`, "warning");
				} catch (error) {
					ctx.ui.notify(`Session deleted, but managed worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			}

			ctx.shutdown();
		},
	});
}
