/**
 * The universal goal mirror.
 *
 * A goal has to be visible in clients that know nothing about this plugin: the
 * web app, the desktop app, an IDE extension, an ACP client, a phone. They all
 * render sessions, and every session carries a free-form, durable `metadata` map
 * that core treats as opaque. Mirroring a compact summary there means a client
 * that never heard of this plugin could still show the goal, the status, and the
 * remaining budget.
 *
 * Two rules matter more than the format:
 *
 * - Other keys are never touched. Metadata belongs to whoever wrote it.
 * - Identical state is not rewritten. Every write is durable and emits
 *   `session.metadata.updated`, so re-publishing the same summary would wake up
 *   every subscribed client for nothing.
 *
 * And one rule matters more than both:
 *
 * - The write is verified. OpenCode 2.0.16 accepts a `metadata` patch over HTTP
 *   but silently drops the same patch through the plugin API, resolving
 *   successfully either way. A mirror that trusted that would claim to have
 *   published a goal nobody can see. So every write is read back, and if the
 *   host has not honoured it, the mirror says so once and stops trying instead
 *   of quietly pretending.
 *
 * This channel is an enhancement, never a dependency. The transcript and the
 * plugin RPC carry the same state and work everywhere.
 */

import type { Goal } from "./goal.ts"
import { elapsedMs, progressPercent, remainingTurns } from "./goal.ts"

/** The metadata key this plugin owns. */
export const GOAL_METADATA_KEY = "opencode-goal"

export interface GoalSummary {
  readonly title: string
  readonly status: Goal["status"]
  readonly progressPercent: number
  readonly usedTurns: number
  readonly maxTurns: number
  readonly remainingTurns: number
  readonly elapsedMinutes: number
  readonly maxMinutes: number
  readonly updatedAt: number
  readonly blocked: boolean
}

export function summarize(goal: Goal, now: number): GoalSummary {
  return {
    title: goal.title,
    status: goal.status,
    progressPercent: progressPercent(goal),
    usedTurns: goal.budget.usedTurns,
    maxTurns: goal.budget.maxTurns,
    remainingTurns: remainingTurns(goal),
    elapsedMinutes: Math.round(elapsedMs(goal, now) / 60_000),
    maxMinutes: Math.round(goal.budget.maxMs / 60_000),
    updatedAt: goal.updatedAt,
    blocked: goal.status === "blocked",
  }
}

export interface MirrorPort {
  readMetadata(sessionID: string): Promise<Record<string, unknown> | undefined>
  writeMetadata(sessionID: string, metadata: Record<string, unknown>): Promise<void>
  warn(message: string): void
  now(): number
}

export class GoalMirror {
  readonly #port: MirrorPort
  /** Last value we wrote per session, so an unchanged state is a no-op. */
  readonly #last = new Map<string, string>()
  /** Set once the host has been shown to ignore metadata writes. */
  #unsupported = false

  constructor(port: MirrorPort) {
    this.#port = port
  }

  /** True when this host honours the metadata channel. */
  get supported(): boolean {
    return !this.#unsupported
  }

  /**
   * Publishes the current goal, or clears the mirror when there is nothing left
   * worth showing. Never throws: a client that cannot see the goal is a
   * degraded view, not a broken session.
   */
  async publish(sessionID: string, goal: Goal | undefined): Promise<void> {
    if (this.#unsupported) return

    const hidden = goal === undefined || goal.status === "cleared"
    const next = hidden ? undefined : summarize(goal, this.#port.now())
    const encoded = next === undefined ? "" : JSON.stringify(next)

    if (this.#last.get(sessionID) === encoded) return
    // Record the intent before the write so a failed write is retried on the
    // next change rather than silently skipped forever.
    this.#last.set(sessionID, encoded)

    let before: Record<string, unknown> | undefined
    try {
      before = await this.#port.readMetadata(sessionID)
      const merged = { ...(before ?? {}) }
      if (next === undefined) delete merged[GOAL_METADATA_KEY]
      else merged[GOAL_METADATA_KEY] = next
      if (before === undefined && next === undefined) return
      await this.#port.writeMetadata(sessionID, merged)
    } catch (error) {
      this.#last.delete(sessionID)
      this.#port.warn(`goal: could not publish the session summary — ${describe(error)}`)
      return
    }

    // Verify. A host that resolves the write without applying it must not be
    // allowed to leave the user believing a goal is visible where it is not.
    try {
      const after = await this.#port.readMetadata(sessionID)
      const landed = next === undefined ? after?.[GOAL_METADATA_KEY] === undefined : isSameSummary(after?.[GOAL_METADATA_KEY], next)
      if (!landed) {
        this.#unsupported = true
        this.#last.clear()
        this.#port.warn(
          "goal: this OpenCode version accepts a session metadata patch but does not apply it " +
            "(observed on 2.0.16), so the goal cannot be shown in clients that only read session metadata. " +
            "The transcript and the goal RPC are unaffected. Set \"mirrorToSessionMetadata\": false to silence this.",
        )
      }
    } catch {
      // Verification is best-effort; the write itself already succeeded.
    }
  }

  /** Forgets cached state so the next publish re-reads the session. */
  invalidate(sessionID: string): void {
    this.#last.delete(sessionID)
  }
}

function isSameSummary(value: unknown, expected: GoalSummary): boolean {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return record.status === expected.status && record.updatedAt === expected.updatedAt && record.usedTurns === expected.usedTurns
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

/** Reads a summary back out of arbitrary session metadata. */
export function readSummary(metadata: Record<string, unknown> | undefined): GoalSummary | undefined {
  const value = metadata?.[GOAL_METADATA_KEY]
  if (!value || typeof value !== "object") return undefined
  const summary = value as Record<string, unknown>
  if (typeof summary.status !== "string" || typeof summary.title !== "string") return undefined
  return summary as unknown as GoalSummary
}

/** One-line form for a client that only has room for a badge. */
export function formatBadge(summary: GoalSummary): string {
  switch (summary.status) {
    case "active":
      return `GOAL ${summary.usedTurns}/${summary.maxTurns}`
    case "complete":
      return "GOAL DONE"
    case "blocked":
      return "GOAL BLOCKED"
    case "budget":
      return "GOAL BUDGET"
    case "paused":
      return "GOAL PAUSED"
    default:
      return "GOAL"
  }
}
