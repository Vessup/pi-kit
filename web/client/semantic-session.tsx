import * as React from "react";
import { createPortal } from "react-dom";
import { closestCenter, DndContext, DragOverlay, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleGauge,
  ChevronRight,
  FilePenLine,
  FileText,
  FileUp,
  GripVertical,
  LoaderCircle,
  Paperclip,
  Search,
  Send,
  Square,
  TerminalSquare,
  Wrench,
  X,
  Pencil,
  Trash2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { diffArrays, diffWords } from "diff";
import hljs from "highlight.js/lib/core";
import bashLanguage from "highlight.js/lib/languages/bash";
import cssLanguage from "highlight.js/lib/languages/css";
import goLanguage from "highlight.js/lib/languages/go";
import javaLanguage from "highlight.js/lib/languages/java";
import javascriptLanguage from "highlight.js/lib/languages/javascript";
import jsonLanguage from "highlight.js/lib/languages/json";
import kotlinLanguage from "highlight.js/lib/languages/kotlin";
import markdownLanguage from "highlight.js/lib/languages/markdown";
import pythonLanguage from "highlight.js/lib/languages/python";
import rubyLanguage from "highlight.js/lib/languages/ruby";
import rustLanguage from "highlight.js/lib/languages/rust";
import scssLanguage from "highlight.js/lib/languages/scss";
import swiftLanguage from "highlight.js/lib/languages/swift";
import typescriptLanguage from "highlight.js/lib/languages/typescript";
import xmlLanguage from "highlight.js/lib/languages/xml";
import yamlLanguage from "highlight.js/lib/languages/yaml";
import "highlight.js/styles/github-dark.css";

hljs.registerLanguage("bash", bashLanguage);
hljs.registerLanguage("css", cssLanguage);
hljs.registerLanguage("go", goLanguage);
hljs.registerLanguage("java", javaLanguage);
hljs.registerLanguage("javascript", javascriptLanguage);
hljs.registerLanguage("json", jsonLanguage);
hljs.registerLanguage("kotlin", kotlinLanguage);
hljs.registerLanguage("markdown", markdownLanguage);
hljs.registerLanguage("python", pythonLanguage);
hljs.registerLanguage("ruby", rubyLanguage);
hljs.registerLanguage("rust", rustLanguage);
hljs.registerLanguage("scss", scssLanguage);
hljs.registerLanguage("swift", swiftLanguage);
hljs.registerLanguage("typescript", typescriptLanguage);
hljs.registerLanguage("xml", xmlLanguage);
hljs.registerLanguage("yaml", yamlLanguage);
import { Button } from "./components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import { AnchoredPopover } from "./components/anchored-popover";
import { resolveScrollFollow } from "./scroll-follow";
import { totalSubagentUsage } from "./usage";
import { cn } from "./lib/utils";
import { moveWebQueuedMessage, type SemanticImage, type WebQueuedMessage, type WebQueueReplacement, type WebSession, type WebSessionOptions, type WebSlashCommand, type WebSubagent, type WebUsage } from "../protocol";

export type SemanticEntry = {
  id?: string;
  type?: string;
  timestamp?: string;
  message?: Record<string, unknown>;
};

export type ActiveTool = {
  id: string;
  name: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  running: boolean;
};

type ToolResultView = { output: string; isError: boolean; details?: unknown };
type MessageView = { message: Record<string, unknown>; key: string; endedAt?: number };

function lastAssistantMessageIndex(messages: MessageView[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.message.role === "assistant") return index;
  }
  return -1;
}

type SemanticSessionProps = {
  session: WebSession | null;
  entries: SemanticEntry[];
  streamingMessage: Record<string, unknown> | null;
  tools: ActiveTool[];
  error: string | null;
  connected: boolean;
  transcriptLoading: boolean;
  queuedMessages: WebQueuedMessage[];
  sessionOptions: WebSessionOptions;
  onSelectModel: (provider: string, modelId: string) => Promise<void>;
  onSelectThinkingLevel: (level: string) => Promise<void>;
  onSend: (message: string, images: SemanticImage[], behavior?: "steer" | "followUp") => Promise<void>;
  onReplaceQueue: (queue: WebQueueReplacement[]) => Promise<void>;
  onReconcileQueue: (itemId: string, action: "discard" | "resubmit") => Promise<void>;
  onAbort: () => Promise<void>;
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SESSION_DRAFT_PREFIX = "pi-web-session-draft-v1:";

function draftStorageKey(sessionId: string): string {
  return `${SESSION_DRAFT_PREFIX}${encodeURIComponent(sessionId)}`;
}

function fuzzyCommandScore(name: string, query: string): number | null {
  const candidate = name.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  if (!needle) return 0;
  if (candidate.startsWith(needle)) return candidate.length - needle.length;
  let cursor = 0;
  let gaps = 0;
  for (const char of needle) {
    const next = candidate.indexOf(char, cursor);
    if (next < 0) return null;
    gaps += next - cursor;
    cursor = next + 1;
  }
  return 100 + gaps + candidate.length - needle.length;
}

export function filterSlashCommands(commands: readonly WebSlashCommand[], query: string): WebSlashCommand[] {
  return commands
    .flatMap((command) => {
      const score = fuzzyCommandScore(command.name, query);
      return score === null ? [] : [{ command, score }];
    })
    .sort((a, b) => a.score - b.score || a.command.name.localeCompare(b.command.name))
    .map(({ command }) => command);
}

function loadSessionDraft(sessionId: string | undefined): string {
  if (!sessionId) return "";
  try { return localStorage.getItem(draftStorageKey(sessionId)) ?? ""; } catch { return ""; }
}

function saveSessionDraft(sessionId: string, draft: string): void {
  try {
    if (draft) localStorage.setItem(draftStorageKey(sessionId), draft);
    else localStorage.removeItem(draftStorageKey(sessionId));
  } catch {
    // Draft persistence is best-effort when storage is unavailable or full.
  }
}

function fileAsImage(file: File): Promise<SemanticImage> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) return reject(new Error("Only image attachments are supported"));
    if (file.size > MAX_IMAGE_BYTES) return reject(new Error("Image exceeds the 10 MB limit"));
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) reject(new Error("Could not encode image"));
      else resolve({ type: "image", mimeType: file.type || "image/png", data: result.slice(comma + 1), name: file.name || undefined });
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
    reader.readAsDataURL(file);
  });
}

function contentParts(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = message.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter((part): part is Record<string, unknown> => !!part && typeof part === "object") : [];
}

