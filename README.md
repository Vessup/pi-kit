# @vessup/pi-kit

Reusable extensions for the [Pi coding agent](https://github.com/earendil-works/pi).

## PR footer

`extensions/pr-footer.ts` contributes the current GitHub pull request to the shared footer as a right-aligned, clickable ` #123` link on the directory/branch line above the model information. A colored circle beside it shows the aggregate check status:

- Green: checks passed
- Yellow: checks are pending or in progress
- Red: at least one check failed or was cancelled

It uses the GitHub CLI to resolve the pull request and check status for the checked-out branch, refreshing every 30 seconds. If `gh` is unavailable, unauthenticated, or the branch has no pull request, the link is hidden. Run `/pr-refresh` to refresh immediately.

### Requirements

- Pi 0.84.1
- Git 2.36.0 or newer
- `lsof` for exclusive source-session verification during worktree replacement
- GitHub CLI (`gh`), authenticated with `gh auth login`
- A terminal that supports OSC 8 hyperlinks for clickable links
- A Nerd Font for the branch icon

## Subagents

`extensions/subagents.ts` lets the main agent run up to eight isolated subagents in the background. Each subagent can use its own model, reasoning effort, prompt, and working directory. The extension provides tools to:

- Create and monitor subagents
- Read activity, output, and retained transcripts
- Send urgent steering or queued follow-up messages
- Change model and reasoning effort
- Terminate subagents and release their resources

The subagent extension independently contributes its token use and status to `extensions/session-footer.ts`, the package's generic composable footer. When subagents are involved, a third footer line shows their aggregate status. With an empty editor, press Option+Down (Alt+Down) to select that line and Enter to open the manager; `/subagents` opens it directly. The manager shows individual status and transcripts and supports model, effort, messaging, and termination controls. Run `/subagents-cleanup` to stop and remove every retained subagent.

## Auto model routing

`extensions/auto-router.ts` adds an "Auto" entry to `/model`. Selecting it routes each turn to a model/reasoning-effort pair chosen from your own configured lists, based on the turn's classified complexity, and fails over to other configured models or tiers when one is unhealthy or out of usage.

Configure it under a new `autoRouter` key in `~/.pi/agent/settings.json` (or `.pi/settings.json` for a project override):

```json
{
  "autoRouter": {
    "efforts": {
      "medium": {
        "models": [
          { "provider": "anthropic", "id": "claude-sonnet-4-5" },
          { "provider": "openai", "id": "gpt-5.3-codex" }
        ]
      },
      "high": {
        "models": [{ "provider": "anthropic", "id": "claude-opus-4-7" }]
      },
      "xhigh": {
        "models": [{ "provider": "openai", "id": "gpt-5.6-sol" }]
      }
    }
  }
}
```

Each tier key is a Pi thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); `medium` is the default/anchor tier. Each tier holds an ordered list of `{ provider, id }` model references — the first is preferred, later entries are failover within that tier.

On every turn, Auto asks the `medium` tier's first healthy model (the "default model") to classify the turn as `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, then routes to the resolved tier: if the classified level has no configured models, it steps toward `medium` until it finds one (a classified `low` with nothing configured there falls back to `medium`). Within that tier it picks the first model that isn't in a failure/rate-limit cooldown; if every model in the tier is unhealthy, it escalates to the next *higher* configured tier; if nothing anywhere is healthy, it uses the first configured model anyway rather than blocking the turn, with a warning.

Health is tracked from two sources. Router-observed traffic (HTTP status codes, rate-limit headers, and message-level provider errors that never surface as a bad HTTP status) sets an immediate cooldown the moment Auto itself sees a model fail. Separately, best-effort real quota reconciliation runs at session start and on `/usage`, for providers with a known quota source: Anthropic, OpenAI Codex, Z.ai, Kimi Coding, and OpenCode Go via their HTTP APIs (using the same credentials Pi already has for each), plus Minimax via its `mmx` CLI (`mmx auth login`) since MiniMax has no HTTP quota endpoint of its own. This is what lets the router self-correct for usage consumed outside the current session (a different session, a manual `/model` pick, another tool) instead of only reacting to its own failures. Codex specifically reports quota per-model for models it meters individually (its own `additional_rate_limits` entries) — those are independent of its account-wide limit in both directions, so a model with its own entry is neither blocked by, nor shielded by, the account-wide state; only models without one fall back to it. Providers without a known quota source simply stay on router-observed data.

