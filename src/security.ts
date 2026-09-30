/**
 * Security and validation utilities.
 *
 * Enforces strict input validation to prevent:
 * - Path traversal and storage key injection attacks
 * - Malformed session identifiers
 * - Unexpected command injection vectors
 */

const SAFE_SESSION_ID_PATTERN = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,127}$/

/**
 * Validates whether a sessionID is safe for internal storage keys,
 * preventing path traversal (`..`, `/`, `\`) and null-byte injection.
 */
export function isValidSessionID(sessionID: unknown): sessionID is string {
  if (typeof sessionID !== "string") {
    return false
  }

  const trimmed = sessionID.trim()
  if (!trimmed) {
    return false
  }

  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..") || trimmed.includes("\0")) {
    return false
  }

  return SAFE_SESSION_ID_PATTERN.test(trimmed)
}

/**
 * Asserts that a sessionID is valid, throwing an explicit Error if invalid.
 */
export function assertSafeSessionID(sessionID: unknown): string {
  if (!isValidSessionID(sessionID)) {
    throw new Error(`Invalid session identifier: unsafe or malformed characters detected`)
  }
  return sessionID.trim()
}
