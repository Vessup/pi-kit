# @vessup/pi-kit

Reusable extensions for the [Pi coding agent](https://github.com/earendil-works/pi).

## PR footer

`extensions/pr-footer.ts` contributes the current GitHub pull request to the shared footer as a right-aligned, clickable ` #123` link on the directory/branch line above the model information. A colored circle beside it shows the aggregate check status:

- Green: checks passed
- Yellow: checks are pending or in progress
- Red: at least one check failed or was cancelled

It uses the GitHub CLI to resolve the pull request and check status for the checked-out branch, refreshing every 30 seconds. If `gh` is unavailable, unauthenticated, or the branch has no pull request, the link is hidden. Run `/pr-refresh` to refresh immediately.

### Requirements

- Pi
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

For frontend development, run `bun run web:dev`. To rebuild the checked-in production assets, run `bun run web:build`.

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
bun run web:build
pi -e ./extensions/session-footer.ts -e ./extensions/pr-footer.ts -e ./extensions/subagents.ts -e ./extensions/web-sessions.ts
```
