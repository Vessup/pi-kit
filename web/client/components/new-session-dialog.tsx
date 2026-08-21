import * as React from "react";
import type { CreateSessionRequest } from "../../protocol";
import {
  type BranchSuggestions,
  listBranchSuggestions,
  listDirectorySuggestions,
} from "../api";
import {
  AutocompleteInput,
  type AutocompleteSuggestion,
} from "./autocomplete-input";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

/** Turn a branch name such as owner/topic into one safe worktree path segment. */
function worktreeNameFromBranch(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function NewSessionDialog({
  open,
  initialRepository,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  initialRepository?: string;
  onOpenChange: (open: boolean) => void;
  onCreate: (value: CreateSessionRequest) => Promise<void>;
}) {
  const [repository, setRepository] = React.useState("");
  const [repositorySuggestions, setRepositorySuggestions] = React.useState<
    AutocompleteSuggestion[]
  >([]);
  const [branch, setBranch] = React.useState("");
  const [branchSuggestions, setBranchSuggestions] =
    React.useState<BranchSuggestions>({ local: [], remote: [] });
  const [worktreeName, setWorktreeName] = React.useState("");
  const [worktreeNameEdited, setWorktreeNameEdited] = React.useState(false);
  const [name, setName] = React.useState("");
  const [nameEdited, setNameEdited] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const repositoryListId = React.useId();
  React.useEffect(() => {
    if (!open) return;
    setRepository(initialRepository?.trim() || "~/");
    setRepositorySuggestions([]);
    setBranch("");
    setBranchSuggestions({ local: [], remote: [] });
    setWorktreeName("");
    setWorktreeNameEdited(false);
    setName("");
    setNameEdited(false);
    setBusy(false);
    setCreateError(null);
  }, [initialRepository, open]);
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void listDirectorySuggestions(repository).then((directories) => {
        if (!cancelled)
          setRepositorySuggestions(
            directories.map((directory) => ({ value: directory })),
          );
      });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [open, repository]);
  const repositoryQuery = repository.trim();
  React.useEffect(() => {
    if (!open || !repositoryQuery) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void listBranchSuggestions(repositoryQuery).then((branches) => {
        if (!cancelled) setBranchSuggestions(branches);
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [open, repositoryQuery]);
  const branchSuggestionsForInput = React.useMemo<AutocompleteSuggestion[]>(
    () => [
      ...branchSuggestions.local.map((value) => ({ value, label: "local" })),
      ...branchSuggestions.remote.map((value) => ({ value, label: "remote" })),
    ],
    [branchSuggestions],
  );
  const trimmedBranch = branch.trim();
  // A branch that matches a remote-tracking ref selects it: the local branch
  // is derived by stripping the remote prefix, and the remote ref becomes the
  // start point so the new branch tracks it.
  const remoteBranch = branchSuggestions.remote.find(
    (candidate) => candidate === trimmedBranch,
  );
  const localBranch = remoteBranch
    ? remoteBranch.slice(remoteBranch.indexOf("/") + 1)
    : trimmedBranch;
  const startPoint =
    remoteBranch && !branchSuggestions.local.includes(localBranch)
      ? remoteBranch
      : undefined;
  React.useEffect(() => {
    if (worktreeNameEdited) return;
    setWorktreeName(worktreeNameFromBranch(localBranch));
  }, [localBranch, worktreeNameEdited]);
  React.useEffect(() => {
    if (nameEdited) return;
    setName(worktreeName.trim());
  }, [nameEdited, worktreeName]);
  const submit = async () => {
    if (busy || !repository.trim()) return;
    setBusy(true);
    setCreateError(null);
    try {
      const resolvedWorktreeName =
        worktreeName.trim() || worktreeNameFromBranch(localBranch);
      await onCreate({
        cwd: repository.trim(),
        name: name.trim() || undefined,
        worktreeName: localBranch
          ? resolvedWorktreeName || undefined
          : undefined,
        worktreeBranch: localBranch || undefined,
        worktreeStartPoint: localBranch ? startPoint : undefined,
      });
      onOpenChange(false);
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          onKeyDown={(event) => {
            // Cmd+Enter / Ctrl+Enter submits from any field, including while
            // an autocomplete suggestion is highlighted (where plain Enter
            // accepts the suggestion instead).
            if (
              event.key === "Enter" &&
              (event.metaKey || event.ctrlKey) &&
              !event.altKey &&
              !event.shiftKey
            ) {
              event.preventDefault();
              void submit();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>New session</DialogTitle>
            <DialogDescription>
              Choose a repository directory. Pick a branch to open it in a
              linked worktree.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <AutocompleteInput
              id={`${repositoryListId}-input`}
              label="repository"
              value={repository}
              onChange={(value) => {
                setRepository(value);
                setCreateError(null);
              }}
              suggestions={repositorySuggestions}
              placeholder="~/path/to/repository"
              acceptSuffix="/"
              hint="Suggestions list directories under ~ and stop once a Git repository is selected."
            />
            <AutocompleteInput
              id={`${repositoryListId}-branch`}
              label="worktree branch"
              value={branch}
              onChange={(value) => {
                setBranch(value);
                setCreateError(null);
              }}
              suggestions={branchSuggestionsForInput}
              placeholder="Optional, e.g. main or origin/owner/topic"
              hint="Local and remote branches of the repository. Choosing a remote branch creates a local branch that tracks it."
            />
            <div className="space-y-2">
              <label
                className="text-xs uppercase tracking-wider text-zinc-500"
                htmlFor={`${repositoryListId}-worktree`}
              >
                worktree name
              </label>
              <Input
                id={`${repositoryListId}-worktree`}
                value={worktreeName}
                onChange={(event) => {
                  setWorktreeName(event.target.value);
                  setWorktreeNameEdited(true);
                  setCreateError(null);
                }}
                placeholder="Optional managed directory name"
              />
              <p className="text-xs text-zinc-500">
                Generated from the branch; edit to override. Creates or reuses{" "}
                <code>&lt;repo-root&gt;/.pi/worktrees/&lt;name&gt;</code>.
              </p>
            </div>
            <div className="space-y-2">
              <label
                className="text-xs uppercase tracking-wider text-zinc-500"
                htmlFor={`${repositoryListId}-session-name`}
              >
                session name
              </label>
              <Input
                id={`${repositoryListId}-session-name`}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameEdited(true);
                }}
                placeholder="Optional display name"
              />
              <p className="text-xs text-zinc-500">
                Generated from the worktree name; edit to override.
              </p>
            </div>
            {createError && (
              <p
                role="alert"
                className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300"
              >
                {createError}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <DialogClose>Cancel</DialogClose>
            <Button type="submit" disabled={busy || !repository.trim()}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
