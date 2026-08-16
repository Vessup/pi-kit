import {
  DynamicBorder,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  type EditorComponent,
  type Focusable,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  formatClock,
  formatDuration,
  formatTokens,
  modelName,
  statusColor,
  statusIcon,
  truncateChars,
} from "./format.js";
import type { SubagentManager } from "./manager.js";
import {
  DETAIL_VIEW_LINES,
  type ManagedSubagent,
  type ManagerDialogResult,
  type SubagentEffort,
  THINKING_LEVELS,
} from "./types.js";

export interface AppEditorComponent
  extends EditorComponent,
    Partial<Focusable> {
  getCursor?: () => { line: number; col: number };
  getLines?: () => string[];
  isShowingAutocomplete?: () => boolean;
  dispose?: () => void;
  actionHandlers?: Map<unknown, () => void>;
  onEscape?: () => void;
  onCtrlD?: () => void;
  onPasteImage?: () => void;
  onExtensionShortcut?: (data: string) => boolean;
}

export class FooterNavigationEditor implements EditorComponent, Focusable {
  readonly actionHandlers?: Map<unknown, () => void>;

  constructor(
    private readonly base: AppEditorComponent,
    private readonly keybindings: KeybindingsManager,
    private readonly manager: SubagentManager,
    private readonly openManager: () => void,
  ) {
    this.actionHandlers = base.actionHandlers;
  }

  get focused(): boolean {
    return this.base.focused ?? false;
  }
  set focused(value: boolean) {
    if ("focused" in this.base) this.base.focused = value;
  }
  get wantsKeyRelease(): boolean | undefined {
    return this.base.wantsKeyRelease;
  }
  set wantsKeyRelease(value: boolean | undefined) {
    this.base.wantsKeyRelease = value;
  }
  get onSubmit(): ((text: string) => void) | undefined {
    return this.base.onSubmit;
  }
  set onSubmit(value: ((text: string) => void) | undefined) {
    this.base.onSubmit = value;
  }
  get onChange(): ((text: string) => void) | undefined {
    return this.base.onChange;
  }
  set onChange(value: ((text: string) => void) | undefined) {
    this.base.onChange = value;
  }
  get borderColor(): ((text: string) => string) | undefined {
    return this.base.borderColor;
  }
  set borderColor(value: ((text: string) => string) | undefined) {
    this.base.borderColor = value;
  }
  get onEscape(): (() => void) | undefined {
    return this.base.onEscape;
  }
  set onEscape(value: (() => void) | undefined) {
    this.base.onEscape = value;
  }
  get onCtrlD(): (() => void) | undefined {
    return this.base.onCtrlD;
  }
  set onCtrlD(value: (() => void) | undefined) {
    this.base.onCtrlD = value;
  }
  get onPasteImage(): (() => void) | undefined {
    return this.base.onPasteImage;
  }
  set onPasteImage(value: (() => void) | undefined) {
    this.base.onPasteImage = value;
  }
  get onExtensionShortcut(): ((data: string) => boolean) | undefined {
    return this.base.onExtensionShortcut;
  }
  set onExtensionShortcut(value: ((data: string) => boolean) | undefined) {
    this.base.onExtensionShortcut = value;
  }

  render(width: number): string[] {
    return this.base.render(width);
  }
  invalidate(): void {
    this.base.invalidate();
  }
  dispose(): void {
    this.base.dispose?.();
  }
  getText(): string {
    return this.base.getText();
  }
  setText(text: string): void {
    this.base.setText(text);
  }
  addToHistory(text: string): void {
    this.base.addToHistory?.(text);
  }
  insertTextAtCursor(text: string): void {
    this.base.insertTextAtCursor?.(text);
  }
  getExpandedText(): string {
    return this.base.getExpandedText?.() ?? this.base.getText();
  }
  setAutocompleteProvider(
    provider: Parameters<
      NonNullable<EditorComponent["setAutocompleteProvider"]>
    >[0],
  ): void {
    this.base.setAutocompleteProvider?.(provider);
  }
  setPaddingX(padding: number): void {
    this.base.setPaddingX?.(padding);
  }
  setAutocompleteMaxVisible(maximum: number): void {
    this.base.setAutocompleteMaxVisible?.(maximum);
  }

