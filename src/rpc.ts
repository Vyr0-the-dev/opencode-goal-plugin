/**
 * The goal RPC surface.
 *
 * The TUI cannot read the server plugin's storage, so the server publishes the
 * goal state here and pushes a `changed` event whenever it moves. The same
 * methods let any other client or plugin read and steer a goal over HTTP
 * without knowing how it is stored.
 */

import type { Rpc } from "@opencode/plugin"
import type { GoalStatus } from "./goal.ts"

const goalSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    sessionID: { type: "string" },
    title: { type: "string" },
    objective: { type: "string" },
    verification: { type: "string" },
    constraints: { type: "string" },
    boundaries: { type: "string" },
    iteration: { type: "string" },
    blockedStop: { type: "string" },
    status: { type: "string" },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
    maxTurns: { type: "number" },
    usedTurns: { type: "number" },
    remainingTurns: { type: "number" },
    maxMs: { type: "number" },
    elapsedMs: { type: "number" },
    progressPercent: { type: "number" },
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          at: { type: "number" },
          status: { type: "string" },
          note: { type: "string" },
          evidence: { type: "string" },
          next: { type: "string" },
          blocker: { type: "string" },
        },
        required: ["at", "status"],
        additionalProperties: false,
      },
    },
    summary: { type: "string" },
    evidence: { type: "string" },
    blocker: { type: "string" },
  },
  required: [
    "id",
    "sessionID",
    "title",
    "objective",
    "verification",
    "constraints",
    "boundaries",
    "iteration",
    "blockedStop",
    "status",
    "createdAt",
    "updatedAt",
    "maxTurns",
    "usedTurns",
    "remainingTurns",
    "maxMs",
    "elapsedMs",
    "progressPercent",
    "notes",
  ],
  additionalProperties: false,
} as const

const nullableGoal = {
  anyOf: [{ type: "null" }, goalSchema],
} as const

const actions = ["status", "pause", "resume", "clear", "budget", "continue-once"] as const

/**
 * Who is steering the goal.
 *
 * The TUI and every other client share one RPC surface, so without this the
 * server cannot tell the user's own keypress from a request arriving over HTTP
 * from a web or IDE client. `external` is the default because a caller that
 * does not say who it is is, for the ledger's purposes, not the local TUI.
 */
const origins = ["tui", "external"] as const

/**
 * The RPC definition, written as a plain object rather than a `Rpc.define(...)`
 * call.
 *
 * `Rpc.define` is an identity helper, and importing it would mean importing
 * `@opencode/plugin` at runtime. Plugin modules are loaded straight from their
 * own directory, so a runtime import of the SDK is not always resolvable —
 * and a type-only import is erased, which is what makes this package loadable
 * from any location with no installed dependencies. TypeScript still checks
 * the shape against `Rpc.PortableDefinition` at build time.
 */
export const GoalRpc = {
  id: "goal",
  methods: {
    get: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { goal: nullableGoal },
        required: ["goal"],
        additionalProperties: false,
      },
    },
    list: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: { goals: { type: "array", items: goalSchema } },
        required: ["goals"],
        additionalProperties: false,
      },
    },
    act: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          action: { type: "string", enum: [...actions] },
          turns: { type: "number" },
          origin: { type: "string", enum: [...origins] },
        },
        required: ["sessionID", "action"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { goal: nullableGoal, message: { type: "string" } },
        required: ["goal", "message"],
        additionalProperties: false,
      },
      errors: {
        unknown_action: {
          type: "object",
          properties: { action: { type: "string" } },
          required: ["action"],
          additionalProperties: false,
        },
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          status: { type: "string" },
          updatedAt: { type: "number" },
        },
        required: ["sessionID", "status", "updatedAt"],
        additionalProperties: false,
      },
    },
  },
} as const satisfies Rpc.PortableDefinition

export type GoalAction = (typeof actions)[number]

export function isGoalAction(value: unknown): value is GoalAction {
  return typeof value === "string" && (actions as readonly string[]).includes(value)
}

export type GoalOrigin = (typeof origins)[number]

export function isGoalOrigin(value: unknown): value is GoalOrigin {
  return typeof value === "string" && (origins as readonly string[]).includes(value)
}

/**
 * The ledger note for a pause.
 *
 * The ledger is the audit trail, so it has to name who acted. "An external
 * client" was technically true of the TUI's own keypress and useless to anyone
 * reading the history later, which is the only reason the note exists.
 */
export function pauseReason(origin: GoalOrigin = "external"): string {
  return origin === "tui" ? "paused from the TUI" : "paused from an external client"
}

export const GOAL_STATUS_VALUES: readonly GoalStatus[] = ["active", "paused", "complete", "blocked", "budget", "cleared"]
