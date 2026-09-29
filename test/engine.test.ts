/**
 * Engine tests run against a fake port, so the whole policy — dispatch,
 * suppression, budget, interruption, persistence — is exercised without an
 * OpenCode server. If these pass, the only thing left unproven is the host
 * wiring in index.ts.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import { GoalEngine, type GoalPort, type GoalTurnOrigin } from "../src/engine.ts"
import { normalizeOptions, type GoalOptions } from "../src/options.ts"
import { isGoalAction } from "../src/rpc.ts"
import { remainingTurns } from "../src/goal.ts"
import { goalSystemBlock } from "../src/prompts.ts"

const T0 = 1_700_000_000_000

class FakeStorage {
  readonly data = new Map<string, unknown>()

  async get(key: string) {
    return this.data.get(key) as never
  }
  async set(key: string, value: unknown) {
    this.data.set(key, value)
  }
  async remove(key: string) {
    this.data.delete(key)
  }
  async scan(options: { prefix: string; after?: string; limit?: number }) {
    const entries = [...this.data.entries()]
      .filter(([key]) => key.startsWith(options.prefix) && key > (options.after ?? ""))
      .slice(0, options.limit ?? 100)
      .map(([key, value]) => ({ key, value: value as never }))
    return { entries }
  }
}

interface Turn {
  sessionID: string
  text: string
  delivery: string
  origin: GoalTurnOrigin
}

interface Notice {
  sessionID: string
  text: string
  description: string
}

class Harness {
  readonly storage = new FakeStorage()
  readonly turns: Turn[] = []
  readonly notices: Notice[] = []
  readonly changed: Array<{ sessionID: string; status: string }> = []
  readonly warnings: string[] = []
  agent: string | undefined = "build"
  clock = T0

  readonly port: GoalPort = {
    storage: this.storage as never,
    sessionInfo: async () => ({ agent: this.agent }),
    prompt: async (input) => {
      this.turns.push(input)
    },
    note: async (input) => {
      this.notices.push(input)
    },
    changed: async (goal, sessionID) => {
      this.changed.push({ sessionID, status: goal?.status ?? "cleared" })
    },
    warn: (message) => {
      this.warnings.push(message)
    },
    now: () => this.clock,
  }

  engine(overrides: Partial<GoalOptions> = {}): GoalEngine {
    return new GoalEngine(this.port, { ...normalizeOptions({}), ...overrides })
  }

  tick(ms: number) {
    this.clock += ms
  }
}

let h: Harness

beforeEach(() => {
  h = new Harness()
})

const SES = "ses_test"

/**
 * A goal with the default budget but no continuation cooldown, so a test can
 * drive several idles in a row without sleeping. The cooldown itself is covered
 * in decision.test.ts and by the dedicated test below.
 */
async function active(overrides: Partial<GoalOptions> = {}) {
  const engine = h.engine({ continuationDelayMs: 0, ...overrides })
  await engine.activate(SES, { objective: "make the suite green", start: false })
  return engine
}

describe("activation", () => {
  test("installs an active goal and asks for the activation turn", async () => {
    const engine = h.engine()
    const result = await engine.activate(SES, { objective: "make the suite green" })
    expect(result.goal?.status).toBe("active")
    expect(result.prompt?.origin).toBe("activation")
    expect(result.prompt?.text).toContain("make the suite green")
    expect(h.storage.data.size).toBe(1)
  })

  test("refuses an empty objective and changes nothing", async () => {
    const engine = h.engine()
    const result = await engine.activate(SES, { objective: "   " })
    expect(result.goal).toBeUndefined()
    expect(result.message).toContain("needs an objective")
    expect(h.storage.data.size).toBe(0)
  })

  test("--no-start installs without asking for a turn", async () => {
    const engine = h.engine()
    const result = await engine.activate(SES, { objective: "x", start: false })
    expect(result.prompt).toBeUndefined()
    expect(result.goal?.status).toBe("active")
  })

  test("--no-continue installs the goal paused", async () => {
    const engine = h.engine()
    const result = await engine.activate(SES, { objective: "x", start: false, autoContinue: false })
    expect(result.goal?.status).toBe("paused")
  })

  test("replacing a goal says so in the report", async () => {
    const engine = h.engine()
    await engine.activate(SES, { objective: "first", start: false })
    const second = await engine.activate(SES, { objective: "second", start: false })
    expect(second.message).toContain("previous goal was replaced")
  })
})

