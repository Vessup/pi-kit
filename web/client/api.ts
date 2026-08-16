import type {
  AgentCommand,
  ClientToServerMessage,
  CreateSessionRequest,
  ResumeSessionRequest,
  RpcSessionCommand,
  ServerToClientMessage,
  WebSession,
} from "../protocol";
import { SessionSocket } from "./ws";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;
const SOCKET_PATHS = ["/ws/client"] as const;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const ABORT_COMMAND_TIMEOUT_MS = 35_000;
const FORK_COMMAND_TIMEOUT_MS = 35_000;
const WORKTREE_COMMAND_TIMEOUT_MS = 11 * 60_000;
const LONG_RUNNING_COMMAND_TIMEOUT_MS = 11 * 60_000;
function healthCapability(health: unknown, key: string): boolean {
  const capabilities =
    health && typeof health === "object" && "capabilities" in health
      ? (health as { capabilities?: unknown }).capabilities
      : undefined;
  return Boolean(
    capabilities &&
      typeof capabilities === "object" &&
      (capabilities as Record<string, unknown>)[key] === true,
  );
}

export function commandHelloType(
  health: unknown,
): "client.hello" | "client.command_hello" {
  return healthCapability(health, "commandHello")
    ? "client.command_hello"
    : "client.hello";
}

export function healthSupportsWorktreeRefs(health: unknown): boolean {
  return healthCapability(health, "worktreeRefs");
}

async function supportsHealthCapability(key: string): Promise<boolean> {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    return response.ok && healthCapability(await response.json(), key);
  } catch {
    return false;
  }
}

async function supportsWorktreeRefs(): Promise<boolean> {
  return supportsHealthCapability("worktreeRefs");
}

async function supportsCommandHello(): Promise<boolean> {
  return supportsHealthCapability("commandHello");
}

export function sessionCommandTimeout(
  command: AgentCommand | RpcSessionCommand,
): number {
  if (
    command.type === "create_worktree" ||
    command.type === "create_worktree_v2" ||
    command.type === "reload"
  )
    return WORKTREE_COMMAND_TIMEOUT_MS;
  if (command.type === "abort") return ABORT_COMMAND_TIMEOUT_MS;
  if (command.type === "clone" || command.type === "fork")
    return FORK_COMMAND_TIMEOUT_MS;
  return command.type === "compact" || command.type === "bash"
    ? LONG_RUNNING_COMMAND_TIMEOUT_MS
    : DEFAULT_COMMAND_TIMEOUT_MS;
}

export type ForkMessageItem = {
  entryId: string;
  text: string;
  timestamp?: string;
};

export type SessionListResponse = WebSession[] | { sessions: WebSession[] };
export type ForkMessagesResponse =
  | { messages: ForkMessageItem[] }
  | { entries: ForkMessageItem[] }
  | ForkMessageItem[];
export type SessionActionResponse = {
  session?: WebSession;
  sessions?: WebSession[];
  ok?: boolean;
  data?: unknown;
};

