import { resolve } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  FOOTER_CONTRIBUTION_EVENT,
  type FooterContribution,
} from "../footer-events.js";
import {
  SUBAGENT_STATUS_EVENT,
  type SubagentStatusEvent,
  type SubagentWebSnapshot,
  type SubagentWebUpdate,
} from "../subagent-events.js";
import {
  formatClock,
  formatDuration,
  formatTokens,
  modelName,
  sanitizeName,
  statusIcon,
  stringifyCompact,
  truncateChars,
  truncateToolOutput,
} from "./format.js";
import {
  abortRunningSubagentSessions,
  countsAgainstSubagentLimit,
  isFailedStopReason,
  isTerminalSubagentStatus,
  shouldArchiveTerminalSubagent,
} from "./lifecycle.js";
import {
  filterModelsToScope,
  inheritedSubagentModel,
  subagentModelRuntime,
  unavailableModelMessage,
} from "./models.js";
import {
  appendBoundedStreamingText,
  boundedWebTranscript,
  finalAssistantText,
  messageError,
  messageRole,
  messageStopReason,
  messageToTranscript,
  messageUsage,
  webTranscript,
} from "./transcript.js";
import {
  type AgentModel,
  type AgentSnapshot,
  MAX_ACTIVITY_ITEMS,
  MAX_SUBAGENTS,
  MAX_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_ITEMS,
  type ManagedSubagent,
  type MessageUrgency,
  type PersistedUsageState,
  SUBAGENT_SYSTEM_PROMPT,
  type SubagentEffort,
  type TranscriptItem,
  USAGE_STATE_ENTRY,
  type Usage,
  WEB_STATUS_PUBLISH_INTERVAL_MS,
} from "./types.js";
import {
  addUsage,
  asFooterUsage,
  cloneUsage,
  hasUsage,
  parsePersistedUsageState,
  subtractUsage,
  zeroUsage,
} from "./usage.js";

export class SubagentManager {
  readonly agents = new Map<string, ManagedSubagent>();
  private archivedAgents = new Map<string, ManagedSubagent>();
  private nextId = 1;
  private currentContext?: ExtensionContext;
  private totalUsage = zeroUsage();
  private accountedUsage = zeroUsage();
  private usageDirty = false;
  private footerSelected = false;
  private lastWebStatusPublishedAt = 0;
  private webStatusPublishTimer?: ReturnType<typeof setTimeout>;
  private webTranscriptCursors = new Map<string, TranscriptItem | undefined>();
  private webStreamingSnapshots = new Map<string, string>();
  private abortAllInFlight?: Promise<number>;

  constructor(private readonly pi: ExtensionAPI) {}