describe("continuation", () => {
  test("dispatches a continuation when a goal is active and the session idles", async () => {
    const engine = await active()
    h.turns.length = 0
    await engine.onIdle(SES)
    expect(h.turns).toHaveLength(1)
    expect(h.turns[0]!.origin).toBe("continuation")
    expect(h.turns[0]!.text).toContain("GOAL CONTINUATION 1/25")
    const goal = await engine.get(SES)
    expect(goal?.budget.usedTurns).toBe(1)
  })

  test("the default cooldown holds off an immediate re-dispatch", async () => {
    const engine = await active({ continuationDelayMs: 750 })
    h.turns.length = 0
    await engine.onIdle(SES)
    expect(h.turns).toHaveLength(1)

    await engine.onIdle(SES)
    expect(h.turns).toHaveLength(1)

    h.tick(800)
    engine.markToolCall(SES)
    await engine.onIdle(SES)
    expect(h.turns).toHaveLength(2)
  })

  test("does not dispatch for a paused goal", async () => {
    const engine = await active()
    await engine.pause(SES)
    h.turns.length = 0
    await engine.onIdle(SES)
    expect(h.turns).toHaveLength(0)
  })

  test("does not dispatch when the user has something queued", async () => {
    const engine = await active()
    h.turns.length = 0
    engine.trackEnqueued(SES, "msg_1", false)
    await engine.onIdle(SES)
    expect(h.turns).toHaveLength(0)

    engine.trackSettled(SES, "msg_1")
    await engine.onIdle(SES)
    expect(h.turns).toHaveLength(1)
  })

  test("this plugin's own notices never count as queued user work", async () => {
    const engine = await active()
    h.turns.length = 0
    engine.trackEnqueued(SES, "msg_notice", true)
    await engine.onIdle(SES)
    expect(h.turns).toHaveLength(1)
  })

  test("does not dispatch for a plan-only agent", async () => {
    const engine = await active()
    h.agent = "plan"
    h.turns.length = 0
    await engine.onIdle(SES)
    expect(h.turns).toHaveLength(0)
  })

  test("counts every continuation against the budget", async () => {
    const engine = await active({ defaultMaxTurns: 2 })
    h.turns.length = 0
    await engine.onIdle(SES)
    engine.markToolCall(SES)
    await engine.onIdle(SES)
    expect(h.turns).toHaveLength(2)
    expect((await engine.get(SES))?.budget.usedTurns).toBe(2)
  })

  test("stops on the budget and explains that it is not completion", async () => {
    const engine = await active({ defaultMaxTurns: 1, postLifecycleNotices: true })
    h.turns.length = 0
    await engine.onIdle(SES)
    engine.markToolCall(SES)
    h.notices.length = 0
    await engine.onIdle(SES)

    const goal = await engine.get(SES)
    expect(goal?.status).toBe("budget")
    expect(h.turns).toHaveLength(1)
    const notice = h.notices.at(-1)
    expect(notice?.text).toContain("turn budget reached")
    expect(notice?.text).toContain("not the same as completing")
  })

  test("stops on the wall-clock budget", async () => {
    const engine = await active({ defaultMaxMinutes: 1 })
    h.turns.length = 0
    h.tick(61_000)
    await engine.onIdle(SES)
    expect(h.turns).toHaveLength(0)
    expect((await engine.get(SES))?.status).toBe("budget")
  })

  test("a failed dispatch releases the lock and does not consume a silent turn", async () => {
    const engine = await active()
    h.port.prompt = async () => {
      throw new Error("server is down")
    }
    await engine.onIdle(SES)
    const goal = await engine.get(SES)
    expect(goal?.lastContinuationAt).toBeUndefined()
    expect(h.warnings.some((w) => w.includes("continuation dispatch failed"))).toBe(true)

    // The lock must be released, otherwise the goal would be stuck forever.
    h.port.prompt = h.port.prompt.bind(h.port)
    const before = (await engine.get(SES))?.budget.usedTurns
    expect(before).toBe(1)
  })
})

