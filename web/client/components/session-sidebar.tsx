import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FolderGit2,
  GitFork,
  Link2,
  ListFilter,
  ListRestart,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Trash2,
  WandSparkles,
} from "lucide-react";
import * as React from "react";
import type { WebSession } from "../../protocol";
import { cn } from "../lib/utils";
import {
  type SessionSort,
  sessionStatusClasses,
  sessionStatusLabel,
  sessionSubtitle,
  sessionTitle,
} from "../session-utils";
import { AnchoredPopover } from "./anchored-popover";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

function fitBeginningEllipsis(
  text: string,
  maxWidth: number,
  measure: (value: string) => number,
): string {
  if (maxWidth <= 0 || measure(text) <= maxWidth) return text;
  const characters = Array.from(text);
  let low = 0;
  let high = characters.length;
  let visibleCharacters = 0;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const candidate = `…${characters.slice(characters.length - count).join("")}`;
    if (measure(candidate) <= maxWidth) {
      visibleCharacters = count;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  return `…${characters.slice(characters.length - visibleCharacters).join("")}`;
}

let sessionLocationMeasurementContext:
  | CanvasRenderingContext2D
  | null
  | undefined;

function textMeasurementContext(): CanvasRenderingContext2D | null {
  if (sessionLocationMeasurementContext === undefined) {
    sessionLocationMeasurementContext = document
      .createElement("canvas")
      .getContext("2d");
  }
  return sessionLocationMeasurementContext;
}

function SessionLocation({ session }: { session: WebSession }) {
  const text = sessionSubtitle(session);
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [visibleText, setVisibleText] = React.useState(text);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const context = textMeasurementContext();
    if (!context) return;
    const update = () => {
      const style = getComputedStyle(element);
      context.font =
        style.font ||
        `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const letterSpacing = Number.parseFloat(style.letterSpacing) || 0;
      const measure = (value: string) =>
        context.measureText(value).width +
        Math.max(0, Array.from(value).length - 1) * letterSpacing;
      const fitted = fitBeginningEllipsis(text, element.clientWidth, measure);
      setVisibleText((current) => (current === fitted ? current : fitted));
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    void document.fonts?.ready.then(update);
    return () => observer.disconnect();
  }, [text]);
  return (
    <div
      ref={ref}
      className="session-location text-left text-xs text-zinc-500"
      dir="ltr"
      title={text}
    >
      {visibleText}
    </div>
  );
}

type ProjectSessionGroup = { id: string; name: string; sessions: WebSession[] };

function projectGroups(sessions: WebSession[]): ProjectSessionGroup[] {
  const groups = new Map<string, ProjectSessionGroup>();
  for (const session of sessions) {
    const id = session.projectId ?? `dir:${session.cwd}`;
    const name =
      session.projectName ??
      session.cwd.split("/").filter(Boolean).pop() ??
      session.cwd;
    const group = groups.get(id) ?? { id, name, sessions: [] };
    group.sessions.push(session);
    groups.set(id, group);
  }
  return Array.from(groups.values());
}

export function SidebarFilterButton({
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
      <AnchoredPopover
        open={open}
        onOpenChange={setOpen}
        anchorRef={buttonRef}
        className="w-72 p-3"
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <label
              htmlFor="session-filter"
              className="text-xs font-medium uppercase tracking-wider text-zinc-500"
            >
              Filter sessions
            </label>
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
            <label
              htmlFor="session-sort"
              className="text-xs font-medium uppercase tracking-wider text-zinc-500"
            >
              Sort
            </label>
            <select
              id="session-sort"
              value={sort}
              onChange={(event) =>
                onSortChange(event.target.value as SessionSort)
              }
              className="h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-200 outline-none focus:ring-2 focus:ring-sky-400/70"
            >
              <option value="newest">Newest created first</option>
              <option value="oldest">Oldest created first</option>
              <option value="custom" disabled={!hasCustomOrder}>
                Custom order
              </option>
            </select>
          </div>
          {hasCustomOrder && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={onResetOrder}
            >
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

/** Build the shareable URL for a session, matching the app's #/sessions/<id> hash routing. */
function sessionUrl(sessionId: string): string {
  return `${window.location.origin}${window.location.pathname}#/sessions/${encodeURIComponent(sessionId)}`;
}

async function copySessionUrl(sessionId: string): Promise<void> {
  const url = sessionUrl(sessionId);
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url);
    return;
  }
  // Non-secure-context fallback (e.g. plain-HTTP LAN access).
  const helper = document.createElement("textarea");
  helper.value = url;
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.appendChild(helper);
  helper.select();
  try {
    document.execCommand("copy");
  } finally {
    helper.remove();
  }
}

