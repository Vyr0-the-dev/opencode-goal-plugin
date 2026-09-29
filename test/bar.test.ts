import { describe, expect, test } from "bun:test"
import { bar } from "../src/bar.ts"
import { isGoalOrigin, pauseReason, GoalRpc } from "../src/rpc.ts"

describe("bar", () => {
  // `░` is a dither pattern and renders as vertical stripes at this size, which
  // is what the progress row was showing. The assertion that would have caught
  // it is a character-level one, so that is what this is.
  const TRACK = "─"
  const FILL = "█"

  test("uses a solid line for the track, not a dithered shade", () => {
    expect(bar(0, 12)).toBe(TRACK.repeat(12))
    expect(bar(0, 12)).not.toContain("░")
  })

  test("renders a half-filled bar as fill then track", () => {
    expect(bar(50, 12)).toBe(FILL.repeat(6) + TRACK.repeat(6))
  })

  test("rounds the filled count and always fills exactly the requested width", () => {
    for (const percent of [0, 1, 33, 50, 66, 99, 100]) {
      expect([...bar(percent, 12)].length).toBe(12)
    }
    // 7% of 12 is 0.84 cells, which rounds down rather than showing one full block.
    expect(bar(7, 12)).toBe(FILL.repeat(1) + TRACK.repeat(11))
    expect(bar(8, 12)).toBe(FILL.repeat(1) + TRACK.repeat(11))
  })

  test("clamps out-of-range percentages instead of overflowing or inverting", () => {
    expect(bar(-20, 8)).toBe(TRACK.repeat(8))
    expect(bar(140, 8)).toBe(FILL.repeat(8))
    expect(bar(Number.NaN, 8)).toBe(TRACK.repeat(8))
  })
})

describe("pause origin", () => {
  test("names the TUI as the actor, not an external client", () => {
    expect(pauseReason("tui")).toBe("paused from the TUI")
    expect(pauseReason("tui")).not.toContain("external")
  })

  test("keeps the external wording for every other client", () => {
    expect(pauseReason("external")).toBe("paused from an external client")
  })

  test("defaults to external, so a caller that does not say who it is is not credited to the TUI", () => {
    expect(pauseReason()).toBe("paused from an external client")
  })

  test("accepts only the two known origins", () => {
    expect(isGoalOrigin("tui")).toBe(true)
    expect(isGoalOrigin("external")).toBe(true)
    for (const value of ["web", "TUI", "", undefined, null, 1, {}]) {
      expect(isGoalOrigin(value)).toBe(false)
    }
  })

  test("the act schema accepts origin, and requires only sessionID and action", () => {
    const input = GoalRpc.methods.act.input
    expect(input.properties.origin).toEqual({ type: "string", enum: ["tui", "external"] })
    // A client predating this field has to keep working.
    expect(input.required).toEqual(["sessionID", "action"])
  })
})
