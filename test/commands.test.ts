/**
 * The command layer is the surface the user actually types, so it is tested
 * against a fake host: every lifecycle verb must answer without scheduling a
 * model turn, and only the verbs that change the work may submit one.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import { runGoalCommand, type CommandDeps } from "../src/commands.ts"
import { GoalEngine, type GoalPort, type GoalTurnOrigin } from "../src/engine.ts"
import { normalizeOptions } from "../src/options.ts"
import { remainingTurns } from "../src/goal.ts"

const SES = "ses_cmd"

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
  async scan(options: { prefix: string; limit?: number }) {
    return {
      entries: [...this.data.entries()]
        .filter(([key]) => key.startsWith(options.prefix))
        .slice(0, options.limit ?? 100)
        .map(([key, value]) => ({ key, value: value as never })),
    }
  }
}

interface Notice {
  sessionID: string
  text: string
  description: string | undefined
  resume: boolean | undefined
}

class Harness {
  readonly storage = new FakeStorage()
  readonly turns: Array<{ sessionID: string; text: string; delivery: string; origin: GoalTurnOrigin }> = []
  readonly notices: Notice[] = []
  readonly commands: Array<{ name: string; description?: string }> = []
  clock = 1_700_000_000_000

  readonly port: GoalPort = {
    storage: this.storage as never,
    sessionInfo: async () => ({ agent: "build" }),
    prompt: async (input) => {
      this.turns.push(input)
    },
    note: async (input) => {
      this.notices.push({ ...input, description: input.description, resume: false })
    },
    changed: async () => undefined,
    warn: () => undefined,
    now: () => this.clock,
  }

  engine = new GoalEngine(this.port, normalizeOptions({ continuationDelayMs: 0 }))

  readonly deps: CommandDeps = {
    host: {
      storage: this.storage as never,
      command: {
        transform: async (cb: (editor: { add: (def: { name: string; description?: string }) => void }) => void) => {
          cb({ add: (def) => this.commands.push(def) })
          return { dispose: async () => undefined }
        },
        reload: async () => undefined,
      } as never,
      session: {
        prompt: async (input: { sessionID: string; text: string; delivery?: string; metadata?: Record<string, unknown> }) => {
          const origin = input.metadata?.["opencode-goal"]
          this.turns.push({
            sessionID: input.sessionID,
            text: input.text,
            delivery: String(input.delivery),
            origin: (origin === "continuation" || origin === "activation" || origin === "user" ? origin : "user") as GoalTurnOrigin,
          })
        },
        synthetic: async (input: { sessionID: string; text: string; description?: string; resume?: boolean }) => {
          this.notices.push({
            sessionID: input.sessionID,
            text: input.text,
            description: input.description,
            resume: input.resume,
          })
        },
      } as never,
    },
    engine: this.engine,
    options: normalizeOptions({ continuationDelayMs: 0 }),
  }

  run(text: string, sessionID = SES) {
    return runGoalCommand(this.deps, { sessionID, prompt: { text }, delivery: "steer" })
  }
}

let h: Harness

beforeEach(() => {
  h = new Harness()
})

describe("lifecycle answers must be visible", () => {
  test.each(["/goal", "/goal status", "/goal help", "/goal history", "/goal pause", "/goal clear"])(
    "%s answers without submitting its own turn",
    async (input) => {
      await h.run(input)
      expect(h.turns).toHaveLength(0)
      expect(h.notices.length).toBeGreaterThan(0)
    },
  )

  test("by default the answer is scheduled, because an undelivered one is invisible", async () => {
    await h.run("/goal status")
    expect(h.notices.at(-1)?.resume).toBe(true)
    expect(h.notices.at(-1)?.description).toBe("goal")
  })

  test("answerLifecycleImmediately:false parks it instead, for a caller that would rather not pay", async () => {
    const engine = new GoalEngine(h.port, normalizeOptions({ continuationDelayMs: 0 }))
    const deps: CommandDeps = { ...h.deps, engine, options: normalizeOptions({ answerLifecycleImmediately: false }) }
    h.notices.length = 0
    await runGoalCommand(deps, { sessionID: SES, prompt: { text: "/goal status" }, delivery: "steer" })
    expect(h.notices.at(-1)?.resume).toBe(false)
  })

  test("the report for a fresh session is a usable answer", async () => {
    await h.run("/goal")
    expect(h.notices.at(-1)?.text).toContain("No goal is active")
  })
})

describe("setting a goal", () => {
  test("installs the goal and starts exactly one turn", async () => {
    await h.run(`/goal cut p95 below 120ms --verify "the checkout benchmark" --turns 8`)
    const goal = await h.engine.get(SES)
    expect(goal?.objective).toBe("cut p95 below 120ms")
    expect(goal?.verification).toBe("the checkout benchmark")
    expect(goal?.budget.maxTurns).toBe(8)
    expect(h.turns).toHaveLength(1)
    expect(h.turns[0]!.origin).toBe("activation")
    expect(h.turns[0]!.text).toContain("cut p95 below 120ms")
  })

  test("the report is shown in the same turn that starts the work", async () => {
    await h.run("/goal ship the parser")
    const report = h.notices.at(-1)
    expect(report?.text).toContain("ship the parser")
    expect(report?.text).toContain("survives compaction")
    // One activation turn, and the report rides on it rather than needing a
    // turn of its own.
    expect(h.turns).toHaveLength(1)
  })

  test("--no-start installs without starting a turn", async () => {
    await h.run("/goal migrate the build to bun --no-start")
    expect(h.turns).toHaveLength(0)
    expect((await h.engine.get(SES))?.status).toBe("active")
    expect(h.notices.at(-1)?.text).toContain("without starting a turn")
  })

  test("--no-continue installs a goal that will not run on its own", async () => {
    await h.run("/goal migrate the build to bun --no-continue")
    expect((await h.engine.get(SES))?.status).toBe("paused")
  })

  test("an objective may begin with a lifecycle word", async () => {
    await h.run("/goal stop the flaky checkout test from failing in ci")
    const goal = await h.engine.get(SES)
    expect(goal?.objective).toBe("stop the flaky checkout test from failing in ci")
    expect(h.turns).toHaveLength(1)
  })

  test("replacing a running goal says the old one was replaced", async () => {
    await h.run("/goal first objective")
    await h.run("/goal second objective")
    expect((await h.engine.get(SES))?.objective).toBe("second objective")
    expect(h.notices.at(-1)?.text).toContain("previous goal was replaced")
  })
})

describe("edit, budget, and resume", () => {
  test("edit replaces the objective and starts a turn on the new one", async () => {
    await h.run("/goal wide objective --verify tests")
    h.turns.length = 0
    await h.run("/goal edit narrow objective")
    const goal = await h.engine.get(SES)
    expect(goal?.objective).toBe("narrow objective")
    expect(goal?.verification).toBe("tests")
    expect(h.turns).toHaveLength(1)
  })

  test("edit without text explains itself and starts nothing", async () => {
    await h.run("/goal objective")
    h.turns.length = 0
    await h.run("/goal edit")
    expect(h.turns).toHaveLength(0)
    expect(h.notices.at(-1)?.text).toContain("needs the new objective")
  })

  test("budget changes the ceiling and starts nothing", async () => {
    await h.run("/goal objective")
    h.turns.length = 0
    await h.run("/goal budget 30")
    expect((await h.engine.get(SES))?.budget.maxTurns).toBe(30)
    expect(h.turns).toHaveLength(0)
  })

  test("a budget with no count asks for one", async () => {
    await h.run("/goal objective")
    h.turns.length = 0
    await h.run("/goal budget")
    expect(h.notices.at(-1)?.text).toContain("positive number")
    expect(h.turns).toHaveLength(0)
  })

  test("a non-numeric budget word is treated as an objective", async () => {
    await h.run("/goal budget the p95 until it drops")
    expect((await h.engine.get(SES))?.objective).toBe("budget the p95 until it drops")
  })

  test("resume re-arms the loop instead of waiting for the next idle", async () => {
    await h.run("/goal objective --turns 5")
    await h.run("/goal pause")
    h.turns.length = 0
    await h.run("/goal resume")
    expect((await h.engine.get(SES))?.status).toBe("active")
    expect(h.turns).toHaveLength(1)
    expect(h.turns[0]!.origin).toBe("continuation")
    expect(remainingTurns((await h.engine.get(SES))!)).toBe(4)
  })

  test("resuming with no goal is not an error", async () => {
    await h.run("/goal resume")
    expect(h.turns).toHaveLength(0)
    expect(h.notices.at(-1)?.text).toContain("No goal is active")
  })

  test("resuming a completed goal refuses to reopen it", async () => {
    await h.run("/goal objective")
    await h.engine.recordComplete(SES, { summary: "done", evidence: "exit 0" })
    h.turns.length = 0
    await h.run("/goal resume")
    expect((await h.engine.get(SES))?.status).toBe("complete")
    expect(h.turns).toHaveLength(0)
    expect(h.notices.at(-1)?.text).toContain("complete")
  })
})

describe("draft", () => {
  test("asks the model to write a contract without activating one", async () => {
    await h.run("/goal draft migrate this repo to bun")
    expect((await h.engine.get(SES))).toBeUndefined()
    expect(h.turns).toHaveLength(1)
    expect(h.turns[0]!.text).toContain("strong goal")
    expect(h.turns[0]!.text).toContain("migrate this repo to bun")
  })

  test("draft without a subject explains itself", async () => {
    await h.run("/goal draft")
    expect(h.turns).toHaveLength(0)
    expect(h.notices.at(-1)?.text).toContain("needs a subject")
  })
})

describe("isolation and failure", () => {
  test("a command in one session cannot see another's goal", async () => {
    await h.run("/goal mine", "ses_a")
    await h.run("/goal", "ses_b")
    expect(h.notices.at(-1)?.text).toContain("No goal is active")
    expect((await h.engine.get("ses_a"))?.objective).toBe("mine")
  })

  test("a thrown error is reported without changing the session", async () => {
    const broken = { ...h.deps, engine: undefined as never }
    await runGoalCommand(broken, { sessionID: SES, prompt: { text: "/goal status" }, delivery: "steer" })
    expect(h.notices.at(-1)?.text).toContain("The goal command failed")
  })

  test("an empty prompt is treated as a status request", async () => {
    await h.run("")
    expect(h.turns).toHaveLength(0)
  })

  test("the command is registered with a description", async () => {
    const { registerGoalCommand } = await import("../src/commands.ts")
    registerGoalCommand(h.deps)
    const registered = h.commands.find((command) => command.name === "goal")
    expect(registered).toBeDefined()
    expect(registered?.description).toContain("durable objective")
  })
})
