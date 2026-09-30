/**
 * The progress bar for the TUI progress row and CLI displays.
 *
 * Supports both high-fidelity Unicode blocks (`█` / `─`) and safe ASCII fallbacks (`#` / `-`)
 * for terminals with restricted encoding, dumb terminals, or legacy consoles.
 */

const UNICODE_FILL = "█" // full block
const UNICODE_TRACK = "─" // light horizontal

const ASCII_FILL = "#"
const ASCII_TRACK = "-"

export interface BarOptions {
  /** Target character width of the progress bar. Defaults to 12. */
  readonly width?: number
  /** Force ASCII characters (# and -) instead of Unicode blocks. */
  readonly ascii?: boolean
}

/**
 * Renders a visual progress bar.
 *
 * Accepts either a numeric width for backward compatibility:
 *   `bar(50, 12)` -> uses Unicode blocks by default
 * Or an options object with optional ASCII fallback:
 *   `bar(50, { width: 12, ascii: true })` -> uses ASCII `#` and `-`
 */
export function bar(percent: number, widthOrOptions: number | BarOptions = 12): string {
  const width = typeof widthOrOptions === "number"
    ? widthOrOptions
    : widthOrOptions.width ?? 12

  const useAscii = typeof widthOrOptions === "object" && Boolean(widthOrOptions.ascii)

  const fillChar = useAscii ? ASCII_FILL : UNICODE_FILL
  const trackChar = useAscii ? ASCII_TRACK : UNICODE_TRACK

  const targetWidth = Math.max(1, Math.floor(width))
  const cells = Math.max(0, Math.min(targetWidth, Math.round((percent / 100) * targetWidth)))
  const filled = Number.isFinite(cells) ? cells : 0

  return fillChar.repeat(filled) + trackChar.repeat(targetWidth - filled)
}
