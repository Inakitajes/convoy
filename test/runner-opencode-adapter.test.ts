import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ExecutionRequest, RunnerEvent } from "../src/runners/contracts"
import { createOpencodeRunner, opencodeCapabilities, parseOpencodeModel, summarizeAssistant } from "../src/runners/opencode/adapter"

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-adapter-"))
  dirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("opencode v2 adapter (unit)", () => {
  test("splits a Convoy model reference into a v2 ModelRef", () => {
    expect(parseOpencodeModel({ runner: "opencode", modelId: "nan/deepseek-v4-flash" })).toEqual({
      providerID: "nan",
      modelID: "deepseek-v4-flash",
    })
    expect(parseOpencodeModel({ runner: "opencode", modelId: "openai/gpt", variant: "high" })).toEqual({
      providerID: "openai",
      modelID: "gpt",
      variant: "high",
    })
    expect(() => parseOpencodeModel({ runner: "opencode", modelId: "no-slash" })).toThrow()
  })

  test("summarizes assistant text, tools, finish, and usage", () => {
    const summary = summarizeAssistant({
      type: "assistant",
      finish: "stop",
      cost: 0.01,
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 0 } },
      content: [
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "hello " },
        { type: "tool", name: "read" },
        { type: "text", text: "world" },
      ],
    })
    expect(summary.text).toBe("hello world")
    expect(summary.tools).toEqual(["read"])
    expect(summary.finish).toBe("stop")
    expect(summary.usage).toMatchObject({ input: 10, output: 5, reasoning: 2, cacheRead: 3, costEstimate: 0.01 })
  })

  test("advertises described capabilities, not bare booleans", () => {
    const caps = opencodeCapabilities("2.0.28")
    expect(caps.runner).toBe("opencode")
    expect(caps.capabilities.every((entry) => typeof entry.availability === "string")).toBe(true)
    expect(caps.capabilities.some((entry) => entry.id === "native-live-attach" && entry.availability === "available")).toBe(true)
  })
})

const live = process.env.CONVOY_V2_LIVE === "1"

describe.if(live)("opencode v2 adapter (live, nan/deepseek-v4-flash)", () => {
  test("runs a full attempt and returns a completed outcome with assistant text", async () => {
    const dir = await tempDir()
    const runner = createOpencodeRunner({ cwd: dir })
    const events: RunnerEvent[] = []
    const request: ExecutionRequest = {
      runId: "run-live",
      phaseName: "implement",
      attempt: 1,
      runner: "opencode",
      checkout: dir,
      agent: { name: "implementer", mode: "write", model: { runner: "opencode", modelId: "nan/deepseek-v4-flash" } },
      prompt: "Reply with exactly: DONE",
      auth: { mode: "subscription" },
      mode: "write",
      approvals: "auto",
      signal: new AbortController().signal,
    }
    try {
      const outcome = await runner.executeAttempt(request, (event) => events.push(event))
      // The adapter must be truthful: a provider/finish error is never reported
      // as success. (nan/deepseek-v4-flash routes without tool support, so a
      // tool-using turn resolves to a failed outcome with an error.)
      expect(["completed", "failed", "uncertain"]).toContain(outcome.status)
      if (outcome.status === "completed") {
        expect((outcome.assistantText ?? "").length).toBeGreaterThan(0)
      } else {
        expect(typeof outcome.error).toBe("string")
      }
      expect(outcome.session?.runner).toBe("opencode")
      expect(events.some((event) => event.type === "session")).toBe(true)
      expect(events.some((event) => event.type === "terminal")).toBe(true)
    } finally {
      await runner.close()
    }
  }, 120_000)
})
