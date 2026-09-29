/**
 * The TUI half of opencode-goal-plugin.
 *
 * `/goal` itself is registered on the server so it works in every client, not
 * only the TUI. This file adds what only a terminal can offer: a live status
 * badge, a goal progress row above the composer, and a dashboard panel. All of
 * it reads state through the plugin's RPC surface, so the UI can never disagree
 * with what the engine actually decided.
 */

/** @jsxImportSource @opentui/solid */

import type { Definition as TuiPluginDefinition } from "@opencode/plugin/tui/plugin"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import type { Store } from "solid-js/store"
import { Show, For } from "solid-js"
import { GoalRpc } from "./rpc.ts"
import { normalizeOptions } from "./options.ts"
import { planGoalUiAction } from "./ui-action.ts"
import { HELP_TEXT } from "./parse.ts"

export const TUI_PANEL = "goal.dashboard"

interface GoalView {
  id: string
  sessionID: string
  title: string
  objective: string
  verification: string
  constraints: string
  boundaries: string
  iteration: string
  blockedStop: string
  status: string
  maxTurns: number
  usedTurns: number
  remainingTurns: number
  maxMs: number
  elapsedMs: number
  progressPercent: number
  notes: Array<{ at: number; status: string; note?: string; evidence?: string; next?: string; blocker?: string }>
  summary?: string
  evidence?: string
  blocker?: string
}

interface GoalState {
  bySession: Record<string, GoalView | undefined>
  error?: string
}

const STATUS_TONE: Record<string, "text.base" | "text.success" | "text.warning" | "text.error" | "text.dim"> = {
  active: "text.success",
  paused: "text.warning",
  complete: "text.success",
  blocked: "text.error",
  budget: "text.warning",
  cleared: "text.dim",
}

const STATUS_BADGE: Record<string, string> = {
  active: "GOAL",
  paused: "GOAL PAUSED",
  complete: "GOAL DONE",
  blocked: "GOAL BLOCKED",
  budget: "GOAL BUDGET",
  cleared: "GOAL",
}

function minutes(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000))
  if (total < 60) return `${total}m`
  return `${Math.floor(total / 60)}h${total % 60 ? ` ${total % 60}m` : ""}`
}

