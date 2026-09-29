/**
 * `/goal` argument parsing.
 *
 * The hard problem here is that almost every word is also a plausible start of
 * an objective. `/goal stop the flakiness in ci` is a goal, not a request to
 * pause; `/goal reset the database` is a goal, not a request to clear. So a
 * lifecycle verb is only recognised when it is the *entire* argument. The few
 * verbs that legitimately take an argument (`set`, `edit`, `draft`, `budget`)
 * are recognised in the leading position, because they are not words anyone
 * starts a sentence with by accident.
 *
 * Everything else is the objective, taken verbatim. Flag parsing only runs on
 * `set`, so an objective containing `--verify` inside a quoted string survives.
 */

import type { GoalDraft } from "./goal.ts"

export type Subcommand =
  | "set"
  | "status"
  | "pause"
  | "resume"
  | "clear"
  | "edit"
  | "budget"
  | "history"
  | "help"
  | "draft"

export interface SetFlags {
  readonly maxTurns?: number
  readonly maxMinutes?: number
  readonly verification?: string
  readonly constraints?: string
  readonly boundaries?: string
  readonly iteration?: string
  readonly blockedStop?: string
  /** Do not start a model turn; just install the goal. */
  readonly noAutostart: boolean
  /** Do not continue automatically even if the goal is active. */
  readonly noAutostartContinuation: boolean
}

type SimpleSubcommand = Exclude<Subcommand, "set" | "draft" | "edit" | "budget">

export type ParsedCommand =
  | { readonly kind: "set"; readonly remainder: string; readonly flags: SetFlags }
  | { readonly kind: "draft"; readonly remainder: string }
  | { readonly kind: "edit"; readonly remainder: string }
  | { readonly kind: "budget"; readonly value: number | undefined }
  | { readonly kind: SimpleSubcommand; readonly remainder: string; readonly flags: SetFlags }

/**
 * Lifecycle verbs that take no argument. These are matched against the *whole*
 * argument, so `/goal stop` pauses while `/goal stop the flakiness` is a goal.
 */
const WHOLE_ARGUMENT: Readonly<Record<string, SimpleSubcommand>> = {
  status: "status",
  show: "status",
  info: "status",
  current: "status",
  view: "status",
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
  history: "history",
  log: "history",
  ledger: "history",
  notes: "history",
  help: "help",
  usage: "help",
}

/**
 * Verbs that legitimately take an argument, so they are matched in the leading
 * position. `budget` additionally requires a number, so `/goal budget the
 * p95` is still read as an objective.
 */
const LEADING_VERB: Readonly<Record<string, "set" | "edit" | "draft" | "budget">> = {
  set: "set",
  edit: "edit",
  amend: "edit",
  draft: "draft",
  budget: "budget",
  limit: "budget",
}

/** Strips the `/goal` invocation itself, if the host passed it through. */
export function stripCommandPrefix(text: string, commandName = "goal"): string {
  let value = text.trim()
  const lowered = value.toLowerCase()
  if (!lowered.startsWith(`/${commandName}`) && !lowered.startsWith(`${commandName} `) && lowered !== commandName) {
    // Fall through: the host may have already removed the invocation.
  }
  if (lowered.startsWith(`/${commandName}`)) {
    value = value.slice(commandName.length + 1)
  } else if (lowered.startsWith(`${commandName} `) || lowered === commandName) {
    value = value.slice(commandName.length)
  }
  return value.replace(/^[:\s]+/, "").trim()
}

/** Splits a command line into words, honouring single and double quotes. */
export function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let escaped = false
  let started = false

  for (const char of input) {
    if (escaped) {
      current += char
      escaped = false
      started = true
      continue
    }
    if (char === "\\" && quote === '"') {
      escaped = true
      started = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current)
        current = ""
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

function parseInt10(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value.trim())
  if (!Number.isFinite(parsed)) return undefined
  return Math.floor(parsed)
}

/**
 * Extracts `--flag value` pairs from a token list. The remainder (all non-flag
 * tokens, in order) is returned so the objective keeps its original wording.
 */
