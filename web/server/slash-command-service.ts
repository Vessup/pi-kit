import type { ExpandableSlashCommand } from "../slash-commands.js";
import { WEB_COMPACT_COMMAND } from "../compact-command.js";
import type { ManagedRpcSession } from "./managed-rpc-session.js";

export type DiscoveredSlashCommand = ExpandableSlashCommand & {
	description?: string;
	sourceInfo: ExpandableSlashCommand["sourceInfo"] & { scope?: "user" | "project" | "temporary" };
};

export class SlashCommandService {
	private readonly cache = new Map<string, { loadedAt: number; commands: DiscoveredSlashCommand[] }>();

	constructor(
		private readonly normalizePath: (path: string) => string,
		private readonly createRuntime: (cwd: string) => ManagedRpcSession,
	) {}

	parse(values: Array<Record<string, unknown>>): DiscoveredSlashCommand[] {
		return values.flatMap((value) => {
			if (typeof value.name !== "string" || (value.source !== "extension" && value.source !== "prompt" && value.source !== "skill")) return [];
			const sourceInfo = value.sourceInfo && typeof value.sourceInfo === "object" && !Array.isArray(value.sourceInfo)
				? value.sourceInfo as Record<string, unknown>
				: undefined;
			if (!sourceInfo || typeof sourceInfo.path !== "string") return [];
			return [{
				name: value.name,
				description: typeof value.description === "string" ? value.description : undefined,
				source: value.source,
				sourceInfo: {
					path: sourceInfo.path,
					baseDir: typeof sourceInfo.baseDir === "string" ? sourceInfo.baseDir : undefined,
					scope: sourceInfo.scope === "user" || sourceInfo.scope === "project" || sourceInfo.scope === "temporary" ? sourceInfo.scope : undefined,
				},
			}];
		});
	}

	async discover(cwd: string): Promise<DiscoveredSlashCommand[]> {
		const key = this.normalizePath(cwd);
		const cached = this.cache.get(key);
		if (cached && Date.now() - cached.loadedAt < 30_000) return cached.commands;
		const runtime = this.createRuntime(cwd);
		try {
			await runtime.start();
			const { commands } = await runtime.getCommands();
			const parsed = this.parse(commands);
			this.cache.set(key, { loadedAt: Date.now(), commands: parsed });
			return parsed;
		} finally {
			await runtime.shutdown();
		}
	}

	invalidate(cwd: string): void {
		this.cache.delete(this.normalizePath(cwd));
	}

	toWeb(commands: readonly DiscoveredSlashCommand[], includeExtensions = false): Array<Record<string, unknown>> {
		const visible = commands
			.filter((command) => command.name !== "web-reload" && (includeExtensions || command.source === "prompt" || command.source === "skill" || command.name === "worktree"))
			.map((command) => ({
				name: command.name,
				description: command.description,
				source: command.source,
				location: command.sourceInfo.scope,
			}));
		if (!visible.some((command) => command.name === "reload")) {
			visible.unshift({ name: "reload", description: "Reload extensions, skills, prompts, themes, and context files", source: "extension", location: "temporary" });
		}
		if (!visible.some((command) => command.name === "compact")) {
			visible.unshift({
				name: WEB_COMPACT_COMMAND.name,
				description: WEB_COMPACT_COMMAND.description,
				source: "extension",
				location: "temporary",
			});
		}
		return visible;
	}
}
