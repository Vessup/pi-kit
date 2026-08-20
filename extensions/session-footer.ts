import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  FOOTER_CONTRIBUTION_EVENT,
  type FooterContribution,
  parseFooterContribution,
} from "./footer-events.js";

type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addUsage(totals: UsageTotals, usage: unknown): void {
  if (!isRecord(usage)) return;
  totals.input += numeric(usage.input);
  totals.output += numeric(usage.output);
  totals.cacheRead += numeric(usage.cacheRead);
  totals.cacheWrite += numeric(usage.cacheWrite);
  if (isRecord(usage.cost)) totals.cost += numeric(usage.cost.total);
}

function sanitizeStatus(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
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
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/** Align text on both sides while preserving ANSI and OSC 8 escape sequences. */
export function alignSides(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  const rightWidth = visibleWidth(right);
  if (rightWidth > width) {
    if (!left) return truncateToWidth(right, width, "");
    const leftBudget = Math.min(
      visibleWidth(left),
      Math.max(1, Math.floor(width * 0.4)),
    );
    const fittedLeft = truncateToWidth(left, leftBudget, "...");
    const rightBudget = Math.max(0, width - visibleWidth(fittedLeft) - 1);
    if (rightBudget === 0) return truncateToWidth(fittedLeft, width, "");
    return `${fittedLeft} ${truncateToWidth(right, rightBudget, "...")}`;
  }
  const maxLeftWidth = Math.max(0, width - rightWidth - (left ? 1 : 0));
  const fittedLeft =
    maxLeftWidth > 0 ? truncateToWidth(left, maxLeftWidth, "...") : "";
  const padding = " ".repeat(
    Math.max(0, width - visibleWidth(fittedLeft) - rightWidth),
  );
  return fittedLeft + padding + right;
}

export default function sessionFooter(pi: ExtensionAPI): void {
  let currentSessionId: string | undefined;
  let contributions = new Map<string, FooterContribution>();
  let requestRender: (() => void) | undefined;

  const unsubscribeContributions = pi.events.on(
    FOOTER_CONTRIBUTION_EVENT,
    (value) => {
      const event = parseFooterContribution(value);
      if (!event || event.sessionId !== currentSessionId) return;
      if (event.remove) contributions.delete(event.key);
      else contributions.set(event.key, event);
      requestRender?.();
    },
  );

  pi.on("session_start", (_event, ctx) => {
    currentSessionId = ctx.sessionManager.getSessionId();
    contributions = new Map();
    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      const rerender = () => tui.requestRender();
      requestRender = rerender;
      const unsubscribeBranch = footerData.onBranchChange(() => {
        for (const contribution of contributions.values()) {
          try {
            contribution.onBranchChange?.();
          } catch {
            // A footer contribution must not break the shared footer.
          }
        }
        tui.requestRender();
      });

      return {
        invalidate() {},
        dispose() {
          unsubscribeBranch();
          if (requestRender === rerender) requestRender = undefined;
        },
        render(width: number): string[] {
          const identityPrefix = Array.from(contributions.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([, contribution]) => {
              try {
                const rendered = contribution.identityPrefix?.(theme);
                return rendered ? [rendered] : [];
              } catch {
                return [];
              }
            })
            .join(" ");
          let cwd = formatCwd(
            ctx.sessionManager.getCwd(),
            process.env.HOME || process.env.USERPROFILE,
          );
          const branch = footerData.getGitBranch();
          if (branch) cwd += ` (${branch})`;
          const sessionName = ctx.sessionManager.getSessionName();
          if (sessionName) cwd += ` • ${sessionName}`;
          const identitySuffix = Array.from(contributions.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([, contribution]) => {
              try {
                const rendered = contribution.identitySuffix?.(theme);
                return rendered ? [rendered] : [];
              } catch {
                return [];
              }
            })
            .join(" ");
          if (identitySuffix) cwd += ` • ${identitySuffix}`;

          const totals: UsageTotals = {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
          };
          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type === "message") {
              if (
                entry.message.role === "assistant" ||
                entry.message.role === "toolResult"
              ) {
                addUsage(totals, entry.message.usage);
              }
            } else if (
              entry.type === "branch_summary" ||
              entry.type === "compaction"
            ) {
              addUsage(totals, entry.usage);
            }
          }
          for (const contribution of contributions.values())
            addUsage(totals, contribution.usage);

          const stats: string[] = [];
          if (totals.input) stats.push(`↑${formatTokens(totals.input)}`);
          if (totals.output) stats.push(`↓${formatTokens(totals.output)}`);
          if (totals.cacheRead)
            stats.push(`R${formatTokens(totals.cacheRead)}`);
          if (totals.cacheWrite)
            stats.push(`W${formatTokens(totals.cacheWrite)}`);
          if (totals.cost) stats.push(`$${totals.cost.toFixed(3)}`);

          const contextUsage = ctx.getContextUsage();
          const contextWindow =
            contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const contextPercent = contextUsage?.percent;
          stats.push(
            contextPercent === null || contextPercent === undefined
              ? `?/${formatTokens(contextWindow)}`
              : `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)}`,
          );

          let model = ctx.model?.id || "no-model";
          if (ctx.model?.reasoning) {
            model +=
              ctx.thinkingLevel === "off"
                ? " • thinking off"
                : ` • ${ctx.thinkingLevel}`;
          }
          if (ctx.model && footerData.getAvailableProviderCount() > 1)
            model = `(${ctx.model.provider}) ${model}`;

          const modelPrefix = Array.from(contributions.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([, contribution]) => {
              try {
                const rendered = contribution.modelPrefix?.(theme);
                return rendered ? [rendered] : [];
              } catch {
                return [];
              }
            })
            .join(theme.fg("dim", " • "));
          const statsRight = Array.from(contributions.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([, contribution]) => {
              try {
                const rendered = contribution.statsRight?.(theme);
                return rendered ? [rendered] : [];
              } catch {
                return [];
              }
            })
            .join(" ");
          const cwdLine = identityPrefix
            ? `${identityPrefix} ${theme.fg("dim", cwd)}`
            : theme.fg("dim", cwd);
          const modelLine = modelPrefix
            ? `${modelPrefix}${theme.fg("dim", " • ")}${theme.fg("dim", model)}`
            : theme.fg("dim", model);
          const statsLine = theme.fg("dim", stats.join(" "));
          const lines = [
            alignSides(cwdLine, modelLine, width),
            statsRight
              ? alignSides(statsLine, statsRight, width)
              : truncateToWidth(statsLine, width, theme.fg("dim", "...")),
          ];

          const contributionStatuses = Array.from(contributions.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([, contribution]) =>
              contribution.status ? [contribution.status] : [],
            );
          const extensionStatuses = Array.from(
            footerData.getExtensionStatuses().entries(),
          )
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => ({ text, selected: false }));
          const statuses = [...contributionStatuses, ...extensionStatuses];
          if (statuses.length > 0) {
            const statusLine = truncateToWidth(
              statuses
                .map((status) => sanitizeStatus(status.text))
                .filter(Boolean)
                .join(" "),
              width,
              theme.fg("dim", "..."),
            );
            if (statuses.some((status) => status.selected)) {
              const padding = " ".repeat(
                Math.max(0, width - visibleWidth(statusLine)),
              );
              lines.push(
                theme.bg(
                  "selectedBg",
                  theme.fg("accent", statusLine + padding),
                ),
              );
            } else if (statusLine) {
              lines.push(statusLine);
            }
          }
          return lines;
        },
      };
    });
  });

  pi.on("session_shutdown", () => {
    currentSessionId = undefined;
    contributions.clear();
    requestRender = undefined;
    unsubscribeContributions();
  });
}
