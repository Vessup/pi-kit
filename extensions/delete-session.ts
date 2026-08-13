import { unlink } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

			if (ctx.hasUI) {
				const confirmed = await ctx.ui.confirm(
					"Delete current session?",
					"This permanently deletes the current session and quits pi.",
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

			ctx.shutdown();
		},
	});
}
