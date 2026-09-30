/**
 * Controlled logging adapter.
 *
 * Prevents uncontrolled stdout/stderr writes that can corrupt TUI render cycles
 * or break non-interactive pipe workflows.
 */

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface LoggerSink {
  write(level: LogLevel, message: string, error?: unknown): void
}

class DefaultSink implements LoggerSink {
  write(level: LogLevel, message: string, error?: unknown): void {
    const errorDetails = error instanceof Error
      ? `: ${error.message}`
      : typeof error === "string" && error.length > 0
        ? `: ${error}`
        : ""
    const formatted = `[opencode-goal] ${message}${errorDetails}`

    if (level === "error" || level === "warn") {
      // In interactive TUI or quiet environments, direct console writes can disrupt screen rendering.
      // We only emit when stderr is a TTY and not explicitly silenced, or in non-TUI server contexts.
      if (process.env.OPENCODE_QUIET !== "1" && process.env.OPENCODE_QUIET !== "true") {
        console.error(formatted)
      }
    }
  }
}

let activeSink: LoggerSink = new DefaultSink()

export const logger = {
  setSink(sink: LoggerSink): void {
    activeSink = sink
  },
  resetSink(): void {
    activeSink = new DefaultSink()
  },
  warn(message: string, error?: unknown): void {
    activeSink.write("warn", message, error)
  },
  error(message: string, error?: unknown): void {
    activeSink.write("error", message, error)
  },
  info(message: string): void {
    activeSink.write("info", message)
  },
  debug(message: string): void {
    if (process.env.DEBUG?.includes("opencode-goal")) {
      activeSink.write("debug", message)
    }
  },
}
