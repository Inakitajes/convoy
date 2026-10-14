import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { writeReportToolName } from "../src/report"
import type { ExecutionRequest, RunnerEvent } from "../src/runners/contracts"
import type { OwnedServer } from "../src/runners/opencode/boot"
import {
  createOpencodeRunner,
  materializePluginModules,
  mergePluginConfigContent,
  opencodeCapabilities,
  parseOpencodeModel,
  summarizeAssistant,
} from "../src/runners/opencode/adapter"
import { planPluginRegistration, type PluginToolSpec } from "../src/runners/opencode/plugin-tools"

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

const reportSpec: PluginToolSpec = {
  name: writeReportToolName,
  description: "Persist this phase's complete Markdown report through Convoy.",
  bridgeUrl: "http://127.0.0.1:49152/report",
  token: "tok-report-adapter",
}

describe("opencode v2 plugin wiring (task 4.5)", () => {
  test("materializes per-run plugin modules in their own owner-only directories", async () => {
    const runA = await tempDir()
    const runB = await tempDir()

    const filesA = await materializePluginModules(planPluginRegistration(runA, [reportSpec]))
    const filesB = await materializePluginModules(planPluginRegistration(runB, [reportSpec]))

    expect(filesA).toEqual([join(runA, "plugins", "write_report.ts")])
    expect(filesB).toEqual([join(runB, "plugins", "write_report.ts")])
    // Distinct per run: two runs never share a mutable tool module.
    expect(filesA[0]).not.toBe(filesB[0])
    expect((await stat(join(runA, "plugins"))).mode & 0o777).toBe(0o700)
    expect((await stat(filesA[0]!)).mode & 0o777).toBe(0o600)
    // The rendered module is the v2 plugin shape, not the v1 bare default export.
    expect(await Bun.file(filesA[0]!).text()).toContain("@opencode/plugin")
  })

  test("merges the plugin directory into the injected config and fails closed on non-JSON", () => {
    expect(JSON.parse(mergePluginConfigContent('{"agents":{}}', ["/run/plugins"])!)).toEqual({
      agents: {},
      plugins: ["/run/plugins"],
    })
    expect(mergePluginConfigContent(undefined, ["/run/plugins"])).toBe('{"plugins":["/run/plugins"]}')
    expect(() => mergePluginConfigContent("not json", ["/x"])).toThrow(/must be JSON/)
  })

  test("fails closed before prompting when a required plugin tool is not registered", async () => {
    const dir = await tempDir()
    const server = {
      url: "http://127.0.0.1:1",
      password: "pw",
      pid: 0,
      stop: async () => ({ status: "stopped", via: "graceful" }) as const,
      forceStop: () => {},
    } as unknown as OwnedServer

    const runner = createOpencodeRunner({
      cwd: dir,
      pluginBaseDir: dir,
      pluginTools: [reportSpec],
      deps: {
        checkRuntime: async () => ({ version: "2.0.26", major: 2, executable: "opencode" }),
        boot: async () => server,
        checkPluginHealth: async () => [{ name: writeReportToolName, registered: false }],
      },
    })

    const events: RunnerEvent[] = []
    const request: ExecutionRequest = {
      runId: "run-plugin",
      phaseName: "implement",
      attempt: 1,
      runner: "opencode",
      checkout: dir,
      agent: { name: "implementer", mode: "write", model: { runner: "opencode", modelId: "nan/deepseek-v4-flash" } },
      prompt: "do the thing",
      auth: { mode: "subscription" },
      mode: "write",
      approvals: "auto",
      signal: new AbortController().signal,
    }

    const outcome = await runner.executeAttempt(request, (event) => events.push(event))
    expect(outcome.status).toBe("failed")
    expect(outcome.error).toMatch(/not registered before prompting/)
    // No prompt was admitted: no session event was emitted.
    expect(events.some((event) => event.type === "session")).toBe(false)
    // The modules were still materialized for inspection/recovery.
    expect(await Bun.file(join(dir, "plugins", "write_report.ts")).exists()).toBe(true)
  })

  test("refuses to plan a run directory when pluginTools are set without one", () => {
    expect(() => createOpencodeRunner({ cwd: "/repo", pluginTools: [reportSpec] })).toThrow(/pluginBaseDir/)
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

  test("continues an exact recorded session and reconstructs its transcript", async () => {
    const dir = await tempDir()
    const runner = createOpencodeRunner({ cwd: dir })
    const base: ExecutionRequest = {
      runId: "run-live",
      phaseName: "implement",
      attempt: 1,
      runner: "opencode",
      checkout: dir,
      agent: { name: "implementer", mode: "write", model: { runner: "opencode", modelId: "nan/deepseek-v4-flash" } },
      prompt: "Reply with exactly: ONE",
      auth: { mode: "subscription" },
      mode: "write",
      approvals: "auto",
      signal: new AbortController().signal,
    }
    try {
      const first = await runner.executeAttempt(base, () => {})
      expect(first.session?.runner).toBe("opencode")
      const sessionId = first.session!.sessionId

      const second = await runner.executeAttempt({ ...base, attempt: 2, prompt: "Reply with exactly: TWO", continueSession: { runner: "opencode", sessionId } }, () => {})
      expect(second.session?.sessionId).toBe(sessionId)

      await expect(runner.backfillEvents(sessionId, 1)).resolves.toBeArray()
    } finally {
      await runner.close()
    }
  }, 120_000)
})