function SessionActionItems({
  session,
  actions,
  onAction,
}: {
  session: WebSession;
  actions: SessionActionCallbacks;
  onAction: () => void;
}) {
  const inactive = session.status === "offline" || session.source === "saved";
  const action = (callback: () => void) => {
    onAction();
    callback();
  };
  const itemClass =
    "flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white";
  return (
    <div
      role="menu"
      tabIndex={-1}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {inactive && (
        <button
          type="button"
          className={itemClass}
          onClick={() => action(actions.onResume)}
        >
          <Play className="h-4 w-4" /> Resume
        </button>
      )}
      {!inactive && (
        <button
          type="button"
          className={itemClass}
          onClick={() => action(actions.onClone)}
        >
          <Copy className="h-4 w-4" /> Clone
        </button>
      )}
      {!inactive && (
        <button
          type="button"
          className={itemClass}
          onClick={() => action(actions.onFork)}
        >
          <GitFork className="h-4 w-4" /> Fork
        </button>
      )}
      <button
        type="button"
        className={itemClass}
        onClick={() => action(actions.onRename)}
      >
        <Pencil className="h-4 w-4" /> Rename
      </button>
      <button
        type="button"
        className={itemClass}
        onClick={() => action(actions.onCompact)}
      >
        <WandSparkles className="h-4 w-4" /> Compact
      </button>
      <button
        type="button"
        className={itemClass}
        onClick={() =>
          action(() => {
            void copySessionUrl(session.id).catch(() => undefined);
          })
        }
      >
        <Link2 className="h-4 w-4" /> Copy URL
      </button>
      <div className="my-1 border-t border-zinc-800" />
      <button
        type="button"
        className={cn(
          itemClass,
          "text-red-300 hover:bg-red-500/10 hover:text-red-200",
        )}
        onClick={() => action(actions.onDelete)}
      >
        <Trash2 className="h-4 w-4" /> Delete
      </button>
    </div>
  );
}

function SessionActionsMenu({
  session,
  actions,
}: {
  session: WebSession;
  actions: SessionActionCallbacks;
}) {
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
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>
      <AnchoredPopover
        open={open}
        onOpenChange={setOpen}
        anchorRef={buttonRef}
        className="w-44"
      >
        <SessionActionItems
          session={session}
          actions={actions}
          onAction={() => setOpen(false)}
        />
      </AnchoredPopover>
    </>
  );
}

export function SessionListItem({
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
  const [contextPoint, setContextPoint] = React.useState<{
    x: number;
    y: number;
  } | null>(null);
  const contextAnchorRef = React.useRef<HTMLSpanElement | null>(null);
  const sortable = useSortable({
    id: overlay ? `overlay:${session.id}` : session.id,
    disabled: overlay,
  });
  const style = overlay
    ? undefined
    : {
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      };
  const actions: SessionActionCallbacks = {
    onResume,
    onClone,
    onFork,
    onRename,
    onCompact,
    onDelete,
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <button> would conflict with dnd-kit's drag listeners and need default-style resets; role="button" + tabIndex is the established pattern.
    <div
      ref={overlay ? undefined : sortable.setNodeRef}
      style={style}
      {...(overlay ? {} : sortable.attributes)}
      {...(overlay ? {} : sortable.listeners)}
      // Explicit role/tabIndex after the spread so an overlay row (no dnd
      // attributes) is still keyboard reachable.
      role="button"
      tabIndex={0}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setContextPoint({ x: event.clientX, y: event.clientY });
      }}
      onClick={onSelect}
      onKeyDown={(event) => {
        sortable.listeners?.onKeyDown?.(event);
        if (
          !event.defaultPrevented &&
          (event.key === "Enter" || event.key === " ")
        ) {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group w-full rounded-xl border p-3 text-left transition",
        !overlay && "cursor-grab touch-none active:cursor-grabbing",
        selected
          ? "border-white/60 bg-white/10"
          : "border-zinc-800 bg-zinc-950/50 hover:border-zinc-700 hover:bg-zinc-900",
        sortable.isDragging && "opacity-0",
        overlay && "cursor-grabbing border-white/70 bg-zinc-900 shadow-2xl",
      )}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1">
        <div className="truncate text-sm font-medium text-zinc-100">
          {sessionTitle(session)}
        </div>
        <SessionActionsMenu session={session} actions={actions} />
        <SessionLocation session={session} />
        <span
          className={cn(
            "inline-flex justify-self-end rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize leading-none",
            sessionStatusClasses(session),
          )}
        >
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
        style={
          contextPoint
            ? { left: contextPoint.x, top: contextPoint.y }
            : undefined
        }
      />
      <AnchoredPopover
        open={contextPoint !== null}
        onOpenChange={(open) => {
          if (!open) setContextPoint(null);
        }}
        anchorRef={contextAnchorRef}
        align="start"
        className="w-44"
      >
        <SessionActionItems
          session={session}
          actions={actions}
          onAction={() => setContextPoint(null)}
        />
      </AnchoredPopover>
    </div>
  );
}

