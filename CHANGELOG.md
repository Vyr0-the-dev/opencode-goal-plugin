# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-09-30

Every entry below was found by running the plugin against a live OpenCode
session. In each case the code and the message the user saw had drifted apart,
and the unit tests were green throughout.

### Fixed

- A cached goal read was never revalidated, so a second writer was invisible. The
  store preferred its cache over storage, which left a goal that had been cleared
  or completed reading as `active` to the dispatcher, and a completed goal could
  be sent a continuation turn.
- `/goal clear` reported "The objective and its ledger are removed from this
  session." They are not removed: `clear` writes status `cleared` and keeps the
  goal, its ledger, and its transitions. The message now says the goal is no
  longer active and that its record is kept.
- `goal_update` against a retired goal answered "25 automatic turns left." The
  goal had status `cleared` and could never spend a turn. The note is still
  recorded, because the ledger is the audit trail; the reply now names the
  status instead of promising budget.
- `/goal clear` resumed an idle session to announce the teardown, spending a
  model turn to tell the user about something they had just done. The
  confirmation is still written to the transcript with `delivery: "queue"`; only
  the session resume is dropped.
- The progress bar's empty track used `░`, which is a dither pattern rather than
  a shade, so terminal fonts rendered it as a stipple. It now uses `─`.
- The TUI's own pause key was recorded as "paused from an external client",
  because the TUI reaches the engine through the same RPC as any other client.
- `install.sh` and `install.ps1` copied whatever `dist/` happened to be on disk.
  The server entrypoint is the compiled `dist/index.js`, so committed source
  fixes were silently invisible until someone remembered to build. Both scripts
  now build first and fail if the compiled entrypoint is still missing.
- A successful `bun run build` could abort `install.ps1` before it copied
  anything: the build banner goes to stderr, PowerShell surfaces a native
  command's stderr as `NativeCommandError`, and the script ran with
  `$ErrorActionPreference = "Stop"`. Success is now judged by exit code.
- `bar(NaN)` returned an empty string instead of an empty bar, because a
  non-finite percent makes both `repeat` counts `NaN`. The new test found this;
  reading the code did not.

### Added

- `origin` on the RPC `goal.act` input, so a caller can identify itself as the
  local TUI. It defaults to `external`, so clients that do not set it behave
  exactly as before.
- `src/bar.ts`, so the bar is unit-testable at all. `src/tui.tsx` cannot be
  imported by the suite, because the tsconfig preserves JSX and the tests run
  unbundled - so a bar defined there could only ever be checked by looking at a
  screenshot, which is how the wrong glyph survived.

### Known gap

The automatic continuation has not been observed dispatching a turn in a live
session since the stale-read fix landed. The loop's guards are covered by unit
tests, but the end-to-end path - a session going idle with an active goal inside
budget - has not been watched end to end since. It is the one property in this
README not backed by a live observation.

Tests: 196 at 1.0.0, 215 here.

## [1.0.0] - 2026-09-30

First release.

### Added

- `/goal` command: start, inspect, pause, resume, clear, edit, budget, history,
  draft, help. A lifecycle word is only a command when it is the whole input, so
  an objective may begin with any word.
- Completion contract with six parts — outcome, verification surface,
  constraints, boundaries, iteration policy, blocked stop condition — injected
  into every model call so the objective survives compaction.
- Automatic continuation on `session.idle`, guarded by pending inbox work, the
  session's agent kind, an in-flight lock, a cooldown, and a turn and wall-clock
  budget.
- `goal_create`, `goal_status`, and `goal_update` tools for the model. The model
  may declare a goal complete or blocked, never pause, resume, or clear it.
- Anti-spin: a continuation turn that made no tool call is not evidence of
  progress, so the next automatic turn is suppressed; repeated fruitless turns
  block the goal.
- Lifecycle answers written with a turn scheduled, because an undelivered
  message is indistinguishable from a command that did nothing.
- Plugin RPC (`goal.get`, `goal.list`, `goal.act`, `changed` event) so any client
  can read and steer goals.
- A session metadata mirror, verified on every write and self-disabling if the
  host does not apply it.
- TUI half: progress row, status badge, command palette entries, dashboard
  panel, and a `<leader>p` toggle. Requires a package install to load.
- `install.sh` and `install.ps1`, both idempotent, for a loader-file install.
- Configuration via `goal.config.json`, overridable per machine by
  `goal.config.local.json`.
- 196 tests covering the dispatcher, the command layer, the parser, storage,
  option precedence, and the TUI routing.
