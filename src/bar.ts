/**
 * The progress bar for the TUI progress row.
 *
 * It lives in its own module rather than in `tui.tsx` for two reasons. The test
 * suite cannot import `tui.tsx` at all, because `tsconfig.json` sets
 * `"jsx": "preserve"` and the suite runs unbundled - so a bar defined in there
 * could only be verified by looking at a screenshot. And the glyph choice is the
 * part most likely to need changing again.
 *
 * `░` is the conventional empty-track character and it is wrong here. It is a
 * dither pattern, not a shade: terminal fonts render it as a stipple, and at
 * twelve columns that reads as vertical stripes rather than as an empty bar. The
 * row looked broken in a way that no assertion would have caught. `─` is a solid
 * line in every font, so the row reads as "filled, then track".
 */

const FILL = "█" // full block
const TRACK = "─" // light horizontal

export function bar(percent: number, width = 12): string {
  const cells = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  // A non-finite percent makes both repeat counts NaN, and "█".repeat(NaN) is
  // the empty string - so the row would lose its bar entirely rather than show
  // an empty one. Found by the clamp test, not by looking at it.
  const filled = Number.isFinite(cells) ? cells : 0
  return FILL.repeat(filled) + TRACK.repeat(width - filled)
}
