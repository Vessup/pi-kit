# @vessup/pi

Reusable extensions for the [Pi coding agent](https://github.com/earendil-works/pi).

## PR footer

`extensions/pr-footer.ts` keeps Pi's normal footer information and adds the current GitHub pull request as a right-aligned, clickable `PR #123` link on the directory/branch line above the model information. A colored dot shows the aggregate check status:

- Green: checks passed
- Yellow: checks are pending or in progress
- Red: at least one check failed or was cancelled

It uses the GitHub CLI to resolve the pull request and check status for the checked-out branch, refreshing every 30 seconds. If `gh` is unavailable, unauthenticated, or the branch has no pull request, the link is hidden. Run `/pr-refresh` to refresh immediately.

### Requirements

- Pi
- GitHub CLI (`gh`), authenticated with `gh auth login`
- A terminal that supports OSC 8 hyperlinks for clickable links

## Install

From this checkout:

```sh
pi install ~/vessup/pi
```

After pushing this repository to GitHub, install it on another machine with either SSH or HTTPS:

```sh
pi install git:git@github.com:Vessup/pi.git
# or
pi install git:github.com/Vessup/pi
```

Use `/reload` in a running Pi session after installing. Update a Git installation later with:

```sh
pi update --extensions
```

## Development

```sh
npm install
npm run check
pi -e ./extensions/pr-footer.ts
```