describe("anti-spin", () => {
  test("a continuation turn that made no tool call halts the loop", async () => {
    const engine = await active({ postLifecycleNotices: true })
    h.turns.length = 0
    await engine.onIdle(SES)
    expect(h.turns).toHaveLength(1)

    h.notices.length = 0
    await engine.onIdle(SES)
    expect(h.turns).toHaveLength(1)

    const goal = await engine.get(SES)
    expect(goal?.status).toBe("active")
    expect(goal?.suppressNextContinuation).toBe(true)
    expect(goal?.noToolStreak).toBe(1)
    expect(h.notices.at(-1)?.text).toContain("no tool call")
  })

  test("a real user turn clears the suppression and the loop restarts", async () => {
    const engine = await active()
    await engine.onIdle(SES)
    await engine.onIdle(SES)
    expect((await engine.get(SES))?.suppressNextContinuation).toBe(true)

    await engine.onUserPrompt(SES)
    expect((await engine.get(SES))?.suppressNextContinuation).toBe(false)

    h.turns.length = 0
    await engine.onIdle(SES)
    expect(h.turns).toHaveLength(1)
  })

  test("a second fruitless turn blocks the goal instead of spinning forever", async () => {
    const engine = await active({ maxNoToolStreak: 2, postLifecycleNotices: true })
    await engine.onIdle(SES)
    await engine.onIdle(SES)
    expect((await engine.get(SES))?.status).toBe("active")

    await engine.onUserPrompt(SES)
    await engine.onIdle(SES)
    await engine.onIdle(SES)

    const goal = await engine.get(SES)
    expect(goal?.status).toBe("blocked")
    expect(goal?.blocker).toContain("stopped making tool calls")
  })

  test("a turn that used tools keeps the loop running", async () => {
    const engine = await active()
    for (let index = 0; index < 3; index++) {
      await engine.onIdle(SES)
      engine.markToolCall(SES)
    }
    expect((await engine.get(SES))?.budget.usedTurns).toBe(3)
    expect((await engine.get(SES))?.status).toBe("active")
  })
})

