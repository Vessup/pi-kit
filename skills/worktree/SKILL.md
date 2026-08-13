---
name: worktree
description: Create Git worktrees under the repository's .pi/worktrees directory, initialize them, and migrate the current Pi conversation into a replacement session rooted in the worktree. Use whenever the user asks to create, add, or set up a Git worktree.
---

# Worktree

When asked to create a Git worktree, always place it at `<repo-root>/.pi/worktrees/<name>`.

## Procedure

1. Resolve the primary repository root, including when the current directory is already a linked worktree:

   ```bash
   common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
   repo_root="$(dirname "$common_dir")"
   ```

2. Choose a short, filesystem-safe `name`. Use the user-provided name when available; otherwise derive it from the branch. The name must be one path segment, not an absolute path, and must not contain `..`, `/`, or `\\`.
3. Set `worktree="$repo_root/.pi/worktrees/$name"` and verify that the path does not already exist. Do not create a worktree anywhere else unless the user explicitly overrides this skill's location.
4. Create the parent directory and use normal `git worktree add` semantics:
   - Existing branch: `git -C "$repo_root" worktree add "$worktree" "$branch"`
   - New branch: `git -C "$repo_root" worktree add -b "$branch" "$worktree" "$start_point"`
   - Use the user's requested ref, branch, or detached mode when specified. Do not guess destructively if the request is ambiguous.
5. After creation succeeds, check for `$repo_root/.pi/worktrees/setup.sh`. If it is a regular file, run it with the new worktree as the working directory:

   ```bash
   setup="$repo_root/.pi/worktrees/setup.sh"
   if [ -f "$setup" ]; then
     (cd "$worktree" && if [ -x "$setup" ]; then "$setup"; else sh "$setup"; fi)
   fi
   ```

6. If setup fails, report the failure and leave the successfully created worktree intact for inspection; do not silently remove it or migrate the session.
7. After setup succeeds, migrate the current Pi conversation to the worktree. This is required unless the user explicitly asks to create only the Git worktree:
   - Record the original session ID and session file before doing anything destructive. Prefer `PI_SESSION_ID` and `PI_SESSION_FILE` when available; otherwise use the harness's session-management API.
   - **Fork the original session history into a replacement session whose recorded CWD is exactly `worktree`.** Do not merely fork in place: an ordinary in-process `/fork` keeps the old CWD and is not sufficient.
   - With the Pi CLI, start the fork from the target directory so Pi records the correct project:

     ```bash
     old_session="$PI_SESSION_FILE"
     (cd "$worktree" && env -u PI_SESSION_ID -u PI_SESSION_FILE pi --fork "$old_session")
     ```

     Use the harness's native cross-CWD fork/session-replacement operation instead when one is available. Do not launch a nested interactive Pi inside a non-interactive tool call; arrange the replacement through the active client/session manager.
   - Verify the replacement session exists, its session header/CWD resolves to `worktree`, and `git -C "$worktree" branch --show-current` (or detached `HEAD`) matches the requested ref. Switch the client to that replacement session before continuing work.
   - Only after the replacement is active and verified, permanently delete the original session by its recorded ID/file through the session manager. `/delete-session` is safe only when invoked in the original client/process while that client still points to the original session; never invoke it from the replacement session because it deletes the current session. Never delete the original JSONL first, never delete the replacement, and never claim migration succeeded while the active client is still attached to the old session.
   - If the current harness cannot create and activate a cross-CWD fork safely, keep the original session, report the exact blocker, and give the user the target-directory `pi --fork` command above. Preserving the old session is mandatory on any migration failure.
8. Continue all subsequent work in the replacement session, using the worktree as CWD and its checked-out branch/ref. Report the replacement session ID/file, absolute worktree path, checked-out branch/ref, setup result, and deletion of the original session.

Use quoted absolute paths in all commands. Never overwrite an existing directory or reuse a branch already checked out elsewhere without explicit user approval.
