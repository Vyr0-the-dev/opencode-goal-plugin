/**
 * Human-readable rendering of a goal.
 *
 * Lifecycle messages are posted into the transcript as synthetic messages, so
 * they have to read well as plain text in a terminal and stay useful when
 * copied into an issue. Markdown headings are avoided: the transcript renders
 * these inline.
 */

import { elapsedMs, remainingTurns, type Goal, type GoalNote } from "./goal.ts"
import { progressPercent } from "./goal.ts"

const STATUS_LABEL: Readonly<Record<Goal["status"], string>> = {
  active: "ACTIVE",
  paused: "PAUSED",
  complete: "COMPLETE",
  blocked: "BLOCKED",
  budget: "BUDGET REACHED",
  cleared: "CLEARED",
}

function duration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 1) return "<1m"
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const rest = totalMinutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

function line(label: string, value: string | undefined): string {
  return value && value.trim() ? `${label}: ${value}` : ""
}

export function formatNote(note: GoalNote): string {
  const parts = [`[${new Date(note.at).toISOString().replace("T", " ").slice(0, 16)}Z] ${note.status}`]
  if (note.note) parts.push(note.note)
  if (note.evidence) parts.push(`evidence: ${note.evidence}`)
  if (note.next) parts.push(`next: ${note.next}`)
  if (note.blocker) parts.push(`blocker: ${note.blocker}`)
  return parts.join(" — ")
}

/** Full status report: what the goal is, what it may still do, and what happened. */
export function formatGoal(goal: Goal, now: number, options: { readonly history?: boolean } = {}): string {
  const lines: string[] = []
  lines.push(`GOAL — ${STATUS_LABEL[goal.status]}`)
  lines.push("")
  lines.push(`Objective`)
  lines.push(goal.objective)
  const extras = [line("Verified by", goal.verification), line("Must not regress", goal.constraints), line("In scope", goal.boundaries), line("Between iterations", goal.iteration), line("Stop and report when", goal.blockedStop)]
  const present = extras.filter((item) => item.length > 0)
  if (present.length > 0) {
    lines.push("")
    lines.push("Contract")
    lines.push(...present)
  }
  lines.push("")
  lines.push(
    `Budget: ${goal.budget.usedTurns}/${goal.budget.maxTurns} automatic turns used · ${remainingTurns(goal)} left · ${duration(elapsedMs(goal, now))} of ${duration(goal.budget.maxMs)} wall clock · ${progressPercent(goal)}%`,
  )
  if (goal.summary) {
    lines.push("")
    lines.push("Result")
    lines.push(goal.summary)
  }
  if (goal.evidence) {
    lines.push("")
    lines.push(`Evidence: ${goal.evidence}`)
  }
  if (goal.blocker) {
    lines.push("")
    lines.push(`Blocker: ${goal.blocker}`)
  }
  if (options.history && goal.notes.length > 0) {
    lines.push("")
    lines.push(`Ledger (${goal.notes.length} entr${goal.notes.length === 1 ? "y" : "ies"})`)
    for (const note of goal.notes) lines.push(`  ${formatNote(note)}`)
  }
  lines.push("")
  lines.push(
    goal.status === "active"
      ? "The agent keeps going on its own until this finish line is met, the budget runs out, or you pause it."
      : "Controls: /goal resume · /goal edit <text> · /goal budget <n> · /goal clear",
  )
  return lines.join("\n")
}

export function formatHistory(goal: Goal): string {
  if (goal.notes.length === 0) {
    return `GOAL LEDGER — empty\n\nNo progress has been recorded for "${goal.title}" yet.`
  }
  const lines = [`GOAL LEDGER — ${goal.status}, ${goal.notes.length} entr${goal.notes.length === 1 ? "y" : "ies"}`, ""]
  for (const note of goal.notes) lines.push(formatNote(note))
  if (goal.transitions.length > 0) {
    lines.push("")
    lines.push("Transitions")
    for (const transition of goal.transitions) {
      const reason = transition.reason ? ` (${transition.reason})` : ""
      lines.push(`  ${new Date(transition.at).toISOString().replace("T", " ").slice(0, 19)}Z  ${transition.from} → ${transition.to}${reason}`)
    }
  }
  return lines.join("\n")
}

export const NO_GOAL_REPORT = [
  "No goal is active in this session.",
  "",
  "Set one with the text that should become both the task and the finish line:",
  "",
  "```",
  "/goal Reduce p95 checkout latency below 120 ms, verified by the checkout benchmark,",
  "      while keeping the correctness suite green.",
  "```",
  "",
  "`/goal help` shows the full command surface.",
].join("\n")

export const HELP_REPORT_HEADER = "GOAL — persistent objectives for OpenCode"