function bar(percent: number, width = 12): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`
}

export default {
  id: "opencode.goal.tui",
  setup(context: Context) {
    const options = normalizeOptions(context.options)
    if (!options.enabled) return

    const api = context.client.rpc(GoalRpc)
    const [state, setState] = context.storage.memory<GoalState>("goal/state", { initial: { bySession: {} } })

    const put = (sessionID: string, goal: GoalView | undefined) => {
      setState((draft) => {
        if (goal) draft.bySession[sessionID] = goal
        else delete draft.bySession[sessionID]
      })
    }

    // JSON Schema in the RPC definition gives us `unknown` here, so the view is
    // narrowed at this one boundary instead of at every read site.
    const asGoal = (value: unknown): GoalView | undefined => (value && typeof value === "object" ? (value as GoalView) : undefined)

    const refresh = async (sessionID: string) => {
      try {
        const result = (await api.get({ sessionID })) as { goal?: unknown }
        put(sessionID, asGoal(result.goal) ?? undefined)
        setState((draft) => {
          draft.error = undefined
        })
      } catch (error) {
        setState((draft) => {
          draft.error = error instanceof Error ? error.message : String(error)
        })
      }
    }

    const refreshAll = async () => {
      try {
        const result = (await api.list({})) as { goals?: unknown }
        const goals = Array.isArray(result.goals) ? result.goals : []
        const next: Record<string, GoalView> = {}
        for (const entry of goals) {
          const goal = asGoal(entry)
          if (goal) next[goal.sessionID] = goal
        }
        setState((draft) => {
          draft.bySession = next
          draft.error = undefined
        })
      } catch (error) {
        setState((draft) => {
          draft.error = error instanceof Error ? error.message : String(error)
        })
      }
    }

    void refreshAll()

    const stopChanged = api.events.on("changed", (event) => {
      const sessionID = (event.data as { sessionID?: string }).sessionID
      if (sessionID) void refresh(sessionID)
    })
    const stopViewed = context.data.on("session.viewed", () => void refreshAll())
    const stopDeleted = context.data.on("session.deleted", (event) => {
      const sessionID = (event.data as { info?: { id?: string }; sessionID?: string })?.info?.id
        ?? (event.data as { sessionID?: string })?.sessionID
      if (sessionID) put(sessionID, undefined)
    })

    const goalOf = (sessionID: string | undefined): GoalView | undefined => {
      if (!sessionID) return undefined
      const goal = state.bySession[sessionID]
      return goal && goal.status !== "cleared" ? goal : undefined
    }

    const act = async (
      sessionID: string,
      action: "pause" | "resume" | "clear" | "status" | "budget" | "continue-once",
      turns?: number,
    ) => {
      try {
        const result = (await api.act({ sessionID, action, ...(turns === undefined ? {} : { turns }) })) as { goal?: unknown }
        put(sessionID, asGoal(result.goal) ?? undefined)
        if (action === "clear") {
          context.ui.toast.show({ title: "Goal", message: "Cleared.", variant: "info" })
        } else if (action === "pause") {
          context.ui.toast.show({ title: "Goal", message: "Paused. The objective is kept.", variant: "info" })
        } else if (action === "resume") {
          context.ui.toast.show({ title: "Goal", message: "Resumed. The agent will keep going.", variant: "success" })
        } else if (action === "budget") {
          context.ui.toast.show({ title: "Goal", message: `Turn budget set to ${turns}.`, variant: "success" })
        }
      } catch (error) {
        context.ui.toast.show({
          title: "Goal",
          message: error instanceof Error ? error.message : String(error),
          variant: "error",
        })
      }
    }

    const showStatus = async (sessionID: string | undefined) => {
      if (!sessionID) {
        context.ui.toast.show({ title: "Goal", message: "Open a session first.", variant: "warning" })
        return
      }
      await refresh(sessionID)
      const goal = goalOf(sessionID)
      context.ui.toast.show({
        title: goal ? goal.title : "Goal",
        message: goal
          ? `${goal.status} · ${goal.usedTurns}/${goal.maxTurns} turns · ${minutes(goal.elapsedMs)}/${minutes(goal.maxMs)}`
          : "No goal is active in this session. Use /goal <outcome> to start one.",
        variant: goal ? "info" : "warning",
        duration: 6000,
      })
    }

    /**
     * Answers a goal question from the palette, a keybind, or the panel — the
     * surfaces that are verified to reach the plugin.
     *
     * `/goal` itself is *not* intercepted here. Registering a slash command with
     * `arguments: true` was tried and measured: the composer still submitted the
     * line to the server, so the command was listed twice and implied an
     * interception that never happened. The server command owns `/goal`, and this
     * path exists so the free, instant answer is still one keystroke away.
     */
    const runGoalSlash = async (raw?: string) => {
      const route = context.ui.router.current()
      const sessionID = route.type === "session" ? route.sessionID : undefined
      const plan = planGoalUiAction({ text: raw ?? "", hasSession: Boolean(sessionID) })

      if (plan.kind === "refuse") {
        context.ui.toast.show({
          title: "Goal",
          message: "Open a session first, then run /goal there.",
          variant: "warning",
        })
        return
      }

      if (plan.kind === "answer") {
        if (plan.verb === "help") {
          await context.ui.dialog.alert({ title: "Goal", message: HELP_TEXT })
          return
        }
        await refresh(sessionID!)
        const goal = goalOf(sessionID)
        if (plan.verb === "history") {
          const lines = goal?.notes?.length
            ? goal.notes.map((n) => `· ${n.status}${n.note ? `: ${n.note}` : ""}`).join("\n")
            : "No progress recorded yet."
          await context.ui.dialog.alert({
            title: goal ? `Ledger — ${goal.title}` : "Ledger",
            message: lines,
          })
          return
        }
        const detail = goal
          ? [
              goal.objective,
              "",
              `Status:     ${goal.status}`,
              `Turns:      ${goal.usedTurns}/${goal.maxTurns} used, ${goal.remainingTurns} left`,
              `Wall clock: ${minutes(goal.elapsedMs)} of ${minutes(goal.maxMs)}`,
              goal.verification ? `Verified by: ${goal.verification}` : "",
              goal.constraints ? `Constraints:  ${goal.constraints}` : "",
              goal.blocker ? `Blocker:      ${goal.blocker}` : "",
              goal.evidence ? `Evidence:     ${goal.evidence}` : "",
            ]
              .filter((line) => line !== "")
              .join("\n")
          : "No goal is active in this session.\n\nUse /goal <outcome> to start one, for example:\n\n  /goal Reduce p95 latency below 120 ms, verified by the benchmark,\n        while the correctness suite stays green."
        await context.ui.dialog.alert({ title: goal ? goal.title : "Goal", message: detail })
        return
      }

      if (plan.kind === "act") {
        await act(sessionID!, plan.action, plan.turns)
        await refresh(sessionID!)
        return
      }

      // A change to the work itself: hand it to the server command, which owns
      // installing the goal and submitting the turn that starts it.
      try {
        await context.client.session.command({ sessionID: sessionID!, name: "goal", text: plan.text })
        await refresh(sessionID!)
      } catch (error) {
        context.ui.toast.show({
          title: "Goal",
          message: error instanceof Error ? error.message : String(error),
          variant: "error",
        })
      }
    }

    const goalCommands = () => [
      {
        id: "opencode.goal.dashboard",
        title: "Goal: open dashboard",
        group: "Goal",
        description: "Show the active goal, its budget, and its ledger",
        palette: true as const,
        bind: false as const,
        run: () => void runGoalSlash("status"),
      },
      {
        id: "opencode.goal.panel",
        title: "Goal: open dashboard",
        group: "Goal",
        description: "Show the active goal, its budget, and its ledger",
        palette: true as const,
        bind: false as const,
        run: () => {
          const route = context.ui.router.current()
          if (route.type !== "session") {
            context.ui.toast.show({ title: "Goal", message: "Open a session first.", variant: "warning" })
            return
          }
          if (!context.ui.panel.open(TUI_PANEL)) {
            context.ui.toast.show({ title: "Goal", message: "No session panel is available here.", variant: "warning" })
          }
        },
      },
      {
        id: "opencode.goal.status",
        title: "Goal: status",
        group: "Goal",
        description: "Report the active goal and its remaining budget",
        palette: true as const,
        bind: false as const,
        run: () => {
          const route = context.ui.router.current()
          return showStatus(route.type === "session" ? route.sessionID : undefined)
        },
      },
      {
        id: "opencode.goal.pause",
        title: "Goal: pause",
        group: "Goal",
        description: "Stop the agent from continuing; the objective is kept",
        bind: false as const,
        run: () => {
          const route = context.ui.router.current()
          if (route.type !== "session") return
          return act(route.sessionID, "pause")
        },
      },
      {
        id: "opencode.goal.resume",
        title: "Goal: resume",
        group: "Goal",
        description: "Let the agent continue toward the finish line",
        bind: false as const,
        run: () => {
          const route = context.ui.router.current()
          if (route.type !== "session") return
          return act(route.sessionID, "resume")
        },
      },
      {
        id: "opencode.goal.clear",
        title: "Goal: clear",
        group: "Goal",
        description: "Remove the goal from this session",
        bind: false as const,
        run: async () => {
          const route = context.ui.router.current()
          if (route.type !== "session") return
          const confirmed = await context.ui.dialog.confirm({
            title: "Clear goal",
            message: "Remove the goal and its ledger from this session? The objective will be lost.",
            label: { confirm: "Clear", cancel: "Keep" },
          })
          if (confirmed) await act(route.sessionID, "clear")
        },
      },
    ]

    // Global palette + shortcut commands, owned by the app slot so the layer
    // lives for the whole TUI session.
    const releaseApp = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 20,
          commands: goalCommands(),
        }))
        return null
      },
    })

    // Status badge in the prompt footer, where the eye already is.
    const releasePrompt = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        const goal = goalOf(input.sessionID)
        return (
          <Show when={goal}>
            {(current) => (
              <text fg={context.theme[STATUS_TONE[current().status] ?? "text.base"]}>
                {" "}
                {STATUS_BADGE[current().status] ?? "GOAL"} {current().usedTurns}/{current().maxTurns}
              </text>
            )}
          </Show>
        )
      },
    })

    // A progress row above the composer: the Codex-style "what is this run for".
    const releaseComposer = context.ui.slot({
      append: "session.composer.top",
      render: (input) => {
        const goal = goalOf(input.sessionID)
        return (
          <Show when={goal}>
            {(current) => (
              <box flexDirection="row" gap={1} paddingX={1}>
                <text fg={context.theme[STATUS_TONE[current().status] ?? "text.base"]}>
                  {STATUS_BADGE[current().status] ?? "GOAL"}
                </text>
                <text fg={context.theme.text.dim}>{bar(current().progressPercent)}</text>
                <text fg={context.theme.text.dim}>
                  {current().usedTurns}/{current().maxTurns} turns · {minutes(current().elapsedMs)}/{minutes(current().maxMs)}
                </text>
                <text fg={context.theme.text.dim} truncate>
                  {current().title}
                </text>
                <Show when={current().status === "active"}>
                  <text fg={context.theme.text.dim}>· /goal pause</text>
                </Show>
                <Show when={current().status !== "active" && current().status !== "complete"}>
                  <text fg={context.theme.text.dim}>· /goal resume</text>
                </Show>
              </box>
            )}
          </Show>
        )
      },
    })

    // The dashboard, opened with the palette command.
    const releasePanel = context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === TUI_PANEL}>
          <GoalPanel panel={panel} context={context} state={state} goalOf={goalOf} refresh={refresh} act={act} />
        </Show>
      ),
    })

    // Toggle pause/resume for the session in view.
    //
    // No key is claimed. An earlier version bound ctrl+g, which is OpenCode's
    // own `session.first` — the host won, the plugin lost, and the symptom was
    // "loading chat history" instead of a goal dialog. Nearly every ctrl+ key in
    // the host's table is already taken, so a hardcoded binding is a guess that
    // fails silently. This is reachable from the palette, and a key can be
    // assigned to `opencode.goal.toggle` in `cli.json` under `keybinds`.
    const releaseKeys = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 20,
          commands: [
            {
              id: "opencode.goal.toggle",
              title: "Goal: pause or resume",
              group: "Goal",
              description: "Toggle the active goal, or show its status when there is none",
              palette: true as const,
              bind: false as const,
              run: () => {
                const route = context.ui.router.current()
                if (route.type !== "session") return
                const goal = goalOf(route.sessionID)
                if (!goal) {
                  void showStatus(route.sessionID)
                  return
                }
                if (goal.status === "active") return void act(route.sessionID, "pause")
                if (goal.status === "complete") {
                  context.ui.toast.show({ title: "Goal", message: "Already complete. Set a new one with /goal <outcome>.", variant: "info" })
                  return
                }
                return void act(route.sessionID, "resume")
              },
            },
          ],
        }))
        return null
      },
    })

    return () => {
      stopChanged()
      stopViewed()
      stopDeleted()
      releaseApp()
      releasePrompt()
      releaseComposer()
      releasePanel()
      releaseKeys()
    }
  },
} satisfies TuiPluginDefinition

interface PanelProps {
  panel: PanelInput
  context: Context
  state: Store<GoalState>
  goalOf: (sessionID: string | undefined) => GoalView | undefined
  refresh: (sessionID: string) => Promise<void>
  act: (sessionID: string, action: "pause" | "resume" | "clear" | "status" | "continue-once", turns?: number) => Promise<void>
}

function GoalPanel(props: PanelProps) {
  const goal = () => props.goalOf(props.panel.sessionID)
  const tone = () => props.context.theme[STATUS_TONE[goal()?.status ?? "active"] ?? "text.base"]

  // The panel owns input only while it is open, so its keys live in its layer.
  props.context.keymap.layer(() => ({
    mode: "goal",
    commands: [
      {
        id: "opencode.goal.panel.pause",
        bind: "p",
        enabled: () => goal()?.status === "active",
        run: () => void props.act(props.panel.sessionID, "pause"),
      },
      {
        id: "opencode.goal.panel.resume",
        bind: "r",
        enabled: () => {
          const status = goal()?.status
          return status !== undefined && status !== "active" && status !== "complete"
        },
        run: () => void props.act(props.panel.sessionID, "resume"),
      },
      {
        id: "opencode.goal.panel.refresh",
        bind: "R",
        run: () => void props.refresh(props.panel.sessionID),
      },
      {
        id: "opencode.goal.panel.clear",
        bind: "c",
        run: async () => {
          const confirmed = await props.context.ui.dialog.confirm({
            title: "Clear goal",
            message: "Remove the goal and its ledger from this session?",
            label: { confirm: "Clear", cancel: "Keep" },
          })
          if (confirmed) await props.act(props.panel.sessionID, "clear")
        },
      },
      {
        id: "opencode.goal.panel.fullscreen",
        bind: "f",
        run: props.panel.toggleFullscreen,
      },
    ],
  }))

  return (
    <box flexDirection="column" gap={1} padding={1}>
      <Show when={goal()} fallback={<text fg={props.context.theme.text.dim}>No goal in this session. Use /goal &lt;outcome&gt; to start one.</text>}>
        {(current) => (
          <>
            <box flexDirection="row" gap={1}>
              <text fg={tone()}>{STATUS_BADGE[current().status] ?? "GOAL"}</text>
              <text fg={props.context.theme.text.dim}>{bar(current().progressPercent, 20)}</text>
              <text fg={props.context.theme.text.dim}>
                {current().usedTurns}/{current().maxTurns} turns · {minutes(current().elapsedMs)}/{minutes(current().maxMs)}
              </text>
            </box>

            <text fg={props.context.theme.text.base} wrapMode="word">{current().objective}</text>

            <Show when={current().verification}>
              <text fg={props.context.theme.text.dim} wrapMode="word">{"verified by: " + current().verification}</text>
            </Show>
            <Show when={current().constraints}>
              <text fg={props.context.theme.text.dim} wrapMode="word">{"must not regress: " + current().constraints}</text>
            </Show>
            <Show when={current().boundaries}>
              <text fg={props.context.theme.text.dim} wrapMode="word">{"in scope: " + current().boundaries}</text>
            </Show>
            <Show when={current().blockedStop}>
              <text fg={props.context.theme.text.dim} wrapMode="word">{"stop and report when: " + current().blockedStop}</text>
            </Show>

            <Show when={current().blocker}>
              <text fg={props.context.theme.text.error} wrapMode="word">{"blocker: " + current().blocker}</text>
            </Show>
            <Show when={current().evidence}>
              <text fg={props.context.theme.text.dim} wrapMode="word">{"evidence: " + current().evidence}</text>
            </Show>

            <box flexDirection="row" gap={1}>
              <Show when={current().status === "active"}>
                <text fg={props.context.theme.text.dim}>p pause</text>
              </Show>
              <Show when={current().status !== "active" && current().status !== "complete"}>
                <text fg={props.context.theme.text.dim}>r resume</text>
              </Show>
              <text fg={props.context.theme.text.dim}>c clear</text>
              <text fg={props.context.theme.text.dim}>f fullscreen</text>
            </box>

            <Show when={current().notes.length > 0}>
              <text fg={props.context.theme.text.dim}>{`ledger (${current().notes.length})`}</text>
              <For each={current().notes.slice(-12)}>
                {(note) => (
                  <text fg={props.context.theme.text.dim} wrapMode="word">
                    {`· ${note.status}${note.note ? `: ${note.note}` : ""}${note.next ? ` → ${note.next}` : ""}`}
                  </text>
                )}
              </For>
            </Show>

            <Show when={props.state.error}>
              <text fg={props.context.theme.text.error}>{`goal panel: ${props.state.error}`}</text>
            </Show>
          </>
        )}
      </Show>
    </box>
  )
}

export { GoalRpc, normalizeOptions }
