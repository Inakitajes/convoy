import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDefaultRegistry, supportedRunners } from "../src/runners/registry"
import { RunnerRegistry } from "../src/runners/contracts"
import type { ExecutionAdapter, RunnerEvent } from "../src/runners/contracts"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("adapter composition", () => {
  test("registers both built-in runners and closes cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-registry-"))
    dirs.push(dir)
    const composition = createDefaultRegistry({ cwd: dir })
    expect(supportedRunners(composition)).toEqual(["opencode", "claude-code"])
    expect(composition.registry.require("opencode").execution.id).toBe("opencode")
    expect(composition.registry.require("claude-code").execution.id).toBe("claude-code")
    await composition.close()
  })

  test("a fake adapter dispatches through the registry", async () => {
    const registry = new RunnerRegistry()
    const adapter: ExecutionAdapter = {
      id: "claude-code",
      async capabilities() {
        return { runner: "claude-code", capabilities: [] }
      },
      async executeAttempt(_request, sink) {
        const event: RunnerEvent = { type: "terminal", runner: "claude-code", attempt: 1, outcome: { status: "completed" } }
        sink(event)
        return { status: "completed" }
      },
      async cancelAttempt() {},
    }
    registry.register({ id: "claude-code", execution: adapter })
    const events: RunnerEvent[] = []
    const outcome = await registry.require("claude-code").execution.executeAttempt(
      {
        runId: "r",
        phaseName: "p",
        attempt: 1,
        runner: "claude-code",
        checkout: "/tmp",
        agent: { name: "a", mode: "write", model: { runner: "claude-code", modelId: "sonnet" } },
        prompt: "x",
        auth: { mode: "subscription" },
        mode: "write",
        approvals: "auto",
        signal: new AbortController().signal,
      },
      (event) => events.push(event),
    )
    expect(outcome.status).toBe("completed")
    expect(events[0]?.type).toBe("terminal")
  })
})
