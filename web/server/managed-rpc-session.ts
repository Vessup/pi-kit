import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { RpcSessionCommand } from "../protocol.js";
import { SerializedWriter } from "./serialized-writer.js";

const encoder = new TextEncoder();
const configuredRpcTimeout = Number(process.env.PI_WEB_RPC_TIMEOUT_MS ?? "30000");
const RPC_REQUEST_TIMEOUT_MS = Number.isFinite(configuredRpcTimeout) && configuredRpcTimeout > 0
	? Math.floor(configuredRpcTimeout)
	: 30_000;
const LONG_RUNNING_COMMAND_TIMEOUT_MS = 10 * 60_000;
const SHUTDOWN_DELIVERY_TIMEOUT_MS = Math.min(RPC_REQUEST_TIMEOUT_MS, 1_000);

type RpcResponse<T = unknown> =
	| { id?: string; type: "response"; command: string; success: true; data?: T }
	| { id?: string; type: "response"; command: string; success: false; error: string };

type RpcEvent = Record<string, unknown> & { type?: string; id?: string };

export type ManagedRpcSessionOptions = {
	cwd: string;
	name?: string;
	sessionFile?: string;
	noSession?: boolean;
	runtimeDirectory?: string;
	onEvent: (event: RpcEvent) => void;
	onExit: (code: number | null, signal: string | null) => void;
	replacementForSessionFile?: (file: string) => { previousSessionId: string; replacementSessionId: string } | undefined;
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

export class ManagedRpcSession {
	private readonly options: ManagedRpcSessionOptions;
	private process: Bun.Subprocess | undefined;
	private stdoutBuffer = "";
	private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; command: string }>();
	private stopped = false;
	private readonly requestPrefix = `web-${randomUUID()}`;
	private worktreeError: Error | undefined;
	private reloadError: Error | undefined;
	private reloadInFlight: Promise<void> | undefined;
	private readonly lineWriter = new SerializedWriter<string>((line) => this.writeLineNow(line));

	constructor(options: ManagedRpcSessionOptions) {
		this.options = options;
	}

	async start(): Promise<void> {
		if (this.process) return;
		if (this.options.runtimeDirectory) mkdirSync(this.options.runtimeDirectory, { recursive: true });
		const env = {
			...process.env,
			PI_WEB_MANAGED: "1",
		};
		const args = ["--mode", "rpc"];
		if (this.options.noSession) args.push("--no-session");
		if (this.options.name) args.push("--name", this.options.name);
		if (this.options.sessionFile) {
			// Start in the target cwd and switch to the existing session file immediately.
			// This keeps the spawned process managed while preserving the existing branch history.
		}
		const proc = Bun.spawn({
			cmd: ["pi", ...args],
			cwd: this.options.cwd,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.process = proc;
		void this.pumpStdout(proc).catch((error) => {
			this.failAllPending(error instanceof Error ? error : new Error(String(error)));
		});
		this.pumpStderr(proc).catch(() => undefined);
		proc.exited.then((code: number) => {
			this.stopped = true;
			this.options.onExit(code, null);
			this.failAllPending(new Error(`RPC process exited with code ${code}`));
		}).catch((error: unknown) => {
			this.stopped = true;
			this.options.onExit(null, error instanceof Error ? error.message : String(error));
			this.failAllPending(error instanceof Error ? error : new Error(String(error)));
		});
		await this.send({ type: "get_state" });
		if (this.options.sessionFile) {
			await this.send({ type: "switch_session", sessionPath: this.options.sessionFile });
		}
	}

	private async pumpStdout(proc: Bun.Subprocess): Promise<void> {
		const stream = (proc as unknown as { stdout?: ReadableStream<Uint8Array> }).stdout;
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
		const stream = (proc as unknown as { stderr?: ReadableStream<Uint8Array> }).stderr;
		if (!stream) return;
		const reader = stream.getReader();
		try {
			// Keep the pipe drained so the child cannot block, but do not retain its
			// unbounded diagnostics for the lifetime of the managed session.
			while (!(await reader.read()).done) {
				// discarded
			}
		} finally {
			reader.releaseLock();
		}
	}

	private handleLine(line: string): void {
		let parsed: RpcEvent;
		try {
			parsed = JSON.parse(line) as RpcEvent;
		} catch (error) {
			this.failAllPending(new Error(`Invalid JSONL from RPC child: ${error instanceof Error ? error.message : String(error)}`));
			return;
		}
		if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") return;
		if (parsed.type === "extension_error" && typeof parsed.error === "string") {
			if (parsed.extensionPath === "command:worktree") this.worktreeError = new Error(parsed.error);
			if (parsed.extensionPath === "command:web-reload") this.reloadError = new Error(parsed.error);
		}
		if (parsed.type === "response") {
			const response = parsed as RpcResponse;
			const responseId = typeof response.id === "string" ? response.id : undefined;
			if (responseId && this.pending.has(responseId)) {
				const pending = this.pending.get(responseId)!;
				this.pending.delete(responseId);
				if (response.success) pending.resolve((response as RpcResponse & { data?: unknown }).data);
				else pending.reject(new CommandRejectedError(response.error));
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
		const stdin = (this.process as unknown as { stdin?: { getWriter?: () => WritableStreamDefaultWriter<Uint8Array>; write?: (value: string | Uint8Array) => unknown; flush?: () => unknown } }).stdin;
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
				pending.reject(isUncertainRpcDeliveryCommand(pending.command)
					? new CommandDeliveryUncertainError(error.message)
					: error);
			} catch {
				// ignore
			}
		}
	}

	private async waitForPendingRequests(): Promise<void> {
		const deadline = Date.now() + RPC_REQUEST_TIMEOUT_MS;
		while (this.pending.size > 0) {
			if (Date.now() >= deadline) {
				const commands = [...this.pending.values()].map((pending) => pending.command).join(", ");
				throw new Error(`Could not reload while RPC commands are still pending: ${commands}`);
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
		const commandName = typeof command.type === "string" ? command.type : "unknown";
		const operation = (async () => {
			if (!bypassReloadBarrier && this.reloadInFlight) await this.reloadInFlight;
			if (this.stopped) throw new Error("RPC session stopped");
			if (!this.process) await this.start();
			let writeStarted = false;
			await this.writeLine(
				`${JSON.stringify({ id: `${this.requestPrefix}-${randomUUID()}`, ...command })}\n`,
				() => {
					if (deadline !== undefined && Date.now() >= deadline) return false;
					writeStarted = true;
					return true;
				},
			);
			if (!writeStarted) throw new Error(`RPC command ${commandName} timed out after ${timeoutMs}ms`);
		})();
		if (deadline === undefined) return await operation;
		const remaining = Math.max(0, deadline - Date.now());
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				operation,
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(() => reject(new Error(`RPC command ${commandName} timed out after ${timeoutMs}ms`)), remaining);
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
		if (!this.process) await this.start();
		const id = `${this.requestPrefix}-${randomUUID()}`;
		const payload = { id, ...command };
		const commandName = typeof command.type === "string" ? command.type : "unknown";
		return await new Promise<T>((resolve, reject) => {
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
					const message = `RPC command ${pending.command} timed out after ${timeoutMs}ms`;
					pending.reject(isUncertainRpcDeliveryCommand(pending.command) ? new CommandDeliveryUncertainError(message) : new Error(message));
				}, timeoutMs);
			}
			void this.writeLine(`${JSON.stringify(payload)}\n`, () => this.pending.has(id)).catch((error: unknown) => {
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);
				const cause = error instanceof Error ? error : new Error(String(error));
				pending.reject(isUncertainRpcDeliveryCommand(commandName) ? new CommandDeliveryUncertainError(cause.message) : cause);
			});
		});
	}

	async getState(): Promise<unknown> {
		return await this.send({ type: "get_state" });
	}

	async getAvailableModels(): Promise<{ models: Array<Record<string, unknown>> }> {
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

	async getEntries(since?: string): Promise<{ entries: unknown[]; leafId: string | null }> {
		return await this.send({ type: "get_entries", since });
	}

	async getMessages(): Promise<{ messages: unknown[] }> {
		return await this.send({ type: "get_messages" });
	}

	async getSessionStats(): Promise<Record<string, unknown>> {
		return await this.send({ type: "get_session_stats" });
	}

	async getForkMessages(): Promise<{ messages: Array<{ entryId: string; text: string }> }> {
		return await this.send({ type: "get_fork_messages" });
	}

	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		return await this.send({ type: "fork", entryId });
	}

	async clone(): Promise<{ cancelled: boolean }> {
		return await this.send({ type: "clone" });
	}

	async compact(customInstructions?: string): Promise<unknown> {
		return await this.send({ type: "compact", customInstructions }, LONG_RUNNING_COMMAND_TIMEOUT_MS);
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
			const commands = await this.send<{ commands: Array<Record<string, unknown>> }>({ type: "get_commands" }, RPC_REQUEST_TIMEOUT_MS, true);
			const generation = commands.commands.find((command) => command.name === "web-reload")?.description;
			if (typeof generation !== "string") throw new Error("The managed Pi runtime does not expose web reload support");
			this.reloadError = undefined;
			await this.send({ type: "prompt", message: "/web-reload" }, LONG_RUNNING_COMMAND_TIMEOUT_MS, true);
			const deadline = Date.now() + LONG_RUNNING_COMMAND_TIMEOUT_MS;
			while (Date.now() < deadline) {
				if (this.reloadError) throw this.reloadError;
				const nextCommands = await this.send<{ commands: Array<Record<string, unknown>> }>({ type: "get_commands" }, RPC_REQUEST_TIMEOUT_MS, true);
				const next = nextCommands.commands.find((command) => command.name === "web-reload")?.description;
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
		const before = await this.getState() as { sessionId?: unknown };
		const previousId = typeof before.sessionId === "string" ? before.sessionId : undefined;
		this.worktreeError = undefined;
		// RPC acknowledges prompt preflight before an extension command's async
		// handler finishes, so wait for its replacement ID or extension error.
		await this.send({ type: "prompt", message }, LONG_RUNNING_COMMAND_TIMEOUT_MS);
		const deadline = Date.now() + LONG_RUNNING_COMMAND_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (this.worktreeError) throw this.worktreeError;
			const state = await this.getState() as { sessionId?: unknown; sessionFile?: unknown };
			if (typeof state.sessionId === "string" && state.sessionId !== previousId) {
				const replacement = typeof state.sessionFile === "string" ? this.options.replacementForSessionFile?.(state.sessionFile) : undefined;
				if (
					replacement &&
					replacement.previousSessionId === previousId &&
					replacement.replacementSessionId === state.sessionId
				) return;
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
		return await this.send({ type: "bash", command }, LONG_RUNNING_COMMAND_TIMEOUT_MS);
	}

	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	async respondToExtensionUi(command: Extract<RpcSessionCommand, { type: "extension_ui_response" }>): Promise<void> {
		if (this.stopped) throw new Error("RPC session stopped");
		if (!this.process) await this.start();
		await this.writeLine(`${JSON.stringify(command)}\n`);
	}

	async switchSession(sessionPath: string): Promise<void> {
		await this.send({ type: "switch_session", sessionPath });
	}

	async shutdown(): Promise<void> {
		if (!this.process || this.stopped) return;
		try {
			// Shutdown only needs confirmed stdin delivery, not an RPC response. A
			// wedged child may never acknowledge abort and must not hold deletion or
			// daemon teardown behind the full request timeout.
			await this.deliver({ type: "abort" }, true, SHUTDOWN_DELIVERY_TIMEOUT_MS);
		} catch {
			// Process termination remains the authoritative shutdown fallback.
		}
		this.stopped = true;
		this.failAllPending(new Error("RPC session stopped"));
		try {
			(this.process as unknown as { kill?: (signal?: string) => void }).kill?.("SIGTERM");
		} catch {
			// ignore
		}
	}
}