  handleInput(data: string): void {
    if (this.manager.isFooterSelected()) {
      if (this.keybindings.matches(data, "tui.select.confirm")) {
        this.manager.setFooterSelected(false);
        this.openManager();
        return;
      }
      if (
        this.keybindings.matches(data, "tui.select.up") ||
        this.keybindings.matches(data, "tui.select.cancel")
      ) {
        this.manager.setFooterSelected(false);
        return;
      }
      this.manager.setFooterSelected(false);
    }

    if (
      this.manager.hasAgents() &&
      this.base.getText().length === 0 &&
      !this.base.isShowingAutocomplete?.() &&
      matchesKey(data, "alt+down")
    ) {
      const cursor = this.base.getCursor?.();
      const lines = this.base.getLines?.();
      if (!cursor || !lines || cursor.line === lines.length - 1) {
        this.manager.setFooterSelected(true);
        return;
      }
    }
    this.base.handleInput(data);
  }
}

function padAnsi(text: string, width: number): string {
  const fitted = truncateToWidth(text, Math.max(0, width), "…");
  return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

function frameLines(
  theme: Theme,
  title: string,
  body: string[],
  width: number,
): string[] {
  if (width < 4) return body.map((line) => truncateToWidth(line, width, ""));
  const inner = width - 2;
  const titleText = truncateToWidth(` ${title} `, Math.max(0, inner - 2), "…");
  const topFill = Math.max(0, inner - visibleWidth(titleText));
  const top = theme.fg("borderAccent", `┌${titleText}${"─".repeat(topFill)}┐`);
  const bottom = theme.fg("borderAccent", `└${"─".repeat(inner)}┘`);
  return [
    top,
    ...body.map(
      (line) =>
        theme.fg("borderAccent", "│") +
        padAnsi(line, inner) +
        theme.fg("borderAccent", "│"),
    ),
    bottom,
  ];
}

class AgentListDialog implements Component {
  private selected = 0;
  private timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly manager: SubagentManager,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (result: ManagerDialogResult) => void,
  ) {
    this.timer = setInterval(() => tui.requestRender(), 500);
  }

  dispose(): void {
    clearInterval(this.timer);
  }
  invalidate(): void {}

  handleInput(data: string): void {
    const agents = this.manager.list();
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done({ action: "close" });
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.selected = Math.max(0, this.selected - 1);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.selected = Math.min(
        Math.max(0, agents.length - 1),
        this.selected + 1,
      );
      this.tui.requestRender();
      return;
    }
    const agent = agents[this.selected];
    if (!agent) return;
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.done({ action: "view", id: agent.id });
      return;
    }
    if (data === "m") {
      this.done({ action: "model", id: agent.id });
      return;
    }
    if (data === "e") {
      this.done({ action: "effort", id: agent.id });
      return;
    }
    if (data === "x") {
      this.done({ action: "terminate", id: agent.id });
      return;
    }
  }

  render(width: number): string[] {
    const agents = this.manager.list();
    this.selected = Math.min(this.selected, Math.max(0, agents.length - 1));
    const body: string[] = [];
    if (agents.length === 0)
      body.push(this.theme.fg("muted", " No subagents in this session"));
    for (let index = 0; index < agents.length; index++) {
      const agent = agents[index];
      const icon = this.theme.fg(
        statusColor(agent.status),
        statusIcon(agent.status),
      );
      const queue = agent.queuedSteering + agent.queuedFollowUp;
      let line = `${index === this.selected ? "›" : " "} ${icon} ${agent.id}  ${agent.status}`;
      if (agent.currentTool) line += ` · ${agent.currentTool}`;
      if (queue) line += ` · ${queue} queued`;
      line += ` · ${agent.model} · ${agent.effort}`;
      if (index === this.selected)
        line = this.theme.bg("selectedBg", this.theme.fg("accent", line));
      body.push(line);
    }
    body.push("");
    body.push(
      this.theme.fg(
        "dim",
        " ↑↓ select · enter transcript · m model · e effort · x terminate · esc close",
      ),
    );
    return frameLines(this.theme, "Subagents", body, width);
  }
}

