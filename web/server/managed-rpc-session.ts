import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WEB_COMPACT_EXTENSION_COMMAND } from "../compact-command.js";
import type { RpcSessionCommand } from "../protocol.js";
import { SerializedWriter } from "./serialized-writer.js";

const encoder = new TextEncoder();
const configuredRpcTimeout = Number(
  process.env.PI_WEB_RPC_TIMEOUT_MS ?? "30000",
);
const RPC_REQUEST_TIMEOUT_MS =
  Number.isFinite(configuredRpcTimeout) && configuredRpcTimeout > 0
    ? Math.floor(configuredRpcTimeout)
    : 30_000;
const LONG_RUNNING_COMMAND_TIMEOUT_MS = 10 * 60_000;
const SHUTDOWN_DELIVERY_TIMEOUT_MS = Math.min(RPC_REQUEST_TIMEOUT_MS, 1_000);
const SHUTDOWN_TERM_GRACE_MS = 500;
const STDERR_TAIL_MAX_CHARS = 16 * 1024;

type RpcResponse<T = unknown> =
  | { id?: string; type: "response"; command: string; success: true; data?: T }
  | {
      id?: string;
      type: "response";
      command: string;
      success: false;
      error: string;
    };

type RpcEvent = Record<string, unknown> & { type?: string; id?: string };

export type ManagedRpcSessionOptions = {
  cwd: string;
  name?: string;
  sessionFile?: string;
  noSession?: boolean;
  runtimeDirectory?: string;
  onEvent: (event: RpcEvent) => void;
  onExit: (code: number | null, signal: string | null) => void;
  replacementForSessionFile?: (
    file: string,
  ) => { previousSessionId: string; replacementSessionId: string } | undefined;
};

export class CommandRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandRejectedError";
  }
}

export class CommandDeliveryUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandDeliveryUncertainError";
  }
}

export function isUncertainRpcDeliveryCommand(command: string): boolean {
  return command === "prompt" || command === "compact";
}

export function rpcDeliveryError(command: string, message: string): Error {
  return isUncertainRpcDeliveryCommand(command)
    ? new CommandDeliveryUncertainError(message)
    : new Error(message);
}

let cachedRpcCommand: string[] | undefined;

/**
 * Command that starts a managed RPC Pi runtime.
 *
 * The daemon must spawn the exact `@earendil-works/pi-coding-agent` build it
 * itself imports (session-file formats and RPC behavior move together), not
 * whatever `pi` happens to be first on PATH — an upgraded global `pi` can
 * otherwise reject the daemon's session files or load extensions
 * differently, which silently dropped every package extension (including the
 * Auto Router provider) from managed web sessions. `rpc-entry` hardcodes
 * `--mode rpc`, so the mode flag is intentionally absent from the rest of
 * the command. Running it under this daemon's own Bun binary keeps
 * TypeScript extension loading identical to the daemon's. `PI_WEB_RPC_BIN`
 * overrides the executable for tests and wrapper setups.
 */
function rpcSessionCommand(): string[] {
  if (cachedRpcCommand) return cachedRpcCommand;
  const override = process.env.PI_WEB_RPC_BIN?.trim();
  let command: string[];
  if (override) {
    command = [override, "--mode", "rpc"];
  } else {
    try {
      const entry = fileURLToPath(
        import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"),
      );
      command = [process.execPath, entry];
    } catch {
      // Fall back to PATH resolution when the package entry cannot be resolved.
      command = ["pi", "--mode", "rpc"];
    }
  }
  cachedRpcCommand = command;
  return command;
}

