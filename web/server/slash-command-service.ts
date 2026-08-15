import type { WebSlashCommand } from "../protocol.js";
import type { ExpandableSlashCommand } from "../slash-commands.js";
import { includeWebCompactCommand } from "../compact-command.js";
import type { ManagedRpcSession } from "./managed-rpc-session.js";

export type DiscoveredSlashCommand = ExpandableSlashCommand & {
	description?: string;
	sourceInfo: ExpandableSlashCommand["sourceInfo"] & { scope?: "user" | "project" | "temporary" };
};

export class SlashCommandService {
	private readonly cache = new Map<string, { loadedAt: number; commands: DiscoveredSlashCommand[] }>();
	private readonly inFlight = new Map<string, Promise<DiscoveredSlashCommand[]>>();

	constructor(
		private readonly normalizePath: (path: string) => string,
		private readonly createRuntime: (cwd: string) => ManagedRpcSession,
		private readonly discoverTimeoutMs = 10_000,
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
		const active = this.inFlight.get(key);
		if (active) return active;
		const pending = this.load(cwd, key).finally(() => this.inFlight.delete(key));
		this.inFlight.set(key, pending);
		return pending;
	}

	private async load(cwd: string, key: string): Promise<DiscoveredSlashCommand[]> {
		const runtime = this.createRuntime(cwd);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const parsed = await Promise.race([
				(async () => {
					await runtime.start();
					const { commands } = await runtime.getCommands();
					return this.parse(commands);
				})(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error(`Slash command discovery timed out for ${cwd}`)), this.discoverTimeoutMs);
					timer.unref?.();
				}),
			]);
			this.cache.set(key, { loadedAt: Date.now(), commands: parsed });
			return parsed;
		} finally {
			if (timer) clearTimeout(timer);
			await runtime.shutdown().catch(() => undefined);
		}
	}

	invalidate(cwd: string): void {
		this.cache.delete(this.normalizePath(cwd));
	}

	toWeb(commands: readonly DiscoveredSlashCommand[], includeExtensions = false): WebSlashCommand[] {
		const visible: WebSlashCommand[] = commands
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
		return includeWebCompactCommand(visible);
	}
}
