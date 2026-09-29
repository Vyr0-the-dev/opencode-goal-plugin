/**
 * The TUI answers `/goal` itself, so this router decides what the user sees.
 *
 * These tests exist because the interactive half cannot be clicked in CI, and
 * because the bug it fixes was exactly a routing mistake: every lifecycle verb
 * used to be answered by a server message that never reached the screen.
 */

import { describe, expect, test } from "bun:test"
import { planGoalUiAction } from "../src/ui-action.ts"

const withSession = (text: string) => planGoalUiAction({ text, hasSession: true })

describe("read-only verbs are answered in the client", () => {
  test.each(["", "status", "show", "info", "current", "view", "STATUS"])("`/goal %s` answers immediately", (text) => {
    expect(withSession(text)).toEqual({ kind: "answer", verb: "status" })
  })

  test.each(["history", "log", "ledger", "notes"])("`/goal %s` shows the ledger", (text) => {
    expect(withSession(text)).toEqual({ kind: "answer", verb: "history" })
  })

  test.each(["help", "usage"])("`/goal %s` shows help", (text) => {
    expect(withSession(text)).toEqual({ kind: "answer", verb: "help" })
  })
})

describe("lifecycle verbs are applied in the client", () => {
  test.each([
    ["pause", "pause"],
    ["stop", "pause"],
    ["hold", "pause"],
    ["resume", "resume"],
    ["continue", "resume"],
    ["restart", "resume"],
    ["clear", "clear"],
    ["reset", "clear"],
    ["remove", "clear"],
    ["delete", "clear"],
    ["drop", "clear"],
  ] as const)("`/goal %s` acts with %s", (text, action) => {
    expect(withSession(text)).toEqual({ kind: "act", action })
  })

  test("budget takes a turn count", () => {
    expect(withSession("budget 30")).toEqual({ kind: "act", action: "budget", turns: 30 })
    expect(withSession("budget --turns 12")).toEqual({ kind: "act", action: "budget", turns: 12 })
    expect(withSession("limit 5")).toEqual({ kind: "act", action: "budget", turns: 5 })
  })

  test("a budget with no usable count falls back to help instead of failing silently", () => {
    expect(withSession("budget")).toEqual({ kind: "answer", verb: "help" })
    expect(withSession("budget zero")).toEqual({ kind: "submit", text: "budget zero" })
  })
})

describe("work-changing input goes to the server", () => {
  test("a bare objective is submitted", () => {
    expect(withSession("cut p95 below 120ms")).toEqual({ kind: "submit", text: "cut p95 below 120ms" })
  })

  test("edit and draft are submitted with their argument", () => {
    expect(withSession("edit narrow it to the parser")).toEqual({ kind: "submit", text: "edit narrow it to the parser" })
    expect(withSession("draft migrate off the legacy build")).toEqual({ kind: "submit", text: "draft migrate off the legacy build" })
  })

  test("set strips the leading verb but keeps the objective", () => {
    expect(withSession("set stop the flakiness")).toEqual({ kind: "submit", text: "set stop the flakiness" })
  })
})

describe("a lifecycle word is only a command when it is the whole line", () => {
  test.each([
    "stop the flaky checkout test",
    "reset the database",
    "remove the legacy shim",
    "continue the migration until green",
    "status endpoint should not 500",
    "clear the cache and restart the worker",
  ])("`/goal %s` is an objective, not a command", (text) => {
    expect(withSession(text)).toEqual({ kind: "submit", text })
  })
})

describe("outside a session", () => {
  test("refuses instead of pretending, whatever was typed", () => {
    for (const text of ["", "status", "pause", "do the thing"]) {
      expect(planGoalUiAction({ text, hasSession: false })).toEqual({ kind: "refuse", reason: "no-session" })
    }
  })
})
