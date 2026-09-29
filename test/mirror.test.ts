/**
 * The mirror is the only part of this plugin that writes to a session, so these
 * tests are mostly about restraint: it must publish, and it must not touch
 * anything else or wake clients up for no reason.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import { GOAL_METADATA_KEY, GoalMirror, formatBadge, readSummary, summarize, type MirrorPort } from "../src/mirror.ts"
import { createGoal, type Goal } from "../src/goal.ts"

const T0 = 1_700_000_000_000
const SES = "ses_mirror"

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    ...createGoal({
      sessionID: SES,
      draft: { objective: "cut p95 below 120ms" },
      now: T0,
      defaults: { maxTurns: 4, maxMinutes: 60 },
      source: "command",
    }),
    ...overrides,
  }
}

class Harness {
  /** Metadata is per session in the real host, so the fake keeps it that way. */
  readonly bySession = new Map<string, Record<string, unknown>>()
  writes = 0
  reads = 0
  readFails = false
  writeFails = false
  /**
   * Reproduces OpenCode 2.0.16: the patch is accepted and the call resolves,
   * but nothing is applied. Set this to prove the mirror notices.
   */
  ignoresWrites = false
  warnings: string[] = []
  clock = T0 + 60_000

  constructor() {
    this.bySession.set(SES, { "other-plugin": { keep: true } })
  }

  get metadata(): Record<string, unknown> {
    return this.bySession.get(SES) ?? {}
  }

  set metadata(next: Record<string, unknown>) {
    this.bySession.set(SES, next)
  }

  readonly port: MirrorPort = {
    readMetadata: async (sessionID) => {
      this.reads++
      if (this.readFails) throw new Error("session vanished")
      return this.bySession.get(sessionID)
    },
    writeMetadata: async (sessionID, next) => {
      if (this.writeFails) throw new Error("disk full")
      this.writes++
      if (!this.ignoresWrites) this.bySession.set(sessionID, next)
    },
    warn: (message) => {
      this.warnings.push(message)
    },
    now: () => this.clock,
  }

  mirror(): GoalMirror {
    return new GoalMirror(this.port)
  }
}

let h: Harness

beforeEach(() => {
  h = new Harness()
})

describe("summarize", () => {
  test("carries everything a client needs for a badge", () => {
    const summary = summarize(goal(), T0 + 120_000)
    expect(summary).toMatchObject({
      title: "cut p95 below 120ms",
      status: "active",
      usedTurns: 0,
      maxTurns: 4,
      remainingTurns: 4,
      progressPercent: 0,
      elapsedMinutes: 2,
      maxMinutes: 60,
      blocked: false,
    })
  })

  test("is JSON-serializable, because it travels over the wire", () => {
    const encoded = JSON.stringify(summarize(goal(), T0))
    expect(JSON.parse(encoded)).toMatchObject({ status: "active" })
  })
})

