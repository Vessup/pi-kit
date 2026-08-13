---
name: worktree
description: Create Git worktrees under the repository's .pi/worktrees directory and initialize them with an optional setup script. Use whenever the user asks to create, add, or set up a Git worktree.
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

6. Report the absolute worktree path, checked-out branch/ref, and setup result. If setup fails, report the failure and leave the successfully created worktree intact for inspection; do not silently remove it.

Use quoted absolute paths in all commands. Never overwrite an existing directory or reuse a branch already checked out elsewhere without explicit user approval.
