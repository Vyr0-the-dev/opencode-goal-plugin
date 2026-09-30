# Compatibility Policy

This document outlines the supported runtime, platform, and OpenCode surface for `opencode-goal-plugin`.

---

## 1. Supported Package Surface

* **Package Root & Exports:**
  * `.` -> `dist/index.js` (Compiled ESM bundle for Node.js / Bun / OpenCode)
  * TypeScript definitions via `index.d.ts` and source files in `src/`
  * Frontend TUI Solid.js component in `src/tui.tsx`
  * RPC interface in `src/rpc.ts`
* **Supported Runtimes:**
  * Node.js `>=18.0.0`
  * Bun `>=1.0.0`
* **Supported OpenCode Versions:**
  * OpenCode v2 (`>=2.0.0`, verified with `2.0.19`)

---

## 2. Operating System & Terminal Compatibility

| Surface | Linux | macOS | Windows |
| :--- | :---: | :---: | :---: |
| **Architectures** | x64, arm64 | x64, arm64 (Apple Silicon) | x64 |
| **Path Handling** | POSIX (`/`) | POSIX (`/`) | Drive letters (`C:\`), UNC paths, backslash preservation |
| **Shells** | Bash, Zsh, Fish | Zsh, Bash | PowerShell 5.1/7+, CMD (`install.cmd`), Git Bash |
| **Terminal Modes** | TTY, Non-TTY, Dumb | TTY, Non-TTY, Dumb | Windows Terminal (`WT_SESSION`), ConHost, VS Code terminal |
| **Color Standards** | `NO_COLOR`, `FORCE_COLOR` | `NO_COLOR`, `FORCE_COLOR` | `NO_COLOR`, `FORCE_COLOR` |
| **Encoding Fallbacks**| UTF-8 / ASCII fallback | UTF-8 / ASCII fallback | UTF-8 / ASCII fallback |

---

## 3. Package Caching & Pinning

OpenCode caches plugin packages downloaded from npm under:
* Linux / macOS: `~/.cache/opencode/packages/`
* Windows: `%USERPROFILE%\.cache\opencode\packages\`

> [!TIP]
> If you reference an unpinned package like `"opencode-goal-plugin"`, OpenCode caches it upon first download and will not automatically re-resolve `latest` unless the cache is cleared.
> To ensure you always run the intended release, either pin the exact version in `opencode.json` (e.g., `"opencode-goal-plugin@1.1.0"`), or link your local development build using the provided installation scripts (`install.ps1`, `install.sh`, or `install.cmd`).