  setContext(ctx: ExtensionContext): void {
    this.currentContext = ctx;
    this.footerSelected = false;
    this.totalUsage = zeroUsage();
    this.accountedUsage = zeroUsage();
    this.usageDirty = false;
    this.webTranscriptCursors.clear();
    this.webStreamingSnapshots.clear();
    for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
      if (entry.type !== "custom" || entry.customType !== USAGE_STATE_ENTRY)
        continue;
      const restored = parsePersistedUsageState(entry.data);
      if (restored) {
        this.totalUsage = cloneUsage(restored.total);
        this.accountedUsage = cloneUsage(restored.accounted);
      }
      break;
    }
    this.publishFooter();
  }

  persistUsage(): void {
    if (!this.usageDirty || !hasUsage(this.totalUsage)) return;
    this.pi.appendEntry(USAGE_STATE_ENTRY, {
      total: cloneUsage(this.totalUsage),
      accounted: cloneUsage(this.accountedUsage),
    } satisfies PersistedUsageState);
    this.usageDirty = false;
  }

  clearContext(): void {
    if (this.webStatusPublishTimer) clearTimeout(this.webStatusPublishTimer);
    this.webStatusPublishTimer = undefined;
    this.lastWebStatusPublishedAt = 0;
    this.webTranscriptCursors.clear();
    this.webStreamingSnapshots.clear();
    this.archivedAgents.clear();
    const ctx = this.currentContext;
    if (ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      this.pi.events.emit(FOOTER_CONTRIBUTION_EVENT, {
        sessionId,
        key: "subagents",
        remove: true,
      } satisfies FooterContribution);
      this.pi.events.emit(SUBAGENT_STATUS_EVENT, {
        sessionId,
        agents: [],
        usage: zeroUsage(),
        remove: true,
      } satisfies SubagentStatusEvent);
    }
    this.currentContext = undefined;
    this.footerSelected = false;
  }

  hasAgents(): boolean {
    return this.agents.size > 0;
  }

  isFooterSelected(): boolean {
    return this.footerSelected;
  }

  setFooterSelected(selected: boolean): void {
    if (this.footerSelected === selected) return;
    this.footerSelected = selected && this.hasAgents();
    this.publishFooter();
  }

  getAgent(id: string): ManagedSubagent {
    const agent = this.agents.get(id) ?? this.archivedAgents.get(id);
    if (!agent) throw new Error(`Unknown subagent: ${id}`);
    return agent;
  }

  list(): ManagedSubagent[] {
    return Array.from(this.agents.values()).sort(
      (a, b) => a.createdAt - b.createdAt,
    );
  }

  snapshots(): AgentSnapshot[] {
    return this.list().map((agent) => ({
      id: agent.id,
      status: agent.status,
      model: agent.model,
      effort: agent.effort,
      turns: agent.turns,
      currentTool: agent.currentTool,
      queued: agent.queuedSteering + agent.queuedFollowUp,
    }));
  }

  webSnapshots(): SubagentWebSnapshot[] {
    return this.list().map((agent) => ({
      id: agent.id,
      status: agent.status,
      model: agent.model,
      effort: agent.effort,
      turns: agent.turns,
      currentTool: agent.currentTool,
      queued: agent.queuedSteering + agent.queuedFollowUp,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      completedAt: agent.completedAt,
      error: agent.error,
      usage: cloneUsage(agent.usage),
      transcript: webTranscript(agent),
      streamingText: agent.streamingText || undefined,
    }));
  }

  private webStatusUpdates(): SubagentWebUpdate[] {
    return this.list().map((agent) => {
      const update: SubagentWebUpdate = {
        id: agent.id,
        status: agent.status,
        model: agent.model,
        effort: agent.effort,
        turns: agent.turns,
        currentTool: agent.currentTool ?? null,
        queued: agent.queuedSteering + agent.queuedFollowUp,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
        completedAt: agent.completedAt ?? null,
        error: agent.error ?? null,
        usage: cloneUsage(agent.usage),
      };

      const hadTranscriptCursor = this.webTranscriptCursors.has(agent.id);
      const previousTranscriptItem = this.webTranscriptCursors.get(agent.id);
      const previousIndex = previousTranscriptItem
        ? agent.transcript.indexOf(previousTranscriptItem)
        : -1;
      if (
        !hadTranscriptCursor ||
        (previousTranscriptItem && previousIndex < 0)
      ) {
        update.transcriptReset = true;
        update.transcriptDelta = webTranscript(agent);
      } else {
        const firstNewIndex = previousTranscriptItem ? previousIndex + 1 : 0;
        if (firstNewIndex < agent.transcript.length) {
          update.transcriptDelta = boundedWebTranscript(
            agent.transcript.slice(firstNewIndex),
          );
        }
      }
      this.webTranscriptCursors.set(agent.id, agent.transcript.at(-1));

      const hadStreamingSnapshot = this.webStreamingSnapshots.has(agent.id);
      const previousStreamingText =
        this.webStreamingSnapshots.get(agent.id) ?? "";
      if (
        !hadStreamingSnapshot ||
        !agent.streamingText.startsWith(previousStreamingText)
      ) {
        update.streamingTextReset = true;
        update.streamingTextDelta = agent.streamingText;
      } else if (agent.streamingText.length > previousStreamingText.length) {
        update.streamingTextDelta = agent.streamingText.slice(
          previousStreamingText.length,
        );
      }
      this.webStreamingSnapshots.set(agent.id, agent.streamingText);
      return update;
    });
  }

  private makeId(requestedName?: string): string {
    const base = requestedName
      ? sanitizeName(requestedName)
      : `agent-${this.nextId++}`;
    if (!base) return this.makeId();
    if (!this.agents.has(base) && !this.archivedAgents.has(base)) return base;
    let suffix = 2;
    while (
      this.agents.has(`${base}-${suffix}`) ||
      this.archivedAgents.has(`${base}-${suffix}`)
    )
      suffix++;
    return `${base}-${suffix}`;
  }

  private activeSessionCount(): number {
    return this.list().filter(countsAgainstSubagentLimit).length;
  }

  private getModelRuntime(ctx: ExtensionContext): ModelRuntime {
    return subagentModelRuntime(ctx.modelRegistry);
  }

  async availableModels(ctx: ExtensionContext): Promise<readonly AgentModel[]> {
    const available = await this.getModelRuntime(ctx).getAvailable();
    return filterModelsToScope(available, ctx.scopedModels);
  }

  private async resolveModel(
    ctx: ExtensionContext,
    requested?: string,
    runtime?: ModelRuntime,
  ): Promise<AgentModel | undefined> {
    if (!requested) {
      if (!ctx.model) return undefined;
      const inheritedRuntime = runtime ?? this.getModelRuntime(ctx);
      // Omitted model means exact host-session inheritance. Session model scope
      // applies only to explicit overrides and may intentionally exclude the
      // separately selected --model value.
      return inheritedSubagentModel(
        ctx.model as AgentModel,
        inheritedRuntime.getModel(ctx.model.provider, ctx.model.id),
      );
    }

    const available = await this.availableModels(ctx);
    const slash = requested.indexOf("/");
    if (slash > 0) {
      const provider = requested.slice(0, slash);
      const id = requested.slice(slash + 1);
      const model = available.find(
        (item) => item.provider === provider && item.id === id,
      );
      if (model) return model;
      throw new Error(
        unavailableModelMessage(
          requested,
          available,
          ctx.model,
          ctx.scopedModels.length > 0,
        ),
      );
    }

    const matches = available.filter(
      (item) => item.id === requested || item.name === requested,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(
        `Model name is ambiguous; use provider/model: ${matches.map(modelName).join(", ")}`,
      );
    }
    throw new Error(
      unavailableModelMessage(
        requested,
        available,
        ctx.model,
        ctx.scopedModels.length > 0,
      ),
    );
  }

  private scopedEffort(
    ctx: ExtensionContext,
    model: AgentModel | undefined,
  ): SubagentEffort | undefined {
    if (!model) return undefined;
    return ctx.scopedModels.find(
      (scoped) =>
        scoped.model.provider === model.provider &&
        scoped.model.id === model.id,
    )?.thinkingLevel as SubagentEffort | undefined;
  }

  private activity(agent: ManagedSubagent, text: string): void {
    agent.updatedAt = Date.now();
    agent.activity.push({ timestamp: agent.updatedAt, text });
    if (agent.activity.length > MAX_ACTIVITY_ITEMS) {
      const removed = agent.activity.length - MAX_ACTIVITY_ITEMS;
      agent.activity.splice(0, removed);
      agent.lastReadActivity = Math.max(0, agent.lastReadActivity - removed);
    }
    for (const waiter of agent.waiters) waiter();
    agent.waiters.clear();
    this.publishFooter();
  }

  private addTranscript(agent: ManagedSubagent, message: unknown): void {
    const transcript = messageToTranscript(message);
    if (!transcript) return;
    agent.transcript.push(transcript);
    if (agent.transcript.length > MAX_TRANSCRIPT_ITEMS)
      agent.transcript.splice(
        0,
        agent.transcript.length - MAX_TRANSCRIPT_ITEMS,
      );
    let retainedCharacters = agent.transcript.reduce(
      (total, item) => total + item.text.length,
      0,
    );
    while (
      retainedCharacters > MAX_TRANSCRIPT_CHARS &&
      agent.transcript.length > 1
    ) {
      retainedCharacters -= agent.transcript.shift()?.text.length ?? 0;
    }
  }

  private accountUsage(agent: ManagedSubagent, usage: Usage | undefined): void {
    if (!usage) return;
    addUsage(agent.usage, usage);
    addUsage(this.totalUsage, usage);
    this.usageDirty = true;
    this.publishFooter();
  }

  private subscribe(agent: ManagedSubagent, session: AgentSession): void {
    agent.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      switch (event.type) {
        case "agent_start":
          agent.status = "working";
          agent.error = undefined;
          agent.lastStopReason = undefined;
          this.activity(agent, "started an agent turn");
          break;
        case "turn_start":
          agent.turns++;
          this.activity(agent, `started turn ${agent.turns}`);
          break;
        case "tool_execution_start":
          agent.currentTool = event.toolName;
          this.activity(
            agent,
            `running ${event.toolName} ${stringifyCompact(event.args)}`,
          );
          break;
        case "tool_execution_end":
          this.activity(
            agent,
            `${event.isError ? "failed" : "finished"} ${event.toolName}`,
          );
          agent.currentTool = undefined;
          break;
        case "message_update": {
          const update = event.assistantMessageEvent;
          if (update.type === "text_delta") {
            agent.streamingText = appendBoundedStreamingText(
              agent.streamingText,
              update.delta,
            );
          }
          const now = Date.now();
          if (
            agent.streamingText &&
            now - agent.lastStreamActivityAt >= 5_000
          ) {
            agent.lastStreamActivityAt = now;
            this.activity(agent, "writing a response");
          }
          break;
        }
        case "message_end": {
          this.addTranscript(agent, event.message);
          const role = messageRole(event.message);
          if (role === "assistant" || role === "toolResult")
            this.accountUsage(agent, messageUsage(event.message));
          if (role === "assistant") {
            agent.streamingText = "";
            const stopReason = messageStopReason(event.message);
            agent.lastStopReason = stopReason;
            const error = messageError(event.message);
            if (error) agent.error = error;
            else if (stopReason !== "error" && stopReason !== "aborted")
              agent.error = undefined;
            this.activity(
              agent,
              `assistant response finished${stopReason ? ` (${stopReason})` : ""}`,
            );
          }
          break;
        }
        case "queue_update":
          agent.queuedSteering = event.steering.length;
          agent.queuedFollowUp = event.followUp.length;
          this.activity(
            agent,
            `queue updated: ${agent.queuedSteering} steering, ${agent.queuedFollowUp} follow-up`,
          );
          break;
        case "agent_end":
          if (event.willRetry) this.activity(agent, "waiting to retry");
          break;
        case "agent_settled":
          if (agent.status !== "terminated" && agent.status !== "terminating") {
            const failed = isFailedStopReason(agent.lastStopReason);
            agent.status = failed ? "failed" : "completed";
            agent.completedAt = Date.now();
            this.activity(
              agent,
              failed
                ? `failed${agent.error ? `: ${agent.error}` : ` (${agent.lastStopReason})`}`
                : "completed and is waiting for more instructions",
            );
          }
          break;
        case "auto_retry_start":
          this.activity(
            agent,
            `retrying after an error (attempt ${event.attempt}/${event.maxAttempts})`,
          );
          break;
        case "compaction_start":
          this.activity(agent, `compacting context (${event.reason})`);
          break;
        case "compaction_end":
          this.accountUsage(agent, event.result?.usage);
          this.activity(
            agent,
            event.errorMessage
              ? `context compaction failed: ${event.errorMessage}`
              : event.aborted
                ? "context compaction aborted"
                : `context compaction finished (${event.reason})`,
          );
          break;
      }
    });
  }

  private attachRun(agent: ManagedSubagent, promise: Promise<void>): void {
    agent.runPromise = promise
      .then(() => {
        if (
          agent.status !== "terminated" &&
          agent.status !== "terminating" &&
          agent.status !== "failed"
        ) {
          agent.status = "completed";
          agent.completedAt = Date.now();
          this.activity(agent, "task run settled");
        }
      })
      .catch((error: unknown) => {
        if (agent.status === "terminated" || agent.status === "terminating")
          return;
        agent.status = "failed";
        agent.error = error instanceof Error ? error.message : String(error);
        agent.completedAt = Date.now();
        this.activity(agent, `failed: ${agent.error}`);
      });
  }

  async create(
    ctx: ExtensionContext,
    options: {
      prompt: string;
      name?: string;
      model?: string;
      effort?: SubagentEffort;
      cwd?: string;
    },
    signal?: AbortSignal,
  ): Promise<ManagedSubagent> {
    if (this.activeSessionCount() >= MAX_SUBAGENTS) {
      throw new Error(
        `At most ${MAX_SUBAGENTS} live subagent sessions may be retained at once. Terminate one before creating another.`,
      );
    }
    if (signal?.aborted) throw new Error("Subagent creation was cancelled");

    const cwd = resolve(ctx.cwd, options.cwd ?? ".");
    const id = this.makeId(options.name);
    const activeTools = this.pi.getActiveTools();
    const effort = options.effort ?? (ctx.thinkingLevel as SubagentEffort);
    const agent: ManagedSubagent = {
      id,
      prompt: options.prompt,
      cwd,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "creating",
      model: options.model ?? modelName(ctx.model),
      effort,
      turns: 0,
      queuedSteering: 0,
      queuedFollowUp: 0,
      activity: [],
      lastReadActivity: 0,
      transcript: [],
      streamingText: "",
      lastStreamActivityAt: 0,
      usage: zeroUsage(),
      waiters: new Set(),
    };
    this.agents.set(id, agent);
    this.activity(agent, "creating isolated session");

    try {
      const runtime = await this.getModelRuntime(ctx);
      const selectedModel = await this.resolveModel(
        ctx,
        options.model,
        runtime,
      );
      const selectedEffort =
        options.effort ?? this.scopedEffort(ctx, selectedModel) ?? effort;
      agent.effort = selectedEffort;
      const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir());
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: getAgentDir(),
        settingsManager,
        noExtensions: true,
        appendSystemPrompt: [SUBAGENT_SYSTEM_PROMPT],
      });
      await resourceLoader.reload();
      if (signal?.aborted) throw new Error("Subagent creation was cancelled");

      const { session } = await createAgentSession({
        cwd,
        agentDir: getAgentDir(),
        modelRuntime: runtime,
        model: selectedModel,
        thinkingLevel: selectedEffort,
        tools: activeTools,
        resourceLoader,
        settingsManager,
        sessionManager: SessionManager.inMemory(cwd),
      });
      if (!session.model) {
        session.dispose();
        throw new Error("No authenticated model is available for the subagent");
      }
      if (signal?.aborted) {
        session.dispose();
        throw new Error("Subagent creation was cancelled");
      }

      agent.session = session;
      agent.model = modelName(session.model);
      agent.effort = session.thinkingLevel as SubagentEffort;
      agent.status = "working";
      this.subscribe(agent, session);
      this.activity(
        agent,
        `started with ${agent.model} at ${agent.effort} effort`,
      );
      this.attachRun(
        agent,
        session.prompt(options.prompt, { source: "extension" }),
      );
      // Creation already reports these startup events, so the first read waits for new activity.
      agent.lastReadActivity = agent.activity.length;
      return agent;
    } catch (error) {
      agent.status = signal?.aborted ? "terminated" : "failed";
      agent.error = error instanceof Error ? error.message : String(error);
      agent.completedAt = Date.now();
      this.activity(agent, `${agent.status}: ${agent.error}`);
      throw error;
    }
  }

  async send(
    id: string,
    message: string,
    urgency: MessageUrgency,
  ): Promise<void> {
    const agent = this.getAgent(id);
    const session = agent.session;
    if (!session)
      throw new Error(`Subagent ${id} no longer has a live session`);
    if (agent.status === "terminating" || agent.status === "terminated") {
      throw new Error(`Subagent ${id} is ${agent.status}`);
    }

    if (session.isStreaming) {
      if (urgency === "urgent") await session.steer(message);
      else await session.followUp(message);
      this.activity(
        agent,
        `${urgency === "urgent" ? "steered with" : "queued"} instruction: ${truncateChars(message, 160)}`,
      );
      return;
    }

    agent.status = "working";
    this.activity(
      agent,
      `started follow-on instruction: ${truncateChars(message, 160)}`,
    );
    this.attachRun(agent, session.prompt(message, { source: "extension" }));
  }

  async configure(
    ctx: ExtensionContext,
    id: string,
    options: { model?: string; effort?: SubagentEffort },
  ): Promise<ManagedSubagent> {
    const agent = this.getAgent(id);
    const session = agent.session;
    if (!session)
      throw new Error(`Subagent ${id} no longer has a live session`);
    if (!options.model && !options.effort)
      throw new Error("Specify a model, effort, or both");

    if (options.model) {
      const model = await this.resolveModel(ctx, options.model);
      if (!model) throw new Error("No model was selected");
      await session.setModel(model);
      agent.model = modelName(session.model);
      const pinnedEffort = this.scopedEffort(ctx, model);
      if (!options.effort && pinnedEffort)
        session.setThinkingLevel(pinnedEffort);
      agent.effort = session.thinkingLevel as SubagentEffort;
      this.activity(
        agent,
        `model changed to ${agent.model} at ${agent.effort} effort`,
      );
    }
    if (options.effort) {
      session.setThinkingLevel(options.effort);
      agent.effort = session.thinkingLevel as SubagentEffort;
      this.activity(agent, `effort changed to ${agent.effort}`);
    }
    return agent;
  }

  async abortAll(): Promise<number> {
    if (this.abortAllInFlight) return await this.abortAllInFlight;
    const operation = (async () => {
      const results = await abortRunningSubagentSessions(this.list());
      for (const { agent, error } of results) {
        if (error) {
          agent.error = error.message;
          this.activity(agent, `abort failed: ${agent.error}`);
        } else {
          this.activity(agent, "aborted with the main agent");
        }
      }
      return results.length;
    })();
    this.abortAllInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.abortAllInFlight === operation)
        this.abortAllInFlight = undefined;
    }
  }

  async terminate(id: string, remove = false): Promise<ManagedSubagent> {
    const agent = this.getAgent(id);
    if (agent.status !== "terminated") {
      agent.status = "terminating";
      this.activity(agent, "termination requested");
      const session = agent.session;
      if (session) {
        try {
          await session.abort();
        } catch (error) {
          agent.error = error instanceof Error ? error.message : String(error);
        } finally {
          agent.unsubscribe?.();
          agent.unsubscribe = undefined;
          try {
            session.dispose();
          } catch (error) {
            agent.error =
              error instanceof Error ? error.message : String(error);
          }
          agent.session = undefined;
        }
      }
      agent.status = "terminated";
      agent.completedAt = Date.now();
      this.activity(agent, "terminated and released session resources");
    }
    this.agents.delete(id);
    this.webTranscriptCursors.delete(id);
    this.webStreamingSnapshots.delete(id);
    if (remove) this.archivedAgents.delete(id);
    else if (shouldArchiveTerminalSubagent(agent))
      this.archivedAgents.set(id, agent);
    this.footerSelected = false;
    this.publishFooter();
    if (this.webStatusPublishTimer) clearTimeout(this.webStatusPublishTimer);
    this.publishWebStatus();
    return agent;
  }

  async terminateAll(remove = false): Promise<void> {
    await Promise.all(
      this.list().map(async (agent) => this.terminate(agent.id, remove)),
    );
    if (remove) this.archivedAgents.clear();
  }

  async clearTerminalAgents(): Promise<number> {
    const terminalAgents = this.list().filter((agent) =>
      isTerminalSubagentStatus(agent.status),
    );
    if (terminalAgents.length === 0) return 0;

    await Promise.all(
      terminalAgents.map(async (agent) => {
        const preserveUnreadOutput = shouldArchiveTerminalSubagent(agent);
        await this.terminate(agent.id, true);
        if (preserveUnreadOutput) this.archivedAgents.set(agent.id, agent);
      }),
    );
    if (this.webStatusPublishTimer) clearTimeout(this.webStatusPublishTimer);
    this.publishWebStatus();
    return terminalAgents.length;
  }

  private hasUnread(agent: ManagedSubagent): boolean {
    return agent.lastReadActivity < agent.activity.length;
  }

  async waitForUpdates(
    agents: ManagedSubagent[],
    seconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (seconds <= 0 || agents.some((agent) => this.hasUnread(agent))) return;
    const running = agents.filter(
      (agent) => agent.status === "creating" || agent.status === "working",
    );
    if (running.length === 0) return;

    await new Promise<void>((done) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        for (const agent of running) agent.waiters.delete(finish);
        signal?.removeEventListener("abort", finish);
        done();
      };
      const timer = setTimeout(finish, Math.min(30, seconds) * 1_000);
      for (const agent of running) agent.waiters.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  read(agents: ManagedSubagent[], includeTranscript: boolean): string {
    if (agents.length === 0)
      return "No subagents are involved in this session.";
    const now = Date.now();
    const sections: string[] = [];
    for (const agent of agents) {
      const heading = `## ${statusIcon(agent.status)} ${agent.id} — ${agent.status}`;
      const metadata = [
        `Model: ${agent.model}`,
        `Effort: ${agent.effort}`,
        `Elapsed: ${formatDuration((agent.completedAt ?? now) - agent.createdAt)}`,
        `Turns: ${agent.turns}`,
        `Usage: ↑${formatTokens(agent.usage.input)} ↓${formatTokens(agent.usage.output)}${agent.usage.cost.total ? ` $${agent.usage.cost.total.toFixed(4)}` : ""}`,
      ];
      if (agent.currentTool)
        metadata.push(`Current tool: ${agent.currentTool}`);
      if (agent.queuedSteering || agent.queuedFollowUp) {
        metadata.push(
          `Queued: ${agent.queuedSteering} steering, ${agent.queuedFollowUp} follow-up`,
        );
      }
      if (agent.error) metadata.push(`Error: ${agent.error}`);

      const unread = agent.activity.slice(agent.lastReadActivity);
      const activity = unread.length
        ? unread
            .map((item) => `- ${formatClock(item.timestamp)} ${item.text}`)
            .join("\n")
        : "- No new activity.";
      agent.lastReadActivity = agent.activity.length;

      let output = `${heading}\n${metadata.join("\n")}\n\nActivity since last read:\n${activity}`;
      if (includeTranscript) {
        const transcript = agent.transcript
          .map(
            (item) =>
              `### ${formatClock(item.timestamp)} ${item.role}\n${item.text}`,
          )
          .join("\n\n");
        output += `\n\nTranscript:\n${transcript || agent.streamingText || "(empty)"}`;
      } else {
        const latest = finalAssistantText(agent);
        if (latest) output += `\n\nLatest assistant output:\n${latest}`;
      }
      sections.push(output);
      if (this.archivedAgents.get(agent.id) === agent)
        this.archivedAgents.delete(agent.id);
    }
    return truncateToolOutput(sections.join("\n\n---\n\n"));
  }

  claimUnaccountedUsage(): Usage | undefined {
    const usage = subtractUsage(this.totalUsage, this.accountedUsage);
    if (!hasUsage(usage)) return undefined;
    this.accountedUsage = cloneUsage(this.totalUsage);
    this.usageDirty = true;
    this.publishFooter();
    return usage;
  }

  private footerText(): string | undefined {
    if (this.agents.size === 0) return undefined;
    let working = 0;
    let completed = 0;
    let failed = 0;
    let terminated = 0;
    for (const agent of this.agents.values()) {
      if (
        agent.status === "creating" ||
        agent.status === "working" ||
        agent.status === "terminating"
      )
        working++;
      else if (agent.status === "completed") completed++;
      else if (agent.status === "failed") failed++;
      else terminated++;
    }
    const parts = [
      `◆ ${this.agents.size} subagent${this.agents.size === 1 ? "" : "s"}`,
    ];
    if (working) parts.push(`${working} working`);
    if (completed) parts.push(`${completed} done`);
    if (failed) parts.push(`${failed} failed`);
    if (terminated) parts.push(`${terminated} stopped`);
    return parts.join(" • ");
  }

  private publishWebStatus(): void {
    this.webStatusPublishTimer = undefined;
    const ctx = this.currentContext;
    if (!ctx) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const usage = asFooterUsage(
      subtractUsage(this.totalUsage, this.accountedUsage),
    );
    this.lastWebStatusPublishedAt = Date.now();
    this.pi.events.emit(SUBAGENT_STATUS_EVENT, {
      sessionId,
      agents: this.webStatusUpdates(),
      usage,
    } satisfies SubagentStatusEvent);
  }

  private publishFooter(): void {
    const ctx = this.currentContext;
    if (!ctx) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const usage = asFooterUsage(
      subtractUsage(this.totalUsage, this.accountedUsage),
    );
    const statusText = this.footerText();
    const contribution: FooterContribution = {
      sessionId,
      key: "subagents",
      status: statusText
        ? { text: statusText, selected: this.footerSelected }
        : undefined,
      usage,
    };
    this.pi.events.emit(FOOTER_CONTRIBUTION_EVENT, contribution);

    // Footer metadata stays immediate, while coalesced web events carry only
    // transcript/streaming deltas. The server retains a bounded full snapshot
    // for newly subscribed clients without retransmitting it on every burst.
    const delay =
      WEB_STATUS_PUBLISH_INTERVAL_MS -
      (Date.now() - this.lastWebStatusPublishedAt);
    if (delay <= 0) {
      if (this.webStatusPublishTimer) clearTimeout(this.webStatusPublishTimer);
      this.publishWebStatus();
    } else if (!this.webStatusPublishTimer) {
      this.webStatusPublishTimer = setTimeout(
        () => this.publishWebStatus(),
        delay,
      );
      this.webStatusPublishTimer.unref?.();
    }
  }
}
