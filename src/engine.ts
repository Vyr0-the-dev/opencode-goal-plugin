/**
 * The goal engine.
 *
 * Owns the lifecycle, the durable state, and the continuation dispatcher. It
 * talks to the host through a narrow port so the whole policy can be exercised
 * in tests without an OpenCode server, and so no call it makes can reach a
 * session it was not given.
 */

import {
  budgetExhausted,
  createGoal,
  elapsedMs,
  progressPercent,
  remainingTurns,
  type Goal,
  type GoalDraft,
  type GoalNote,
  type GoalStatus,
} from "./goal.ts"
import { decideContinuation, shouldSuppressContinuation } from "./decision.ts"
import { formatGoal, formatHistory, NO_GOAL_REPORT } from "./format.ts"
import { activationPrompt, continuationPrompt } from "./prompts.ts"
import type { GoalOptions } from "./options.ts"
import { GoalStore } from "./store.ts"

/** Metadata written on every message the engine itself submits. */
export const GOAL_METADATA = "opencode-goal" as const

export type GoalTurnOrigin = "activation" | "continuation" | "user"

export interface GoalPort {
  readonly storage: ConstructorParameters<typeof GoalStore>[0]
  sessionInfo(sessionID: string): Promise<{ readonly agent?: string } | undefined>
  prompt(input: {
    sessionID: string
    text: string
    delivery: "steer" | "queue"
    origin: GoalTurnOrigin
  }): Promise<unknown>
  note(input: { sessionID: string; text: string; description: string }): Promise<unknown>
  changed(goal: Goal | undefined, sessionID: string): Promise<void>
  warn(message: string): void
  now(): number
}

/**
 * Tracks undelivered inbox work per session.
 *
 * A continuation must never talk over something the user is waiting to say, so
 * the dispatcher refuses to act while anything is queued. The engine learns
 * this from the inbox event stream rather than by polling, which keeps it
 * correct for synthetic items too: this plugin's own notices are recorded but
 * not counted, because they are deliberately inert.
 */
class PendingInbox {
  readonly #foreign = new Map<string, Set<string>>()
  readonly #own = new Map<string, Set<string>>()

  enqueue(sessionID: string, inboxID: string, own: boolean): void {
    const target = own ? this.#own : this.#foreign
    const set = target.get(sessionID) ?? new Set<string>()
    set.add(inboxID)
    target.set(sessionID, set)
  }

  settle(sessionID: string, inboxID: string): void {
    this.#foreign.get(sessionID)?.delete(inboxID)
    this.#own.get(sessionID)?.delete(inboxID)
  }

  count(sessionID: string): number {
    return this.#foreign.get(sessionID)?.size ?? 0
  }

  clear(sessionID: string): void {
    this.#foreign.delete(sessionID)
    this.#own.delete(sessionID)
  }
}

export interface ActivateInput extends GoalDraft {
  /** Install the goal without submitting the activation turn. */
  readonly start?: boolean
  /** Install an active goal that never auto-continues. */
  readonly autoContinue?: boolean
}

export interface MutationResult {
  readonly goal: Goal | undefined
  readonly message: string
  /** Set when the caller should submit a model turn after the mutation. */
  readonly prompt?: { readonly text: string; readonly origin: GoalTurnOrigin }
}

const MAX_NOTE_LENGTH = 4_000

