import * as React from "react";
import { createPortal } from "react-dom";
import { closestCenter, DndContext, DragOverlay, KeyboardSensor, PointerSensor, useSensor, useSensors, type CollisionDetection, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FolderGit2,
  GitFork,
  ListFilter,
  ListRestart,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  Plus,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { Button } from "./components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { AnchoredPopover } from "./components/anchored-popover";
import {
  cloneSessionViaCommand,
  compactSessionViaCommand,
  createSession,
  deleteSession,
  forkSessionViaCommand,
  getForkMessages,
  listSessions,
  type ForkMessageItem,
  openSessionSocket,
  renameSessionViaCommand,
  resumeSession,
  sendSessionCommand,
} from "./api";
import { compareWebSessions, mergeWebSubagentUpdates, moveWebSessionRelative, orderWebSessions, type ClientPromptMessage, type CreateSessionRequest, type SemanticImage, type WebQueuedMessage, type WebQueueReplacement, type WebSession, type WebSessionOptions, type WebSlashCommand, type WebSubagentUpdate, type WebUsage } from "../protocol";
import { SessionSocket } from "./ws";
import { SemanticSession, updateStreamingMessage, type ActiveTool, type SemanticEntry } from "./semantic-session";
import { preserveSessionTelemetry, preserveSessionsTelemetry } from "./session-telemetry";
import { cn } from "./lib/utils";
import { recentRepositories, type RecentRepository } from "./recent-repositories";
import { includeWebReloadCommand, isWebReloadCommand } from "../reload-command";
import { assertClientPromptPayloadFits } from "./image-payload";
import { displaySessionStatus } from "./session-status";

const SESSION_ORDER_KEY = "pi-web-session-order-v1";

function semanticEntryIdentity(entry: SemanticEntry): string | undefined {
  const message = entry.message;
  if (!message) return undefined;
  if (typeof message.id === "string") return `id:${message.id}`;
  const role = typeof message.role === "string" ? message.role : "";
  const timestamp = typeof message.timestamp === "number" || typeof message.timestamp === "string" ? String(message.timestamp) : "";
  if (timestamp) return `${role}:${timestamp}`;
  return undefined;
}

function preserveSemanticEntryKeys(previous: SemanticEntry[], incoming: SemanticEntry[]): SemanticEntry[] {
  const previousIds = new Map<string, string>();
  for (const entry of previous) {
    const identity = semanticEntryIdentity(entry);
    if (identity && entry.id) previousIds.set(identity, entry.id);
  }
  return incoming.map((entry) => {
    const identity = semanticEntryIdentity(entry);
    const id = identity ? previousIds.get(identity) : undefined;
    return id ? { ...entry, id } : entry;
  });
}

function mergeSemanticHistory(previous: SemanticEntry[], incoming: SemanticEntry[]): SemanticEntry[] {
  const reconciled = preserveSemanticEntryKeys(previous, incoming);
  const incomingIdentities = new Set(reconciled.map(semanticEntryIdentity).filter((identity): identity is string => Boolean(identity)));
  const retained = previous.filter((entry) => {
    const identity = semanticEntryIdentity(entry);
    return !identity || !incomingIdentities.has(identity);
  });
  return [...retained, ...reconciled];
}
const SESSION_SORT_KEY = "pi-web-session-sort-v1";
const COLLAPSED_PROJECTS_KEY = "pi-web-collapsed-projects-v1";

type SessionSort = "newest" | "oldest" | "custom";

function loadSessionOrder(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SESSION_ORDER_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function loadSessionSort(): SessionSort {
  try {
    const value = localStorage.getItem(SESSION_SORT_KEY);
    return value === "oldest" || value === "custom" ? value : "newest";
  } catch {
    return "newest";
  }
}

function loadCollapsedProjects(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function savePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Preferences are best-effort when browser storage is denied or full.
  }
}

function messageContentParts(message: Record<string, unknown>): Array<Record<string, unknown>> {
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  return Array.isArray(message.content)
    ? message.content.filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object")
    : [];
}

function messageText(message: Record<string, unknown>): string {
  return messageContentParts(message)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function upsertActiveTool(
  tools: ActiveTool[],
  event: Record<string, unknown>,
  patch: Pick<ActiveTool, "running"> & Partial<Pick<ActiveTool, "result" | "isError">>,
): ActiveTool[] {
  const id = String(event.toolCallId ?? "");
  if (!id) return tools;
  const existing = tools.find((tool) => tool.id === id);
  const next: ActiveTool = {
    id,
    name: typeof event.toolName === "string" ? event.toolName : existing?.name ?? "tool",
    args: event.args ?? existing?.args,
    result: patch.result ?? existing?.result,
    isError: patch.isError ?? existing?.isError,
    running: patch.running,
  };
  return [...tools.filter((tool) => tool.id !== id), next];
}

function preserveOptimisticAttachments(
  confirmed: Record<string, unknown>,
  optimistic: SemanticEntry,
): Record<string, unknown> {
  const confirmedParts = messageContentParts(confirmed);
  const confirmedHasImages = confirmedParts.some((part) => part.type === "image");
  if (confirmedHasImages || !optimistic.message) return confirmed;
  const attachments = messageContentParts(optimistic.message).filter((part) => part.type === "image");
  return attachments.length > 0 ? { ...confirmed, content: [...confirmedParts, ...attachments] } : confirmed;
}

function sessionStatusClasses(session: WebSession): string {
  switch (displaySessionStatus(session)) {
    case "working": return "border-emerald-400/25 bg-emerald-400/10 text-emerald-300";
    case "starting": return "border-amber-400/25 bg-amber-400/10 text-amber-300";
    case "inactive": return "border-zinc-600/60 bg-zinc-800/70 text-zinc-400";
    case "error": return "border-red-400/25 bg-red-400/10 text-red-300";
    case "idle": return "border-sky-400/25 bg-sky-400/10 text-sky-300";
  }
}

function sessionStatusLabel(session: WebSession): string {
  return displaySessionStatus(session);
}

function sessionTitle(session: WebSession): string {
  return session.name?.trim() || session.preview?.trim() || session.file?.split("/").pop() || session.id.slice(0, 8);
}

function sessionSubtitle(session: WebSession): string {
  const homeRelative = session.cwd.replace(/^\/Users\/[^/]+(?=\/|$)/, "~").replace(/^\/home\/[^/]+(?=\/|$)/, "~");
  return session.branch ? `${homeRelative} · ${session.branch}` : homeRelative;
}

function sessionMatches(session: WebSession, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [sessionTitle(session), session.cwd, session.branch, session.projectName, session.model, session.status, sessionStatusLabel(session)]
    .some((value) => value?.toLocaleLowerCase().includes(needle));
}

function hashSessionId(): string | null {
  const match = window.location.hash.match(/#\/sessions\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function setHashSessionId(sessionId: string): void {
  window.location.hash = `#/sessions/${encodeURIComponent(sessionId)}`;
}

function sortSessions(sessions: WebSession[]): WebSession[] {
  return [...sessions].sort(compareWebSessions);
}

function sortSessionsForSidebar(sessions: WebSession[], sort: SessionSort, customOrder: readonly string[]): WebSession[] {
  if (sort === "custom") return orderWebSessions(sessions, customOrder);
  if (sort === "newest") return sortSessions(sessions);
  return [...sessions].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

type ProjectSessionGroup = { id: string; name: string; sessions: WebSession[] };

function projectGroups(sessions: WebSession[]): ProjectSessionGroup[] {
  const groups = new Map<string, ProjectSessionGroup>();
  for (const session of sessions) {
    const id = session.projectId ?? `dir:${session.cwd}`;
    const name = session.projectName ?? session.cwd.split("/").filter(Boolean).pop() ?? session.cwd;
    const group = groups.get(id) ?? { id, name, sessions: [] };
    group.sessions.push(session);
    groups.set(id, group);
  }
  return Array.from(groups.values());
}

function NewSessionDialog({ open, baseSession, repositories, onOpenChange, onCreate }: { open: boolean; baseSession: WebSession | null; repositories: RecentRepository[]; onOpenChange: (open: boolean) => void; onCreate: (value: CreateSessionRequest) => Promise<void> }) {
  const [repository, setRepository] = React.useState("");
  const [name, setName] = React.useState("");
  const [worktreeName, setWorktreeName] = React.useState("");
  const [worktreeBranch, setWorktreeBranch] = React.useState("");
  const [worktreeStartPoint, setWorktreeStartPoint] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const repositoryListId = React.useId();
  React.useEffect(() => {
    if (!open) return;
    setRepository(baseSession?.repositoryRoot ?? baseSession?.cwd ?? "");
    setName("");
    setWorktreeName("");
    setWorktreeBranch("");
    setWorktreeStartPoint("");
    setBusy(false);
    setCreateError(null);
  }, [baseSession?.cwd, baseSession?.repositoryRoot, open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New session</DialogTitle>
          <DialogDescription>Choose a repository or directory. Add a worktree name to create a linked checkout first.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-wider text-zinc-500" htmlFor={`${repositoryListId}-input`}>repository</label>
            <Input
              id={`${repositoryListId}-input`}
              list={repositoryListId}
              autoComplete="off"
              value={repository}
              onChange={(event) => { setRepository(event.target.value); setCreateError(null); }}
              placeholder="~/path/to/repository"
              role="combobox"
              aria-autocomplete="list"
            />
            <datalist id={repositoryListId}>
              {repositories.map((item) => <option key={item.id} value={item.path}>{item.name}</option>)}
            </datalist>
            <p className="text-xs text-zinc-500">Recently used repositories appear as you type.</p>
          </div>
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-wider text-zinc-500">worktree name</label>
            <Input value={worktreeName} onChange={(event) => { setWorktreeName(event.target.value); setCreateError(null); }} placeholder="Optional managed directory name" />
            <p className="text-xs text-zinc-500">Creates <code>&lt;repo-root&gt;/.pi/worktrees/&lt;name&gt;</code>. The branch can have a different, namespaced name.</p>
          </div>
          {worktreeName.trim() && <>
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wider text-zinc-500">local branch</label>
              <Input value={worktreeBranch} onChange={(event) => { setWorktreeBranch(event.target.value); setCreateError(null); }} placeholder={`Defaults to ${worktreeName.trim()}`} />
            </div>
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wider text-zinc-500">start point</label>
              <Input value={worktreeStartPoint} onChange={(event) => { setWorktreeStartPoint(event.target.value); setCreateError(null); }} placeholder="Optional, e.g. origin/owner/topic" />
              <p className="text-xs text-zinc-500">Used only when creating a missing local branch. A remote-tracking ref configures its upstream.</p>
            </div>
          </>}
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-wider text-zinc-500">session name</label>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Optional display name" />
          </div>
          {createError && <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{createError}</p>}
        </DialogBody>
        <DialogFooter>
          <DialogClose>Cancel</DialogClose>
          <Button
            onClick={async () => {
              setBusy(true);
              setCreateError(null);
              try {
                await onCreate({
                  cwd: repository.trim(),
                  name: name.trim() || undefined,
                  worktreeName: worktreeName.trim() || undefined,
                  worktreeBranch: worktreeName.trim() && worktreeBranch.trim() ? worktreeBranch.trim() : undefined,
                  worktreeStartPoint: worktreeName.trim() && worktreeStartPoint.trim() ? worktreeStartPoint.trim() : undefined,
                });
                onOpenChange(false);
              } catch (cause) {
                setCreateError(cause instanceof Error ? cause.message : String(cause));
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy || !repository.trim()}
          >
            {busy ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameSessionDialog({
  session,
  onOpenChange,
  onRename,
}: {
  session: WebSession | null;
  onOpenChange: (open: boolean) => void;
  onRename: (session: WebSession, name: string) => Promise<void>;
}) {
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [renameError, setRenameError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!session) return;
    setName(session.name ?? "");
    setBusy(false);
    setRenameError(null);
  }, [session]);

  const submit = async () => {
    if (!session || busy) return;
    setBusy(true);
    setRenameError(null);
    try {
      await onRename(session, name.trim());
      onOpenChange(false);
    } catch (cause) {
      setRenameError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={session !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename session</DialogTitle>
          <DialogDescription>Set the name shown in Pi and the web sidebar.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void submit(); }}
            placeholder="Session name"
          />
          {renameError && <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{renameError}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy} onClick={() => void submit()}>{busy ? "Renaming…" : "Rename"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteSessionDialog({
  session,
  onOpenChange,
  onDelete,
}: {
  session: WebSession | null;
  onOpenChange: (open: boolean) => void;
  onDelete: (session: WebSession) => Promise<void>;
}) {
  const [busy, setBusy] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (session) {
      setBusy(false);
      setDeleteError(null);
    }
  }, [session]);

  return (
    <Dialog open={session !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete session?</DialogTitle>
          <DialogDescription>
            {session
              ? `Delete ${sessionTitle(session)}?${session.status !== "offline" ? " Its Pi process will be stopped." : ""}${session.managedWorktree ? " Its managed worktree will also be removed when this is its final saved session." : ""}`
              : "Delete this session?"}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3 text-sm text-zinc-400">
          <p>{session?.file ? "Its saved session file will be permanently removed." : "This unsaved session will be permanently removed."}</p>
          {session?.managedWorktree && <p className="break-all rounded-md bg-zinc-900 p-2 font-mono text-xs text-zinc-500">Managed worktree: {session.managedWorktree.path}</p>}
          {session?.file && <p className="break-all rounded-md bg-zinc-900 p-2 font-mono text-xs text-zinc-500">{session.file}</p>}
          {deleteError && <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-red-300">{deleteError}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            autoFocus
            variant="destructive"
            disabled={busy || !session}
            onClick={async () => {
              if (!session) return;
              setBusy(true);
              setDeleteError(null);
              try {
                await onDelete(session);
                onOpenChange(false);
              } catch (cause) {
                setDeleteError(cause instanceof Error ? cause.message : String(cause));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ForkSessionDialog({
  session,
  onOpenChange,
  onFork,
}: {
  session: WebSession | null;
  onOpenChange: (open: boolean) => void;
  onFork: (session: WebSession, entryId: string) => Promise<void>;
}) {
  const [messages, setMessages] = React.useState<ForkMessageItem[]>([]);
  const [selectedEntryId, setSelectedEntryId] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [forkError, setForkError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setMessages([]);
    setSelectedEntryId("");
    setLoading(true);
    setBusy(false);
    setForkError(null);
    void getForkMessages(session.id).then((items) => {
      if (cancelled) return;
      setMessages(items);
      setSelectedEntryId(items.at(-1)?.entryId ?? "");
    }).catch((cause) => {
      if (!cancelled) setForkError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [session]);

  const submit = async () => {
    if (!session || !selectedEntryId || busy) return;
    setBusy(true);
    setForkError(null);
    try {
      await onFork(session, selectedEntryId);
      onOpenChange(false);
    } catch (cause) {
      setForkError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={session !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Fork session</DialogTitle>
          <DialogDescription>Select the user message to branch from.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {loading && <p className="text-sm text-zinc-400">Loading fork points…</p>}
          {!loading && messages.length === 0 && !forkError && <p className="text-sm text-zinc-400">This session has no user messages to fork from.</p>}
          {messages.length > 0 && (
            <div className="max-h-72 space-y-2 overflow-y-auto">
              {messages.map((message) => (
                <label key={message.entryId} className={cn("flex cursor-pointer gap-3 rounded-lg border p-3 text-sm", selectedEntryId === message.entryId ? "border-sky-400/60 bg-sky-400/10" : "border-zinc-800 bg-zinc-950")}>
                  <input type="radio" name="fork-entry" value={message.entryId} checked={selectedEntryId === message.entryId} onChange={() => setSelectedEntryId(message.entryId)} />
                  <span className="line-clamp-3 text-zinc-300">{message.text}</span>
                </label>
              ))}
            </div>
          )}
          {forkError && <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{forkError}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={loading || busy || !selectedEntryId} onClick={() => void submit()}>{busy ? "Forking…" : "Fork"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SidebarFilterButton({
  query,
  onQueryChange,
  sort,
  onSortChange,
  hasCustomOrder,
  onResetOrder,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  sort: SessionSort;
  onSortChange: (value: SessionSort) => void;
  hasCustomOrder: boolean;
  onResetOrder: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const buttonRef = React.useRef<HTMLButtonElement | null>(null);
  const active = !!query || sort !== "newest";
  return (
    <>
      <Button
        ref={buttonRef}
        title="Filter and sort sessions"
        aria-label="Filter and sort sessions"
        aria-expanded={open}
        variant={active ? "secondary" : "outline"}
        size="icon"
        className="shrink-0"
        onClick={() => setOpen((value) => !value)}
      >
        <ListFilter className="h-4 w-4" />
      </Button>
      <AnchoredPopover open={open} onOpenChange={setOpen} anchorRef={buttonRef} className="w-72 p-3">
        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="session-filter" className="text-xs font-medium uppercase tracking-wider text-zinc-500">Filter sessions</label>
            <Input
              id="session-filter"
              autoFocus
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Name, project, path, branch…"
              className="h-9"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="session-sort" className="text-xs font-medium uppercase tracking-wider text-zinc-500">Sort</label>
            <select
              id="session-sort"
              value={sort}
              onChange={(event) => onSortChange(event.target.value as SessionSort)}
              className="h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-200 outline-none focus:ring-2 focus:ring-sky-400/70"
            >
              <option value="newest">Newest created first</option>
              <option value="oldest">Oldest created first</option>
              <option value="custom" disabled={!hasCustomOrder}>Custom order</option>
            </select>
          </div>
          {hasCustomOrder && (
            <Button variant="ghost" size="sm" className="w-full justify-start" onClick={onResetOrder}>
              <ListRestart className="h-4 w-4" /> Reset custom order
            </Button>
          )}
        </div>
      </AnchoredPopover>
    </>
  );
}

type SessionActionCallbacks = {
  onResume: () => void;
  onClone: () => void;
  onFork: () => void;
  onRename: () => void;
  onCompact: () => void;
  onDelete: () => void;
};

function SessionActionItems({ session, actions, onAction }: {
  session: WebSession;
  actions: SessionActionCallbacks;
  onAction: () => void;
}) {
  const inactive = session.status === "offline" || session.source === "saved";
  const action = (callback: () => void) => {
    onAction();
    callback();
  };
  const itemClass = "flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white";
  return (
    <div onClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
      {inactive && <button className={itemClass} onClick={() => action(actions.onResume)}><Play className="h-4 w-4" /> Resume</button>}
      {!inactive && <button className={itemClass} onClick={() => action(actions.onClone)}><Copy className="h-4 w-4" /> Clone</button>}
      {!inactive && <button className={itemClass} onClick={() => action(actions.onFork)}><GitFork className="h-4 w-4" /> Fork</button>}
      <button className={itemClass} onClick={() => action(actions.onRename)}><Pencil className="h-4 w-4" /> Rename</button>
      <button className={itemClass} onClick={() => action(actions.onCompact)}><WandSparkles className="h-4 w-4" /> Compact</button>
      <div className="my-1 border-t border-zinc-800" />
      <button className={cn(itemClass, "text-red-300 hover:bg-red-500/10 hover:text-red-200")} onClick={() => action(actions.onDelete)}><Trash2 className="h-4 w-4" /> Delete</button>
    </div>
  );
}

function SessionActionsMenu({ session, actions }: { session: WebSession; actions: SessionActionCallbacks }) {
  const [open, setOpen] = React.useState(false);
  const buttonRef = React.useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <Button
        ref={buttonRef}
        draggable={false}
        title="Session actions"
        aria-label={`Actions for ${sessionTitle(session)}`}
        aria-expanded={open}
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0 justify-self-end text-zinc-500"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen((value) => !value); }}
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>
      <AnchoredPopover open={open} onOpenChange={setOpen} anchorRef={buttonRef} className="w-44">
        <SessionActionItems session={session} actions={actions} onAction={() => setOpen(false)} />
      </AnchoredPopover>
    </>
  );
}

function SessionListItem({
  session,
  selected,
  overlay = false,
  onSelect,
  onResume,
  onClone,
  onFork,
  onRename,
  onCompact,
  onDelete,
}: {
  session: WebSession;
  selected: boolean;
  overlay?: boolean;
  onSelect: () => void;
  onResume: () => void;
  onClone: () => void;
  onFork: () => void;
  onRename: () => void;
  onCompact: () => void;
  onDelete: () => void;
}) {
  const [contextPoint, setContextPoint] = React.useState<{ x: number; y: number } | null>(null);
  const contextAnchorRef = React.useRef<HTMLSpanElement | null>(null);
  const sortable = useSortable({ id: overlay ? `overlay:${session.id}` : session.id, disabled: overlay });
  const style = overlay ? undefined : { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  const actions: SessionActionCallbacks = { onResume, onClone, onFork, onRename, onCompact, onDelete };
  return (
    <div
      ref={overlay ? undefined : sortable.setNodeRef}
      style={style}
      {...(overlay ? {} : sortable.attributes)}
      {...(overlay ? {} : sortable.listeners)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setContextPoint({ x: event.clientX, y: event.clientY });
      }}
      onClick={onSelect}
      onKeyDown={(event) => {
        sortable.listeners?.onKeyDown?.(event);
        if (!event.defaultPrevented && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group w-full rounded-xl border p-3 text-left transition",
        !overlay && "cursor-grab touch-none active:cursor-grabbing",
        selected ? "border-white/60 bg-white/10" : "border-zinc-800 bg-zinc-950/50 hover:border-zinc-700 hover:bg-zinc-900",
        sortable.isDragging && "opacity-0",
        overlay && "cursor-grabbing border-white/70 bg-zinc-900 shadow-2xl",
      )}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1">
        <div className="truncate text-sm font-medium text-zinc-100">{sessionTitle(session)}</div>
        <SessionActionsMenu session={session} actions={actions} />
        <div className="truncate text-left text-xs text-zinc-500" dir="rtl" title={sessionSubtitle(session)}>{sessionSubtitle(session)}</div>
        <span className={cn(
          "inline-flex justify-self-end rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize leading-none",
          sessionStatusClasses(session),
        )}>
          {sessionStatusLabel(session)}
        </span>
        {session.pullRequest && (
          <div className="col-span-2 mt-0.5 flex min-w-0 items-center text-xs">
            <a
              className="min-w-0 truncate text-sky-300 hover:text-sky-200 hover:underline"
              href={session.pullRequest.url}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              PR #{session.pullRequest.number}
            </a>
          </div>
        )}
      </div>
      <span
        ref={contextAnchorRef}
        className="pointer-events-none fixed h-0 w-0"
        style={contextPoint ? { left: contextPoint.x, top: contextPoint.y } : undefined}
      />
      <AnchoredPopover
        open={contextPoint !== null}
        onOpenChange={(open) => { if (!open) setContextPoint(null); }}
        anchorRef={contextAnchorRef}
        align="start"
        className="w-44"
      >
        <SessionActionItems session={session} actions={actions} onAction={() => setContextPoint(null)} />
      </AnchoredPopover>
    </div>
  );
}

export function App() {
  const [sessions, setSessions] = React.useState<WebSession[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(() => hashSessionId());
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [newSessionOpen, setNewSessionOpen] = React.useState(false);
  const [renameCandidate, setRenameCandidate] = React.useState<WebSession | null>(null);
  const [deleteCandidate, setDeleteCandidate] = React.useState<WebSession | null>(null);
  const [forkCandidate, setForkCandidate] = React.useState<WebSession | null>(null);
  const [currentSession, setCurrentSession] = React.useState<WebSession | null>(null);
  const [sessionOrder, setSessionOrder] = React.useState<string[]>(loadSessionOrder);
  const [sessionSort, setSessionSort] = React.useState<SessionSort>(loadSessionSort);
  const [collapsedProjects, setCollapsedProjects] = React.useState<string[]>(loadCollapsedProjects);
  const [filterQuery, setFilterQuery] = React.useState("");
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const sessionSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [entries, setEntries] = React.useState<SemanticEntry[]>([]);
  const [streamingMessage, setStreamingMessage] = React.useState<Record<string, unknown> | null>(null);
  const [streamingMessageKey, setStreamingMessageKey] = React.useState<string | null>(null);
  const streamingMessageKeyRef = React.useRef<string | null>(null);
  const activeSessionIdRef = React.useRef<string | null>(null);
  const [activeTools, setActiveTools] = React.useState<ActiveTool[]>([]);
  const [connected, setConnected] = React.useState(false);
  const [transcriptLoading, setTranscriptLoading] = React.useState(Boolean(selectedId));
  const [queuedMessages, setQueuedMessages] = React.useState<WebQueuedMessage[]>([]);
  const [sessionOptions, setSessionOptions] = React.useState<WebSessionOptions>({ models: [], thinkingLevels: [], commands: [] });
  const socketRef = React.useRef<SessionSocket | null>(null);
  const selectedIdRef = React.useRef<string | null>(selectedId);
  const reconnectTimerRef = React.useRef<number | null>(null);
  const queueSyncRef = React.useRef<{ requestId: string; sessionId: string; socket: SessionSocket; timer: number } | null>(null);
  const connectionGenerationRef = React.useRef(0);
  const optionsGenerationRef = React.useRef(0);
  const pendingRequestsRef = React.useRef(new Map<string, { socket: SessionSocket; optimisticId: string; resolve: (data?: unknown) => void; reject: (error: Error) => void }>());

  React.useEffect(() => { savePreference(SESSION_ORDER_KEY, JSON.stringify(sessionOrder)); }, [sessionOrder]);
  React.useEffect(() => { savePreference(SESSION_SORT_KEY, sessionSort); }, [sessionSort]);
  React.useEffect(() => { savePreference(COLLAPSED_PROJECTS_KEY, JSON.stringify(collapsedProjects)); }, [collapsedProjects]);
  React.useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  const loadAllSessions = React.useCallback(async () => {
    try {
      setLoading(true);
      const snapshot = sortSessions(await listSessions());
      setSessions((previous) => preserveSessionsTelemetry(previous, snapshot));
      setError(null);
      if (!selectedId && snapshot[0]) setSelectedId(snapshot[0].id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  React.useEffect(() => { void loadAllSessions(); }, [loadAllSessions]);
  React.useEffect(() => {
    const interval = connected ? 60_000 : 5_000;
    const timer = window.setInterval(() => void loadAllSessions(), interval);
    return () => window.clearInterval(timer);
  }, [connected, loadAllSessions]);

  React.useEffect(() => {
    const onHashChange = () => {
      const next = hashSessionId();
      if (next !== selectedIdRef.current) setSelectedId(next);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  React.useEffect(() => {
    if (!selectedId) {
      setCurrentSession(null);
      return;
    }
    const session = sessions.find((item) => item.id === selectedId) ?? null;
    setCurrentSession(session);
  }, [selectedId, sessions]);

  const rejectPendingForSocket = React.useCallback((socket: SessionSocket, error: Error) => {
    const optimisticIds = new Set<string>();
    for (const [requestId, pending] of pendingRequestsRef.current) {
      if (pending.socket !== socket) continue;
      pendingRequestsRef.current.delete(requestId);
      optimisticIds.add(pending.optimisticId);
      pending.reject(error);
    }
    if (optimisticIds.size > 0) setEntries((previous) => previous.filter((entry) => !entry.id || !optimisticIds.has(entry.id)));
  }, []);

  const connect = React.useCallback(async (sessionId: string) => {
    const generation = ++connectionGenerationRef.current;
    if (queueSyncRef.current) {
      window.clearTimeout(queueSyncRef.current.timer);
      queueSyncRef.current = null;
    }
    const switchingSessions = activeSessionIdRef.current !== sessionId;
    const previousSocket = socketRef.current;
    socketRef.current = null;
    if (previousSocket) {
      rejectPendingForSocket(previousSocket, new Error("Session connection was replaced"));
      previousSocket.close();
    }
    if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    setConnected(false);
    setTranscriptLoading(true);
    if (switchingSessions) {
      setEntries([]);
      setStreamingMessage(null);
      setStreamingMessageKey(null);
      streamingMessageKeyRef.current = null;
      setActiveTools([]);
      setQueuedMessages([]);
    }
    const socket = await openSessionSocket((message) => {
      if (generation !== connectionGenerationRef.current || selectedIdRef.current !== sessionId) return;
      if (!message || typeof message !== "object" || !("type" in message)) return;
      const type = String((message as { type?: unknown }).type);
      if (type === "server.snapshot") {
        const snapshot = message as { sessions?: WebSession[] };
        if (snapshot.sessions) setSessions((previous) => preserveSessionsTelemetry(previous, sortSessions(snapshot.sessions!)));
        return;
      }
      if (type === "server.session") {
        const payload = message as unknown as { session: WebSession };
        if (payload.session.id === selectedIdRef.current) {
          setCurrentSession((current) => preserveSessionTelemetry(current ?? undefined, payload.session));
        }
        setSessions((previous) => {
          const session = preserveSessionTelemetry(previous.find((item) => item.id === payload.session.id), payload.session);
          return sortSessions([...previous.filter((item) => item.id !== session.id), session]);
        });
        return;
      }
      if (type === "server.session_removed") {
        const payload = message as unknown as { sessionId: string; replacementSessionId?: string };
        setSessions((prev) => prev.filter((s) => s.id !== payload.sessionId));
        if (payload.sessionId === selectedIdRef.current) {
          setSelectedId(payload.replacementSessionId ?? null);
          if (payload.replacementSessionId) setHashSessionId(payload.replacementSessionId);
        }
        return;
      }
      if (type === "server.history") {
        const payload = message as unknown as { sessionId: string; entries?: SemanticEntry[] };
        if (payload.sessionId === selectedIdRef.current) {
          if (payload.entries) setEntries((previous) => switchingSessions ? payload.entries! : mergeSemanticHistory(previous, payload.entries!));
          setTranscriptLoading(false);
        }
        return;
      }
      if (type === "server.response") {
        const payload = message as unknown as { requestId?: string; success: boolean; error?: string; data?: unknown };
        if (!payload.requestId) return;
        const pending = pendingRequestsRef.current.get(payload.requestId);
        if (!pending) return;
        pendingRequestsRef.current.delete(payload.requestId);
        if (payload.success) pending.resolve(payload.data);
        else {
          setEntries((previous) => previous.filter((entry) => entry.id !== pending.optimisticId));
          pending.reject(new Error(payload.error ?? "Request failed"));
        }
        return;
      }
      if (type !== "server.event") return;
      const payload = message as unknown as { sessionId: string; event: Record<string, unknown> };
      if (payload.sessionId !== selectedIdRef.current) return;
      const event = payload.event;
      const eventType = String(event.type ?? "");
      if (eventType === "agent_start" || eventType === "turn_start" || eventType === "agent_end" || eventType === "agent_settled") {
        const applyLifecycle = (session: WebSession): WebSession => {
          if (eventType === "agent_start" || eventType === "turn_start") return { ...session, status: "working" };
          if (eventType === "agent_end" && session.compaction) return session;
          return { ...session, status: "idle" };
        };
        setCurrentSession((current) => current?.id === payload.sessionId ? applyLifecycle(current) : current);
        setSessions((previous) => previous.map((session) => session.id === payload.sessionId ? applyLifecycle(session) : session));
      }
      if (eventType === "subagents_update") {
        const updates = Array.isArray(event.agents) ? event.agents as WebSubagentUpdate[] : [];
        const usage = event.usage as WebUsage | undefined;
        const applyUpdate = (session: WebSession): WebSession => ({
          ...session,
          subagents: mergeWebSubagentUpdates(session.subagents, updates),
          subagentUsage: usage ?? session.subagentUsage,
        });
        setCurrentSession((current) => current?.id === payload.sessionId ? applyUpdate(current) : current);
        setSessions((previous) => previous.map((session) => session.id === payload.sessionId ? applyUpdate(session) : session));
      } else if (eventType === "web_queue_update") {
        if (typeof event.syncRequestId === "string" && queueSyncRef.current?.requestId === event.syncRequestId) {
          window.clearTimeout(queueSyncRef.current.timer);
          queueSyncRef.current = null;
        }
        setQueuedMessages(Array.isArray(event.queue) ? event.queue.filter((item): item is WebQueuedMessage => Boolean(item) && typeof item === "object" && typeof (item as WebQueuedMessage).id === "string" && typeof (item as WebQueuedMessage).message === "string") : []);
      } else if (eventType === "web_queue_delivery" && event.item && typeof event.item === "object") {
        const item = event.item as WebQueuedMessage;
        if (typeof item.id !== "string" || typeof item.message !== "string") return;
        const optimisticId = `optimistic-queued-${item.id}`;
        if (event.phase === "started") {
          // Atomically move the follow-up out of the editable queue and into the
          // normal transcript before the server asks Pi to begin its turn.
          setQueuedMessages((previous) => previous.filter((queued) => queued.id !== item.id));
          setEntries((previous) => previous.some((entry) => entry.id === optimisticId) ? previous : [...previous, {
            id: optimisticId,
            type: "message",
            timestamp: new Date().toISOString(),
            message: {
              role: "user",
              timestamp: Date.now(),
              content: [
                ...(item.message ? [{ type: "text", text: item.message }] : []),
                ...(item.images ?? []).map((image) => ({ ...image })),
              ],
            },
          }]);
        } else if (event.phase === "failed") {
          setEntries((previous) => previous.filter((entry) => entry.id !== optimisticId));
        }
      } else if (eventType === "message_start" && event.message && typeof event.message === "object" && (event.message as Record<string, unknown>).role === "assistant") {
        const assistant = event.message as Record<string, unknown>;
        const key = String(assistant.id ?? assistant.timestamp ?? `streaming-${crypto.randomUUID()}`);
        streamingMessageKeyRef.current = key;
        setStreamingMessageKey(key);
        setStreamingMessage(assistant);
      } else if (eventType === "message_update") {
        if (event.message && typeof event.message === "object") {
          if (!streamingMessageKeyRef.current) {
            const partial = event.message as Record<string, unknown>;
            const key = String(partial.id ?? partial.timestamp ?? `streaming-${crypto.randomUUID()}`);
            streamingMessageKeyRef.current = key;
            setStreamingMessageKey(key);
          }
          // Pi includes the authoritative partial assistant message on every
          // update. Rendering it directly avoids reconstructing streams from
          // provider-specific deltas (especially tool-call deltas).
          setStreamingMessage(event.message as Record<string, unknown>);
        } else if (event.assistantMessageEvent && typeof event.assistantMessageEvent === "object") {
          setStreamingMessage((current) => updateStreamingMessage(current, event.assistantMessageEvent as Record<string, unknown>));
        }
      } else if (eventType === "message_end" && event.message && typeof event.message === "object") {
        const finalized = event.message as Record<string, unknown>;
        const finalizedStreamingKey = streamingMessageKeyRef.current;
        setEntries((previous) => {
          const stableAssistantId = finalized.role === "assistant"
            ? finalizedStreamingKey ?? String(finalized.id ?? finalized.timestamp ?? crypto.randomUUID())
            : crypto.randomUUID();
          const entry = { id: stableAssistantId, type: "message", timestamp: new Date().toISOString(), message: finalized };
          if (finalized.role === "user") {
            const confirmedText = messageText(finalized);
            let optimisticIndex = previous.findIndex((item) =>
              item.id?.startsWith("optimistic-") && item.message && messageText(item.message) === confirmedText
            );
            if (optimisticIndex < 0) optimisticIndex = previous.findIndex((item) => item.id?.startsWith("optimistic-"));
            if (optimisticIndex >= 0) {
              const next = [...previous];
              next[optimisticIndex] = {
                ...entry,
                id: previous[optimisticIndex]!.id,
                message: preserveOptimisticAttachments(finalized, previous[optimisticIndex]!),
              };
              return next;
            }
          }
          return [...previous, entry];
        });
        if (finalized.role === "assistant") {
          setStreamingMessage(null);
          setStreamingMessageKey(null);
          streamingMessageKeyRef.current = null;
        }
      } else if (eventType === "tool_execution_start") {
        const id = String(event.toolCallId ?? crypto.randomUUID());
        setActiveTools((previous) => [...previous.filter((tool) => tool.id !== id), { id, name: String(event.toolName ?? "tool"), args: event.args, running: true }]);
      } else if (eventType === "tool_execution_update") {
        setActiveTools((previous) => upsertActiveTool(previous, event, { result: event.partialResult, running: true }));
      } else if (eventType === "tool_execution_end") {
        setActiveTools((previous) => upsertActiveTool(previous, event, { result: event.result, isError: event.isError === true, running: false }));
      } else if (eventType === "agent_settled") {
        setActiveTools([]);
      }
    }).catch(() => {
      if (generation === connectionGenerationRef.current && selectedIdRef.current === sessionId) {
        reconnectTimerRef.current = window.setTimeout(() => {
          if (generation === connectionGenerationRef.current && selectedIdRef.current === sessionId) void connect(sessionId);
        }, 2500);
      }
      return null;
    });
    if (!socket) return;
    if (generation !== connectionGenerationRef.current || selectedIdRef.current !== sessionId) {
      socket.close();
      return;
    }
    socket.onClose(() => {
      rejectPendingForSocket(socket, new Error("Session connection closed"));
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      setConnected(false);
      if (generation === connectionGenerationRef.current && selectedIdRef.current === sessionId) {
        reconnectTimerRef.current = window.setTimeout(() => {
          if (generation === connectionGenerationRef.current && selectedIdRef.current === sessionId) void connect(sessionId);
        }, 2500);
      }
    });
    socket.send({ type: "client.subscribe", sessionId });
    socketRef.current = socket;
    activeSessionIdRef.current = sessionId;
    setConnected(true);
  }, [rejectPendingForSocket]);

  const syncSelectedQueue = React.useCallback(() => {
    const sessionId = selectedIdRef.current;
    if (!sessionId) return;
    const socket = socketRef.current;
    if (!socket) {
      if (!reconnectTimerRef.current) void connect(sessionId);
      return;
    }
    const pending = queueSyncRef.current;
    if (pending?.sessionId === sessionId && pending.socket === socket) return;
    if (pending) window.clearTimeout(pending.timer);
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      if (queueSyncRef.current?.requestId !== requestId) return;
      queueSyncRef.current = null;
      if (selectedIdRef.current === sessionId && socketRef.current === socket) void connect(sessionId);
    }, 5_000);
    queueSyncRef.current = { requestId, sessionId, socket, timer };
    try {
      socket.send({ type: "client.sync_queue", requestId, sessionId });
    } catch {
      window.clearTimeout(timer);
      if (queueSyncRef.current?.requestId === requestId) queueSyncRef.current = null;
      if (!reconnectTimerRef.current) void connect(sessionId);
    }
  }, [connect]);

  React.useEffect(() => {
    const syncWhenVisible = () => {
      if (document.visibilityState === "visible") syncSelectedQueue();
    };
    const interval = window.setInterval(syncWhenVisible, 60_000);
    document.addEventListener("visibilitychange", syncWhenVisible);
    window.addEventListener("focus", syncWhenVisible);
    window.addEventListener("online", syncWhenVisible);
    window.addEventListener("pageshow", syncWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", syncWhenVisible);
      window.removeEventListener("focus", syncWhenVisible);
      window.removeEventListener("online", syncWhenVisible);
      window.removeEventListener("pageshow", syncWhenVisible);
    };
  }, [syncSelectedQueue]);

  React.useEffect(() => {
    if (!selectedId) return;
    setHashSessionId(selectedId);
    void connect(selectedId);
    return () => {
      connectionGenerationRef.current += 1;
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      if (queueSyncRef.current) window.clearTimeout(queueSyncRef.current.timer);
      queueSyncRef.current = null;
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        rejectPendingForSocket(socket, new Error("Session changed"));
        socket.close();
      }
    };
  }, [connect, selectedId]);

  const selectedSession = currentSession?.id === selectedId
    ? currentSession
    : sessions.find((session) => session.id === selectedId) ?? null;

  const loadSessionOptions = React.useCallback(async (sessionId: string, generation = optionsGenerationRef.current) => {
    try {
      const options = await sendSessionCommand(sessionId, { type: "get_session_options" }) as Partial<WebSessionOptions>;
      if (selectedIdRef.current !== sessionId || optionsGenerationRef.current !== generation) return;
      setSessionOptions((current) => ({
        models: Array.isArray(options.models) ? options.models : [],
        thinkingLevels: Array.isArray(options.thinkingLevels) ? options.thinkingLevels : [],
        commands: includeWebReloadCommand(Array.isArray(options.commands) ? options.commands : current.commands),
      }));
    } catch {
      if (selectedIdRef.current === sessionId && optionsGenerationRef.current === generation) setSessionOptions((current) => ({ ...current, models: [], thinkingLevels: [] }));
    }
  }, []);

  const loadSessionCommands = React.useCallback(async (sessionId: string, generation = optionsGenerationRef.current) => {
    try {
      const response = await sendSessionCommand(sessionId, { type: "get_commands" }) as { commands?: WebSlashCommand[] } | undefined;
      if (selectedIdRef.current !== sessionId || optionsGenerationRef.current !== generation) return;
      setSessionOptions((current) => ({ ...current, commands: includeWebReloadCommand(Array.isArray(response?.commands) ? response.commands : []) }));
    } catch {
      if (selectedIdRef.current === sessionId && optionsGenerationRef.current === generation) {
        setSessionOptions((current) => ({ ...current, commands: includeWebReloadCommand(current.commands) }));
      }
    }
  }, []);

  React.useEffect(() => {
    const generation = ++optionsGenerationRef.current;
    if (!selectedSession || selectedSession.status === "offline") {
      setSessionOptions({ models: [], thinkingLevels: [], commands: [] });
      return;
    }
    void loadSessionOptions(selectedSession.id, generation);
    void loadSessionCommands(selectedSession.id, generation);
  }, [loadSessionCommands, loadSessionOptions, selectedSession?.id, selectedSession?.status]);

  const selectModel = React.useCallback(async (provider: string, modelId: string) => {
    const sessionId = selectedIdRef.current;
    if (!sessionId) return;
    await sendSessionCommand(sessionId, { type: "set_model", provider, modelId });
    await loadSessionOptions(sessionId);
  }, [loadSessionOptions]);

  const selectThinkingLevel = React.useCallback(async (level: string) => {
    const sessionId = selectedIdRef.current;
    if (!sessionId) return;
    await sendSessionCommand(sessionId, { type: "set_thinking_level", level });
  }, []);

  const orderedSessions = React.useMemo(
    () => sortSessionsForSidebar(sessions, sessionSort, sessionOrder),
    [sessionOrder, sessionSort, sessions],
  );
  const filteredSessions = React.useMemo(
    () => orderedSessions.filter((session) => sessionMatches(session, filterQuery)),
    [filterQuery, orderedSessions],
  );
  const repositorySuggestions = React.useMemo(() => recentRepositories(sessions), [sessions]);

  const sendSemanticPrompt = React.useCallback(async (
    message: string,
    images: SemanticImage[],
    streamingBehavior?: "steer" | "followUp",
  ) => {
    const sessionId = selectedIdRef.current;
    const socket = socketRef.current;
    if (!sessionId || !socket) throw new Error("Session is disconnected");
    const requestId = crypto.randomUUID();
    const promptFrame = { type: "client.prompt", requestId, sessionId, message, images, streamingBehavior } satisfies ClientPromptMessage;
    assertClientPromptPayloadFits(promptFrame);
    const queuedFollowUp = streamingBehavior === "followUp" && selectedSession?.status === "working";
    const controlCommand = isWebReloadCommand(message) || /^\/worktree(?:\s|$)/.test(message.trim());
    const optimisticallyWorking = !queuedFollowUp && !controlCommand && selectedSession?.status !== "working";
    const previousStatus = selectedSession?.status;
    if (optimisticallyWorking) {
      setCurrentSession((current) => current?.id === sessionId ? { ...current, status: "working" } : current);
      setSessions((previous) => previous.map((session) => session.id === sessionId ? { ...session, status: "working" } : session));
    }
    const optimisticId = `optimistic-${requestId}`;
    const optimistic: SemanticEntry = {
      id: optimisticId,
      type: "message",
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        timestamp: Date.now(),
        content: [
          ...(message ? [{ type: "text", text: message }] : []),
          ...images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType })),
        ],
      },
    };
    if (!queuedFollowUp) setEntries((previous) => [...previous, optimistic]);
    let responseData: unknown;
    let promptFrameSent = false;
    try {
      responseData = await new Promise<unknown>((resolve, reject) => {
        pendingRequestsRef.current.set(requestId, { socket, optimisticId, resolve, reject });
        try {
          socket.send(promptFrame);
          promptFrameSent = true;
        } catch (cause) {
          pendingRequestsRef.current.delete(requestId);
          if (!queuedFollowUp) setEntries((previous) => previous.filter((entry) => entry.id !== optimisticId));
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        }
      });
    } catch (cause) {
      if (optimisticallyWorking && previousStatus && !promptFrameSent) {
        setCurrentSession((current) => current?.id === sessionId ? { ...current, status: previousStatus } : current);
        setSessions((previous) => previous.map((session) => session.id === sessionId ? { ...session, status: previousStatus } : session));
      }
      throw cause;
    }
    if (isWebReloadCommand(message)) {
      setEntries((previous) => previous.filter((entry) => entry.id !== optimisticId));
      const generation = ++optionsGenerationRef.current;
      await Promise.all([
        loadSessionOptions(sessionId, generation),
        loadSessionCommands(sessionId, generation),
      ]);
      return;
    }
    if (message.trimStart().startsWith("/worktree") && responseData && typeof responseData === "object") {
      const replacementId = (responseData as { sessionId?: unknown }).sessionId;
      if (typeof replacementId === "string") {
        setSelectedId(replacementId);
        setHashSessionId(replacementId);
      }
    }
  }, [loadSessionCommands, loadSessionOptions, selectedSession?.status]);

  const replaceQueuedMessages = React.useCallback(async (queue: WebQueueReplacement[]) => {
    const sessionId = selectedIdRef.current;
    if (!sessionId) throw new Error("No session selected");
    // Keep the visible queue authoritative: the subscribed socket applies the
    // server's web_queue_update only after replace_queue has been accepted.
    await sendSessionCommand(sessionId, { type: "replace_queue", queue });
  }, []);

  const steerQueuedMessage = React.useCallback(async (itemId: string) => {
    const sessionId = selectedIdRef.current;
    if (!sessionId) throw new Error("No session selected");
    await sendSessionCommand(sessionId, { type: "steer_queue_item", itemId });
  }, []);

  const reconcileQueuedMessage = React.useCallback(async (itemId: string, action: "discard" | "resubmit") => {
    const sessionId = selectedIdRef.current;
    if (!sessionId) throw new Error("No session selected");
    await sendSessionCommand(sessionId, { type: "reconcile_queue", itemId, action });
  }, []);

  const abortSemanticSession = React.useCallback(async () => {
    const sessionId = selectedIdRef.current;
    if (!sessionId) return;
    await sendSessionCommand(sessionId, { type: "abort" });
  }, []);

  const handleCreate = React.useCallback(async (request: CreateSessionRequest) => {
    const session = await createSession(request);
    setSessions((prev) => sortSessions([...prev.filter((s) => s.id !== session.id), session]));
    setSelectedId(session.id);
    setHashSessionId(session.id);
  }, []);

  const handleResume = React.useCallback(async (session: WebSession) => {
    if (!session.file) return;
    const resumed = await resumeSession({ file: session.file });
    setSessions((prev) => sortSessions([...prev.filter((s) => s.id !== resumed.id), resumed]));
    setSelectedId(resumed.id);
    setHashSessionId(resumed.id);
  }, []);

  const handleDelete = React.useCallback(async (session: WebSession) => {
    await deleteSession(session.id);
    setSessions((prev) => prev.filter((s) => s.id !== session.id));
    setSessionOrder((previous) => previous.filter((id) => id !== session.id));
    if (selectedIdRef.current === session.id) setSelectedId(null);
  }, []);

  const handleRename = React.useCallback(async (session: WebSession, name: string) => {
    await renameSessionViaCommand(session.id, name);
    const nextName = name || undefined;
    setSessions((previous) => previous.map((item) => item.id === session.id ? { ...item, name: nextName } : item));
    if (selectedIdRef.current === session.id) setCurrentSession((current) => current ? { ...current, name: nextName } : current);
  }, []);

  const handleCompact = React.useCallback(async (session: WebSession) => {
    const next = window.prompt("Compact with custom instructions (optional)", "");
    if (next === null) return;
    await compactSessionViaCommand(session.id, next.trim() || undefined);
    await loadAllSessions();
  }, [loadAllSessions]);

  const handleClone = React.useCallback(async (session: WebSession) => {
    const result = await cloneSessionViaCommand(session.id) as { cancelled?: boolean; sessionId?: string } | undefined;
    if (result?.cancelled) return;
    await loadAllSessions();
    if (result?.sessionId) {
      setSelectedId(result.sessionId);
      setHashSessionId(result.sessionId);
    }
  }, [loadAllSessions]);

  const handleForkOpen = React.useCallback((session: WebSession) => {
    setForkCandidate(session);
  }, []);

  const handleFork = React.useCallback(async (session: WebSession, entryId: string) => {
    const result = await forkSessionViaCommand(session.id, entryId) as { cancelled?: boolean; sessionId?: string } | undefined;
    if (result?.cancelled) return;
    await loadAllSessions();
    if (result?.sessionId) {
      setSelectedId(result.sessionId);
      setHashSessionId(result.sessionId);
    }
  }, [loadAllSessions]);

  const handleSelect = React.useCallback(async (session: WebSession) => {
    if (session.status === "offline" || session.source === "saved") {
      await handleResume(session);
    } else {
      setSelectedId(session.id);
      setHashSessionId(session.id);
    }
    setSidebarOpen(false);
  }, [handleResume]);

  const toggleProject = React.useCallback((key: string) => {
    setCollapsedProjects((previous) => previous.includes(key)
      ? previous.filter((item) => item !== key)
      : [...previous, key]);
  }, []);

  const sessionCard = (session: WebSession, overlay = false) => (
    <SessionListItem
      key={overlay ? `overlay:${session.id}` : session.id}
      session={session}
      selected={session.id === selectedId}
      overlay={overlay}
      onSelect={() => { if (!overlay) void handleSelect(session); }}
      onResume={() => void handleResume(session)}
      onClone={() => void handleClone(session)}
      onFork={() => handleForkOpen(session)}
      onRename={() => setRenameCandidate(session)}
      onCompact={() => void handleCompact(session)}
      onDelete={() => setDeleteCandidate(session)}
    />
  );

  const sessionCardList = (items: WebSession[]) => (
    <SortableContext items={items.map((session) => session.id)} strategy={verticalListSortingStrategy}>
      <div className="space-y-3">{items.map((session) => sessionCard(session))}</div>
    </SortableContext>
  );

  const sessionCollisionDetection = React.useCallback<CollisionDetection>((args) => {
    const activeSession = sessions.find((session) => session.id === String(args.active.id));
    if (!activeSession) return [];
    const projectId = activeSession.projectId ?? `dir:${activeSession.cwd}`;
    const allowedIds = new Set(sessions
      .filter((session) => (session.projectId ?? `dir:${session.cwd}`) === projectId)
      .map((session) => session.id));
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter((container) => allowedIds.has(String(container.id))),
    });
  }, [sessions]);

  const handleSessionDragEnd = React.useCallback((event: DragEndEvent) => {
    setDraggingId(null);
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId || activeId === overId) return;
    const activeSession = sessions.find((session) => session.id === activeId);
    const overSession = sessions.find((session) => session.id === overId);
    if (!activeSession || !overSession) return;
    if ((activeSession.projectId ?? `dir:${activeSession.cwd}`) !== (overSession.projectId ?? `dir:${overSession.cwd}`)) return;
    const orderedIds = orderedSessions.map((session) => session.id);
    const activeIndex = orderedIds.indexOf(activeId);
    const overIndex = orderedIds.indexOf(overId);
    if (activeIndex < 0 || overIndex < 0) return;
    const placement = activeIndex < overIndex ? { afterId: overId } : { beforeId: overId };
    setSessionOrder((previous) => moveWebSessionRelative(
      sessions,
      sessionSort === "custom" ? previous : orderedIds,
      activeId,
      placement,
    ));
    setSessionSort("custom");
  }, [orderedSessions, sessionSort, sessions]);

  const sessionCards = (items: WebSession[]) => {
    return (
      <div className="space-y-5">
        {projectGroups(items).map((group) => {
          const collapseKey = group.id;
          const collapsed = collapsedProjects.includes(collapseKey);
          return (
            <div key={group.id}>
              <button
                className="flex w-full min-w-0 items-center gap-2 rounded-full bg-zinc-900/90 px-3 py-2 text-sm text-zinc-300 transition hover:bg-zinc-800/90"
                aria-expanded={!collapsed}
                onClick={() => toggleProject(collapseKey)}
              >
                {collapsed ? <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" /> : <ChevronDown className="h-4 w-4 shrink-0 text-zinc-400" />}
                <FolderGit2 className="h-4 w-4 shrink-0 text-white" />
                <span className="truncate font-semibold text-zinc-200">{group.name}</span>
                <span className="h-px min-w-4 flex-1 bg-zinc-700" />
                <span className="shrink-0 text-xs tabular-nums text-zinc-500">{group.sessions.length}</span>
              </button>
              {!collapsed && <div className="mt-3">{sessionCardList(group.sessions)}</div>}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="pi-web-shell bg-[#09090b] text-zinc-100">
      <NewSessionDialog open={newSessionOpen} baseSession={selectedSession} repositories={repositorySuggestions} onOpenChange={setNewSessionOpen} onCreate={handleCreate} />
      <RenameSessionDialog
        session={renameCandidate}
        onOpenChange={(open) => { if (!open) setRenameCandidate(null); }}
        onRename={handleRename}
      />
      <DeleteSessionDialog
        session={deleteCandidate}
        onOpenChange={(open) => { if (!open) setDeleteCandidate(null); }}
        onDelete={handleDelete}
      />
      <ForkSessionDialog
        session={forkCandidate}
        onOpenChange={(open) => { if (!open) setForkCandidate(null); }}
        onFork={handleFork}
      />
      <DndContext
        sensors={sessionSensors}
        collisionDetection={sessionCollisionDetection}
        onDragStart={(event) => setDraggingId(String(event.active.id))}
        onDragCancel={() => setDraggingId(null)}
        onDragEnd={handleSessionDragEnd}
      >
      <div className="flex h-full overflow-hidden">
        {sidebarOpen && (
          <button
            aria-label="Close sessions sidebar"
            className="fixed inset-0 z-20 bg-black/60 xl:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <aside className={cn(
          "pi-web-sidebar fixed z-30 w-[min(340px,calc(100vw-24px))] flex-col border-r border-zinc-800 bg-zinc-950/95 p-4 backdrop-blur xl:static xl:w-[340px]",
          sidebarOpen ? "flex" : "hidden",
          sidebarCollapsed ? "xl:hidden" : "xl:flex",
        )}>
          <div className="mb-4 flex gap-2">
            <Button className="h-9 min-w-0 flex-1 justify-start" onClick={() => setNewSessionOpen(true)}>
              <Plus className="h-4 w-4" /> New session
            </Button>
            <SidebarFilterButton
              query={filterQuery}
              onQueryChange={setFilterQuery}
              sort={sessionSort}
              onSortChange={setSessionSort}
              hasCustomOrder={sessionOrder.length > 0}
              onResetOrder={() => { setSessionOrder([]); setSessionSort("newest"); }}
            />
            <Button
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={() => { setSidebarCollapsed(true); setSidebarOpen(false); }}
            >
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {filteredSessions.length > 0
              ? sessionCards(filteredSessions)
              : <p className="px-1 py-3 text-xs text-zinc-600">No sessions match.</p>}
          </div>
        </aside>

        <main className="relative min-w-0 flex-1 bg-[#09090b]">
          <Button
            aria-label="Open sessions sidebar"
            variant="secondary"
            size="icon"
            className={cn("absolute left-2 top-2 z-20 shadow-xl", !sidebarCollapsed && "xl:hidden", sidebarOpen && "hidden")}
            onClick={() => { setSidebarCollapsed(false); setSidebarOpen(true); }}
          >
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
          <SemanticSession
            key={selectedSession?.id ?? "no-session"}
            session={selectedSession}
            entries={entries}
            streamingMessage={streamingMessage}
            streamingMessageKey={streamingMessageKey}
            tools={activeTools}
            error={error}
            connected={connected}
            transcriptLoading={transcriptLoading}
            queuedMessages={queuedMessages}
            sessionOptions={sessionOptions}
            onSelectModel={selectModel}
            onSelectThinkingLevel={selectThinkingLevel}
            onSend={sendSemanticPrompt}
            onReplaceQueue={replaceQueuedMessages}
            onSteerQueuedMessage={steerQueuedMessage}
            onReconcileQueue={reconcileQueuedMessage}
            onAbort={abortSemanticSession}
          />
          {!selectedSession && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-zinc-500">
              {loading ? "Loading sessions…" : error ?? "Select or create a session."}
            </div>
          )}
        </main>
      </div>
      {createPortal(
        <DragOverlay dropAnimation={null}>
          {draggingId ? (() => {
            const session = sessions.find((item) => item.id === draggingId);
            return session ? <div className="w-[308px]">{sessionCard(session, true)}</div> : null;
          })() : null}
        </DragOverlay>,
        document.body,
      )}
      </DndContext>
    </div>
  );
}