export class AgentDetailDialog implements Component {
  private scrollOffset = 0;
  private timer: ReturnType<typeof setInterval>;
  private transcriptCache:
    | {
        width: number;
        length: number;
        first: ManagedSubagent["transcript"][number] | undefined;
        last: ManagedSubagent["transcript"][number] | undefined;
        streamingText: string;
        lines: string[];
      }
    | undefined;

  constructor(
    private readonly agent: ManagedSubagent,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (result: ManagerDialogResult) => void,
  ) {
    this.timer = setInterval(() => tui.requestRender(), 300);
  }

  dispose(): void {
    clearInterval(this.timer);
  }
  invalidate(): void {
    this.transcriptCache = undefined;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel") || data === "b") {
      this.done({ action: "back" });
      return;
    }
    if (
      this.keybindings.matches(data, "tui.select.up") ||
      this.keybindings.matches(data, "tui.select.pageUp")
    ) {
      this.scrollOffset += this.keybindings.matches(data, "tui.select.pageUp")
        ? DETAIL_VIEW_LINES
        : 1;
      this.tui.requestRender();
      return;
    }
    if (
      this.keybindings.matches(data, "tui.select.down") ||
      this.keybindings.matches(data, "tui.select.pageDown")
    ) {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset -
          (this.keybindings.matches(data, "tui.select.pageDown")
            ? DETAIL_VIEW_LINES
            : 1),
      );
      this.tui.requestRender();
      return;
    }
    if (data === "m") {
      this.done({ action: "model", id: this.agent.id });
      return;
    }
    if (data === "e") {
      this.done({ action: "effort", id: this.agent.id });
      return;
    }
    if (data === "u") {
      this.done({ action: "urgent", id: this.agent.id });
      return;
    }
    if (data === "q") {
      this.done({ action: "queue", id: this.agent.id });
      return;
    }
    if (data === "x") {
      this.done({ action: "terminate", id: this.agent.id });
      return;
    }
  }

  private transcriptLines(width: number): string[] {
    const length = this.agent.transcript.length;
    const first = this.agent.transcript[0];
    const last = this.agent.transcript.at(-1);
    const streamingText = this.agent.streamingText;
    const cached = this.transcriptCache;
    if (
      cached &&
      cached.width === width &&
      cached.length === length &&
      cached.first === first &&
      cached.last === last &&
      cached.streamingText === streamingText
    )
      return cached.lines;

    const lines: string[] = [];
    for (const item of this.agent.transcript) {
      lines.push(
        this.theme.fg("muted", `[${formatClock(item.timestamp)}] ${item.role}`),
      );
      const roleColor =
        item.role === "assistant"
          ? "text"
          : item.role === "toolResult"
            ? "dim"
            : "accent";
      for (const line of wrapTextWithAnsi(
        this.theme.fg(roleColor, item.text),
        Math.max(1, width),
      ))
        lines.push(line);
      lines.push("");
    }
    if (streamingText) {
      lines.push(this.theme.fg("warning", "[streaming] assistant"));
      for (const line of wrapTextWithAnsi(streamingText, Math.max(1, width)))
        lines.push(line);
    }
    if (lines.length === 0)
      lines.push(this.theme.fg("muted", "(transcript is empty)"));
    this.transcriptCache = { width, length, first, last, streamingText, lines };
    return lines;
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    const allLines = this.transcriptLines(inner);
    const maxOffset = Math.max(0, allLines.length - DETAIL_VIEW_LINES);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
    const end = Math.max(0, allLines.length - this.scrollOffset);
    const start = Math.max(0, end - DETAIL_VIEW_LINES);
    const visible = allLines.slice(start, end);
    const status = this.theme.fg(
      statusColor(this.agent.status),
      `${statusIcon(this.agent.status)} ${this.agent.status}`,
    );
    const body = [
      ` ${status} · ${this.agent.model} · effort ${this.agent.effort} · ${formatDuration(Date.now() - this.agent.createdAt)}`,
      this.theme.fg(
        "dim",
        ` Task: ${truncateChars(this.agent.prompt.replace(/\s+/g, " "), 180)}`,
      ),
      this.theme.fg(
        "dim",
        ` Usage: ↑${formatTokens(this.agent.usage.input)} ↓${formatTokens(this.agent.usage.output)}${this.agent.usage.cost.total ? ` $${this.agent.usage.cost.total.toFixed(4)}` : ""}`,
      ),
      this.theme.fg("borderMuted", ` ${"─".repeat(Math.max(0, inner - 1))}`),
      ...visible.map((line) => ` ${line}`),
      this.theme.fg("borderMuted", ` ${"─".repeat(Math.max(0, inner - 1))}`),
      this.theme.fg(
        "dim",
        ` ↑↓/pg scroll${this.scrollOffset ? ` · ${this.scrollOffset} lines below` : ""} · m model · e effort · u steer · q queue · x terminate · b back`,
      ),
    ];
    return frameLines(this.theme, this.agent.id, body, width);
  }
}

