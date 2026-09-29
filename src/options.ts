/**
 * Plugin options.
 *
 * Everything here is defensive: `ctx.options` is a plain `Record<string, any>`
 * coming from user config, so nothing may be trusted. A bad value falls back to
 * its default instead of throwing, because a broken option must never take a
 * session down with it.
 */

export interface GoalOptions {
  /** Master switch. When false the plugin registers nothing. */
  readonly enabled: boolean
  /** Slash command name, without the leading slash. */
  readonly commandName: string
  /** Turns a goal may consume on its own before it stops for review. */
  readonly defaultMaxTurns: number
  /** Wall-clock ceiling for a goal, in minutes. */
  readonly defaultMaxMinutes: number
  /** Grace period before a continuation is dispatched on idle, in ms. Lets you interrupt. */
  readonly continuationDelayMs: number
  /** Pause the objective when a run is interrupted. */
  readonly pauseOnInterrupt: boolean
  /** Agents that may not drive a goal forward (read-only/plan agents). */
  readonly skipAgents: readonly string[]
  /** Inject the active goal contract into the system prompt of every model call. */
  readonly injectGoal: boolean
  /** Progress notes kept in the ledger. Older notes are dropped first. */
  readonly maxNotes: number
  /** Consecutive continuation turns without a single tool call before the goal is declared blocked. */
  readonly maxNoToolStreak: number
  /** Post a short transcript note when the goal pauses, hits its budget, or blocks. */
  readonly postLifecycleNotices: boolean
}

export const DEFAULT_OPTIONS: GoalOptions = {
  enabled: true,
  commandName: "goal",
  defaultMaxTurns: 25,
  defaultMaxMinutes: 180,
  continuationDelayMs: 750,
  pauseOnInterrupt: true,
  skipAgents: ["plan"],
  injectGoal: true,
  maxNotes: 40,
  maxNoToolStreak: 2,
  postLifecycleNotices: true,
}

const LIMITS = {
  defaultMaxTurns: [1, 10_000] as const,
  defaultMaxMinutes: [1, 60 * 24 * 30] as const,
  continuationDelayMs: [0, 10 * 60_000] as const,
  maxNotes: [1, 5_000] as const,
  maxNoToolStreak: [1, 100] as const,
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value
  if (value === "true") return true
  if (value === "false") return false
  return fallback
}

function int(value: unknown, range: readonly [number, number], fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  const rounded = Math.floor(parsed)
  if (rounded < range[0]) return fallback
  if (rounded > range[1]) return range[1]
  return rounded
}

function name(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback
  const trimmed = value.trim().replace(/^\/+/, "")
  if (!trimmed) return fallback
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(trimmed)) return fallback
  return trimmed.toLowerCase()
}

function list(value: unknown, fallback: readonly string[]): readonly string[] {
  if (Array.isArray(value)) {
    const cleaned = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0)
    return cleaned.length > 0 ? [...new Set(cleaned)] : fallback
  }
  if (typeof value === "string") {
    const cleaned = value
      .split(/[,\s]+/)
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0)
    return cleaned.length > 0 ? [...new Set(cleaned)] : fallback
  }
  return fallback
}

/** Normalizes raw plugin options into a complete, valid set. */
export function normalizeOptions(raw: unknown): GoalOptions {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  return {
    enabled: bool(input.enabled, DEFAULT_OPTIONS.enabled),
    commandName: name(input.commandName, DEFAULT_OPTIONS.commandName),
    defaultMaxTurns: int(input.defaultMaxTurns, LIMITS.defaultMaxTurns, DEFAULT_OPTIONS.defaultMaxTurns),
    defaultMaxMinutes: int(input.defaultMaxMinutes, LIMITS.defaultMaxMinutes, DEFAULT_OPTIONS.defaultMaxMinutes),
    continuationDelayMs: int(input.continuationDelayMs, LIMITS.continuationDelayMs, DEFAULT_OPTIONS.continuationDelayMs),
    pauseOnInterrupt: bool(input.pauseOnInterrupt, DEFAULT_OPTIONS.pauseOnInterrupt),
    skipAgents: list(input.skipAgents, DEFAULT_OPTIONS.skipAgents),
    injectGoal: bool(input.injectGoal, DEFAULT_OPTIONS.injectGoal),
    maxNotes: int(input.maxNotes, LIMITS.maxNotes, DEFAULT_OPTIONS.maxNotes),
    maxNoToolStreak: int(input.maxNoToolStreak, LIMITS.maxNoToolStreak, DEFAULT_OPTIONS.maxNoToolStreak),
    postLifecycleNotices: bool(input.postLifecycleNotices, DEFAULT_OPTIONS.postLifecycleNotices),
  }
}
