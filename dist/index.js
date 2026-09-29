// src/index.ts
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// src/goal.ts
var GOAL_VERSION = 1;
var GOAL_STATUSES = ["active", "paused", "complete", "blocked", "budget", "cleared"];
var TERMINAL_STATUSES = ["complete", "blocked", "budget", "cleared"];
function isGoalStatus(value) {
  return typeof value === "string" && GOAL_STATUSES.includes(value);
}
function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}
var TITLE_LIMIT = 72;
function deriveTitle(objective) {
  const flat = objective.replace(/\s+/g, " ").trim();
  if (!flat)
    return "Untitled goal";
  if (flat.length <= TITLE_LIMIT)
    return flat;
  const cut = flat.slice(0, TITLE_LIMIT);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_LIMIT * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
var counter = 0;
function createGoalID(sessionID, now) {
  counter = (counter + 1) % 1e6;
  return `goal_${now.toString(36)}_${counter.toString(36)}_${sessionID.slice(-6)}`;
}
function createGoal(input) {
  const { sessionID, draft, now, defaults, source, previous } = input;
  const transitions = previous ? [...previous.transitions, { at: now, from: previous.status, to: "active", reason: "replaced by a new goal" }] : [];
  return {
    version: GOAL_VERSION,
    id: createGoalID(sessionID, now),
    sessionID,
    title: deriveTitle(draft.objective),
    objective: draft.objective.trim(),
    verification: (draft.verification ?? "").trim(),
    constraints: (draft.constraints ?? "").trim(),
    boundaries: (draft.boundaries ?? "").trim(),
    iteration: (draft.iteration ?? "").trim(),
    blockedStop: (draft.blockedStop ?? "").trim(),
    status: "active",
    createdAt: now,
    updatedAt: now,
    budget: {
      maxTurns: clampInt(draft.maxTurns, 1, 1e4, defaults.maxTurns),
      usedTurns: 0,
      startedAt: now,
      maxMs: clampInt(draft.maxMinutes, 1, 60 * 24 * 30, defaults.maxMinutes) * 60000
    },
    notes: [],
    transitions,
    noToolStreak: 0,
    lastTurnWasContinuation: false,
    dispatching: false,
    source
  };
}
function clampInt(value, min, max, fallback) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(parsed))
    return fallback;
  const rounded = Math.floor(parsed);
  if (rounded < min)
    return fallback;
  return Math.min(rounded, max);
}
function remainingTurns(goal) {
  return Math.max(0, goal.budget.maxTurns - goal.budget.usedTurns);
}
function elapsedMs(goal, now) {
  return Math.max(0, now - goal.budget.startedAt);
}
function budgetExhausted(goal, now) {
  if (remainingTurns(goal) <= 0)
    return "turns";
  if (elapsedMs(goal, now) >= goal.budget.maxMs)
    return "time";
  return;
}
function progressPercent(goal) {
  if (goal.status === "complete")
    return 100;
  const byTurns = goal.budget.maxTurns > 0 ? goal.budget.usedTurns / goal.budget.maxTurns : 0;
  return Math.max(0, Math.min(100, Math.round(byTurns * 100)));
}
function reviveGoal(value) {
  if (!value || typeof value !== "object")
    return;
  const raw = value;
  if (typeof raw.sessionID !== "string" || !raw.sessionID)
    return;
  if (typeof raw.objective !== "string" || !raw.objective.trim())
    return;
  const status = isGoalStatus(raw.status) ? raw.status : "paused";
  const budget = raw.budget ?? {};
  const now = Date.now();
  return {
    version: GOAL_VERSION,
    id: typeof raw.id === "string" ? raw.id : createGoalID(raw.sessionID, now),
    sessionID: raw.sessionID,
    title: typeof raw.title === "string" && raw.title ? raw.title : deriveTitle(raw.objective),
    objective: raw.objective,
    verification: str(raw.verification),
    constraints: str(raw.constraints),
    boundaries: str(raw.boundaries),
    iteration: str(raw.iteration),
    blockedStop: str(raw.blockedStop),
    status,
    createdAt: num(raw.createdAt, now),
    updatedAt: num(raw.updatedAt, now),
    budget: {
      maxTurns: Math.max(1, num(budget.maxTurns, 25)),
      usedTurns: Math.max(0, num(budget.usedTurns, 0)),
      startedAt: num(budget.startedAt, num(raw.createdAt, now)),
      maxMs: Math.max(1000, num(budget.maxMs, 180 * 60000))
    },
    notes: Array.isArray(raw.notes) ? raw.notes.filter(isNote) : [],
    transitions: Array.isArray(raw.transitions) ? raw.transitions.filter(isTransition) : [],
    summary: optStr(raw.summary),
    evidence: optStr(raw.evidence),
    blocker: optStr(raw.blocker),
    suppressNextContinuation: raw.suppressNextContinuation === true,
    noToolStreak: Math.max(0, num(raw.noToolStreak, 0)),
    lastTurnWasContinuation: raw.lastTurnWasContinuation === true,
    lastContinuationAt: typeof raw.lastContinuationAt === "number" ? raw.lastContinuationAt : undefined,
    dispatching: false,
    source: raw.source === "command" ? "command" : "tool"
  };
}
function str(value) {
  return typeof value === "string" ? value : "";
}
function optStr(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function num(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function isNote(value) {
  if (!value || typeof value !== "object")
    return false;
  const note = value;
  return typeof note.at === "number" && (note.status === "working" || note.status === "complete" || note.status === "blocked" || note.status === "budget");
}
function isTransition(value) {
  if (!value || typeof value !== "object")
    return false;
  const transition = value;
  return typeof transition.at === "number" && isGoalStatus(transition.from) && isGoalStatus(transition.to);
}

// src/decision.ts
function decideContinuation(input) {
  if (!input.enabled)
    return { action: "stop", reason: "disabled" };
  const goal = input.goal;
  if (!goal)
    return { action: "stop", reason: "no_goal" };
  const status = goal.status;
  if (status !== "active") {
    if (isTerminal(status))
      return { action: "stop", reason: "not_active" };
    return { action: "stop", reason: "not_active" };
  }
  if (input.dispatching || goal.dispatching)
    return { action: "stop", reason: "dispatching" };
  if (input.pendingItems > 0)
    return { action: "stop", reason: "pending_input" };
  const agent = input.agent?.trim().toLowerCase();
  if (agent && input.skipAgents.includes(agent))
    return { action: "stop", reason: "agent_skipped" };
  if (input.cooldownMs > 0 && typeof goal.lastContinuationAt === "number" && input.now - goal.lastContinuationAt < input.cooldownMs) {
    return { action: "stop", reason: "cooldown" };
  }
  const exhausted = budgetExhausted(goal, input.now);
  if (exhausted)
    return { action: "budget_exhausted", exhausted };
  return { action: "continue" };
}
function shouldSuppressContinuation(input) {
  const status = input.status;
  if (status !== "active")
    return "no";
  if (!input.lastTurnWasContinuation)
    return "no";
  if (input.sawToolCall)
    return "no";
  if (input.suppressNextContinuation)
    return "blocked";
  if (input.noToolStreak + 1 >= input.maxNoToolStreak)
    return "blocked";
  return "suppress";
}

// src/format.ts
var STATUS_LABEL = {
  active: "ACTIVE",
  paused: "PAUSED",
  complete: "COMPLETE",
  blocked: "BLOCKED",
  budget: "BUDGET REACHED",
  cleared: "CLEARED"
};
function duration(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 1)
    return "<1m";
  if (totalMinutes < 60)
    return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const rest = totalMinutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
function line(label, value) {
  return value && value.trim() ? `${label}: ${value}` : "";
}
function formatNote(note) {
  const parts = [`[${new Date(note.at).toISOString().replace("T", " ").slice(0, 16)}Z] ${note.status}`];
  if (note.note)
    parts.push(note.note);
  if (note.evidence)
    parts.push(`evidence: ${note.evidence}`);
  if (note.next)
    parts.push(`next: ${note.next}`);
  if (note.blocker)
    parts.push(`blocker: ${note.blocker}`);
  return parts.join(" — ");
}
function formatGoal(goal, now, options = {}) {
  const lines = [];
  lines.push(`GOAL — ${STATUS_LABEL[goal.status]}`);
  lines.push("");
  lines.push(`Objective`);
  lines.push(goal.objective);
  const extras = [line("Verified by", goal.verification), line("Must not regress", goal.constraints), line("In scope", goal.boundaries), line("Between iterations", goal.iteration), line("Stop and report when", goal.blockedStop)];
  const present = extras.filter((item) => item.length > 0);
  if (present.length > 0) {
    lines.push("");
    lines.push("Contract");
    lines.push(...present);
  }
  lines.push("");
  lines.push(`Budget: ${goal.budget.usedTurns}/${goal.budget.maxTurns} automatic turns used · ${remainingTurns(goal)} left · ${duration(elapsedMs(goal, now))} of ${duration(goal.budget.maxMs)} wall clock · ${progressPercent(goal)}%`);
  if (goal.summary) {
    lines.push("");
    lines.push("Result");
    lines.push(goal.summary);
  }
  if (goal.evidence) {
    lines.push("");
    lines.push(`Evidence: ${goal.evidence}`);
  }
  if (goal.blocker) {
    lines.push("");
    lines.push(`Blocker: ${goal.blocker}`);
  }
  if (options.history && goal.notes.length > 0) {
    lines.push("");
    lines.push(`Ledger (${goal.notes.length} entr${goal.notes.length === 1 ? "y" : "ies"})`);
    for (const note of goal.notes)
      lines.push(`  ${formatNote(note)}`);
  }
  lines.push("");
  lines.push(goal.status === "active" ? "The agent keeps going on its own until this finish line is met, the budget runs out, or you pause it." : "Controls: /goal resume · /goal edit <text> · /goal budget <n> · /goal clear");
  return lines.join(`
`);
}
function formatHistory(goal) {
  if (goal.notes.length === 0) {
    return `GOAL LEDGER — empty

No progress has been recorded for "${goal.title}" yet.`;
  }
  const lines = [`GOAL LEDGER — ${goal.status}, ${goal.notes.length} entr${goal.notes.length === 1 ? "y" : "ies"}`, ""];
  for (const note of goal.notes)
    lines.push(formatNote(note));
  if (goal.transitions.length > 0) {
    lines.push("");
    lines.push("Transitions");
    for (const transition of goal.transitions) {
      const reason = transition.reason ? ` (${transition.reason})` : "";
      lines.push(`  ${new Date(transition.at).toISOString().replace("T", " ").slice(0, 19)}Z  ${transition.from} → ${transition.to}${reason}`);
    }
  }
  return lines.join(`
`);
}
var NO_GOAL_REPORT = [
  "No goal is active in this session.",
  "",
  "Set one with the text that should become both the task and the finish line:",
  "",
  "```",
  "/goal Reduce p95 checkout latency below 120 ms, verified by the checkout benchmark,",
  "      while keeping the correctness suite green.",
  "```",
  "",
  "`/goal help` shows the full command surface."
].join(`
`);

// src/prompts.ts
var HEADER = "ACTIVE GOAL (opencode-goal-plugin)";
function field(label, value) {
  return value ? `- ${label}: ${value}` : "";
}
function goalSystemBlock(goal) {
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
    '   `goal_update` with `status: "complete"`, a summary, and the evidence you checked.',
    "3. Do not mark the goal blocked while a defensible path remains. Mark it blocked only",
    "   through `goal_update` with the blocker and the input that would unblock it.",
    '4. Record each iteration with `goal_update` using `status: "working"` so progress is',
    "   auditable and survives compaction.",
    "5. The goal does not widen your authority. Permissions, approvals, deploy rights, and",
    "   network policy still apply. A durable objective is not authorization.",
    "6. Prefer a measured next experiment over a blind retry. If the same approach has",
    "   failed twice, change approach or report the blocker.",
    "",
    `Budget: ${remainingTurns(goal)} of ${goal.budget.maxTurns} automatic turns remaining.`,
    "Running out of budget stops the loop for review; it does not mean the goal is done.",
    "",
    `Controls (user-owned): /goal pause · /goal resume · /goal clear · /goal status.`
  ];
  const blocked = goal.blocker ? ["", `Last recorded blocker: ${goal.blocker}`] : [];
  return [...lines, ...blocked].join(`
`);
}
function activationPrompt(goal) {
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
    `Budget: ${goal.budget.maxTurns} automatic turns, ${goal.budget.maxMs / 60000} minutes.`,
    "",
    "Begin with the smallest useful step, verify it against the evidence named above, and",
    'keep going. Record each iteration with `goal_update` using `status: "working"`. When',
    'the finish line is met, call `goal_update` with `status: "complete"` and the evidence.',
    'If no defensible path remains, call `goal_update` with `status: "blocked"` and say what',
    "input would unblock it."
  ].filter((line2) => line2 !== "").join(`
`);
}
function continuationPrompt(goal, turn) {
  const remaining = remainingTurns(goal);
  const last = goal.notes.length > 0 ? goal.notes[goal.notes.length - 1] : undefined;
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
    `- If the finish line is met, call \`goal_update\` with \`status: "complete"\`, a summary, and the evidence.`,
    `- If no defensible path remains, call \`goal_update\` with \`status: "blocked"\`, the blocker, and the input that would unblock it.`,
    `- Otherwise call \`goal_update\` with \`status: "working"\` and the next step, then act on it.`,
    "",
    `${remaining} automatic turn${remaining === 1 ? "" : "s"} left after this one.`,
    "The user can stop this at any time with `/goal pause` or by interrupting."
  ].filter((line2) => line2 !== "").join(`
`);
}
function draftPrompt(subject) {
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
    "End with a suggested turn budget, e.g. `--turns 12`, if the work looks bounded."
  ].join(`
`);
}