describe("publish", () => {
  test("writes a summary under the plugin's own key", async () => {
    await h.mirror().publish(SES, goal())
    expect(h.writes).toBe(1)
    expect(readSummary(h.metadata)).toMatchObject({ status: "active", maxTurns: 4 })
  })

  test("never touches metadata it does not own", async () => {
    await h.mirror().publish(SES, goal())
    expect(h.metadata["other-plugin"]).toEqual({ keep: true })
  })

  test("tolerates a session that has no metadata yet", async () => {
    h.metadata = {}
    await h.mirror().publish(SES, goal())
    expect(readSummary(h.metadata)).toBeDefined()
  })

  test("does not rewrite identical state, so clients are not woken for nothing", async () => {
    const mirror = h.mirror()
    const g = goal()
    await mirror.publish(SES, g)
    await mirror.publish(SES, g)
    await mirror.publish(SES, { ...g })
    expect(h.writes).toBe(1)
    // Two reads for the first publish: merge, then verify.
    expect(h.reads).toBe(2)
  })

  test("writes again once the state actually moves", async () => {
    const mirror = h.mirror()
    await mirror.publish(SES, goal())
    await mirror.publish(SES, goal({ status: "paused" }))
    expect(h.writes).toBe(2)
  })

  test("removes the key when the goal is gone, keeping everything else", async () => {
    const mirror = h.mirror()
    await mirror.publish(SES, goal())
    await mirror.publish(SES, undefined)
    expect(GOAL_METADATA_KEY in h.metadata).toBe(false)
    expect(h.metadata["other-plugin"]).toEqual({ keep: true })
  })

  test("a cleared goal stops being advertised", async () => {
    const mirror = h.mirror()
    await mirror.publish(SES, goal({ status: "cleared" }))
    expect(GOAL_METADATA_KEY in h.metadata).toBe(false)
  })

  test("a completed or blocked goal is still advertised, because it matters", async () => {
    const mirror = h.mirror()
    await mirror.publish(SES, goal({ status: "complete" }))
    expect(readSummary(h.metadata)?.status).toBe("complete")
    await mirror.publish(SES, goal({ status: "blocked" }))
    expect(readSummary(h.metadata)).toMatchObject({ status: "blocked", blocked: true })
  })

  test("a failed read warns and does not throw", async () => {
    h.readFails = true
    await h.mirror().publish(SES, goal())
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toContain("could not publish")
  })

  test("a failed write is retried on the next change, not skipped forever", async () => {
    const mirror = h.mirror()
    h.writeFails = true
    await mirror.publish(SES, goal())
    expect(h.writes).toBe(0)

    h.writeFails = false
    await mirror.publish(SES, goal())
    expect(h.writes).toBe(1)
  })

  test("a host that silently drops the write is reported, not trusted", async () => {
    h.ignoresWrites = true
    const mirror = h.mirror()
    await mirror.publish(SES, goal())

    expect(h.writes).toBe(1)
    expect(GOAL_METADATA_KEY in h.metadata).toBe(false)
    expect(mirror.supported).toBe(false)
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toContain("does not apply it")
  })

  test("an unsupported host is not asked again, and is not warned about twice", async () => {
    h.ignoresWrites = true
    const mirror = h.mirror()
    await mirror.publish(SES, goal())
    await mirror.publish(SES, goal({ status: "paused" }))
    await mirror.publish(SES, undefined)
    expect(h.writes).toBe(1)
    expect(h.warnings).toHaveLength(1)
  })

  test("a supported host stays supported after a successful verified write", async () => {
    const mirror = h.mirror()
    await mirror.publish(SES, goal())
    expect(mirror.supported).toBe(true)
    expect(h.warnings).toHaveLength(0)
  })

  test("invalidate forces the next publish to re-read the session", async () => {
    const mirror = h.mirror()
    const g = goal()
    await mirror.publish(SES, g)
    mirror.invalidate(SES)
    await mirror.publish(SES, g)
    expect(h.writes).toBe(2)
  })

  test("sessions do not share state, and dedupe is per session", async () => {
    const mirror = h.mirror()
    await mirror.publish("ses_a", goal())
    await mirror.publish("ses_b", goal({ status: "paused" }))
    expect(h.writes).toBe(2)
    // A change in one session must not suppress a publish in another.
    await mirror.publish("ses_a", goal({ status: "paused" }))
    expect(h.writes).toBe(3)
    expect(readSummary(h.bySession.get("ses_a"))?.status).toBe("paused")
    expect(readSummary(h.bySession.get("ses_b"))?.status).toBe("paused")
    // Re-publishing an unchanged session is still a no-op.
    await mirror.publish("ses_b", goal({ status: "paused" }))
    expect(h.writes).toBe(3)
  })
})

describe("readSummary", () => {
  test("returns undefined for metadata that is not ours", () => {
    expect(readSummary(undefined)).toBeUndefined()
    expect(readSummary({})).toBeUndefined()
    expect(readSummary({ [GOAL_METADATA_KEY]: "nope" })).toBeUndefined()
    expect(readSummary({ [GOAL_METADATA_KEY]: { title: "x" } })).toBeUndefined()
    expect(readSummary({ [GOAL_METADATA_KEY]: { title: "x", status: "active" } })).toBeDefined()
  })
})

describe("formatBadge", () => {
  test("has a short label for every status", () => {
    const base = summarize(goal(), T0)
    for (const status of ["active", "paused", "complete", "blocked", "budget", "cleared"] as const) {
      const label = formatBadge({ ...base, status })
      expect(label.length).toBeGreaterThan(0)
      expect(label.length).toBeLessThanOrEqual(20)
    }
    expect(formatBadge({ ...base, status: "active", usedTurns: 3, maxTurns: 25 })).toBe("GOAL 3/25")
    expect(formatBadge({ ...base, status: "complete" })).toBe("GOAL DONE")
  })
})