function trimText(value: unknown, limit = MAX_NOTE_LENGTH): string {
  if (typeof value !== "string") return ""
  const trimmed = value.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 1)}…`
}

function nowSafe(goal: Goal, now: number): Goal {
  return { ...goal, updatedAt: now }
}

function withNote(goal: Goal, note: GoalNote, maxNotes: number): Goal {
  const notes = [...goal.notes, note]
  return { ...goal, notes: notes.length > maxNotes ? notes.slice(notes.length - maxNotes) : notes }
}

export class GoalEngine {
  readonly #port: GoalPort
  readonly #options: GoalOptions
  readonly #store: GoalStore
  /** A tool ran during the most recent turn of this session. */
  readonly #toolSeen = new Set<string>()
  readonly #dispatching = new Set<string>()
  readonly #inbox = new PendingInbox()

  constructor(port: GoalPort, options: GoalOptions) {
    this.#port = port
    this.#options = options
    this.#store = new GoalStore(port.storage)
  }

  get store(): GoalStore {
    return this.#store
  }

  get options(): GoalOptions {
    return this.#options
  }

  // ---------------------------------------------------------------- reads

  async get(sessionID: string): Promise<Goal | undefined> {
    return this.#store.read(sessionID)
  }

  // ------------------------------------------------------------- mutation

  async activate(sessionID: string, input: ActivateInput): Promise<MutationResult> {
    const now = this.#port.now()
    const objective = trimText(input.objective, 4_000)
    if (!objective) {
      return { goal: await this.get(sessionID), message: "A goal needs an objective. Usage: `/goal <outcome>`." }
    }
    const previous = await this.#store.read(sessionID)
    const goal = createGoal({
      sessionID,
      draft: {
        objective,
        verification: input.verification,
        constraints: input.constraints,
        boundaries: input.boundaries,
        iteration: input.iteration,
        blockedStop: input.blockedStop,
        maxTurns: input.maxTurns,
        maxMinutes: input.maxMinutes,
      },
      now,
      defaults: { maxTurns: this.#options.defaultMaxTurns, maxMinutes: this.#options.defaultMaxMinutes },
      source: "command",
    })

    const final: Goal = input.autoContinue === false ? { ...goal, status: "paused" } : goal
    await this.#store.write(final)
    await this.#port.changed(final, sessionID)

    const replaced = previous && !isCleared(previous) ? "\n\nA previous goal was replaced; its history is in the ledger below." : ""
    const message = formatGoal(final, this.#port.now()) + replaced
    if (input.start === false) {
      return { goal: final, message }
    }
    return { goal: final, message, prompt: { text: activationPrompt(final), origin: "activation" } }
  }

  async pause(sessionID: string, reason = "paused by user"): Promise<MutationResult> {
    return this.#transition(sessionID, "paused", reason)
  }

  async resume(sessionID: string): Promise<MutationResult> {
    const current = await this.#store.read(sessionID)
    if (!current) return { goal: undefined, message: NO_GOAL_REPORT }
    if (current.status === "complete") {
      return { goal: current, message: `The goal is complete: "${current.title}". Set a new one with \`/goal <outcome>\`.` }
    }
    if (current.status === "cleared") return { goal: undefined, message: NO_GOAL_REPORT }

    const now = this.#port.now()
    const exhausted = current.status === "budget" ? budgetExhausted(current, now) : undefined
    // Resuming after a budget stop grants a fresh window; the old accounting is
    // kept in the ledger so nothing is hidden.
    const budget = current.status === "budget" ? { ...current.budget, maxTurns: this.#options.defaultMaxTurns, startedAt: now } : current.budget
    const goal = withNote(
      nowSafe(
        {
          ...current,
          status: "active",
          budget,
          suppressNextContinuation: false,
          noToolStreak: 0,
          lastTurnWasContinuation: false,
          transitions: [...current.transitions, { at: now, from: current.status, to: "active" as GoalStatus, reason: "resumed" }],
        },
        now,
      ),
      { at: now, status: "working", note: current.status === "budget" ? "resumed with a fresh turn budget" : "resumed" },
      this.#options.maxNotes,
    )
    await this.#store.write(goal)
    this.#toolSeen.delete(sessionID)
    await this.#port.changed(goal, sessionID)

    if (exhausted && goal.budget.usedTurns >= goal.budget.maxTurns) {
      return { goal, message: "The turn budget is already spent. Raise it with `/goal budget <n>`, then resume." }
    }
    return { goal, message: formatGoal(goal, this.#port.now()) }
  }

  async clear(sessionID: string): Promise<MutationResult> {
    const current = await this.#store.read(sessionID)
    if (!current) return { goal: undefined, message: "There is no goal to clear." }
    const now = this.#port.now()
    const goal: Goal = {
      ...current,
      status: "cleared",
      updatedAt: now,
      transitions: [...current.transitions, { at: now, from: current.status, to: "cleared", reason: "cleared by user" }],
    }
    await this.#store.write(goal)
    await this.#port.changed(goal, sessionID)
    return {
      goal,
      message: [
`Goal cleared: "${current.title}"`,
"",
"The goal is no longer active and will not continue on its own. Its record and",
"ledger are kept in this session, so the history stays auditable. Setting a new",
"goal replaces it.",
].join("\n"),
    }
  }

  async forget(sessionID: string): Promise<void> {
    this.#toolSeen.delete(sessionID)
    this.#dispatching.delete(sessionID)
    this.#inbox.clear(sessionID)
    await this.#store.remove(sessionID)
    await this.#port.changed(undefined, sessionID)
  }

  async edit(sessionID: string, objective: string): Promise<MutationResult> {
    const text = trimText(objective, 4_000)
    if (!text) return { goal: await this.get(sessionID), message: "`/goal edit` needs the new objective text." }
    const current = await this.#store.read(sessionID)
    if (!current) return { goal: undefined, message: NO_GOAL_REPORT }
    const result = await this.activate(sessionID, {
      objective: text,
      verification: current.verification,
      constraints: current.constraints,
      boundaries: current.boundaries,
      iteration: current.iteration,
      blockedStop: current.blockedStop,
      maxTurns: current.budget.maxTurns,
      maxMinutes: Math.round(current.budget.maxMs / 60_000),
      start: false,
    })
    const ledger = result.goal ? formatHistory(result.goal) : ""
    return {
      goal: result.goal,
      message: `Objective replaced.\n\n${result.message}${ledger ? `\n\n${ledger}` : ""}`,
      prompt: { text: activationPrompt(result.goal!), origin: "activation" },
    }
  }

  async setBudget(sessionID: string, turns: number | undefined): Promise<MutationResult> {
    if (turns === undefined || !Number.isFinite(turns) || turns < 1) {
      return { goal: await this.get(sessionID), message: "`/goal budget` needs a positive number of turns, e.g. `/goal budget 30`." }
    }
    const current = await this.#store.read(sessionID)
    if (!current) return { goal: undefined, message: NO_GOAL_REPORT }
    const now = this.#port.now()
    const goal = nowSafe({ ...current, budget: { ...current.budget, maxTurns: Math.floor(turns) } }, now)
    await this.#store.write(goal)
    await this.#port.changed(goal, sessionID)
    return { goal, message: formatGoal(goal, now) }
  }

  // ------------------------------------------------- model-facing updates

  async recordWorking(sessionID: string, input: { note?: string; evidence?: string; next?: string }): Promise<MutationResult> {
    const now = this.#port.now()
    const updated = await this.#store.update(sessionID, (current) => {
      if (!current) return undefined
      return withNote(
        nowSafe(current, now),
        { at: now, status: "working", note: trimText(input.note), evidence: trimText(input.evidence), next: trimText(input.next) },
        this.#options.maxNotes,
      )
    })
    if (!updated) return { goal: undefined, message: NO_GOAL_REPORT }
    await this.#port.changed(updated, sessionID)
    return { goal: updated, message: `Recorded (${updated.notes.length} ledger entr${updated.notes.length === 1 ? "y" : "ies"}). ${remainingTurns(updated)} automatic turns left.` }
  }

  async recordComplete(sessionID: string, input: { summary?: string; evidence?: string }): Promise<MutationResult> {
    const summary = trimText(input.summary)
    const evidence = trimText(input.evidence)
    if (!summary) {
      return { goal: await this.get(sessionID), message: "Refusing to complete: a completion needs a summary of what is now true. Call `goal_update` again with `summary` and `evidence`." }
    }
    const now = this.#port.now()
    const goal = await this.#store.update(sessionID, (current) => {
      if (!current) return undefined
      return withNote(
        nowSafe(
          {
            ...current,
            status: "complete" as GoalStatus,
            summary,
            evidence: evidence || undefined,
            suppressNextContinuation: false,
            transitions: [...current.transitions, { at: now, from: current.status, to: "complete" as GoalStatus, reason: "model reported completion" }],
          },
          now,
        ),
        { at: now, status: "complete", note: summary, evidence: evidence || undefined },
        this.#options.maxNotes,
      )
    })
    if (!goal) return { goal: undefined, message: NO_GOAL_REPORT }
    this.#toolSeen.delete(sessionID)
    await this.#port.changed(goal, sessionID)
    return { goal, message: `Goal marked complete. ${formatGoal(goal, now)}` }
  }

  async recordBlocked(sessionID: string, input: { blocker?: string; next?: string; summary?: string }): Promise<MutationResult> {
    const blocker = trimText(input.blocker)
    if (!blocker) {
      return { goal: await this.get(sessionID), message: "Refusing to block: call `goal_update` with the `blocker` and what would unblock it." }
    }
    const now = this.#port.now()
    const goal = await this.#store.update(sessionID, (current) => {
      if (!current) return undefined
      return withNote(
        nowSafe(
          {
            ...current,
            status: "blocked" as GoalStatus,
            blocker,
            summary: trimText(input.summary) || undefined,
            suppressNextContinuation: false,
            transitions: [...current.transitions, { at: now, from: current.status, to: "blocked" as GoalStatus, reason: "model reported a blocker" }],
          },
          now,
        ),
        { at: now, status: "blocked", blocker, next: trimText(input.next) },
        this.#options.maxNotes,
      )
    })
    if (!goal) return { goal: undefined, message: NO_GOAL_REPORT }
    this.#toolSeen.delete(sessionID)
    await this.#port.changed(goal, sessionID)
    return { goal, message: `Goal marked blocked. ${formatGoal(goal, now)}` }
  }

  // ------------------------------------------------------------- reports

  async report(sessionID: string, options: { history?: boolean } = {}): Promise<{ goal: Goal | undefined; text: string }> {
    const goal = await this.get(sessionID)
    if (!goal || goal.status === "cleared") return { goal, text: NO_GOAL_REPORT }
    return { goal, text: formatGoal(goal, this.#port.now(), options) }
  }

  async history(sessionID: string): Promise<{ goal: Goal | undefined; text: string }> {
    const goal = await this.get(sessionID)
    if (!goal || goal.status === "cleared") return { goal, text: "No goal ledger in this session." }
    return { goal, text: formatHistory(goal) }
  }

  // -------------------------------------------------------- host callbacks

  /** A user message was admitted. Reset the per-turn bookkeeping for it. */
  async onUserPrompt(sessionID: string): Promise<void> {
    this.#toolSeen.delete(sessionID)
    await this.#store.update(sessionID, (current) => {
      if (!current) return undefined
      if (!current.lastTurnWasContinuation && !current.suppressNextContinuation) return undefined
      return {
        ...current,
        lastTurnWasContinuation: false,
        suppressNextContinuation: false,
        dispatching: false,
      }
    })
  }

  /** A tool ran in this session during the current turn. */
  markToolCall(sessionID: string): void {
    this.#toolSeen.add(sessionID)
  }

  /** Something was added to the session inbox. */
  trackEnqueued(sessionID: string, inboxID: string, own: boolean): void {
    this.#inbox.enqueue(sessionID, inboxID, own)
  }

  /** Something left the session inbox, delivered or cancelled. */
  trackSettled(sessionID: string, inboxID: string): void {
    this.#inbox.settle(sessionID, inboxID)
  }

  /** An execution was interrupted. */
  async onInterrupted(sessionID: string): Promise<void> {
    if (!this.#options.pauseOnInterrupt) return
    const current = await this.get(sessionID)
    if (!current || current.status !== "active") return
    const now = this.#port.now()
    const goal = withNote(
      nowSafe(
        {
          ...current,
          status: "paused" as GoalStatus,
          lastTurnWasContinuation: false,
          dispatching: false,
          transitions: [...current.transitions, { at: now, from: current.status, to: "paused" as GoalStatus, reason: "run interrupted" }],
        },
        now,
      ),
      { at: now, status: "working", note: "paused: the run was interrupted" },
      this.#options.maxNotes,
    )
    await this.#store.write(goal)
    this.#toolSeen.delete(sessionID)
    this.#dispatching.delete(sessionID)
    await this.#port.changed(goal, sessionID)
    if (this.#options.postLifecycleNotices) {
      await this.#announce(sessionID, `Goal paused — the run was interrupted.\n\n${formatGoal(goal, now)}`, "goal paused")
    }
  }

  /**
   * The session went idle. This is the only place a continuation can be
   * dispatched, and only when every guard in `decideContinuation` passes.
   */
  async onIdle(sessionID: string): Promise<void> {
    if (this.#dispatching.has(sessionID)) return
    const goal = await this.#getRich(sessionID)
    if (!goal) return

    const now = this.#port.now()
    const decision = decideContinuation({
      enabled: this.#options.enabled,
      goal,
      now,
      dispatching: this.#dispatching.has(sessionID),
      pendingItems: this.#inbox.count(sessionID),
      agent: await this.#safeAgent(sessionID),
      skipAgents: this.#options.skipAgents,
      cooldownMs: this.#options.continuationDelayMs,
    })

    if (decision.action === "stop") return
    if (decision.action === "budget_exhausted") {
      await this.finalizeBudget(sessionID, goal, decision.exhausted)
      return
    }

    const spin = shouldSuppressContinuation({
      status: goal.status,
      lastTurnWasContinuation: goal.lastTurnWasContinuation,
      sawToolCall: this.#toolSeen.has(sessionID),
      suppressNextContinuation: goal.suppressNextContinuation === true,
      maxNoToolStreak: this.#options.maxNoToolStreak,
      noToolStreak: goal.noToolStreak,
    })

    if (spin === "suppress") {
      await this.suppressContinuation(sessionID, goal)
      return
    }
    if (spin === "blocked") {
      await this.declareStalled(sessionID, goal)
      return
    }

    await this.dispatchContinuation(sessionID, goal)
  }

  // ------------------------------------------------------------ internals

  async #getRich(sessionID: string): Promise<Goal | undefined> {
    const stored = await this.#store.read(sessionID)
    if (!stored) return undefined
    // Runtime-only flags are merged here so a stale persisted value can never
    // pin a goal into "dispatching" forever.
    return { ...stored, dispatching: this.#dispatching.has(sessionID) }
  }

  async #transition(sessionID: string, to: GoalStatus, reason: string): Promise<MutationResult> {
    const current = await this.#store.read(sessionID)
    if (!current) return { goal: undefined, message: NO_GOAL_REPORT }
    if (current.status === to) {
      return { goal: current, message: `The goal is already ${to}.\n\n${formatGoal(current, this.#port.now())}` }
    }
    const now = this.#port.now()
    const goal = withNote(
      nowSafe(
        {
          ...current,
          status: to,
          lastTurnWasContinuation: false,
          suppressNextContinuation: false,
          dispatching: false,
          transitions: [...current.transitions, { at: now, from: current.status, to, reason }],
        },
        now,
      ),
      { at: now, status: "working", note: reason },
      this.#options.maxNotes,
    )
    await this.#store.write(goal)
    this.#dispatching.delete(sessionID)
    this.#toolSeen.delete(sessionID)
    await this.#port.changed(goal, sessionID)
    return { goal, message: formatGoal(goal, now) }
  }

  async #announce(sessionID: string, text: string, description: string): Promise<void> {
    try {
      await this.#port.note({ sessionID, text, description })
    } catch (error) {
      this.#port.warn(`goal: could not post notice — ${describe(error)}`)
    }
  }

  async #safeAgent(sessionID: string): Promise<string | undefined> {
    try {
      const info = await this.#port.sessionInfo(sessionID)
      return info?.agent
    } catch {
      return undefined
    }
  }

  async dispatchContinuation(sessionID: string, goal: Goal): Promise<void> {
    const now = this.#port.now()
    const turn = goal.budget.usedTurns + 1
    this.#dispatching.add(sessionID)
    this.#toolSeen.delete(sessionID)

    const prepared: Goal = {
      ...goal,
      // `dispatching` is runtime-only; the in-memory set is the source of truth
      // so a persisted `true` can never wedge a goal.
      dispatching: false,
      lastTurnWasContinuation: true,
      lastContinuationAt: now,
      budget: { ...goal.budget, usedTurns: turn },
    }
    await this.#store.write(prepared)
    await this.#port.changed(prepared, sessionID)

    try {
      await this.#port.prompt({
        sessionID,
        text: continuationPrompt(prepared, turn),
        delivery: "queue",
        origin: "continuation",
      })
    } catch (error) {
      this.#port.warn(`goal: continuation dispatch failed — ${describe(error)}`)
      await this.#store.update(sessionID, (current) =>
        current ? nowSafe({ ...current, dispatching: false, lastContinuationAt: undefined }, this.#port.now()) : undefined,
      )
    } finally {
      this.#dispatching.delete(sessionID)
    }
  }

  async suppressContinuation(sessionID: string, goal: Goal): Promise<void> {
    const now = this.#port.now()
    const streak = goal.noToolStreak + 1
    const updated: Goal = withNote(
      nowSafe({ ...goal, suppressNextContinuation: true, noToolStreak: streak, dispatching: false }, now),
      { at: now, status: "working", note: "automatic continuation halted: the last turn made no tool call, so it was not progress" },
      this.#options.maxNotes,
    )
    await this.#store.write(updated)
    this.#toolSeen.delete(sessionID)
    await this.#port.changed(updated, sessionID)
    if (this.#options.postLifecycleNotices) {
      await this.#announce(
        sessionID,
        [
          `Goal loop halted (${streak}/${this.#options.maxNoToolStreak}).`,
          "",
          "The last automatic turn made no tool call, so it produced no evidence and the next",
          "automatic turn was suppressed instead of spinning. The goal is still active.",
          "",
          "Do this next: send a message that asks for a concrete action, or run `/goal resume`",
          "to restart the loop yourself.",
        ].join("\n"),
        "goal loop halted",
      )
    }
  }

  async declareStalled(sessionID: string, goal: Goal): Promise<void> {
    const now = this.#port.now()
    const blocker = "The agent stopped making tool calls, so the loop cannot produce evidence."
    const updated: Goal = withNote(
      nowSafe(
        {
          ...goal,
          status: "blocked" as GoalStatus,
          blocker,
          summary: goal.summary ?? `Stopped after ${goal.noToolStreak} consecutive turns without a single tool call.`,
          suppressNextContinuation: false,
          dispatching: false,
          transitions: [...goal.transitions, { at: now, from: goal.status, to: "blocked" as GoalStatus, reason: "no progress" }],
        },
        now,
      ),
      { at: now, status: "blocked", blocker, next: "Ask for a concrete action, or `/goal resume` to try again." },
      this.#options.maxNotes,
    )
    await this.#store.write(updated)
    this.#toolSeen.delete(sessionID)
    this.#dispatching.delete(sessionID)
    await this.#port.changed(updated, sessionID)
    if (this.#options.postLifecycleNotices) {
      await this.#announce(
        sessionID,
        `Goal blocked — no progress.\n\n${formatGoal(updated, now)}`,
        "goal blocked",
      )
    }
  }

  async finalizeBudget(sessionID: string, goal: Goal, exhausted: "turns" | "time"): Promise<void> {
    const now = this.#port.now()
    const reason = exhausted === "turns" ? "turn budget reached" : "wall-clock budget reached"
    const summary =
      goal.summary ??
      [
        `Stopped after ${goal.budget.usedTurns} automatic turns and ${Math.round(elapsedMs(goal, now) / 60_000)} minutes without the finish line being met.`,
        goal.blocker ? `Blocker: ${goal.blocker}` : "No blocker was recorded.",
        "Reaching a budget limit is not the same as completing the objective.",
      ].join(" ")
    const updated: Goal = withNote(
      nowSafe(
        {
          ...goal,
          status: "budget" as GoalStatus,
          summary,
          suppressNextContinuation: false,
          dispatching: false,
          transitions: [...goal.transitions, { at: now, from: goal.status, to: "budget" as GoalStatus, reason }],
        },
        now,
      ),
      { at: now, status: "budget", note: reason, next: "Review, then `/goal budget <n>` and `/goal resume`, or `/goal clear`." },
      this.#options.maxNotes,
    )
    await this.#store.write(updated)
    this.#toolSeen.delete(sessionID)
    this.#dispatching.delete(sessionID)
    await this.#port.changed(updated, sessionID)
    if (this.#options.postLifecycleNotices) {
      await this.#announce(
        sessionID,
        [
          `Goal stopped — ${reason}.`,
          "",
          updated.summary,
          "",
          `${remainingTurns(updated)} automatic turns remain unused, and the objective is not complete.`,
          "Next: raise the budget and resume, narrow the goal, or clear it.",
        ].join("\n"),
        "goal budget reached",
      )
    }
  }
}

function isCleared(goal: Goal): boolean {
  return goal.status === "cleared"
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return "unknown error"
  }
}

export { progressPercent }