// src/store.ts
function json(value) {
  return value;
}
var PREFIX = "goal/v1/session/";
var SCAN_LIMIT = 500;

class GoalStore {
  #storage;
  #cache = new Map;
  #locks = new Map;
  constructor(storage) {
    this.#storage = storage;
  }
  key(sessionID) {
    return `${PREFIX}${sessionID}`;
  }
  async read(sessionID) {
    const cached = this.#cache.get(sessionID);
    if (cached)
      return cached;
    try {
      const raw = await this.#storage.get(this.key(sessionID));
      const goal = reviveGoal(raw);
      if (goal)
        this.#cache.set(sessionID, goal);
      return goal;
    } catch {
      return;
    }
  }
  async write(goal) {
    this.#cache.set(goal.sessionID, goal);
    await this.#serialized(goal.sessionID, async () => {
      try {
        await this.#storage.set(this.key(goal.sessionID), json(goal));
      } catch {}
    });
    return goal;
  }
  async update(sessionID, updater) {
    let result;
    await this.#serialized(sessionID, async () => {
      const current = await this.read(sessionID);
      const next = updater(current);
      if (next === undefined)
        return;
      result = next;
      this.#cache.set(sessionID, next);
      try {
        await this.#storage.set(this.key(sessionID), json(next));
      } catch {}
    });
    return result;
  }
  async remove(sessionID) {
    this.#cache.delete(sessionID);
    await this.#serialized(sessionID, async () => {
      try {
        await this.#storage.remove(this.key(sessionID));
      } catch {}
    });
  }
  async list() {
    const goals = [];
    try {
      let cursor;
      for (let page = 0;page < 20; page++) {
        const result = await this.#storage.scan(cursor ? { prefix: PREFIX, after: cursor, limit: SCAN_LIMIT } : { prefix: PREFIX, limit: SCAN_LIMIT });
        for (const entry of result.entries) {
          const sessionID = entry.key.slice(PREFIX.length);
          if (!sessionID)
            continue;
          const cached = this.#cache.get(sessionID);
          if (cached) {
            goals.push(cached);
            continue;
          }
          const goal = reviveGoal(entry.value);
          if (goal) {
            this.#cache.set(sessionID, goal);
            goals.push(goal);
          }
        }
        if (!result.next)
          break;
        cursor = result.next;
      }
    } catch {
      return [...this.#cache.values()];
    }
    return goals;
  }
  invalidate(sessionID) {
    if (sessionID)
      this.#cache.delete(sessionID);
    else
      this.#cache.clear();
  }
  #serialized(sessionID, task) {
    const previous = this.#locks.get(sessionID) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tracked = next.catch(() => {
      return;
    });
    this.#locks.set(sessionID, tracked);
    tracked.finally(() => {
      if (this.#locks.get(sessionID) === tracked)
        this.#locks.delete(sessionID);
    });
    return next;
  }
}

