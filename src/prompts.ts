/**
 * Prompt construction.
 *
 * The contract is re-stated to the model on every call, because the model does
 * not remember anything between calls and a goal must survive compaction. Every
 * string here is written so that a model reading it for the first time behaves
 * the way the feature promises: keep working, verify against evidence, and stop
 * for a reason.
 */

import { remainingTurns, type Goal } from "./goal.ts"

const HEADER = "ACTIVE GOAL (opencode-goal-plugin)"

function field(label: string, value: string): string {
  return value ? `- ${label}: ${value}` : ""
}

/** The goal contract injected into the system prompt of every model call. */
export function goalSystemBlock(goal: Goal): string {
  const lines = [
    HEADER,
    "",
    "This session has a durable goal. Keep it in view across every step, including after",
    "context compaction. A normal prompt asks for one result; a goal asks you to keep",
    "working until the finish line below is actually met.",
    "",
    `Status: ${goal.status}`,
    `Title: ${goal.title}`,
    "",
    "Completion contract:",
    `- Outcome: ${goal.objective}`,
    field("Verified by", goal.verification),
    field("Must not regress", goal.constraints),
    field("In scope", goal.boundaries),
    field("Between iterations", goal.iteration),
    field("Stop and report when", goal.blockedStop),
    "",
    "Rules:",
    "1. Audit the objective against concrete evidence — files changed, commands run,",
    "   tests passed, benchmark output, generated artifacts — before you consider it done.",
    "2. Do not mark the goal complete because it feels finished. Complete it only through",
    "   `goal_update` with `status: \"complete\"`, a summary, and the evidence you checked.",
    "3. Do not mark the goal blocked while a defensible path remains. Mark it blocked only",
    "   through `goal_update` with the blocker and the input that would unblock it.",
    "4. Record each iteration with `goal_update` using `status: \"working\"` so progress is",
    "   auditable and survives compaction.",
    "5. The goal does not widen your authority. Permissions, approvals, deploy rights, and",
    "   network policy still apply. A durable objective is not authorization.",
    "6. Prefer a measured next experiment over a blind retry. If the same approach has",
    "   failed twice, change approach or report the blocker.",
    "",
    `Budget: ${remainingTurns(goal)} of ${goal.budget.maxTurns} automatic turns remaining.`,
    "Running out of budget stops the loop for review; it does not mean the goal is done.",
    "",
    `Controls (user-owned): /goal pause · /goal resume · /goal clear · /goal status.`,
  ]
  const blocked = goal.blocker ? ["", `Last recorded blocker: ${goal.blocker}`] : []
  return [...lines, ...blocked].join("\n")
}

/** The turn that starts work on a newly activated goal. */
export function activationPrompt(goal: Goal): string {
  return [
    "A goal is now active for this session. Start working on it now.",
    "",
    `Outcome: ${goal.objective}`,
    goal.verification ? `Verified by: ${goal.verification}` : "",
    goal.constraints ? `Must not regress: ${goal.constraints}` : "",
    goal.boundaries ? `In scope: ${goal.boundaries}` : "",
    goal.iteration ? `Between iterations: ${goal.iteration}` : "",
    goal.blockedStop ? `Stop and report when: ${goal.blockedStop}` : "",
    "",
    `Budget: ${goal.budget.maxTurns} automatic turns, ${goal.budget.maxMs / 60_000} minutes.`,
    "",
    "Begin with the smallest useful step, verify it against the evidence named above, and",
    "keep going. Record each iteration with `goal_update` using `status: \"working\"`. When",
    "the finish line is met, call `goal_update` with `status: \"complete\"` and the evidence.",
    "If no defensible path remains, call `goal_update` with `status: \"blocked\"` and say what",
    "input would unblock it.",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

/** The automatic turn that wakes the agent to audit and continue. */
export function continuationPrompt(goal: Goal, turn: number): string {
  const remaining = remainingTurns(goal)
  const last = goal.notes.length > 0 ? goal.notes[goal.notes.length - 1] : undefined
  return [
    `GOAL CONTINUATION ${turn}/${goal.budget.maxTurns} — no user input is waiting.`,
    "",
    `Outcome: ${goal.objective}`,
    goal.verification ? `Verified by: ${goal.verification}` : "",
    goal.constraints ? `Must not regress: ${goal.constraints}` : "",
    goal.boundaries ? `In scope: ${goal.boundaries}` : "",
    goal.blockedStop ? `Stop and report when: ${goal.blockedStop}` : "",
    "",
    last?.next ? `Your own last stated next step: ${last.next}` : "",
    last?.evidence ? `Evidence you last recorded: ${last.evidence}` : "",
    "",
    "Before doing anything else, audit the outcome against real evidence from the work so",
    "far. Then choose the single most useful next action and take it. This is a real turn:",
    "use tools, do the work, and verify. Do not merely restate the plan.",
    "",
    `- If the finish line is met, call \`goal_update\` with \`status: \"complete\"\`, a summary, and the evidence.`,
    `- If no defensible path remains, call \`goal_update\` with \`status: \"blocked\"\`, the blocker, and the input that would unblock it.`,
    `- Otherwise call \`goal_update\` with \`status: \"working\"\` and the next step, then act on it.`,
    "",
    `${remaining} automatic turn${remaining === 1 ? "" : "s"} left after this one.`,
    "The user can stop this at any time with `/goal pause` or by interrupting.",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

/** The turn that asks the model to author a strong goal contract, not to run it. */
export function draftPrompt(subject: string): string {
  return [
    "Turn this into a strong goal. Do not start the work and do not call any goal tool —",
    "return the finished contract as text, ready to paste after `/goal`.",
    "",
    `Subject: ${subject}`,
    "",
    "Write one paragraph that states, in this order:",
    "1. Outcome — what must be true when the work is done, concretely enough to check.",
    "2. Verification surface — the specific test, benchmark, command, or artifact that proves it.",
    "3. Constraints — what must not regress while working.",
    "4. Boundaries — which files, tools, data, or systems are in scope.",
    "5. Iteration policy — how to choose the next action after each attempt.",
    "6. Blocked stop condition — when to stop and report instead of continuing.",
    "",
    "Keep the subject's intent. Fill gaps with the most defensible reading, mark any",
    "assumption you had to make, and do not invent success criteria the user did not imply.",
    "End with a suggested turn budget, e.g. `--turns 12`, if the work looks bounded.",
  ].join("\n")
}
