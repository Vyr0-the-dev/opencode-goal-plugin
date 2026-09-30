import { describe, expect, test } from "bun:test"
import { parseGoalCommand, tokenize } from "../src/parse.ts"
import { isValidSessionID } from "../src/security.ts"
import { GoalStore } from "../src/store.ts"

class MemoryStorage {
  readonly items = new Map<string, unknown>()
  async get(key: string) { return this.items.get(key) as never }
  async set(key: string, value: unknown) { this.items.set(key, value) }
  async remove(key: string) { this.items.delete(key) }
  async scan(options: { prefix: string }) {
    return {
      entries: [...this.items.entries()]
        .filter(([k]) => k.startsWith(options.prefix))
        .map(([key, value]) => ({ key, value: value as never })),
    }
  }
}

describe("cross-platform parsing & line endings", () => {
  test("tokenizes and parses multi-line inputs with Windows CRLF line endings", () => {
    const crlfInput = "/goal Build the cross-platform binary\r\n--verify \"cargo test && bun test\"\r\n--turns 15"
    const parsed = parseGoalCommand(crlfInput)
    expect(parsed.kind).toBe("set")
    if (parsed.kind === "set") {
      expect(parsed.remainder).toBe("Build the cross-platform binary")
      expect(parsed.flags.verification).toBe("cargo test && bun test")
      expect(parsed.flags.maxTurns).toBe(15)
    }
  })

  test("handles Unix LF and mixed line endings identically", () => {
    const lfInput = "/goal Build binary\n--verify \"bun test\"\n--turns 10"
    const parsed = parseGoalCommand(lfInput)
    expect(parsed.kind).toBe("set")
    if (parsed.kind === "set") {
      expect(parsed.remainder).toBe("Build binary")
      expect(parsed.flags.verification).toBe("bun test")
      expect(parsed.flags.maxTurns).toBe(10)
    }
  })

  test("tokenizes quotes containing backslashes and path separators safely", () => {
    const input = `--boundaries "src\\core\\engine.ts,src\\platform\\win32.ts"`
    const tokens = tokenize(input)
    expect(tokens).toHaveLength(2)
    expect(tokens[1]).toBe("src\\core\\engine.ts,src\\platform\\win32.ts")
  })
})

describe("cross-platform storage key safety", () => {
  test("prevents Windows drive letter or backslash traversal into store keys", () => {
    const store = new GoalStore(new MemoryStorage() as never)
    expect(() => store.key("C:\\evil")).toThrow("Invalid session identifier")
    expect(() => store.key("..\\..\\windows")).toThrow("Invalid session identifier")
    expect(() => store.key("../../etc/shadow")).toThrow("Invalid session identifier")
  })

  test("allows safe session identifiers across platforms", () => {
    const store = new GoalStore(new MemoryStorage() as never)
    expect(store.key("ses_linux_01")).toBe("goal/v1/session/ses_linux_01")
    expect(store.key("ses_win-desktop_42")).toBe("goal/v1/session/ses_win-desktop_42")
    expect(store.key("ses.macos.local")).toBe("goal/v1/session/ses.macos.local")
  })
})
