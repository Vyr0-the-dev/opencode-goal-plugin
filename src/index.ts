/**
 * opencode-goal-plugin
 *
 * Persistent, evidence-checked goals for OpenCode.
 *
 * A goal is durable, thread-scoped state: an objective, a completion contract, a
 * budget, and a progress ledger. While a goal is active its contract is injected
 * into every model call, and when a session goes idle with the finish line still
 * unmet the agent is woken again to audit its evidence and pick the next useful
 * action. The loop ends when the model declares the goal complete with cited
 * evidence, declares it blocked, the user pauses or clears it, the budget runs
 * out, or the agent stops making tool calls.
 *
 * The user drives it with `/goal`. The agent drives it with `goal_create`,
 * `goal_status`, and `goal_update`. Neither can reach another session's goal, and
 * a goal never widens the authority permissions already granted.
 */

import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin as GoalPluginDefinition } from "@opencode/plugin/promise/plugin"
import type { Context as PluginContext } from "@opencode/plugin/promise/plugin"
import { GoalEngine, GOAL_METADATA, type GoalPort, type GoalTurnOrigin } from "./engine.ts"
import { elapsedMs, progressPercent, remainingTurns, type Goal } from "./goal.ts"
import { GoalMirror } from "./mirror.ts"
import { normalizeOptions } from "./options.ts"
import { GoalRpc, isGoalAction } from "./rpc.ts"
import { goalSystemBlock } from "./prompts.ts"
import { registerGoalCommand } from "./commands.ts"
import { registerGoalTools } from "./tools.ts"

export const PLUGIN_ID = "opencode.goal"

interface Emitter {
  emit(sessionID: string, status: string, updatedAt: number): Promise<void>
}

/**
 * The plugin object.
 *
 * A plain object with `id` and `setup`, typed against the SDK rather than built
 * by `Plugin.define`. Every SDK import in this package is type-only, so nothing
 * here has to resolve `@opencode/plugin` at runtime and the package can be
 * dropped into any plugins directory with no installed dependencies.
 */
const goalPlugin = {
  id: PLUGIN_ID,
  async setup(ctx: PluginContext) {
    const options = normalizeOptions({ ...(await readFileOptions()), ...ctx.options })
    if (!options.enabled) return

    const emitter: Emitter = { emit: async () => undefined }
    const mirror = options.mirrorToSessionMetadata
      ? new GoalMirror({
          readMetadata: async (sessionID) => {
            const info = await ctx.session.get({ sessionID })
            const metadata = info?.metadata
            return metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : undefined
          },
          writeMetadata: async (sessionID, metadata) => {
            await ctx.session.update({ sessionID, metadata: metadata as Record<string, never> })
          },
          warn,
          now: () => Date.now(),
        })
      : undefined
    const engine = new GoalEngine(createPort(ctx, emitter, mirror), options)

    registerGoalTools({ tool: ctx.tool, session: ctx.session, engine, namespace: "goal" })
    registerGoalCommand({ host: { storage: ctx.storage, command: ctx.command, session: ctx.session }, engine, options })

    if (options.injectGoal) {
      const inject = async (event: { readonly sessionID: string; readonly system: unknown }): Promise<void> => {
        const goal = await engine.get(event.sessionID)
        if (!goal || goal.status === "cleared") return
        const system = event.system as Array<{ type?: string; text?: string }> | undefined
        if (!Array.isArray(system)) return
        // Never stack a second copy: a plugin reload must not double the block.
        if (system.some((part) => typeof part?.text === "string" && part.text.includes(ACTIVE_GOAL_MARKER))) return
        try {
          system.push({ type: "text", text: goalSystemBlock(goal) })
        } catch {
          // A host that changes the system shape must not break the request.
        }
      }

      await ctx.session.hook("context", (event) => void inject(event).catch(warn))
      await ctx.session.hook("compaction", (event) => void inject(event).catch(warn))
      await ctx.session.hook("generate", (event) => void inject(event).catch(warn))
    }

    // A human turn always wins. It clears the continuation bookkeeping so a
    // halted loop is not stuck, and the prompt hook runs before admission, so
    // this can never race the user's own turn.
    await ctx.session.hook("prompt", (event) => {
      if (readOrigin(event.metadata) === "continuation") return
      void engine.onUserPrompt(event.sessionID).catch(warn)
    })

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          dispatchEvent(engine, mirror, event as { type?: string; data?: unknown })
        }
      } catch (error) {
        if (!controller.signal.aborted) warn(error)
      }
    })()

    const registration = await ctx.rpc.register(GoalRpc, {
      get: async (input) => {
        const goal = await engine.get((input as { sessionID: string }).sessionID)
        return { goal: goal ? project(goal, Date.now()) : null }
      },
      list: async () => {
        const now = Date.now()
        const goals = await engine.store.list()
        return { goals: goals.filter((goal) => goal.status !== "cleared").map((goal) => project(goal, now)) }
      },
      act: async (input, call) => {
        const raw = input as { sessionID: string; action: string; turns?: number }
        if (!isGoalAction(raw.action)) {
          return call.error("unknown_action", `Unknown goal action: ${raw.action}`, { action: raw.action })
        }
        const result = await performAction(engine, raw.sessionID, raw.action, raw.turns)
        return { goal: result.goal ? project(result.goal, Date.now()) : null, message: result.message }
      },
    })

    emitter.emit = async (sessionID, status, updatedAt) => {
      try {
        await registration.events.emit("changed", { sessionID, status, updatedAt })
      } catch {
        // A subscriber going away is not a goal problem.
      }
    }

    return async () => {
      controller.abort()
      await registration.dispose().catch(() => undefined)
    }
  },
} satisfies GoalPluginDefinition

