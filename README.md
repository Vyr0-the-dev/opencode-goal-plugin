# opencode-goal-plugin

Persistent, evidence-checked goals for OpenCode — the `/goal` feature.

A prompt asks for one result and waits. A **goal** gives the agent one durable
objective and lets it keep working until that objective is verifiably true, or
until it is honestly blocked. It is the same idea as `/goal` in OpenAI Codex
(0.128.0+), Claude Code, and Hermes, built on OpenCode's own plugin API.

You drive it with `/goal`. OpenCode itself drives it with the `goal_create`,
`goal_status`, and `goal_update` tools. Neither of you can touch the other
session's goal, and a goal never widens the authority your permissions already
granted.

---

## Install

The plugin is loaded by a one-line file in your global plugins directory.
Run the installer:

```powershell
.\install.ps1
```

It writes `~/.config/opencode/plugins/goal.ts`, which re-exports the plugin from
this folder. To move this folder later, delete that file and run `install.ps1`
again. Uninstalling is deleting the same file.

`opencode reload` picks up the change; restarting is not required.

Prefer npm? The package name is `opencode-goal-plugin` and it works as a normal
package plugin too.

---

## Use it

```
/goal Reduce p95 checkout latency below 120 ms, verified by the checkout
      benchmark, while keeping the correctness suite green. Use only the
      checkout service and its tests. Between iterations, record what changed,
      what the benchmark showed, and the next best experiment. If the benchmark
      cannot run, stop and report the blocker.
```

That text is both the task and the finish line. From then on, whenever the
session goes idle with the goal still active and inside budget, the agent is
woken again to audit its evidence and take the next useful action.

### Commands

| Command | Effect |
| --- | --- |
| `/goal <objective>` | Start (or replace) the goal and begin working |
| `/goal` or `/goal status` | Show the goal, its contract, its budget, its ledger |
| `/goal pause` (`stop`) | Stop continuing; the objective is kept |
| `/goal resume` (`continue`) | Continue from the current state |
| `/goal clear` (`reset`) | Remove the goal from the session |
| `/goal history` | Show the progress ledger and lifecycle |
| `/goal edit <text>` | Replace the objective, keep the rest of the contract |
| `/goal budget <n>` | Change the automatic turn budget |
| `/goal draft <text>` | Have the model write a strong contract first |
| `/goal help` | Full command surface |

A lifecycle word is only a command when it is the **whole** input, so an
objective may start with any word:

```
/goal stop the flaky checkout test     <- sets a goal
/goal stop                             <- pauses the current one
```

Verbs that take an argument (`set`, `edit`, `draft`, `budget`) are read in the
leading position.

### Contract flags

Everything after the objective is optional, and quoting follows shell rules.

| Flag | Meaning |
| --- | --- |
| `--turns N` | Automatic turn budget (default 25) |
| `--minutes N` | Wall-clock ceiling in minutes (default 180) |
| `--verify "…"` | Verification surface: the evidence that proves the outcome |
| `--constraints "…"` | What must not regress |
| `--boundaries "…"` | Files, tools, and data in scope |
| `--iterate "…"` | How to choose the next action after each attempt |
| `--blocked "…"` | When to stop and report instead of continuing |
| `--no-start` | Install the goal without starting a turn |
| `--no-continue` | Install an active goal that will not run on its own |

### In the terminal

* A `GOAL 3/25` badge appears in the prompt footer.
* A progress row above the composer shows the title, a bar, and the budget.
* `ctrl+g` pauses or resumes; `ctrl+g` on a session with no goal shows its status.
* The command palette has *Goal: open dashboard / status / pause / resume / clear*.
* The dashboard panel (`p` pause, `r` resume, `R` refresh, `c` clear, `f` fullscreen)
  shows the contract, the blocker, and the ledger.

---

## How it behaves

**Thread-scoped, not global.** A goal belongs to the session that set it. It is
durable plugin storage, not project instructions and not global memory.

**Survives compaction.** The completion contract is injected into the system
prompt of every model call (`context`, `compaction`, and `generate`), so the
objective cannot be forgotten when history is summarized away.

**Continuation is event-driven and conservative.** It happens on `session.idle`
only, and only when all of these hold: the goal is `active`; nothing is queued in
the session inbox; the session's agent is not a skipped read-only agent; no
continuation is already in flight; the cooldown since the last one has passed;
and the budget has room.

