/**
 * What the TUI should do with a line the user typed at `/goal`.
 *
 * Kept separate from the TUI so the routing is unit-testable: the interactive
 * half has no DOM to test, but the decision does not need one.
 *
 * Why this exists. A server plugin has exactly one way to write into a
 * transcript — `session.synthetic` — and OpenCode 2.0.16 only delivers such a
 * message when it also schedules a turn. So a report posted with
 * `resume: false` is durable but *invisible* until some unrelated turn drains
 * the inbox. For `/goal status` that means the user types a command and nothing
 * happens at all, which is exactly what the lifecycle verbs are for. Answering
 * them has to happen in the client, where a dialog or a toast is rendered
 * immediately and costs nothing.
 *
 * Anything that changes the agent's work still goes to the server command; only
 * the read-only and lifecycle verbs are answered locally.
 */

export type LocalVerb = "status" | "history" | "help" | "pause" | "resume" | "clear"
export type LeadingVerb = "edit" | "draft" | "budget"

export type UiAction =
  | { readonly kind: "answer"; readonly verb: "status" | "history" | "help" }
  | { readonly kind: "act"; readonly action: "pause" | "resume" | "clear" | "budget"; readonly turns?: number }
  | { readonly kind: "submit"; readonly text: string }
  | { readonly kind: "refuse"; readonly reason: "no-session" }

/**
 * Lifecycle words that take no argument. They are matched against the *whole*
 * line, so an objective may begin with any of them.
 */
const WHOLE_LINE: Readonly<Record<string, LocalVerb>> = {
  status: "status",
  show: "status",
  info: "status",
  current: "status",
  view: "status",
  history: "history",
  log: "history",
  ledger: "history",
  notes: "history",
  help: "help",
  usage: "help",
  pause: "pause",
  stop: "pause",
  hold: "pause",
  resume: "resume",
  continue: "resume",
  restart: "resume",
  clear: "clear",
  reset: "clear",
  remove: "clear",
  delete: "clear",
  drop: "clear",
}

/** Verbs that legitimately take an argument, so they are read in leading position. */
const LEADING = new Set<string>(["set", "edit", "amend", "draft", "budget", "limit"])

/** Verbs the TUI answers with a dialog, and verbs it carries out itself. */
function planVerb(verb: LocalVerb): UiAction {
  switch (verb) {
    case "status":
    case "history":
    case "help":
      return { kind: "answer", verb }
    case "pause":
    case "resume":
    case "clear":
      return { kind: "act", action: verb }
  }
}

export function planGoalUiAction(input: { readonly text: string; readonly hasSession: boolean }): UiAction {
  if (!input.hasSession) return { kind: "refuse", reason: "no-session" }

  const text = input.text.trim()
  if (!text) return { kind: "answer", verb: "status" }

  const bare = text.toLowerCase()
  const whole = WHOLE_LINE[bare]
  if (whole) return planVerb(whole)

  const first = (text.split(/\s+/)[0] ?? "").toLowerCase()

  if (first === "budget" || first === "limit") {
    const rest = text.slice(first.length).trim()
    const turns = leadingCount(rest)
    if (turns !== undefined) return { kind: "act", action: "budget", turns }
    // A bare `/goal budget` is a request to set one; anything else after the
    // word is an objective, matching the server's rule.
    if (!rest) return { kind: "answer", verb: "help" }
  }

  if (LEADING.has(first)) return { kind: "submit", text }

  return { kind: "submit", text }
}

function leadingCount(rest: string): number | undefined {
  // No \b here: the token starts with a hyphen, so there is no word boundary at
  // the start of the string and \b would never match.
  const fromFlag = /(?:^|\s)--turns[=\s]+(\d+)/.exec(rest)
  if (fromFlag) return Number.parseInt(fromFlag[1]!, 10)
  const bare = /^(\d+)$/.exec(rest)
  if (bare) return Number.parseInt(bare[1]!, 10)
  return undefined
}
