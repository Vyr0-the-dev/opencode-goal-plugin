import { describe, expect, test } from "bun:test"
import { decideContinuation, shouldSuppressContinuation, type ContinuationInput } from "../src/decision.ts"
import { createGoal, budgetExhausted, deriveTitle, remainingTurns, reviveGoal, type Goal } from "../src/goal.ts"

const T0 = 1_700_000_000_000

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    ...createGoal({
      sessionID: "ses_1",
      draft: { objective: "make the suite green" },
      now: T0,
      defaults: { maxTurns: 5, maxMinutes: 60 },
      source: "command",
    }),
    ...overrides,
  }
}

function input(overrides: Partial<ContinuationInput> = {}): ContinuationInput {
  return {
    enabled: true,
    goal: goal(),
    now: T0 + 1_000,
    dispatching: false,
    pendingItems: 0,
    agent: "build",
    skipAgents: ["plan"],
    cooldownMs: 0,
    ...overrides,
  }
}

describe("decideContinuation", () => {
  test("continues an active goal with budget left", () => {
    expect(decideContinuation(input())).toEqual({ action: "continue" })
  })

  test("never continues without a goal", () => {
    expect(decideContinuation(input({ goal: undefined }))).toEqual({ action: "stop", reason: "no_goal" })
  })

  test("never continues when the plugin is disabled", () => {
    expect(decideContinuation(input({ enabled: false }))).toEqual({ action: "stop", reason: "disabled" })
  })

  test.each(["paused", "complete", "blocked", "budget", "cleared"] as const)("never continues a %s goal", (status) => {
    expect(decideContinuation(input({ goal: goal({ status }) }))).toEqual({ action: "stop", reason: "not_active" })
  })

  test("waits while anything is queued for the session", () => {
    expect(decideContinuation(input({ pendingItems: 1 }))).toEqual({ action: "stop", reason: "pending_input" })
  })

  test("never dispatches twice concurrently", () => {
    expect(decideContinuation(input({ dispatching: true }))).toEqual({ action: "stop", reason: "dispatching" })
  })

  test("does not drive a plan-only agent", () => {
    expect(decideContinuation(input({ agent: "plan" }))).toEqual({ action: "stop", reason: "agent_skipped" })
    expect(decideContinuation(input({ agent: "PLAN" }))).toEqual({ action: "stop", reason: "agent_skipped" })
  })

  test("honours a custom skip list", () => {
    expect(decideContinuation(input({ agent: "review", skipAgents: ["review"] }))).toEqual({
      action: "stop",
      reason: "agent_skipped",
    })
  })

  test("respects the cooldown after the previous continuation", () => {
    const recent = goal({ lastContinuationAt: T0 + 900 })
    expect(decideContinuation(input({ goal: recent, now: T0 + 1_000, cooldownMs: 750 }))).toEqual({
      action: "stop",
      reason: "cooldown",
    })
    expect(decideContinuation(input({ goal: recent, now: T0 + 2_000, cooldownMs: 750 }))).toEqual({ action: "continue" })
  })

  test("reports an exhausted turn budget", () => {
    const spent = goal()
    const drained: Goal = { ...spent, budget: { ...spent.budget, usedTurns: 5 } }
    expect(decideContinuation(input({ goal: drained }))).toEqual({ action: "budget_exhausted", exhausted: "turns" })
  })

  test("reports an exhausted wall-clock budget", () => {
    const old = goal()
    const slow: Goal = { ...old, budget: { ...old.budget, startedAt: T0 - 61 * 60_000 } }
    expect(decideContinuation(input({ goal: slow, now: T0 }))).toEqual({ action: "budget_exhausted", exhausted: "time" })
  })

  test("the exact last turn is allowed", () => {
    const spent = goal()
    const lastOne: Goal = { ...spent, budget: { ...spent.budget, usedTurns: 4 } }
    expect(decideContinuation(input({ goal: lastOne }))).toEqual({ action: "continue" })
  })
})

describe("shouldSuppressContinuation", () => {
  const base = {
    status: "active" as const,
    lastTurnWasContinuation: true,
    sawToolCall: false,
    suppressNextContinuation: false,
    maxNoToolStreak: 2,
    noToolStreak: 0,
  }

  test("allows a turn that made a tool call", () => {
    expect(shouldSuppressContinuation({ ...base, sawToolCall: true })).toBe("no")
  })

  test("ignores the previous turn when the user was driving", () => {
    expect(shouldSuppressContinuation({ ...base, lastTurnWasContinuation: false })).toBe("no")
  })

  test("ignores a goal that is no longer active", () => {
    expect(shouldSuppressContinuation({ ...base, status: "paused" })).toBe("no")
  })

  test("suppresses the next turn after one turn without a tool call", () => {
    expect(shouldSuppressContinuation(base)).toBe("suppress")
  })

  test("blocks once the streak is already spent or exhausted", () => {
    expect(shouldSuppressContinuation({ ...base, suppressNextContinuation: true })).toBe("blocked")
    expect(shouldSuppressContinuation({ ...base, noToolStreak: 1 })).toBe("blocked")
  })
})

