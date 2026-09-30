import { describe, expect, test } from "bun:test"
import goalPlugin from "../src/index.ts"

class MockStorage {
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

interface HookEntry {
  type: string
  handler: (event: any) => Promise<void>
}

class MockPluginContext {
  readonly storage = new MockStorage()
  readonly tools: Array<{ name: string; options?: any; description: string }> = []
  readonly commands: Array<{ name: string; description: string }> = []
  readonly hooks: HookEntry[] = []
  readonly rpcRegistrations: Array<{ id: string; definition: any; handlers: any }> = []
  readonly options: Record<string, unknown>
  readonly prompts: Array<{ sessionID: string; text: string; metadata?: any }> = []
  readonly notices: Array<{ sessionID: string; text: string; metadata?: any }> = []

  disposed = false
  rpcDisposed = false

  constructor(options: Record<string, unknown> = {}) {
    this.options = options
  }

  get tool() {
    return {
      transform: (cb: (editor: any) => void) => {
        cb({
          namespace: () => {},
          add: (def: any) => this.tools.push(def),
        })
      },
    } as any
  }

  get command() {
    return {
      transform: (cb: (editor: any) => void) => {
        cb({
          add: (def: any) => this.commands.push(def),
        })
      },
    } as any
  }

  get session() {
    return {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        agent: "build",
        metadata: {},
      }),
      update: async () => {},
      hook: async (type: string, handler: (event: any) => Promise<void>) => {
        this.hooks.push({ type, handler })
      },
      prompt: async (input: any) => {
        this.prompts.push(input)
      },
      synthetic: async (input: any) => {
        this.notices.push(input)
      },
    } as any
  }

  get event() {
    return {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        while (!signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 50))
          break
        }
      },
    } as any
  }

  get rpc() {
    return {
      register: async (definition: any, handlers: any) => {
        this.rpcRegistrations.push({ id: definition.id, definition, handlers })
        return {
          events: {
            emit: async () => {},
          },
          dispose: async () => {
            this.rpcDisposed = true
          },
        }
      },
    } as any
  }
}

describe("OpenCode v2 plugin integration lifecycle", () => {
  test("registers tools, commands, hooks and RPC upon setup", async () => {
    const ctx = new MockPluginContext({ enabled: true })
    const cleanup = await goalPlugin.setup(ctx as any)

    expect(typeof cleanup).toBe("function")
    expect(ctx.commands.some((c) => c.name === "goal")).toBe(true)
    expect(ctx.tools.some((t) => t.name === "create")).toBe(true)
    expect(ctx.tools.some((t) => t.name === "status")).toBe(true)
    expect(ctx.tools.some((t) => t.name === "update")).toBe(true)

    expect(ctx.hooks.some((h) => h.type === "context")).toBe(true)
    expect(ctx.hooks.some((h) => h.type === "compaction")).toBe(true)
    expect(ctx.hooks.some((h) => h.type === "generate")).toBe(true)
    expect(ctx.hooks.some((h) => h.type === "prompt")).toBe(true)

    expect(ctx.rpcRegistrations.some((r) => r.id === "goal")).toBe(true)

    if (cleanup) {
      await cleanup()
    }
    expect(ctx.rpcDisposed).toBe(true)
  })

  test("skips all registrations when enabled: false", async () => {
    const ctx = new MockPluginContext({ enabled: false })
    const cleanup = await goalPlugin.setup(ctx as any)

    expect(cleanup).toBeUndefined()
    expect(ctx.commands).toHaveLength(0)
    expect(ctx.tools).toHaveLength(0)
    expect(ctx.hooks).toHaveLength(0)
    expect(ctx.rpcRegistrations).toHaveLength(0)
  })

  test("system prompt injection hook injects active goal into context", async () => {
    const ctx = new MockPluginContext({ enabled: true })
    const cleanup = await goalPlugin.setup(ctx as any)

    // Set an active goal via the registered tool
    const createTool = ctx.tools.find((t) => t.name === "create") as any
    expect(createTool).toBeDefined()

    await createTool.execute(
      { objective: "Verify OpenCode v2 compatibility suite" },
      { sessionID: "ses_integ_01", progress: () => {} },
    )

    // Trigger context hook
    const contextHook = ctx.hooks.find((h) => h.type === "context")
    expect(contextHook).toBeDefined()

    const systemParts: Array<{ type?: string; text?: string }> = []
    await contextHook?.handler({ sessionID: "ses_integ_01", system: systemParts })

    expect(systemParts).toHaveLength(1)
    expect(systemParts[0]?.text).toContain("ACTIVE GOAL (opencode-goal-plugin)")
    expect(systemParts[0]?.text).toContain("Verify OpenCode v2 compatibility suite")

    // Consecutive hook calls must not duplicate the block
    await contextHook?.handler({ sessionID: "ses_integ_01", system: systemParts })
    expect(systemParts).toHaveLength(1)

    if (cleanup) {
      await cleanup()
    }
  })

  test("RPC act handler responds to actions and handles unknown actions", async () => {
    const ctx = new MockPluginContext({ enabled: true })
    const cleanup = await goalPlugin.setup(ctx as any)

    const rpcEntry = ctx.rpcRegistrations.find((r) => r.id === "goal")
    expect(rpcEntry).toBeDefined()

    let errorRaised: { code: string; message: string } | undefined
    const mockCall = {
      error: (code: string, message: string) => {
        errorRaised = { code, message }
        return { error: code }
      },
    }

    const invalidRes = await rpcEntry?.handlers.act(
      { sessionID: "ses_integ_02", action: "invalid-action" },
      mockCall,
    )
    expect(invalidRes.error).toBe("unknown_action")
    expect(errorRaised?.code).toBe("unknown_action")

    const validStatusRes = await rpcEntry?.handlers.act(
      { sessionID: "ses_integ_02", action: "status" },
      mockCall,
    )
    expect(validStatusRes.message).toBeDefined()

    if (cleanup) {
      await cleanup()
    }
  })
})
