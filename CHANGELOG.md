# Changelog

## 0.1.0 - 2026-06-19

Initial public release.

- Add `/impeccable` Pi command backed by upstream `impeccable`.
- Install/update upstream Impeccable into `.agents/skills/impeccable` without vendoring skill files.
- Run `/impeccable live` polling in the background so Pi stays usable.
- Inject Impeccable live events and command work as hidden extension messages, not visible user prompts.
- Add `impeccable_live_reply` and `impeccable_live_complete` tools for live event responses.
- Add quiet live status UI via Pi extension status: `✦ impeccable live`.
- Add transient status feedback for queued Impeccable commands without replacing live status.
- Stop argument autocomplete after the first word so `/impeccable craft foo` cannot collapse back to `/impeccable craft`.
- Handle `stop live` and `/impeccable stop` quietly.
- Summarize `/impeccable status` instead of dumping raw JSON.