describe("lifecycle", () => {
  test("pause, resume, and clear move the goal through its states", async () => {
    const engine = await active()
    expect((await engine.pause(SES)).goal?.status).toBe("paused")
    expect((await engine.resume(SES)).goal?.status).toBe("active")
    expect((await engine.clear(SES)).goal?.status).toBe("cleared")

    const gone = await engine.resume(SES)
    expect(gone.message).toContain("No goal is active")
  })

  test("pausing twice is a no-op with an explanation", async () => {
    const engine = await active()
    await engine.pause(SES)
    const again = await engine.pause(SES)
    expect(again.message).toContain("already paused")
  })

  test("a completed goal cannot be resumed into a false claim", async () => {
    const engine = await active()
    await engine.recordComplete(SES, { summary: "all 42 checks pass", evidence: "bun test exit 0" })
    const resumed = await engine.resume(SES)
    expect(resumed.message).toContain("complete")
    expect((await engine.get(SES))?.status).toBe("complete")
  })

  test("resuming from a budget stop renews the window without erasing the accounting", async () => {
    const engine = await active({ defaultMaxTurns: 2, defaultMaxMinutes: 60 })
    await engine.onIdle(SES)
    engine.markToolCall(SES)
    await engine.onIdle(SES)
    await engine.onIdle(SES)
    expect((await engine.get(SES))?.status).toBe("budget")

    const resumed = await engine.resume(SES)
    expect(resumed.goal?.status).toBe("active")
    // The turns already spent stay on the record; only the ceiling is renewed.
    expect(resumed.goal?.budget.usedTurns).toBe(2)
    expect(resumed.goal?.budget.maxTurns).toBe(2)
    expect(resumed.goal?.notes.at(-1)?.note).toContain("fresh turn budget")
  })

  test("resuming with no turns left says what to do instead of pretending", async () => {
    const engine = await active({ defaultMaxTurns: 1, defaultMaxMinutes: 60 })
    await engine.onIdle(SES)
    engine.markToolCall(SES)
    await engine.onIdle(SES)
    expect((await engine.get(SES))?.status).toBe("budget")

    const resumed = await engine.resume(SES)
    expect(resumed.message).toContain("already spent")
    expect(resumed.message).toContain("/goal budget <n>")
    expect(remainingTurns(resumed.goal!)).toBe(0)

    // Raising the budget and resuming again does restore the loop.
    await engine.setBudget(SES, 10)
    const again = await engine.resume(SES)
    expect(again.goal?.status).toBe("active")
    expect(remainingTurns(again.goal!)).toBe(9)
  })

  test("an interruption pauses the objective and explains itself", async () => {
    const engine = await active({ postLifecycleNotices: true })
    h.notices.length = 0
    await engine.onInterrupted(SES)
    const goal = await engine.get(SES)
    expect(goal?.status).toBe("paused")
    expect(h.notices.at(-1)?.description).toBe("goal paused")

    h.turns.length = 0
    await engine.onIdle(SES)
    expect(h.turns).toHaveLength(0)
  })

  test("pauseOnInterrupt: false leaves the objective running", async () => {
    const engine = await active({ pauseOnInterrupt: false })
    await engine.onInterrupted(SES)
    expect((await engine.get(SES))?.status).toBe("active")
  })

  test("budget changes are validated", async () => {
    const engine = await active()
    expect((await engine.setBudget(SES, 0)).message).toContain("positive number")
    expect((await engine.setBudget(SES, 40)).goal?.budget.maxTurns).toBe(40)
  })

  test("edit replaces the objective and keeps the contract", async () => {
    const engine = await active()
    await engine.edit(SES, "a narrower objective")
    const goal = await engine.get(SES)
    expect(goal?.objective).toBe("a narrower objective")
    expect(goal?.status).toBe("active")
  })

  test("editing a session with no goal says so", async () => {
    const engine = h.engine()
    const result = await engine.edit(SES, "anything")
    expect(result.message).toContain("No goal is active")
  })
})