async function selectOverlay(
  ctx: ExtensionContext,
  title: string,
  items: SelectItem[],
): Promise<string | undefined> {
  if (ctx.mode !== "tui") return undefined;
  return ctx.ui.custom<string | undefined>(
    (tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(
        new DynamicBorder((text: string) => theme.fg("accent", text)),
      );
      container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
      const list = new SelectList(
        items,
        Math.min(12, Math.max(1, items.length)),
        {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        },
      );
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(undefined);
      container.addChild(list);
      container.addChild(
        new Text(
          theme.fg("dim", "↑↓ navigate · enter select · esc cancel"),
          1,
          0,
        ),
      );
      container.addChild(
        new DynamicBorder((text: string) => theme.fg("accent", text)),
      );
      return {
        render: (width) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "70%",
        maxHeight: "80%",
        minWidth: 48,
      },
    },
  );
}

export async function showManager(
  manager: SubagentManager,
  ctx: ExtensionContext,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      "The subagent manager is only available in TUI mode",
      "warning",
    );
    return;
  }

  let detailId: string | undefined;
  while (true) {
    let result: ManagerDialogResult;
    const fromDetail = Boolean(detailId && manager.agents.has(detailId));
    if (fromDetail && detailId) {
      const agent = manager.getAgent(detailId);
      result = await ctx.ui.custom<ManagerDialogResult>(
        (tui, theme, keybindings, done) =>
          new AgentDetailDialog(agent, tui, theme, keybindings, done),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "85%",
            maxHeight: "90%",
            minWidth: 56,
          },
        },
      );
    } else {
      detailId = undefined;
      result = await ctx.ui.custom<ManagerDialogResult>(
        (tui, theme, keybindings, done) =>
          new AgentListDialog(manager, tui, theme, keybindings, done),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "85%",
            maxHeight: "85%",
            minWidth: 56,
          },
        },
      );
    }

    if (!result || result.action === "close") return;
    if (result.action === "back") {
      detailId = undefined;
      continue;
    }
    if (result.action === "view") {
      detailId = result.id;
      continue;
    }

    detailId = fromDetail ? result.id : undefined;
    try {
      if (result.action === "model") {
        const models = await manager.availableModels(ctx);
        const selected = await selectOverlay(
          ctx,
          `Model for ${result.id}`,
          models.map((model) => ({
            value: modelName(model),
            label: model.id,
            description: `${model.provider} · ${model.name}`,
          })),
        );
        if (selected)
          await manager.configure(ctx, result.id, { model: selected });
      } else if (result.action === "effort") {
        const selected = await selectOverlay(
          ctx,
          `Effort for ${result.id}`,
          THINKING_LEVELS.map((level) => ({ value: level, label: level })),
        );
        if (selected)
          await manager.configure(ctx, result.id, {
            effort: selected as SubagentEffort,
          });
      } else if (result.action === "urgent" || result.action === "queue") {
        const message = await ctx.ui.input(
          result.action === "urgent"
            ? `Steer ${result.id}`
            : `Queue for ${result.id}`,
          "Instruction for the subagent",
        );
        if (message)
          await manager.send(
            result.id,
            message,
            result.action === "urgent" ? "urgent" : "normal",
          );
      } else if (result.action === "terminate") {
        const confirmed = await ctx.ui.confirm(
          "Terminate subagent?",
          `Stop ${result.id} and release its resources?`,
        );
        if (confirmed) await manager.terminate(result.id);
      }
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  }
}