async function fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    let message = text || response.statusText;
    try {
      const payload = JSON.parse(text) as { error?: unknown };
      if (typeof payload.error === "string") message = payload.error;
    } catch {
      // Keep the plain-text response when the body is not JSON.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

async function tryJson<T>(
  paths: readonly string[],
  init: RequestInit = {},
): Promise<T> {
  let lastError: unknown = new Error("No API endpoint matched");
  for (const path of paths) {
    try {
      return await fetchJson<T>(path, init);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function listSessions(): Promise<WebSession[]> {
  const data = await tryJson<SessionListResponse>(["/api/sessions"]);
  return Array.isArray(data) ? data : data.sessions;
}

export async function createSession(
  request: CreateSessionRequest,
): Promise<WebSession> {
  if (
    (request.worktreeBranch || request.worktreeStartPoint) &&
    !(await supportsWorktreeRefs())
  ) {
    throw new Error(
      "The running Pi Web daemon must be updated before creating a worktree with branch or start-point options",
    );
  }
  const data = await tryJson<SessionActionResponse>(["/api/sessions"], {
    method: "POST",
    body: JSON.stringify(request),
  });
  const session = data.session ?? data.sessions?.[0];
  if (!session) throw new Error("Create session failed");
  return session;
}

export async function resumeSession(
  request: ResumeSessionRequest,
): Promise<WebSession> {
  const data = await tryJson<SessionActionResponse>(["/api/sessions/resume"], {
    method: "POST",
    body: JSON.stringify(request),
  });
  const session = data.session ?? data.sessions?.[0];
  if (!session) throw new Error("Resume session failed");
  return session;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await tryJson<SessionActionResponse>(
    [`/api/sessions/${encodeURIComponent(sessionId)}`],
    { method: "DELETE" },
  );
}

export function getSocketCandidates(): readonly string[] {
  return SOCKET_PATHS;
}

export function buildSocketUrl(path: string): string {
  return new URL(path, window.location.origin)
    .toString()
    .replace(/^http/, "ws");
}

export function parseSocketMessage(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

export function isServerMessage(
  message: unknown,
): message is ServerToClientMessage {
  return !!message && typeof message === "object" && "type" in message;
}

export async function sendSessionCommand(
  sessionId: string,
  command: AgentCommand | RpcSessionCommand,
): Promise<unknown> {
  // New daemons avoid a full session-catalog snapshot on one-shot command sockets.
  // Fall back to client.hello when an older daemon is still serving a freshly built
  // client bundle; this protocol skew previously broke Stop and every queue action.
  const socket = new SessionSocket(
    (await supportsCommandHello()) ? "client.command_hello" : "client.hello",
  );
  let earlyClose: CloseEvent | undefined;
  const unsubscribeEarlyClose = socket.onClose((event) => {
    earlyClose = event;
  });
  try {
    await socket.connect();
  } catch (error) {
    unsubscribeEarlyClose();
    throw error;
  }
  return new Promise<unknown>((resolve, reject) => {
    const requestId = crypto.randomUUID();
    let settled = false;
    let timeout: number | undefined;
    let unsubscribeMessage = () => {};
    let unsubscribeClose = () => {};
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
      unsubscribeMessage();
      unsubscribeClose();
      socket.close();
      callback();
    };
    const rejectClosed = (event: CloseEvent) => {
      finish(() =>
        reject(
          new Error(
            `Command socket closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`,
          ),
        ),
      );
    };
    unsubscribeMessage = socket.onMessage((message) => {
      if (
        !message ||
        typeof message !== "object" ||
        !("requestId" in message) ||
        message.requestId !== requestId
      )
        return;
      const response = message as unknown as {
        success?: boolean;
        error?: string;
        data?: unknown;
      };
      finish(() => {
        if (response.success === false)
          reject(new Error(response.error ?? "Request failed"));
        else resolve(response.data);
      });
    });
    unsubscribeClose = socket.onClose(rejectClosed);
    unsubscribeEarlyClose();
    if (earlyClose) {
      rejectClosed(earlyClose);
      return;
    }
    timeout = window.setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              `Command timed out after ${sessionCommandTimeout(command)}ms`,
            ),
          ),
        ),
      sessionCommandTimeout(command),
    );
    try {
      socket.send({
        type: "client.command",
        requestId,
        sessionId,
        command,
      } satisfies ClientToServerMessage as Record<string, unknown>);
    } catch (error) {
      finish(() =>
        reject(error instanceof Error ? error : new Error(String(error))),
      );
    }
  });
}

export async function getForkMessages(
  sessionId: string,
): Promise<ForkMessageItem[]> {
  const data = await sendSessionCommand(sessionId, {
    type: "get_fork_messages",
  });
  const typed = data as ForkMessagesResponse | undefined;
  const messages = Array.isArray(typed)
    ? typed
    : typed && "messages" in typed
      ? typed.messages
      : typed && "entries" in typed
        ? typed.entries
        : [];
  return messages.flatMap((message) => {
    const candidate = message as unknown as {
      entryId?: unknown;
      id?: unknown;
      text?: unknown;
      timestamp?: unknown;
    };
    const entryId =
      typeof candidate.entryId === "string"
        ? candidate.entryId
        : typeof candidate.id === "string"
          ? candidate.id
          : undefined;
    return entryId && typeof candidate.text === "string"
      ? [
          {
            entryId,
            text: candidate.text,
            timestamp:
              typeof candidate.timestamp === "string"
                ? candidate.timestamp
                : undefined,
          },
        ]
      : [];
  });
}

export async function renameSessionViaCommand(
  sessionId: string,
  name: string,
): Promise<void> {
  await sendSessionCommand(sessionId, { type: "set_session_name", name });
}

export async function compactSessionViaCommand(
  sessionId: string,
  customInstructions?: string,
): Promise<void> {
  await sendSessionCommand(sessionId, { type: "compact", customInstructions });
}

export async function cloneSessionViaCommand(
  sessionId: string,
): Promise<unknown> {
  return sendSessionCommand(sessionId, { type: "clone" });
}

export async function forkSessionViaCommand(
  sessionId: string,
  entryId: string,
): Promise<unknown> {
  return sendSessionCommand(sessionId, { type: "fork", entryId });
}

export async function createSessionWorktreeViaCommand(
  sessionId: string,
  repository: string,
  name: string,
  options: { branch?: string; startPoint?: string } = {},
): Promise<unknown> {
  return sendSessionCommand(sessionId, {
    type: "create_worktree",
    repository,
    name,
    ...options,
  });
}

export async function openSessionSocket(
  onMessage: (message: unknown) => void,
): Promise<SessionSocket> {
  const socket = new SessionSocket();
  socket.onMessage(onMessage);
  await socket.connect();
  return socket;
}
