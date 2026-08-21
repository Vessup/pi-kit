import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { agentEndTerminalNotice } from "../web/assistant-message.js";
import {
  WEB_COMPACT_COMMAND,
  WEB_COMPACT_EXTENSION_COMMAND,
} from "../web/compact-command.js";
import { boundedWebHistory } from "../web/history.js";
import {
  applyRuntimeModelStatus,
  isAutoModelReference,
  isAutoRuntimeModelSwap,
  lastAutoRoutedModelFromEntries,
  selectedAutoModelFromEntries,
  selectedModelReference,
  webModelReference,
} from "../web/model-status.js";
import type {
  AgentCommand,
  AgentEventMessage,
  AgentHelloMessage,
  AgentHistoryMessage,
  AgentResponseMessage,
  AgentSessionReplacedMessage,
  AgentSubagentsMessage,
  AgentToServerMessage,
  AgentUpdateMessage,
  RpcSessionCommand,
  ServerStateFile,
  TailscaleWebStatus,
  WebSession,
} from "../web/protocol.js";
import { mergeWebSubagentUpdates, WEB_STATE_VERSION } from "../web/protocol.js";
import { isConfirmedMissingPath } from "../web/server/file-presence.js";
import { managedWorktreeFromEntries } from "../web/server/worktrees.js";
import {
  expandSlashCommand,
  isSkillSlashCommand,
} from "../web/slash-commands.js";
import type { TailscaleWebSettings } from "../web/tailscale.js";
import { formatWorktreeCreateCommandArgs } from "../web/worktree-command.js";
import {
  AUTO_ROUTER_COMPACTION_EVENT,
  AUTO_ROUTER_MODEL_ROUTING_EVENT,
} from "./auto-router.js";
import {
  FOOTER_CONTRIBUTION_EVENT,
  type FooterContribution,
} from "./footer-events.js";
import {
  SUBAGENT_ABORT_EVENT,
  SUBAGENT_STATUS_EVENT,
  type SubagentAbortRequest,
  type SubagentStatusEvent,
} from "./subagent-events.js";
import {
  readWebTailscaleSetting,
  withWebTailscaleLock,
  writeWebTailscaleSetting,
} from "./web-settings.js";
import {
  consumeWorktreeReplacement,
  replacementFromEntries,
  runWorktreeCommand,
  type WorktreeSessionReplacement,
} from "./worktree.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = join(PACKAGE_ROOT, "web", "server", "index.ts");