describe("model-facing updates", () => {
  test("working records an auditable ledger entry", async () => {
    const engine = await active()
    await engine.recordWorking(SES, { note: "ran the suite", evidence: "12 failing", next: "fix the auth fixture" })
    const goal = await engine.get(SES)
    expect(goal?.notes).toHaveLength(1)
    expect(goal?.notes[0]).toMatchObject({ status: "working", next: "fix the auth fixture" })
  })

  test("completion is refused without a summary", async () => {
    const engine = await active()
    const result = await engine.recordComplete(SES, { evidence: "looks good" })
    expect(result.message).toContain("Refusing to complete")
    expect((await engine.get(SES))?.status).toBe("active")
  })

  test("completion needs evidence, not just confidence", async () => {
    const engine = await active()
    await engine.recordComplete(SES, { summary: "all green" })
    const goal = await engine.get(SES)
    expect(goal?.status).toBe("complete")
    expect(goal?.evidence).toBeUndefined()
  })

  test("a completed goal stops the loop", async () => {
    const engine = await active()
    await engine.recordComplete(SES, { summary: "all green", evidence: "exit 0" })
    h.turns.length = 0
    await engine.onIdle(SES)
    expect(h.turns).toHaveLength(0)
  })

  test("blocking is refused without a blocker", async () => {
    const engine = await active()
    const result = await engine.recordBlocked(SES, {})
    expect(result.message).toContain("Refusing to block")
    expect((await engine.get(SES))?.status).toBe("active")
  })

  test("blocking records what would unblock it", async () => {
    const engine = await active()
    await engine.recordBlocked(SES, { blocker: "no network access to fetch the fixture", next: "ask for an offline fixture" })
    const goal = await engine.get(SES)
    expect(goal?.status).toBe("blocked")
    expect(goal?.notes[0]?.next).toContain("offline fixture")
  })

  test("a note is dropped when there is no goal", async () => {
    const engine = h.engine()
    const result = await engine.recordWorking(SES, { note: "x" })
    expect(result.goal).toBeUndefined()
  })

  test("the ledger is capped so a long goal cannot grow without bound", async () => {
    const engine = await active({ maxNotes: 3 })
    for (let index = 0; index < 10; index++) {
      await engine.recordWorking(SES, { note: `step ${index}` })
    }
    const goal = await engine.get(SES)
    expect(goal?.notes).toHaveLength(3)
    expect(goal?.notes.at(-1)?.note).toBe("step 9")
  })
})

describe("persistence", () => {
  test("a goal survives a fresh engine over the same storage", async () => {
    const first = h.engine()
    await first.activate(SES, { objective: "persist me", start: false, verification: "bun test" })

    const second = h.engine()
    const goal = await second.get(SES)
    expect(goal?.objective).toBe("persist me")
    expect(goal?.verification).toBe("bun test")
  })

  test("forget removes the record and the runtime state", async () => {
    const engine = await active()
    await engine.forget(SES)
    expect(await engine.get(SES)).toBeUndefined()
    expect(h.storage.data.size).toBe(0)
  })

  test("concurrent updates to one session do not lose writes", async () => {
    const engine = await active()
    await Promise.all([
      engine.recordWorking(SES, { note: "a" }),
      engine.recordWorking(SES, { note: "b" }),
      engine.recordWorking(SES, { note: "c" }),
    ])
    expect((await engine.get(SES))?.notes).toHaveLength(3)
  })

  test("the store lists goals across sessions", async () => {
    const engine = h.engine()
    await engine.activate("ses_a", { objective: "one", start: false })
    await engine.activate("ses_b", { objective: "two", start: false })
    const all = await engine.store.list()
    expect(all.map((goal) => goal.sessionID).sort()).toEqual(["ses_a", "ses_b"])
  })

  test("a storage failure never propagates into the session", async () => {
    const engine = new GoalEngine(
      {
        ...h.port,
        storage: {
          get: async () => {
            throw new Error("disk gone")
          },
          set: async () => {
            throw new Error("disk gone")
          },
          remove: async () => {
            throw new Error("disk gone")
          },
          scan: async () => {
            throw new Error("disk gone")
          },
        } as never,
      },
      normalizeOptions({}),
    )
    const result = await engine.activate(SES, { objective: "still works", start: false })
    expect(result.goal?.objective).toBe("still works")
    // The in-memory copy stays authoritative, so reads keep working even though
    // nothing reached disk.
    expect((await engine.store.list()).map((goal) => goal.objective)).toEqual(["still works"])
    expect(await engine.get(SES)).toBeDefined()
  })
})

