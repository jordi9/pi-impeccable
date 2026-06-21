# pi-impeccable

Run [Impeccable](https://impeccable.style/) skills from Pi without blocking the agent.

<p align="center">
  <img src="docs/images/screenshot.jpg" alt="Impeccable live mode running in Pi" width="720">
</p>

`pi-impeccable` is a Pi integration for the incredible [`impeccable`](https://github.com/pbakaus/impeccable) package. It installs or updates the Impeccable skill in your project, then runs Impeccable live mode through Pi in the background.

That means you can keep chatting with the agent while Impeccable watches the browser, queues design feedback, and asks Pi to respond. No long-running `live-poll.mjs` command holds the shell hostage.

## Why use this?

- **Non-blocking live mode** — `/impeccable live` starts the helper server and background poller, then immediately gives Pi back to you.
- **Agent-native feedback loop** — browser events and Impeccable work arrive to the agent.
- **Quiet status UI** — Pi shows `✦ impeccable live` while the background bridge is running.
- **Upstream skill, no vendoring** — the extension uses the official `impeccable` package to install/update `.agents/skills/impeccable` in your project.

## Install

```bash
pi install npm:pi-impeccable
```

Local testing:

```bash
pi -e ./pi-impeccable
```

## Use

Install or update the upstream Impeccable skill:

```text
/impeccable install              # installs latest upstream skill into .agents/skills/impeccable
/impeccable update               # updates that skill from upstream
```

Run Impeccable commands from Pi:

```text
/impeccable init
/impeccable audit src/pages/Home.tsx
```

Start the non-blocking live loop:

```text
/impeccable live
```

While live mode is running, Pi remains usable. Impeccable events are delivered in the background, and the agent can reply through `impeccable_live_reply` / `impeccable_live_complete` without exposing the polling loop as a foreground task.

Check or stop live mode:

```text
/impeccable live status
/impeccable live stop
/impeccable stop
```

You can also say `stop live` to stop it quietly.

## Release

Releases are tag-driven:

1. `jj` owns the working-copy commit and `main` bookmark.
2. `git` owns release tags.
3. GitHub Actions publishes to npm, generates release notes with `git-cliff`, and creates the GitHub Release.

First release:

```bash
pnpm release:check

git-cliff --unreleased --tag v0.1.0   # optional release-notes preview

jj describe -m "chore: prepare v0.1.0 release"
jj bookmark move main -r @
jj git push 

git tag v0.1.0 main
git push origin v0.1.0                # publishes to npm and creates the GitHub Release
```

Later releases use the same flow: bump `package.json`, update `CHANGELOG.md`, preview notes with `git-cliff --unreleased --tag vX.Y.Z`, push `main`, then create and push the matching Git tag.

## License

Apache-2.0 as Impeccable.
