# Security Policy

## Supported Versions

Security fixes are provided for the latest published version on the `main` branch.

| Version | Supported          |
| ------- | ------------------ |
| 1.1.x   | :white_check_mark: |
| < 1.1.0 | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability within `opencode-goal-plugin`, please report it privately:

1. Use GitHub's private vulnerability reporting feature on this repository.
2. Do **not** open a public issue with exploit details, reproduction steps, or local environment paths.
3. Provide a clear summary of the issue, affected components, and proof-of-concept steps.

We will review reports promptly and publish patches alongside release notes.

## Scope & Security Architecture

The plugin is designed to operate safely inside OpenCode without escalating model privileges:

- **No Arbitrary Command Execution:** The plugin does not spawn shell commands on its own; it relies entirely on OpenCode's host session and permission engine.
- **Session ID Sanitization:** All session identifiers are strictly validated against path traversal (`..`), path separators (`/`, `\`), and control/null characters before storage access.
- **TUI Stream Isolation:** No uncontrolled writes to `process.stdout` or `process.stderr` occur during interactive TUI execution, preventing terminal corruption and escape-sequence injection.
- **Untrusted Input Handling:** User goal objectives, assistant checkpoints, and tool arguments are treated as untrusted data.
- **No Secret Leakage:** Goal state, notes, and progress logs exclude credentials and tokens.
