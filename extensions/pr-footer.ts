import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type PullRequest = {
	number: number;
	url: string;
};

type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

const OSC_8_OPEN = "\x1b]8;;";
const OSC_8_CLOSE = "\x1b]8;;\x1b\\";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function numeric(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parsePullRequest(value: string): PullRequest | null {
	try {
		const parsed: unknown = JSON.parse(value);
		if (!isRecord(parsed) || !Number.isInteger(parsed.number) || numeric(parsed.number) < 1) return null;
		if (typeof parsed.url !== "string") return null;

		const url = new URL(parsed.url);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;

		return { number: numeric(parsed.number), url: url.toString() };
	} catch {
		return null;
	}
}

export function formatTokens(count: number): string {
	if (count < 1_000) return count.toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

export function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function addUsage(totals: UsageTotals, usage: unknown): void {
	if (!isRecord(usage)) return;

	totals.input += numeric(usage.input);
	totals.output += numeric(usage.output);
	totals.cacheRead += numeric(usage.cacheRead);
	totals.cacheWrite += numeric(usage.cacheWrite);
	if (isRecord(usage.cost)) totals.cost += numeric(usage.cost.total);
}

function hyperlink(url: string, label: string): string {
	return `${OSC_8_OPEN}${url}\x1b\\${label}${OSC_8_CLOSE}`;
}

function sanitizeStatus(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/** Align text on both sides, preserving ANSI and OSC 8 escape sequences. */
export function alignSides(left: string, right: string, width: number): string {
	if (width <= 0) return "";

	const rightWidth = visibleWidth(right);
	if (rightWidth > width) return truncateToWidth(right, width, "");

	const maxLeftWidth = Math.max(0, width - rightWidth - (left ? 1 : 0));
	const fittedLeft = maxLeftWidth > 0 ? truncateToWidth(left, maxLeftWidth, "...") : "";
	const padding = " ".repeat(Math.max(0, width - visibleWidth(fittedLeft) - rightWidth));
	return fittedLeft + padding + right;
}

async function findPullRequest(pi: ExtensionAPI, cwd: string): Promise<PullRequest | null> {
	const result = await pi.exec("gh", ["pr", "view", "--json", "number,url"], {
		cwd,
		timeout: 10_000,
	});
	if (result.code !== 0) return null;
	return parsePullRequest(result.stdout);
}

export default function prFooter(pi: ExtensionAPI): void {
	let refreshCurrent: (() => Promise<PullRequest | null>) | undefined;

	pi.registerCommand("pr-refresh", {
		description: "Refresh the pull request link in the footer",
		handler: async (_args, ctx) => {
			if (!refreshCurrent || ctx.mode !== "tui") {
				ctx.ui.notify("The PR footer is only available in TUI mode", "warning");
				return;
			}

			const pullRequest = await refreshCurrent();
			ctx.ui.notify(pullRequest ? `Showing PR #${pullRequest.number}` : "No PR found for the current branch", "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			let pullRequest: PullRequest | null = null;
			let disposed = false;
			let refreshGeneration = 0;

			const refresh = async (): Promise<PullRequest | null> => {
				const generation = ++refreshGeneration;
				const next = await findPullRequest(pi, ctx.cwd);
				if (disposed || generation !== refreshGeneration) return next;

				pullRequest = next;
				tui.requestRender();
				return next;
			};

			refreshCurrent = refresh;
			void refresh();

			const unsubscribeBranch = footerData.onBranchChange(() => {
				pullRequest = null;
				tui.requestRender();
				void refresh();
			});

			return {
				invalidate() {},
				dispose() {
					disposed = true;
					refreshGeneration++;
					unsubscribeBranch();
					if (refreshCurrent === refresh) refreshCurrent = undefined;
				},
				render(width: number): string[] {
					let cwd = formatCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
					const branch = footerData.getGitBranch();
					if (branch) cwd += ` (${branch})`;

					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) cwd += ` • ${sessionName}`;

					const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message") {
							if (entry.message.role === "assistant" || entry.message.role === "toolResult") {
								addUsage(totals, entry.message.usage);
							}
						} else if (entry.type === "branch_summary" || entry.type === "compaction") {
							addUsage(totals, entry.usage);
						}
					}

					const stats: string[] = [];
					if (totals.input) stats.push(`↑${formatTokens(totals.input)}`);
					if (totals.output) stats.push(`↓${formatTokens(totals.output)}`);
					if (totals.cacheRead) stats.push(`R${formatTokens(totals.cacheRead)}`);
					if (totals.cacheWrite) stats.push(`W${formatTokens(totals.cacheWrite)}`);
					if (totals.cost) stats.push(`$${totals.cost.toFixed(3)}`);

					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercent = contextUsage?.percent;
					stats.push(
						contextPercent === null || contextPercent === undefined
							? `?/${formatTokens(contextWindow)}`
							: `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)}`,
					);

					let model = ctx.model?.id || "no-model";
					if (ctx.model?.reasoning) {
						model += ctx.thinkingLevel === "off" ? " • thinking off" : ` • ${ctx.thinkingLevel}`;
					}
					if (ctx.model && footerData.getAvailableProviderCount() > 1) model = `(${ctx.model.provider}) ${model}`;

					const lines = [
						truncateToWidth(theme.fg("dim", cwd), width, theme.fg("dim", "...")),
						alignSides(theme.fg("dim", stats.join(" ")), theme.fg("dim", model), width),
					];

					const statuses = Array.from(footerData.getExtensionStatuses().entries())
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => sanitizeStatus(text))
						.join(" ");

					if (pullRequest) {
						const label = `PR #${pullRequest.number}`;
						const link = hyperlink(pullRequest.url, theme.fg("accent", label));
						if (visibleWidth(link) <= width) lines.push(alignSides(statuses, link, width));
					} else if (statuses) {
						lines.push(truncateToWidth(statuses, width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	});
}
