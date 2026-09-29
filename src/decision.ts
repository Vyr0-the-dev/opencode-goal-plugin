/**
 * The continuation dispatcher.
 *
 * This is the whole safety story of a goal, so it is a pure function of
 * observable state: given what is true right now, either dispatch another
 * automatic turn, stop the budget, or explain why nothing happened. No I/O, no
 * clock, no plugin context — which makes every rule testable and makes it
 * impossible for the dispatcher to act on state it has not looked at.
 */

import type { Goal, GoalStatus } from "./goal.ts"
import { budgetExhausted, isTerminal } from "./goal.ts"

export interface ContinuationInput {
  readonly enabled: boolean
  readonly goal: Goal | undefined
  readonly now: number
  /** A continuation is already being dispatched for this session. */
  readonly dispatching: boolean
  /** Queued user or synthetic inbox items. The agent never talks over the user. */
  readonly pendingItems: number
  /** The session's active agent, used to skip read-only/plan runs. */
  readonly agent: string | undefined
  readonly skipAgents: readonly string[]
  /** Grace period after the last continuation, so a human can interrupt. */
  readonly cooldownMs: number
}

export type StopReason =
  | "disabled"
  | "no_goal"
  | "not_active"
  | "dispatching"
  | "pending_input"
  | "agent_skipped"
  | "cooldown"

export type ContinuationDecision =
  | { readonly action: "continue" }
  | { readonly action: "budget_exhausted"; readonly exhausted: "turns" | "time" }
  | { readonly action: "stop"; readonly reason: StopReason }

export function decideContinuation(input: ContinuationInput): ContinuationDecision {
  if (!input.enabled) return { action: "stop", reason: "disabled" }

  const goal = input.goal
  if (!goal) return { action: "stop", reason: "no_goal" }

  const status: GoalStatus = goal.status
  if (status !== "active") {
    if (isTerminal(status)) return { action: "stop", reason: "not_active" }
    return { action: "stop", reason: "not_active" }
  }

  if (input.dispatching || goal.dispatching) return { action: "stop", reason: "dispatching" }
  if (input.pendingItems > 0) return { action: "stop", reason: "pending_input" }

  const agent = input.agent?.trim().toLowerCase()
  if (agent && input.skipAgents.includes(agent)) return { action: "stop", reason: "agent_skipped" }

  if (
    input.cooldownMs > 0 &&
    typeof goal.lastContinuationAt === "number" &&
    input.now - goal.lastContinuationAt < input.cooldownMs
  ) {
    return { action: "stop", reason: "cooldown" }
  }

  const exhausted = budgetExhausted(goal, input.now)
  if (exhausted) return { action: "budget_exhausted", exhausted }

  return { action: "continue" }
}

/**
 * A turn is only allowed to auto-continue when the model actually did something.
 * A continuation that produced no tool call cannot be evidence of progress, so
 * the next automatic turn is suppressed instead of spinning.
 */
export function shouldSuppressContinuation(input: {
  readonly status: GoalStatus | undefined
  readonly lastTurnWasContinuation: boolean
  readonly sawToolCall: boolean
  readonly suppressNextContinuation: boolean
  readonly maxNoToolStreak: number
  readonly noToolStreak: number
}): "no" | "suppress" | "blocked" {
  const status = input.status
  if (status !== "active") return "no"
  if (!input.lastTurnWasContinuation) return "no"
  if (input.sawToolCall) return "no"
  if (input.suppressNextContinuation) return "blocked"
  if (input.noToolStreak + 1 >= input.maxNoToolStreak) return "blocked"
  return "suppress"
}
