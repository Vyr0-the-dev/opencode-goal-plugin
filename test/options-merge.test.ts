/**
 * Configuration precedence.
 *
 * The merge order was wrong when it first shipped: goal.config.local.json was
 * read before goal.config.json, so the shipped file silently overwrote the
 * machine-specific override and the setting appeared to do nothing. Nothing
 * caught it because no test touched the order.
 */

import { describe, expect, test } from "bun:test"
import { mergeOptionSources } from "../src/index.ts"
import { normalizeOptions } from "../src/options.ts"

describe("mergeOptionSources", () => {
  test("a later source wins, key by key", () => {
    const merged = mergeOptionSources([{ a: 1, b: 2 }, { b: 3, c: 4 }])
    expect(merged).toEqual({ a: 1, b: 3, c: 4 })
  })

  test("a local override beats the shipped defaults", () => {
    const shipped = { answerLifecycleImmediately: false, defaultMaxTurns: 25, enabled: true }
    const local = { answerLifecycleImmediately: true }
    // Discovery order in the loader is shipped first, local last.
    const merged = mergeOptionSources([shipped, local])
    expect(merged.answerLifecycleImmediately).toBe(true)
    // Untouched keys still come from the shipped file.
    expect(merged.defaultMaxTurns).toBe(25)
    expect(merged.enabled).toBe(true)
  })

  test("the reverse order would clobber the override, which is the bug this guards", () => {
    const shipped = { answerLifecycleImmediately: false }
    const local = { answerLifecycleImmediately: true }
    expect(mergeOptionSources([local, shipped]).answerLifecycleImmediately).toBe(false)
  })

  test("an empty or single source behaves", () => {
    expect(mergeOptionSources([])).toEqual({})
    expect(mergeOptionSources([{ only: true }])).toEqual({ only: true })
  })

  test("merging never mutates its inputs", () => {
    const shipped = { a: 1 }
    const local = { b: 2 }
    mergeOptionSources([shipped, local])
    expect(shipped).toEqual({ a: 1 })
    expect(local).toEqual({ b: 2 })
  })
})

describe("merged sources normalise cleanly", () => {
  test("the shipped file alone yields the documented defaults", () => {
    const shipped = {
      defaultMaxTurns: 25,
      defaultMaxMinutes: 180,
      continuationDelayMs: 750,
      mirrorToSessionMetadata: true,
      answerLifecycleImmediately: false,
      enabled: true,
    }
    const options = normalizeOptions(mergeOptionSources([shipped]))
    expect(options.answerLifecycleImmediately).toBe(false)
    expect(options.defaultMaxTurns).toBe(25)
  })

  test("a local file can flip a boolean without disturbing the rest", () => {
    const shipped = { defaultMaxTurns: 12, answerLifecycleImmediately: false, enabled: true }
    const local = { answerLifecycleImmediately: true }
    const options = normalizeOptions(mergeOptionSources([shipped, local]))
    expect(options.answerLifecycleImmediately).toBe(true)
    expect(options.defaultMaxTurns).toBe(12)
    expect(options.enabled).toBe(true)
  })
})
