/**
 * The model-facing goal tools.
 *
 * These are how OpenCode itself drives a goal. They are deliberately narrow:
 * the model may start a goal, report progress, and declare `complete` or
 * `blocked` — nothing else. Pausing, resuming, editing, and clearing stay with
 * the user, because a goal that the model can quietly cancel is not a contract.
 *
 * Every tool is scoped to the session that called it, so a subagent or a
 * parallel session can never reach across and touch another thread's goal.
 */

import type { ToolDomain } from "@opencode/plugin/promise/tool"
import type { SessionDomain } from "@opencode/plugin/promise/session"
import { GOAL_METADATA, type GoalEngine } from "./engine.ts"
import { remainingTurns, type Goal } from "./goal.ts"

export interface ToolDeps {
  readonly tool: ToolDomain
  readonly session: SessionDomain
  readonly engine: GoalEngine
  readonly namespace: string
}

const JSON_OBJECT = { type: "object" } as const

export function registerGoalTools(deps: ToolDeps): void {
  const { tool, engine, namespace } = deps

  void tool.transform((editor) => {
    editor.namespace({
      name: namespace,
      description:
        "Durable goals for this session. Use these to start a persistent objective, record each iteration, and declare completion or a blocker against real evidence.",
    })

    editor.add({
      name: "create",
      options: { namespace },
      description: [
        "Start a persistent goal for the current session. The objective becomes both the task and",
        "the finish line: keep working until it is verifiably true, or until no defensible path",
        "remains. Calling this again replaces the current goal.",
        "",
        "A strong goal states six things. Fill in what you can and leave the rest blank rather than",
        "inventing criteria the user did not ask for.",
        "  objective      (required) what must be true when the work is done",
        "  verification   the test, benchmark, command, or artifact that proves it",
        "  constraints    what must not regress while working",
        "  boundaries     which files, tools, or data are in scope",
        "  iteration      how to choose the next action after each attempt",
        "  blockedStop    when to stop and report instead of continuing",
        "",
        "Do not use this for a one-line edit, a question, or a review. Use it when the correct next",
        "step depends on what you learn along the way.",
      ].join("\n"),
      input: {
        ...JSON_OBJECT,
        properties: {
          objective: {
            type: "string",
            description: "What must be true when the work is done. Concrete enough to check.",
          },
          verification: {
            type: "string",
            description: "The evidence that proves the outcome: a test command, benchmark, or artifact.",
          },
          constraints: { type: "string", description: "What must not regress while working." },
          boundaries: { type: "string", description: "Files, tools, data, or systems in scope." },
          iteration: { type: "string", description: "How to pick the next action after each attempt." },
          blockedStop: { type: "string", description: "When to stop and report instead of continuing." },
          maxTurns: { type: "number", description: "Automatic turns the goal may use. Defaults to the configured budget." },
          maxMinutes: { type: "number", description: "Wall-clock ceiling in minutes. Defaults to the configured budget." },
        },
        required: ["objective"],
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const parsed = asRecord(input)
        const objective = str(parsed.objective)
        if (!objective) {
          return text("A goal needs an objective. Describe what must be true when the work is done.")
        }
        const result = await engine.activate(context.sessionID, {
          objective,
          verification: optStr(parsed.verification),
          constraints: optStr(parsed.constraints),
          boundaries: optStr(parsed.boundaries),
          iteration: optStr(parsed.iteration),
          blockedStop: optStr(parsed.blockedStop),
          maxTurns: num(parsed.maxTurns),
          maxMinutes: num(parsed.maxMinutes),
          start: false,
        })
        if (!result.goal) return text(result.message)
        void context.progress({ phase: "goal", status: "active", title: result.goal.title })
        return text(`${result.message}\n\nThe goal is active. Begin with the smallest useful step.`)
      },
    })

    editor.add({
      name: "status",
      options: { namespace },
      description:
        "Read the current session's goal, its completion contract, its budget, and the last few ledger entries. Read-only.",
      input: { ...JSON_OBJECT, properties: {}, additionalProperties: false },
      execute: async (_input, context) => {
        const { goal, text: report } = await engine.report(context.sessionID, { history: true })
        return text(report, { goalID: goal?.id })
      },
    })

    editor.add({
      name: "update",
      options: { namespace },
      description: [
        "Report progress on, or finish, the current session's goal. Call it at least once per",
        "iteration so the ledger survives compaction and the user can audit the work.",
        "",
        "status:",
        '  "working"  (default) record an iteration. Give `next` so the next turn has a starting point.',
        '  "complete" the finish line is met. REQUIRES `summary` and the `evidence` you checked.',
        '  "blocked"  no defensible path remains. REQUIRES `blocker` and what would unblock it.',
        "",
        "Rules:",
        "- `complete` is a claim about evidence, not about confidence. If the verification surface has",
        "  not actually been run, the goal is not complete.",
        "- `blocked` means no path remains, not that this attempt failed. Try a different approach first.",
        "- You cannot pause, resume, edit, or clear a goal. Those belong to the user: `/goal`.",
      ].join("\n"),
      input: {
        ...JSON_OBJECT,
        properties: {
          status: {
            type: "string",
            enum: ["working", "complete", "blocked"],
            description: "What to record. Defaults to \"working\".",
          },
          note: { type: "string", description: "What this iteration did." },
          evidence: { type: "string", description: "The concrete evidence checked: command output, test result, benchmark number." },
          next: { type: "string", description: "The next action to take." },
          summary: { type: "string", description: "For \"complete\": what is now true." },
          blocker: { type: "string", description: "For \"blocked\": what is stopping progress." },
        },
        required: [],
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const parsed = asRecord(input)
        const status = str(parsed.status) || "working"
        if (status === "complete") {
          const result = await engine.recordComplete(context.sessionID, {
            summary: optStr(parsed.summary),
            evidence: optStr(parsed.evidence),
          })
          void context.progress({ phase: "goal", status: result.goal?.status ?? "complete" })
          return text(result.message)
        }
        if (status === "blocked") {
          const result = await engine.recordBlocked(context.sessionID, {
            blocker: optStr(parsed.blocker),
            next: optStr(parsed.next),
            summary: optStr(parsed.summary),
          })
          void context.progress({ phase: "goal", status: result.goal?.status ?? "blocked" })
          return text(result.message)
        }
        const result = await engine.recordWorking(context.sessionID, {
          note: optStr(parsed.note),
          evidence: optStr(parsed.evidence),
          next: optStr(parsed.next),
        })
        return text(result.message)
      },
    })
  })
}

function text(content: string, metadata?: Record<string, unknown>) {
  return metadata ? { content, metadata } : { content }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function optStr(value: unknown): string | undefined {
  const trimmed = str(value)
  return trimmed ? trimmed : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export { remainingTurns, GOAL_METADATA }
export type { Goal }
