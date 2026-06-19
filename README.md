# pi-impeccable

Thin Pi extension wrapper for [Impeccable](https://github.com/pbakaus/impeccable).

This package does **not** vendor the Impeccable skill. It uses the upstream `impeccable` package to install/update `.agents/skills/impeccable` in your project, then wraps live mode so Pi is not blocked by `live-poll.mjs`.

## Install

```bash
pi install npm:pi-impeccable
```

Local testing:

```bash
pi -e ./pi-impeccable
```

## Use

```text
/impeccable install              # installs latest upstream skill into .agents/skills/impeccable
/impeccable update               # updates that skill from upstream
/impeccable init
/impeccable audit src/pages/Home.tsx
/impeccable live --delivery=steer
/impeccable live status
/impeccable live stop
/impeccable stop
```

`/impeccable live` starts Impeccable's helper server and a background poller, then gives Pi back to you. Browser events and Impeccable command work are injected as hidden extension messages, not visible user prompts. The agent replies with `impeccable_live_reply` / `impeccable_live_complete`, so the shell is not blocked by a long poll.

Live mode shows a quiet status indicator: `✦ impeccable live`. Say `stop live` or run `/impeccable stop` to stop it.