describe("goal helpers", () => {
  test("derives a short title without breaking words badly", () => {
    expect(deriveTitle("short objective")).toBe("short objective")
    const long = deriveTitle(
      "reduce the p95 latency of the checkout service below one hundred and twenty milliseconds while the correctness suite stays green",
    )
    expect(long.length).toBeLessThanOrEqual(73)
    expect(long.endsWith("…")).toBe(true)
  })

  test("a new goal starts active with a fresh budget", () => {
    const created = goal()
    expect(created.status).toBe("active")
    expect(created.budget).toMatchObject({ maxTurns: 5, usedTurns: 0, maxMs: 3_600_000 })
    expect(remainingTurns(created)).toBe(5)
    expect(goal({ budget: { ...created.budget, usedTurns: 3 } }) && remainingTurns(goal({ budget: { ...created.budget, usedTurns: 3 } }))).toBe(2)
  })

  test("budget exhaustion covers both limits", () => {
    const created = goal()
    expect(budgetExhausted(created, T0)).toBeUndefined()
    expect(budgetExhausted({ ...created, budget: { ...created.budget, usedTurns: 5 } }, T0)).toBe("turns")
    expect(budgetExhausted(created, T0 + 3_600_000)).toBe("time")
  })

  test("explicit budget overrides from the draft win over the defaults", () => {
    const created = createGoal({
      sessionID: "ses_1",
      draft: { objective: "x", maxTurns: 3, maxMinutes: 5 },
      now: T0,
      defaults: { maxTurns: 25, maxMinutes: 180 },
      source: "tool",
    })
    expect(created.budget.maxTurns).toBe(3)
    expect(created.budget.maxMs).toBe(300_000)
  })

  test("a nonsense budget falls back to the defaults", () => {
    const created = createGoal({
      sessionID: "ses_1",
      draft: { objective: "x", maxTurns: -4, maxMinutes: Number.NaN },
      now: T0,
      defaults: { maxTurns: 25, maxMinutes: 180 },
      source: "command",
    })
    expect(created.budget.maxTurns).toBe(25)
    expect(created.budget.maxMs).toBe(180 * 60_000)
  })

  test("replacing a goal keeps the old lifecycle in the transitions", () => {
    const first = goal({ status: "paused" })
    const second = createGoal({
      sessionID: "ses_1",
      draft: { objective: "next thing" },
      now: T0 + 10,
      defaults: { maxTurns: 5, maxMinutes: 60 },
      source: "command",
      previous: first,
    })
    expect(second.transitions).toHaveLength(1)
    expect(second.transitions[0]).toMatchObject({ from: "paused", to: "active" })
  })
})

describe("reviveGoal", () => {
  test("round-trips a goal through JSON", () => {
    const original = goal()
    const revived = reviveGoal(JSON.parse(JSON.stringify(original)))
    expect(revived).toMatchObject({
      id: original.id,
      sessionID: original.sessionID,
      objective: original.objective,
      status: "active",
      budget: original.budget,
    })
  })

  test("repairs junk instead of throwing, so a bad record cannot wedge a session", () => {
    expect(reviveGoal(undefined)).toBeUndefined()
    expect(reviveGoal("nonsense")).toBeUndefined()
    expect(reviveGoal({})).toBeUndefined()
    expect(reviveGoal({ sessionID: "ses_1" })).toBeUndefined()
    expect(reviveGoal({ sessionID: "ses_1", objective: "  " })).toBeUndefined()

    const repaired = reviveGoal({ sessionID: "ses_1", objective: "ship it", status: "bogus", budget: { maxTurns: -1, usedTurns: -9 } })
    expect(repaired?.status).toBe("paused")
    expect(repaired?.budget.maxTurns).toBe(1)
    expect(repaired?.budget.usedTurns).toBe(0)
  })

  test("never revives a goal pinned as dispatching", () => {
    const revived = reviveGoal({ ...JSON.parse(JSON.stringify(goal())), dispatching: true })
    expect(revived?.dispatching).toBe(false)
  })
})
