import { describe, expect, test } from "bun:test"
import { parseGoalCommand, stripCommandPrefix, tokenize, draftFromParsed, HELP_TEXT } from "../src/parse.ts"

describe("stripCommandPrefix", () => {
  test("removes the slash invocation in every form the host may pass", () => {
    expect(stripCommandPrefix("/goal fix the flaky test")).toBe("fix the flaky test")
    expect(stripCommandPrefix("/goal: fix the flaky test")).toBe("fix the flaky test")
    expect(stripCommandPrefix("goal fix the flaky test")).toBe("fix the flaky test")
    expect(stripCommandPrefix("/goal")).toBe("")
    expect(stripCommandPrefix("  /goal   pause  ")).toBe("pause")
  })

  test("leaves text that is not an invocation alone", () => {
    expect(stripCommandPrefix("make the goal bigger")).toBe("make the goal bigger")
  })
})

describe("tokenize", () => {
  test("keeps quoted text together", () => {
    expect(tokenize(`verify "all 42 checks pass" and stop`)).toEqual(["verify", "all 42 checks pass", "and", "stop"])
    expect(tokenize(`verify 'single quoted'`)).toEqual(["verify", "single quoted"])
  })

  test("handles escaped quotes and empty quoted strings", () => {
    expect(tokenize(`a "say \\"hi\\"" b`)).toEqual(["a", 'say "hi"', "b"])
    expect(tokenize(`a "" b`)).toEqual(["a", "", "b"])
  })
})

