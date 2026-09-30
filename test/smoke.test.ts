import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")

interface PluginModule {
  default?: {
    id?: string
    setup?: unknown
  }
}

describe("distribution and packaging smoke tests", () => {
  test("verifies all package root entrypoints and shims exist", () => {
    const requiredFiles = [
      "package.json",
      "index.js",
      "tui.tsx",
      "rpc.ts",
      "goal.config.json",
      "install.sh",
      "install.ps1",
      "install.cmd",
      "README.md",
      "LICENSE",
      "CHANGELOG.md",
      "dist/index.js",
    ]

    for (const relPath of requiredFiles) {
      const fullPath = join(ROOT, relPath)
      expect(existsSync(fullPath)).toBe(true)
    }
  })

  test("verifies package.json export targets match physical files", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
    expect(pkg.name).toBe("opencode-goal-plugin")
    expect(pkg.exports["."]).toBe("./index.js")
    expect(pkg.exports["./server"]).toBe("./index.js")
    expect(pkg.exports["./tui"]).toBe("./tui.tsx")
    expect(pkg.exports["./rpc"]).toBe("./rpc.ts")
  })

  test("verifies goal.config.json has valid json and required keys", () => {
    const raw = readFileSync(join(ROOT, "goal.config.json"), "utf8")
    const config = JSON.parse(raw)
    expect(config.enabled).toBe(true)
    expect(typeof config.defaultMaxTurns).toBe("number")
    expect(typeof config.defaultMaxMinutes).toBe("number")
    expect(typeof config.continuationDelayMs).toBe("number")
  })

  test("verifies compiled dist/index.js exports the plugin default object", async () => {
    // Dynamic import typed to satisfy strict TypeScript checking without requiring d.ts for js bundles
    const distModule = (await import("../dist/index.js" as string)) as PluginModule
    expect(distModule.default).toBeDefined()
    expect(distModule.default?.id).toBe("opencode.goal")
    expect(typeof distModule.default?.setup).toBe("function")
  })

  test("verifies root index.js re-exports the compiled plugin cleanly", async () => {
    const rootModule = (await import("../index.js" as string)) as PluginModule
    expect(rootModule.default).toBeDefined()
    expect(rootModule.default?.id).toBe("opencode.goal")
  })

  test("verifies rpc.ts exports all RPC definitions and helpers", async () => {
    const rpcModule = await import("../rpc.ts")
    expect(rpcModule.GoalRpc).toBeDefined()
    expect(rpcModule.isGoalAction).toBeDefined()
    expect(rpcModule.isGoalOrigin).toBeDefined()
    expect(rpcModule.pauseReason).toBeDefined()
    expect(rpcModule.GOAL_STATUS_VALUES).toBeDefined()
  })
})