function extractFlags(tokens: readonly string[]): { flags: SetFlags; rest: string[] } {
  const flags: {
    maxTurns?: number
    maxMinutes?: number
    verification?: string
    constraints?: string
    boundaries?: string
    iteration?: string
    blockedStop?: string
    noAutostart: boolean
    noAutostartContinuation: boolean
  } = { noAutostart: false, noAutostartContinuation: false }
  const rest: string[] = []

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (!token.startsWith("--")) {
      rest.push(token)
      continue
    }
    const eq = token.indexOf("=")
    const name = (eq === -1 ? token : token.slice(0, eq)).slice(2).toLowerCase()
    let value: string | undefined = eq === -1 ? undefined : token.slice(eq + 1)

    switch (name) {
      case "turns":
      case "max-turns":
      case "budget": {
        if (value === undefined) value = tokens[++index]
        const parsed = parseInt10(value)
        if (parsed !== undefined) flags.maxTurns = parsed
        break
      }
      case "minutes":
      case "max-minutes": {
        if (value === undefined) value = tokens[++index]
        const parsed = parseInt10(value)
        if (parsed !== undefined) flags.maxMinutes = parsed
        break
      }
      case "verify":
      case "verification":
      case "evidence":
        if (value === undefined) value = tokens[++index]
        if (value !== undefined) flags.verification = value
        break
      case "constraints":
      case "constraint":
        if (value === undefined) value = tokens[++index]
        if (value !== undefined) flags.constraints = value
        break
      case "boundaries":
      case "boundary":
      case "scope":
        if (value === undefined) value = tokens[++index]
        if (value !== undefined) flags.boundaries = value
        break
      case "iterate":
      case "iteration":
        if (value === undefined) value = tokens[++index]
        if (value !== undefined) flags.iteration = value
        break
      case "blocked":
      case "blocked-stop":
      case "stop-when":
        if (value === undefined) value = tokens[++index]
        if (value !== undefined) flags.blockedStop = value
        break
      case "no-start":
      case "no-autostart":
        flags.noAutostart = true
        break
      case "no-continue":
      case "no-autocontinue":
        flags.noAutostartContinuation = true
        break
      default:
        // Unknown flag: keep it in the objective rather than silently eating it.
        rest.push(token)
        if (value !== undefined) rest.push(value)
        break
    }
  }

  return { flags, rest }
}

export function parseGoalCommand(rawText: string, commandName = "goal"): ParsedCommand {
  const text = stripCommandPrefix(rawText, commandName)
  if (!text) return { kind: "status", remainder: "", flags: emptyFlags() }

  const lowered = text.toLowerCase()

  // A bare lifecycle word is the whole command, never the start of an objective.
  const whole = WHOLE_ARGUMENT[lowered]
  if (whole) return { kind: whole, remainder: "", flags: emptyFlags() }

  // `/goal budget` with no count is a request to change it, not an objective
  // called "budget"; the command layer answers with the usage.
  if (lowered === "budget" || lowered === "limit") return { kind: "budget", value: undefined }

  const tokens = tokenize(text)
  const head = tokens[0]
  const firstWord = head === undefined ? "" : head.toLowerCase()
  const verb = LEADING_VERB[firstWord]
  const restTokens = tokens.slice(1)

  if (verb === "budget") {
    const { flags } = extractFlags(restTokens)
    const value = flags.maxTurns ?? parseInt10(restTokens[0])
    // `/goal budget the p95` is an objective, not a malformed budget request, so
    // the verb is put back rather than swallowed.
    if (value !== undefined) return { kind: "budget", value }
    const whole = extractFlags(tokens)
    return { kind: "set", remainder: whole.rest.join(" ").trim(), flags: whole.flags }
  }

  if (verb === "edit" || verb === "draft") {
    const { rest } = extractFlags(restTokens)
    return { kind: verb, remainder: rest.join(" ").trim() }
  }
  if (verb === "set") {
    const { flags, rest } = extractFlags(restTokens)
    return { kind: "set", remainder: rest.join(" ").trim(), flags }
  }

  // No recognised verb: the whole line is the objective.
  const { flags, rest } = extractFlags(tokens)
  return { kind: "set", remainder: rest.join(" ").trim(), flags }
}

