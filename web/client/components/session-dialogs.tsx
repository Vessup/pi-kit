import * as React from "react";
import type { WebSession } from "../../protocol";
import { type ForkMessageItem, getForkMessages } from "../api";
import { cn } from "../lib/utils";
import { sessionTitle } from "../session-utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

export function RenameSessionDialog({
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
          <DialogDescription>
            Set the name shown in Pi and the web sidebar.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
            placeholder="Session name"
          />
          {renameError && (
            <p
              role="alert"
              className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300"
            >
              {renameError}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? "Renaming…" : "Rename"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteSessionDialog({
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
          <p>
            {session?.file
              ? "Its saved session file will be permanently removed."
              : "This unsaved session will be permanently removed."}
          </p>
          {session?.managedWorktree && (
            <p className="break-all rounded-md bg-zinc-900 p-2 font-mono text-xs text-zinc-500">
              Managed worktree: {session.managedWorktree.path}
            </p>
          )}
          {session?.file && (
            <p className="break-all rounded-md bg-zinc-900 p-2 font-mono text-xs text-zinc-500">
              {session.file}
            </p>
          )}
          {deleteError && (
            <p
              role="alert"
              className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-red-300"
            >
              {deleteError}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
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
                setDeleteError(
                  cause instanceof Error ? cause.message : String(cause),
                );
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

export function ForkSessionDialog({
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
    void getForkMessages(session.id)
      .then((items) => {
        if (cancelled) return;
        setMessages(items);
        setSelectedEntryId(items.at(-1)?.entryId ?? "");
      })
      .catch((cause) => {
        if (!cancelled)
          setForkError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
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
          <DialogDescription>
            Select the user message to branch from.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {loading && (
            <p className="text-sm text-zinc-400">Loading fork points…</p>
          )}
          {!loading && messages.length === 0 && !forkError && (
            <p className="text-sm text-zinc-400">
              This session has no user messages to fork from.
            </p>
          )}
          {messages.length > 0 && (
            <div className="max-h-72 space-y-2 overflow-y-auto">
              {messages.map((message) => (
                <label
                  key={message.entryId}
                  className={cn(
                    "flex cursor-pointer gap-3 rounded-lg border p-3 text-sm",
                    selectedEntryId === message.entryId
                      ? "border-sky-400/60 bg-sky-400/10"
                      : "border-zinc-800 bg-zinc-950",
                  )}
                >
                  <input
                    type="radio"
                    name="fork-entry"
                    value={message.entryId}
                    checked={selectedEntryId === message.entryId}
                    onChange={() => setSelectedEntryId(message.entryId)}
                  />
                  <span className="line-clamp-3 text-zinc-300">
                    {message.text}
                  </span>
                </label>
              ))}
            </div>
          )}
          {forkError && (
            <p
              role="alert"
              className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300"
            >
              {forkError}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={loading || busy || !selectedEntryId}
            onClick={() => void submit()}
          >
            {busy ? "Forking…" : "Fork"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
