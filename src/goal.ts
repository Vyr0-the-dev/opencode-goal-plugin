/**
 * The goal domain model.
 *
 * A Goal is durable, thread-scoped state — not global memory and not a project
 * instruction. It records the objective, the completion contract the user wrote,
 * the lifecycle, and the progress accounting that decides whether the agent may
 * keep going.
 */

export const GOAL_VERSION = 1

export const GOAL_STATUSES = ["active", "paused", "complete", "blocked", "budget", "cleared"] as const
export type GoalStatus = (typeof GOAL_STATUSES)[number]

/** Statuses from which the goal will not continue on its own. */
export const TERMINAL_STATUSES: readonly GoalStatus[] = ["complete", "blocked", "budget", "cleared"]

export function isGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === "string" && (GOAL_STATUSES as readonly string[]).includes(value)
}

export function isTerminal(status: GoalStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

export type GoalNoteStatus = "working" | "complete" | "blocked" | "budget"

export interface GoalNote {
  readonly at: number
  readonly status: GoalNoteStatus
  readonly note?: string
  readonly evidence?: string
  readonly next?: string
  readonly blocker?: string
}

export interface GoalBudget {
  /** Automatic continuation turns this goal may still consume. */
  readonly maxTurns: number
  /** Automatic continuation turns consumed so far. */
  readonly usedTurns: number
  /** When the goal was activated. */
  readonly startedAt: number
  /** Wall-clock ceiling in milliseconds. */
  readonly maxMs: number
}

export interface GoalTransition {
  readonly at: number
  readonly from: GoalStatus
  readonly to: GoalStatus
  readonly reason?: string
}

export interface Goal {
  readonly version: number
  readonly id: string
  readonly sessionID: string
  /** Short one-line label derived from the objective. */
  readonly title: string
  /** Outcome: what should be true when the work is done. */
  readonly objective: string
  /** Verification surface: the evidence that proves the outcome. */
  readonly verification: string
  /** What must not regress while working. */
  readonly constraints: string
  /** Which files, tools, data, or systems are in scope. */
  readonly boundaries: string
  /** How to pick the next action after each attempt. */
  readonly iteration: string
  /** When to stop and report instead of continuing. */
  readonly blockedStop: string
  readonly status: GoalStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly budget: GoalBudget
  readonly notes: readonly GoalNote[]
  readonly transitions: readonly GoalTransition[]
  /** Final report written when the goal completed or blocked. */
  readonly summary?: string
  /** Evidence cited for completion. */
  readonly evidence?: string
  /** Why the goal is blocked. */
  readonly blocker?: string
  /** Set when a continuation turn made no tool call; suppresses the next automatic turn. */
  readonly suppressNextContinuation?: boolean
  /** Consecutive continuation turns that produced no tool call. */
  readonly noToolStreak: number
  /** Whether the most recent dispatched turn was an automatic continuation. */
  readonly lastTurnWasContinuation: boolean
  readonly lastContinuationAt?: number
  /** Whether a continuation is currently being dispatched. */
  readonly dispatching: boolean
  /** Where the goal came from. */
  readonly source: "command" | "tool"
}

export interface GoalDraft {
  objective: string
  verification?: string
  constraints?: string
  boundaries?: string
  iteration?: string
  blockedStop?: string
  maxTurns?: number
  maxMinutes?: number
}

const TITLE_LIMIT = 72

/** Derives a compact label so status lines stay readable. */
export function deriveTitle(objective: string): string {
  const flat = objective.replace(/\s+/g, " ").trim()
  if (!flat) return "Untitled goal"
  if (flat.length <= TITLE_LIMIT) return flat
  const cut = flat.slice(0, TITLE_LIMIT)
  const space = cut.lastIndexOf(" ")
  return `${(space > TITLE_LIMIT * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

let counter = 0

/** Goal IDs only need to be unique within a session; they are not URLs. */
export function createGoalID(sessionID: string, now: number): string {
  counter = (counter + 1) % 1_000_000
  return `goal_${now.toString(36)}_${counter.toString(36)}_${sessionID.slice(-6)}`
}

export function createGoal(input: {
  sessionID: string
  draft: GoalDraft
  now: number
  defaults: { maxTurns: number; maxMinutes: number }
  source: "command" | "tool"
  previous?: Goal
}): Goal {
  const { sessionID, draft, now, defaults, source, previous } = input
  const transitions: GoalTransition[] = previous
    ? [...previous.transitions, { at: now, from: previous.status, to: "active" as const, reason: "replaced by a new goal" }]
    : []

  return {
    version: GOAL_VERSION,
    id: createGoalID(sessionID, now),
    sessionID,
    title: deriveTitle(draft.objective),
    objective: draft.objective.trim(),
    verification: (draft.verification ?? "").trim(),
    constraints: (draft.constraints ?? "").trim(),
    boundaries: (draft.boundaries ?? "").trim(),
    iteration: (draft.iteration ?? "").trim(),
    blockedStop: (draft.blockedStop ?? "").trim(),
    status: "active",
    createdAt: now,
    updatedAt: now,
    budget: {
      maxTurns: clampInt(draft.maxTurns, 1, 10_000, defaults.maxTurns),
      usedTurns: 0,
      startedAt: now,
      maxMs: clampInt(draft.maxMinutes, 1, 60 * 24 * 30, defaults.maxMinutes) * 60_000,
    },
    notes: [],
    transitions,
    noToolStreak: 0,
    lastTurnWasContinuation: false,
    dispatching: false,
    source,
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  const rounded = Math.floor(parsed)
  if (rounded < min) return fallback
  return Math.min(rounded, max)
}

export function remainingTurns(goal: Goal): number {
  return Math.max(0, goal.budget.maxTurns - goal.budget.usedTurns)
}

export function elapsedMs(goal: Goal, now: number): number {
  return Math.max(0, now - goal.budget.startedAt)
}

export type BudgetExhaustion = "turns" | "time" | undefined

export function budgetExhausted(goal: Goal, now: number): BudgetExhaustion {
  if (remainingTurns(goal) <= 0) return "turns"
  if (elapsedMs(goal, now) >= goal.budget.maxMs) return "time"
  return undefined
}

export function progressPercent(goal: Goal): number {
  if (goal.status === "complete") return 100
  const byTurns = goal.budget.maxTurns > 0 ? goal.budget.usedTurns / goal.budget.maxTurns : 0
  return Math.max(0, Math.min(100, Math.round(byTurns * 100)))
}

/** Repairs a value read back from storage so a schema change can never crash a session. */
export function reviveGoal(value: unknown): Goal | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.sessionID !== "string" || !raw.sessionID) return undefined
  if (typeof raw.objective !== "string" || !raw.objective.trim()) return undefined
  const status = isGoalStatus(raw.status) ? raw.status : "paused"
  const budget = (raw.budget ?? {}) as Record<string, unknown>
  const now = Date.now()
  return {
    version: GOAL_VERSION,
    id: typeof raw.id === "string" ? raw.id : createGoalID(raw.sessionID, now),
    sessionID: raw.sessionID,
    title: typeof raw.title === "string" && raw.title ? raw.title : deriveTitle(raw.objective),
    objective: raw.objective,
    verification: str(raw.verification),
    constraints: str(raw.constraints),
    boundaries: str(raw.boundaries),
    iteration: str(raw.iteration),
    blockedStop: str(raw.blockedStop),
    status,
    createdAt: num(raw.createdAt, now),
    updatedAt: num(raw.updatedAt, now),
    budget: {
      maxTurns: Math.max(1, num(budget.maxTurns, 25)),
      usedTurns: Math.max(0, num(budget.usedTurns, 0)),
      startedAt: num(budget.startedAt, num(raw.createdAt, now)),
      maxMs: Math.max(1_000, num(budget.maxMs, 180 * 60_000)),
    },
    notes: Array.isArray(raw.notes) ? (raw.notes.filter(isNote) as GoalNote[]) : [],
    transitions: Array.isArray(raw.transitions) ? (raw.transitions.filter(isTransition) as GoalTransition[]) : [],
    summary: optStr(raw.summary),
    evidence: optStr(raw.evidence),
    blocker: optStr(raw.blocker),
    suppressNextContinuation: raw.suppressNextContinuation === true,
    noToolStreak: Math.max(0, num(raw.noToolStreak, 0)),
    lastTurnWasContinuation: raw.lastTurnWasContinuation === true,
    lastContinuationAt: typeof raw.lastContinuationAt === "number" ? raw.lastContinuationAt : undefined,
    dispatching: false,
    source: raw.source === "command" ? "command" : "tool",
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function optStr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function isNote(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const note = value as Record<string, unknown>
  return typeof note.at === "number" && (note.status === "working" || note.status === "complete" || note.status === "blocked" || note.status === "budget")
}

function isTransition(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const transition = value as Record<string, unknown>
  return typeof transition.at === "number" && isGoalStatus(transition.from) && isGoalStatus(transition.to)
}
