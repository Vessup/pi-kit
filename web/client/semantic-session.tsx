import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleGauge,
  FilePenLine,
  FileText,
  FileUp,
  GripVertical,
  LoaderCircle,
  Paperclip,
  Pencil,
  Search,
  Send,
  Square,
  TerminalSquare,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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

import { renderTerminalOutput } from "../../terminal-output";
import { assistantTerminalNotice } from "../assistant-message";
import {
  moveWebQueuedMessage,
  type SemanticImage,
  type WebQueuedMessage,
  type WebQueueReplacement,
  type WebSession,
  type WebSessionOptions,
  type WebSlashCommand,
  type WebSubagent,
  type WebUsage,
} from "../protocol";
import { AnchoredPopover } from "./components/anchored-popover";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./components/ui/tooltip";
import { assertClientPromptPayloadFits } from "./image-payload";
import { cn } from "./lib/utils";
import { anchoredScrollTop, resolveScrollFollow } from "./scroll-follow";
import { hasActiveSessionWork } from "./session-status";
import { toolHasArgumentDetails } from "./tool-expansion";
import { totalSubagentUsage } from "./usage";

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
type MessageView = {
  message: Record<string, unknown>;
  key: string;
  endedAt?: number;
};

function lastAssistantMessageIndex(messages: MessageView[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.message.role === "assistant") return index;
  }
  return -1;
}

type SemanticSessionProps = {
  session: WebSession | null;
  entries: SemanticEntry[];
  historyRevision: number;
  streamingMessage: Record<string, unknown> | null;
  streamingMessageKey: string | null;
  tools: ActiveTool[];
  error: string | null;
  connected: boolean;
  transcriptLoading: boolean;
  queuedMessages: WebQueuedMessage[];
  sessionOptions: WebSessionOptions;
  onSelectModel: (provider: string, modelId: string) => Promise<void>;
  onSelectThinkingLevel: (level: string) => Promise<void>;
  onSend: (
    message: string,
    images: SemanticImage[],
    behavior?: "steer" | "followUp",
  ) => Promise<void>;
  onReplaceQueue: (queue: WebQueueReplacement[]) => Promise<void>;
  onSteerQueuedMessage: (itemId: string) => Promise<void>;
  onReconcileQueue: (
    itemId: string,
    action: "discard" | "resubmit",
  ) => Promise<void>;
  onAbort: () => Promise<void>;
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SESSION_DRAFT_PREFIX = "pi-web-session-draft-v1:";
const SUBAGENTS_MINIMIZED_PREFIX = "pi-web-subagents-minimized-v1:";
const subagentsMinimizedBySession = new Map<string, boolean>();

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

export function filterSlashCommands(
  commands: readonly WebSlashCommand[],
  query: string,
): WebSlashCommand[] {
  return commands
    .flatMap((command) => {
      const score = fuzzyCommandScore(command.name, query);
      return score === null ? [] : [{ command, score }];
    })
    .sort(
      (a, b) =>
        a.score - b.score || a.command.name.localeCompare(b.command.name),
    )
    .map(({ command }) => command);
}

function loadSessionDraft(sessionId: string | undefined): string {
  if (!sessionId) return "";
  try {
    return localStorage.getItem(draftStorageKey(sessionId)) ?? "";
  } catch {
    return "";
  }
}

function saveSessionDraft(sessionId: string, draft: string): void {
  try {
    if (draft) localStorage.setItem(draftStorageKey(sessionId), draft);
    else localStorage.removeItem(draftStorageKey(sessionId));
  } catch {
    // Draft persistence is best-effort when storage is unavailable or full.
  }
}

function subagentsMinimizedStorageKey(sessionId: string): string {
  return `${SUBAGENTS_MINIMIZED_PREFIX}${encodeURIComponent(sessionId)}`;
}

function loadSubagentsMinimized(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  const retained = subagentsMinimizedBySession.get(sessionId);
  if (retained !== undefined) return retained;
  let minimized = false;
  try {
    minimized =
      localStorage.getItem(subagentsMinimizedStorageKey(sessionId)) === "1";
  } catch {
    /* use the in-memory default */
  }
  subagentsMinimizedBySession.set(sessionId, minimized);
  return minimized;
}

function saveSubagentsMinimized(sessionId: string, minimized: boolean): void {
  subagentsMinimizedBySession.set(sessionId, minimized);
  try {
    if (minimized)
      localStorage.setItem(subagentsMinimizedStorageKey(sessionId), "1");
    else localStorage.removeItem(subagentsMinimizedStorageKey(sessionId));
  } catch {
    // The in-memory preference still survives session navigation.
  }
}

function fileAsImage(file: File): Promise<SemanticImage> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/"))
      return reject(new Error("Only image attachments are supported"));
    if (file.size > MAX_IMAGE_BYTES)
      return reject(new Error("Image exceeds the 10 MB limit"));
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) reject(new Error("Could not encode image"));
      else
        resolve({
          type: "image",
          mimeType: file.type || "image/png",
          data: result.slice(comma + 1),
          name: file.name || undefined,
        });
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read image"));
    reader.readAsDataURL(file);
  });
}

function contentParts(
  message: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const content = message.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content)
    ? content.filter(
        (part): part is Record<string, unknown> =>
          !!part && typeof part === "object",
      )
    : [];
}

function textFromResult(value: unknown): string {
  if (!value || typeof value !== "object")
    return typeof value === "string" ? value : "";
  const record = value as Record<string, unknown>;
  const content = record.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is Record<string, unknown> =>
        !!part && typeof part === "object",
    )
    .map((part) =>
      part.type === "text" && typeof part.text === "string" ? part.text : "",
    )
    .filter(Boolean)
    .join("\n");
}

function toolResultView(value: unknown, isError = false): ToolResultView {
  const record = asRecord(value);
  return { output: textFromResult(value), isError, details: record.details };
}

const Markdown = React.memo(function Markdown({
  children,
  preserveSoftBreaks = false,
}: {
  children: string;
  preserveSoftBreaks?: boolean;
}) {
  return (
    <div className="semantic-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={
          preserveSoftBreaks
            ? {
                p: ({ children: paragraph }) => (
                  <p className="semantic-preserve-breaks">{paragraph}</p>
                ),
              }
            : undefined
        }
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});

function thinkingLines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) =>
      line
        .trim()
        .replace(/^[-*+]\s+/, "")
        .replace(/^#{1,6}\s+/, "")
        .replace(/\*\*/g, "")
        .replace(/__/g, ""),
    )
    .filter(Boolean);
}

function displayContentParts(
  message: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const display: Array<Record<string, unknown>> = [];
  for (const part of contentParts(message)) {
    const previous = display.at(-1);
    if (
      part.type === "thinking" &&
      typeof part.thinking === "string" &&
      previous?.type === "thinking"
    ) {
      previous.thinking = `${String(previous.thinking ?? "")}\n${part.thinking}`;
    } else {
      display.push({ ...part });
    }
  }
  return display;
}

function messageDate(value: unknown): Date | null {
  const timestamp =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function formatMessageTime(value: unknown): string | null {
  const date = messageDate(value);
  return date
    ? new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(date)
    : null;
}

function formatFullTimestamp(value: unknown): string | null {
  const date = messageDate(value);
  return date
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "full",
        timeStyle: "long",
      }).format(date)
    : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function shortened(value: string, max = 180): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function parseJsonDocuments(text: string): unknown[] | null {
  const source = text.trim();
  if (!source || source.length > 100_000) return null;
  try {
    return [JSON.parse(source)];
  } catch {
    /* Multiple JSON documents may follow. */
  }
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
        try {
          documents.push(JSON.parse(source.slice(start, index + 1)));
        } catch {
          return null;
        }
        start = -1;
      }
    }
  }
  return documents.length > 0 && start < 0 ? documents : null;
}

function DataValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null) return <span className="semantic-data-empty">none</span>;
  if (typeof value === "boolean")
    return (
      <span
        className={cn("semantic-data-bool", value ? "is-true" : "is-false")}
      >
        {value ? "Yes" : "No"}
      </span>
    );
  if (typeof value === "number")
    return (
      <span className="semantic-data-number">{value.toLocaleString()}</span>
    );
  if (typeof value === "string") {
    if (/^https?:\/\//.test(value))
      return (
        <a href={value} target="_blank" rel="noreferrer">
          {value}
        </a>
      );
    return <span>{value}</span>;
  }
  if (depth >= 4) return <code>{JSON.stringify(value)}</code>;
  if (Array.isArray(value)) {
    return (
      <div className="semantic-data-list">
        {value.map((item, index) => (
          <DataValue
            key={`${index}-${JSON.stringify(item)}`}
            value={item}
            depth={depth + 1}
          />
        ))}
      </div>
    );
  }
  return (
    <dl className="semantic-data-grid">
      {Object.entries(asRecord(value)).map(([key, item]) => (
        <React.Fragment key={key}>
          <dt>{key.replace(/([a-z])([A-Z])/g, "$1 $2")}</dt>
          <dd>
            <DataValue value={item} depth={depth + 1} />
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function HighlightedCode({
  text,
  language,
}: {
  text: string;
  language?: string;
}) {
  const codeRef = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    if (codeRef.current) {
      codeRef.current.innerHTML = highlightedHtml(text, language);
    }
  }, [text, language]);
  return (
    <pre className="semantic-highlighted-code">
      <code
        ref={codeRef}
        className={language ? `language-${language}` : undefined}
      />
    </pre>
  );
}

function FormattedOutput({
  text,
  toolName,
  args,
}: {
  text: string;
  toolName: string;
  args?: Record<string, unknown>;
}) {
  if (toolName === "bash") text = renderTerminalOutput(text);
  if (toolName === "read")
    return text ? (
      <HighlightedCode
        text={text}
        language={syntaxLanguage(String(args?.path ?? ""))}
      />
    ) : null;
  if (toolName.startsWith("subagent_"))
    return text ? <Markdown preserveSoftBreaks>{text}</Markdown> : null;
  const documents = parseJsonDocuments(text);
  if (documents)
    return (
      <div className="semantic-data-documents">
        {documents.map((document, index) => (
          <DataValue
            key={`${index}-${JSON.stringify(document)}`}
            value={document}
          />
        ))}
      </div>
    );
  const success =
    /^(successfully|wrote |created |updated |deleted |resolved )/i.test(
      text.trim(),
    );
  if (
    success &&
    ["edit", "write", "staff", "staff-comment"].some((name) =>
      toolName.includes(name),
    )
  ) {
    return (
      <div className="semantic-tool-success">
        <CheckCircle2 className="h-4 w-4" /> {text.trim()}
      </div>
    );
  }
  return text ? (
    <pre className={cn(toolName === "bash" && "semantic-terminal-output")}>
      {text}
    </pre>
  ) : null;
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

function combinedUsage(
  primary: WebUsage | undefined,
  live: WebUsage | undefined,
): WebUsage | undefined {
  if (!primary && !live) return undefined;
  const a = primary ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const b = live ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
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
      <span>
        Input <strong>{formatTokenCount(usage?.input ?? 0)}</strong>
      </span>
      <span>
        Output <strong>{formatTokenCount(usage?.output ?? 0)}</strong>
      </span>
      {(usage?.cacheRead ?? 0) > 0 && (
        <span>
          Cache read <strong>{formatTokenCount(usage?.cacheRead ?? 0)}</strong>
        </span>
      )}
      {(usage?.cacheWrite ?? 0) > 0 && (
        <span>
          Cache write{" "}
          <strong>{formatTokenCount(usage?.cacheWrite ?? 0)}</strong>
        </span>
      )}
      <span>
        Cost <strong>${(usage?.cost.total ?? 0).toFixed(3)}</strong>
      </span>
      {context?.contextWindow ? (
        <span>
          Context{" "}
          <strong>
            {context.percent == null ? "?" : `${context.percent.toFixed(1)}%`} /{" "}
            {formatTokenCount(context.contextWindow)}
          </strong>
        </span>
      ) : (
        <span>
          Context <strong>unknown</strong>
        </span>
      )}
    </div>
  );
}

function CompactionStatus({ session }: { session: WebSession }) {
  const compaction = session.compaction;
  if (!compaction) return null;
  const title =
    compaction.reason === "overflow"
      ? "Context overflow — compacting before retry…"
      : compaction.reason === "threshold"
        ? "Context limit reached — compacting…"
        : "Compacting context…";
  return (
    <output className="semantic-compaction-status">
      <LoaderCircle className="h-4 w-4 animate-spin" />
      <div>
        <strong>{title}</strong>
        <small>
          Summarizing older messages to free context. This may take a moment.
        </small>
      </div>
    </output>
  );
}

function sameTokenTelemetry(
  a: WebSession | null,
  b: WebSession | null,
): boolean {
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

const ComposerTokenInfo = React.memo(
  function ComposerTokenInfo({ session }: { session: WebSession | null }) {
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
      context?.contextWindow
        ? `${context.percent == null ? "?" : `${context.percent.toFixed(1)}%`}/${formatTokenCount(context.contextWindow)}`
        : "?/?",
    ].join(" ");
    return (
      <>
        <span className="semantic-token-inline">{compact}</span>
        <span className="semantic-token-mobile">
          <TooltipProvider>
            <Tooltip open={open} onOpenChange={setOpen}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Token usage"
                  onClick={() => setOpen((value) => !value)}
                >
                  <CircleGauge className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <TokenDetails session={session} />
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </span>
      </>
    );
  },
  (previous, next) => sameTokenTelemetry(previous.session, next.session),
);

const ContextProgressCircle = React.memo(
  function ContextProgressCircle({ session }: { session: WebSession | null }) {
    const context = session?.contextUsage;
    const contextTokens = context?.tokens ?? 0;
    const rawPercent =
      context?.percent ??
      (context?.contextWindow
        ? (contextTokens / context.contextWindow) * 100
        : 0);
    const percent = Math.max(
      0,
      Math.min(100, Number.isFinite(rawPercent) ? rawPercent : 0),
    );
    const compacting = Boolean(session?.compaction);
    const radius = 8;
    const circumference = 2 * Math.PI * radius;
    const progress = compacting ? 25 : percent;
    const dash = (circumference * progress) / 100;
    const contextText = context?.contextWindow
      ? `${percent.toFixed(1)}% · ${formatTokenCount(contextTokens)} / ${formatTokenCount(context.contextWindow)}`
      : "Context unavailable";
    const label = compacting
      ? `Compacting context, ${contextText}`
      : `Context usage ${contextText}`;
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                "semantic-context-progress",
                compacting && "is-compacting",
                !compacting && percent >= 90 && "is-critical",
                !compacting && percent >= 70 && percent < 90 && "is-warning",
              )}
              aria-label={label}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <circle
                  className="semantic-context-progress-track"
                  cx="10"
                  cy="10"
                  r={radius}
                />
                <circle
                  className="semantic-context-progress-value"
                  cx="10"
                  cy="10"
                  r={radius}
                  strokeDasharray={`${dash} ${circumference - dash}`}
                />
              </svg>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <div className="semantic-context-progress-details">
              <strong>{compacting ? "Compacting context…" : "Context"}</strong>
              <span>{contextText}</span>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  },
  (previous, next) =>
    previous.session?.id === next.session?.id &&
    previous.session?.contextUsage?.tokens ===
      next.session?.contextUsage?.tokens &&
    previous.session?.contextUsage?.contextWindow ===
      next.session?.contextUsage?.contextWindow &&
    previous.session?.contextUsage?.percent ===
      next.session?.contextUsage?.percent &&
    previous.session?.compaction?.reason === next.session?.compaction?.reason,
);

function SubagentRows({
  agents,
  onSelect,
}: {
  agents: WebSubagent[];
  onSelect?: (agent: WebSubagent) => void;
}) {
  if (agents.length === 0) return null;
  return (
    <div className="semantic-subagent-list">
      {agents.map((agent) => (
        <div key={agent.id} className="semantic-subagent-row">
          <span
            className={cn("semantic-subagent-status", `is-${agent.status}`)}
            role="img"
            aria-label={agent.status}
          />
          <div className="semantic-subagent-main">
            {onSelect ? (
              <button type="button" onClick={() => onSelect(agent)}>
                {agent.id}
              </button>
            ) : (
              <strong>{agent.id}</strong>
            )}
            <small>
              {agent.model} · {agent.effort} · {agent.turns} turn
              {agent.turns === 1 ? "" : "s"}
            </small>
          </div>
          <div className="semantic-subagent-activity">
            {agent.currentTool && (
              <span className="semantic-subagent-tool">
                {agent.currentTool}
              </span>
            )}
            {agent.queued > 0 && <span>{agent.queued} queued</span>}
            <span
              className={cn(
                "semantic-subagent-status-label capitalize",
                `is-${agent.status}`,
              )}
            >
              {agent.status}
            </span>
            {usageSummary(agent.usage) && (
              <span>{usageSummary(agent.usage)}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function SubagentOutputDialog({
  agent,
  onOpenChange,
}: {
  agent: WebSubagent | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={agent !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader className="relative pr-16">
          <DialogTitle>{agent?.id ?? "Subagent"}</DialogTitle>
          <DialogDescription>
            {agent
              ? `${agent.status} · ${agent.model} · ${agent.effort} · ${agent.turns} turn${agent.turns === 1 ? "" : "s"}`
              : ""}
          </DialogDescription>
          <DialogClose className="absolute right-3 top-3 h-8 w-8 p-0" />
        </DialogHeader>
        <DialogBody className="semantic-subagent-dialog-body">
          {agent?.error && (
            <div className="semantic-subagent-error">{agent.error}</div>
          )}
          {agent &&
            (agent.transcript?.length ?? 0) === 0 &&
            !agent.streamingText && (
              <p className="text-sm text-zinc-500">No output yet.</p>
            )}
          {agent?.transcript?.map((item, index) => (
            <section
              key={`${item.timestamp}:${index}`}
              className="semantic-subagent-transcript-item"
            >
              <header>
                <span>{item.role}</span>
                <time title={formatFullTimestamp(item.timestamp) ?? undefined}>
                  {formatMessageTime(item.timestamp)}
                </time>
              </header>
              <pre>{item.text}</pre>
            </section>
          ))}
          {agent?.streamingText && (
            <section className="semantic-subagent-transcript-item is-streaming">
              <header>
                <span>assistant</span>
                <span className="semantic-streaming-dot" />
              </header>
              <pre>{agent.streamingText}</pre>
            </section>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function imageDataUrl(image: Pick<SemanticImage, "data" | "mimeType">): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

function ImageLightboxDialog({
  image,
  onOpenChange,
}: {
  image: SemanticImage | null;
  onOpenChange: (open: boolean) => void;
}) {
  const title = image?.name ?? "Attachment preview";
  return (
    <Dialog open={image !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl border-zinc-700 bg-zinc-950/95 p-0">
        <DialogHeader className="relative border-b-0 px-4 py-3 pr-16 sm:px-5">
          <DialogTitle className="truncate text-sm">{title}</DialogTitle>
          <DialogDescription className="sr-only">
            Expanded attachment preview
          </DialogDescription>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close image preview"
            className="absolute right-3 top-2 h-8 w-8 p-0"
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </DialogHeader>
        <DialogBody className="flex max-h-[calc(100dvh-6rem)] min-h-0 items-center justify-center overflow-auto bg-black/20 p-3 sm:p-5">
          {image && (
            <img
              className="semantic-image-lightbox"
              src={imageDataUrl(image)}
              alt={title}
            />
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
    if (typeof item.id !== "string" || typeof item.status !== "string")
      return [];
    return [
      {
        id: item.id,
        status: item.status as WebSubagent["status"],
        model: typeof item.model === "string" ? item.model : "unknown model",
        effort: typeof item.effort === "string" ? item.effort : "off",
        turns: typeof item.turns === "number" ? item.turns : 0,
        currentTool:
          typeof item.currentTool === "string" ? item.currentTool : undefined,
        queued: typeof item.queued === "number" ? item.queued : 0,
        createdAt:
          typeof item.createdAt === "number" ? item.createdAt : Date.now(),
        updatedAt:
          typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
        completedAt:
          typeof item.completedAt === "number" ? item.completedAt : undefined,
        error: typeof item.error === "string" ? item.error : undefined,
        usage:
          item.usage && typeof item.usage === "object"
            ? (asRecord(item.usage) as WebUsage)
            : undefined,
        transcript: Array.isArray(item.transcript)
          ? item.transcript.flatMap((entry) => {
              const transcript = asRecord(entry);
              return typeof transcript.timestamp === "number" &&
                typeof transcript.role === "string" &&
                typeof transcript.text === "string"
                ? [
                    {
                      timestamp: transcript.timestamp,
                      role: transcript.role,
                      text: transcript.text,
                    },
                  ]
                : [];
            })
          : undefined,
        streamingText:
          typeof item.streamingText === "string"
            ? item.streamingText
            : undefined,
      },
    ];
  });
}

function toolPresentation(name: string, args: Record<string, unknown>) {
  if (name === "bash")
    return {
      icon: TerminalSquare,
      verb: "Run",
      subject: shortened(String(args.command ?? "command")),
      detail: args.cwd ? String(args.cwd) : undefined,
    };
  if (name === "read") {
    const range = args.offset
      ? `lines ${args.offset}${args.limit ? `–${Number(args.offset) + Number(args.limit) - 1}` : ""}`
      : undefined;
    return {
      icon: FileText,
      verb: "Read",
      subject: String(args.path ?? "file"),
      detail: range,
    };
  }
  if (name === "write")
    return {
      icon: FileUp,
      verb: "Write",
      subject: String(args.path ?? "file"),
      detail:
        typeof args.content === "string"
          ? `${args.content.split("\n").length} lines`
          : undefined,
    };
  if (name === "edit")
    return {
      icon: FilePenLine,
      verb: "Edit",
      subject: String(args.path ?? "file"),
      detail: Array.isArray(args.edits)
        ? `${args.edits.length} change${args.edits.length === 1 ? "" : "s"}`
        : undefined,
    };
  if (name === "grep" || name === "find" || name === "search")
    return {
      icon: Search,
      verb: "Search",
      subject: String(args.pattern ?? args.query ?? args.path ?? name),
    };
  if (name.startsWith("subagent_"))
    return {
      icon: Bot,
      verb: name.replace("subagent_", "").replaceAll("_", " "),
      subject: String(args.name ?? args.id ?? "subagent"),
    };
  return { icon: Wrench, verb: name.replaceAll("_", " "), subject: "" };
}

type DiffRow = {
  kind: "context" | "removed" | "added" | "skip";
  oldLine?: number;
  newLine?: number;
  text: string;
  pairedText?: string;
};

function editDiffRows(
  oldText: string,
  newText: string,
  context = 3,
): DiffRow[] {
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
      for (const line of lines)
        all.push({
          kind: "removed",
          oldLine: oldLine++,
          text: line,
          pairedText: paired ? added.value[0] : undefined,
        });
      for (const line of added.value)
        all.push({
          kind: "added",
          newLine: newLine++,
          text: line,
          pairedText: paired ? lines[0] : undefined,
        });
      index += 1;
    } else if (change.removed) {
      for (const line of lines)
        all.push({ kind: "removed", oldLine: oldLine++, text: line });
    } else if (change.added) {
      for (const line of lines)
        all.push({ kind: "added", newLine: newLine++, text: line });
    } else {
      for (const line of lines)
        all.push({
          kind: "context",
          oldLine: oldLine++,
          newLine: newLine++,
          text: line,
        });
    }
  }
  const visible = new Set<number>();
  all.forEach((row, index) => {
    if (row.kind === "context") return;
    for (
      let cursor = Math.max(0, index - context);
      cursor <= Math.min(all.length - 1, index + context);
      cursor += 1
    )
      visible.add(cursor);
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
  return (
    {
      ts: "typescript",
      tsx: "typescript",
      js: "javascript",
      jsx: "javascript",
      mjs: "javascript",
      cjs: "javascript",
      json: "json",
      css: "css",
      scss: "scss",
      html: "xml",
      htm: "xml",
      xml: "xml",
      svg: "xml",
      sh: "bash",
      bash: "bash",
      zsh: "bash",
      py: "python",
      rb: "ruby",
      go: "go",
      rs: "rust",
      java: "java",
      kt: "kotlin",
      swift: "swift",
      yaml: "yaml",
      yml: "yaml",
      md: "markdown",
    } as Record<string, string>
  )[extension ?? ""];
}

function highlightedHtml(value: string, language?: string): string {
  if (!value || !language || !hljs.getLanguage(language))
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  return hljs.highlight(value, { language, ignoreIllegals: true }).value;
}

function ChangedLine({ row, language }: { row: DiffRow; language?: string }) {
  if (row.kind === "skip")
    return (
      <div className="semantic-diff-row semantic-diff-skip">
        <span />
        <span />
        <code>…</code>
      </div>
    );
  // Always compare old → new. A removed row stores old text in `text` and new
  // text in `pairedText`; an added row stores those fields in the opposite
  // order. Reversing this direction marks common words as removed.
  const oldText = row.kind === "removed" ? row.text : row.pairedText;
  const newText = row.kind === "added" ? row.text : row.pairedText;
  const pieces: Array<{ value: string; added?: boolean; removed?: boolean }> =
    oldText === undefined || newText === undefined
      ? [{ value: row.text }]
      : diffWords(oldText, newText);
  return (
    <div className={cn("semantic-diff-row", `semantic-diff-${row.kind}`)}>
      <span className="semantic-diff-sign">
        {row.kind === "removed" ? "−" : row.kind === "added" ? "+" : ""}
      </span>
      <span className="semantic-diff-number">
        {row.kind === "removed" ? row.oldLine : row.newLine}
      </span>
      <code>
        {pieces.map((piece, index) => {
          const highlighted =
            row.kind === "added"
              ? (piece.added ?? false)
              : row.kind === "removed"
                ? (piece.removed ?? false)
                : false;
          const hidden =
            row.kind === "added"
              ? (piece.removed ?? false)
              : row.kind === "removed"
                ? (piece.added ?? false)
                : false;
          return hidden ? null : (
            <HighlightedPiece
              key={`${index}-${piece.added ? "add" : "del"}-${piece.value.slice(0, 32)}`}
              highlighted={highlighted}
              text={piece.value}
              language={language}
            />
          );
        })}
      </code>
    </div>
  );
}

function HighlightedPiece({
  highlighted,
  text,
  language,
}: {
  highlighted: boolean;
  text: string;
  language?: string;
}) {
  const ref = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    if (ref.current) {
      ref.current.innerHTML = highlightedHtml(text, language);
    }
  }, [text, language]);
  return (
    <mark
      ref={ref}
      className={highlighted ? "semantic-diff-changed" : undefined}
    />
  );
}

function EditDiff({
  oldText,
  newText,
  language,
}: {
  oldText: string;
  newText: string;
  language?: string;
}) {
  return (
    <div className="semantic-edit-diff">
      {editDiffRows(oldText, newText).map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: diff rows are recomputed on every render and never reordered; index is stable here.
        <ChangedLine key={index} row={row} language={language} />
      ))}
    </div>
  );
}

function ArgumentDetails({
  name,
  args,
}: {
  name: string;
  args: Record<string, unknown>;
}) {
  if (name === "bash")
    return (
      <pre className="semantic-command">
        <span>$</span> {String(args.command ?? "")}
      </pre>
    );
  if (name === "write" && typeof args.content === "string") {
    return (
      <HighlightedCode
        text={args.content}
        language={syntaxLanguage(String(args.path ?? ""))}
      />
    );
  }
  if (name === "edit" && Array.isArray(args.edits)) {
    const language = syntaxLanguage(String(args.path ?? ""));
    return (
      <div className="semantic-edits">
        {args.edits.map((edit, index) => {
          const item = asRecord(edit);
          return (
            <EditDiff
              // biome-ignore lint/suspicious/noArrayIndexKey: edits come from tool args in submission order and never reorder within a single call.
              key={index}
              oldText={String(item.oldText ?? "")}
              newText={String(item.newText ?? "")}
              language={language}
            />
          );
        })}
      </div>
    );
  }
  const hidden = new Set(["path", "command", "content", "edits", "name", "id"]);
  const rest = Object.fromEntries(
    Object.entries(args).filter(([key]) => !hidden.has(key)),
  );
  return Object.keys(rest).length > 0 ? <DataValue value={rest} /> : null;
}

function ToolCallCard({
  name,
  args: input,
  running = false,
  result,
  expansionKey,
  expanded,
  autoFollowOutput = false,
  onExpansionChange,
}: {
  name: string;
  args: unknown;
  running?: boolean;
  result?: ToolResultView;
  expansionKey: string;
  expanded: boolean;
  autoFollowOutput?: boolean;
  onExpansionChange: (key: string, open: boolean, manual?: boolean) => void;
}) {
  const args = asRecord(input);
  const cardRef = React.useRef<HTMLDetailsElement | null>(null);
  const followInnerOutputRef = React.useRef(false);
  const previousAutoFollowRef = React.useRef(false);
  const presentation = toolPresentation(name, args);
  const Icon = running
    ? presentation.icon
    : result && !result.isError
      ? CheckCircle2
      : result?.isError
        ? X
        : presentation.icon;
  const subagents = name.startsWith("subagent_")
    ? subagentsFromDetails(result?.details)
    : [];

  React.useLayoutEffect(() => {
    if (autoFollowOutput && !previousAutoFollowRef.current)
      followInnerOutputRef.current = true;
    previousAutoFollowRef.current = autoFollowOutput;
    if (!autoFollowOutput || !expanded || !followInnerOutputRef.current) return;
    const card = cardRef.current;
    if (!card) return;
    for (const element of card.querySelectorAll<HTMLElement>(
      "pre, .semantic-edits, .semantic-data-documents",
    )) {
      if (element.scrollHeight > element.clientHeight)
        element.scrollTop = element.scrollHeight;
    }
  }, [autoFollowOutput, expanded]);

  return (
    <details
      ref={cardRef}
      data-expansion-key={expansionKey}
      className={cn(
        "semantic-tool-call",
        result?.isError && "border-red-500/35",
      )}
      open={expanded}
      onScrollCapture={(event) => {
        if (
          !autoFollowOutput ||
          !(event.target instanceof HTMLElement) ||
          event.target === cardRef.current
        )
          return;
        followInnerOutputRef.current =
          event.target.scrollHeight -
            event.target.scrollTop -
            event.target.clientHeight <=
          2;
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: <summary> is already a button-like disclosure; the rule fires anyway because onClick is used to coordinate controlled open state. */}
      <summary
        onClick={(event) => {
          event.preventDefault();
          onExpansionChange(expansionKey, !expanded, true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onExpansionChange(expansionKey, !expanded, true);
          }
        }}
      >
        <Icon
          className={cn(
            "semantic-tool-icon h-4 w-4",
            running && "animate-pulse text-emerald-400",
            !running && result && !result.isError && "text-emerald-400",
            !running && result?.isError && "text-red-300",
          )}
        />
        <span className="semantic-tool-verb">{presentation.verb}</span>
        {presentation.subject && (
          <span className="semantic-tool-subject">{presentation.subject}</span>
        )}
        <span className="semantic-tool-spacer" />
        {presentation.detail && (
          <span className="semantic-tool-detail">{presentation.detail}</span>
        )}
        <ChevronRight className="semantic-tool-chevron h-4 w-4" />
      </summary>
      {expanded && <ArgumentDetails name={name} args={args} />}
      {subagents.length > 0 && <SubagentRows agents={subagents} />}
      {result && (result.isError || (name !== "edit" && name !== "write")) && (
        <FormattedOutput text={result.output} toolName={name} args={args} />
      )}
    </details>
  );
}

const MessageCard = React.memo(function MessageCard({
  message,
  active = false,
  messageKey,
  expandedItems,
  autoFollowExpansionKey,
  onExpansionChange,
  onImageClick,
  toolResults,
  runningToolIds,
}: {
  message: Record<string, unknown>;
  active?: boolean;
  messageKey: string;
  expandedItems: ReadonlySet<string>;
  autoFollowExpansionKey?: string | null;
  onExpansionChange: (key: string, open: boolean, manual?: boolean) => void;
  onImageClick: (image: SemanticImage) => void;
  toolResults: ReadonlyMap<string, ToolResultView>;
  runningToolIds: ReadonlySet<string>;
}) {
  const role = typeof message.role === "string" ? message.role : "assistant";
  const parts = displayContentParts(message);
  const terminalNotice = assistantTerminalNotice(message);
  const messageTime = formatMessageTime(message.timestamp);
  const fullTimestamp = formatFullTimestamp(message.timestamp);
  if (role === "toolResult") return null;
  if (role === "bashExecution") {
    const expansionKey = `bash:${messageKey}`;
    return (
      <details className="semantic-tool" open={expandedItems.has(expansionKey)}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: <summary> is already a button-like disclosure; the rule fires anyway because onClick is used to coordinate controlled open state. */}
        <summary
          onClick={(event) => {
            event.preventDefault();
            onExpansionChange(
              expansionKey,
              !expandedItems.has(expansionKey),
              true,
            );
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onExpansionChange(
                expansionKey,
                !expandedItems.has(expansionKey),
                true,
              );
            }
          }}
        >
          <Wrench className="h-4 w-4" />
          <span className="semantic-tool-verb">bash</span>
          <span className="semantic-tool-spacer" />
          <ChevronRight className="semantic-tool-chevron h-4 w-4" />
        </summary>
        <pre>{String(message.output ?? "")}</pre>
      </details>
    );
  }
  return (
    <article
      className={cn(
        "semantic-message-group",
        role === "user" && "semantic-message-group-user",
      )}
    >
      <header>
        <span>{role === "user" ? "You" : "Pi"}</span>
        {messageTime && (
          <time
            className="semantic-message-time"
            dateTime={messageDate(message.timestamp)?.toISOString()}
            title={fullTimestamp ?? undefined}
          >
            {messageTime}
          </time>
        )}
        {active && <span className="semantic-streaming-dot" />}
      </header>
      <div
        className={cn(
          "semantic-message",
          role === "user"
            ? "semantic-message-user"
            : "semantic-message-assistant",
        )}
      >
        <div className="space-y-3">
          {parts.map((part, index) => {
            if (part.type === "text" && typeof part.text === "string") {
              const key = `${index}-text-${part.text.length}`;
              return <Markdown key={key}>{part.text}</Markdown>;
            }
            if (part.type === "thinking" && typeof part.thinking === "string") {
              return (
                <div
                  key={`${index}-thinking-${part.thinking.length}`}
                  className="semantic-thinking-flat"
                >
                  {thinkingLines(part.thinking).map((line, lineIndex) => (
                    <span key={`${lineIndex}-${line.slice(0, 32)}`}>
                      {line}
                    </span>
                  ))}
                </div>
              );
            }
            if (part.type === "toolCall") {
              const callId = String(part.id ?? `${messageKey}:${index}`);
              const expansionKey = `call:${callId}`;
              return (
                <ToolCallCard
                  // biome-ignore lint/suspicious/noArrayIndexKey: tool calls use callId as the stable id; index is only used because the surrounding map needs a key.
                  key={index}
                  name={String(part.name ?? "tool")}
                  args={part.arguments}
                  running={runningToolIds.has(callId)}
                  result={toolResults.get(callId)}
                  expansionKey={expansionKey}
                  expanded={expandedItems.has(expansionKey)}
                  autoFollowOutput={autoFollowExpansionKey === expansionKey}
                  onExpansionChange={onExpansionChange}
                />
              );
            }
            if (part.type === "image" && typeof part.data === "string") {
              const image: SemanticImage = {
                type: "image",
                data: part.data,
                mimeType:
                  typeof part.mimeType === "string"
                    ? part.mimeType
                    : "image/png",
                name: typeof part.name === "string" ? part.name : undefined,
              };
              return (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: image parts are appended in order from the model stream and never reordered; index is stable within a single message.
                  key={index}
                  type="button"
                  className="group block cursor-zoom-in rounded-xl text-left focus:outline-none focus:ring-2 focus:ring-sky-400/70"
                  aria-label={`Expand ${image.name ?? "attachment"}`}
                  onClick={() => onImageClick(image)}
                >
                  <img
                    className="max-h-80 rounded-xl border border-zinc-700 transition group-hover:border-zinc-400"
                    src={imageDataUrl(image)}
                    alt={image.name ?? "Attachment"}
                  />
                </button>
              );
            }
            return null;
          })}
          {terminalNotice && (
            <div
              className={cn(
                "semantic-terminal-notice",
                `is-${terminalNotice.kind}`,
              )}
              role="alert"
            >
              <strong>{terminalNotice.title}</strong>
              <span>{terminalNotice.detail}</span>
            </div>
          )}
        </div>
      </div>
    </article>
  );
});

export function updateStreamingMessage(
  current: Record<string, unknown> | null,
  delta: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = current
    ? { ...current }
    : { role: "assistant", content: [] };
  const content = Array.isArray(next.content)
    ? next.content.map((part) =>
        part && typeof part === "object"
          ? { ...(part as Record<string, unknown>) }
          : part,
      )
    : [];
  const index =
    typeof delta.contentIndex === "number"
      ? delta.contentIndex
      : content.length;
  const existing =
    content[index] && typeof content[index] === "object"
      ? (content[index] as Record<string, unknown>)
      : undefined;
  switch (delta.type) {
    case "text_start":
      content[index] = { type: "text", text: "" };
      break;
    case "text_delta":
      content[index] = {
        type: "text",
        text: `${existing?.text ?? ""}${String(delta.delta ?? "")}`,
      };
      break;
    case "text_end":
      content[index] = {
        type: "text",
        text: String(delta.content ?? existing?.text ?? ""),
      };
      break;
    case "thinking_start":
      content[index] = {
        type: "thinking",
        thinking: "",
        startedAt: Date.now(),
      };
      break;
    case "thinking_delta":
      content[index] = {
        type: "thinking",
        thinking: `${existing?.thinking ?? ""}${String(delta.delta ?? "")}`,
      };
      break;
    case "thinking_end":
      content[index] = {
        type: "thinking",
        thinking: String(delta.content ?? existing?.thinking ?? ""),
        startedAt: existing?.startedAt,
        endedAt: Date.now(),
      };
      break;
    case "toolcall_start":
      content[index] = {
        type: "toolCall",
        name: delta.name,
        id: delta.id,
        arguments: {},
      };
      break;
    case "toolcall_end":
      content[index] = delta.toolCall ?? existing ?? { type: "toolCall" };
      break;
  }
  next.content = content;
  return next;
}

function QueuedMessageRow({
  item,
  overlay = false,
  overlayWidth,
  blocked = false,
  steering = false,
  steerDisabled = false,
  onEdit,
  onRemove,
  onSteer,
  onReconcile,
}: {
  item: WebQueuedMessage;
  overlay?: boolean;
  overlayWidth?: number | null;
  blocked?: boolean;
  steering?: boolean;
  steerDisabled?: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onSteer: () => void;
  onReconcile: (action: "discard" | "resubmit") => void;
}) {
  const uncertain = item.deliveryState === "delivering";
  const sortable = useSortable({
    id: overlay ? `overlay:${item.id}` : item.id,
    disabled: overlay || uncertain || blocked,
  });
  const style: React.CSSProperties | undefined = overlay
    ? overlayWidth
      ? { width: overlayWidth }
      : undefined
    : {
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      };
  return (
    <div
      ref={overlay ? undefined : sortable.setNodeRef}
      data-queue-item-id={overlay ? undefined : item.id}
      style={style}
      className={cn(
        "semantic-queue-item",
        sortable.isDragging && "is-sortable-dragging",
        overlay && "is-overlay",
        uncertain && "is-uncertain",
        blocked && "is-blocked",
      )}
    >
      {overlay ? (
        <GripVertical
          className="semantic-queue-grip h-4 w-4"
          aria-hidden="true"
        />
      ) : (
        <button
          type="button"
          className="semantic-queue-grip"
          title="Drag to reorder"
          aria-label="Drag queued message"
          {...sortable.attributes}
          {...sortable.listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
      )}
      {item.images?.[0] && (
        <img
          draggable={false}
          src={`data:${item.images[0].mimeType};base64,${item.images[0].data}`}
          alt="Queued attachment"
        />
      )}
      <span>
        {item.message || "Image attachment"}
        {uncertain
          ? " · delivery uncertain"
          : blocked
            ? " · blocked by uncertain item"
            : ""}
      </span>
      {!overlay && uncertain && (
        <button
          type="button"
          title="Discard uncertain message"
          onClick={() => onReconcile("discard")}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
      {!overlay && uncertain && (
        <button
          type="button"
          title="Confirm and resubmit uncertain message"
          onClick={() => onReconcile("resubmit")}
        >
          <Send className="h-4 w-4" />
        </button>
      )}
      {!overlay && !uncertain && !blocked && (
        <button
          type="button"
          title="Edit queued message"
          aria-label="Edit queued message"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onEdit}
        >
          <Pencil className="h-4 w-4" />
        </button>
      )}
      {!overlay && !uncertain && !blocked && (
        <button
          type="button"
          title="Remove queued message"
          aria-label="Remove queued message"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
      {!overlay && !uncertain && !blocked && (
        <button
          type="button"
          title="Send now to steer Pi"
          aria-label="Send queued message now to steer Pi"
          disabled={steerDisabled}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onSteer}
        >
          {steering ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <ArrowUp className="h-4 w-4" />
          )}
        </button>
      )}
    </div>
  );
}

export function SemanticSession({
  session,
  entries,
  historyRevision,
  streamingMessage,
  streamingMessageKey: providedStreamingMessageKey,
  tools,
  error,
  connected,
  transcriptLoading,
  queuedMessages,
  sessionOptions,
  onSelectModel,
  onSelectThinkingLevel,
  onSend,
  onReplaceQueue,
  onSteerQueuedMessage,
  onReconcileQueue,
  onAbort,
}: SemanticSessionProps) {
  const [draft, setDraft] = React.useState(() => loadSessionDraft(session?.id));
  const [images, setImages] = React.useState<SemanticImage[]>([]);
  const [previewImage, setPreviewImage] = React.useState<SemanticImage | null>(
    null,
  );
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [sendNotice, setSendNotice] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [aborting, setAborting] = React.useState(false);
  const [draggingAttachments, setDraggingAttachments] = React.useState(false);
  const [editingQueueId, setEditingQueueId] = React.useState<string | null>(
    null,
  );
  const [draggingQueueId, setDraggingQueueId] = React.useState<string | null>(
    null,
  );
  const [draggingQueueWidth, setDraggingQueueWidth] = React.useState<
    number | null
  >(null);
  const [steeringQueueId, setSteeringQueueId] = React.useState<string | null>(
    null,
  );
  const queueSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const [modelMenuOpen, setModelMenuOpen] = React.useState(false);
  const [sendMenuOpen, setSendMenuOpen] = React.useState(false);
  const [selectedSubagentId, setSelectedSubagentId] = React.useState<
    string | null
  >(null);
  const [subagentsMinimized, setSubagentsMinimized] = React.useState(() =>
    loadSubagentsMinimized(session?.id),
  );
  const [slashMenuDismissed, setSlashMenuDismissed] = React.useState(false);
  const [selectedSlashCommand, setSelectedSlashCommand] = React.useState(0);
  const [showScrollToBottom, setShowScrollToBottom] = React.useState(false);
  const [controlBusy, setControlBusy] = React.useState(false);
  const [expandedItems, setExpandedItems] = React.useState<Set<string>>(
    () => new Set(),
  );
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const scrollSpacerRef = React.useRef<HTMLDivElement | null>(null);
  const lockedScrollHeightRef = React.useRef<number | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const slashMenuRef = React.useRef<HTMLDivElement | null>(null);
  const modelButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const sendMenuButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const draftBeforeQueueEditRef = React.useRef<{
    draft: string;
    images: SemanticImage[];
  } | null>(null);
  const initialScrollSessionRef = React.useRef<string | null>(null);
  const initialScrollPendingRef = React.useRef(true);
  const followOutputRef = React.useRef(true);
  const showScrollToBottomRef = React.useRef(false);
  const scrollIntentRef = React.useRef<"up" | "down" | null>(null);
  const scrollbarPointerRef = React.useRef(false);
  const lastTouchYRef = React.useRef<number | null>(null);
  const lastScrollTopRef = React.useRef(0);
  const autoScrollFrameRef = React.useRef<number | null>(null);
  const historyRevisionRef = React.useRef(historyRevision);
  const manuallyExpandedRef = React.useRef(new Set<string>());
  const autoExpandedRef = React.useRef<string | null>(null);
  const viewportAnchorRef = React.useRef<{
    element: HTMLElement | null;
    range: Range | null;
    rangeTop: number;
    key: string | null;
    top: number;
    keyTop: number;
    fallbacks: Array<{ key: string; top: number }>;
    scrollTop: number;
  } | null>(null);

  React.useLayoutEffect(() => {
    if (historyRevisionRef.current === historyRevision) return;
    historyRevisionRef.current = historyRevision;
    lockedScrollHeightRef.current = null;
    viewportAnchorRef.current = null;
    followOutputRef.current = true;
    scrollIntentRef.current = null;
    if (scrollSpacerRef.current) scrollSpacerRef.current.style.height = "0px";
    if (scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    showScrollToBottomRef.current = false;
    setShowScrollToBottom(false);
    setExpandedItems(new Set());
    manuallyExpandedRef.current.clear();
    autoExpandedRef.current = null;
  }, [historyRevision]);

  const updateScrollButton = React.useCallback((visible: boolean) => {
    showScrollToBottomRef.current = visible;
    setShowScrollToBottom(visible);
  }, []);

  const captureViewportAnchor = React.useCallback(() => {
    const target = scrollRef.current;
    if (
      !target ||
      (!showScrollToBottomRef.current && followOutputRef.current)
    ) {
      viewportAnchorRef.current = null;
      return;
    }
    const viewport = target.getBoundingClientRect();
    const anchors = Array.from(
      target.querySelectorAll<HTMLElement>("[data-transcript-anchor]"),
    );
    const anchorIndex = anchors.findIndex(
      (candidate) =>
        candidate.getBoundingClientRect().bottom > viewport.top + 1,
    );
    const messageAnchor = anchorIndex >= 0 ? anchors[anchorIndex] : null;
    let element: HTMLElement | null = messageAnchor;
    let range: Range | null = null;
    let rangeTop = viewport.top;
    const caretDocument = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    for (const x of [
      viewport.left + Math.min(32, viewport.width / 4),
      viewport.left + viewport.width / 2,
    ]) {
      const hit = document.elementFromPoint(x, viewport.top + 2);
      if (!(hit instanceof HTMLElement) || !messageAnchor?.contains(hit))
        continue;
      element = hit;
      const candidateRange =
        caretDocument.caretRangeFromPoint?.(x, viewport.top + 2) ?? null;
      const candidateNode = candidateRange?.startContainer;
      const candidateElement =
        candidateNode instanceof Element
          ? candidateNode
          : candidateNode?.parentNode instanceof Element
            ? candidateNode.parentNode
            : null;
      const candidateRect = candidateRange?.getBoundingClientRect();
      if (
        candidateRange &&
        candidateElement &&
        messageAnchor.contains(candidateElement) &&
        candidateRect &&
        candidateRect.height > 0
      ) {
        range = candidateRange.cloneRange();
        rangeTop = candidateRect.top;
      }
      break;
    }
    const key = messageAnchor?.dataset.transcriptAnchor ?? null;
    viewportAnchorRef.current = {
      element,
      range,
      rangeTop,
      key,
      top: element?.getBoundingClientRect().top ?? viewport.top,
      keyTop: messageAnchor?.getBoundingClientRect().top ?? viewport.top,
      fallbacks:
        anchorIndex < 0
          ? []
          : anchors.slice(anchorIndex, anchorIndex + 5).flatMap((candidate) => {
              const candidateKey = candidate.dataset.transcriptAnchor;
              return candidateKey
                ? [
                    {
                      key: candidateKey,
                      top: candidate.getBoundingClientRect().top,
                    },
                  ]
                : [];
            }),
      scrollTop: target.scrollTop,
    };
  }, []);

  const maintainLockedScrollExtent = React.useCallback(() => {
    const target = scrollRef.current;
    const spacer = scrollSpacerRef.current;
    if (!target || !spacer) return;
    if (!showScrollToBottomRef.current && followOutputRef.current) {
      lockedScrollHeightRef.current = null;
      spacer.style.height = "0px";
      return;
    }
    lockedScrollHeightRef.current ??= target.scrollHeight;
    const naturalScrollHeight = target.scrollHeight - spacer.offsetHeight;
    const anchoredMinimum =
      (viewportAnchorRef.current?.scrollTop ?? target.scrollTop) +
      target.clientHeight +
      1;
    const requiredScrollHeight = Math.max(
      lockedScrollHeightRef.current,
      anchoredMinimum,
    );
    spacer.style.height = `${Math.max(0, requiredScrollHeight - naturalScrollHeight)}px`;
  }, []);

  const restoreViewportAnchor = React.useCallback(() => {
    maintainLockedScrollExtent();
    const target = scrollRef.current;
    const anchor = viewportAnchorRef.current;
    if (
      !target ||
      !anchor ||
      (!showScrollToBottomRef.current && followOutputRef.current)
    )
      return;
    const currentAnchors = Array.from(
      target.querySelectorAll<HTMLElement>("[data-transcript-anchor]"),
    );
    const rangeNode = anchor.range?.startContainer;
    const rangeRect = rangeNode?.isConnected
      ? anchor.range?.getBoundingClientRect()
      : undefined;
    if (rangeRect && rangeRect.height > 0) {
      target.scrollTop = anchoredScrollTop(
        target.scrollTop,
        anchor.rangeTop,
        rangeRect.top,
      );
    } else if (anchor.element?.isConnected) {
      target.scrollTop = anchoredScrollTop(
        target.scrollTop,
        anchor.top,
        anchor.element.getBoundingClientRect().top,
      );
    } else {
      const fallback =
        anchor.fallbacks.flatMap((candidate) => {
          const element = currentAnchors.find(
            (current) => current.dataset.transcriptAnchor === candidate.key,
          );
          return element ? [{ element, top: candidate.top }] : [];
        })[0] ??
        (anchor.key
          ? (() => {
              const element = currentAnchors.find(
                (current) => current.dataset.transcriptAnchor === anchor.key,
              );
              return element ? { element, top: anchor.keyTop } : undefined;
            })()
          : undefined);
      target.scrollTop = fallback
        ? anchoredScrollTop(
            target.scrollTop,
            fallback.top,
            fallback.element.getBoundingClientRect().top,
          )
        : anchor.scrollTop;
    }
    lastScrollTopRef.current = target.scrollTop;
    captureViewportAnchor();
  }, [captureViewportAnchor, maintainLockedScrollExtent]);

  const stopFollowing = React.useCallback(() => {
    const target = scrollRef.current;
    if (followOutputRef.current && target)
      lockedScrollHeightRef.current = target.scrollHeight;
    followOutputRef.current = false;
    scrollIntentRef.current = "up";
    if (autoScrollFrameRef.current !== null)
      cancelAnimationFrame(autoScrollFrameRef.current);
    autoScrollFrameRef.current = null;
    updateScrollButton(true);
    maintainLockedScrollExtent();
    captureViewportAnchor();
  }, [captureViewportAnchor, maintainLockedScrollExtent, updateScrollButton]);

  const openImagePreview = React.useCallback((image: SemanticImage) => {
    setPreviewImage(image);
  }, []);
  const closeImagePreview = React.useCallback(() => {
    setPreviewImage(null);
  }, []);

  React.useEffect(() => {
    setSendNotice(null);
    setAborting(false);
  }, []);

  React.useEffect(() => {
    if (session?.status !== "working") setAborting(false);
  }, [session?.status]);

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
        const callId =
          typeof entry.message.toolCallId === "string"
            ? entry.message.toolCallId
            : "";
        if (callId)
          results.set(
            callId,
            toolResultView(entry.message, entry.message.isError === true),
          );
        continue;
      }
      visible.push({
        message: entry.message,
        key: String(
          entry.id ??
            entry.message.id ??
            entry.message.timestamp ??
            `message-${index}`,
        ),
        endedAt: entry.timestamp ? Date.parse(entry.timestamp) : undefined,
      });
    }
    return { messages: visible, toolResults: results };
  }, [entries]);

  if (initialScrollSessionRef.current !== session?.id) {
    initialScrollSessionRef.current = session?.id ?? null;
    initialScrollPendingRef.current = true;
    followOutputRef.current = true;
    showScrollToBottomRef.current = false;
    scrollIntentRef.current = null;
    viewportAnchorRef.current = null;
    lockedScrollHeightRef.current = null;
  }

  React.useEffect(() => {
    setExpandedItems(new Set());
    manuallyExpandedRef.current.clear();
    autoExpandedRef.current = null;
  }, []);

  const handleExpansionChange = React.useCallback(
    (key: string, open: boolean, manual = false) => {
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
    },
    [],
  );

  const streamingToolResults = React.useMemo(() => {
    const results = new Map(toolResults);
    for (const tool of tools) {
      if (tool.result !== undefined)
        results.set(
          tool.id,
          toolResultView(tool.result, tool.isError === true),
        );
    }
    return results;
  }, [toolResults, tools]);
  const runningToolIds = React.useMemo(
    () => new Set(tools.filter((tool) => tool.running).map((tool) => tool.id)),
    [tools],
  );
  const representedToolIds = React.useMemo(() => {
    const ids = new Set<string>();
    const visit = (message: Record<string, unknown>) => {
      for (const part of contentParts(message)) {
        if (part.type === "toolCall" && typeof part.id === "string")
          ids.add(part.id);
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

  const streamingMessageKey =
    providedStreamingMessageKey ??
    (streamingMessage
      ? String(
          streamingMessage.id ??
            streamingMessage.timestamp ??
            "streaming-assistant",
        )
      : "streaming-assistant");

  const latestCard = React.useMemo(() => {
    type Candidate = { key: string; expandable: boolean };
    const card = (
      message: Record<string, unknown>,
      messageKey: string,
    ): Candidate | null => {
      const parts = contentParts(message);
      for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
        const part = parts[partIndex];
        if (
          part.type === "text" &&
          typeof part.text === "string" &&
          part.text.length > 0
        ) {
          return { key: `text:${messageKey}:${partIndex}`, expandable: false };
        }
        if (part.type === "toolCall") {
          const callId = String(part.id ?? `${messageKey}:${partIndex}`);
          const result = streamingToolResults.get(callId);
          return {
            key: `call:${callId}`,
            expandable:
              toolHasArgumentDetails(
                String(part.name ?? "tool"),
                part.arguments,
              ) ||
              Boolean(
                result &&
                  (result.output.trim() || result.details !== undefined),
              ),
          };
        }
        if (part.type === "thinking") {
          return {
            key: `thinking:${String(message.timestamp ?? messageKey)}:${partIndex}`,
            expandable: false,
          };
        }
      }
      return null;
    };
    if (streamingMessage) return card(streamingMessage, streamingMessageKey);
    const orphan = orphanTools.at(-1);
    if (orphan) {
      const result = streamingToolResults.get(orphan.id);
      return {
        key: `call:${orphan.id}`,
        expandable:
          toolHasArgumentDetails(orphan.name, orphan.args) ||
          Boolean(
            result && (result.output.trim() || result.details !== undefined),
          ),
      };
    }
    for (
      let messageIndex = messages.length - 1;
      messageIndex >= 0;
      messageIndex -= 1
    ) {
      const candidate = card(
        messages[messageIndex].message,
        messages[messageIndex].key,
      );
      if (candidate) return candidate;
    }
    return null;
  }, [
    messages,
    orphanTools,
    streamingMessage,
    streamingMessageKey,
    streamingToolResults,
  ]);

  const latestCardKey = latestCard?.key ?? null;
  const latestExpandableKey = latestCard?.expandable ? latestCard.key : null;
  const autoFollowExpansionKey =
    latestExpandableKey && !manuallyExpandedRef.current.has(latestExpandableKey)
      ? latestExpandableKey
      : null;

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
    if (!target || transcriptLoading || !initialScrollPendingRef.current)
      return;
    const scrollToEnd = () => {
      if (!followOutputRef.current || showScrollToBottomRef.current) return;
      target.scrollTop = target.scrollHeight;
      lastScrollTopRef.current = target.scrollTop;
    };
    followOutputRef.current = true;
    updateScrollButton(false);
    scrollToEnd();
    const frame = requestAnimationFrame(() => {
      scrollToEnd();
      initialScrollPendingRef.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [transcriptLoading, updateScrollButton]);

  React.useEffect(() => {
    const target = scrollRef.current;
    if (!target) return;
    const pinToBottom = () => {
      if (!followOutputRef.current || showScrollToBottomRef.current) return;
      target.scrollTop = target.scrollHeight;
      lastScrollTopRef.current = target.scrollTop;
    };
    const handleLayoutChange = () => {
      if (autoScrollFrameRef.current !== null)
        cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = requestAnimationFrame(() => {
        autoScrollFrameRef.current = null;
        if (!followOutputRef.current || showScrollToBottomRef.current) {
          restoreViewportAnchor();
          return;
        }
        pinToBottom();
      });
    };
    const transcript = target.firstElementChild;
    const resizeObserver = new ResizeObserver(handleLayoutChange);
    const mutationObserver = new MutationObserver(handleLayoutChange);
    resizeObserver.observe(target);
    if (transcript) {
      resizeObserver.observe(transcript);
      mutationObserver.observe(transcript, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
    if (!followOutputRef.current || showScrollToBottomRef.current)
      captureViewportAnchor();
    handleLayoutChange();
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (autoScrollFrameRef.current !== null)
        cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    };
  }, [captureViewportAnchor, restoreViewportAnchor]);

  const addFiles = async (files: File[]) => {
    try {
      const next = await Promise.all(files.slice(0, 4).map(fileAsImage));
      const combined = [...images, ...next].slice(0, 4);
      if (session) {
        assertClientPromptPayloadFits({
          type: "client.prompt",
          requestId: "00000000-0000-4000-8000-000000000000",
          sessionId: session.id,
          message: draft.trim(),
          images: combined,
        });
      }
      setImages(combined);
      setSendError(null);
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      requestAnimationFrame(() =>
        textareaRef.current?.focus({ preventScroll: true }),
      );
    }
  };

  const editQueuedMessage = (item: WebQueuedMessage) => {
    if (!editingQueueId) draftBeforeQueueEditRef.current = { draft, images };
    setEditingQueueId(item.id);
    setDraft(item.message);
    setImages(item.images ?? []);
    requestAnimationFrame(() =>
      textareaRef.current?.focus({ preventScroll: true }),
    );
  };

  const finishQueueEditing = () => {
    const previous = draftBeforeQueueEditRef.current;
    draftBeforeQueueEditRef.current = null;
    setEditingQueueId(null);
    setDraft(previous?.draft ?? loadSessionDraft(session?.id));
    setImages(previous?.images ?? []);
  };

  const removeQueuedMessage = async (item: WebQueuedMessage) => {
    await onReplaceQueue(
      queuedMessages.filter((queued) => queued.id !== item.id),
    );
  };

  const steerQueuedMessage = async (item: WebQueuedMessage) => {
    if (steeringQueueId) return;
    setSteeringQueueId(item.id);
    try {
      await onSteerQueuedMessage(item.id);
      if (editingQueueId === item.id) finishQueueEditing();
      setSendError(null);
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSteeringQueueId(null);
    }
  };

  const reconcileQueuedMessage = async (
    item: WebQueuedMessage,
    action: "discard" | "resubmit",
  ) => {
    const verb =
      action === "discard"
        ? "permanently discard"
        : "resubmit (this may duplicate a prompt Pi already accepted)";
    if (!window.confirm(`Confirm ${verb}?`)) return;
    try {
      await onReconcileQueue(item.id, action);
      setSendError(null);
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const finishQueueDrag = async (event: DragEndEvent) => {
    setDraggingQueueId(null);
    setDraggingQueueWidth(null);
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId || activeId === overId) return;
    const activeIndex = queuedMessages.findIndex(
      (item) => item.id === activeId,
    );
    const overIndex = queuedMessages.findIndex((item) => item.id === overId);
    if (activeIndex < 0 || overIndex < 0) return;
    const placement =
      activeIndex < overIndex ? { afterId: overId } : { beforeId: overId };
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
      requestAnimationFrame(() =>
        textareaRef.current?.focus({ preventScroll: true }),
      );
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
      requestAnimationFrame(() =>
        textareaRef.current?.focus({ preventScroll: true }),
      );
    }
  };

  const modelLabel = session?.model?.split("/").pop() ?? "Model";
  const effortLabel = session?.thinkingLevel ?? "off";
  const availableModels =
    sessionOptions.models.length > 0
      ? sessionOptions.models
      : (() => {
          const slashIndex = session?.model?.indexOf("/") ?? -1;
          if (!session?.model || slashIndex < 0) return [];
          return [
            {
              provider: session.model.slice(0, slashIndex),
              id: session.model.slice(slashIndex + 1),
              name: modelLabel,
              reasoning: true,
            },
          ];
        })();
  const availableEfforts =
    sessionOptions.thinkingLevels.length > 0
      ? sessionOptions.thinkingLevels
      : ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const slashMatch = editingQueueId ? null : draft.match(/^\/([^\s]*)$/);
  const slashQuery = slashMatch?.[1] ?? "";
  const matchingSlashCommands = React.useMemo(
    () =>
      slashMatch
        ? filterSlashCommands(sessionOptions.commands ?? [], slashQuery)
        : [],
    [sessionOptions.commands, slashMatch?.[0], slashQuery],
  );
  const slashMenuOpen = !slashMenuDismissed && matchingSlashCommands.length > 0;
  const activeSkillInvocation = React.useMemo(() => {
    const name = draft.match(/^\/([^\s]+)(?:\s|$)/)?.[1];
    return name
      ? sessionOptions.commands.find(
          (command) => command.name === name && command.source === "skill",
        )
      : undefined;
  }, [draft, sessionOptions.commands]);

  React.useEffect(() => {
    setSelectedSlashCommand(0);
  }, []);

  React.useEffect(() => {
    if (!slashMenuOpen) return;
    slashMenuRef.current
      ?.querySelector(`[data-command-index="${selectedSlashCommand}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedSlashCommand, slashMenuOpen]);

  const insertSlashCommand = React.useCallback((command: WebSlashCommand) => {
    setDraft(`/${command.name} `);
    setSlashMenuDismissed(true);
    requestAnimationFrame(() =>
      textareaRef.current?.focus({ preventScroll: true }),
    );
  }, []);

  const isWorking =
    session?.status === "working" || tools.some((tool) => tool.running);
  const jumpToBottom = React.useCallback(() => {
    const target = scrollRef.current;
    if (!target) return;
    followOutputRef.current = true;
    scrollIntentRef.current = null;
    viewportAnchorRef.current = null;
    lockedScrollHeightRef.current = null;
    if (scrollSpacerRef.current) scrollSpacerRef.current.style.height = "0px";
    updateScrollButton(false);
    target.scrollTo({ top: target.scrollHeight, behavior: "smooth" });
  }, [updateScrollButton]);
  const latestAssistantIndex = lastAssistantMessageIndex(messages);
  const selectedSubagent =
    session?.subagents?.find((agent) => agent.id === selectedSubagentId) ??
    null;
  const displayedSubagentUsage = React.useMemo(
    () => totalSubagentUsage(session?.subagents ?? []),
    [session?.subagents],
  );

  const stopAction =
    !editingQueueId &&
    Boolean(session && hasActiveSessionWork(session)) &&
    !draft.trim() &&
    images.length === 0;

  const requestAbort = async () => {
    if (!session || aborting) return;
    setAborting(true);
    setSendError(null);
    setSendNotice("Stopping…");
    try {
      await onAbort();
      setSendNotice("Stop requested");
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : String(cause));
      setSendNotice(null);
      setAborting(false);
    }
  };

  const submit = async (
    behavior?: "steer" | "followUp",
    messageOverride?: string,
  ) => {
    const message = (messageOverride ?? draft).trim();
    if ((!message && images.length === 0) || sending || !session) return;
    try {
      assertClientPromptPayloadFits({
        type: "client.prompt",
        requestId: "00000000-0000-4000-8000-000000000000",
        sessionId: session.id,
        message,
        images,
        streamingBehavior: behavior,
      });
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setSending(true);
    setSendNotice(null);
    try {
      if (editingQueueId) {
        await onReplaceQueue(
          queuedMessages.map((item) =>
            item.id === editingQueueId ? { ...item, message, images } : item,
          ),
        );
        finishQueueEditing();
      } else {
        const queuesFollowUp =
          behavior === "followUp" && session.status === "working";
        if (!queuesFollowUp) {
          // Sending is an explicit navigation intent: reveal the local bubble
          // immediately even if passive transcript updates were left unpinned.
          const target = scrollRef.current;
          followOutputRef.current = true;
          scrollIntentRef.current = null;
          viewportAnchorRef.current = null;
          lockedScrollHeightRef.current = null;
          if (scrollSpacerRef.current)
            scrollSpacerRef.current.style.height = "0px";
          updateScrollButton(false);
          if (target) {
            target.scrollTop = target.scrollHeight;
            lastScrollTopRef.current = target.scrollTop;
          }
        }
        const submittedImages = images;
        // Delivery can remain pending for long-running control commands such as
        // /compact. Clear immediately so a delivered command never looks unsent.
        setDraft("");
        setImages([]);
        try {
          await onSend(message, submittedImages, behavior);
        } catch (cause) {
          setDraft((current) => current || message);
          setImages((current) =>
            current.length > 0 ? current : submittedImages,
          );
          throw cause;
        }
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
      <ImageLightboxDialog
        image={previewImage}
        onOpenChange={(open) => {
          if (!open) closeImagePreview();
        }}
      />
      <SubagentOutputDialog
        agent={selectedSubagent}
        onOpenChange={(open) => {
          if (!open) setSelectedSubagentId(null);
        }}
      />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: this is a custom scroll container with wheel/touch tracking, not a clickable element; role="region" would force an aria-label and tabIndex that don't fit the layout. */}
      <div
        ref={scrollRef}
        data-testid="transcript-scroll"
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain [overflow-anchor:none]"
        onWheel={(event) => {
          scrollIntentRef.current = event.deltaY < 0 ? "up" : "down";
          if (event.deltaY < 0) stopFollowing();
        }}
        onTouchStart={(event) => {
          lastTouchYRef.current = event.touches[0]?.clientY ?? null;
        }}
        onTouchMove={(event) => {
          const currentY = event.touches[0]?.clientY;
          const previousY = lastTouchYRef.current;
          if (currentY === undefined || previousY === null) return;
          // Finger moving down scrolls transcript content upward, away from bottom.
          scrollIntentRef.current = currentY > previousY ? "up" : "down";
          if (scrollIntentRef.current === "up") stopFollowing();
          lastTouchYRef.current = currentY;
        }}
        onTouchEnd={() => {
          lastTouchYRef.current = null;
          scrollIntentRef.current = null;
        }}
        onPointerDown={(event) => {
          const target = event.currentTarget;
          const bounds = target.getBoundingClientRect();
          if (event.clientX >= bounds.left + target.clientWidth) {
            scrollbarPointerRef.current = true;
            lastScrollTopRef.current = target.scrollTop;
          }
        }}
        onPointerUp={() => {
          scrollbarPointerRef.current = false;
          scrollIntentRef.current = null;
        }}
        onPointerCancel={() => {
          scrollbarPointerRef.current = false;
          scrollIntentRef.current = null;
        }}
        onKeyDown={(event) => {
          if (
            event.key === "ArrowUp" ||
            event.key === "PageUp" ||
            event.key === "Home"
          ) {
            scrollIntentRef.current = "up";
            stopFollowing();
          } else if (
            event.key === "ArrowDown" ||
            event.key === "PageDown" ||
            event.key === "End"
          ) {
            scrollIntentRef.current = "down";
          }
        }}
        onScroll={(event) => {
          const target = event.currentTarget;
          if (
            scrollbarPointerRef.current &&
            target.scrollTop !== lastScrollTopRef.current
          ) {
            scrollIntentRef.current =
              target.scrollTop < lastScrollTopRef.current ? "up" : "down";
            if (scrollIntentRef.current === "up") stopFollowing();
          }
          const decision = resolveScrollFollow(
            followOutputRef.current,
            target.scrollHeight - target.scrollTop - target.clientHeight,
            undefined,
            scrollIntentRef.current === "down",
          );
          followOutputRef.current = decision.following;
          updateScrollButton(decision.showButton);
          if (decision.following && !decision.showButton) {
            lockedScrollHeightRef.current = null;
            viewportAnchorRef.current = null;
            if (scrollSpacerRef.current)
              scrollSpacerRef.current.style.height = "0px";
          }
          lastScrollTopRef.current = target.scrollTop;
          if (!decision.following) captureViewportAnchor();
          scrollIntentRef.current = null;
          if (decision.pinToBottom) {
            if (autoScrollFrameRef.current !== null)
              cancelAnimationFrame(autoScrollFrameRef.current);
            autoScrollFrameRef.current = requestAnimationFrame(() => {
              autoScrollFrameRef.current = null;
              if (followOutputRef.current && !showScrollToBottomRef.current)
                target.scrollTop = target.scrollHeight;
            });
          }
        }}
      >
        <div className="flex w-full flex-col gap-4 px-4 pb-8 pt-16 sm:px-6 xl:pt-8">
          {transcriptLoading && messages.length === 0 && !streamingMessage && (
            <output
              className="semantic-transcript-loading"
              aria-label="Loading transcript"
            >
              <div />
              <div />
              <div />
            </output>
          )}
          {!transcriptLoading &&
            messages.length === 0 &&
            !streamingMessage &&
            orphanTools.length === 0 && (
              <div className="py-24 text-center text-sm text-zinc-500">
                {session
                  ? "No messages in this session yet."
                  : "Select a session."}
              </div>
            )}
          {messages.map((view, index) => (
            <div key={view.key} data-transcript-anchor={view.key}>
              <MessageCard
                message={view.message}
                active={
                  !streamingMessage &&
                  isWorking &&
                  index === latestAssistantIndex
                }
                messageKey={view.key}
                expandedItems={expandedItems}
                autoFollowExpansionKey={autoFollowExpansionKey}
                onExpansionChange={handleExpansionChange}
                onImageClick={openImagePreview}
                toolResults={streamingToolResults}
                runningToolIds={runningToolIds}
              />
            </div>
          ))}
          {streamingMessage && (
            <div data-transcript-anchor={streamingMessageKey}>
              <MessageCard
                message={streamingMessage}
                active={isWorking}
                messageKey={streamingMessageKey}
                expandedItems={expandedItems}
                autoFollowExpansionKey={autoFollowExpansionKey}
                onExpansionChange={handleExpansionChange}
                onImageClick={openImagePreview}
                toolResults={streamingToolResults}
                runningToolIds={runningToolIds}
              />
            </div>
          )}
          {session?.compaction && (
            <div data-transcript-anchor="compaction">
              <CompactionStatus session={session} />
            </div>
          )}
          {!session?.compaction &&
            !streamingMessage &&
            latestAssistantIndex < 0 &&
            isWorking && (
              <div
                data-transcript-anchor="activity"
                className="semantic-activity-label"
              >
                <span>Pi</span>
                <span className="semantic-streaming-dot" />
              </div>
            )}
          {orphanTools.map((tool) => {
            const callKey = `call:${tool.id}`;
            return (
              <div key={tool.id} data-transcript-anchor={callKey}>
                <ToolCallCard
                  name={tool.name}
                  args={tool.args}
                  running={tool.running}
                  result={
                    tool.result === undefined
                      ? undefined
                      : toolResultView(tool.result, tool.isError === true)
                  }
                  expansionKey={callKey}
                  expanded={expandedItems.has(callKey)}
                  autoFollowOutput={autoFollowExpansionKey === callKey}
                  onExpansionChange={handleExpansionChange}
                />
              </div>
            );
          })}
        </div>
        <div ref={scrollSpacerRef} aria-hidden="true" className="shrink-0" />
      </div>
      {showScrollToBottom && (
        <div className="relative z-30 h-0">
          <button
            type="button"
            className="semantic-scroll-bottom"
            title="Scroll to bottom"
            aria-label="Scroll to bottom"
            onClick={jumpToBottom}
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        </div>
      )}
      <div className="semantic-session-composer bg-zinc-950/95 p-3 backdrop-blur sm:p-4">
        <div className="w-full">
          {session?.subagents && session.subagents.length > 0 && (
            <div
              className={cn(
                "semantic-live-subagents",
                subagentsMinimized && "is-minimized",
              )}
            >
              <div className="semantic-live-subagents-header">
                <div className="semantic-queue-label">
                  Subagents · {session.subagents.length} ·{" "}
                  {usageSummary(displayedSubagentUsage)}
                </div>
                <button
                  type="button"
                  className="semantic-subagents-minimize"
                  title={
                    subagentsMinimized
                      ? "Expand subagents"
                      : "Minimize subagents"
                  }
                  aria-label={
                    subagentsMinimized
                      ? "Expand subagents"
                      : "Minimize subagents"
                  }
                  aria-expanded={!subagentsMinimized}
                  onClick={() => {
                    const next = !subagentsMinimized;
                    setSubagentsMinimized(next);
                    if (session?.id) saveSubagentsMinimized(session.id, next);
                  }}
                >
                  {subagentsMinimized ? (
                    <ChevronRight className="h-4 w-4" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                </button>
              </div>
              {!subagentsMinimized && (
                <SubagentRows
                  agents={session.subagents}
                  onSelect={(agent) => setSelectedSubagentId(agent.id)}
                />
              )}
            </div>
          )}
          {queuedMessages.length > 0 && (
            <DndContext
              sensors={queueSensors}
              collisionDetection={closestCenter}
              onDragStart={(event) => {
                const activeId = String(event.active.id);
                const activeRow = Array.from(
                  document.querySelectorAll<HTMLElement>(
                    "[data-queue-item-id]",
                  ),
                ).find((element) => element.dataset.queueItemId === activeId);
                setDraggingQueueId(activeId);
                setDraggingQueueWidth(
                  event.active.rect.current.initial?.width ??
                    activeRow?.getBoundingClientRect().width ??
                    null,
                );
              }}
              onDragCancel={() => {
                setDraggingQueueId(null);
                setDraggingQueueWidth(null);
              }}
              onDragEnd={(event) => void finishQueueDrag(event)}
            >
              <div className="semantic-queue">
                <div className="semantic-queue-label">Queued</div>
                <SortableContext
                  items={queuedMessages.map((item) => item.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="grid gap-1.5">
                    {queuedMessages.map((item, index) => {
                      const blocked = queuedMessages
                        .slice(0, index)
                        .some(
                          (queued) => queued.deliveryState === "delivering",
                        );
                      return (
                        <QueuedMessageRow
                          key={item.id}
                          item={item}
                          blocked={blocked}
                          steering={steeringQueueId === item.id}
                          steerDisabled={
                            steeringQueueId !== null ||
                            editingQueueId === item.id
                          }
                          onEdit={() => editQueuedMessage(item)}
                          onRemove={() => void removeQueuedMessage(item)}
                          onSteer={() => void steerQueuedMessage(item)}
                          onReconcile={(action) =>
                            void reconcileQueuedMessage(item, action)
                          }
                        />
                      );
                    })}
                  </div>
                </SortableContext>
              </div>
              {createPortal(
                <DragOverlay dropAnimation={null}>
                  {draggingQueueId
                    ? (() => {
                        const item = queuedMessages.find(
                          (queued) => queued.id === draggingQueueId,
                        );
                        return item ? (
                          <QueuedMessageRow
                            item={item}
                            overlay
                            overlayWidth={draggingQueueWidth}
                            onEdit={() => {}}
                            onRemove={() => {}}
                            onSteer={() => {}}
                            onReconcile={() => {}}
                          />
                        ) : null;
                      })()
                    : null}
                </DragOverlay>,
                document.body,
              )}
            </DndContext>
          )}
          <div
            className={cn(
              "relative rounded-2xl border border-zinc-700 bg-zinc-900 shadow-2xl focus-within:border-white/70",
              draggingAttachments && "border-sky-400 bg-sky-400/5",
            )}
          >
            {slashMenuOpen && (
              <div
                ref={slashMenuRef}
                id="semantic-slash-command-menu"
                role="listbox"
                className="semantic-slash-menu"
              >
                {matchingSlashCommands.map((command, index) => (
                  <button
                    id={`semantic-slash-command-${index}`}
                    data-command-index={index}
                    key={`${command.source}:${command.name}`}
                    type="button"
                    role="option"
                    aria-selected={index === selectedSlashCommand}
                    className={cn(
                      index === selectedSlashCommand && "is-selected",
                    )}
                    onMouseEnter={() => setSelectedSlashCommand(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insertSlashCommand(command)}
                  >
                    <span className="semantic-slash-command-main">
                      <strong>/{command.name}</strong>
                      {command.description && (
                        <small>{command.description}</small>
                      )}
                    </span>
                    <span className="semantic-slash-command-source">
                      {command.source}
                      {command.location ? ` · ${command.location}` : ""}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {activeSkillInvocation && (
              <div className="semantic-skill-invocation">
                <span>skill</span>
                <code>/{activeSkillInvocation.name}</code>
              </div>
            )}
            {images.length > 0 && (
              <div className="flex gap-2 overflow-x-auto px-3 pt-3">
                {images.map((image, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: image attachments are appended in order and never reordered; index is stable.
                  <div key={index} className="relative shrink-0">
                    <button
                      type="button"
                      className="group block cursor-zoom-in rounded-lg border-0 bg-transparent p-0 focus:outline-none focus:ring-2 focus:ring-sky-400/70"
                      aria-label={`Expand ${image.name ?? `attachment ${index + 1}`}`}
                      title="Expand attachment"
                      onClick={() => openImagePreview(image)}
                    >
                      <img
                        className="h-16 w-16 rounded-lg border border-zinc-700 object-cover transition group-hover:border-zinc-400"
                        src={imageDataUrl(image)}
                        alt={image.name ?? "Attachment"}
                      />
                    </button>
                    <button
                      type="button"
                      className="absolute -right-1 -top-1 rounded-full bg-zinc-800 p-0.5"
                      aria-label={`Remove ${image.name ?? `attachment ${index + 1}`}`}
                      title="Remove attachment"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setImages((current) =>
                          current.filter((_, item) => item !== index),
                        );
                        textareaRef.current?.focus({ preventScroll: true });
                      }}
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setSlashMenuDismissed(false);
              }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files).filter(
                  (file) => file.type.startsWith("image/"),
                );
                if (files.length) {
                  event.preventDefault();
                  void addFiles(files);
                }
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
                if (
                  event.currentTarget.contains(
                    event.relatedTarget as Node | null,
                  )
                )
                  return;
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
                    setSelectedSlashCommand(
                      (current) =>
                        (current + direction + matchingSlashCommands.length) %
                        matchingSlashCommands.length,
                    );
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setSlashMenuDismissed(true);
                    return;
                  }
                  const command =
                    matchingSlashCommands[
                      Math.min(
                        selectedSlashCommand,
                        matchingSlashCommands.length - 1,
                      )
                    ];
                  if (command && event.key === "Tab") {
                    event.preventDefault();
                    insertSlashCommand(command);
                    return;
                  }
                  if (command && event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    setSlashMenuDismissed(true);
                    void submit(
                      event.altKey
                        ? "followUp"
                        : session?.status === "working"
                          ? "steer"
                          : undefined,
                      `/${command.name}`,
                    );
                    return;
                  }
                }
                if (event.key !== "Enter" || event.shiftKey) return;
                event.preventDefault();
                void submit(
                  event.altKey
                    ? "followUp"
                    : session?.status === "working"
                      ? "steer"
                      : undefined,
                );
              }}
              aria-autocomplete="list"
              aria-controls={
                slashMenuOpen ? "semantic-slash-command-menu" : undefined
              }
              aria-expanded={slashMenuOpen}
              role="combobox"
              aria-activedescendant={
                slashMenuOpen
                  ? `semantic-slash-command-${selectedSlashCommand}`
                  : undefined
              }
              className="min-h-20 max-h-52 w-full resize-none bg-transparent px-4 pt-3 text-[16px] leading-6 text-zinc-100 outline-none placeholder:text-zinc-600"
              placeholder={
                editingQueueId
                  ? "Edit queued follow-up…"
                  : session?.status === "working"
                    ? "Steer Pi… (Option+Enter queues a follow-up)"
                    : "Message Pi…"
              }
              disabled={!session || !connected}
            />
            {draggingAttachments && (
              <div className="semantic-attachment-drop" aria-hidden="true">
                <Paperclip className="h-5 w-5" /> Drop images to attach
              </div>
            )}
            <div className="flex items-center justify-between gap-2 px-2 pb-2">
              <div className="flex items-center gap-1">
                <input
                  ref={fileRef}
                  className="hidden"
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(event) => {
                    void addFiles(Array.from(event.target.files ?? []));
                    event.currentTarget.value = "";
                  }}
                />
                <Button
                  className="h-9 min-w-9 px-2"
                  variant="ghost"
                  size="icon"
                  title="Attach image"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => fileRef.current?.click()}
                >
                  <Paperclip className="h-4 w-4" />
                </Button>
                <Button
                  ref={modelButtonRef}
                  className="semantic-composer-control h-9 max-w-64 px-2"
                  variant="ghost"
                  size="sm"
                  disabled={controlBusy || !connected}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setModelMenuOpen((open) => !open)}
                >
                  {modelLabel}
                  <span className="text-zinc-600">·</span>
                  <span>{effortLabel}</span>
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
                <AnchoredPopover
                  open={modelMenuOpen}
                  onOpenChange={setModelMenuOpen}
                  anchorRef={modelButtonRef}
                  align="start"
                  className="semantic-composer-menu semantic-model-menu max-h-[70vh] overflow-y-auto"
                >
                  <div className="semantic-model-menu-sections">
                    <section className="semantic-model-menu-section">
                      <div className="semantic-composer-menu-label">Model</div>
                      {availableModels.map((model) => {
                        const value = `${model.provider}/${model.id}`;
                        return (
                          <button
                            key={value}
                            type="button"
                            onClick={() =>
                              void selectModel(model.provider, model.id)
                            }
                          >
                            <span>
                              <strong>{model.name}</strong>
                              <small>{value}</small>
                            </span>
                            {session?.model === value && (
                              <Check className="h-4 w-4 text-sky-300" />
                            )}
                          </button>
                        );
                      })}
                    </section>
                    <section className="semantic-model-menu-section semantic-model-menu-effort">
                      <div className="semantic-composer-menu-label">Effort</div>
                      <div className="semantic-effort-grid">
                        {availableEfforts.map((level) => (
                          <button
                            key={level}
                            type="button"
                            onClick={() => void selectEffort(level)}
                          >
                            <span>
                              <strong>{level}</strong>
                            </span>
                            {effortLabel === level && (
                              <Check className="h-4 w-4 text-sky-300" />
                            )}
                          </button>
                        ))}
                      </div>
                    </section>
                  </div>
                </AnchoredPopover>
                <ContextProgressCircle session={session} />
                <ComposerTokenInfo session={session} />
              </div>
              <div className="flex items-center gap-2">
                {editingQueueId && (
                  <Button
                    className="h-9 px-3"
                    variant="ghost"
                    size="sm"
                    onClick={finishQueueEditing}
                  >
                    Cancel
                  </Button>
                )}
                <div className="flex items-center overflow-hidden rounded-xl shadow-sm">
                  <Button
                    className={cn(
                      "h-9 w-9 rounded-xl",
                      !editingQueueId &&
                        session?.status === "working" &&
                        "rounded-r-none",
                    )}
                    title={
                      editingQueueId
                        ? "Save queued message"
                        : stopAction
                          ? aborting
                            ? "Stopping"
                            : "Stop"
                          : "Send"
                    }
                    size="icon"
                    disabled={
                      stopAction
                        ? aborting || !session
                        : sending ||
                          !connected ||
                          (!editingQueueId &&
                            session?.status !== "working" &&
                            !draft.trim() &&
                            images.length === 0)
                    }
                    onClick={() => {
                      if (stopAction) void requestAbort();
                      else
                        void submit(
                          editingQueueId
                            ? undefined
                            : session?.status === "working"
                              ? "steer"
                              : undefined,
                        );
                    }}
                  >
                    {stopAction ? (
                      <Square className="h-4 w-4" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
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
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                <AnchoredPopover
                  open={sendMenuOpen}
                  onOpenChange={setSendMenuOpen}
                  anchorRef={sendMenuButtonRef}
                  className="semantic-composer-menu w-56"
                >
                  <button
                    type="button"
                    disabled={!draft.trim() && images.length === 0}
                    onClick={() => {
                      setSendMenuOpen(false);
                      void submit("followUp");
                    }}
                  >
                    <span>
                      <strong>Queue follow-up</strong>
                      <small>Send after Pi finishes</small>
                    </span>
                  </button>
                </AnchoredPopover>
              </div>
            </div>
          </div>
          {(sendError || error) && (
            <p className="mt-2 text-sm text-red-300">{sendError ?? error}</p>
          )}
          {!sendError && !error && sendNotice && (
            <output className="mt-2 text-sm text-zinc-400">{sendNotice}</output>
          )}
        </div>
      </div>
    </section>
  );
}
