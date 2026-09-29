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

**macOS, Linux, WSL, or Git Bash**

```sh
sh install.sh
```

**Windows PowerShell**

```powershell
.\install.ps1
```

Either script writes a one-line loader to `~/.config/opencode/plugins/goal.ts`
(or `$XDG_CONFIG_HOME/opencode/plugins/goal.ts`) that re-exports the plugin from
this folder. Both are idempotent: re-running points an existing loader at the new
location instead of failing, and refuse to clobber a loader that points somewhere
else unless you pass `-f` / `--force`. Uninstalling is deleting that one file.

**As a managed package** — no script, and OpenCode keeps it updated:

```sh
npx opencode plugin add opencode-goal-plugin
```

`opencode reload` picks up any of these; restarting is not required.

The plugin code itself has no platform-specific paths, no OS-gated dependencies,
and no runtime dependencies at all, so one build serves every platform.

## Where it works

The same install works everywhere OpenCode does, because everything that carries
the goal lives in the server, not in a client.

| Surface | `/goal` command | `goal_*` tools | Goal state | Extra UI |
| --- | --- | --- | --- | --- |
| TUI | yes | yes | RPC + transcript | badge, progress row, `ctrl+g`, dashboard |
| Web app | yes | yes | RPC + transcript | — |
| Desktop app | yes | yes | RPC + transcript | — |
| IDE extensions | yes | yes | RPC + transcript | — |
| ACP clients (Zed, …) | yes | yes | RPC + transcript | — |
| `opencode run` | yes | yes | RPC + transcript | — |
| `opencode mini` | yes | yes | RPC + transcript | — |
| Phone / third-party clients | yes | yes | RPC + transcript | — |

*Transcript* means lifecycle and status answers are written as durable synthetic
messages, so any client that shows a conversation shows the goal. *RPC* means any
client built on the OpenCode API can call `goal.get`, `goal.list`, and `goal.act`
and subscribe to a `changed` event. Read the [RPC section](#rpc) for the client
code.

The TUI half is additive: it reads the same RPC surface, so it can never disagree
with what the engine decided.

### Known host limitation (OpenCode 2.0.16)

The plugin also mirrors a compact summary onto each session's own `metadata`, so a
client that only renders a session list could show the goal. On OpenCode 2.0.16
the HTTP `PATCH /api/session/{id}` applies that patch but the **plugin API's**
`session.update` accepts and silently discards it — `update({ title })` persists,
`update({ metadata })` does not.

The mirror verifies every write by reading it back. When the host drops it, the
plugin logs one honest warning and stops trying, rather than pretending a goal is
visible where it is not:

```
[opencode-goal] goal: this OpenCode version accepts a session metadata patch but
does not apply it (observed on 2.0.16), so the goal cannot be shown in clients
that only read session metadata. The transcript and the goal RPC are unaffected.
```

Nothing else depends on that channel. Set `"mirrorToSessionMetadata": false` to
skip the attempt and silence the warning. If a future OpenCode wires the write
through, the channel starts working with no change here.


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

`/goal` is handled by the server command, so it behaves the same everywhere. A
lifecycle answer is written to the transcript and the turn that carries it is
scheduled, which is why the agent answers in the chat rather than in a dialog.

* A `GOAL 3/25` badge appears in the prompt footer.
* A progress row above the composer shows the title, a bar, and the budget.
* The command palette has *Goal: open dashboard / status / pause / resume / clear*
  and *Goal: pause or resume*, and those answer in a dialog from the same RPC,
  without a model turn.
* The dashboard panel (`p` pause, `r` resume, `R` refresh, `c` clear, `f` fullscreen)
  shows the contract, the blocker, and the ledger.

**Keybind: `ctrl+x` then `p`.** That is `<leader>p`. The choice is deliberate: an
earlier version bound `ctrl+g`, which turned out to be OpenCode's own
`session.first` — the host won, the plugin lost, and pressing it scrolled the
transcript instead of opening a goal dialog. Almost every `ctrl+` and `<leader>+`
key in the host's table is already assigned, so a binding has to be picked against
that table rather than guessed. The palette entries work regardless. To change the
key, assign the command ID in `cli.json`:

```json title="~/.config/opencode/cli.json"
{
  "keybinds": {
    "opencode.goal.toggle": "<leader>o"
  }
}
```

`<leader>` is `ctrl+x` by default.

**Why the answer costs a turn.** A plugin's only way to write into a transcript is
`session.synthetic`, and on OpenCode 2.0.16 that message is delivered *only* when
it also schedules a turn. An answer written with `resume: false` is durable and
free, but it sits in the session inbox until some later turn drains it — so
`/goal status` would look like it did nothing at all. An answer that is free but
invisible is worse than one that costs a call, so the default is to schedule it.
Set `answerLifecycleImmediately: false` to go back to the silent-but-free
behaviour, or use `ctrl+g` and the palette entries for the free path.

**A note on `/goal` in the composer.** An earlier version registered a TUI slash
command to intercept `/goal` and answer it in a dialog without a turn. It was
measured and it does not intercept: the composer still submits the line to the
server, so the command was listed twice and implied a behaviour that never
happened. It has been removed rather than left in place. The dialog path still
exists, reachable from the palette and `ctrl+g`.

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
in `opencode.json(c)` (that wins over the file). For a machine-specific change,
put it in `goal.config.local.json` beside the plugin instead: it overrides
`goal.config.json`, is gitignored, and never ends up in a commit.

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
| `mirrorToSessionMetadata` | `true` | Mirror a summary onto session metadata; verified, and self-disabling if the host ignores it |
| `answerLifecycleImmediately` | `true` | Schedule the turn that carries a lifecycle answer, so it is actually delivered. Set `false` to write it for free but leave it undelivered until the next turn |
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

**Nothing is written that was not read first.** The session metadata mirror merges
into the existing map and never removes a key it does not own, and it verifies its
own write so a host that drops it is reported rather than assumed to have worked.

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
plugin's own storage and its own metadata key is ever mutated.

## Development

```sh
bun install
bun test          # 152 tests
bun run typecheck
```

Tests run against a fake port, so the whole policy — dispatch, suppression,
budget, interruption, persistence, isolation — is exercised without a server.

## License

MIT