export default goalPlugin

const ACTIVE_GOAL_MARKER = "ACTIVE GOAL (opencode-goal-plugin)"

/**
 * Optional settings from a `goal.config.json` beside the plugin.
 *
 * This exists because the plugin is normally loaded by a one-line loader file
 * in `~/.config/opencode/plugins/`, and a bare loader file carries no `options`
 * from the host config. A file the user can edit is the least surprising place
 * for the budget and the continuation policy. Anything set in `opencode.json(c)`
 * under the plugin's `options` wins over this file.
 */
async function readFileOptions(): Promise<Record<string, unknown> | undefined> {
  let here: string
  try {
    here = dirname(fileURLToPath(import.meta.url))
  } catch {
    return undefined
  }
  // `src/` when bundled or run directly, the package root otherwise.
  for (const dir of [here, join(here, "..")]) {
    try {
      const text = await readFile(join(dir, "goal.config.json"), "utf8")
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // No file here, or it is unreadable or malformed: defaults apply.
    }
  }
  return undefined
}

function dispatchEvent(engine: GoalEngine, mirror: GoalMirror | undefined, event: { type?: string; data?: unknown }): void {
  const sessionID = readSessionID(event)
  if (!sessionID) return
  switch (event.type) {
    case "session.idle":
      void engine.onIdle(sessionID).catch(warn)
      return
    case "session.execution.interrupted":
      void engine.onInterrupted(sessionID).catch(warn)
      return
    case "session.deleted":
      mirror?.invalidate(sessionID)
      void engine.forget(sessionID).catch(warn)
      return
    case "session.tool.called":
    case "session.tool.success":
    case "session.tool.failed":
      engine.markToolCall(sessionID)
      return
    case "session.inbox.enqueued": {
      const data = event.data as { inboxID?: unknown; item?: unknown }
      const inboxID = typeof data.inboxID === "string" ? data.inboxID : undefined
      if (inboxID) engine.trackEnqueued(sessionID, inboxID, isOwnNotice(data.item))
      return
    }
    case "session.inbox.delivered":
    case "session.inbox.cancelled": {
      const inboxID = (event.data as { inboxID?: unknown }).inboxID
      if (typeof inboxID === "string") engine.trackSettled(sessionID, inboxID)
      return
    }
    default:
  }
}