function emptyFlags(): SetFlags {
  return { noAutostart: false, noAutostartContinuation: false }
}

/** Builds a goal draft from a parsed `set`, filling in blanks from the old goal. */
export function draftFromParsed(parsed: Extract<ParsedCommand, { kind: "set" }>, previous?: { verification: string; constraints: string; boundaries: string; iteration: string; blockedStop: string }): GoalDraft {
  // An empty previous value means "not set", so it must not become an explicit
  // blank on the new goal.
  const carry = (next: string | undefined, fallback: string | undefined): string | undefined => (next && next.trim() ? next : fallback && fallback.trim() ? fallback : undefined)
  return {
    objective: parsed.remainder,
    verification: carry(parsed.flags.verification, previous?.verification),
    constraints: carry(parsed.flags.constraints, previous?.constraints),
    boundaries: carry(parsed.flags.boundaries, previous?.boundaries),
    iteration: carry(parsed.flags.iteration, previous?.iteration),
    blockedStop: carry(parsed.flags.blockedStop, previous?.blockedStop),
    maxTurns: parsed.flags.maxTurns,
    maxMinutes: parsed.flags.maxMinutes,
  }
}

export const HELP_TEXT = [
  "`/goal` — work autonomously toward one durable objective until the evidence says it is done.",
  "",
  "**Set a goal** (the text becomes the objective *and* the completion criteria):",
  "```",
  "/goal Reduce p95 checkout latency below 120 ms, verified by the checkout benchmark,",
  "      while keeping the correctness suite green. Use only the checkout service and",
  "      its tests. If the benchmark cannot run, stop and report the blocker.",
  "```",
  "",
  "Optional flags: `--turns N` (auto-turn budget, default 25) · `--minutes N` ·",
  "`--verify \"…\"` · `--constraints \"…\"` · `--boundaries \"…\"` · `--iterate \"…\"` ·",
  "`--blocked \"…\"` · `--no-start` (install without starting a turn) ·",
  "`--no-continue` (install but do not auto-continue).",
  "",
  "**Lifecycle**",
  "A lifecycle word is only a command when it is the *whole* input, so an objective may",
  "start with any word you like.",
  "",
  "| Command | Effect |",
  "| --- | --- |",
  "| `/goal` or `/goal status` | Show the current goal, budget, and ledger |",
  "| `/goal pause` (alias `stop`) | Stop continuing; keeps the objective |",
  "| `/goal resume` (alias `continue`) | Continue from the current state |",
  "| `/goal clear` (alias `reset`) | Remove the goal entirely |",
  "| `/goal history` | Show the progress ledger |",
  "| `/goal help` | This text |",
  "",
  "Verbs that take an argument are read in the leading position:",
  "| Command | Effect |",
  "| --- | --- |",
  "| `/goal edit <text>` | Replace the objective, keep the rest of the contract |",
  "| `/goal budget <n>` | Change the auto-turn budget |",
  "| `/goal draft <text>` | Have the model write a strong goal contract first |",
  "| `/goal set <text>` | Same as bare `/goal <text>`; use it when the objective starts with a lifecycle word |",
  "",
  "So `/goal stop the flaky checkout test` sets a goal, while `/goal stop` pauses the",
  "current one.",
  "",
  "**What a goal changes**",
  "The objective is injected into every model call, so it survives compaction. When the",
  "session goes idle with the goal still active and inside budget, the agent is woken",
  "again to audit its evidence and pick the next useful action. The agent declares the",
  "goal `complete` only through `goal_update` with cited evidence, and `blocked` only",
  "when no defensible path remains. Interrupting a run pauses the goal.",
  "",
  "**What a goal does not change**",
  "Permissions, approvals, deploy rights, and network policy are unchanged. A goal makes",
  "the loop durable; it does not grant authority.",
].join("\n")