// src/engine.ts
var GOAL_METADATA = "opencode-goal";

class PendingInbox {
  #foreign = new Map;
  #own = new Map;
  enqueue(sessionID, inboxID, own) {
    const target = own ? this.#own : this.#foreign;
    const set = target.get(sessionID) ?? new Set;
    set.add(inboxID);
    target.set(sessionID, set);
  }
  settle(sessionID, inboxID) {
    this.#foreign.get(sessionID)?.delete(inboxID);
    this.#own.get(sessionID)?.delete(inboxID);
  }
  count(sessionID) {
    return this.#foreign.get(sessionID)?.size ?? 0;
  }
  clear(sessionID) {
    this.#foreign.delete(sessionID);
    this.#own.delete(sessionID);
  }
}
var MAX_NOTE_LENGTH = 4000;
function trimText(value, limit = MAX_NOTE_LENGTH) {
  if (typeof value !== "string")
    return "";
  const trimmed = value.trim();
  if (trimmed.length <= limit)
    return trimmed;
  return `${trimmed.slice(0, limit - 1)}…`;
}
function nowSafe(goal, now) {
  return { ...goal, updatedAt: now };
}
function withNote(goal, note, maxNotes) {
  const notes = [...goal.notes, note];
  return { ...goal, notes: notes.length > maxNotes ? notes.slice(notes.length - maxNotes) : notes };
}

