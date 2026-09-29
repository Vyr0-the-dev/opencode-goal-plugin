/**
 * The goal store.
 *
 * The regression here is a two-writer one, which is exactly the case no
 * single-instance test could see: a plugin reload or a second process leaves an
 * older instance holding a snapshot that a newer writer has already replaced.
 */

import { describe, expect, test } from "bun:test"
import { GoalStore } from "../src/store.ts"
import { createGoal, type Goal } from "../src/goal.ts"

const SES = "ses_store"
const T0 = 1_700_000_000_000

class Backing {
  readonly data = new Map<string, unknown>()
  failReads = false
  failWrites = false
  reads = 0

  get storage() {
    return {
      get: async (key: string) => {
        this.reads++
        if (this.failReads) throw new Error("storage unavailable")
        return this.data.get(key) as never
      },
      set: async (key: string, value: unknown) => {
        if (this.failWrites) throw new Error("disk full")
        this.data.set(key, value)
      },
      remove: async (key: string) => {
        this.data.delete(key)
      },
      scan: async (options: { prefix: string }) => ({
        entries: [...this.data.entries()]
          .filter(([key]) => key.startsWith(options.prefix))
          .map(([key, value]) => ({ key, value: value as never })),
      }),
    } as never
  }
}

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    ...createGoal({
      sessionID: SES,
      draft: { objective: "prove the store" },
      now: T0,
      defaults: { maxTurns: 4, maxMinutes: 60 },
      source: "command",
    }),
    ...overrides,
  }
}

describe("a second writer is visible to the first", () => {
  test("a store does not serve a snapshot that another instance replaced", async () => {
    const backing = new Backing()
    const older = new GoalStore(backing.storage)
    const newer = new GoalStore(backing.storage)

    await older.write(goal())
    expect((await older.read(SES))?.budget.usedTurns).toBe(0)

    // The newer instance spends a turn.
    const spent = goal({ budget: { maxTurns: 4, usedTurns: 1, startedAt: T0, maxMs: 3_600_000 } })
    await newer.write(spent)

    // The older one must not keep answering from its own memory.
    expect((await older.read(SES))?.budget.usedTurns).toBe(1)
  })

  test("reads actually go to storage rather than being served from memory", async () => {
    const backing = new Backing()
    const store = new GoalStore(backing.storage)
    await store.write(goal())
    const before = backing.reads
    await store.read(SES)
    await store.read(SES)
    expect(backing.reads).toBeGreaterThan(before)
  })

  test("a removed goal stops being reported rather than lingering in memory", async () => {
    const backing = new Backing()
    const store = new GoalStore(backing.storage)
    await store.write(goal())
    expect(await store.read(SES)).toBeDefined()
    await store.remove(SES)
    expect(await store.read(SES)).toBeUndefined()
  })
})

describe("the cache is only a fallback", () => {
  test("an unreadable store still answers from the last known value", async () => {
    const backing = new Backing()
    const store = new GoalStore(backing.storage)
    await store.write(goal())
    backing.failReads = true
    expect((await store.read(SES))?.objective).toBe("prove the store")
  })

  test("a failed write keeps the goal usable in memory", async () => {
    const backing = new Backing()
    const store = new GoalStore(backing.storage)
    backing.failWrites = true
    const written = await store.write(goal())
    expect(written.objective).toBe("prove the store")
    expect((await store.read(SES))?.objective).toBe("prove the store")
  })
})

describe("listing", () => {
  test("collects goals across sessions", async () => {
    const backing = new Backing()
    const store = new GoalStore(backing.storage)
    await store.write(goal())
    await store.write({ ...goal(), sessionID: "ses_other" })
    const all = await store.list()
    expect(all.map((g) => g.sessionID).sort()).toEqual(["ses_other", SES])
  })
})
