/**
 * Terminal and environment detection.
 *
 * Provides safe, robust inspection of terminal capabilities:
 * - Unicode vs ASCII character support
 * - Color support and NO_COLOR compliance
 * - Terminal dimensions and narrow viewport detection
 * - Interactive TTY vs piped/redirected execution
 *
 * Free of external dependencies and fully testable with injected environments.
 */

export interface TerminalEnvironment {
  readonly platform?: string
  readonly env?: Record<string, string | undefined>
  readonly stdout?: {
    readonly isTTY?: boolean
    readonly columns?: number
    readonly rows?: number
  }
  readonly stdin?: {
    readonly isTTY?: boolean
  }
}

const DEFAULT_TERMINAL_WIDTH = 80
const NARROW_TERMINAL_THRESHOLD = 70

/**
 * Determines whether the terminal environment safely supports UTF-8 / Unicode glyphs.
 * When false, callers should fallback to standard ASCII characters (e.g. #, -, *).
 */
export function isUnicodeSupported(customEnv?: TerminalEnvironment): boolean {
  const env = customEnv?.env ?? process.env
  const platform = customEnv?.platform ?? process.platform

  if (env.TERM === "dumb") {
    return false
  }

  if (platform === "win32") {
    return Boolean(
      env.WT_SESSION || // Windows Terminal
      env.TERMINUS_SUBLIME || // Terminus
      env.ConEmuTask === "{cmd::Cmder}" || // Cmder
      env.TERM_PROGRAM === "vscode" ||
      env.TERM_PROGRAM === "WezTerm" ||
      env.TERM === "xterm-256color" ||
      env.TERM === "alacritty",
    )
  }

  const locale = `${env.LC_ALL ?? ""}${env.LC_MESSAGES ?? ""}${env.LANG ?? ""}`
  return /utf-?8/i.test(locale)
}

/**
 * Determines whether color escape sequences are supported and permitted.
 * Adheres strictly to the https://no-color.org standard.
 */
export function isColorSupported(customEnv?: TerminalEnvironment): boolean {
  const env = customEnv?.env ?? process.env
  const stdout = customEnv?.stdout ?? process.stdout

  if ("NO_COLOR" in env && env.NO_COLOR !== "") {
    return false
  }

  if (env.FORCE_COLOR === "0") {
    return false
  }

  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") {
    return true
  }

  if (env.TERM === "dumb") {
    return false
  }

  if (stdout && typeof stdout.isTTY === "boolean") {
    return stdout.isTTY
  }

  return false
}

/**
 * Safely resolves the current terminal column width.
 * Prioritizes renderer width, then stdout columns, then a standard fallback.
 */
export function getTerminalWidth(rendererWidth?: number, customEnv?: TerminalEnvironment): number {
  if (typeof rendererWidth === "number" && Number.isFinite(rendererWidth) && rendererWidth > 0) {
    return Math.floor(rendererWidth)
  }

  const stdout = customEnv?.stdout ?? process.stdout
  const columns = stdout?.columns
  if (typeof columns === "number" && Number.isFinite(columns) && columns > 0) {
    return Math.floor(columns)
  }

  return DEFAULT_TERMINAL_WIDTH
}

/**
 * Checks whether the terminal width is considered narrow, requiring
 * compact layouts to avoid wrapping and visual clutter.
 */
export function isNarrowTerminal(width: number, threshold = NARROW_TERMINAL_THRESHOLD): boolean {
  return width < threshold
}

/**
 * Determines whether the current process is running in an interactive TTY session.
 */
export function isInteractive(customEnv?: TerminalEnvironment): boolean {
  const stdout = customEnv?.stdout ?? process.stdout
  const stdin = customEnv?.stdin ?? process.stdin
  const env = customEnv?.env ?? process.env

  if (env.CI && env.CI !== "0" && env.CI !== "false") {
    return false
  }

  return Boolean(stdout?.isTTY && stdin?.isTTY)
}
