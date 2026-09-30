import { describe, expect, test } from "bun:test"
import {
  isUnicodeSupported,
  isColorSupported,
  getTerminalWidth,
  isNarrowTerminal,
  isInteractive,
} from "../src/terminal.ts"

describe("terminal unicode detection", () => {
  test("returns false when TERM is dumb", () => {
    expect(isUnicodeSupported({ env: { TERM: "dumb" } })).toBe(false)
  })

  test("detects Windows Terminal via WT_SESSION", () => {
    expect(isUnicodeSupported({
      platform: "win32",
      env: { WT_SESSION: "some-guid", TERM: "xterm" },
    })).toBe(true)
  })

  test("detects VS Code integrated terminal on Windows", () => {
    expect(isUnicodeSupported({
      platform: "win32",
      env: { TERM_PROGRAM: "vscode" },
    })).toBe(true)
  })

  test("falls back to false on legacy Windows console without modern terminal", () => {
    expect(isUnicodeSupported({
      platform: "win32",
      env: { COMSPEC: "cmd.exe" },
    })).toBe(false)
  })

  test("detects UTF-8 locales on POSIX platforms (Linux / macOS)", () => {
    expect(isUnicodeSupported({
      platform: "linux",
      env: { LANG: "en_US.UTF-8" },
    })).toBe(true)

    expect(isUnicodeSupported({
      platform: "darwin",
      env: { LC_ALL: "tr_TR.utf8" },
    })).toBe(true)
  })

  test("returns false for non-UTF8 POSIX locales", () => {
    expect(isUnicodeSupported({
      platform: "linux",
      env: { LANG: "C", LC_ALL: "C" },
    })).toBe(false)
  })
})

describe("terminal color detection and NO_COLOR compliance", () => {
  test("honors NO_COLOR standard by disabling color when present", () => {
    expect(isColorSupported({
      env: { NO_COLOR: "1" },
      stdout: { isTTY: true },
    })).toBe(false)

    expect(isColorSupported({
      env: { NO_COLOR: "true" },
      stdout: { isTTY: true },
    })).toBe(false)
  })

  test("honors FORCE_COLOR=0 to disable color", () => {
    expect(isColorSupported({
      env: { FORCE_COLOR: "0" },
      stdout: { isTTY: true },
    })).toBe(false)
  })

  test("honors FORCE_COLOR=1 to force color even when non-TTY", () => {
    expect(isColorSupported({
      env: { FORCE_COLOR: "1" },
      stdout: { isTTY: false },
    })).toBe(true)
  })

  test("disables color when TERM is dumb", () => {
    expect(isColorSupported({
      env: { TERM: "dumb" },
      stdout: { isTTY: true },
    })).toBe(false)
  })

  test("enables color in standard interactive TTY without restrictions", () => {
    expect(isColorSupported({
      env: {},
      stdout: { isTTY: true },
    })).toBe(true)
  })

  test("disables color when stdout is redirected / piped and not forced", () => {
    expect(isColorSupported({
      env: {},
      stdout: { isTTY: false },
    })).toBe(false)
  })
})

describe("terminal dimensions and viewport detection", () => {
  test("prefers renderer width when provided", () => {
    expect(getTerminalWidth(120, { stdout: { columns: 80 } })).toBe(120)
  })

  test("falls back to stdout columns when renderer width is absent", () => {
    expect(getTerminalWidth(undefined, { stdout: { columns: 100 } })).toBe(100)
  })

  test("falls back to standard 80 columns when neither is available", () => {
    expect(getTerminalWidth(undefined, { stdout: { columns: undefined } })).toBe(80)
    expect(getTerminalWidth(NaN, { stdout: { columns: undefined } })).toBe(80)
  })

  test("identifies narrow terminals correctly", () => {
    expect(isNarrowTerminal(60)).toBe(true)
    expect(isNarrowTerminal(69)).toBe(true)
    expect(isNarrowTerminal(70)).toBe(false)
    expect(isNarrowTerminal(120)).toBe(false)
  })
})

describe("interactive mode detection", () => {
  test("identifies interactive TTY when both stdin and stdout are TTYs and no CI", () => {
    expect(isInteractive({
      env: {},
      stdout: { isTTY: true },
      stdin: { isTTY: true },
    })).toBe(true)
  })

  test("returns false when running inside CI environment", () => {
    expect(isInteractive({
      env: { CI: "true" },
      stdout: { isTTY: true },
      stdin: { isTTY: true },
    })).toBe(false)
  })

  test("returns false when stdin or stdout is piped / redirected", () => {
    expect(isInteractive({
      env: {},
      stdout: { isTTY: true },
      stdin: { isTTY: false },
    })).toBe(false)

    expect(isInteractive({
      env: {},
      stdout: { isTTY: false },
      stdin: { isTTY: true },
    })).toBe(false)
  })
})
