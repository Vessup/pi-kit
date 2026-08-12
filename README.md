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

```sh
npm install
npm run check
npm test
pi -e ./extensions/session-footer.ts -e ./extensions/pr-footer.ts -e ./extensions/subagents.ts
```