// The detached Bun daemon runs outside Pi's extension loader. Point it at the
// host Pi modules because registry installs intentionally omit optional peers.
function hostNodeModulesPath(): string | undefined {
  try {
    let directory = dirname(
      fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
    );
    while (true) {
      if (basename(directory) === "node_modules") return directory;
      const parent = dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  } catch {
    return undefined;
  }
}

const HOST_NODE_MODULES = hostNodeModulesPath();
const STATE_FILE = process.env.PI_WEB_STATE_FILE
  ? resolve(process.env.PI_WEB_STATE_FILE)
  : join(getAgentDir(), "web", "server.json");
const FOOTER_KEY = "web-session";
const MAX_RECONNECT_DELAY_MS = 10_000;
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

function modelThinkingLevels(model: {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
}): string[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function isScopedModelAllowed(
  scopedModels: readonly { model: { provider: string; id: string } }[],
  provider: string,
  modelId: string,
): boolean {
  return (
    scopedModels.length === 0 ||
    scopedModels.some(
      ({ model }) => model.provider === provider && model.id === modelId,
    )
  );
}

function bridgeCommandList(pi: ExtensionAPI) {
  const commands = pi
    .getCommands()
    .filter(
      (command) =>
        command.source === "prompt" ||
        command.source === "skill" ||
        command.name === "worktree",
    )
    .map((command) => ({
      name: command.name,
      description: command.description,
      source: command.source,
      location: command.sourceInfo.scope,
    }));
  if (!commands.some((command) => command.name === "reload")) {
    commands.unshift({
      name: "reload",
      description:
        "Reload extensions, skills, prompts, themes, and context files",
      source: "extension",
      location: "temporary",
    });
  }
  if (!commands.some((command) => command.name === "compact")) {
    commands.unshift({
      name: WEB_COMPACT_COMMAND.name,
      description: WEB_COMPACT_COMMAND.description,
      source: "extension",
      location: "temporary",
    });
  }
  return commands;
}

export function splitWebWorktreeCommandArgs(args: string): {
  token: string;
  worktreeArgs: string;
} {
  const trimmed = args.trim();
  const separator = trimmed.search(/\s/);
  return separator < 0
    ? { token: trimmed, worktreeArgs: "" }
    : {
        token: trimmed.slice(0, separator),
        worktreeArgs: trimmed.slice(separator + 1),
      };
}

/** Abort the main session and wait for subagent abort operations registered through waitUntil. */
export function abortSessionAndSubagents(options: {
  sessionId: string;
  abortMain(): void;
  emit(request: SubagentAbortRequest): void;
}): Promise<void> {
  const operations: Promise<unknown>[] = [];
  const request: SubagentAbortRequest = {
    sessionId: options.sessionId,
    waitUntil(operation) {
      operations.push(operation);
    },
  };
  try {
    options.emit(request);
  } catch {
    // A broken optional listener must never prevent the main Stop request.
  }
  options.abortMain();
  return Promise.allSettled(operations).then(() => undefined);
}

/** Apply a route change and roll it back if the matching settings write fails. */
export async function applyTailscaleSettingTransaction<
  TSetting,
  TStatus,
>(options: {
  current: TSetting;
  next: TSetting;
  apply: (setting: TSetting) => Promise<TStatus>;
  persist: (setting: TSetting) => Promise<void>;
}): Promise<TStatus> {
  const status = await options.apply(options.next);
  try {
    await options.persist(options.next);
    return status;
  } catch (persistError) {
    try {
      await options.apply(options.current);
    } catch (rollbackError) {
      throw new AggregateError(
        [persistError, rollbackError],
        `Could not persist Tailscale settings and route rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    throw persistError;
  }
}
const START_TIMEOUT_MS = 8_000;
const FORK_TIMEOUT_MS = 30_000;
const WORKTREE_TIMEOUT_MS = 10 * 60_000;
type ForkResult = { cancelled: boolean; sessionId?: string };
type WorktreeResult = {
  cancelled: boolean;
  sessionId?: string;
  path?: string;
  branch?: string;
};
type PendingFork = {
  owner: BridgeState;
  expectingReplacement: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: ForkResult) => void;
  reject: (error: Error) => void;
};
const PENDING_FORKS_KEY = Symbol.for("@vessup/pi-kit/web-pending-forks");
type PendingForkGlobal = typeof globalThis & {
  [PENDING_FORKS_KEY]?: Map<string, PendingFork>;
};
const pendingForksGlobal = globalThis as PendingForkGlobal;
if (!pendingForksGlobal[PENDING_FORKS_KEY]) {
  pendingForksGlobal[PENDING_FORKS_KEY] = new Map<string, PendingFork>();
}
const pendingForks = pendingForksGlobal[PENDING_FORKS_KEY];
const PENDING_RELOADS_KEY = Symbol.for("@vessup/pi-kit/web-pending-reloads");
type PendingReloadGlobal = typeof globalThis & {
  [PENDING_RELOADS_KEY]?: Set<string>;
};
const pendingReloadsGlobal = globalThis as PendingReloadGlobal;
if (!pendingReloadsGlobal[PENDING_RELOADS_KEY]) {
  pendingReloadsGlobal[PENDING_RELOADS_KEY] = new Set<string>();
}
const pendingReloads = pendingReloadsGlobal[PENDING_RELOADS_KEY];
const WEB_RELOAD_GENERATION = crypto.randomUUID();

type SocketLike = WebSocket;
type BridgeState = {
  ctx: ExtensionContext;
  session: WebSession;
  replacement?: BridgeState;
  server?: ServerStateFile;
  socket?: SocketLike;
  closed: boolean;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  reconnectAttempt: number;
  pending: AgentToServerMessage[];
  /** Set before Auto's before_agent_start hook swaps in the concrete model. */
  autoTurnRouting: boolean;
  /** True while Auto itself is applying a runtime model swap. */
  autoRuntimeRouting: boolean;
  /** Latest browser model choice waiting for the active turn to settle. */
  pendingModelSelection?: { provider: string; modelId: string };
  applyingModelSelection?: boolean;
  metrics: Pick<WebSession, "usage" | "contextUsage">;
  sourceReplacement?: WorktreeSessionReplacement;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function runAutoRouterCompactionAction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  action: "route" | "restore",
  holdThroughCompaction = false,
): Promise<void> {
  const operations: Promise<void>[] = [];
  pi.events.emit(AUTO_ROUTER_COMPACTION_EVENT, {
    action,
    ctx,
    holdThroughCompaction,
    waitUntil(operation: Promise<void>) {
      operations.push(operation);
    },
  });
  return Promise.all(operations).then(() => undefined);
}

function compactInstructionsFromCommandArgs(args: string): string | undefined {
  const trimmed = args.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : trimmed;
  } catch {
    return trimmed;
  }
}

async function compactWithWebRouting(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  customInstructions: string | undefined,
  bridge?: BridgeState,
): Promise<unknown> {
  try {
    await runAutoRouterCompactionAction(pi, ctx, "route", true);
    return await new Promise<unknown>((resolveCompaction, rejectCompaction) => {
      try {
        ctx.compact({
          customInstructions,
          onComplete: resolveCompaction,
          onError: (error) => {
            if (bridge) {
              endBridgeCompaction(bridge, {
                aborted: false,
                willRetry: false,
                errorMessage: error.message,
              });
            }
            rejectCompaction(error);
          },
        });
      } catch (error) {
        rejectCompaction(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  } finally {
    await runAutoRouterCompactionAction(pi, ctx, "restore").catch(
      () => undefined,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function parseState(value: unknown): ServerStateFile | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.version !== WEB_STATE_VERSION ||
    typeof value.pid !== "number" ||
    typeof value.port !== "number" ||
    typeof value.startedAt !== "number"
  )
    return undefined;
  return value as unknown as ServerStateFile;
}

async function readServerState(): Promise<ServerStateFile | undefined> {
  try {
    return parseState(JSON.parse(await readFile(STATE_FILE, "utf8")));
  } catch {
    return undefined;
  }
}

function serverBase(state: ServerStateFile): string {
  return `http://127.0.0.1:${state.port}`;
}

function publishedServerBase(state: ServerStateFile): string {
  return state.tailscale?.published && state.tailscale.url
    ? state.tailscale.url
    : serverBase(state);
}

async function updateTailscaleServer(
  state: ServerStateFile,
  setting: TailscaleWebSettings,
  currentSetting?: TailscaleWebSettings,
): Promise<TailscaleWebStatus> {
  const url = new URL("/api/tailscale", serverBase(state));
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: serverBase(state) },
    body: JSON.stringify({
      ...setting,
      ...(currentSetting ? { current: currentSetting } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : response.statusText;
    throw new Error(message || "Could not update Tailscale Serve");
  }
  if (!isRecord(payload) || !isRecord(payload.tailscale))
    throw new Error("Pi web returned an invalid Tailscale response");
  return payload.tailscale as TailscaleWebStatus;
}

/** Verify the detached daemon and make its tailnet route authoritative before exit. */
export async function reconcileBackgroundWebServer(options: {
  ensure: () => Promise<ServerStateFile>;
  readSetting: () => Promise<TailscaleWebSettings>;
  withLock?: <T>(operation: () => Promise<T>) => Promise<T>;
  updateTailscale: (
    state: ServerStateFile,
    setting: TailscaleWebSettings,
    currentSetting: TailscaleWebSettings,
  ) => Promise<TailscaleWebStatus>;
}): Promise<ServerStateFile> {
  const withLock = options.withLock ?? (async (operation) => await operation());
  return await withLock(async () => {
    const server = await options.ensure();
    const setting = await options.readSetting();
    if (!setting.enabled) return server;
    const tailscale = await options.updateTailscale(server, setting, setting);
    if (!tailscale.published || tailscale.error)
      throw new Error(
        tailscale.error ?? "Tailscale Serve did not publish Pi web",
      );
    return { ...server, tailscale };
  });
}

async function keepWebServerBackgrounded(): Promise<ServerStateFile> {
  return await reconcileBackgroundWebServer({
    ensure: ensureServer,
    readSetting: readWebTailscaleSetting,
    withLock: withWebTailscaleLock,
    updateTailscale: updateTailscaleServer,
  });
}

/** The /api/health fields the bridge cares about when adopting a daemon. */
export type DaemonHealthPayload = {
  ok: true;
  pid: number;
  assets?: boolean;
  root?: string;
};

/** Parse a /api/health body only when it names the state file's daemon. */
export function parseDaemonHealth(
  payload: unknown,
  state: ServerStateFile,
): DaemonHealthPayload | undefined {
  if (!isRecord(payload) || payload.ok !== true || payload.pid !== state.pid)
    return undefined;
  return payload as DaemonHealthPayload;
}

/** Healthy enough to adopt: the CLI↔daemon bridge only needs the WS/API
 * surface, not the browser bundle. A daemon is rejected only when its own
 * checkout is confirmed gone, since that daemon can never serve anything
 * again — blocking adoption on a stale web/dist would break /web, session
 * mirroring, and /web-tailscale for otherwise-healthy daemons. */
export function daemonIsAdoptable(payload: DaemonHealthPayload): boolean {
  const root = payload.root ?? "";
  return !(root !== "" && isConfirmedMissingPath(root));
}

/** A degraded (stale/failed) browser build over a live checkout. */
export function daemonBuildIsDegraded(payload: DaemonHealthPayload): boolean {
  return payload.assets === false;
}

function warnIfDegraded(payload: DaemonHealthPayload | undefined): void {
  if (payload && daemonBuildIsDegraded(payload))
    console.warn(
      `Pi web server cannot serve its web app (run 'bun run webBuild' in ${payload.root || "its checkout"} and restart it); session bridging continues normally.`,
    );
}

async function fetchDaemonHealth(
  state: ServerStateFile,
): Promise<DaemonHealthPayload | undefined> {
  try {
    const url = new URL("/api/health", serverBase(state));
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return undefined;
    return parseDaemonHealth(await response.json(), state);
  } catch {
    return undefined;
  }
}

async function ensureServer(): Promise<ServerStateFile> {
  const current = await readServerState();
  if (current) {
    const payload = await fetchDaemonHealth(current);
    if (payload && daemonIsAdoptable(payload)) {
      warnIfDegraded(payload);
      return current;
    }
  }

  const nodePath = [HOST_NODE_MODULES, process.env.NODE_PATH]
    .filter((path): path is string => Boolean(path))
    .join(delimiter);
  const child = spawn("bun", ["run", SERVER_ENTRY], {
    cwd: PACKAGE_ROOT,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ...(nodePath ? { NODE_PATH: nodePath } : {}),
      PI_WEB_ROOT: PACKAGE_ROOT,
      PI_WEB_STATE_FILE: STATE_FILE,
    },
  });
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(100);
    const state = await readServerState();
    if (!state) continue;
    const payload = await fetchDaemonHealth(state);
    if (payload && daemonIsAdoptable(payload)) {
      warnIfDegraded(payload);
      return state;
    }
  }
  throw new Error(
    "Pi web server did not become ready. Make sure Bun is installed and web assets are built.",
  );
}

function zeroWebUsage(): NonNullable<WebSession["usage"]> {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addWebUsage(
  target: NonNullable<WebSession["usage"]>,
  value: unknown,
): void {
  if (!isRecord(value)) return;
  const number = (key: string) =>
    typeof value[key] === "number" && Number.isFinite(value[key])
      ? (value[key] as number)
      : 0;
  target.input += number("input");
  target.output += number("output");
  target.cacheRead += number("cacheRead");
  target.cacheWrite += number("cacheWrite");
  target.totalTokens += number("totalTokens");
  if (!isRecord(value.cost)) return;
  const cost = value.cost;
  for (const key of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "total",
  ] as const) {
    if (typeof cost[key] === "number" && Number.isFinite(cost[key]))
      target.cost[key] += cost[key];
  }
}

function contextUsage(ctx: ExtensionContext): WebSession["contextUsage"] {
  const usage = ctx.getContextUsage();
  return usage
    ? { ...usage }
    : ctx.model
      ? { tokens: null, contextWindow: ctx.model.contextWindow, percent: null }
      : undefined;
}

function sessionMetrics(
  ctx: ExtensionContext,
): Pick<WebSession, "usage" | "contextUsage"> {
  const usage = zeroWebUsage();
  for (const entry of ctx.sessionManager.getEntries()) {
    if (
      entry.type === "message" &&
      (entry.message.role === "assistant" ||
        entry.message.role === "toolResult")
    ) {
      addWebUsage(usage, entry.message.usage);
    } else if (entry.type === "branch_summary" || entry.type === "compaction") {
      addWebUsage(usage, entry.usage);
    }
  }
  return { usage, contextUsage: contextUsage(ctx) };
}

function refreshIncrementalMetrics(
  state: BridgeState,
  usageValue: unknown,
): void {
  const current = state.metrics.usage ?? zeroWebUsage();
  const usage = { ...current, cost: { ...current.cost } };
  addWebUsage(usage, usageValue);
  state.metrics = { usage, contextUsage: contextUsage(state.ctx) };
}

function safeClone(value: unknown): Record<string, unknown> {
  try {
    const cloned: unknown = JSON.parse(JSON.stringify(value));
    return isRecord(cloned) ? cloned : { value: cloned };
  } catch (error) {
    return {
      type: "serialization_error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function sessionUrl(state: ServerStateFile, sessionId: string): string {
  const url = new URL("/", publishedServerBase(state));
  url.hash = `/sessions/${encodeURIComponent(sessionId)}`;
  return url.toString();
}

function hyperlink(url: string, label: string): string {
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

function renderWebLink(theme: Theme, url: string): string {
  // Some terminals eat the trailing space between the OSC 8 link close and
  // the following glyph, leaving the icon visually glued to the directory
  // text. Wrapping the trailing space inside the hyperlink avoids that.
  return hyperlink(url, `${theme.fg("accent", "⧉")} `);
}

function publishFooter(pi: ExtensionAPI, state: BridgeState): void {
  const server = state.server;
  const contribution: FooterContribution = {
    sessionId: state.session.id,
    key: FOOTER_KEY,
    identityPrefix: server
      ? (theme) => renderWebLink(theme, sessionUrl(server, state.session.id))
      : undefined,
    onBranchChange: () => {
      void refreshGitMetadata(pi, state);
    },
  };
  pi.events.emit(FOOTER_CONTRIBUTION_EVENT, contribution);
}

function removeFooter(pi: ExtensionAPI, sessionId: string): void {
  pi.events.emit(FOOTER_CONTRIBUTION_EVENT, {
    sessionId,
    key: FOOTER_KEY,
    remove: true,
  } satisfies FooterContribution);
}

function send(state: BridgeState, message: AgentToServerMessage): void {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(message));
    return;
  }
  state.pending.push(message);
  if (state.pending.length > 500)
    state.pending.splice(0, state.pending.length - 500);
}

function sendSourceReplacement(
  state: BridgeState,
  replacement: WorktreeSessionReplacement,
): void {
  state.sourceReplacement = replacement;
  send(state, {
    type: "agent.session_replaced",
    ...replacement,
  } satisfies AgentSessionReplacedMessage);
}

function flush(state: BridgeState): void {
  if (state.socket?.readyState !== WebSocket.OPEN) return;
  for (const message of state.pending.splice(0))
    state.socket.send(JSON.stringify(message));
}

function discardPendingCoveredByHello(state: BridgeState): void {
  // Hello includes authoritative history and the fully merged subagent snapshot.
  // Replaying an old delta after it would duplicate transcript/streaming content.
  state.pending = state.pending.filter(
    (message) => message.type === "agent.response",
  );
}

function statusForContext(ctx: ExtensionContext): WebSession["status"] {
  return ctx.isIdle() ? "idle" : "working";
}

async function findPullRequest(
  pi: ExtensionAPI,
  cwd: string,
): Promise<WebSession["pullRequest"]> {
  try {
    const result = await pi.exec("gh", ["pr", "view", "--json", "number,url"], {
      cwd,
      timeout: 10_000,
    });
    if (result.code !== 0) return undefined;
    const value: unknown = JSON.parse(result.stdout);
    if (
      !isRecord(value) ||
      !Number.isInteger(value.number) ||
      typeof value.url !== "string"
    )
      return undefined;
    const url = new URL(value.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return { number: value.number as number, url: url.toString() };
  } catch {
    return undefined;
  }
}

async function refreshGitMetadata(
  pi: ExtensionAPI,
  state: BridgeState,
): Promise<void> {
  let branch: string | undefined;
  try {
    const result = await pi.exec("git", ["branch", "--show-current"], {
      cwd: state.ctx.cwd,
    });
    if (result.code === 0) branch = result.stdout.trim() || undefined;
  } catch {
    // Non-git working directories are valid sessions.
  }
  const pullRequest = branch
    ? await findPullRequest(pi, state.ctx.cwd)
    : undefined;
  if (!state.closed) updateSession(state, { branch, pullRequest });
}

export function applySubagentStatusToSession(
  session: WebSession,
  event: SubagentStatusEvent,
): WebSession {
  return {
    ...session,
    subagents: event.remove
      ? []
      : mergeWebSubagentUpdates(session.subagents, event.agents),
    subagentUsage: event.usage,
  };
}

function updateSession(
  state: BridgeState,
  patch: Partial<WebSession> = {},
): void {
  state.session = {
    ...state.session,
    ...state.metrics,
    ...patch,
    status: patch.status ?? statusForContext(state.ctx),
    updatedAt: Date.now(),
  };
  // Subagent transcripts use their own incremental channel. Omitting them here
  // prevents unrelated session updates from retransmitting the retained corpus.
  const {
    subagents: _subagents,
    subagentUsage: _subagentUsage,
    ...session
  } = state.session;
  send(state, { type: "agent.update", session } satisfies AgentUpdateMessage);
}

function respond(
  state: BridgeState,
  requestId: string,
  success: boolean,
  data?: unknown,
  error?: string,
): void {
  while (state.closed && state.replacement) state = state.replacement;
  send(state, {
    type: "agent.response",
    requestId,
    success,
    data,
    error,
  } satisfies AgentResponseMessage);
}

function startBridgeCompaction(
  state: BridgeState,
  reason: "manual" | "threshold" | "overflow",
  willRetry: boolean,
): void {
  const compaction = { reason, startedAt: Date.now() };
  updateSession(state, { status: "working", compaction });
  send(state, {
    type: "agent.event",
    sessionId: state.session.id,
    event: { type: "compaction_start", ...compaction, willRetry },
  } satisfies AgentEventMessage);
}

function endBridgeCompaction(
  state: BridgeState,
  options: {
    aborted: boolean;
    willRetry: boolean;
    errorMessage?: string;
    tokensBefore?: number;
  },
): void {
  const compaction = state.session.compaction;
  if (!compaction) return;
  send(state, {
    type: "agent.event",
    sessionId: state.session.id,
    event: { type: "compaction_end", reason: compaction.reason, ...options },
  } satisfies AgentEventMessage);
  updateSession(state, { compaction: undefined });
}

function replacePendingForkOwners(
  owner: BridgeState,
  replacement: BridgeState,
): void {
  for (const pending of pendingForks.values()) {
    if (pending.owner === owner && pending.expectingReplacement)
      pending.owner = replacement;
  }
}

function rejectPendingForks(
  owner: BridgeState,
  reason: string,
  preserveExpectedReplacement = false,
): void {
  for (const [token, pending] of pendingForks) {
    if (
      pending.owner !== owner ||
      (preserveExpectedReplacement && pending.expectingReplacement)
    )
      continue;
    pendingForks.delete(token);
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
}

async function requestFork(
  pi: ExtensionAPI,
  state: BridgeState,
  message: string,
): Promise<ForkResult> {
  const token = crypto.randomUUID();
  return await new Promise<ForkResult>((resolveFork, rejectFork) => {
    const finish = (error?: Error, result?: ForkResult) => {
      const pending = pendingForks.get(token);
      if (!pending) return;
      pendingForks.delete(token);
      clearTimeout(pending.timer);
      if (error) rejectFork(error);
      else resolveFork(result ?? { cancelled: true });
    };
    const timer = setTimeout(
      () => finish(new Error("Pi session fork timed out")),
      FORK_TIMEOUT_MS,
    );
    timer.unref?.();
    pendingForks.set(token, {
      owner: state,
      expectingReplacement: false,
      timer,
      resolve: (result) => finish(undefined, result),
      reject: (error) => finish(error),
    });
    try {
      pi.sendUserMessage(`${message} ${token}`);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function resolveBridgeModel(
  state: BridgeState,
  provider: string,
  modelId: string,
): Model<Api> {
  if (!isScopedModelAllowed(state.ctx.scopedModels, provider, modelId)) {
    throw new Error(
      `Model is outside this session's configured scope: ${provider}/${modelId}`,
    );
  }
  const model = state.ctx.modelRegistry.find(provider, modelId);
  if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
  return model;
}

async function applyBridgeModelSelection(
  pi: ExtensionAPI,
  state: BridgeState,
  selection: { provider: string; modelId: string },
): Promise<void> {
  const model = resolveBridgeModel(
    state,
    selection.provider,
    selection.modelId,
  );
  if (!(await pi.setModel(model))) {
    throw new Error(
      `No credentials available for ${selection.provider}/${selection.modelId}`,
    );
  }
  // A browser model change is explicit user selection, not Auto's transient
  // model swap for the current turn.
  state.autoTurnRouting = false;
  updateSession(state, {
    model: `${model.provider}/${model.id}`,
    selectedModel: `${model.provider}/${model.id}`,
    lastModel: null,
  });
}

async function applyPendingBridgeModelSelection(
  pi: ExtensionAPI,
  state: BridgeState,
): Promise<void> {
  if (!state.pendingModelSelection || state.applyingModelSelection) return;
  state.applyingModelSelection = true;
  try {
    while (state.pendingModelSelection) {
      const selection = state.pendingModelSelection;
      state.pendingModelSelection = undefined;
      try {
        await applyBridgeModelSelection(pi, state, selection);
      } catch (error) {
        send(state, {
          type: "agent.event",
          sessionId: state.session.id,
          event: {
            type: "model_selection_error",
            message: error instanceof Error ? error.message : String(error),
          },
        } satisfies AgentEventMessage);
      }
    }
  } finally {
    state.applyingModelSelection = false;
  }
}

async function executeAgentCommand(
  pi: ExtensionAPI,
  state: BridgeState,
  requestId: string,
  command: AgentCommand | RpcSessionCommand,
): Promise<void> {
  try {
    switch (command.type) {
      case "prompt": {
        const message = await expandSlashCommand(
          pi.getCommands(),
          command.message,
          { rejectExtensionCommands: true },
        );
        pi.sendUserMessage(
          command.images?.length
            ? [
                ...(message ? [{ type: "text" as const, text: message }] : []),
                ...command.images.map((image) => ({
                  type: "image" as const,
                  data: image.data,
                  mimeType: image.mimeType,
                })),
              ]
            : message,
          state.ctx.isIdle()
            ? undefined
            : { deliverAs: command.streamingBehavior ?? "steer" },
        );
        respond(state, requestId, true);
        return;
      }
      case "abort": {
        // Invoke the main abort before acknowledging, then let subagent teardown
        // settle in the background. Compaction can delay that settlement well
        // past the browser's command bound even though Stop has taken effect.
        void abortSessionAndSubagents({
          sessionId: state.session.id,
          abortMain: () => state.ctx.abort(),
          emit: (request) => pi.events.emit(SUBAGENT_ABORT_EVENT, request),
        });
        respond(state, requestId, true, { accepted: true });
        return;
      }
      case "replace_queue":
        respond(state, requestId, true);
        return;
      case "get_session_options": {
        const models = (
          state.ctx.scopedModels.length > 0
            ? state.ctx.scopedModels.map((item) => item.model)
            : state.ctx.modelRegistry.getAvailable()
        ).map((model) => ({
          provider: model.provider,
          id: model.id,
          name: model.name,
          reasoning: model.reasoning,
          thinkingLevels: modelThinkingLevels(model),
        }));
        const commands = bridgeCommandList(pi);
        respond(state, requestId, true, {
          models,
          thinkingLevels: modelThinkingLevels(state.ctx.model ?? {}),
          commands,
        });
        return;
      }
      case "get_commands": {
        const commands = bridgeCommandList(pi);
        respond(state, requestId, true, { commands });
        return;
      }
      case "set_model": {
        // Validate now so an invalid browser choice still gets an immediate
        // response, but never mutate Pi's runtime model during an active turn.
        resolveBridgeModel(state, command.provider, command.modelId);
        if (!state.ctx.isIdle() || state.applyingModelSelection) {
          state.pendingModelSelection = {
            provider: command.provider,
            modelId: command.modelId,
          };
          respond(state, requestId, true, { deferred: true });
          return;
        }
        await applyBridgeModelSelection(pi, state, command);
        respond(state, requestId, true);
        return;
      }
      case "set_thinking_level":
        pi.setThinkingLevel(
          command.level as Parameters<typeof pi.setThinkingLevel>[0],
        );
        updateSession(state, { thinkingLevel: pi.getThinkingLevel() });
        respond(state, requestId, true);
        return;
      case "shutdown":
        respond(state, requestId, true);
        state.ctx.shutdown();
        return;
      case "reload":
        if (!state.ctx.isIdle())
          throw new Error("Wait for Pi to become idle before reloading");
        pi.sendUserMessage(`/web-reload ${requestId}`);
        return;
      case "create_worktree":
      case "create_worktree_v2": {
        if (!state.ctx.isIdle())
          throw new Error(
            "Wait for Pi to become idle before creating a worktree",
          );
        const token = crypto.randomUUID();
        const result = await new Promise<WorktreeResult>(
          (resolveWorktree, rejectWorktree) => {
            const finish = (error?: Error, value?: WorktreeResult) => {
              const pending = pendingForks.get(token);
              if (!pending) return;
              pendingForks.delete(token);
              clearTimeout(pending.timer);
              if (error) rejectWorktree(error);
              else resolveWorktree(value ?? { cancelled: true });
            };
            const timer = setTimeout(
              () => finish(new Error("Pi worktree switch timed out")),
              WORKTREE_TIMEOUT_MS,
            );
            timer.unref?.();
            pendingForks.set(token, {
              owner: state,
              expectingReplacement: false,
              timer,
              resolve: (value) => finish(undefined, value),
              reject: (error) => finish(error),
            });
            try {
              const worktreeCommand =
                "existing" in command
                  ? `--existing ${JSON.stringify(command.existing)}`
                  : formatWorktreeCreateCommandArgs(command);
              pi.sendUserMessage(`/web-worktree ${token} ${worktreeCommand}`);
            } catch (error) {
              finish(error instanceof Error ? error : new Error(String(error)));
            }
          },
        );
        respond(state, requestId, true, result);
        return;
      }
      case "set_session_name":
        pi.setSessionName(command.name);
        updateSession(state, { name: command.name || undefined });
        respond(state, requestId, true);
        return;
      case "compact": {
        const result = await compactWithWebRouting(
          pi,
          state.ctx,
          command.customInstructions,
          state,
        );
        respond(state, requestId, true, result);
        return;
      }
      case "bash": {
        const shell = process.env.SHELL || "/bin/sh";
        const result = await pi.exec(shell, ["-lc", command.command], {
          cwd: state.ctx.cwd,
        });
        const output = `${result.stdout}${result.stderr}`;
        pi.sendMessage(
          {
            customType: "web-bash",
            content: `Ran \`${command.command}\`\n\n\`\`\`\n${output}\n\`\`\``,
            display: true,
          },
          { triggerTurn: false },
        );
        send(state, {
          type: "agent.event",
          sessionId: state.session.id,
          event: {
            type: "bash_execution_update",
            id: requestId,
            delta: output,
          },
        } satisfies AgentEventMessage);
        respond(state, requestId, true, {
          output,
          exitCode: result.code,
          cancelled: false,
          truncated: false,
        });
        return;
      }
      case "get_fork_messages": {
        const messages = state.ctx.sessionManager
          .getEntries()
          .flatMap((entry) => {
            if (entry.type !== "message" || entry.message.role !== "user")
              return [];
            const content = entry.message.content;
            const text =
              typeof content === "string"
                ? content
                : content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("");
            return text ? [{ entryId: entry.id, id: entry.id, text }] : [];
          });
        respond(state, requestId, true, { messages });
        return;
      }
      case "clone": {
        if (!state.ctx.isIdle())
          throw new Error("Wait for Pi to become idle before cloning");
        respond(
          state,
          requestId,
          true,
          await requestFork(pi, state, "/web-clone"),
        );
        return;
      }
      case "fork": {
        if (!state.ctx.isIdle())
          throw new Error("Wait for Pi to become idle before forking");
        respond(
          state,
          requestId,
          true,
          await requestFork(pi, state, `/web-fork ${command.entryId}`),
        );
        return;
      }
    }
    throw new Error("Unknown Pi web command");
  } catch (error) {
    respond(
      state,
      requestId,
      false,
      undefined,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function drainPendingReloads(state: BridgeState): void {
  for (const requestId of pendingReloads) {
    pendingReloads.delete(requestId);
    respond(state, requestId, true, { reloaded: true });
  }
}

function scheduleReconnect(pi: ExtensionAPI, state: BridgeState): void {
  if (state.closed || state.reconnectTimer) return;
  const delayMs = Math.min(
    500 * 2 ** state.reconnectAttempt,
    MAX_RECONNECT_DELAY_MS,
  );
  state.reconnectAttempt += 1;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = undefined;
    void connect(pi, state).catch(() => scheduleReconnect(pi, state));
  }, delayMs);
}

async function connect(pi: ExtensionAPI, state: BridgeState): Promise<void> {
  if (state.closed) return;
  const server = await ensureServer();
  if (state.closed) return;
  state.server = server;
  publishFooter(pi, state);

  const url = new URL("/ws/agent", serverBase(server));
  url.protocol = "ws:";
  const socket = new WebSocket(url);
  state.socket = socket;

  socket.onmessage = (event) => {
    try {
      const message: unknown = JSON.parse(String(event.data));
      if (
        !isRecord(message) ||
        message.type !== "agent.command" ||
        typeof message.requestId !== "string" ||
        !isRecord(message.command)
      )
        return;
      void executeAgentCommand(
        pi,
        state,
        message.requestId,
        message.command as unknown as AgentCommand | RpcSessionCommand,
      );
    } catch {
      // Ignore malformed server frames. The server remains localhost-only
      // except for its explicitly configured tailnet Service.
    }
  };

  await new Promise<void>((resolveOpen, rejectOpen) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        if (state.socket === socket) state.socket = undefined;
        socket.close();
        rejectOpen(error);
      } else {
        resolveOpen();
      }
    };
    const timeout = setTimeout(
      () => finish(new Error("Timed out connecting to Pi web server")),
      3_000,
    );
    socket.onopen = () => {
      if (state.closed || state.socket !== socket) {
        finish(new Error("Pi web connection was superseded"));
        return;
      }
      state.reconnectAttempt = 0;
      discardPendingCoveredByHello(state);
      const hello: AgentHelloMessage = {
        type: "agent.hello",
        session: state.session,
        historyMode: "replace",
        // Send only active, compaction-aware history and bound its encoded size.
        // The append-only JSONL can be hundreds of MB after old context is gone.
        entries: boundedWebHistory(
          state.ctx.sessionManager.buildContextEntries(),
        ),
        // Forward the session's --models scope so the daemon's model picker
        // shows the same list the TUI would.
        scopedModels: state.ctx.scopedModels.map((item) => ({
          provider: item.model.provider,
          id: item.model.id,
          thinkingLevel: item.thinkingLevel,
        })),
      };
      socket.send(JSON.stringify(hello));
      if (state.sourceReplacement) {
        socket.send(
          JSON.stringify({
            type: "agent.session_replaced",
            ...state.sourceReplacement,
          } satisfies AgentSessionReplacedMessage),
        );
      }
      flush(state);
      finish();
    };
    socket.onerror = () =>
      finish(new Error("Could not connect to Pi web server"));
  });

  drainPendingReloads(state);
  socket.onclose = () => {
    if (state.socket === socket) state.socket = undefined;
    scheduleReconnect(pi, state);
  };
}

function previewFromMessage(message: unknown): string | undefined {
  if (
    !isRecord(message) ||
    (message.role !== "user" && message.role !== "assistant")
  )
    return undefined;
  if (typeof message.content === "string") return message.content.slice(0, 180);
  if (!Array.isArray(message.content)) return undefined;
  const preview = message.content
    .filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) && item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text as string)
    .join("");
  return preview ? preview.slice(0, 180) : undefined;
}

function makeSession(
  ctx: ExtensionContext,
  branch: string | undefined,
): WebSession {
  const entries = ctx.sessionManager.getEntries();
  const header = ctx.sessionManager.getHeader();
  let preview: string | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type !== "message" ||
      (entry.message.role !== "user" && entry.message.role !== "assistant")
    )
      continue;
    preview = previewFromMessage(entry.message);
    if (preview) break;
  }
  return {
    id: ctx.sessionManager.getSessionId(),
    file: ctx.sessionManager.getSessionFile(),
    cwd: ctx.cwd,
    name: ctx.sessionManager.getSessionName(),
    branch,
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    thinkingLevel: ctx.thinkingLevel,
    selectedModel:
      selectedAutoModelFromEntries(entries) ??
      (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
    lastModel: lastAutoRoutedModelFromEntries(entries),
    status: statusForContext(ctx),
    source: "tui",
    createdAt: header ? Date.parse(header.timestamp) || Date.now() : Date.now(),
    updatedAt: Date.now(),
    messageCount: entries.filter((entry) => entry.type === "message").length,
    preview,
    parentSession: header?.parentSession,
    managedWorktree: managedWorktreeFromEntries(entries),
    ...sessionMetrics(ctx),
  };
}

export default function webSessions(pi: ExtensionAPI): void {
  let bridge: BridgeState | undefined;

  pi.events.on(AUTO_ROUTER_MODEL_ROUTING_EVENT, (value) => {
    if (!isRecord(value)) return;
    const action = value.action;
    const ctx = value.ctx as ExtensionContext | undefined;
    if (
      (action !== "start" && action !== "end" && action !== "discard") ||
      !ctx ||
      !bridge ||
      bridge.closed ||
      ctx.sessionManager.getSessionId() !== bridge.session.id
    )
      return;
    bridge.autoRuntimeRouting = action === "start";
    if (action === "discard") {
      const selectedModel = selectedModelReference(bridge.session);
      if (isAutoModelReference(selectedModel)) {
        updateSession(bridge, {
          model: selectedModel,
          lastModel:
            typeof value.restoreRoute === "string"
              ? value.restoreRoute
              : null,
        });
      }
    }
  });

  // RPC mode normally expands /skill:name before the agent sees it. Pi Web keeps
  // skill invocations as user-authored text so the agent follows the advertised
  // progressive-disclosure contract and loads SKILL.md with read when needed.
  pi.on("input", (event) => {
    if (
      process.env.PI_WEB_MANAGED !== "1" ||
      event.source !== "rpc" ||
      !isSkillSlashCommand(pi.getCommands(), event.text)
    ) {
      return { action: "continue" };
    }
    pi.sendUserMessage(
      event.images?.length
        ? [{ type: "text" as const, text: event.text }, ...event.images]
        : event.text,
      event.streamingBehavior
        ? { deliverAs: event.streamingBehavior }
        : undefined,
    );
    return { action: "handled" };
  });

  pi.events.on(SUBAGENT_STATUS_EVENT, (value) => {
    const event = value as SubagentStatusEvent;
    if (!bridge || event.sessionId !== bridge.session.id) return;
    // Retain the authoritative merged snapshot for hello. The incremental frame
    // remains the normal low-bandwidth path while connected.
    bridge.session = applySubagentStatusToSession(bridge.session, event);
    send(bridge, {
      type: "agent.subagents",
      sessionId: event.sessionId,
      agents: event.remove ? [] : event.agents,
      usage: event.usage,
    } satisfies AgentSubagentsMessage);
  });

  const forward = (
    event: unknown,
    ctx: ExtensionContext,
    status?: WebSession["status"],
    refreshMetrics = false,
  ): void => {
    if (
      !bridge ||
      bridge.closed ||
      ctx.sessionManager.getSessionId() !== bridge.session.id
    )
      return;
    if (refreshMetrics) {
      const message =
        isRecord(event) && event.type === "message_end"
          ? event.message
          : undefined;
      refreshIncrementalMetrics(
        bridge,
        isRecord(message) ? message.usage : undefined,
      );
    }
    send(bridge, {
      type: "agent.event",
      sessionId: bridge.session.id,
      event: safeClone(event),
    } satisfies AgentEventMessage);
    const latestPreview =
      isRecord(event) && event.type === "message_end"
        ? previewFromMessage(event.message)
        : undefined;
    updateSession(bridge, {
      status,
      preview: latestPreview ?? bridge.session.preview,
      messageCount: refreshMetrics
        ? bridge.session.messageCount + 1
        : bridge.session.messageCount,
    });
  };

  const activeBridgeFor = (
    ctx: ExtensionContext,
  ): BridgeState | undefined => {
    const state = bridge;
    return state &&
      !state.closed &&
      ctx.sessionManager.getSessionId() === state.session.id
      ? state
      : undefined;
  };

  // Managed RPC sessions use this private command so compaction can route
  // through Auto before the core RPC compact path resolves model auth.
  pi.registerCommand(WEB_COMPACT_EXTENSION_COMMAND, {
    description: WEB_COMPACT_COMMAND.description,
    handler: async (args, ctx) => {
      await compactWithWebRouting(
        pi,
        ctx,
        compactInstructionsFromCommandArgs(args),
        bridge,
      );
    },
  });

  pi.registerCommand("web", {
    description: "Show the current session in the Pi web app",
    handler: async (_args, ctx) => {
      try {
        const server = bridge?.server ?? (await ensureServer());
        ctx.ui.notify(
          sessionUrl(server, ctx.sessionManager.getSessionId()),
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });

  pi.registerCommand("web-background", {
    description: "Keep Pi web and its tailnet route running without this TUI",
    handler: async (_args, ctx) => {
      try {
        const server = await keepWebServerBackgrounded();
        if (bridge) {
          bridge.server = server;
          publishFooter(pi, bridge);
        }
        ctx.ui.notify(
          `Pi web is running in the background at ${publishedServerBase(server)}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `Could not background Pi web: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("web-reload", {
    description: `Internal web reload ${WEB_RELOAD_GENERATION}`,
    handler: async (args, ctx) => {
      const token = args.trim();
      if (token) pendingReloads.add(token);
      try {
        await ctx.waitForIdle();
        await ctx.reload();
        return;
      } catch (error) {
        if (token) pendingReloads.delete(token);
        const state = bridge;
        if (token && state)
          respond(
            state,
            token,
            false,
            undefined,
            error instanceof Error ? error.message : String(error),
          );
        else throw error;
      }
    },
  });

  pi.registerCommand("web-tailscale", {
    description: "Enable, disable, or inspect tailnet publishing for Pi web",
    handler: async (args, ctx) => {
      const [rawAction = "", rawServiceName] = args.trim().split(/\s+/, 2);
      const action = rawAction.toLowerCase();
      if (!action || action === "status") {
        const setting = await readWebTailscaleSetting();
        const current = await readServerState();
        if (current?.tailscale?.published && current.tailscale.url) {
          ctx.ui.notify(
            `Pi web is published at ${current.tailscale.url}`,
            "info",
          );
        } else if (current?.tailscale?.error) {
          ctx.ui.notify(current.tailscale.error, "warning");
        } else {
          ctx.ui.notify(
            `Tailnet publishing is ${setting.enabled ? "enabled; restart the Pi web server to retry" : "disabled"}.`,
            "info",
          );
        }
        return;
      }
      if (action !== "on" && action !== "off") {
        ctx.ui.notify(
          "Usage: /web-tailscale [on [service-name]|off|status]",
          "warning",
        );
        return;
      }
      const { server, status } = await withWebTailscaleLock(async () => {
        const setting = await readWebTailscaleSetting();
        const serviceName =
          rawServiceName?.trim().replace(/^svc:/, "") || setting.serviceName;
        const nextSetting = {
          ...setting,
          enabled: action === "on",
          ...(serviceName ? { serviceName } : {}),
        };
        const server = bridge?.server ?? (await ensureServer());
        let appliedSetting = setting;
        const status = await applyTailscaleSettingTransaction({
          current: setting,
          next: nextSetting,
          apply: async (target) => {
            const applied = await updateTailscaleServer(
              server,
              target,
              appliedSetting,
            );
            if ((target.enabled && !applied.published) || applied.error) {
              throw new Error(
                applied.error ?? "Tailscale Serve did not publish Pi web",
              );
            }
            appliedSetting = target;
            return applied;
          },
          persist: writeWebTailscaleSetting,
        });
        return { server, status };
      });
      server.tailscale = status;
      if (bridge) {
        bridge.server = server;
        publishFooter(pi, bridge);
      }
      if (status.published && status.url) {
        ctx.ui.notify(`Pi web is now published at ${status.url}`, "info");
      } else if (status.error) {
        ctx.ui.notify(status.error, "warning");
      } else {
        ctx.ui.notify("Tailnet publishing disabled.", "info");
      }
    },
  });

  pi.registerCommand("web-clone", {
    description: "Clone the current branch for the web session manager",
    handler: async (args, ctx) => {
      const token = args.trim();
      const pending = pendingForks.get(token);
      try {
        await ctx.waitForIdle();
        const leaf = ctx.sessionManager.getLeafId();
        if (!leaf) throw new Error("Current session has no entries to clone");
        let sessionId: string | undefined;
        if (pending) pending.expectingReplacement = true;
        const result = await ctx.fork(leaf, {
          position: "at",
          withSession: async (replacement) => {
            sessionId = replacement.sessionManager.getSessionId();
          },
        });
        pending?.resolve({ cancelled: result.cancelled, sessionId });
      } catch (error) {
        pending?.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
        if (!pending) throw error;
      } finally {
        if (pending) pendingForks.delete(token);
      }
    },
  });

  pi.registerCommand("web-worktree", {
    description: "Create and activate a worktree for the web session manager",
    handler: async (args, ctx) => {
      const { token, worktreeArgs } = splitWebWorktreeCommandArgs(args);
      const pending = pendingForks.get(token);
      try {
        if (pending) pending.expectingReplacement = true;
        const result = await runWorktreeCommand(worktreeArgs, ctx);
        if (result.replacedSession && bridge)
          sendSourceReplacement(bridge, result.replacedSession);
        pending?.resolve({
          ...result,
          sessionId: result.cancelled ? undefined : pending.owner.session.id,
          path: result.path ?? pending.owner.session.cwd,
          branch: result.branch ?? pending.owner.session.branch,
        } as WorktreeResult);
      } catch (error) {
        pending?.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
        if (!pending) throw error;
      }
    },
  });

  pi.registerCommand("web-fork", {
    description: "Fork from an entry for the web session manager",
    handler: async (args, ctx) => {
      const [entryId = "", token = ""] = args.trim().split(/\s+/, 2);
      const pending = pendingForks.get(token);
      try {
        if (!entryId || !ctx.sessionManager.getEntry(entryId))
          throw new Error("Unknown session entry");
        await ctx.waitForIdle();
        let sessionId: string | undefined;
        if (pending) pending.expectingReplacement = true;
        const result = await ctx.fork(entryId, {
          withSession: async (replacement) => {
            sessionId = replacement.sessionManager.getSessionId();
          },
        });
        pending?.resolve({ cancelled: result.cancelled, sessionId });
      } catch (error) {
        pending?.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
        if (!pending)
          ctx.ui.notify(
            error instanceof Error ? error.message : String(error),
            "error",
          );
      } finally {
        if (pending) pendingForks.delete(token);
      }
    },
  });

  pi.on("session_start", async (event, ctx) => {
    if (process.env.PI_WEB_MANAGED === "1") return;
    const previous = bridge;
    const session = makeSession(ctx, undefined);
    const worktreeReplacement = consumeWorktreeReplacement(session.id);
    // The in-memory replacement token exists before activation verification.
    // Advertise deletion only from the durable marker written after verification.
    const persistedReplacement = replacementFromEntries(
      ctx.sessionManager.getEntries(),
    );
    const sourceReplacement =
      persistedReplacement?.replacementSessionId === session.id
        ? persistedReplacement
        : undefined;
    const state: BridgeState = {
      ctx,
      session,
      closed: false,
      reconnectAttempt: 0,
      pending: [],
      autoTurnRouting: false,
      autoRuntimeRouting: false,
      metrics: { usage: session.usage, contextUsage: session.contextUsage },
      sourceReplacement,
    };
    if (previous) {
      previous.closed = true;
      previous.replacement = state;
      replacePendingForkOwners(previous, state);
      rejectPendingForks(
        previous,
        "Pi session changed before the fork completed",
        true,
      );
      previous.socket?.close();
      if (previous.reconnectTimer) clearTimeout(previous.reconnectTimer);
      removeFooter(pi, previous.session.id);
    }
    bridge = state;
    if (worktreeReplacement && !sourceReplacement) {
      const deadline = Date.now() + WORKTREE_TIMEOUT_MS;
      const poll = setInterval(() => {
        if (state.closed || Date.now() >= deadline) {
          clearInterval(poll);
          return;
        }
        if (!worktreeReplacement.activated) return;
        clearInterval(poll);
        sendSourceReplacement(state, worktreeReplacement.activated);
      }, 10);
      poll.unref?.();
    }
    for (const pending of pendingForks.values()) {
      if (!pending.expectingReplacement) continue;
      if (
        pending.owner === previous ||
        pending.owner.session.file === event.previousSessionFile ||
        pending.owner.session.id === worktreeReplacement?.previousSessionId
      )
        pending.owner = state;
    }
    void refreshGitMetadata(pi, state);
    try {
      await connect(pi, state);
    } catch (error) {
      ctx.ui.notify(
        `Pi web unavailable: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
      scheduleReconnect(pi, state);
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    const activeBridge = activeBridgeFor(ctx);
    if (activeBridge)
      activeBridge.autoTurnRouting = isAutoModelReference(
        selectedModelReference(activeBridge.session),
      );
  });
  pi.on("session_info_changed", (event, ctx) => {
    const activeBridge = activeBridgeFor(ctx);
    if (activeBridge) updateSession(activeBridge, { name: event.name });
    forward(event, ctx);
  });
  pi.on("model_select", (event, ctx) => {
    const activeBridge = activeBridgeFor(ctx);
    if (activeBridge) {
      const runtimeModel = webModelReference(event.model);
      const previousModel = event.previousModel
        ? webModelReference(event.previousModel)
        : undefined;
      const selectedModel = selectedModelReference(activeBridge.session);
      const autoRoute = activeBridge.autoRuntimeRouting
        ? isAutoModelReference(selectedModel) &&
          !isAutoModelReference(runtimeModel)
        : activeBridge.autoTurnRouting &&
          isAutoRuntimeModelSwap(selectedModel, previousModel, runtimeModel);
      const next = applyRuntimeModelStatus(
        activeBridge.session,
        runtimeModel,
        ctx.thinkingLevel,
        autoRoute,
      );
      if (!autoRoute) activeBridge.autoTurnRouting = false;
      updateSession(activeBridge, {
        ...next,
        lastModel: next.lastModel,
      });
    }
    forward(event, ctx);
  });
  pi.on("thinking_level_select", (event, ctx) => {
    const activeBridge = activeBridgeFor(ctx);
    if (activeBridge) updateSession(activeBridge, { thinkingLevel: event.level });
    forward(event, ctx);
  });
  pi.on("agent_start", (event, ctx) => forward(event, ctx, "working"));
  // The visible run is complete at agent_end. Surface provider/runtime failures
  // instead of making an unfinished transcript look successfully idle.
  pi.on("agent_end", (event, ctx) => {
    const status =
      agentEndTerminalNotice(event)?.kind === "error" ? "error" : "idle";
    forward(event, ctx, status);
  });
  pi.on("agent_settled", async (event, ctx) => {
    const activeBridge = activeBridgeFor(ctx);
    if (activeBridge) {
      activeBridge.autoTurnRouting = false;
      activeBridge.autoRuntimeRouting = false;
      const selectedModel = selectedModelReference(activeBridge.session);
      if (
        isAutoModelReference(selectedModel) &&
        activeBridge.session.model !== selectedModel
      )
        updateSession(activeBridge, { model: selectedModel });
    }
    if (activeBridge?.session.compaction) {
      endBridgeCompaction(activeBridge, {
        aborted: false,
        willRetry: false,
        errorMessage: "Compaction stopped before completion",
      });
    }
    if (activeBridge) await applyPendingBridgeModelSelection(pi, activeBridge);
    forward(
      event,
      ctx,
      activeBridge?.session.status === "error" ? "error" : "idle",
    );
  });
  pi.on("turn_start", (event, ctx) => forward(event, ctx, "working"));
  pi.on("turn_end", (event, ctx) => forward(event, ctx));
  pi.on("message_start", (event, ctx) => forward(event, ctx));
  pi.on("message_update", (event, ctx) => forward(event, ctx));
  pi.on("message_end", (event, ctx) => forward(event, ctx, undefined, true));
  pi.on("tool_execution_start", (event, ctx) => forward(event, ctx));
  pi.on("tool_execution_update", (event, ctx) => forward(event, ctx));
  pi.on("tool_execution_end", (event, ctx) => forward(event, ctx));
  pi.on("session_before_compact", (event, ctx) => {
    if (
      !bridge ||
      bridge.closed ||
      ctx.sessionManager.getSessionId() !== bridge.session.id
    )
      return;
    startBridgeCompaction(bridge, event.reason, event.willRetry);
    const startedAt = bridge.session.compaction?.startedAt;
    event.signal.addEventListener(
      "abort",
      () => {
        if (!bridge || bridge.session.compaction?.startedAt !== startedAt)
          return;
        endBridgeCompaction(bridge, {
          aborted: true,
          willRetry: event.willRetry,
        });
      },
      { once: true },
    );
  });
  pi.on("session_compact", (event, ctx) => {
    if (bridge && ctx.sessionManager.getSessionId() === bridge.session.id) {
      refreshIncrementalMetrics(bridge, event.compactionEntry.usage);
      updateSession(bridge);
      send(bridge, {
        type: "agent.history",
        sessionId: bridge.session.id,
        entries: boundedWebHistory(ctx.sessionManager.buildContextEntries()),
      } satisfies AgentHistoryMessage);
      endBridgeCompaction(bridge, {
        aborted: false,
        willRetry: event.willRetry,
        tokensBefore: event.compactionEntry.tokensBefore,
      });
    }
    forward(event, ctx);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const state = bridge;
    if (!state || state.session.id !== ctx.sessionManager.getSessionId())
      return;
    if (event.reason === "quit" && ctx.mode === "tui") {
      try {
        state.server = await keepWebServerBackgrounded();
      } catch (error) {
        console.warn(
          `Could not keep Pi web running after the TUI exits: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    state.closed = true;
    // Expected replacement requests survive extension-runtime reload and are
    // rebound by the next session_start through the module-global pending map.
    rejectPendingForks(
      state,
      "Pi session closed before the fork completed",
      true,
    );
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    state.socket?.close();
    removeFooter(pi, state.session.id);
    bridge = undefined;
  });
}
