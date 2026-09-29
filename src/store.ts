/**
 * Durable, session-scoped goal storage.
 *
 * Goals live in the plugin's own storage, one record per session. Writes are
 * serialized per session so a continuation tick can never clobber a tool call
 * that landed at the same moment. Every storage failure is swallowed: a goal
 * that cannot be persisted must never take a session with it.
 */

import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { reviveGoal, type Goal } from "./goal.ts"

/** The plugin's storage takes plain JSON; a Goal is JSON by construction. */
type Json = Parameters<StorageDomain["set"]>[1]

function json(value: Goal): Json {
  return value as unknown as Json
}

const PREFIX = "goal/v1/session/"
const SCAN_LIMIT = 500

export class GoalStore {
  readonly #storage: StorageDomain
  readonly #cache = new Map<string, Goal>()
  readonly #locks = new Map<string, Promise<unknown>>()

  constructor(storage: StorageDomain) {
    this.#storage = storage
  }

  key(sessionID: string): string {
    return `${PREFIX}${sessionID}`
  }

  async read(sessionID: string): Promise<Goal | undefined> {
    const cached = this.#cache.get(sessionID)
    if (cached) return cached
    try {
      const raw = await this.#storage.get(this.key(sessionID))
      const goal = reviveGoal(raw)
      if (goal) this.#cache.set(sessionID, goal)
      return goal
    } catch {
      return undefined
    }
  }

  async write(goal: Goal): Promise<Goal> {
    this.#cache.set(goal.sessionID, goal)
    await this.#serialized(goal.sessionID, async () => {
      try {
        await this.#storage.set(this.key(goal.sessionID), json(goal))
      } catch {
        // Persistence is best-effort; the in-memory copy stays authoritative
        // for this process lifetime.
      }
    })
    return goal
  }

  /**
   * Read-modify-write under the session lock. Returning `undefined` from the
   * updater leaves storage untouched.
   */
  async update(sessionID: string, updater: (current: Goal | undefined) => Goal | undefined): Promise<Goal | undefined> {
    let result: Goal | undefined
    await this.#serialized(sessionID, async () => {
      const current = await this.read(sessionID)
      const next = updater(current)
      if (next === undefined) return
      result = next
      this.#cache.set(sessionID, next)
      try {
        await this.#storage.set(this.key(sessionID), json(next))
      } catch {
        // See write().
      }
    })
    return result
  }

  async remove(sessionID: string): Promise<void> {
    this.#cache.delete(sessionID)
    await this.#serialized(sessionID, async () => {
      try {
        await this.#storage.remove(this.key(sessionID))
      } catch {
        // Nothing to do — the cache is already clear.
      }
    })
  }

  /** Every stored goal, across sessions. Used by the RPC surface. */
  async list(): Promise<Goal[]> {
    const goals: Goal[] = []
    try {
      let cursor: string | undefined
      for (let page = 0; page < 20; page++) {
        const result = await this.#storage.scan(cursor ? { prefix: PREFIX, after: cursor, limit: SCAN_LIMIT } : { prefix: PREFIX, limit: SCAN_LIMIT })
        for (const entry of result.entries) {
          const sessionID = entry.key.slice(PREFIX.length)
          if (!sessionID) continue
          const cached = this.#cache.get(sessionID)
          if (cached) {
            goals.push(cached)
            continue
          }
          const goal = reviveGoal(entry.value)
          if (goal) {
            this.#cache.set(sessionID, goal)
            goals.push(goal)
          }
        }
        if (!result.next) break
        cursor = result.next
      }
    } catch {
      // Fall back to whatever the cache knows about.
      return [...this.#cache.values()]
    }
    return goals
  }

  /** Drops the cached copy so the next read comes from storage. */
  invalidate(sessionID?: string): void {
    if (sessionID) this.#cache.delete(sessionID)
    else this.#cache.clear()
  }

  #serialized<T>(sessionID: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(sessionID) ?? Promise.resolve()
    const next = previous.then(task, task)
    // Keep the chain alive but never let a rejection escape into the host.
    const tracked = next.catch(() => undefined)
    this.#locks.set(sessionID, tracked)
    void tracked.finally(() => {
      if (this.#locks.get(sessionID) === tracked) this.#locks.delete(sessionID)
    })
    return next
  }
}