export class ManagedRpcSession {
  private readonly options: ManagedRpcSessionOptions;
  private process: Bun.Subprocess | undefined;
  private startPromise: Promise<void> | undefined;
  private started = false;
  private shutdownPromise: Promise<void> | undefined;
  private stdoutBuffer = "";
  private stderrTail = "";
  private stderrPump: Promise<void> | undefined;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      command: string;
    }
  >();
  private stopped = false;
  private readonly requestPrefix = `web-${randomUUID()}`;
  private worktreeError: Error | undefined;
  private reloadError: Error | undefined;
  private compactCompletion:
    | {
        started: boolean;
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private reloadInFlight: Promise<void> | undefined;
  private readonly lineWriter = new SerializedWriter<string>((line) =>
    this.writeLineNow(line),
  );

  constructor(options: ManagedRpcSessionOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.startPromise) return await this.startPromise;
    const operation = this.startOnce();
    this.startPromise = operation;
    try {
      await operation;
      this.started = true;
    } catch (error) {
      this.stopped = true;
      try {
        this.process?.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      throw error;
    } finally {
      if (this.startPromise === operation) this.startPromise = undefined;
    }
  }

  private async startOnce(): Promise<void> {
    if (this.stopped) throw new Error("RPC session stopped");
    if (this.options.runtimeDirectory)
      mkdirSync(this.options.runtimeDirectory, { recursive: true });
    const env = { ...process.env, PI_WEB_MANAGED: "1" };
    const args: string[] = [];
    if (this.options.noSession) args.push("--no-session");
    if (this.options.name) args.push("--name", this.options.name);
    const proc = Bun.spawn({
      cmd: [...rpcSessionCommand(), ...args],
      cwd: this.options.cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.process = proc;
    void this.pumpStdout(proc).catch((error) => {
      this.failRuntimeOperations(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
    this.stderrPump = this.pumpStderr(proc).catch(() => undefined);
    void proc.exited
      .then(async (code: number) => {
        await this.stderrPump;
        const expected = this.stopped;
        this.started = false;
        this.stopped = true;
        if (this.process === proc) this.process = undefined;
        this.options.onExit(code, null);
        const detail = this.stderrTail.trim();
        if (detail && (!expected || code !== 0))
          console.error(`RPC process exited with code ${code}: ${detail}`);
        this.failRuntimeOperations(
          new Error(`RPC process exited with code ${code}`),
        );
      })
      .catch((error: unknown) => {
        this.started = false;
        this.stopped = true;
        if (this.process === proc) this.process = undefined;
        this.options.onExit(
          null,
          error instanceof Error ? error.message : String(error),
        );
        this.failRuntimeOperations(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    await this.sendToStartedProcess({ type: "get_state" });
    if (this.options.sessionFile) {
      await this.sendToStartedProcess({
        type: "switch_session",
        sessionPath: this.options.sessionFile,
      });
    }
  }

  private async pumpStdout(proc: Bun.Subprocess): Promise<void> {
    const stream = (proc as unknown as { stdout?: ReadableStream<Uint8Array> })
      .stdout;
    if (!stream) return;
    const streamDecoder = new TextDecoder();
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        this.stdoutBuffer += streamDecoder.decode(value, { stream: true });
        let newlineIndex = this.stdoutBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          let line = this.stdoutBuffer.slice(0, newlineIndex);
          this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.length > 0) this.handleLine(line);
          newlineIndex = this.stdoutBuffer.indexOf("\n");
        }
      }
      const tail = `${this.stdoutBuffer}${streamDecoder.decode()}`;
      this.stdoutBuffer = "";
      if (tail.trim().length > 0) {
        const line = tail.endsWith("\r") ? tail.slice(0, -1) : tail;
        this.handleLine(line);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async pumpStderr(proc: Bun.Subprocess): Promise<void> {
    const stream = (proc as unknown as { stderr?: ReadableStream<Uint8Array> })
      .stderr;
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        this.appendStderr(decoder.decode(value, { stream: true }));
      }
      this.appendStderr(decoder.decode());
    } finally {
      reader.releaseLock();
    }
  }

  private appendStderr(text: string): void {
    if (!text) return;
    this.stderrTail = `${this.stderrTail}${text}`.slice(-STDERR_TAIL_MAX_CHARS);
  }

  private resolveCompactCompletion(value: unknown): void {
    const pending = this.compactCompletion;
    if (!pending) return;
    this.compactCompletion = undefined;
    clearTimeout(pending.timer);
    pending.resolve(value);
  }

  private rejectCompactCompletion(error: Error): void {
    const pending = this.compactCompletion;
    if (!pending) return;
    this.compactCompletion = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private waitForCompactCompletion(): Promise<unknown> {
    if (this.compactCompletion)
      return Promise.reject(new Error("Compaction is already in progress"));
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.compactCompletion) return;
        this.compactCompletion = undefined;
        reject(
          rpcDeliveryError(
            "compact",
            `Web compaction did not finish within ${LONG_RUNNING_COMMAND_TIMEOUT_MS}ms`,
          ),
        );
      }, LONG_RUNNING_COMMAND_TIMEOUT_MS);
      this.compactCompletion = {
        started: false,
        resolve,
        reject,
        timer,
      };
    });
  }

  private handleLine(line: string): void {
    let parsed: RpcEvent;
    try {
      parsed = JSON.parse(line) as RpcEvent;
    } catch (error) {
      const preview = line.length > 500 ? `${line.slice(0, 500)}…` : line;
      console.warn(
        `Ignoring invalid JSONL from RPC child (${error instanceof Error ? error.message : String(error)}): ${preview}`,
      );
      return;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.type !== "string"
    )
      return;
    if (parsed.type === "extension_error" && typeof parsed.error === "string") {
      if (parsed.extensionPath === "command:worktree")
        this.worktreeError = new Error(parsed.error);
      if (parsed.extensionPath === "command:web-reload")
        this.reloadError = new Error(parsed.error);
      if (parsed.extensionPath === `command:${WEB_COMPACT_EXTENSION_COMMAND}`)
        this.rejectCompactCompletion(new CommandRejectedError(parsed.error));
    }
    if (
      parsed.type === "compaction_start" &&
      parsed.reason === "manual" &&
      this.compactCompletion
    ) {
      this.compactCompletion.started = true;
    }
    if (
      parsed.type === "compaction_end" &&
      parsed.reason === "manual" &&
      this.compactCompletion?.started
    ) {
      if (parsed.aborted === true || typeof parsed.errorMessage === "string")
        this.rejectCompactCompletion(
          new CommandRejectedError(
            typeof parsed.errorMessage === "string"
              ? parsed.errorMessage
              : "Compaction cancelled",
          ),
        );
      else this.resolveCompactCompletion(parsed.result);
    }
    if (parsed.type === "response") {
      const response = parsed as RpcResponse;
      const responseId =
        typeof response.id === "string" ? response.id : undefined;
      if (responseId && this.pending.has(responseId)) {
        const pending = this.pending.get(responseId);
        if (pending) {
          this.pending.delete(responseId);
          if (response.success)
            pending.resolve(
              (response as RpcResponse & { data?: unknown }).data,
            );
          else pending.reject(new CommandRejectedError(response.error));
        }
      }
      return;
    }
    this.options.onEvent(parsed);
  }

  private writeLine(line: string, shouldWrite?: () => boolean): Promise<void> {
    return this.lineWriter.write(line, shouldWrite);
  }

  private async writeLineNow(line: string): Promise<void> {
    if (!this.process) throw new Error("RPC process is not running");
    const stdin = (
      this.process as unknown as {
        stdin?: {
          getWriter?: () => WritableStreamDefaultWriter<Uint8Array>;
          write?: (value: string | Uint8Array) => unknown;
          flush?: () => unknown;
        };
      }
    ).stdin;
    if (!stdin) throw new Error("RPC stdin unavailable");
    const payload = encoder.encode(line);
    if (typeof stdin.getWriter === "function") {
      const writer = stdin.getWriter();
      try {
        await writer.write(payload);
      } finally {
        writer.releaseLock();
      }
      return;
    }
    if (typeof stdin.write === "function") {
      await stdin.write(payload);
      if (typeof stdin.flush === "function") await stdin.flush();
      return;
    }
    throw new Error("Unsupported RPC stdin sink");
  }

  private failAllPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      try {
        pending.reject(rpcDeliveryError(pending.command, error.message));
      } catch {
        // ignore
      }
    }
  }

  private failRuntimeOperations(error: Error): void {
    this.failAllPending(error);
    this.rejectCompactCompletion(rpcDeliveryError("compact", error.message));
  }

  private async waitForPendingRequests(): Promise<void> {
    const deadline = Date.now() + RPC_REQUEST_TIMEOUT_MS;
    while (this.pending.size > 0) {
      if (Date.now() >= deadline) {
        const commands = [...this.pending.values()]
          .map((pending) => pending.command)
          .join(", ");
        throw new Error(
          `Could not reload while RPC commands are still pending: ${commands}`,
        );
      }
      await Bun.sleep(10);
    }
  }

  private async deliver(
    command: Record<string, unknown>,
    bypassReloadBarrier = false,
    timeoutMs: number | null = null,
  ): Promise<void> {
    const deadline = timeoutMs === null ? undefined : Date.now() + timeoutMs;
    const commandName =
      typeof command.type === "string" ? command.type : "unknown";
    const operation = (async () => {
      if (!bypassReloadBarrier && this.reloadInFlight)
        await this.reloadInFlight;
      if (this.stopped) throw new Error("RPC session stopped");
      if (!this.started) await this.start();
      let writeStarted = false;
      await this.writeLine(
        `${JSON.stringify({ id: `${this.requestPrefix}-${randomUUID()}`, ...command })}\n`,
        () => {
          if (deadline !== undefined && Date.now() >= deadline) return false;
          writeStarted = true;
          return true;
        },
      );
      if (!writeStarted)
        throw new Error(
          `RPC command ${commandName} timed out after ${timeoutMs}ms`,
        );
    })();
    if (deadline === undefined) return await operation;
    const remaining = Math.max(0, deadline - Date.now());
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  `RPC command ${commandName} timed out after ${timeoutMs}ms`,
                ),
              ),
            remaining,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async send<T = unknown>(
    command: Record<string, unknown>,
    timeoutMs: number | null = RPC_REQUEST_TIMEOUT_MS,
    bypassReloadBarrier = false,
  ): Promise<T> {
    if (!bypassReloadBarrier && this.reloadInFlight) await this.reloadInFlight;
    if (this.stopped) throw new Error("RPC session stopped");
    if (!this.started) await this.start();
    return await this.sendToStartedProcess<T>(command, timeoutMs);
  }

  private sendToStartedProcess<T = unknown>(
    command: Record<string, unknown>,
    timeoutMs: number | null = RPC_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.process)
      return Promise.reject(new Error("RPC process is not running"));
    const id = `${this.requestPrefix}-${randomUUID()}`;
    const payload = { id, ...command };
    const commandName =
      typeof command.type === "string" ? command.type : "unknown";
    return new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const clearRequestTimeout = () => {
        if (timeout) clearTimeout(timeout);
      };
      this.pending.set(id, {
        resolve: (value) => {
          clearRequestTimeout();
          resolve(value as T);
        },
        reject: (error) => {
          clearRequestTimeout();
          reject(error);
        },
        command: commandName,
      });
      if (timeoutMs !== null) {
        timeout = setTimeout(() => {
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          pending.reject(
            rpcDeliveryError(
              pending.command,
              `RPC command ${pending.command} timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }
      void this.writeLine(`${JSON.stringify(payload)}\n`, () =>
        this.pending.has(id),
      ).catch((error: unknown) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        const cause = error instanceof Error ? error : new Error(String(error));
        pending.reject(rpcDeliveryError(commandName, cause.message));
      });
    });
  }

  async getState(): Promise<unknown> {
    return await this.send({ type: "get_state" });
  }

  async getAvailableModels(): Promise<{
    models: Array<Record<string, unknown>>;
  }> {
    return await this.send({ type: "get_available_models" });
  }

  async getAvailableThinkingLevels(): Promise<{ levels: string[] }> {
    return await this.send({ type: "get_available_thinking_levels" });
  }

  async getCommands(): Promise<{ commands: Array<Record<string, unknown>> }> {
    return await this.send({ type: "get_commands" });
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.send({ type: "set_model", provider, modelId });
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.send({ type: "set_thinking_level", level });
  }

  async getEntries(
    since?: string,
  ): Promise<{ entries: unknown[]; leafId: string | null }> {
    return await this.send({ type: "get_entries", since });
  }

  async getMessages(): Promise<{ messages: unknown[] }> {
    return await this.send({ type: "get_messages" });
  }

  async getSessionStats(): Promise<Record<string, unknown>> {
    return await this.send({ type: "get_session_stats" });
  }

  async getForkMessages(): Promise<{
    messages: Array<{ entryId: string; text: string }>;
  }> {
    return await this.send({ type: "get_fork_messages" });
  }

  async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    return await this.send({ type: "fork", entryId });
  }

  async clone(): Promise<{ cancelled: boolean }> {
    return await this.send({ type: "clone" });
  }

  async compact(customInstructions?: string): Promise<unknown> {
    // The web extension command gives Auto Router a chance to replace its inert
    // placeholder before Pi resolves compaction auth. Older runtimes still use
    // the native RPC command for compatibility.
    const commands = await this.getCommands();
    const supportsWebCompact = commands.commands.some(
      (command) => command.name === WEB_COMPACT_EXTENSION_COMMAND,
    );
    if (!supportsWebCompact)
      return await this.send(
        { type: "compact", customInstructions },
        LONG_RUNNING_COMMAND_TIMEOUT_MS,
      );

    if (this.compactCompletion)
      throw new Error("Compaction is already in progress");
    const completion = this.waitForCompactCompletion();
    const message = customInstructions
      ? `/${WEB_COMPACT_EXTENSION_COMMAND} ${JSON.stringify(customInstructions)}`
      : `/${WEB_COMPACT_EXTENSION_COMMAND}`;
    try {
      const [, result] = await Promise.all([
        this.send(
          { type: "prompt", message },
          LONG_RUNNING_COMMAND_TIMEOUT_MS,
        ),
        completion,
      ]);
      return result;
    } catch (error) {
      this.rejectCompactCompletion(
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  async setSessionName(name: string): Promise<void> {
    await this.send({ type: "set_session_name", name });
  }

  async reload(): Promise<void> {
    if (this.reloadInFlight) return await this.reloadInFlight;
    const operation = (async () => {
      // Resource reload invalidates the current extension runner. Quiesce ordinary
      // RPC traffic first so model/command discovery cannot race that invalidation.
      await this.waitForPendingRequests();
      const commands = await this.send<{
        commands: Array<Record<string, unknown>>;
      }>({ type: "get_commands" }, RPC_REQUEST_TIMEOUT_MS, true);
      const generation = commands.commands.find(
        (command) => command.name === "web-reload",
      )?.description;
      if (typeof generation !== "string")
        throw new Error(
          "The managed Pi runtime does not expose web reload support",
        );
      this.reloadError = undefined;
      await this.send(
        { type: "prompt", message: "/web-reload" },
        LONG_RUNNING_COMMAND_TIMEOUT_MS,
        true,
      );
      const deadline = Date.now() + LONG_RUNNING_COMMAND_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (this.reloadError) throw this.reloadError;
        const nextCommands = await this.send<{
          commands: Array<Record<string, unknown>>;
        }>({ type: "get_commands" }, RPC_REQUEST_TIMEOUT_MS, true);
        const next = nextCommands.commands.find(
          (command) => command.name === "web-reload",
        )?.description;
        if (typeof next === "string" && next !== generation) return;
        await Bun.sleep(25);
      }
      throw new Error("Pi reload timed out");
    })();
    this.reloadInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.reloadInFlight === operation) this.reloadInFlight = undefined;
    }
  }

  async prompt(
    message: string,
    streamingBehavior?: "steer" | "followUp",
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<void> {
    await this.send({ type: "prompt", message, images, streamingBehavior });
  }

  async worktree(message: string): Promise<void> {
    const before = (await this.getState()) as { sessionId?: unknown };
    const previousId =
      typeof before.sessionId === "string" ? before.sessionId : undefined;
    this.worktreeError = undefined;
    // RPC acknowledges prompt preflight before an extension command's async
    // handler finishes, so wait for its replacement ID or extension error.
    await this.send(
      { type: "prompt", message },
      LONG_RUNNING_COMMAND_TIMEOUT_MS,
    );
    const deadline = Date.now() + LONG_RUNNING_COMMAND_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.worktreeError) throw this.worktreeError;
      const state = (await this.getState()) as {
        sessionId?: unknown;
        sessionFile?: unknown;
      };
      if (
        typeof state.sessionId === "string" &&
        state.sessionId !== previousId
      ) {
        const replacement =
          typeof state.sessionFile === "string"
            ? this.options.replacementForSessionFile?.(state.sessionFile)
            : undefined;
        if (
          replacement &&
          replacement.previousSessionId === previousId &&
          replacement.replacementSessionId === state.sessionId
        )
          return;
      }
      await Bun.sleep(25);
    }
    throw new Error("Pi worktree switch timed out");
  }

  async abort(): Promise<void> {
    // Stop must bypass a wedged reload, but still acknowledge only after its
    // serialized frame is written. Expired queued writes are skipped.
    await this.deliver({ type: "abort" }, true, RPC_REQUEST_TIMEOUT_MS);
  }

  async bash(command: string): Promise<unknown> {
    return await this.send(
      { type: "bash", command },
      LONG_RUNNING_COMMAND_TIMEOUT_MS,
    );
  }

  async abortBash(): Promise<void> {
    await this.send({ type: "abort_bash" });
  }

  async respondToExtensionUi(
    command: Extract<RpcSessionCommand, { type: "extension_ui_response" }>,
  ): Promise<void> {
    if (this.stopped) throw new Error("RPC session stopped");
    if (!this.started) await this.start();
    await this.writeLine(`${JSON.stringify(command)}\n`);
  }

  async switchSession(sessionPath: string): Promise<void> {
    await this.send({ type: "switch_session", sessionPath });
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return await this.shutdownPromise;
    const operation = this.shutdownOnce();
    this.shutdownPromise = operation;
    try {
      await operation;
    } finally {
      if (this.shutdownPromise === operation) this.shutdownPromise = undefined;
    }
  }

  private async shutdownOnce(): Promise<void> {
    const proc = this.process;
    if (!proc || this.stopped) {
      this.failRuntimeOperations(new Error("RPC session stopped"));
      return;
    }
    try {
      // Shutdown only needs confirmed stdin delivery, not an RPC response. A
      // wedged child may never acknowledge abort and must not hold deletion or
      // daemon teardown behind the full request timeout.
      await this.deliver({ type: "abort" }, true, SHUTDOWN_DELIVERY_TIMEOUT_MS);
    } catch {
      // Process termination remains the authoritative shutdown fallback.
    }
    this.stopped = true;
    this.failRuntimeOperations(new Error("RPC session stopped"));
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    if (!(await this.waitForExit(proc, SHUTDOWN_TERM_GRACE_MS))) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await proc.exited.catch(() => undefined);
    }
    if (this.process === proc) this.process = undefined;
  }

  private async waitForExit(
    proc: Bun.Subprocess,
    timeoutMs: number,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        proc.exited.then(
          () => true,
          () => true,
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
