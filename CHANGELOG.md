# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