describe("parseGoalCommand", () => {
  test("bare invocation reports status", () => {
    expect(parseGoalCommand("/goal").kind).toBe("status")
    expect(parseGoalCommand("").kind).toBe("status")
  })

  test("a lifecycle word alone is the command", () => {
    expect(parseGoalCommand("/goal status").kind).toBe("status")
    expect(parseGoalCommand("/goal show").kind).toBe("status")
    expect(parseGoalCommand("/goal pause").kind).toBe("pause")
    expect(parseGoalCommand("/goal stop").kind).toBe("pause")
    expect(parseGoalCommand("/goal resume").kind).toBe("resume")
    expect(parseGoalCommand("/goal continue").kind).toBe("resume")
    expect(parseGoalCommand("/goal clear").kind).toBe("clear")
    expect(parseGoalCommand("/goal reset").kind).toBe("clear")
    expect(parseGoalCommand("/goal help").kind).toBe("help")
    expect(parseGoalCommand("/goal history").kind).toBe("history")
    expect(parseGoalCommand("/goal PAUSE").kind).toBe("pause")
  })

  test("a lifecycle word followed by words is part of the objective", () => {
    // The whole point of the rule: a goal may start with any word at all.
    for (const [input, objective] of [
      ["/goal stop the flaky checkout test", "stop the flaky checkout test"],
      ["/goal reset the database", "reset the database"],
      ["/goal remove the legacy shim", "remove the legacy shim"],
      ["/goal continue the migration until green", "continue the migration until green"],
      ["/goal plan the release", "plan the release"],
      ["/goal run the benchmark suite", "run the benchmark suite"],
      ["/goal status endpoint should not 500", "status endpoint should not 500"],
      ["/goal drop the connection pool", "drop the connection pool"],
      ["/goal update the docs for the parser", "update the docs for the parser"],
    ] as const) {
      const parsed = parseGoalCommand(input)
      expect(parsed.kind).toBe("set")
      if (parsed.kind === "set") expect(parsed.remainder).toBe(objective)
    }
  })

  test("an unrecognised first word is part of the objective", () => {
    const parsed = parseGoalCommand("/goal reduce p95 latency below 120ms")
    expect(parsed.kind).toBe("set")
    if (parsed.kind === "set") expect(parsed.remainder).toBe("reduce p95 latency below 120ms")
  })

  test("leading verbs that take an argument still work", () => {
    const edit = parseGoalCommand("/goal edit a narrower objective")
    expect(edit.kind).toBe("edit")
    const draft = parseGoalCommand("/goal draft migrate off the legacy build")
    expect(draft.kind).toBe("draft")
    const set = parseGoalCommand("/goal set stop the flakiness")
    expect(set.kind).toBe("set")
    if (set.kind === "set") expect(set.remainder).toBe("stop the flakiness")
  })

  test("budget without a number is an objective, not a broken command", () => {
    const parsed = parseGoalCommand("/goal budget the p95 until it drops")
    expect(parsed.kind).toBe("set")
    if (parsed.kind === "set") expect(parsed.remainder).toBe("budget the p95 until it drops")
  })

  test("set reads the full contract from flags", () => {
    const parsed = parseGoalCommand(
      `/goal migrate to bun --verify "bun test exits 0" --constraints "no API change" --boundaries "packages/api" --iterate "one package per turn" --blocked "the test harness will not run" --turns 12 --minutes 90`,
    )
    expect(parsed.kind).toBe("set")
    if (parsed.kind !== "set") throw new Error("expected set")
    expect(parsed.remainder).toBe("migrate to bun")
    expect(parsed.flags.verification).toBe("bun test exits 0")
    expect(parsed.flags.constraints).toBe("no API change")
    expect(parsed.flags.boundaries).toBe("packages/api")
    expect(parsed.flags.iteration).toBe("one package per turn")
    expect(parsed.flags.blockedStop).toBe("the test harness will not run")
    expect(parsed.flags.maxTurns).toBe(12)
    expect(parsed.flags.maxMinutes).toBe(90)
  })

  test("flags accept the equals form, and a value with spaces still needs quotes", () => {
    const parsed = parseGoalCommand(`/goal ship it --turns=4 --verify="tests pass"`)
    if (parsed.kind !== "set") throw new Error("expected set")
    expect(parsed.flags.maxTurns).toBe(4)
    expect(parsed.flags.verification).toBe("tests pass")
    expect(parsed.remainder).toBe("ship it")

    // Shell-style: without quotes the value ends at the first space.
    const bare = parseGoalCommand(`/goal ship it --verify=tests pass`)
    if (bare.kind !== "set") throw new Error("expected set")
    expect(bare.flags.verification).toBe("tests")
    expect(bare.remainder).toBe("ship it pass")
  })

  test("autostart switches", () => {
    const noStart = parseGoalCommand("/goal do the thing --no-start")
    if (noStart.kind !== "set") throw new Error("expected set")
    expect(noStart.flags.noAutostart).toBe(true)
    expect(noStart.remainder).toBe("do the thing")

    const noContinue = parseGoalCommand("/goal do the thing --no-continue")
    if (noContinue.kind !== "set") throw new Error("expected set")
    expect(noContinue.flags.noAutostartContinuation).toBe(true)
  })

  test("an unknown flag is kept in the objective instead of being swallowed", () => {
    const parsed = parseGoalCommand("/goal fix the --weird-parser bug")
    if (parsed.kind !== "set") throw new Error("expected set")
    expect(parsed.remainder).toContain("--weird-parser")
  })

  test("budget reads a count from either position", () => {
    expect(parseGoalCommand("/goal budget 30")).toEqual({ kind: "budget", value: 30 })
    expect(parseGoalCommand("/goal budget --turns 12")).toEqual({ kind: "budget", value: 12 })
    expect(parseGoalCommand("/goal budget 30 --minutes 90")).toEqual({ kind: "budget", value: 30 })
  })

  test("budget with no count asks for one instead of creating a goal", () => {
    expect(parseGoalCommand("/goal budget")).toEqual({ kind: "budget", value: undefined })
    expect(parseGoalCommand("/goal limit")).toEqual({ kind: "budget", value: undefined })
  })

  test("edit and draft keep the rest verbatim", () => {
    const edit = parseGoalCommand(`/goal edit narrow it to the parser only, keep the public API`)
    expect(edit.kind).toBe("edit")
    if (edit.kind === "edit") expect(edit.remainder).toBe("narrow it to the parser only, keep the public API")

    const draft = parseGoalCommand("/goal draft migrate the repo off the legacy build")
    if (draft.kind === "draft") expect(draft.remainder).toBe("migrate the repo off the legacy build")
    else throw new Error("expected draft")
  })

  test("a custom command name is honoured", () => {
    expect(parseGoalCommand("/mission ship it", "mission").kind).toBe("set")
    expect(parseGoalCommand("/mission", "mission").kind).toBe("status")
    expect(parseGoalCommand("/mission stop", "mission").kind).toBe("pause")
  })
})

describe("draftFromParsed", () => {
  test("carries the previous contract forward when a flag is omitted", () => {
    const parsed = parseGoalCommand("/goal a sharper objective")
    if (parsed.kind !== "set") throw new Error("expected set")
    const draft = draftFromParsed(parsed, {
      verification: "bun test",
      constraints: "no API change",
      boundaries: "",
      iteration: "",
      blockedStop: "",
    })
    expect(draft.objective).toBe("a sharper objective")
    expect(draft.verification).toBe("bun test")
    expect(draft.constraints).toBe("no API change")
    expect(draft.boundaries).toBeUndefined()
  })

  test("an explicit flag wins over the previous value", () => {
    const parsed = parseGoalCommand(`/goal new objective --verify "vitest exits 0"`)
    if (parsed.kind !== "set") throw new Error("expected set")
    const draft = draftFromParsed(parsed, {
      verification: "bun test",
      constraints: "",
      boundaries: "",
      iteration: "",
      blockedStop: "",
    })
    expect(draft.verification).toBe("vitest exits 0")
  })
})

describe("HELP_TEXT", () => {
  test("documents every subcommand the parser accepts", () => {
    for (const verb of ["pause", "resume", "clear", "edit", "budget", "history", "draft", "help", "status"]) {
      expect(HELP_TEXT).toContain(verb)
    }
  })
})
