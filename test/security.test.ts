import { describe, expect, test } from "bun:test"
import { isValidSessionID, assertSafeSessionID } from "../src/security.ts"

describe("session ID security validation", () => {
  test("accepts standard session IDs", () => {
    expect(isValidSessionID("ses_123456")).toBe(true)
    expect(isValidSessionID("session-abc-def")).toBe(true)
    expect(isValidSessionID("f0a8d6e2-1b3c-4d5e-8f9a-0b1c2d3e4f5a")).toBe(true)
    expect(isValidSessionID("12345")).toBe(true)
    expect(isValidSessionID("test.session_01")).toBe(true)
  })

  test("rejects path traversal attempts", () => {
    expect(isValidSessionID("../escape")).toBe(false)
    expect(isValidSessionID("..\\escape")).toBe(false)
    expect(isValidSessionID("sessions/../other")).toBe(false)
    expect(isValidSessionID("/etc/passwd")).toBe(false)
    expect(isValidSessionID("C:\\Windows\\System32")).toBe(false)
    expect(isValidSessionID("..")).toBe(false)
  })

  test("rejects null-byte injection attempts", () => {
    expect(isValidSessionID("ses_123\0admin")).toBe(false)
  })

  test("rejects empty or whitespace-only inputs", () => {
    expect(isValidSessionID("")).toBe(false)
    expect(isValidSessionID("   ")).toBe(false)
    expect(isValidSessionID("\n\t")).toBe(false)
  })

  test("rejects non-string inputs", () => {
    expect(isValidSessionID(undefined)).toBe(false)
    expect(isValidSessionID(null)).toBe(false)
    expect(isValidSessionID(12345)).toBe(false)
    expect(isValidSessionID({})).toBe(false)
  })

  test("rejects excessively long identifiers", () => {
    const overlyLong = "a".repeat(200)
    expect(isValidSessionID(overlyLong)).toBe(false)
  })

  test("assertSafeSessionID returns valid IDs and throws on invalid ones", () => {
    expect(assertSafeSessionID("  valid_session_123  ")).toBe("valid_session_123")
    expect(() => assertSafeSessionID("../malicious")).toThrow("Invalid session identifier")
    expect(() => assertSafeSessionID("")).toThrow("Invalid session identifier")
  })
})