Run `/usage` to see health and usage for every configured model, grouped by tier. Each row shows its cooldown status if any, the real "verified usage" reported by the provider's own quota API when available (e.g. "5% used" or "interval 81% left, weekly 89% left"), and separately the request/token/cost totals *this router itself* has routed to that model this way — the latter only reflects Auto's own traffic and will read zero for a model you've used through other means, which is exactly what verified usage is for. Shown as a bordered dashboard in the TUI, or a compact summary elsewhere (including Pi Web).

The `/model` picker's effort/thinking control is inert while Auto is selected, since effort is chosen per turn internally. `/model` keeps showing "Auto" selected even after routing: the real model is only swapped in for the duration of each turn and swapped back to the inert Auto placeholder as soon as it settles, so reopening `/model` between turns still shows Auto, not whichever model last handled a turn. A `🔀 Auto (<tier>)` badge in the TUI footer tracks the most recently used tier regardless of which of the two is currently selected. Manually picking a different model from `/model` turns Auto off; reselecting "Auto" turns it back on.

If you've scoped `/model` with `enabledModels` (or `--models`), Pi's picker defaults to showing only that scoped list, hiding everything else — including Auto — behind a manual Tab to "all". At session start, Auto best-effort appends its own `auto/auto` pattern to `enabledModels` (only when scoping is already configured, and only if it isn't already present) so it shows up in the default scoped view too, without changing anything else about what's scoped.

### Requirements

- Pi 0.84.1
- Network access from the machine running Pi, for the optional quota reconciliation calls (never required — routing and `/usage` work fully offline from router-observed data alone)
- For Minimax quota reconciliation specifically: MiniMax's own `mmx` CLI on `PATH`, logged in via `mmx auth login`. Without it, Minimax models just stay on router-observed data like any other unsupported provider.

## Worktrees

Run `/worktree <name>` to create `<repo-root>/.pi/worktrees/<name>`, run the optional `.pi/worktrees/setup.sh`, and move the active conversation into a replacement session rooted in the managed checkout. The backward-compatible default creates or reuses local branch `<name>`; a missing branch starts at the selected checkout's `HEAD`.

The managed directory name, local branch, and new-branch start point can be selected independently:

```sh
/worktree pr-30 --repo /path/to/repo \
  --branch tembo/cancel-builds \
  --start-point origin/tembo/cancel-builds
```

That creates `.pi/worktrees/pr-30` without creating a `pr-30` branch. If `tembo/cancel-builds` does not exist locally, it is created at `origin/tembo/cancel-builds` and tracks that remote branch. If the local branch already exists, omit `--start-point`; Pi reuses it without moving it or taking ownership of it. A branch already checked out in any registered worktree is rejected. To enter an already registered worktree without modifying its checkout or branch, run `/worktree --existing <worktree-path>`.

Managed ownership records the directory name and whether Pi created the local branch. Final-session cleanup removes the managed checkout, while automatic rollback removes it only when clean so unrelated uncommitted files are never discarded. Both paths delete only a branch created by Pi; reused branches are preserved. Switching completes only after the replacement CWD and actual branch or detached HEAD are verified; the replacement is then made self-contained and the source session is deleted automatically.

The LLM-callable `worktree` tool provides the same `name`, `repository`, `branch`, `startPoint`, and `existing` flows. For a pull request URL, agents must resolve the PR's real head branch and fetched remote-tracking ref and pass them explicitly rather than deriving a branch from a directory such as `pr-30`. The tool queues a correlated `/worktree` follow-up, ends the old run, verifies the replacement, and resumes its continuation there. Create-only requests that should not enter the checkout remain ordinary Git operations.

## Web sessions

`extensions/web-sessions.ts` connects every running Pi session to a local Bun server. The first Pi process starts the server on `127.0.0.1:31415`; later processes discover it through `~/.pi/agent/web/server.json` and attach their own live event streams.

The bundled Vite/React app provides a shadcn/ui-style session shell with:

- Sessions with filtering, creation-time sorting, and persistent drag-and-drop ordering
- Collapsible repository groups by default, keeping linked Git worktrees together
- Responsive collapsible sidebar and per-session menus for resume, delete, clone, fork, rename, and compact controls
- Semantic conversation rendering for both browser-managed and native Pi sessions
- Streaming assistant text, thinking, tool activity, queued follow-ups, model selection, and image prompts
- Fork-point selection from the session's real user-message entries
- Optional Tailscale Serve publishing for HTTPS access from authorized tailnet identities

A linked `🌐` appears at the far left of Pi's first footer line, immediately before the directory. Click it to open that session directly, or run `/web` to display its URL.

The server is intentionally tokenless so installed iOS home-screen links remain stable. It binds only to localhost unless explicitly published through Tailscale Serve. Local machine users are therefore inside the trust boundary; remote access relies on Tailscale Service grants, which must be limited to trusted identities. Browser WebSockets also require an exact same-host `Origin`, preventing unrelated websites from driving shell-capable sessions. Do not expose the localhost port with a generic reverse proxy or Tailscale Funnel.

Browser-created sessions use Pi's RPC mode, while native Pi processes keep their physical TUI and publish semantic session events. The browser never requests an isolated TUI repaint or resizes the native terminal, avoiding the CPU starvation that full viewport rendering can cause on long sessions. Bun must be installed on the machine running the web server.

### Tailscale

If Tailscale is installed and connected, opt into tailnet-only publishing with `/web-tailscale on`. The running server immediately configures Tailscale Serve to proxy its HTTPS MagicDNS address to the localhost-only backend, and future starts restore it automatically. `/web`, the footer globe, and `/web-tailscale status` then use the tailnet URL. Node-level publishing defaults to HTTPS port `8443` to avoid macOS port-443 conflicts.

The equivalent global Pi setting in `~/.pi/agent/settings.json` is:

```json
{
  "web": {
    "tailscale": {
      "enabled": true,
      "httpsPort": 8443
    }
  }
}
```

Use `/web-tailscale off` to remove Pi's active Serve route immediately and disable publishing on future starts. This integration uses **Tailscale Serve**, not Funnel, so it remains tailnet-only. Access is controlled by your Tailscale Service grant.

To publish as a named entry on the Tailscale **Services** page, use `/web-tailscale on pi-web` or set `serviceName: "pi-web"`. Named Services require this machine to be a tagged node, an admin-defined `svc:pi-web` resource, approval (or auto-approval), and an access grant. Pi reports Tailscale's actionable error until those requirements are met.

For frontend development, run `bun run webDev`. Production assets in `web/dist` are not checked in — `bun install` builds them via `postinstall`, and `bun run webServer` rebuilds them on every startup, so a manual `bun run webBuild` is only needed to preview the production bundle without starting the server.

## Prompt templates

- `/address-pr` gets the current pull request ready to merge by addressing review comments, conflicts, and CI failures.

## Install

From this checkout:

```sh
pi install ~/vessup/pi-kit
```

After pushing this repository to GitHub, install it on another machine with either SSH or HTTPS:

```sh
pi install git:git@github.com:Vessup/pi-kit.git
# or
pi install git:github.com/Vessup/pi-kit
```

Use `/reload` in a running Pi session after installing. Update a Git installation later with:

```sh
pi update --extensions
```

## Development

This repository uses [Bun](https://bun.sh/) for dependency management and scripts. Pi still loads the package normally from a local path or Git source; the web-session extension starts Bun only when a Pi session begins. Runtime dependencies are declared in `package.json`, and `bun.lock` is the checked-in source of truth. Pi may invoke `npm install` internally when reconciling a Git package, but that does not require a separate npm lockfile or change this repository's Bun workflow.

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run webBuild
pi -e ./extensions/session-footer.ts -e ./extensions/pr-footer.ts -e ./extensions/subagents.ts -e ./extensions/worktree.ts -e ./extensions/web-sessions.ts -e ./extensions/auto-router.ts
```
