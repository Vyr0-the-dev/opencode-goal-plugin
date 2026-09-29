/**
 * The `/goal` slash command.
 *
 * Lifecycle verbs are answered with a synthetic message carrying `resume: false`,
 * so `/goal status` and `/goal pause` are recorded in the transcript but never
 * wake the model. Only `set`, `edit`, and `draft` submit a real turn, because
 * those are the ones that change what the agent is being asked to do.
 */

import type { CommandDomain } from "@opencode/plugin/promise/command"
import type { SessionDomain } from "@opencode/plugin/promise/session"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { GOAL_METADATA, type GoalEngine, type GoalTurnOrigin } from "./engine.ts"
import { NO_GOAL_REPORT } from "./format.ts"
import { normalizeOptions, type GoalOptions } from "./options.ts"
import { HELP_TEXT, draftFromParsed, parseGoalCommand, type ParsedCommand } from "./parse.ts"
import { activationPrompt, draftPrompt } from "./prompts.ts"
import type { Goal } from "./goal.ts"

export interface CommandHost {
  readonly storage: StorageDomain
  readonly command: CommandDomain
  readonly session: SessionDomain
}

export interface CommandDeps {
  readonly host: CommandHost
  readonly engine: GoalEngine
  readonly options: GoalOptions
}

interface Invocation {
  readonly sessionID: string
  readonly prompt: { readonly text: string }
  readonly delivery: "steer" | "queue"
}

export function registerGoalCommand(deps: CommandDeps): void {
  const { host, options } = deps
  void host.command.transform((editor) => {
    editor.add({
      name: options.commandName,
      description:
        "Work autonomously toward one durable objective until the evidence says it is done. `/goal <outcome>` starts it; bare `/goal` shows the current one.",
      execute: async (invocation) => {
        await runGoalCommand(deps, invocation)
      },
    })
  })
}

export async function runGoalCommand(deps: CommandDeps, invocation: Invocation): Promise<void> {
  const { host, engine, options } = deps
  const sessionID = invocation.sessionID
  const raw = typeof invocation.prompt?.text === "string" ? invocation.prompt.text : ""
  const parsed = parseGoalCommand(raw, options.commandName)

  try {
    switch (parsed.kind) {
      case "help":
        return report(deps, sessionID, HELP_TEXT)

      case "status": {
        const { text } = await engine.report(sessionID)
        return report(deps, sessionID, text)
      }

      case "history": {
        const { text } = await engine.history(sessionID)
        return report(deps, sessionID, text)
      }

      case "pause": {
        const result = await engine.pause(sessionID)
        return report(deps, sessionID, result.message)
      }

      case "resume": {
        const result = await engine.resume(sessionID)
        await report(deps, sessionID, result.message)
        if (result.goal?.status === "active" && remainingTurnsOf(result.goal) > 0) {
          // Re-arm the loop immediately instead of waiting for the next idle
          // marker, which may be far away.
          await engine.onIdle(sessionID)
        }
        return
      }

      case "clear": {
        const result = await engine.clear(sessionID)
        return report(deps, sessionID, result.message)
      }

      case "budget": {
        const result = await engine.setBudget(sessionID, parsed.value)
        return report(deps, sessionID, result.message)
      }

      case "draft": {
        if (!parsed.remainder) {
          return report(deps, sessionID, "`/goal draft` needs a subject, e.g. `/goal draft migrate this repo off the legacy build`.")
        }
        return submit(host, sessionID, draftPrompt(parsed.remainder), "user")
      }

      case "edit": {
        if (!parsed.remainder) {
          return report(deps, sessionID, "`/goal edit` needs the new objective text, e.g. `/goal edit narrow it to the parser only`.")
        }
        const result = await engine.edit(sessionID, parsed.remainder)
        await report(deps, sessionID, result.message)
        if (result.prompt) return submit(host, sessionID, result.prompt.text, result.prompt.origin)
        return
      }

      case "set":
        return startGoal(deps, sessionID, parsed)

      default:
        return report(deps, sessionID, NO_GOAL_REPORT)
    }
  } catch (error) {
    await report(deps, sessionID, `The goal command failed: ${describe(error)}\n\nNothing was changed and the session is unaffected.`)
  }
}

async function startGoal(deps: CommandDeps, sessionID: string, parsed: Extract<ParsedCommand, { kind: "set" }>): Promise<void> {
  const { host, engine } = deps

  if (!parsed.remainder) {
    // Bare `/goal` shows the goal and its ledger instead of starting one.
    const { text } = await engine.report(sessionID, { history: true })
    await report(deps, sessionID, text)
    return
  }

  const previous = await engine.get(sessionID)
  const result = await engine.activate(sessionID, {
    ...draftFromParsed(parsed, previous),
    start: false,
    autoContinue: parsed.flags.noAutostartContinuation !== true,
  })

  const goal = result.goal
  if (!goal) {
    await report(deps, sessionID, NO_GOAL_REPORT)
    return
  }

  const summary = result.message
  if (parsed.flags.noAutostart === true) {
    await report(
      deps,
      sessionID,
      `${summary}\n\nInstalled without starting a turn. Run \`/goal resume\` when you want the agent to begin.`,
    )
    return
  }

  const headline = [
    summary,
    "",
    "The contract above is now active for this session. It is injected into every model call, so",
    `it survives compaction. Budget: ${goal.budget.maxTurns} automatic turns, ${Math.round(goal.budget.maxMs / 60_000)} minutes.`,
    "It keeps going on its own until the finish line is met, you pause it, or the budget runs out.",
    "",
  ].join("\n")

  // One real turn, carrying the objective. The report stays synthetic so it costs
  // nothing and the transcript shows exactly what was installed.
  await report(deps, sessionID, headline)
  await submit(host, sessionID, activationPrompt(goal), "activation")
}

function remainingTurnsOf(goal: Goal): number {
  return Math.max(0, goal.budget.maxTurns - goal.budget.usedTurns)
}

/** Records a message in the transcript without scheduling a model turn. */
async function report(deps: CommandDeps, sessionID: string, text: string): Promise<void> {
  try {
    await deps.host.session.synthetic({
      sessionID,
      text,
      description: "goal",
      delivery: "queue",
      resume: false,
      metadata: { [GOAL_METADATA]: "notice" },
    })
  } catch (error) {
    console.error(`[opencode-goal] ${describe(error)}`)
  }
}

async function submit(host: CommandHost, sessionID: string, text: string, origin: GoalTurnOrigin): Promise<void> {
  try {
    await host.session.prompt({
      sessionID,
      text,
      delivery: "queue",
      metadata: { [GOAL_METADATA]: origin },
    })
  } catch (error) {
    console.error(`[opencode-goal] could not submit the ${origin} turn — ${describe(error)}`)
  }
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

export { normalizeOptions, draftFromParsed, parseGoalCommand, activationPrompt, draftPrompt }
export type { GoalOptions }