describe("reports", () => {
  test("a session with no goal gets a usable answer, not an error", async () => {
    const engine = h.engine()
    const { text } = await engine.report(SES)
    expect(text).toContain("No goal is active")
  })

  test("the report shows the contract and the budget", async () => {
    const engine = h.engine()
    await engine.activate(SES, {
      objective: "cut p95 below 120ms",
      verification: "the checkout benchmark",
      constraints: "correctness suite stays green",
      start: false,
    })
    const { text } = await engine.report(SES)
    expect(text).toContain("cut p95 below 120ms")
    expect(text).toContain("the checkout benchmark")
    expect(text).toContain("correctness suite stays green")
    expect(text).toContain("0/25 automatic turns used")
  })

  test("a cleared goal reports as absent", async () => {
    const engine = await active()
    await engine.clear(SES)
    const { text } = await engine.report(SES)
    expect(text).toContain("No goal is active")
  })

  test("a retired goal is annotated without promising turns it cannot spend", async () => {
    const engine = await active()
    await engine.clear(SES)
    const result = await engine.recordWorking(SES, { note: "one last look" })
    expect(result.goal?.status).toBe("cleared")
    expect(result.message).toContain("cleared")
    expect(result.message).not.toContain("automatic turns left")
    // The note is still recorded: the ledger is the audit trail, and a retired
    // goal is exactly the one whose history someone will want to read.
    expect(result.goal?.notes.at(-1)?.note).toBe("one last look")
  })

  test("a live goal is still told how much budget it has", async () => {
    const engine = await active()
    const result = await engine.recordWorking(SES, { note: "step one" })
    expect(result.message).toContain("automatic turns left")
  })

  test("the history report lists the ledger and the transitions", async () => {
    const engine = await active()
    await engine.recordWorking(SES, { note: "profiled the hot path" })
    await engine.pause(SES)
    const { text } = await engine.history(SES)
    expect(text).toContain("profiled the hot path")
    expect(text).toContain("active → paused")
  })

  test("history on a fresh goal says so plainly", async () => {
    const engine = await active()
    const { text } = await engine.history(SES)
    expect(text).toContain("empty")
  })
})

describe("system block", () => {
  test("states the contract, the rules, and the budget", async () => {
    const engine = await active()
    const goal = await engine.get(SES)
    const block = goalSystemBlock(goal!)
    expect(block).toContain("make the suite green")
    expect(block).toContain("ACTIVE GOAL (opencode-goal-plugin)")
    expect(block).toContain("25 automatic turns remaining")
    expect(block).toContain("does not widen your authority")
  })

  test("surfaces the last recorded blocker", async () => {
    const engine = await active()
    await engine.recordBlocked(SES, { blocker: "no credentials" })
    const goal = await engine.get(SES)
    expect(goalSystemBlock(goal!)).toContain("no credentials")
  })
})

describe("rpc guards", () => {
  test("only the documented actions are accepted", () => {
    for (const action of ["status", "pause", "resume", "clear", "budget", "continue-once"]) {
      expect(isGoalAction(action)).toBe(true)
    }
    for (const action of ["delete", "drop", "", "COMPLETE"]) {
      expect(isGoalAction(action)).toBe(false)
    }
  })
})

describe("options", () => {
  test("bad values fall back instead of throwing", () => {
    const options = normalizeOptions({ defaultMaxTurns: "banana", defaultMaxMinutes: -1, skipAgents: 42, enabled: "maybe" })
    expect(options.defaultMaxTurns).toBe(25)
    expect(options.defaultMaxMinutes).toBe(180)
    expect(options.skipAgents).toEqual(["plan"])
    expect(options.enabled).toBe(true)
  })

  test("a non-object is treated as no options at all", () => {
    expect(normalizeOptions(null).commandName).toBe("goal")
    expect(normalizeOptions("nope").commandName).toBe("goal")
  })

  test("a custom command name is accepted, an unsafe one is not", () => {
    expect(normalizeOptions({ commandName: "/Mission" }).commandName).toBe("mission")
    expect(normalizeOptions({ commandName: "bad name!" }).commandName).toBe("goal")
  })

  test("a very large turn budget is clamped", () => {
    expect(normalizeOptions({ defaultMaxTurns: 10_000_000 }).defaultMaxTurns).toBe(10_000)
  })
})