class GoalEngine {
  #port;
  #options;
  #store;
  #toolSeen = new Set;
  #dispatching = new Set;
  #inbox = new PendingInbox;
  constructor(port, options) {
    this.#port = port;
    this.#options = options;
    this.#store = new GoalStore(port.storage);
  }
  get store() {
    return this.#store;
  }
  get options() {
    return this.#options;
  }
  async get(sessionID) {
    return this.#store.read(sessionID);
  }
  async activate(sessionID, input) {
    const now = this.#port.now();
    const objective = trimText(input.objective, 4000);
    if (!objective) {
      return { goal: await this.get(sessionID), message: "A goal needs an objective. Usage: `/goal <outcome>`." };
    }
    const previous = await this.#store.read(sessionID);
    const goal = createGoal({
      sessionID,
      draft: {
        objective,
        verification: input.verification,
        constraints: input.constraints,
        boundaries: input.boundaries,
        iteration: input.iteration,
        blockedStop: input.blockedStop,
        maxTurns: input.maxTurns,
        maxMinutes: input.maxMinutes
      },
      now,
      defaults: { maxTurns: this.#options.defaultMaxTurns, maxMinutes: this.#options.defaultMaxMinutes },
      source: "command"
    });
    const final = input.autoContinue === false ? { ...goal, status: "paused" } : goal;
    await this.#store.write(final);
    await this.#port.changed(final, sessionID);
    const replaced = previous && !isCleared(previous) ? `

A previous goal was replaced; its history is in the ledger below.` : "";
    const message = formatGoal(final, this.#port.now()) + replaced;
    if (input.start === false) {
      return { goal: final, message };
    }
    return { goal: final, message, prompt: { text: activationPrompt(final), origin: "activation" } };
  }
  async pause(sessionID, reason = "paused by user") {
    return this.#transition(sessionID, "paused", reason);
  }
  async resume(sessionID) {
    const current = await this.#store.read(sessionID);
    if (!current)
      return { goal: undefined, message: NO_GOAL_REPORT };
    if (current.status === "complete") {
      return { goal: current, message: `The goal is complete: "${current.title}". Set a new one with \`/goal <outcome>\`.` };
    }
    if (current.status === "cleared")
      return { goal: undefined, message: NO_GOAL_REPORT };
    const now = this.#port.now();
    const exhausted = current.status === "budget" ? budgetExhausted(current, now) : undefined;
    const budget = current.status === "budget" ? { ...current.budget, maxTurns: this.#options.defaultMaxTurns, startedAt: now } : current.budget;
    const goal = withNote(nowSafe({
      ...current,
      status: "active",
      budget,
      suppressNextContinuation: false,
      noToolStreak: 0,
      lastTurnWasContinuation: false,
      transitions: [...current.transitions, { at: now, from: current.status, to: "active", reason: "resumed" }]
    }, now), { at: now, status: "working", note: current.status === "budget" ? "resumed with a fresh turn budget" : "resumed" }, this.#options.maxNotes);
    await this.#store.write(goal);
    this.#toolSeen.delete(sessionID);
    await this.#port.changed(goal, sessionID);
    if (exhausted && goal.budget.usedTurns >= goal.budget.maxTurns) {
      return { goal, message: "The turn budget is already spent. Raise it with `/goal budget <n>`, then resume." };
    }
    return { goal, message: formatGoal(goal, this.#port.now()) };
  }
  async clear(sessionID) {
    const current = await this.#store.read(sessionID);
    if (!current)
      return { goal: undefined, message: "There is no goal to clear." };
    const now = this.#port.now();
    const goal = {
      ...current,
      status: "cleared",
      updatedAt: now,
      transitions: [...current.transitions, { at: now, from: current.status, to: "cleared", reason: "cleared by user" }]
    };
    await this.#store.write(goal);
    await this.#port.changed(goal, sessionID);
    return {
      goal,
      message: `Goal cleared: "${current.title}"

The objective and its ledger are removed from this session. Set a new one with \`/goal <outcome>\`.`
    };
  }
  async forget(sessionID) {
    this.#toolSeen.delete(sessionID);
    this.#dispatching.delete(sessionID);
    this.#inbox.clear(sessionID);
    await this.#store.remove(sessionID);
    await this.#port.changed(undefined, sessionID);
  }
  async edit(sessionID, objective) {
    const text = trimText(objective, 4000);
    if (!text)
      return { goal: await this.get(sessionID), message: "`/goal edit` needs the new objective text." };
    const current = await this.#store.read(sessionID);
    if (!current)
      return { goal: undefined, message: NO_GOAL_REPORT };
    const result = await this.activate(sessionID, {
      objective: text,
      verification: current.verification,
      constraints: current.constraints,
      boundaries: current.boundaries,
      iteration: current.iteration,
      blockedStop: current.blockedStop,
      maxTurns: current.budget.maxTurns,
      maxMinutes: Math.round(current.budget.maxMs / 60000),
      start: false
    });
    const ledger = result.goal ? formatHistory(result.goal) : "";
    return {
      goal: result.goal,
      message: `Objective replaced.

${result.message}${ledger ? `

${ledger}` : ""}`,
      prompt: { text: activationPrompt(result.goal), origin: "activation" }
    };
  }
  async setBudget(sessionID, turns) {
    if (turns === undefined || !Number.isFinite(turns) || turns < 1) {
      return { goal: await this.get(sessionID), message: "`/goal budget` needs a positive number of turns, e.g. `/goal budget 30`." };
    }
    const current = await this.#store.read(sessionID);
    if (!current)
      return { goal: undefined, message: NO_GOAL_REPORT };
    const now = this.#port.now();
    const goal = nowSafe({ ...current, budget: { ...current.budget, maxTurns: Math.floor(turns) } }, now);
    await this.#store.write(goal);
    await this.#port.changed(goal, sessionID);
    return { goal, message: formatGoal(goal, now) };
  }
  async recordWorking(sessionID, input) {
    const now = this.#port.now();
    const updated = await this.#store.update(sessionID, (current) => {
      if (!current)
        return;
      return withNote(nowSafe(current, now), { at: now, status: "working", note: trimText(input.note), evidence: trimText(input.evidence), next: trimText(input.next) }, this.#options.maxNotes);
    });
    if (!updated)
      return { goal: undefined, message: NO_GOAL_REPORT };
    await this.#port.changed(updated, sessionID);
    return { goal: updated, message: `Recorded (${updated.notes.length} ledger entr${updated.notes.length === 1 ? "y" : "ies"}). ${remainingTurns(updated)} automatic turns left.` };
  }
  async recordComplete(sessionID, input) {
    const summary = trimText(input.summary);
    const evidence = trimText(input.evidence);
    if (!summary) {
      return { goal: await this.get(sessionID), message: "Refusing to complete: a completion needs a summary of what is now true. Call `goal_update` again with `summary` and `evidence`." };
    }
    const now = this.#port.now();
    const goal = await this.#store.update(sessionID, (current) => {
      if (!current)
        return;
      return withNote(nowSafe({
        ...current,
        status: "complete",
        summary,
        evidence: evidence || undefined,
        suppressNextContinuation: false,
        transitions: [...current.transitions, { at: now, from: current.status, to: "complete", reason: "model reported completion" }]
      }, now), { at: now, status: "complete", note: summary, evidence: evidence || undefined }, this.#options.maxNotes);
    });
    if (!goal)
      return { goal: undefined, message: NO_GOAL_REPORT };
    this.#toolSeen.delete(sessionID);
    await this.#port.changed(goal, sessionID);
    return { goal, message: `Goal marked complete. ${formatGoal(goal, now)}` };
  }
  async recordBlocked(sessionID, input) {
    const blocker = trimText(input.blocker);
    if (!blocker) {
      return { goal: await this.get(sessionID), message: "Refusing to block: call `goal_update` with the `blocker` and what would unblock it." };
    }
    const now = this.#port.now();
    const goal = await this.#store.update(sessionID, (current) => {
      if (!current)
        return;
      return withNote(nowSafe({
        ...current,
        status: "blocked",
        blocker,
        summary: trimText(input.summary) || undefined,
        suppressNextContinuation: false,
        transitions: [...current.transitions, { at: now, from: current.status, to: "blocked", reason: "model reported a blocker" }]
      }, now), { at: now, status: "blocked", blocker, next: trimText(input.next) }, this.#options.maxNotes);
    });
    if (!goal)
      return { goal: undefined, message: NO_GOAL_REPORT };
    this.#toolSeen.delete(sessionID);
    await this.#port.changed(goal, sessionID);
    return { goal, message: `Goal marked blocked. ${formatGoal(goal, now)}` };
  }
  async report(sessionID, options = {}) {
    const goal = await this.get(sessionID);
    if (!goal || goal.status === "cleared")
      return { goal, text: NO_GOAL_REPORT };
    return { goal, text: formatGoal(goal, this.#port.now(), options) };
  }
  async history(sessionID) {
    const goal = await this.get(sessionID);
    if (!goal || goal.status === "cleared")
      return { goal, text: "No goal ledger in this session." };
    return { goal, text: formatHistory(goal) };
  }
  async onUserPrompt(sessionID) {
    this.#toolSeen.delete(sessionID);
    await this.#store.update(sessionID, (current) => {
      if (!current)
        return;
      if (!current.lastTurnWasContinuation && !current.suppressNextContinuation)
        return;
      return {
        ...current,
        lastTurnWasContinuation: false,
        suppressNextContinuation: false,
        dispatching: false
      };
    });
  }
  markToolCall(sessionID) {
    this.#toolSeen.add(sessionID);
  }
  trackEnqueued(sessionID, inboxID, own) {
    this.#inbox.enqueue(sessionID, inboxID, own);
  }
  trackSettled(sessionID, inboxID) {
    this.#inbox.settle(sessionID, inboxID);
  }
  async onInterrupted(sessionID) {
    if (!this.#options.pauseOnInterrupt)
      return;
    const current = await this.get(sessionID);
    if (!current || current.status !== "active")
      return;
    const now = this.#port.now();
    const goal = withNote(nowSafe({
      ...current,
      status: "paused",
      lastTurnWasContinuation: false,
      dispatching: false,
      transitions: [...current.transitions, { at: now, from: current.status, to: "paused", reason: "run interrupted" }]
    }, now), { at: now, status: "working", note: "paused: the run was interrupted" }, this.#options.maxNotes);
    await this.#store.write(goal);
    this.#toolSeen.delete(sessionID);
    this.#dispatching.delete(sessionID);
    await this.#port.changed(goal, sessionID);
    if (this.#options.postLifecycleNotices) {
      await this.#announce(sessionID, `Goal paused — the run was interrupted.

${formatGoal(goal, now)}`, "goal paused");
    }
  }
  async onIdle(sessionID) {
    if (this.#dispatching.has(sessionID))
      return;
    const goal = await this.#getRich(sessionID);
    if (!goal)
      return;
    const now = this.#port.now();
    const decision = decideContinuation({
      enabled: this.#options.enabled,
      goal,
      now,
      dispatching: this.#dispatching.has(sessionID),
      pendingItems: this.#inbox.count(sessionID),
      agent: await this.#safeAgent(sessionID),
      skipAgents: this.#options.skipAgents,
      cooldownMs: this.#options.continuationDelayMs
    });
    if (decision.action === "stop")
      return;
    if (decision.action === "budget_exhausted") {
      await this.finalizeBudget(sessionID, goal, decision.exhausted);
      return;
    }
    const spin = shouldSuppressContinuation({
      status: goal.status,
      lastTurnWasContinuation: goal.lastTurnWasContinuation,
      sawToolCall: this.#toolSeen.has(sessionID),
      suppressNextContinuation: goal.suppressNextContinuation === true,
      maxNoToolStreak: this.#options.maxNoToolStreak,
      noToolStreak: goal.noToolStreak
    });
    if (spin === "suppress") {
      await this.suppressContinuation(sessionID, goal);
      return;
    }
    if (spin === "blocked") {
      await this.declareStalled(sessionID, goal);
      return;
    }
    await this.dispatchContinuation(sessionID, goal);
  }
  async#getRich(sessionID) {
    const stored = await this.#store.read(sessionID);
    if (!stored)
      return;
    return { ...stored, dispatching: this.#dispatching.has(sessionID) };
  }
  async#transition(sessionID, to, reason) {
    const current = await this.#store.read(sessionID);
    if (!current)
      return { goal: undefined, message: NO_GOAL_REPORT };
    if (current.status === to) {
      return { goal: current, message: `The goal is already ${to}.

${formatGoal(current, this.#port.now())}` };
    }
    const now = this.#port.now();
    const goal = withNote(nowSafe({
      ...current,
      status: to,
      lastTurnWasContinuation: false,
      suppressNextContinuation: false,
      dispatching: false,
      transitions: [...current.transitions, { at: now, from: current.status, to, reason }]
    }, now), { at: now, status: "working", note: reason }, this.#options.maxNotes);
    await this.#store.write(goal);
    this.#dispatching.delete(sessionID);
    this.#toolSeen.delete(sessionID);
    await this.#port.changed(goal, sessionID);
    return { goal, message: formatGoal(goal, now) };
  }
  async#announce(sessionID, text, description) {
    try {
      await this.#port.note({ sessionID, text, description });
    } catch (error) {
      this.#port.warn(`goal: could not post notice — ${describe(error)}`);
    }
  }
  async#safeAgent(sessionID) {
    try {
      const info = await this.#port.sessionInfo(sessionID);
      return info?.agent;
    } catch {
      return;
    }
  }
  async dispatchContinuation(sessionID, goal) {
    const now = this.#port.now();
    const turn = goal.budget.usedTurns + 1;
    this.#dispatching.add(sessionID);
    this.#toolSeen.delete(sessionID);
    const prepared = {
      ...goal,
      dispatching: false,
      lastTurnWasContinuation: true,
      lastContinuationAt: now,
      budget: { ...goal.budget, usedTurns: turn }
    };
    await this.#store.write(prepared);
    await this.#port.changed(prepared, sessionID);
    try {
      await this.#port.prompt({
        sessionID,
        text: continuationPrompt(prepared, turn),
        delivery: "queue",
        origin: "continuation"
      });
    } catch (error) {
      this.#port.warn(`goal: continuation dispatch failed — ${describe(error)}`);
      await this.#store.update(sessionID, (current) => current ? nowSafe({ ...current, dispatching: false, lastContinuationAt: undefined }, this.#port.now()) : undefined);
    } finally {
      this.#dispatching.delete(sessionID);
    }
  }
  async suppressContinuation(sessionID, goal) {
    const now = this.#port.now();
    const streak = goal.noToolStreak + 1;
    const updated = withNote(nowSafe({ ...goal, suppressNextContinuation: true, noToolStreak: streak, dispatching: false }, now), { at: now, status: "working", note: "automatic continuation halted: the last turn made no tool call, so it was not progress" }, this.#options.maxNotes);
    await this.#store.write(updated);
    this.#toolSeen.delete(sessionID);
    await this.#port.changed(updated, sessionID);
    if (this.#options.postLifecycleNotices) {
      await this.#announce(sessionID, [
        `Goal loop halted (${streak}/${this.#options.maxNoToolStreak}).`,
        "",
        "The last automatic turn made no tool call, so it produced no evidence and the next",
        "automatic turn was suppressed instead of spinning. The goal is still active.",
        "",
        "Do this next: send a message that asks for a concrete action, or run `/goal resume`",
        "to restart the loop yourself."
      ].join(`
`), "goal loop halted");
    }
  }
  async declareStalled(sessionID, goal) {
    const now = this.#port.now();
    const blocker = "The agent stopped making tool calls, so the loop cannot produce evidence.";
    const updated = withNote(nowSafe({
      ...goal,
      status: "blocked",
      blocker,
      summary: goal.summary ?? `Stopped after ${goal.noToolStreak} consecutive turns without a single tool call.`,
      suppressNextContinuation: false,
      dispatching: false,
      transitions: [...goal.transitions, { at: now, from: goal.status, to: "blocked", reason: "no progress" }]
    }, now), { at: now, status: "blocked", blocker, next: "Ask for a concrete action, or `/goal resume` to try again." }, this.#options.maxNotes);
    await this.#store.write(updated);
    this.#toolSeen.delete(sessionID);
    this.#dispatching.delete(sessionID);
    await this.#port.changed(updated, sessionID);
    if (this.#options.postLifecycleNotices) {
      await this.#announce(sessionID, `Goal blocked — no progress.

${formatGoal(updated, now)}`, "goal blocked");
    }
  }
  async finalizeBudget(sessionID, goal, exhausted) {
    const now = this.#port.now();
    const reason = exhausted === "turns" ? "turn budget reached" : "wall-clock budget reached";
    const summary = goal.summary ?? [
      `Stopped after ${goal.budget.usedTurns} automatic turns and ${Math.round(elapsedMs(goal, now) / 60000)} minutes without the finish line being met.`,
      goal.blocker ? `Blocker: ${goal.blocker}` : "No blocker was recorded.",
      "Reaching a budget limit is not the same as completing the objective."
    ].join(" ");
    const updated = withNote(nowSafe({
      ...goal,
      status: "budget",
      summary,
      suppressNextContinuation: false,
      dispatching: false,
      transitions: [...goal.transitions, { at: now, from: goal.status, to: "budget", reason }]
    }, now), { at: now, status: "budget", note: reason, next: "Review, then `/goal budget <n>` and `/goal resume`, or `/goal clear`." }, this.#options.maxNotes);
    await this.#store.write(updated);
    this.#toolSeen.delete(sessionID);
    this.#dispatching.delete(sessionID);
    await this.#port.changed(updated, sessionID);
    if (this.#options.postLifecycleNotices) {
      await this.#announce(sessionID, [
        `Goal stopped — ${reason}.`,
        "",
        updated.summary,
        "",
        `${remainingTurns(updated)} automatic turns remain unused, and the objective is not complete.`,
        "Next: raise the budget and resume, narrow the goal, or clear it."
      ].join(`
`), "goal budget reached");
    }
  }
}
function isCleared(goal) {
  return goal.status === "cleared";
}
function describe(error) {
  if (error instanceof Error)
    return error.message;
  if (typeof error === "string")
    return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

// src/mirror.ts
var GOAL_METADATA_KEY = "opencode-goal";
function summarize(goal, now) {
  return {
    title: goal.title,
    status: goal.status,
    progressPercent: progressPercent(goal),
    usedTurns: goal.budget.usedTurns,
    maxTurns: goal.budget.maxTurns,
    remainingTurns: remainingTurns(goal),
    elapsedMinutes: Math.round(elapsedMs(goal, now) / 60000),
    maxMinutes: Math.round(goal.budget.maxMs / 60000),
    updatedAt: goal.updatedAt,
    blocked: goal.status === "blocked"
  };
}

class GoalMirror {
  #port;
  #last = new Map;
  #unsupported = false;
  constructor(port) {
    this.#port = port;
  }
  get supported() {
    return !this.#unsupported;
  }
  async publish(sessionID, goal) {
    if (this.#unsupported)
      return;
    const hidden = goal === undefined || goal.status === "cleared";
    const next = hidden ? undefined : summarize(goal, this.#port.now());
    const encoded = next === undefined ? "" : JSON.stringify(next);
    if (this.#last.get(sessionID) === encoded)
      return;
    this.#last.set(sessionID, encoded);
    let before;
    try {
      before = await this.#port.readMetadata(sessionID);
      const merged = { ...before ?? {} };
      if (next === undefined)
        delete merged[GOAL_METADATA_KEY];
      else
        merged[GOAL_METADATA_KEY] = next;
      if (before === undefined && next === undefined)
        return;
      await this.#port.writeMetadata(sessionID, merged);
    } catch (error) {
      this.#last.delete(sessionID);
      this.#port.warn(`goal: could not publish the session summary — ${describe2(error)}`);
      return;
    }
    try {
      const after = await this.#port.readMetadata(sessionID);
      const landed = next === undefined ? after?.[GOAL_METADATA_KEY] === undefined : isSameSummary(after?.[GOAL_METADATA_KEY], next);
      if (!landed) {
        this.#unsupported = true;
        this.#last.clear();
        this.#port.warn("goal: this OpenCode version accepts a session metadata patch but does not apply it " + "(observed on 2.0.16), so the goal cannot be shown in clients that only read session metadata. " + 'The transcript and the goal RPC are unaffected. Set "mirrorToSessionMetadata": false to silence this.');
      }
    } catch {}
  }
  invalidate(sessionID) {
    this.#last.delete(sessionID);
  }
}
function isSameSummary(value, expected) {
  if (!value || typeof value !== "object")
    return false;
  const record = value;
  return record.status === expected.status && record.updatedAt === expected.updatedAt && record.usedTurns === expected.usedTurns;
}
function describe2(error) {
  if (error instanceof Error)
    return error.message;
  if (typeof error === "string")
    return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

// src/options.ts
var DEFAULT_OPTIONS = {
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
  mirrorToSessionMetadata: true,
  answerLifecycleImmediately: true
};
var LIMITS = {
  defaultMaxTurns: [1, 1e4],
  defaultMaxMinutes: [1, 60 * 24 * 30],
  continuationDelayMs: [0, 10 * 60000],
  maxNotes: [1, 5000],
  maxNoToolStreak: [1, 100]
};
function bool(value, fallback) {
  if (typeof value === "boolean")
    return value;
  if (value === "true")
    return true;
  if (value === "false")
    return false;
  return fallback;
}
function int(value, range, fallback) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(parsed))
    return fallback;
  const rounded = Math.floor(parsed);
  if (rounded < range[0])
    return fallback;
  if (rounded > range[1])
    return range[1];
  return rounded;
}
function name(value, fallback) {
  if (typeof value !== "string")
    return fallback;
  const trimmed = value.trim().replace(/^\/+/, "");
  if (!trimmed)
    return fallback;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(trimmed))
    return fallback;
  return trimmed.toLowerCase();
}
function list(value, fallback) {
  if (Array.isArray(value)) {
    const cleaned = value.filter((item) => typeof item === "string").map((item) => item.trim().toLowerCase()).filter((item) => item.length > 0);
    return cleaned.length > 0 ? [...new Set(cleaned)] : fallback;
  }
  if (typeof value === "string") {
    const cleaned = value.split(/[,\s]+/).map((item) => item.trim().toLowerCase()).filter((item) => item.length > 0);
    return cleaned.length > 0 ? [...new Set(cleaned)] : fallback;
  }
  return fallback;
}
function normalizeOptions(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
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
    mirrorToSessionMetadata: bool(input.mirrorToSessionMetadata, DEFAULT_OPTIONS.mirrorToSessionMetadata),
    answerLifecycleImmediately: bool(input.answerLifecycleImmediately, DEFAULT_OPTIONS.answerLifecycleImmediately)
  };
}

// src/rpc.ts
var goalSchema = {
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
          blocker: { type: "string" }
        },
        required: ["at", "status"],
        additionalProperties: false
      }
    },
    summary: { type: "string" },
    evidence: { type: "string" },
    blocker: { type: "string" }
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
    "notes"
  ],
  additionalProperties: false
};
var nullableGoal = {
  anyOf: [{ type: "null" }, goalSchema]
};
var actions = ["status", "pause", "resume", "clear", "budget", "continue-once"];
var GoalRpc = {
  id: "goal",
  methods: {
    get: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: { goal: nullableGoal },
        required: ["goal"],
        additionalProperties: false
      }
    },
    list: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: { goals: { type: "array", items: goalSchema } },
        required: ["goals"],
        additionalProperties: false
      }
    },
    act: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          action: { type: "string", enum: [...actions] },
          turns: { type: "number" }
        },
        required: ["sessionID", "action"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: { goal: nullableGoal, message: { type: "string" } },
        required: ["goal", "message"],
        additionalProperties: false
      },
      errors: {
        unknown_action: {
          type: "object",
          properties: { action: { type: "string" } },
          required: ["action"],
          additionalProperties: false
        }
      }
    }
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          status: { type: "string" },
          updatedAt: { type: "number" }
        },
        required: ["sessionID", "status", "updatedAt"],
        additionalProperties: false
      }
    }
  }
};
function isGoalAction(value) {
  return typeof value === "string" && actions.includes(value);
}

// src/parse.ts
var WHOLE_ARGUMENT = {
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
  usage: "help"
};
var LEADING_VERB = {
  set: "set",
  edit: "edit",
  amend: "edit",
  draft: "draft",
  budget: "budget",
  limit: "budget"
};
function stripCommandPrefix(text, commandName = "goal") {
  let value = text.trim();
  const lowered = value.toLowerCase();
  if (!lowered.startsWith(`/${commandName}`) && !lowered.startsWith(`${commandName} `) && lowered !== commandName) {}
  if (lowered.startsWith(`/${commandName}`)) {
    value = value.slice(commandName.length + 1);
  } else if (lowered.startsWith(`${commandName} `) || lowered === commandName) {
    value = value.slice(commandName.length);
  }
  return value.replace(/^[:\s]+/, "").trim();
}
function tokenize(input) {
  const tokens = [];
  let current = "";
  let quote;
  let escaped = false;
  let started = false;
  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote === '"') {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote)
        quote = undefined;
      else
        current += char;
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started)
    tokens.push(current);
  return tokens;
}
function parseInt10(value) {
  if (value === undefined)
    return;
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed))
    return;
  return Math.floor(parsed);
}
function extractFlags(tokens) {
  const flags = { noAutostart: false, noAutostartContinuation: false };
  const rest = [];
  for (let index = 0;index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      rest.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name2 = (eq === -1 ? token : token.slice(0, eq)).slice(2).toLowerCase();
    let value = eq === -1 ? undefined : token.slice(eq + 1);
    switch (name2) {
      case "turns":
      case "max-turns":
      case "budget": {
        if (value === undefined)
          value = tokens[++index];
        const parsed = parseInt10(value);
        if (parsed !== undefined)
          flags.maxTurns = parsed;
        break;
      }
      case "minutes":
      case "max-minutes": {
        if (value === undefined)
          value = tokens[++index];
        const parsed = parseInt10(value);
        if (parsed !== undefined)
          flags.maxMinutes = parsed;
        break;
      }
      case "verify":
      case "verification":
      case "evidence":
        if (value === undefined)
          value = tokens[++index];
        if (value !== undefined)
          flags.verification = value;
        break;
      case "constraints":
      case "constraint":
        if (value === undefined)
          value = tokens[++index];
        if (value !== undefined)
          flags.constraints = value;
        break;
      case "boundaries":
      case "boundary":
      case "scope":
        if (value === undefined)
          value = tokens[++index];
        if (value !== undefined)
          flags.boundaries = value;
        break;
      case "iterate":
      case "iteration":
        if (value === undefined)
          value = tokens[++index];
        if (value !== undefined)
          flags.iteration = value;
        break;
      case "blocked":
      case "blocked-stop":
      case "stop-when":
        if (value === undefined)
          value = tokens[++index];
        if (value !== undefined)
          flags.blockedStop = value;
        break;
      case "no-start":
      case "no-autostart":
        flags.noAutostart = true;
        break;
      case "no-continue":
      case "no-autocontinue":
        flags.noAutostartContinuation = true;
        break;
      default:
        rest.push(token);
        if (value !== undefined)
          rest.push(value);
        break;
    }
  }
  return { flags, rest };
}
function parseGoalCommand(rawText, commandName = "goal") {
  const text = stripCommandPrefix(rawText, commandName);
  if (!text)
    return { kind: "status", remainder: "", flags: emptyFlags() };
  const lowered = text.toLowerCase();
  const whole = WHOLE_ARGUMENT[lowered];
  if (whole)
    return { kind: whole, remainder: "", flags: emptyFlags() };
  if (lowered === "budget" || lowered === "limit")
    return { kind: "budget", value: undefined };
  const tokens = tokenize(text);
  const head = tokens[0];
  const firstWord = head === undefined ? "" : head.toLowerCase();
  const verb = LEADING_VERB[firstWord];
  const restTokens = tokens.slice(1);
  if (verb === "budget") {
    const { flags: flags2 } = extractFlags(restTokens);
    const value = flags2.maxTurns ?? parseInt10(restTokens[0]);
    if (value !== undefined)
      return { kind: "budget", value };
    const whole2 = extractFlags(tokens);
    return { kind: "set", remainder: whole2.rest.join(" ").trim(), flags: whole2.flags };
  }
  if (verb === "edit" || verb === "draft") {
    const { rest: rest2 } = extractFlags(restTokens);
    return { kind: verb, remainder: rest2.join(" ").trim() };
  }
  if (verb === "set") {
    const { flags: flags2, rest: rest2 } = extractFlags(restTokens);
    return { kind: "set", remainder: rest2.join(" ").trim(), flags: flags2 };
  }
  const { flags, rest } = extractFlags(tokens);
  return { kind: "set", remainder: rest.join(" ").trim(), flags };
}
function emptyFlags() {
  return { noAutostart: false, noAutostartContinuation: false };
}
function draftFromParsed(parsed, previous) {
  const carry = (next, fallback) => next && next.trim() ? next : fallback && fallback.trim() ? fallback : undefined;
  return {
    objective: parsed.remainder,
    verification: carry(parsed.flags.verification, previous?.verification),
    constraints: carry(parsed.flags.constraints, previous?.constraints),
    boundaries: carry(parsed.flags.boundaries, previous?.boundaries),
    iteration: carry(parsed.flags.iteration, previous?.iteration),
    blockedStop: carry(parsed.flags.blockedStop, previous?.blockedStop),
    maxTurns: parsed.flags.maxTurns,
    maxMinutes: parsed.flags.maxMinutes
  };
}
var HELP_TEXT = [
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
  '`--verify "…"` · `--constraints "…"` · `--boundaries "…"` · `--iterate "…"` ·',
  '`--blocked "…"` · `--no-start` (install without starting a turn) ·',
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
  "the loop durable; it does not grant authority."
].join(`
`);

// src/commands.ts
function registerGoalCommand(deps) {
  const { host, options } = deps;
  host.command.transform((editor) => {
    editor.add({
      name: options.commandName,
      description: "Work autonomously toward one durable objective until the evidence says it is done. `/goal <outcome>` starts it; bare `/goal` shows the current one.",
      execute: async (invocation) => {
        await runGoalCommand(deps, invocation);
      }
    });
  });
}
async function runGoalCommand(deps, invocation) {
  const { host, engine, options } = deps;
  const sessionID = invocation.sessionID;
  const raw = typeof invocation.prompt?.text === "string" ? invocation.prompt.text : "";
  const parsed = parseGoalCommand(raw, options.commandName);
  try {
    switch (parsed.kind) {
      case "help":
        return report(deps, sessionID, HELP_TEXT);
      case "status": {
        const { text } = await engine.report(sessionID);
        return report(deps, sessionID, text);
      }
      case "history": {
        const { text } = await engine.history(sessionID);
        return report(deps, sessionID, text);
      }
      case "pause": {
        const result = await engine.pause(sessionID);
        return report(deps, sessionID, result.message);
      }
      case "resume": {
        const result = await engine.resume(sessionID);
        await report(deps, sessionID, result.message);
        if (result.goal?.status === "active" && remainingTurnsOf(result.goal) > 0) {
          await engine.onIdle(sessionID);
        }
        return;
      }
      case "clear": {
        const result = await engine.clear(sessionID);
        return report(deps, sessionID, result.message);
      }
      case "budget": {
        const result = await engine.setBudget(sessionID, parsed.value);
        return report(deps, sessionID, result.message);
      }
      case "draft": {
        if (!parsed.remainder) {
          return report(deps, sessionID, "`/goal draft` needs a subject, e.g. `/goal draft migrate this repo off the legacy build`.");
        }
        return submit(host, sessionID, draftPrompt(parsed.remainder), "user");
      }
      case "edit": {
        if (!parsed.remainder) {
          return report(deps, sessionID, "`/goal edit` needs the new objective text, e.g. `/goal edit narrow it to the parser only`.");
        }
        const result = await engine.edit(sessionID, parsed.remainder);
        await report(deps, sessionID, result.message);
        if (result.prompt)
          return submit(host, sessionID, result.prompt.text, result.prompt.origin);
        return;
      }
      case "set":
        return startGoal(deps, sessionID, parsed);
      default:
        return report(deps, sessionID, NO_GOAL_REPORT);
    }
  } catch (error) {
    await report(deps, sessionID, `The goal command failed: ${describe3(error)}

Nothing was changed and the session is unaffected.`);
  }
}
async function startGoal(deps, sessionID, parsed) {
  const { host, engine } = deps;
  if (!parsed.remainder) {
    const { text } = await engine.report(sessionID, { history: true });
    await report(deps, sessionID, text);
    return;
  }
  const previous = await engine.get(sessionID);
  const result = await engine.activate(sessionID, {
    ...draftFromParsed(parsed, previous),
    start: false,
    autoContinue: parsed.flags.noAutostartContinuation !== true
  });
  const goal = result.goal;
  if (!goal) {
    await report(deps, sessionID, NO_GOAL_REPORT);
    return;
  }
  const summary = result.message;
  if (parsed.flags.noAutostart === true) {
    await report(deps, sessionID, `${summary}

Installed without starting a turn. Run \`/goal resume\` when you want the agent to begin.`);
    return;
  }
  const headline = [
    summary,
    "",
    "The contract above is now active for this session. It is injected into every model call, so",
    `it survives compaction. Budget: ${goal.budget.maxTurns} automatic turns, ${Math.round(goal.budget.maxMs / 60000)} minutes.`,
    "It keeps going on its own until the finish line is met, you pause it, or the budget runs out.",
    ""
  ].join(`
`);
  await report(deps, sessionID, headline);
  await submit(host, sessionID, activationPrompt(goal), "activation");
}
function remainingTurnsOf(goal) {
  return Math.max(0, goal.budget.maxTurns - goal.budget.usedTurns);
}
async function report(deps, sessionID, text) {
  try {
    await deps.host.session.synthetic({
      sessionID,
      text,
      description: "goal",
      delivery: "queue",
      resume: deps.options.answerLifecycleImmediately,
      metadata: { [GOAL_METADATA]: "notice" }
    });
  } catch (error) {
    console.error(`[opencode-goal] ${describe3(error)}`);
  }
}
async function submit(host, sessionID, text, origin) {
  try {
    await host.session.prompt({
      sessionID,
      text,
      delivery: "queue",
      metadata: { [GOAL_METADATA]: origin }
    });
  } catch (error) {
    console.error(`[opencode-goal] could not submit the ${origin} turn — ${describe3(error)}`);
  }
}
function describe3(error) {
  if (error instanceof Error)
    return error.message;
  if (typeof error === "string")
    return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

// src/tools.ts
var JSON_OBJECT = { type: "object" };
function registerGoalTools(deps) {
  const { tool, engine, namespace } = deps;
  tool.transform((editor) => {
    editor.namespace({
      name: namespace,
      description: "Durable goals for this session. Use these to start a persistent objective, record each iteration, and declare completion or a blocker against real evidence."
    });
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
        "step depends on what you learn along the way."
      ].join(`
`),
      input: {
        ...JSON_OBJECT,
        properties: {
          objective: {
            type: "string",
            description: "What must be true when the work is done. Concrete enough to check."
          },
          verification: {
            type: "string",
            description: "The evidence that proves the outcome: a test command, benchmark, or artifact."
          },
          constraints: { type: "string", description: "What must not regress while working." },
          boundaries: { type: "string", description: "Files, tools, data, or systems in scope." },
          iteration: { type: "string", description: "How to pick the next action after each attempt." },
          blockedStop: { type: "string", description: "When to stop and report instead of continuing." },
          maxTurns: { type: "number", description: "Automatic turns the goal may use. Defaults to the configured budget." },
          maxMinutes: { type: "number", description: "Wall-clock ceiling in minutes. Defaults to the configured budget." }
        },
        required: ["objective"],
        additionalProperties: false
      },
      execute: async (input, context) => {
        const parsed = asRecord(input);
        const objective = str2(parsed.objective);
        if (!objective) {
          return text("A goal needs an objective. Describe what must be true when the work is done.");
        }
        const result = await engine.activate(context.sessionID, {
          objective,
          verification: optStr2(parsed.verification),
          constraints: optStr2(parsed.constraints),
          boundaries: optStr2(parsed.boundaries),
          iteration: optStr2(parsed.iteration),
          blockedStop: optStr2(parsed.blockedStop),
          maxTurns: num2(parsed.maxTurns),
          maxMinutes: num2(parsed.maxMinutes),
          start: false
        });
        if (!result.goal)
          return text(result.message);
        context.progress({ phase: "goal", status: "active", title: result.goal.title });
        return text(`${result.message}

The goal is active. Begin with the smallest useful step.`);
      }
    });
    editor.add({
      name: "status",
      options: { namespace },
      description: "Read the current session's goal, its completion contract, its budget, and the last few ledger entries. Read-only.",
      input: { ...JSON_OBJECT, properties: {}, additionalProperties: false },
      execute: async (_input, context) => {
        const { goal, text: report2 } = await engine.report(context.sessionID, { history: true });
        return text(report2, { goalID: goal?.id });
      }
    });
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
        "- You cannot pause, resume, edit, or clear a goal. Those belong to the user: `/goal`."
      ].join(`
`),
      input: {
        ...JSON_OBJECT,
        properties: {
          status: {
            type: "string",
            enum: ["working", "complete", "blocked"],
            description: 'What to record. Defaults to "working".'
          },
          note: { type: "string", description: "What this iteration did." },
          evidence: { type: "string", description: "The concrete evidence checked: command output, test result, benchmark number." },
          next: { type: "string", description: "The next action to take." },
          summary: { type: "string", description: 'For "complete": what is now true.' },
          blocker: { type: "string", description: 'For "blocked": what is stopping progress.' }
        },
        required: [],
        additionalProperties: false
      },
      execute: async (input, context) => {
        const parsed = asRecord(input);
        const status = str2(parsed.status) || "working";
        if (status === "complete") {
          const result2 = await engine.recordComplete(context.sessionID, {
            summary: optStr2(parsed.summary),
            evidence: optStr2(parsed.evidence)
          });
          context.progress({ phase: "goal", status: result2.goal?.status ?? "complete" });
          return text(result2.message);
        }
        if (status === "blocked") {
          const result2 = await engine.recordBlocked(context.sessionID, {
            blocker: optStr2(parsed.blocker),
            next: optStr2(parsed.next),
            summary: optStr2(parsed.summary)
          });
          context.progress({ phase: "goal", status: result2.goal?.status ?? "blocked" });
          return text(result2.message);
        }
        const result = await engine.recordWorking(context.sessionID, {
          note: optStr2(parsed.note),
          evidence: optStr2(parsed.evidence),
          next: optStr2(parsed.next)
        });
        return text(result.message);
      }
    });
  });
}
function text(content, metadata) {
  return metadata ? { content, metadata } : { content };
}
function asRecord(value) {
  return value && typeof value === "object" ? value : {};
}
function str2(value) {
  return typeof value === "string" ? value.trim() : "";
}
function optStr2(value) {
  const trimmed = str2(value);
  return trimmed ? trimmed : undefined;
}
function num2(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// src/index.ts
var PLUGIN_ID = "opencode.goal";
var goalPlugin = {
  id: PLUGIN_ID,
  async setup(ctx) {
    const options = normalizeOptions({ ...await readFileOptions(), ...ctx.options });
    if (!options.enabled)
      return;
    const emitter = { emit: async () => {
      return;
    } };
    const mirror = options.mirrorToSessionMetadata ? new GoalMirror({
      readMetadata: async (sessionID) => {
        const info = await ctx.session.get({ sessionID });
        const metadata = info?.metadata;
        return metadata && typeof metadata === "object" ? metadata : undefined;
      },
      writeMetadata: async (sessionID, metadata) => {
        await ctx.session.update({ sessionID, metadata });
      },
      warn,
      now: () => Date.now()
    }) : undefined;
    const engine = new GoalEngine(createPort(ctx, emitter, mirror), options);
    registerGoalTools({ tool: ctx.tool, session: ctx.session, engine, namespace: "goal" });
    registerGoalCommand({ host: { storage: ctx.storage, command: ctx.command, session: ctx.session }, engine, options });
    if (options.injectGoal) {
      const inject = async (event) => {
        const goal = await engine.get(event.sessionID);
        if (!goal || goal.status === "cleared")
          return;
        const system = event.system;
        if (!Array.isArray(system))
          return;
        if (system.some((part) => typeof part?.text === "string" && part.text.includes(ACTIVE_GOAL_MARKER)))
          return;
        try {
          system.push({ type: "text", text: goalSystemBlock(goal) });
        } catch {}
      };
      await ctx.session.hook("context", (event) => void inject(event).catch(warn));
      await ctx.session.hook("compaction", (event) => void inject(event).catch(warn));
      await ctx.session.hook("generate", (event) => void inject(event).catch(warn));
    }
    await ctx.session.hook("prompt", (event) => {
      if (readOrigin(event.metadata) === "continuation")
        return;
      engine.onUserPrompt(event.sessionID).catch(warn);
    });
    const controller = new AbortController;
    (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          dispatchEvent(engine, mirror, event);
        }
      } catch (error) {
        if (!controller.signal.aborted)
          warn(error);
      }
    })();
    const registration = await ctx.rpc.register(GoalRpc, {
      get: async (input) => {
        const goal = await engine.get(input.sessionID);
        return { goal: goal ? project(goal, Date.now()) : null };
      },
      list: async () => {
        const now = Date.now();
        const goals = await engine.store.list();
        return { goals: goals.filter((goal) => goal.status !== "cleared").map((goal) => project(goal, now)) };
      },
      act: async (input, call) => {
        const raw = input;
        if (!isGoalAction(raw.action)) {
          return call.error("unknown_action", `Unknown goal action: ${raw.action}`, { action: raw.action });
        }
        const result = await performAction(engine, raw.sessionID, raw.action, raw.turns);
        return { goal: result.goal ? project(result.goal, Date.now()) : null, message: result.message };
      }
    });
    emitter.emit = async (sessionID, status, updatedAt) => {
      try {
        await registration.events.emit("changed", { sessionID, status, updatedAt });
      } catch {}
    };
    return async () => {
      controller.abort();
      await registration.dispose().catch(() => {
        return;
      });
    };
  }
};
var src_default = goalPlugin;
var ACTIVE_GOAL_MARKER = "ACTIVE GOAL (opencode-goal-plugin)";
async function readFileOptions() {
  let here;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    return;
  }
  const dirs = [here, join(here, "..")];
  const names = ["goal.config.json", "goal.config.local.json"];
  const found = [];
  for (const name2 of names) {
    for (const dir of dirs) {
      try {
        const text2 = await readFile(join(dir, name2), "utf8");
        const parsed = JSON.parse(text2);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          found.push(parsed);
        }
        break;
      } catch {}
    }
  }
  return found.length > 0 ? mergeOptionSources(found) : undefined;
}
function mergeOptionSources(sources) {
  return Object.assign({}, ...sources);
}
function dispatchEvent(engine, mirror, event) {
  const sessionID = readSessionID(event);
  if (!sessionID)
    return;
  switch (event.type) {
    case "session.idle":
      engine.onIdle(sessionID).catch(warn);
      return;
    case "session.execution.interrupted":
      engine.onInterrupted(sessionID).catch(warn);
      return;
    case "session.deleted":
      mirror?.invalidate(sessionID);
      engine.forget(sessionID).catch(warn);
      return;
    case "session.tool.called":
    case "session.tool.success":
    case "session.tool.failed":
      engine.markToolCall(sessionID);
      return;
    case "session.inbox.enqueued": {
      const data = event.data;
      const inboxID = typeof data.inboxID === "string" ? data.inboxID : undefined;
      if (inboxID)
        engine.trackEnqueued(sessionID, inboxID, isOwnNotice(data.item));
      return;
    }
    case "session.inbox.delivered":
    case "session.inbox.cancelled": {
      const inboxID = event.data.inboxID;
      if (typeof inboxID === "string")
        engine.trackSettled(sessionID, inboxID);
      return;
    }
    default:
  }
}
async function performAction(engine, sessionID, action, turns) {
  switch (action) {
    case "status": {
      const { goal, text: text2 } = await engine.report(sessionID, { history: true });
      return { goal, message: text2 };
    }
    case "pause":
      return engine.pause(sessionID, "paused from an external client");
    case "resume": {
      const result = await engine.resume(sessionID);
      if (result.goal?.status === "active" && remainingTurns(result.goal) > 0)
        await engine.onIdle(sessionID);
      return result;
    }
    case "clear":
      return engine.clear(sessionID);
    case "budget":
      return engine.setBudget(sessionID, turns);
    case "continue-once": {
      await engine.onIdle(sessionID);
      const { goal, text: text2 } = await engine.report(sessionID);
      return { goal, message: text2 };
    }
    default:
      return { goal: undefined, message: "unsupported action" };
  }
}
function createPort(ctx, emitter, mirror) {
  return {
    storage: ctx.storage,
    async sessionInfo(sessionID) {
      const info = await ctx.session.get({ sessionID });
      return { agent: info?.agent };
    },
    async prompt(input) {
      await ctx.session.prompt({
        sessionID: input.sessionID,
        text: input.text,
        delivery: input.delivery,
        metadata: { [GOAL_METADATA]: input.origin }
      });
    },
    async note(input) {
      await ctx.session.synthetic({
        sessionID: input.sessionID,
        text: input.text,
        description: input.description,
        delivery: "queue",
        resume: false,
        metadata: { [GOAL_METADATA]: "notice" }
      });
    },
    async changed(goal, sessionID) {
      if (mirror)
        await mirror.publish(sessionID, goal);
      await emitter.emit(sessionID, goal?.status ?? "cleared", goal?.updatedAt ?? Date.now());
    },
    warn,
    now: () => Date.now()
  };
}
function project(goal, now) {
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
      const entry = { at: note.at, status: note.status };
      if (note.note)
        entry.note = note.note;
      if (note.evidence)
        entry.evidence = note.evidence;
      if (note.next)
        entry.next = note.next;
      if (note.blocker)
        entry.blocker = note.blocker;
      return entry;
    }),
    ...goal.summary ? { summary: goal.summary } : {},
    ...goal.evidence ? { evidence: goal.evidence } : {},
    ...goal.blocker ? { blocker: goal.blocker } : {}
  };
}
function readOrigin(metadata) {
  if (!metadata || typeof metadata !== "object")
    return;
  const value = metadata[GOAL_METADATA];
  if (value === "continuation" || value === "activation" || value === "user")
    return value;
  return;
}
function readSessionID(event) {
  const data = event.data;
  if (!data || typeof data !== "object")
    return;
  const sessionID = data.sessionID;
  return typeof sessionID === "string" && sessionID ? sessionID : undefined;
}
function isOwnNotice(item) {
  if (!item || typeof item !== "object")
    return false;
  const payload = item.payload;
  const metadata = payload?.metadata;
  if (!metadata || typeof metadata !== "object")
    return false;
  return metadata[GOAL_METADATA] === "notice";
}
function warn(error) {
  console.error(`[opencode-goal] ${error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error"}`);
}
export {
  normalizeOptions,
  mergeOptionSources,
  src_default as default,
  PLUGIN_ID,
  GoalRpc,
  GoalEngine
};
