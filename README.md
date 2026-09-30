# opencode-goal-plugin

[![CI](https://github.com/Vyr0-the-dev/opencode-goal-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/Vyr0-the-dev/opencode-goal-plugin/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Vyr0-the-dev/opencode-goal-plugin/actions/workflows/codeql.yml/badge.svg)](https://github.com/Vyr0-the-dev/opencode-goal-plugin/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Persistent, evidence-checked goals for OpenCode — the `/goal` feature.

A prompt asks for one result and waits. A **goal** gives the agent one durable
objective and lets it keep working until that objective is verifiably true, or
until it is honestly blocked. It is the same idea as `/goal` in OpenAI Codex
(0.128.0+), Claude Code, and Hermes, built on OpenCode v2's native plugin API.

You drive it with `/goal`. OpenCode itself drives it with the `goal_create`,
`goal_status`, and `goal_update` tools. Neither can touch another session's
goal, and a goal never widens the authority your permissions already granted.

---

## Installation

### macOS, Linux, WSL, and Git Bash (POSIX)
```sh
sh install.sh
```

### Windows PowerShell
```powershell
.\install.ps1
```

### Windows Command Prompt (`cmd.exe`)
```cmd
install.cmd
```

Each installer script deploys the package into the global OpenCode plugins directory (`~/.config/opencode/plugins/opencode-goal-plugin` or `$XDG_CONFIG_HOME/opencode/plugins/...`), copies frontend dependencies (`solid-js`, `@opentui/*`) into the OpenCode configuration's `node_modules`, and cleans up any legacy single-file loader artifacts.

Re-running refreshes the copy; deleting the directory uninstalls the plugin. `opencode reload` reloads the server half; restarting the TUI reloads the terminal half.

### Why Install as a Directory?

OpenCode resolves a plugin package's `exports` targets **relative to the package root**. Because of this architecture:
* A single loader file (`goal.ts`) can only load the server half; without an adjacent package map, the host cannot resolve `./tui` and the terminal interface remains silently disabled.
* Packages whose entrypoints reside solely under `./src` or `./dist` without root exports are skipped by the host.

Therefore, the package root maintains `index.js`, `tui.tsx`, and `rpc.ts` re-export shims.

To verify that the plugin is active:
```sh
opencode api get /api/plugin
```
Verify that the `opencode.goal` entry reports `{"server": true, "tui": true, "rpc": true}`.

---

## Supported Environments & Platforms

Because status and control logic operate server-side, behavior remains consistent across all clients supported by OpenCode:

| Environment / Interface | `/goal` Command | `goal_*` Tools | Status Tracking | Terminal UI |
| --- | --- | --- | --- | --- |
| **OpenCode TUI** | Yes | Yes | RPC + Transcript | Status badge, progress bar, dashboard panel (`<leader>p`), keybind overlay |
| **Web UI** | Yes | Yes | RPC + Transcript | — |
| **Desktop App** | Yes | Yes | RPC + Transcript | — |
| **IDE Extensions (VS Code, Cursor)** | Yes | Yes | RPC + Transcript | — |
| **ACP Clients (Zed, etc.)** | Yes | Yes | RPC + Transcript | — |
| **`opencode run` (Headless/CI)** | Yes | Yes | RPC + Transcript | Non-interactive & TTY fallback |
| **`opencode mini`** | Yes | Yes | RPC + Transcript | — |
| **Third-Party API Clients** | Yes | Yes | RPC + Transcript | — |

### Platform & Shell Compatibility
* **Operating Systems:** macOS (Intel/Apple Silicon), Linux (x64/arm64), Windows 10/11 (x64/arm64)
* **Shells:** Bash, Zsh, Fish, PowerShell 5.1/7+, Windows Command Prompt (`cmd.exe`)
* **Terminal Capabilities:**
  - Modern terminals (Windows Terminal, iTerm2, WezTerm, Alacritty, VS Code Terminal): Full Unicode block characters (`█` / `─`).
  - Restricted / Legacy terminals (`TERM=dumb`, legacy console): Automatic ASCII fallback (`#` / `-`).
  - Narrow terminals (< 70 columns): Compact composer header and dynamically clamped progress bars.
  - CI / Pipe / Non-interactive: Full compliance with the `NO_COLOR` standard and controlled logger routing (preventing TUI screen corruption).

---

## Usage Guide

### Basic Command
```
/goal Reduce p95 checkout latency below 120 ms, verified by the checkout
      benchmark, while keeping the correctness suite green. Use only the
      checkout service and its tests. Between iterations, record what changed,
      what the benchmark showed, and the next best experiment. If the benchmark
      cannot run, stop and report the blocker.
```

This text defines both the objective and the completion condition (finish line). When the session goes idle and a goal is active within budget, the agent automatically continues, audits the evidence, and performs the next action.

### Command Reference

| Command | Description |
| --- | --- |
| `/goal <objective>` | Activates (or replaces) the goal and begins work |
| `/goal` or `/goal status` | Shows current goal, contract, remaining budget, and ledger |
| `/goal pause` (or `stop`) | Pauses the loop; preserves objective and progress |
| `/goal resume` (or `continue`) | Resumes a paused goal |
| `/goal clear` (or `reset`) | Clears the goal from the session |
| `/goal history` | Lists progress ledger and state transitions |
| `/goal edit <new objective>` | Updates the objective text while preserving contract flags |
| `/goal budget <number>` | Adjusts the automatic turn budget |
| `/goal draft <subject>` | Requests the model to draft a strong goal contract |
| `/goal help` | Displays help and usage details |

A lifecycle keyword (`pause`, `stop`, `clear`, etc.) is treated as a command only when it constitutes the **entire** input line. This allows objectives to naturally start with those words:
```
/goal stop the flaky checkout test     <- Starts a new goal
/goal stop                             <- Pauses the current goal
```

### Contract Flags

| Flag | Meaning |
| --- | --- |
| `--turns N` | Automatic turn budget (default: 25) |
| `--minutes N` | Wall-clock time ceiling in minutes (default: 180) |
| `--verify "…"` | Verification surface: test, benchmark, or command proving completion |
| `--constraints "…"` | Invariants that must not regress |
| `--boundaries "…"` | Scoped files, services, or data limits |
| `--iterate "…"` | Rule for choosing next action after each attempt |
| `--blocked "…"` | Condition under which to stop and report a blocker |
| `--no-start` | Installs the goal into session state without starting a turn immediately |
| `--no-continue` | Installs active goal but prevents automatic continuation |

---

## Terminal & TUI Experience

1. **Footer Badge:** Live status displayed on the bottom-right footer of the prompt: `GOAL 3/25`.
2. **Composer Header:**
   - Wide terminal: `GOAL [██████──────] 3/25 turns · 12m/3h · Goal Title · <leader>p pause`
   - Narrow terminal (< 70 cols): `GOAL [███---] 3/25t · Goal Title`
   - ASCII terminal: `GOAL [######------]`
3. **Dashboard Panel (`<leader>p` or Command Palette -> *Goal: open dashboard*):**
   - `p`: Pause
   - `r`: Resume
   - `R`: Refresh
   - `c`: Clear
   - `f`: Toggle fullscreen
4. **Keybind:** Default `<leader>p` (`ctrl+x` followed by `p`). Customizable in `cli.json`:
   ```json
   {
     "keybinds": {
       "opencode.goal.toggle": "<leader>o"
     }
   }
   ```

---

## Model-Facing Tools

OpenCode drives long-running goals through canonical tools:

* `goal_create`: Used by the model when the user describes an objective in chat.
* `goal_status`: Reads active goal, remaining budget, and recent ledger entries (read-only).
* `goal_update`: Records progress (`working`), completes with verifiable evidence (`complete`), or reports a blocker (`blocked`). Completion without evidence or blocking without reason is rejected.

---

## RPC Interface

The plugin exposes a typed RPC surface for external clients:

```ts
import { OpenCode } from "@opencode/client"
import { GoalRpc } from "opencode-goal-plugin/rpc"

const client = OpenCode.make({ baseUrl: "http://localhost:4096" })
const api = client.rpc(GoalRpc)

// Read goal state
const status = await api.get({ sessionID: "ses_123" })

// Pause or resume goal
await api.act({ sessionID: "ses_123", action: "pause", origin: "external" })

// Subscribe to events
api.events.on("changed", (event) => {
  console.log(`Session ${event.data.sessionID} status: ${event.data.status}`)
})
```

---

## Configuration (`goal.config.json`)

Options are loaded from `goal.config.json` or `goal.config.local.json` for local overrides. Options declared under `opencode.json(c)` plugins take highest precedence.

```json
{
  "enabled": true,
  "commandName": "goal",
  "defaultMaxTurns": 25,
  "defaultMaxMinutes": 180,
  "continuationDelayMs": 750,
  "pauseOnInterrupt": true,
  "skipAgents": ["plan"],
  "injectGoal": true,
  "maxNotes": 40,
  "maxNoToolStreak": 2,
  "postLifecycleNotices": true,
  "mirrorToSessionMetadata": true,
  "answerLifecycleImmediately": true
}
```

---

## Development, Testing & Quality Checks

The codebase uses Bun and TypeScript:

```sh
# Install dependencies
bun install

# Typecheck (TypeScript strict mode)
bun run typecheck

# Lint check
bun run lint

# Unit, integration, and terminal tests (258+ tests)
bun test

# Distribution & smoke tests
bun run smoke

# Build server bundle
bun run build

# Validate all prepublish steps
bun run prepublishOnly
```

### CI/CD Verification
GitHub Actions (`.github/workflows/ci.yml`) runs across Ubuntu, macOS, and Windows runners:
- Dependency installation
- Typecheck & Lint
- Full test matrix
- Build compilation
- Smoke tests
- `npm pack --dry-run` package verification

---

## Known Limitations & Troubleshooting

1. **Session Metadata Mirroring (OpenCode 2.0.16):**
   - In OpenCode 2.0.16, `session.update({ metadata })` calls may be silently ignored by the host. The plugin verifies writes and safely disables this channel if unsupported. Transcripts and RPC are unaffected. You can disable this check via `"mirrorToSessionMetadata": false`.
2. **Character Encoding on Legacy Consoles:**
   - On legacy Windows CMD consoles lacking Unicode support, the plugin automatically switches to ASCII mode (`#` and `-`). For optimal rendering, Windows Terminal or `LANG=en_US.UTF-8` is recommended.
3. **Session ID Safety:**
   - All session IDs undergo strict sanitization against path traversal (`..`, `/`, `\`) and control characters.
4. **Queueing When Running Active Shell Commands:**
   - In OpenCode v2, when an active shell or tool process is running, submitting a new prompt places it into the session queue (`1 queued`). The goal prompt begins executing immediately once the prior command concludes or is interrupted.

---

## Additional Documentation

* **Provider & Model Compatibility:** [`docs/providers.md`](docs/providers.md) (Claude, GPT, DeepSeek, Qwen, and strict-template local backends)
* **Compatibility Policy:** [`docs/compatibility.md`](docs/compatibility.md) (Supported runtimes, package caching, and OS matrix)
* **Security Policy:** [`SECURITY.md`](SECURITY.md) (Security architecture, threat model, and vulnerability reporting)

---

## License

MIT