async function performAction(
  engine: GoalEngine,
  sessionID: string,
  action: "status" | "pause" | "resume" | "clear" | "budget" | "continue-once",
  turns: number | undefined,
): Promise<{ goal: Goal | undefined; message: string }> {
  switch (action) {
    case "status": {
      const { goal, text } = await engine.report(sessionID, { history: true })
      return { goal, message: text }
    }
    case "pause":
      return engine.pause(sessionID, "paused from an external client")
    case "resume": {
      const result = await engine.resume(sessionID)
      if (result.goal?.status === "active" && remainingTurns(result.goal) > 0) await engine.onIdle(sessionID)
      return result
    }
    case "clear":
      return engine.clear(sessionID)
    case "budget":
      return engine.setBudget(sessionID, turns)
    case "continue-once": {
      await engine.onIdle(sessionID)
      const { goal, text } = await engine.report(sessionID)
      return { goal, message: text }
    }
    default:
      return { goal: undefined, message: "unsupported action" }
  }
}

/** Narrows the plugin context to exactly what the engine is allowed to touch. */
function createPort(ctx: PluginContext, emitter: Emitter, mirror: GoalMirror | undefined): GoalPort {
  return {
    storage: ctx.storage,

    async sessionInfo(sessionID) {
      const info = await ctx.session.get({ sessionID })
      return { agent: info?.agent }
    },

    async prompt(input) {
      await ctx.session.prompt({
        sessionID: input.sessionID,
        text: input.text,
        delivery: input.delivery,
        metadata: { [GOAL_METADATA]: input.origin },
      })
    },

    async note(input) {
      await ctx.session.synthetic({
        sessionID: input.sessionID,
        text: input.text,
        description: input.description,
        delivery: "queue",
        // Admitted to the transcript, but it must not schedule a model turn.
        resume: false,
        metadata: { [GOAL_METADATA]: "notice" },
      })
    },

    async changed(goal, sessionID) {
      // One call site, three channels: the plugin RPC event for clients that
      // speak it, the session's own metadata for clients that only read a
      // session list, and the transcript via lifecycle notices.
      if (mirror) await mirror.publish(sessionID, goal)
      await emitter.emit(sessionID, goal?.status ?? "cleared", goal?.updatedAt ?? Date.now())
    },

    warn,

    now: () => Date.now(),
  }
}

function project(goal: Goal, now: number) {
  return {
    id: goal.id,
    sessionID: goal.sessionID,
    title: goal.title,
    objective: goal.objective,
    verification: goal.verification,
    constraints: goal.constraints,
    boundaries: goal.boundaries,
    iteration: goal.iteration,
    blockedStop: goal.blockedStop,
    status: goal.status,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    maxTurns: goal.budget.maxTurns,
    usedTurns: goal.budget.usedTurns,
    remainingTurns: remainingTurns(goal),
    maxMs: goal.budget.maxMs,
    elapsedMs: elapsedMs(goal, now),
    progressPercent: progressPercent(goal),
    notes: goal.notes.map((note) => {
      const entry: Record<string, unknown> = { at: note.at, status: note.status }
      if (note.note) entry.note = note.note
      if (note.evidence) entry.evidence = note.evidence
      if (note.next) entry.next = note.next
      if (note.blocker) entry.blocker = note.blocker
      return entry
    }),
    ...(goal.summary ? { summary: goal.summary } : {}),
    ...(goal.evidence ? { evidence: goal.evidence } : {}),
    ...(goal.blocker ? { blocker: goal.blocker } : {}),
  }
}

function readOrigin(metadata: unknown): GoalTurnOrigin | undefined {
  if (!metadata || typeof metadata !== "object") return undefined
  const value = (metadata as Record<string, unknown>)[GOAL_METADATA]
  if (value === "continuation" || value === "activation" || value === "user") return value
  return undefined
}

function readSessionID(event: { type?: string; data?: unknown }): string | undefined {
  const data = event.data
  if (!data || typeof data !== "object") return undefined
  const sessionID = (data as { sessionID?: unknown }).sessionID
  return typeof sessionID === "string" && sessionID ? sessionID : undefined
}

/** Recognizes this plugin's own synthetic notices so they never look like queued work. */
function isOwnNotice(item: unknown): boolean {
  if (!item || typeof item !== "object") return false
  const payload = (item as { payload?: { metadata?: unknown } }).payload
  const metadata = payload?.metadata
  if (!metadata || typeof metadata !== "object") return false
  return (metadata as Record<string, unknown>)[GOAL_METADATA] === "notice"
}

function warn(error: unknown): void {
  console.error(`[opencode-goal] ${error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error"}`)
}

export { GoalRpc, GoalEngine, normalizeOptions }
export type { PluginContext }