function ProjectSessionGroupSection({
  group,
  collapsed,
  onToggle,
  onNewSession,
  children,
}: {
  group: ProjectSessionGroup;
  collapsed: boolean;
  onToggle: () => void;
  onNewSession: (directory: string) => void;
  children: React.ReactNode;
}) {
  const [contextPoint, setContextPoint] = React.useState<{
    x: number;
    y: number;
  } | null>(null);
  const contextAnchorRef = React.useRef<HTMLSpanElement | null>(null);
  const directory =
    group.sessions[0]?.repositoryRoot ?? group.sessions[0]?.cwd ?? "";
  const itemClass =
    "flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white";
  return (
    <div>
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 rounded-full bg-zinc-900/90 px-3 py-2 text-sm text-zinc-300 transition hover:bg-zinc-800/90"
        aria-expanded={!collapsed}
        onClick={onToggle}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setContextPoint({ x: event.clientX, y: event.clientY });
        }}
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-zinc-400" />
        )}
        <FolderGit2 className="h-4 w-4 shrink-0 text-white" />
        <span className="truncate font-semibold text-zinc-200">
          {group.name}
        </span>
        <span className="h-px min-w-4 flex-1 bg-zinc-700" />
      </button>
      {!collapsed && <div className="mt-3">{children}</div>}
      <span
        ref={contextAnchorRef}
        className="pointer-events-none fixed h-0 w-0"
        style={
          contextPoint
            ? { left: contextPoint.x, top: contextPoint.y }
            : undefined
        }
      />
      <AnchoredPopover
        open={contextPoint !== null}
        onOpenChange={(open) => {
          if (!open) setContextPoint(null);
        }}
        anchorRef={contextAnchorRef}
        align="start"
        className="w-44"
      >
        <div
          role="menu"
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className={itemClass}
            disabled={!directory}
            onClick={() => {
              setContextPoint(null);
              if (directory) onNewSession(directory);
            }}
          >
            <Plus className="h-4 w-4" /> New session
          </button>
        </div>
      </AnchoredPopover>
    </div>
  );
}

export function SessionSidebarList({
  sessions,
  selectedId,
  collapsedProjects,
  onToggleProject,
  onNewSession,
  onSelect,
  onResume,
  onClone,
  onFork,
  onRename,
  onCompact,
  onDelete,
}: {
  sessions: WebSession[];
  selectedId: string | null;
  collapsedProjects: readonly string[];
  onToggleProject: (projectId: string) => void;
  onNewSession: (directory: string) => void;
  onSelect: (session: WebSession) => void;
  onResume: (session: WebSession) => void;
  onClone: (session: WebSession) => void;
  onFork: (session: WebSession) => void;
  onRename: (session: WebSession) => void;
  onCompact: (session: WebSession) => void;
  onDelete: (session: WebSession) => void;
}) {
  const card = (session: WebSession) => (
    <SessionListItem
      key={session.id}
      session={session}
      selected={session.id === selectedId}
      onSelect={() => onSelect(session)}
      onResume={() => onResume(session)}
      onClone={() => onClone(session)}
      onFork={() => onFork(session)}
      onRename={() => onRename(session)}
      onCompact={() => onCompact(session)}
      onDelete={() => onDelete(session)}
    />
  );
  return (
    <div className="space-y-5">
      {projectGroups(sessions).map((group) => {
        const collapsed = collapsedProjects.includes(group.id);
        return (
          <ProjectSessionGroupSection
            key={group.id}
            group={group}
            collapsed={collapsed}
            onToggle={() => onToggleProject(group.id)}
            onNewSession={onNewSession}
          >
            <SortableContext
              items={group.sessions.map((session) => session.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-3">{group.sessions.map(card)}</div>
            </SortableContext>
          </ProjectSessionGroupSection>
        );
      })}
    </div>
  );
}
