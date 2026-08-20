import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  FOOTER_CONTRIBUTION_EVENT,
  type FooterContribution,
} from "./footer-events.js";

export { alignSides, formatCwd, formatTokens } from "./session-footer.js";

export type CheckStatus = "failure" | "pending" | "success";

type PullRequest = {
  number: number;
  url: string;
  checkStatus: CheckStatus;
};

const OSC_8_OPEN = "\x1b]8;;";
const OSC_8_CLOSE = "\x1b]8;;\x1b\\";
const NERD_FONT_BRANCH_ICON = "\uf418";
const REFRESH_INTERVAL_MS = 30_000;
const FAILING_CHECK_STATES = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "ERROR",
  "FAILURE",
  "STALE",
  "STARTUP_FAILURE",
  "TIMED_OUT",
]);
const PENDING_CHECK_STATES = new Set([
  "EXPECTED",
  "IN_PROGRESS",
  "PENDING",
  "QUEUED",
  "REQUESTED",
  "WAITING",
]);
const SUCCESSFUL_CHECK_STATES = new Set([
  "COMPLETED",
  "NEUTRAL",
  "SKIPPED",
  "SUCCESS",
]);
const CHECK_STATUS_COLORS = {
  failure: { rgb: [239, 68, 68], ansi256: 203 },
  pending: { rgb: [245, 158, 11], ansi256: 214 },
  success: { rgb: [34, 197, 94], ansi256: 41 },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function aggregateCheckStatus(value: unknown): CheckStatus {
  if (!Array.isArray(value) || value.length === 0) return "pending";
  let pending = false;
  for (const check of value) {
    if (!isRecord(check)) {
      pending = true;
      continue;
    }
    const states = [check.conclusion, check.state, check.status]
      .filter((state): state is string => typeof state === "string")
      .map((state) => state.toUpperCase());
    if (states.some((state) => FAILING_CHECK_STATES.has(state)))
      return "failure";
    if (
      states.length === 0 ||
      states.some((state) => PENDING_CHECK_STATES.has(state))
    )
      pending = true;
    if (
      states.some(
        (state) =>
          !FAILING_CHECK_STATES.has(state) &&
          !SUCCESSFUL_CHECK_STATES.has(state),
      )
    )
      pending = true;
  }
  return pending ? "pending" : "success";
}

export function parsePullRequest(value: string): PullRequest | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      !Number.isInteger(parsed.number) ||
      numeric(parsed.number) < 1
    )
      return null;
    if (typeof parsed.url !== "string") return null;
    const url = new URL(parsed.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return {
      number: numeric(parsed.number),
      url: url.toString(),
      checkStatus: aggregateCheckStatus(parsed.statusCheckRollup),
    };
  } catch {
    return null;
  }
}

function hyperlink(url: string, label: string): string {
  return `${OSC_8_OPEN}${url}\x1b\\${label}${OSC_8_CLOSE}`;
}

export function checkStatusCircle(
  status: CheckStatus,
  colorMode: "truecolor" | "256color",
): string {
  const color = CHECK_STATUS_COLORS[status];
  const foreground =
    colorMode === "truecolor"
      ? `\x1b[38;2;${color.rgb.join(";")}m`
      : `\x1b[38;5;${color.ansi256}m`;
  return `${foreground}●\x1b[39m`;
}

function renderPullRequest(pullRequest: PullRequest, theme: Theme): string {
  const link = hyperlink(
    pullRequest.url,
    theme.fg("accent", `${NERD_FONT_BRANCH_ICON} #${pullRequest.number}`),
  );
  return `${link} ${checkStatusCircle(pullRequest.checkStatus, theme.getColorMode())}`;
}

async function findPullRequest(
  pi: ExtensionAPI,
  cwd: string,
): Promise<PullRequest | null> {
  const result = await pi.exec(
    "gh",
    ["pr", "view", "--json", "number,url,statusCheckRollup"],
    {
      cwd,
      timeout: 10_000,
    },
  );
  if (result.code !== 0) return null;
  return parsePullRequest(result.stdout);
}

export default function prFooter(pi: ExtensionAPI): void {
  let currentSessionId: string | undefined;
  let currentCwd: string | undefined;
  let pullRequest: PullRequest | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshGeneration = 0;
  let refreshCurrent: (() => Promise<PullRequest | null>) | undefined;

  const publish = () => {
    if (!currentSessionId) return;
    const current = pullRequest;
    const contribution: FooterContribution = {
      sessionId: currentSessionId,
      key: "pull-request",
      identitySuffix: current
        ? (theme) => renderPullRequest(current, theme)
        : undefined,
      onBranchChange: () => {
        pullRequest = null;
        publish();
        void refreshCurrent?.();
      },
    };
    pi.events.emit(FOOTER_CONTRIBUTION_EVENT, contribution);
  };

  pi.registerCommand("pr-refresh", {
    description: "Refresh the pull request link and check status in the footer",
    handler: async (_args, ctx) => {
      if (!refreshCurrent || ctx.mode !== "tui") {
        ctx.ui.notify("The PR footer is only available in TUI mode", "warning");
        return;
      }
      const next = await refreshCurrent();
      ctx.ui.notify(
        next
          ? `Showing PR #${next.number}`
          : "No PR found for the current branch",
        "info",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    currentSessionId = ctx.sessionManager.getSessionId();
    currentCwd = ctx.cwd;
    pullRequest = null;
    if (ctx.mode !== "tui") return;

    const refresh = async (): Promise<PullRequest | null> => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = undefined;
      const generation = ++refreshGeneration;
      if (!currentCwd) return null;
      const next = await findPullRequest(pi, currentCwd);
      if (generation !== refreshGeneration || !currentSessionId) return next;
      pullRequest = next;
      publish();
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refresh();
      }, REFRESH_INTERVAL_MS);
      return next;
    };
    refreshCurrent = refresh;
    publish();
    void refresh();
  });

  pi.on("session_shutdown", () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
    refreshGeneration++;
    if (currentSessionId) {
      pi.events.emit(FOOTER_CONTRIBUTION_EVENT, {
        sessionId: currentSessionId,
        key: "pull-request",
        remove: true,
      } satisfies FooterContribution);
    }
    currentSessionId = undefined;
    currentCwd = undefined;
    pullRequest = null;
    refreshCurrent = undefined;
  });
}