function textFromResult(value: unknown): string {
  if (!value || typeof value !== "object") return typeof value === "string" ? value : "";
  const record = value as Record<string, unknown>;
  const content = record.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is Record<string, unknown> => !!part && typeof part === "object")
    .map((part) => part.type === "text" && typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

function toolResultView(value: unknown, isError = false): ToolResultView {
  const record = asRecord(value);
  return { output: textFromResult(value), isError, details: record.details };
}

const Markdown = React.memo(function Markdown({ children, preserveSoftBreaks = false }: { children: string; preserveSoftBreaks?: boolean }) {
  return (
    <div className="semantic-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={preserveSoftBreaks ? { p: ({ children: paragraph }) => <p className="semantic-preserve-breaks">{paragraph}</p> } : undefined}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});

function thinkingLines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim().replace(/^[-*+]\s+/, "").replace(/^#{1,6}\s+/, "").replace(/\*\*/g, "").replace(/__/g, ""))
    .filter(Boolean);
}

function displayContentParts(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const display: Array<Record<string, unknown>> = [];
  for (const part of contentParts(message)) {
    const previous = display.at(-1);
    if (part.type === "thinking" && typeof part.thinking === "string" && previous?.type === "thinking") {
      previous.thinking = `${String(previous.thinking ?? "")}\n${part.thinking}`;
    } else {
      display.push({ ...part });
    }
  }
  return display;
}

function messageDate(value: unknown): Date | null {
  const timestamp = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function formatMessageTime(value: unknown): string | null {
  const date = messageDate(value);
  return date ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date) : null;
}

function formatFullTimestamp(value: unknown): string | null {
  const date = messageDate(value);
  return date ? new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" }).format(date) : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function shortened(value: string, max = 180): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function parseJsonDocuments(text: string): unknown[] | null {
  const source = text.trim();
  if (!source || source.length > 100_000) return null;
  try { return [JSON.parse(source)]; } catch { /* Multiple JSON documents may follow. */ }
  const documents: unknown[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (start < 0) {
      if (/\s/.test(char)) continue;
      if (char !== "{" && char !== "[") return null;
      start = index;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try { documents.push(JSON.parse(source.slice(start, index + 1))); } catch { return null; }
        start = -1;
      }
    }
  }
  return documents.length > 0 && start < 0 ? documents : null;
}

function DataValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null) return <span className="semantic-data-empty">none</span>;
  if (typeof value === "boolean") return <span className={cn("semantic-data-bool", value ? "is-true" : "is-false")}>{value ? "Yes" : "No"}</span>;
  if (typeof value === "number") return <span className="semantic-data-number">{value.toLocaleString()}</span>;
  if (typeof value === "string") {
    if (/^https?:\/\//.test(value)) return <a href={value} target="_blank" rel="noreferrer">{value}</a>;
    return <span>{value}</span>;
  }
  if (depth >= 4) return <code>{JSON.stringify(value)}</code>;
  if (Array.isArray(value)) {
    return <div className="semantic-data-list">{value.map((item, index) => <DataValue key={index} value={item} depth={depth + 1} />)}</div>;
  }
  return (
    <dl className="semantic-data-grid">
      {Object.entries(asRecord(value)).map(([key, item]) => (
        <React.Fragment key={key}><dt>{key.replace(/([a-z])([A-Z])/g, "$1 $2")}</dt><dd><DataValue value={item} depth={depth + 1} /></dd></React.Fragment>
      ))}
    </dl>
  );
}

function HighlightedCode({ text, language }: { text: string; language?: string }) {
  return <pre className="semantic-highlighted-code"><code className={language ? `language-${language}` : undefined} dangerouslySetInnerHTML={{ __html: highlightedHtml(text, language) }} /></pre>;
}

function FormattedOutput({ text, toolName, args }: { text: string; toolName: string; args?: Record<string, unknown> }) {
  if (toolName === "read") return text ? <HighlightedCode text={text} language={syntaxLanguage(String(args?.path ?? ""))} /> : null;
  if (toolName.startsWith("subagent_")) return text ? <Markdown preserveSoftBreaks>{text}</Markdown> : null;
  const documents = parseJsonDocuments(text);
  if (documents) return <div className="semantic-data-documents">{documents.map((document, index) => <DataValue key={index} value={document} />)}</div>;
  const success = /^(successfully|wrote |created |updated |deleted |resolved )/i.test(text.trim());
  if (success && ["edit", "write", "staff", "staff-comment"].some((name) => toolName.includes(name))) {
    return <div className="semantic-tool-success"><CheckCircle2 className="h-4 w-4" /> {text.trim()}</div>;
  }
  return text ? <pre className={cn(toolName === "bash" && "semantic-terminal-output")}>{text}</pre> : null;
}

function formatTokenCount(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function usageSummary(usage: WebUsage | undefined): string | null {
  if (!usage) return null;
  // Subagent totals and rows use exact values so the visible numbers can be
  // added directly; compact rounding made correct aggregates look mismatched.
  return `${Math.round(usage.totalTokens).toLocaleString("en-US")} tokens${usage.cost.total ? ` · $${usage.cost.total.toFixed(4)}` : ""}`;
}

function combinedUsage(primary: WebUsage | undefined, live: WebUsage | undefined): WebUsage | undefined {
  if (!primary && !live) return undefined;
  const a = primary ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const b = live ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

function TokenDetails({ session }: { session: WebSession }) {
  const usage = combinedUsage(session.usage, session.subagentUsage);
  const context = session.contextUsage;
  return (
    <div className="semantic-token-details">
      <span>Input <strong>{formatTokenCount(usage?.input ?? 0)}</strong></span>
      <span>Output <strong>{formatTokenCount(usage?.output ?? 0)}</strong></span>
      {(usage?.cacheRead ?? 0) > 0 && <span>Cache read <strong>{formatTokenCount(usage!.cacheRead)}</strong></span>}
      {(usage?.cacheWrite ?? 0) > 0 && <span>Cache write <strong>{formatTokenCount(usage!.cacheWrite)}</strong></span>}
      <span>Cost <strong>${(usage?.cost.total ?? 0).toFixed(3)}</strong></span>
      {context?.contextWindow ? <span>Context <strong>{context.percent == null ? "?" : `${context.percent.toFixed(1)}%`} / {formatTokenCount(context.contextWindow)}</strong></span> : <span>Context <strong>unknown</strong></span>}
    </div>
  );
}

function CompactionStatus({ session }: { session: WebSession }) {
  const compaction = session.compaction;
  if (!compaction) return null;
  const title = compaction.reason === "overflow"
    ? "Context overflow — compacting before retry…"
    : compaction.reason === "threshold"
      ? "Context limit reached — compacting…"
      : "Compacting context…";
  return (
    <div className="semantic-compaction-status" role="status" aria-live="polite">
      <LoaderCircle className="h-4 w-4 animate-spin" />
      <div><strong>{title}</strong><small>Summarizing older messages to free context. This may take a moment.</small></div>
    </div>
  );
}

function sameTokenTelemetry(a: WebSession | null, b: WebSession | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.id !== b.id) return false;
  const values = (session: WebSession) => {
    const usage = combinedUsage(session.usage, session.subagentUsage);
    return [
      usage?.input ?? 0,
      usage?.output ?? 0,
      usage?.cacheRead ?? 0,
      usage?.cacheWrite ?? 0,
      usage?.cost.total ?? 0,
      session.contextUsage?.percent ?? null,
      session.contextUsage?.contextWindow ?? 0,
    ];
  };
  const left = values(a);
  const right = values(b);
  return left.every((value, index) => value === right[index]);
}

const ComposerTokenInfo = React.memo(function ComposerTokenInfo({ session }: { session: WebSession | null }) {
  const [open, setOpen] = React.useState(false);
  if (!session) return null;
  const usage = combinedUsage(session.usage, session.subagentUsage);
  const context = session.contextUsage;
  // Keep a fixed set of fields mounted. Conditional fields made the toolbar
  // collapse and expand while partial metrics snapshots arrived.
  const compact = [
    `↑${formatTokenCount(usage?.input ?? 0)}`,
    `↓${formatTokenCount(usage?.output ?? 0)}`,
    `R${formatTokenCount(usage?.cacheRead ?? 0)}`,
    `W${formatTokenCount(usage?.cacheWrite ?? 0)}`,
    `$${(usage?.cost.total ?? 0).toFixed(3)}`,
    context?.contextWindow ? `${context.percent == null ? "?" : `${context.percent.toFixed(1)}%`}/${formatTokenCount(context.contextWindow)}` : "?/?",
  ].join(" ");
  return (
    <>
      <span className="semantic-token-inline">{compact}</span>
      <span className="semantic-token-mobile">
        <TooltipProvider>
          <Tooltip open={open} onOpenChange={setOpen}>
            <TooltipTrigger asChild>
              <button type="button" aria-label="Token usage" onClick={() => setOpen((value) => !value)}><CircleGauge className="h-4 w-4" /></button>
            </TooltipTrigger>
            <TooltipContent side="top"><TokenDetails session={session} /></TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </span>
    </>
  );
}, (previous, next) => sameTokenTelemetry(previous.session, next.session));

function SubagentRows({ agents, onSelect }: { agents: WebSubagent[]; onSelect?: (agent: WebSubagent) => void }) {
  if (agents.length === 0) return null;
  return (
    <div className="semantic-subagent-list">
      {agents.map((agent) => (
        <div key={agent.id} className="semantic-subagent-row">
          <span className={cn("semantic-subagent-status", `is-${agent.status}`)} aria-label={agent.status} />
          <div className="semantic-subagent-main">
            {onSelect ? <button type="button" onClick={() => onSelect(agent)}>{agent.id}</button> : <strong>{agent.id}</strong>}
            <small>{agent.model} · {agent.effort} · {agent.turns} turn{agent.turns === 1 ? "" : "s"}</small>
          </div>
          <div className="semantic-subagent-activity">
            {agent.currentTool && <span className="semantic-subagent-tool">{agent.currentTool}</span>}
            {agent.queued > 0 && <span>{agent.queued} queued</span>}
            <span className="capitalize">{agent.status}</span>
            {usageSummary(agent.usage) && <span>{usageSummary(agent.usage)}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function SubagentOutputDialog({ agent, onOpenChange }: { agent: WebSubagent | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={agent !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader className="relative pr-16">
          <DialogTitle>{agent?.id ?? "Subagent"}</DialogTitle>
          <DialogDescription>{agent ? `${agent.status} · ${agent.model} · ${agent.effort} · ${agent.turns} turn${agent.turns === 1 ? "" : "s"}` : ""}</DialogDescription>
          <DialogClose className="absolute right-3 top-3 h-8 w-8 p-0" />
        </DialogHeader>
        <DialogBody className="semantic-subagent-dialog-body">
          {agent?.error && <div className="semantic-subagent-error">{agent.error}</div>}
          {agent && (agent.transcript?.length ?? 0) === 0 && !agent.streamingText && <p className="text-sm text-zinc-500">No output yet.</p>}
          {agent?.transcript?.map((item, index) => (
            <section key={`${item.timestamp}:${index}`} className="semantic-subagent-transcript-item">
              <header><span>{item.role}</span><time title={formatFullTimestamp(item.timestamp) ?? undefined}>{formatMessageTime(item.timestamp)}</time></header>
              <pre>{item.text}</pre>
            </section>
          ))}
          {agent?.streamingText && (
            <section className="semantic-subagent-transcript-item is-streaming">
              <header><span>assistant</span><span className="semantic-streaming-dot" /></header>
              <pre>{agent.streamingText}</pre>
            </section>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function subagentsFromDetails(details: unknown): WebSubagent[] {
  const agents = asRecord(details).agents;
  if (!Array.isArray(agents)) return [];
  return agents.flatMap((value) => {
    const item = asRecord(value);
    if (typeof item.id !== "string" || typeof item.status !== "string") return [];
    return [{
      id: item.id,
      status: item.status as WebSubagent["status"],
      model: typeof item.model === "string" ? item.model : "unknown model",
      effort: typeof item.effort === "string" ? item.effort : "off",
      turns: typeof item.turns === "number" ? item.turns : 0,
      currentTool: typeof item.currentTool === "string" ? item.currentTool : undefined,
      queued: typeof item.queued === "number" ? item.queued : 0,
      createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
      updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
      completedAt: typeof item.completedAt === "number" ? item.completedAt : undefined,
      error: typeof item.error === "string" ? item.error : undefined,
      usage: item.usage && typeof item.usage === "object" ? asRecord(item.usage) as WebUsage : undefined,
      transcript: Array.isArray(item.transcript) ? item.transcript.flatMap((entry) => {
        const transcript = asRecord(entry);
        return typeof transcript.timestamp === "number" && typeof transcript.role === "string" && typeof transcript.text === "string"
          ? [{ timestamp: transcript.timestamp, role: transcript.role, text: transcript.text }]
          : [];
      }) : undefined,
      streamingText: typeof item.streamingText === "string" ? item.streamingText : undefined,
    }];
  });
}

function toolPresentation(name: string, args: Record<string, unknown>) {
  if (name === "bash") return { icon: TerminalSquare, verb: "Run", subject: shortened(String(args.command ?? "command")), detail: args.cwd ? String(args.cwd) : undefined };
  if (name === "read") {
    const range = args.offset ? `lines ${args.offset}${args.limit ? `–${Number(args.offset) + Number(args.limit) - 1}` : ""}` : undefined;
    return { icon: FileText, verb: "Read", subject: String(args.path ?? "file"), detail: range };
  }
  if (name === "write") return { icon: FileUp, verb: "Write", subject: String(args.path ?? "file"), detail: typeof args.content === "string" ? `${args.content.split("\n").length} lines` : undefined };
  if (name === "edit") return { icon: FilePenLine, verb: "Edit", subject: String(args.path ?? "file"), detail: Array.isArray(args.edits) ? `${args.edits.length} change${args.edits.length === 1 ? "" : "s"}` : undefined };
  if (name === "grep" || name === "find" || name === "search") return { icon: Search, verb: "Search", subject: String(args.pattern ?? args.query ?? args.path ?? name) };
  if (name.startsWith("subagent_")) return { icon: Bot, verb: name.replace("subagent_", "").replaceAll("_", " "), subject: String(args.name ?? args.id ?? "subagent") };
  return { icon: Wrench, verb: name.replaceAll("_", " "), subject: "" };
}

type DiffRow = {
  kind: "context" | "removed" | "added" | "skip";
  oldLine?: number;
  newLine?: number;
  text: string;
  pairedText?: string;
};

function editDiffRows(oldText: string, newText: string, context = 3): DiffRow[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const changes = diffArrays(oldLines, newLines);
  const all: DiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    const lines = change.value;
    if (change.removed && changes[index + 1]?.added) {
      const added = changes[index + 1];
      // Match Pi TUI: inline highlighting is only meaningful for a one-line
      // replacement. Multi-line blocks keep line highlighting without guessing
      // which lines correspond to each other.
      const paired = lines.length === 1 && added.value.length === 1;
      for (const line of lines) all.push({ kind: "removed", oldLine: oldLine++, text: line, pairedText: paired ? added.value[0] : undefined });
      for (const line of added.value) all.push({ kind: "added", newLine: newLine++, text: line, pairedText: paired ? lines[0] : undefined });
      index += 1;
    } else if (change.removed) {
      for (const line of lines) all.push({ kind: "removed", oldLine: oldLine++, text: line });
    } else if (change.added) {
      for (const line of lines) all.push({ kind: "added", newLine: newLine++, text: line });
    } else {
      for (const line of lines) all.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: line });
    }
  }
  const visible = new Set<number>();
  all.forEach((row, index) => {
    if (row.kind === "context") return;
    for (let cursor = Math.max(0, index - context); cursor <= Math.min(all.length - 1, index + context); cursor += 1) visible.add(cursor);
  });
  const rows: DiffRow[] = [];
  let skipped = false;
  all.forEach((row, index) => {
    if (visible.has(index) || row.kind !== "context") {
      skipped = false;
      rows.push(row);
    } else if (!skipped) {
      skipped = true;
      rows.push({ kind: "skip", text: "…" });
    }
  });
  return rows;
}

function syntaxLanguage(path: string): string | undefined {
  const extension = path.split(".").pop()?.toLowerCase();
  return ({
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json", css: "css", scss: "scss", html: "xml", htm: "xml", xml: "xml", svg: "xml",
    sh: "bash", bash: "bash", zsh: "bash", py: "python", rb: "ruby", go: "go", rs: "rust",
    java: "java", kt: "kotlin", swift: "swift", yaml: "yaml", yml: "yaml", md: "markdown",
  } as Record<string, string>)[extension ?? ""];
}

function highlightedHtml(value: string, language?: string): string {
  if (!value || !language || !hljs.getLanguage(language)) return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return hljs.highlight(value, { language, ignoreIllegals: true }).value;
}

function ChangedLine({ row, language }: { row: DiffRow; language?: string }) {
  if (row.kind === "skip") return <div className="semantic-diff-row semantic-diff-skip"><span /><span /><code>…</code></div>;
  // Always compare old → new. A removed row stores old text in `text` and new
  // text in `pairedText`; an added row stores those fields in the opposite
  // order. Reversing this direction marks common words as removed.
  const oldText = row.kind === "removed" ? row.text : row.pairedText;
  const newText = row.kind === "added" ? row.text : row.pairedText;
  const pieces: Array<{ value: string; added?: boolean; removed?: boolean }> =
    oldText === undefined || newText === undefined ? [{ value: row.text }] : diffWords(oldText, newText);
  return (
    <div className={cn("semantic-diff-row", `semantic-diff-${row.kind}`)}>
      <span className="semantic-diff-sign">{row.kind === "removed" ? "−" : row.kind === "added" ? "+" : ""}</span>
      <span className="semantic-diff-number">{row.kind === "removed" ? row.oldLine : row.newLine}</span>
      <code>{pieces.map((piece, index) => {
        const highlighted = row.kind === "added" ? piece.added : row.kind === "removed" ? piece.removed : false;
        const hidden = row.kind === "added" ? piece.removed : row.kind === "removed" ? piece.added : false;
        return hidden ? null : <mark key={index} className={highlighted ? "semantic-diff-changed" : undefined} dangerouslySetInnerHTML={{ __html: highlightedHtml(piece.value, language) }} />;
      })}</code>
    </div>
  );
}

function EditDiff({ oldText, newText, language }: { oldText: string; newText: string; language?: string }) {
  return <div className="semantic-edit-diff">{editDiffRows(oldText, newText).map((row, index) => <ChangedLine key={index} row={row} language={language} />)}</div>;
}

function ArgumentDetails({ name, args }: { name: string; args: Record<string, unknown> }) {
  if (name === "bash") return <pre className="semantic-command"><span>$</span> {String(args.command ?? "")}</pre>;
  if (name === "write" && typeof args.content === "string") {
    return <HighlightedCode text={args.content} language={syntaxLanguage(String(args.path ?? ""))} />;
  }
  if (name === "edit" && Array.isArray(args.edits)) {
    const language = syntaxLanguage(String(args.path ?? ""));
    return <div className="semantic-edits">{args.edits.map((edit, index) => {
      const item = asRecord(edit);
      return <EditDiff key={index} oldText={String(item.oldText ?? "")} newText={String(item.newText ?? "")} language={language} />;
    })}</div>;
  }
  const hidden = new Set(["path", "command", "content", "edits", "name", "id"]);
  const rest = Object.fromEntries(Object.entries(args).filter(([key]) => !hidden.has(key)));
  return Object.keys(rest).length > 0 ? <DataValue value={rest} /> : null;
}

function ToolCallCard({
  name,
  args: input,
  running = false,
  result,
  expansionKey,
  expanded,
  onExpansionChange,
}: {
  name: string;
  args: unknown;
  running?: boolean;
  result?: ToolResultView;
  expansionKey: string;
  expanded: boolean;
  onExpansionChange: (key: string, open: boolean, manual?: boolean) => void;
}) {
  const args = asRecord(input);
  const presentation = toolPresentation(name, args);
  const Icon = running ? presentation.icon : result && !result.isError ? CheckCircle2 : result?.isError ? X : presentation.icon;
  const subagents = name.startsWith("subagent_") ? subagentsFromDetails(result?.details) : [];
  return (
    <details
      className={cn("semantic-tool-call", result?.isError && "border-red-500/35")}
      open={expanded}
    >
      <summary onClick={(event) => { event.preventDefault(); onExpansionChange(expansionKey, !expanded, true); }}>
        <Icon className={cn("semantic-tool-icon h-4 w-4", running && "animate-pulse text-sky-400", !running && result && !result.isError && "text-emerald-400", !running && result?.isError && "text-red-300")} />
        <span className="semantic-tool-verb">{presentation.verb}</span>
        {presentation.subject && <span className="semantic-tool-subject">{presentation.subject}</span>}
        <span className="semantic-tool-spacer" />
        {presentation.detail && <span className="semantic-tool-detail">{presentation.detail}</span>}
        <ChevronRight className="semantic-tool-chevron h-4 w-4" />
      </summary>
      {expanded && <ArgumentDetails name={name} args={args} />}
      {subagents.length > 0 && <SubagentRows agents={subagents} />}
      {result && (result.isError || (name !== "edit" && name !== "write")) && <FormattedOutput text={result.output} toolName={name} args={args} />}
    </details>
  );
}

const MessageCard = React.memo(function MessageCard({
  message,
  streaming = false,
  active = false,
  messageKey,
  expandedItems,
  onExpansionChange,
  toolResults,
  runningToolIds,
  endedAt,
}: {
  message: Record<string, unknown>;
  streaming?: boolean;
  active?: boolean;
  messageKey: string;
  expandedItems: ReadonlySet<string>;
  onExpansionChange: (key: string, open: boolean, manual?: boolean) => void;
  toolResults: ReadonlyMap<string, ToolResultView>;
  runningToolIds: ReadonlySet<string>;
  endedAt?: number;
}) {
  const role = typeof message.role === "string" ? message.role : "assistant";
  const parts = displayContentParts(message);
  const messageTime = formatMessageTime(message.timestamp);
  const fullTimestamp = formatFullTimestamp(message.timestamp);
  if (role === "toolResult") return null;
  if (role === "bashExecution") {
    const expansionKey = `bash:${messageKey}`;
    return (
      <details className="semantic-tool" open={expandedItems.has(expansionKey)}>
        <summary onClick={(event) => { event.preventDefault(); onExpansionChange(expansionKey, !expandedItems.has(expansionKey), true); }}><Wrench className="h-4 w-4" /><span className="semantic-tool-verb">bash</span><span className="semantic-tool-spacer" /><ChevronRight className="semantic-tool-chevron h-4 w-4" /></summary>
        <pre>{String(message.output ?? "")}</pre>
      </details>
    );
  }
  return (
    <article className={cn("semantic-message-group", role === "user" && "semantic-message-group-user")}>
      <header><span>{role === "user" ? "You" : "Pi"}</span>{messageTime && <time className="semantic-message-time" dateTime={messageDate(message.timestamp)?.toISOString()} title={fullTimestamp ?? undefined} aria-label={fullTimestamp ?? undefined}>{messageTime}</time>}{active && <span className="semantic-streaming-dot" />}</header>
      <div className={cn("semantic-message", role === "user" ? "semantic-message-user" : "semantic-message-assistant")}>
        <div className="space-y-3">
        {parts.map((part, index) => {
          if (part.type === "text" && typeof part.text === "string") return <Markdown key={index}>{part.text}</Markdown>;
          if (part.type === "thinking" && typeof part.thinking === "string") {
            return <div key={index} className="semantic-thinking-flat">{thinkingLines(part.thinking).map((line, lineIndex) => <span key={lineIndex}>{line}</span>)}</div>;
          }
          if (part.type === "toolCall") {
            const callId = String(part.id ?? `${messageKey}:${index}`);
            const expansionKey = `call:${callId}`;
            return <ToolCallCard key={index} name={String(part.name ?? "tool")} args={part.arguments} running={runningToolIds.has(callId)} result={toolResults.get(callId)} expansionKey={expansionKey} expanded={expandedItems.has(expansionKey)} onExpansionChange={onExpansionChange} />;
          }
          if (part.type === "image" && typeof part.data === "string") {
            return <img key={index} className="max-h-80 rounded-xl border border-zinc-700" src={`data:${String(part.mimeType ?? "image/png")};base64,${part.data}`} alt="Attachment" />;
          }
          return null;
        })}
        </div>
      </div>
    </article>
  );
});

export function updateStreamingMessage(
  current: Record<string, unknown> | null,
  delta: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = current ? { ...current } : { role: "assistant", content: [] };
  const content = Array.isArray(next.content)
    ? next.content.map((part) => part && typeof part === "object" ? { ...(part as Record<string, unknown>) } : part)
    : [];
  const index = typeof delta.contentIndex === "number" ? delta.contentIndex : content.length;
  const existing = content[index] && typeof content[index] === "object" ? content[index] as Record<string, unknown> : undefined;
  switch (delta.type) {
    case "text_start": content[index] = { type: "text", text: "" }; break;
    case "text_delta": content[index] = { type: "text", text: `${existing?.text ?? ""}${String(delta.delta ?? "")}` }; break;
    case "text_end": content[index] = { type: "text", text: String(delta.content ?? existing?.text ?? "") }; break;
    case "thinking_start": content[index] = { type: "thinking", thinking: "", startedAt: Date.now() }; break;
    case "thinking_delta": content[index] = { type: "thinking", thinking: `${existing?.thinking ?? ""}${String(delta.delta ?? "")}` }; break;
    case "thinking_end": content[index] = { type: "thinking", thinking: String(delta.content ?? existing?.thinking ?? ""), startedAt: existing?.startedAt, endedAt: Date.now() }; break;
    case "toolcall_start": content[index] = { type: "toolCall", name: delta.name, id: delta.id, arguments: {} }; break;
    case "toolcall_end": content[index] = delta.toolCall ?? existing ?? { type: "toolCall" }; break;
  }
  next.content = content;
  return next;
}

function QueuedMessageRow({ item, overlay = false, blocked = false, onEdit, onRemove, onReconcile }: {
  item: WebQueuedMessage;
  overlay?: boolean;
  blocked?: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onReconcile: (action: "discard" | "resubmit") => void;
}) {
  const uncertain = item.deliveryState === "delivering";
  const sortable = useSortable({ id: overlay ? `overlay:${item.id}` : item.id, disabled: overlay || uncertain || blocked });
  const style = overlay ? undefined : { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  return (
    <div
      ref={overlay ? undefined : sortable.setNodeRef}
      style={style}
      {...(overlay ? {} : sortable.attributes)}
      {...(overlay ? {} : sortable.listeners)}
      className={cn("semantic-queue-item", sortable.isDragging && "is-sortable-dragging", overlay && "is-overlay", uncertain && "is-uncertain", blocked && "is-blocked")}
    >
      <GripVertical className="semantic-queue-grip h-4 w-4" aria-hidden="true" />
      {item.images?.[0] && <img draggable={false} src={`data:${item.images[0].mimeType};base64,${item.images[0].data}`} alt="Queued attachment" />}
      <span>{item.message || "Image attachment"}{uncertain ? " · delivery uncertain" : blocked ? " · blocked by uncertain item" : ""}</span>
      {!overlay && uncertain && <button type="button" title="Discard uncertain message" onClick={() => onReconcile("discard")}><Trash2 className="h-4 w-4" /></button>}
      {!overlay && uncertain && <button type="button" title="Confirm and resubmit uncertain message" onClick={() => onReconcile("resubmit")}><Send className="h-4 w-4" /></button>}
      {!overlay && !uncertain && !blocked && <button type="button" title="Edit queued message" onPointerDown={(event) => event.stopPropagation()} onClick={onEdit}><Pencil className="h-4 w-4" /></button>}
      {!overlay && !uncertain && !blocked && <button type="button" title="Remove queued message" onPointerDown={(event) => event.stopPropagation()} onClick={onRemove}><Trash2 className="h-4 w-4" /></button>}
    </div>
  );
}

export function SemanticSession({ session, entries, streamingMessage, tools, error, connected, transcriptLoading, queuedMessages, sessionOptions, onSelectModel, onSelectThinkingLevel, onSend, onReplaceQueue, onReconcileQueue, onAbort }: SemanticSessionProps) {
  const [draft, setDraft] = React.useState(() => loadSessionDraft(session?.id));
  const [images, setImages] = React.useState<SemanticImage[]>([]);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [draggingAttachments, setDraggingAttachments] = React.useState(false);
  const [editingQueueId, setEditingQueueId] = React.useState<string | null>(null);
  const [draggingQueueId, setDraggingQueueId] = React.useState<string | null>(null);
  const queueSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [modelMenuOpen, setModelMenuOpen] = React.useState(false);
  const [sendMenuOpen, setSendMenuOpen] = React.useState(false);
  const [selectedSubagentId, setSelectedSubagentId] = React.useState<string | null>(null);
  const [slashMenuDismissed, setSlashMenuDismissed] = React.useState(false);
  const [selectedSlashCommand, setSelectedSlashCommand] = React.useState(0);
  const [showScrollToBottom, setShowScrollToBottom] = React.useState(false);
  const [controlBusy, setControlBusy] = React.useState(false);
  const [expandedItems, setExpandedItems] = React.useState<Set<string>>(() => new Set());
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const slashMenuRef = React.useRef<HTMLDivElement | null>(null);
  const modelButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const sendMenuButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const draftBeforeQueueEditRef = React.useRef<{ draft: string; images: SemanticImage[] } | null>(null);
  const initialScrollSessionRef = React.useRef<string | null>(null);
  const initialScrollPendingRef = React.useRef(true);
  const followOutputRef = React.useRef(true);
  const autoScrollFrameRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (session?.id && !editingQueueId) saveSessionDraft(session.id, draft);
  }, [draft, editingQueueId, session?.id]);

  const { messages, toolResults } = React.useMemo(() => {
    const results = new Map<string, ToolResultView>();
    const visible: MessageView[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.type !== "message" || !entry.message) continue;
      const role = entry.message.role;
      if (role === "toolResult") {
        const callId = typeof entry.message.toolCallId === "string" ? entry.message.toolCallId : "";
        if (callId) results.set(callId, toolResultView(entry.message, entry.message.isError === true));
        continue;
      }
      visible.push({
        message: entry.message,
        key: String(entry.id ?? entry.message.id ?? entry.message.timestamp ?? `message-${index}`),
        endedAt: entry.timestamp ? Date.parse(entry.timestamp) : undefined,
      });
    }
    return { messages: visible, toolResults: results };
  }, [entries]);

  if (initialScrollSessionRef.current !== session?.id) {
    initialScrollSessionRef.current = session?.id ?? null;
    initialScrollPendingRef.current = true;
    followOutputRef.current = true;
  }

  const manuallyExpandedRef = React.useRef(new Set<string>());
  const autoExpandedRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    setExpandedItems(new Set());
    manuallyExpandedRef.current.clear();
    autoExpandedRef.current = null;
  }, [session?.id]);

  const handleExpansionChange = React.useCallback((key: string, open: boolean, manual = false) => {
    if (manual) {
      if (open) manuallyExpandedRef.current.add(key);
      else manuallyExpandedRef.current.delete(key);
    }
    setExpandedItems((current) => {
      if (current.has(key) === open) return current;
      const next = new Set(current);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const streamingToolResults = React.useMemo(() => {
    const results = new Map(toolResults);
    for (const tool of tools) {
      if (tool.result !== undefined) results.set(tool.id, toolResultView(tool.result, tool.isError === true));
    }
    return results;
  }, [toolResults, tools]);
  const runningToolIds = React.useMemo(() => new Set(tools.filter((tool) => tool.running).map((tool) => tool.id)), [tools]);
  const representedToolIds = React.useMemo(() => {
    const ids = new Set<string>();
    const visit = (message: Record<string, unknown>) => {
      for (const part of contentParts(message)) {
        if (part.type === "toolCall" && typeof part.id === "string") ids.add(part.id);
      }
    };
    for (const view of messages) visit(view.message);
    if (streamingMessage) visit(streamingMessage);
    return ids;
  }, [messages, streamingMessage]);
  const orphanTools = React.useMemo(
    () => tools.filter((tool) => !representedToolIds.has(tool.id)),
    [representedToolIds, tools],
  );

  const latestCard = React.useMemo(() => {
    type Candidate = { key: string; expandable: boolean };
    const card = (message: Record<string, unknown>, messageKey: string): Candidate | null => {
      const parts = contentParts(message);
      for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
        const part = parts[partIndex];
        if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
          return { key: `text:${messageKey}:${partIndex}`, expandable: false };
        }
        if (part.type === "toolCall") {
          const callId = String(part.id ?? `${messageKey}:${partIndex}`);
          const result = streamingToolResults.get(callId);
          return { key: `call:${callId}`, expandable: Boolean(result && (result.output.trim() || result.details !== undefined)) };
        }
        if (part.type === "thinking") {
          return { key: `thinking:${String(message.timestamp ?? messageKey)}:${partIndex}`, expandable: false };
        }
      }
      return null;
    };
    if (streamingMessage) return card(streamingMessage, "streaming-assistant");
    const orphan = orphanTools.at(-1);
    if (orphan) {
      const result = streamingToolResults.get(orphan.id);
      return { key: `call:${orphan.id}`, expandable: Boolean(result && (result.output.trim() || result.details !== undefined)) };
    }
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const candidate = card(messages[messageIndex].message, messages[messageIndex].key);
      if (candidate) return candidate;
    }
    return null;
  }, [messages, orphanTools, streamingMessage, streamingToolResults]);

  const latestCardKey = latestCard?.key ?? null;
  const latestExpandableKey = latestCard?.expandable ? latestCard.key : null;

  React.useEffect(() => {
    if (!latestCardKey) return;
    const expansionToken = `${latestCardKey}:${latestExpandableKey === latestCardKey ? "open" : "closed"}`;
    if (expansionToken === autoExpandedRef.current) return;
    autoExpandedRef.current = expansionToken;
    setExpandedItems(() => {
      const next = new Set(manuallyExpandedRef.current);
      if (latestExpandableKey) next.add(latestExpandableKey);
      return next;
    });
  }, [latestCardKey, latestExpandableKey]);

  React.useLayoutEffect(() => {
    const target = scrollRef.current;
    if (!target || transcriptLoading || !initialScrollPendingRef.current) return;
    const scrollToEnd = () => { target.scrollTop = target.scrollHeight; };
    followOutputRef.current = true;
    setShowScrollToBottom(false);
    scrollToEnd();
    const frame = requestAnimationFrame(() => {
      scrollToEnd();
      initialScrollPendingRef.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages.length, session?.id, streamingMessage, transcriptLoading]);

  React.useEffect(() => {
    const target = scrollRef.current;
    if (!target || initialScrollPendingRef.current) return;
    const pinToBottom = () => {
      if (!followOutputRef.current) return;
      target.scrollTop = target.scrollHeight;
    };
    const schedulePin = () => {
      if (!followOutputRef.current) return;
      if (autoScrollFrameRef.current !== null) cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = requestAnimationFrame(() => {
        autoScrollFrameRef.current = null;
        pinToBottom();
      });
    };
    const observer = new ResizeObserver(schedulePin);
    const transcript = target.firstElementChild;
    if (transcript) observer.observe(transcript);
    schedulePin();
    return () => {
      observer.disconnect();
      if (autoScrollFrameRef.current !== null) cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    };
  }, [expandedItems, messages.length, streamingMessage, tools, queuedMessages.length]);

  const addFiles = async (files: File[]) => {
    try {
      const next = await Promise.all(files.slice(0, 4).map(fileAsImage));
      setImages((previous) => [...previous, ...next].slice(0, 4));
      setSendError(null);
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
    }
  };

  const editQueuedMessage = (item: WebQueuedMessage) => {
    if (!editingQueueId) draftBeforeQueueEditRef.current = { draft, images };
    setEditingQueueId(item.id);
    setDraft(item.message);
    setImages(item.images ?? []);
    requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
  };

  const finishQueueEditing = () => {
    const previous = draftBeforeQueueEditRef.current;
    draftBeforeQueueEditRef.current = null;
    setEditingQueueId(null);
    setDraft(previous?.draft ?? loadSessionDraft(session?.id));
    setImages(previous?.images ?? []);
  };

  const removeQueuedMessage = async (item: WebQueuedMessage) => {
    await onReplaceQueue(queuedMessages.filter((queued) => queued.id !== item.id));
  };

  const reconcileQueuedMessage = async (item: WebQueuedMessage, action: "discard" | "resubmit") => {
    const verb = action === "discard" ? "permanently discard" : "resubmit (this may duplicate a prompt Pi already accepted)";
    if (!window.confirm(`Confirm ${verb}?`)) return;
    try { await onReconcileQueue(item.id, action); setSendError(null); }
    catch (cause) { setSendError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const finishQueueDrag = async (event: DragEndEvent) => {
    setDraggingQueueId(null);
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId || activeId === overId) return;
    const activeIndex = queuedMessages.findIndex((item) => item.id === activeId);
    const overIndex = queuedMessages.findIndex((item) => item.id === overId);
    if (activeIndex < 0 || overIndex < 0) return;
    const placement = activeIndex < overIndex ? { afterId: overId } : { beforeId: overId };
    const next = moveWebQueuedMessage(queuedMessages, activeId, placement);
    try {
      await onReplaceQueue(next);
      setSendError(null);
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const selectModel = async (provider: string, modelId: string) => {
    setControlBusy(true);
    try {
      await onSelectModel(provider, modelId);
      setModelMenuOpen(false);
      setSendError(null);
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setControlBusy(false);
      requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
    }
  };

  const selectEffort = async (level: string) => {
    setControlBusy(true);
    try {
      await onSelectThinkingLevel(level);
      setModelMenuOpen(false);
      setSendError(null);
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setControlBusy(false);
      requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
    }
  };

  const modelLabel = session?.model?.split("/").pop() ?? "Model";
  const effortLabel = session?.thinkingLevel ?? "off";
  const availableModels = sessionOptions.models.length > 0
    ? sessionOptions.models
    : session?.model?.includes("/")
      ? [{ provider: session.model.split("/")[0]!, id: session.model.split("/").slice(1).join("/"), name: modelLabel, reasoning: true }]
      : [];
  const availableEfforts = sessionOptions.thinkingLevels.length > 0
    ? sessionOptions.thinkingLevels
    : ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const slashMatch = editingQueueId ? null : draft.match(/^\/([^\s]*)$/);
  const slashQuery = slashMatch?.[1] ?? "";
  const matchingSlashCommands = React.useMemo(
    () => slashMatch ? filterSlashCommands(sessionOptions.commands ?? [], slashQuery) : [],
    [sessionOptions.commands, slashMatch?.[0], slashQuery],
  );
  const slashMenuOpen = !slashMenuDismissed && matchingSlashCommands.length > 0;
  const activeSkillInvocation = React.useMemo(() => {
    const name = draft.match(/^\/([^\s]+)(?:\s|$)/)?.[1];
    return name ? sessionOptions.commands.find((command) => command.name === name && command.source === "skill") : undefined;
  }, [draft, sessionOptions.commands]);

  React.useEffect(() => {
    setSelectedSlashCommand(0);
  }, [session?.id, slashQuery, matchingSlashCommands.length]);

  React.useEffect(() => {
    if (!slashMenuOpen) return;
    slashMenuRef.current?.querySelector(`[data-command-index="${selectedSlashCommand}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedSlashCommand, slashMenuOpen]);

  const insertSlashCommand = React.useCallback((command: WebSlashCommand) => {
    setDraft(`/${command.name} `);
    setSlashMenuDismissed(true);
    requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
  }, []);

  const isWorking = session?.status === "working" || tools.some((tool) => tool.running);
  const jumpToBottom = React.useCallback(() => {
    const target = scrollRef.current;
    if (!target) return;
    followOutputRef.current = true;
    setShowScrollToBottom(false);
    target.scrollTo({ top: target.scrollHeight, behavior: "smooth" });
  }, []);
  const latestAssistantIndex = lastAssistantMessageIndex(messages);
  const selectedSubagent = session?.subagents?.find((agent) => agent.id === selectedSubagentId) ?? null;
  const displayedSubagentUsage = React.useMemo(
    () => totalSubagentUsage(session?.subagents ?? []),
    [session?.subagents],
  );

  const submit = async (behavior?: "steer" | "followUp", messageOverride?: string) => {
    const message = (messageOverride ?? draft).trim();
    if ((!message && images.length === 0) || sending || !session) return;
    setSending(true);
    try {
      if (editingQueueId) {
        await onReplaceQueue(queuedMessages.map((item) => item.id === editingQueueId ? { ...item, message, images } : item));
        finishQueueEditing();
      } else {
        await onSend(message, images, behavior);
        setDraft("");
        setImages([]);
      }
      setSendError(null);
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="relative flex h-full min-h-0 flex-col bg-[#09090b]">
      <SubagentOutputDialog agent={selectedSubagent} onOpenChange={(open) => { if (!open) setSelectedSubagentId(null); }} />
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onWheel={(event) => {
          if (event.deltaY < 0) {
            followOutputRef.current = false;
            setShowScrollToBottom(true);
          }
        }}
        onTouchMove={() => {
          followOutputRef.current = false;
          setShowScrollToBottom(true);
        }}
        onPointerDown={(event) => {
          const target = event.currentTarget;
          const bounds = target.getBoundingClientRect();
          if (event.clientX >= bounds.left + target.clientWidth) {
            followOutputRef.current = false;
            setShowScrollToBottom(true);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") {
            followOutputRef.current = false;
            setShowScrollToBottom(true);
          }
        }}
        onScroll={(event) => {
          const target = event.currentTarget;
          const decision = resolveScrollFollow(
            followOutputRef.current,
            target.scrollHeight - target.scrollTop - target.clientHeight,
          );
          followOutputRef.current = decision.following;
          setShowScrollToBottom(decision.showButton);
          if (decision.pinToBottom) {
            if (autoScrollFrameRef.current !== null) cancelAnimationFrame(autoScrollFrameRef.current);
            autoScrollFrameRef.current = requestAnimationFrame(() => {
              autoScrollFrameRef.current = null;
              if (followOutputRef.current) target.scrollTop = target.scrollHeight;
            });
          }
        }}
      >
        <div className="flex w-full flex-col gap-4 px-4 pb-8 pt-16 sm:px-6 xl:pt-8">
          {transcriptLoading && messages.length === 0 && !streamingMessage && (
            <div className="semantic-transcript-loading" aria-label="Loading transcript">
              <div /><div /><div />
            </div>
          )}
          {!transcriptLoading && messages.length === 0 && !streamingMessage && orphanTools.length === 0 && (
            <div className="py-24 text-center text-sm text-zinc-500">{session ? "No messages in this session yet." : "Select a session."}</div>
          )}
          {messages.map((view, index) => (
            <MessageCard key={view.key} message={view.message} active={!streamingMessage && isWorking && index === latestAssistantIndex} messageKey={view.key} endedAt={view.endedAt} expandedItems={expandedItems} onExpansionChange={handleExpansionChange} toolResults={streamingToolResults} runningToolIds={runningToolIds} />
          ))}
          {streamingMessage && <MessageCard message={streamingMessage} streaming active={isWorking} messageKey="streaming-assistant" expandedItems={expandedItems} onExpansionChange={handleExpansionChange} toolResults={streamingToolResults} runningToolIds={runningToolIds} />}
          {session?.compaction && <CompactionStatus session={session} />}
          {!session?.compaction && !streamingMessage && latestAssistantIndex < 0 && isWorking && <div className="semantic-activity-label"><span>Pi</span><span className="semantic-streaming-dot" /></div>}
          {orphanTools.map((tool) => {
            const callKey = `call:${tool.id}`;
            return <ToolCallCard key={tool.id} name={tool.name} args={tool.args} running={tool.running} result={tool.result === undefined ? undefined : toolResultView(tool.result, tool.isError === true)} expansionKey={callKey} expanded={expandedItems.has(callKey)} onExpansionChange={handleExpansionChange} />;
          })}
        </div>
      </div>
      {showScrollToBottom && <div className="relative z-30 h-0"><button type="button" className="semantic-scroll-bottom" title="Scroll to bottom" aria-label="Scroll to bottom" onClick={jumpToBottom}><ArrowDown className="h-4 w-4" /></button></div>}
      <div className="semantic-session-composer bg-zinc-950/95 p-3 backdrop-blur sm:p-4">
        <div className="w-full">
          {session?.subagents && session.subagents.length > 0 && (
            <div className="semantic-live-subagents">
              <div className="semantic-queue-label">Subagents · {usageSummary(displayedSubagentUsage)}</div>
              <SubagentRows agents={session.subagents} onSelect={(agent) => setSelectedSubagentId(agent.id)} />
            </div>
          )}
          {queuedMessages.length > 0 && (
            <DndContext
              sensors={queueSensors}
              collisionDetection={closestCenter}
              onDragStart={(event) => setDraggingQueueId(String(event.active.id))}
              onDragCancel={() => setDraggingQueueId(null)}
              onDragEnd={(event) => void finishQueueDrag(event)}
            >
              <div className="semantic-queue">
                <div className="semantic-queue-label">Queued follow-up{queuedMessages.length === 1 ? "" : "s"}</div>
                <SortableContext items={queuedMessages.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                  <div className="grid gap-1.5">
                    {queuedMessages.map((item, index) => {
                      const blocked = queuedMessages.slice(0, index).some((queued) => queued.deliveryState === "delivering");
                      return <QueuedMessageRow key={item.id} item={item} blocked={blocked} onEdit={() => editQueuedMessage(item)} onRemove={() => void removeQueuedMessage(item)} onReconcile={(action) => void reconcileQueuedMessage(item, action)} />;
                    })}
                  </div>
                </SortableContext>
              </div>
              {createPortal(
                <DragOverlay dropAnimation={null}>
                  {draggingQueueId ? (() => {
                    const item = queuedMessages.find((queued) => queued.id === draggingQueueId);
                    return item ? <QueuedMessageRow item={item} overlay onEdit={() => {}} onRemove={() => {}} onReconcile={() => {}} /> : null;
                  })() : null}
                </DragOverlay>,
                document.body,
              )}
            </DndContext>
          )}
          <div className={cn("relative rounded-2xl border border-zinc-700 bg-zinc-900 shadow-2xl focus-within:border-white/70", draggingAttachments && "border-sky-400 bg-sky-400/5")}>
            {slashMenuOpen && (
              <div ref={slashMenuRef} id="semantic-slash-command-menu" role="listbox" className="semantic-slash-menu">
                {matchingSlashCommands.map((command, index) => (
                  <button
                    id={`semantic-slash-command-${index}`}
                    data-command-index={index}
                    key={`${command.source}:${command.name}`}
                    type="button"
                    role="option"
                    aria-selected={index === selectedSlashCommand}
                    className={cn(index === selectedSlashCommand && "is-selected")}
                    onMouseEnter={() => setSelectedSlashCommand(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insertSlashCommand(command)}
                  >
                    <span className="semantic-slash-command-main"><strong>/{command.name}</strong>{command.description && <small>{command.description}</small>}</span>
                    <span className="semantic-slash-command-source">{command.source}{command.location ? ` · ${command.location}` : ""}</span>
                  </button>
                ))}
              </div>
            )}
            {activeSkillInvocation && <div className="semantic-skill-invocation"><span>skill</span><code>/{activeSkillInvocation.name}</code><small>arguments stay verbatim</small></div>}
            {images.length > 0 && <div className="flex gap-2 overflow-x-auto px-3 pt-3">{images.map((image, index) => <div key={index} className="relative shrink-0"><img className="h-16 w-16 rounded-lg border border-zinc-700 object-cover" src={`data:${image.mimeType};base64,${image.data}`} alt={image.name ?? "Attachment"} /><button type="button" className="absolute -right-1 -top-1 rounded-full bg-zinc-800 p-0.5" onMouseDown={(event) => event.preventDefault()} onClick={() => { setImages((current) => current.filter((_, item) => item !== index)); textareaRef.current?.focus({ preventScroll: true }); }}><X className="h-3 w-3" /></button></div>)}</div>}
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setSlashMenuDismissed(false);
              }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
                if (files.length) { event.preventDefault(); void addFiles(files); }
              }}
              onDragEnter={(event) => {
                if (!event.dataTransfer.types.includes("Files")) return;
                event.preventDefault();
                setDraggingAttachments(true);
              }}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes("Files")) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setDraggingAttachments(true);
              }}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                setDraggingAttachments(false);
              }}
              onDrop={(event) => {
                if (!event.dataTransfer.types.includes("Files")) return;
                event.preventDefault();
                setDraggingAttachments(false);
                const files = Array.from(event.dataTransfer.files);
                if (files.length) void addFiles(files);
              }}
              onKeyDown={(event) => {
                if (slashMenuOpen) {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const direction = event.key === "ArrowDown" ? 1 : -1;
                    setSelectedSlashCommand((current) => (current + direction + matchingSlashCommands.length) % matchingSlashCommands.length);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setSlashMenuDismissed(true);
                    return;
                  }
                  const command = matchingSlashCommands[Math.min(selectedSlashCommand, matchingSlashCommands.length - 1)];
                  if (command && event.key === "Tab") {
                    event.preventDefault();
                    insertSlashCommand(command);
                    return;
                  }
                  if (command && event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    setSlashMenuDismissed(true);
                    void submit(event.altKey ? "followUp" : session?.status === "working" ? "steer" : undefined, `/${command.name}`);
                    return;
                  }
                }
                if (event.key !== "Enter" || event.shiftKey) return;
                event.preventDefault();
                void submit(event.altKey ? "followUp" : session?.status === "working" ? "steer" : undefined);
              }}
              aria-autocomplete="list"
              aria-controls={slashMenuOpen ? "semantic-slash-command-menu" : undefined}
              aria-expanded={slashMenuOpen}
              aria-activedescendant={slashMenuOpen ? `semantic-slash-command-${selectedSlashCommand}` : undefined}
              className="min-h-20 max-h-52 w-full resize-none bg-transparent px-4 pt-3 text-[16px] leading-6 text-zinc-100 outline-none placeholder:text-zinc-600"
              placeholder={editingQueueId ? "Edit queued follow-up…" : session?.status === "working" ? "Steer Pi… (Option+Enter queues a follow-up)" : "Message Pi…"}
              disabled={!session || !connected}
            />
            {draggingAttachments && <div className="semantic-attachment-drop" aria-hidden="true"><Paperclip className="h-5 w-5" /> Drop images to attach</div>}
            <div className="flex items-center justify-between gap-2 px-2 pb-2">
              <div className="flex items-center gap-1">
                <input ref={fileRef} className="hidden" type="file" accept="image/*" multiple onChange={(event) => { void addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
                <Button className="h-9 min-w-9 px-2" variant="ghost" size="icon" title="Attach image" onMouseDown={(event) => event.preventDefault()} onClick={() => fileRef.current?.click()}><Paperclip className="h-4 w-4" /></Button>
                <Button ref={modelButtonRef} className="semantic-composer-control h-9 max-w-64 px-2" variant="ghost" size="sm" disabled={controlBusy || !connected} onMouseDown={(event) => event.preventDefault()} onClick={() => setModelMenuOpen((open) => !open)}>{modelLabel}<span className="text-zinc-600">·</span><span>{effortLabel}</span><ChevronDown className="h-3.5 w-3.5" /></Button>
                <AnchoredPopover open={modelMenuOpen} onOpenChange={setModelMenuOpen} anchorRef={modelButtonRef} align="start" className="semantic-composer-menu max-h-[70vh] w-80 overflow-y-auto">
                  <div className="semantic-composer-menu-label">Model</div>
                  {availableModels.map((model) => {
                    const value = `${model.provider}/${model.id}`;
                    return <button key={value} type="button" onClick={() => void selectModel(model.provider, model.id)}><span><strong>{model.name}</strong><small>{value}</small></span>{session?.model === value && <Check className="h-4 w-4 text-sky-300" />}</button>;
                  })}
                  <div className="semantic-composer-menu-divider" />
                  <div className="semantic-composer-menu-label">Thinking effort</div>
                  <div className="semantic-effort-grid">
                    {availableEfforts.map((level) => <button key={level} type="button" onClick={() => void selectEffort(level)}><span><strong>{level}</strong></span>{effortLabel === level && <Check className="h-4 w-4 text-sky-300" />}</button>)}
                  </div>
                </AnchoredPopover>
                <ComposerTokenInfo session={session} />
              </div>
              <div className="flex items-center gap-2">
                {editingQueueId && <Button className="h-9 px-3" variant="ghost" size="sm" onClick={finishQueueEditing}>Cancel</Button>}
                <div className="flex items-center overflow-hidden rounded-xl shadow-sm">
                  <Button
                    className={cn("h-9 w-9 rounded-xl", !editingQueueId && session?.status === "working" && "rounded-r-none")}
                    title={editingQueueId ? "Save queued message" : session?.status === "working" && !draft.trim() && images.length === 0 ? "Stop" : "Send"}
                    size="icon"
                    disabled={sending || !connected || (!editingQueueId && session?.status !== "working" && !draft.trim() && images.length === 0)}
                    onClick={() => {
                      if (!editingQueueId && session?.status === "working" && !draft.trim() && images.length === 0) void onAbort();
                      else void submit(editingQueueId ? undefined : session?.status === "working" ? "steer" : undefined);
                    }}
                  >
                    {!editingQueueId && session?.status === "working" && !draft.trim() && images.length === 0 ? <Square className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                  </Button>
                  {!editingQueueId && session?.status === "working" && (
                    <Button
                      ref={sendMenuButtonRef}
                      className="h-9 w-7 rounded-l-none rounded-r-xl border-l border-zinc-300/25 p-0"
                      title="Send options"
                      size="icon"
                      disabled={sending || !connected}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setSendMenuOpen((open) => !open)}
                    ><ChevronDown className="h-3.5 w-3.5" /></Button>
                  )}
                </div>
                <AnchoredPopover open={sendMenuOpen} onOpenChange={setSendMenuOpen} anchorRef={sendMenuButtonRef} className="semantic-composer-menu w-56">
                  <button type="button" disabled={!draft.trim() && images.length === 0} onClick={() => { setSendMenuOpen(false); void submit("followUp"); }}><span><strong>Queue follow-up</strong><small>Send after Pi finishes</small></span></button>
                </AnchoredPopover>
              </div>
            </div>
          </div>
          {(sendError || error) && <p className="mt-2 text-sm text-red-300">{sendError ?? error}</p>}
        </div>
      </div>
    </section>
  );
}