**Completion is evidence-based.** The model can only mark a goal `complete`
through `goal_update`, and that call is refused without a summary. Marking
`blocked` is refused without a blocker. It cannot pause, resume, edit, or clear a
goal — those are yours, through `/goal`.

**The loop cannot spin.** A continuation turn that produced no tool call is not
evidence of progress, so the next automatic turn is suppressed and you are told
why. After `maxNoToolStreak` fruitless turns the goal is marked `blocked`.

**Interrupting pauses.** Pressing escape during a run pauses the objective, so a
runaway loop cannot be resumed by accident.

**The budget is honest.** Reaching it stops the loop for review and says plainly
that a budget limit is not the same as completing the objective. Resuming
renews the ceiling but keeps the turns already spent on the record.

**Zero cost for lifecycle commands.** `status`, `pause`, `history`, and `clear`
answer with a durable synthetic message that carries `resume: false`, so they are
recorded in the transcript without scheduling a model turn.

---

## Tools

| Tool | Purpose |
| --- | --- |
| `goal_create` | Start a goal for the current session. The model may do this when the user describes an objective instead of setting one. |
| `goal_status` | Read the goal, its contract, its budget, and its ledger. |
| `goal_update` | Record an iteration (`working`), declare `complete` with evidence, or declare `blocked` with a blocker. |

## RPC

The server plugin publishes an RPC surface, so any client or another plugin can
read and steer goals without going through the TUI:

```ts
import { OpenCode } from "@opencode/client"
import { GoalRpc } from "opencode-goal-plugin/rpc"

const api = OpenCode.make({ baseUrl: "http://localhost:4096" }).rpc(GoalRpc)

await api.get({ sessionID })
await api.list({})
await api.act({ sessionID, action: "pause" })
api.events.on("changed", (event) => console.log(event.data.sessionID, event.data.status))
```

`act` accepts `status`, `pause`, `resume`, `clear`, `budget`, and `continue-once`;
anything else is rejected with `unknown_action`.

---

## Configuration

Edit `goal.config.json` next to the plugin, or set `options` on the plugin entry
in `opencode.json(c)` (that wins over the file).

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; when false nothing is registered |
| `defaultMaxTurns` | `25` | Automatic turns a goal may use |
| `defaultMaxMinutes` | `180` | Wall-clock ceiling |
| `continuationDelayMs` | `750` | Grace period after a continuation, so you can interrupt |
| `pauseOnInterrupt` | `true` | Interrupting a run pauses the goal |
| `skipAgents` | `["plan"]` | Agents that may not drive a goal |
| `injectGoal` | `true` | Inject the contract into every model call |
| `maxNotes` | `40` | Ledger entries kept |
| `maxNoToolStreak` | `2` | Fruitless turns before the goal is blocked |
| `postLifecycleNotices` | `true` | Note pauses, budget stops, and blocks in the transcript |
| `commandName` | `"goal"` | Slash command name |

Every option is validated; a bad value falls back to its default rather than
failing the session.

---

## Design notes

**No runtime SDK import.** Every `@opencode/plugin` import in this package is
`import type`, which TypeScript erases. The plugin object is a plain
`{ id, setup }` and the RPC definition is a plain object typed against
`Rpc.PortableDefinition`. That is what makes the package loadable from any
directory with no installed dependencies, and it is the pattern the shipped
OpenCode plugins use.

**The dispatcher is a pure function.** `decideContinuation` takes observable
state and returns `continue`, `budget_exhausted`, or `stop` with a reason. No
I/O, no clock, no plugin context. Every rule — pending input, plan agents,
cooldown, concurrency, budget — is unit tested directly.

**Storage failures cannot reach a session.** Reads and writes are wrapped, writes
are serialized per session so a continuation tick cannot clobber a tool call, and
a goal that cannot be persisted still works in memory.

**Compatibility.** Only documented, stable plugin surfaces are used: `command`,
`tool`, `storage`, `session` hooks, the event stream, and plugin RPC. Unknown
event types are ignored, missing or malformed state is repaired rather than
thrown, and the lifecycle stops when the plugin unloads. Nothing outside the
plugin's own storage is ever mutated.

## Development

```sh
bun install
bun test          # 133 tests
bun run typecheck
```

Tests run against a fake port, so the whole policy — dispatch, suppression,
budget, interruption, persistence, isolation — is exercised without a server.

## License

MIT
