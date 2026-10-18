import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { installAdvisorTool, startAdvisorBridge } from "../src/advisor-bridge"
import type { AdvisorPhaseHandle, AdvisorRuntime } from "../src/advisor-runtime"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "convoy-advisor-bridge-"))
  dirs.push(dir)
  return dir
}

const token = "test-token"

type StubHandle = AdvisorPhaseHandle & { consulted: { reason: string; question?: string }[] }

function stubRuntime(sessions: Record<string, string>): { runtime: AdvisorRuntime; handles: Map<string, StubHandle> } {
  const handles = new Map<string, StubHandle>()
  for (const [sessionID, advice] of Object.entries(sessions)) {
    const consulted: { reason: string; question?: string }[] = []
    handles.set(sessionID, {
      consulted,
      calls: 0,
      usage: [],
      events: [],
      consult: async (reason, question) => {
        consulted.push({ reason, ...(question ? { question } : {}) })
        return { text: advice, ok: true }
      },
      delivered: async () => {},
      feedback: async () => true,
      end: () => {},
    } as StubHandle)
  }
  return {
    runtime: {
      begin: () => undefined,
      handleFor: (sessionID) => handles.get(sessionID),
      checkpoint: async () => ({ action: "defer" }),
    },
    handles,
  }
}

async function post(url: string, body: unknown, authorization = `Bearer ${token}`) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(body),
  })
}

describe("advisor bridge endpoint", () => {
  test("consults the phase that owns the session and returns its advice", async () => {
    const { runtime, handles } = stubRuntime({ ses_1: "Read src/retry.ts first." })
    const bridge = await startAdvisorBridge({ advisors: () => runtime })
    try {
      const response = await post(bridge.url, { sessionID: "ses_1", question: "which lock ordering?" }, `Bearer ${bridge.token}`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ advice: "Read src/retry.ts first." })
      expect(handles.get("ses_1")?.consulted).toEqual([{ reason: "on-demand", question: "which lock ordering?" }])
    } finally {
      bridge.close()
    }
  })

  test("rejects a wrong or missing token", async () => {
    const { runtime } = stubRuntime({ ses_1: "advice" })
    const bridge = await startAdvisorBridge({ advisors: () => runtime })
    try {
      expect((await post(bridge.url, { sessionID: "ses_1" }, "Bearer wrong")).status).toBe(401)
      expect((await post(bridge.url, { sessionID: "ses_1" }, "")).status).toBe(401)
    } finally {
      bridge.close()
    }
  })

  test("rejects non-POST and malformed bodies", async () => {
    const { runtime } = stubRuntime({ ses_1: "advice" })
    const bridge = await startAdvisorBridge({ advisors: () => runtime })
    try {
      expect((await fetch(bridge.url, { method: "GET", headers: { authorization: `Bearer ${bridge.token}` } })).status).toBe(405)
      expect((await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}` }, body: "not json" })).status).toBe(400)
      expect((await post(bridge.url, {}, `Bearer ${bridge.token}`)).status).toBe(400)
    } finally {
      bridge.close()
    }
  })

  test("answers an unknown session with degradation guidance rather than an error", async () => {
    const { runtime } = stubRuntime({})
    const bridge = await startAdvisorBridge({ advisors: () => runtime })
    try {
      const response = await post(bridge.url, { sessionID: "ses_unowned" }, `Bearer ${bridge.token}`)
      expect(response.status).toBe(200)
      expect((await response.json()).advice).toContain("Continue on your own judgement")
    } finally {
      bridge.close()
    }
  })

  test("validates and records explicit executor feedback", async () => {
    const { runtime, handles } = stubRuntime({ ses_1: "advice" })
    let recorded: unknown[] | undefined
    handles.get("ses_1")!.feedback = async (...args) => {
      recorded = args
      return true
    }
    const bridge = await startAdvisorBridge({ advisors: () => runtime })
    try {
      const feedbackUrl = new URL("/feedback", bridge.url).toString()
      const response = await post(feedbackUrl, { sessionID: "ses_1", outcome: "partially-adopted", note: "Kept the API." }, `Bearer ${bridge.token}`)
      expect(await response.json()).toMatchObject({ recorded: true })
      expect(recorded).toEqual([undefined, "partially-adopted", "Kept the API."])
    } finally {
      bridge.close()
    }
  })

  test("rejects malformed feedback and degrades unknown sessions without recording", async () => {
    const { runtime } = stubRuntime({})
    const bridge = await startAdvisorBridge({ advisors: () => runtime })
    try {
      const feedbackUrl = new URL("/feedback", bridge.url).toString()
      expect((await fetch(feedbackUrl, { method: "GET", headers: { authorization: `Bearer ${bridge.token}` } })).status).toBe(405)
      expect((await post(feedbackUrl, { sessionID: "ses_1", outcome: "maybe" }, `Bearer ${bridge.token}`)).status).toBe(400)
      expect(await (await post(feedbackUrl, { sessionID: "ses_1", outcome: "adopted" }, `Bearer ${bridge.token}`)).json()).toMatchObject({ recorded: false })
    } finally {
      bridge.close()
    }
  })
})

describe("advisor bridge server", () => {
  test("serves a live loopback endpoint that resolves the runtime per request", async () => {
    let runtime: AdvisorRuntime | undefined
    const bridge = await startAdvisorBridge({ advisors: () => runtime })
    try {
      // Before the runtime is wired up, the endpoint still answers.
      const early = await fetch(bridge.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({ sessionID: "ses_1" }),
      })
      expect((await early.json()).advice).toContain("Continue on your own judgement")

      runtime = stubRuntime({ ses_1: "Now there is advice." }).runtime
      const later = await fetch(bridge.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({ sessionID: "ses_1" }),
      })
      expect((await later.json()).advice).toBe("Now there is advice.")
    } finally {
      bridge.close()
    }
  })

  test("mints a distinct token per bridge", async () => {
    const first = await startAdvisorBridge({ advisors: () => undefined })
    const second = await startAdvisorBridge({ advisors: () => undefined })
    try {
      expect(first.token).not.toBe(second.token)
      expect(first.url).not.toBe(second.url)
    } finally {
      first.close()
      second.close()
    }
  })
})

describe("advisor tool file", () => {
  test("registers the advisor and feedback tools as V2 plugins with restrictive permissions", async () => {
    const dir = await scratch()
    const [path, feedbackPath] = await installAdvisorTool({ dir })

    const source = await readFile(path, "utf8")
    expect(path).toBe(join(dir, "plugins", "advisor", "index.ts"))
    expect(JSON.parse(await readFile(join(dir, "plugins", "advisor", "package.json"), "utf8"))).toMatchObject({ main: "index.ts", type: "module" })
    // V2 hides plugin tools behind Code Mode unless told otherwise.
    expect(source).toContain("options: { codemode: false }")
    expect(source).toContain('import { Plugin } from "@opencode/plugin"')
    expect(source).toContain("ctx.tool.transform")
    expect(source).toContain('"advisor"')
    expect(source).toContain('input: { type: "object", properties: {} }')
    expect(source).toContain("context?.sessionID")
    expect((await stat(path)).mode & 0o777).toBe(0o600)

    expect(feedbackPath).toBe(join(dir, "plugins", "advisor_feedback", "index.ts"))
    const feedbackSource = await readFile(feedbackPath, "utf8")
    expect(feedbackSource).toContain('url.pathname = "/feedback"')
    expect(feedbackSource).toContain("context?.sessionID")
    expect(feedbackSource).toContain("partially-adopted")
    expect((await stat(feedbackPath)).mode & 0o777).toBe(0o600)
  })

  test("is a valid plugin that returns the bridge's advice", async () => {
    const dir = await scratch()
    // The generated plugin imports "@opencode/plugin"; rewrite the bare
    // specifier to the resolved module URL so the temp copy can be imported.
    const modulePath = join(dir, "advisor.mjs")
    const [installedPath] = await installAdvisorTool({ dir })
    const source = (await readFile(installedPath, "utf8")).replace(
      '"@opencode/plugin"',
      JSON.stringify(import.meta.resolve("@opencode/plugin")),
    )
    await writeFile(modulePath, source)
    const plugin = (await import(modulePath)).default

    let tool: { name: string; description: string; input: unknown; execute: (args: unknown, ctx: unknown) => Promise<{ content?: string }> } | undefined
    await plugin.setup({ tool: { transform: async (cb: (editor: { add: (t: typeof tool) => void }) => void) => { cb({ add: (t) => { tool = t } }) } } })
    expect(plugin.id).toBe("convoy-advisor")
    expect(tool?.name).toBe("advisor")
    expect(tool?.input).toEqual({ type: "object", properties: {} })
    expect(tool?.description).toContain("Takes no parameters")

    // No bridge configured: says so instead of throwing.
    delete process.env.CONVOY_ADVISOR_URL
    delete process.env.CONVOY_ADVISOR_TOKEN
    expect((await tool!.execute({}, { sessionID: "ses_1" })).content).toContain("no advisor configured")

    // Against a real bridge, it returns the advice verbatim.
    const bridge = await startAdvisorBridge({ advisors: () => stubRuntime({ ses_1: "Read the migration first." }).runtime })
    try {
      process.env.CONVOY_ADVISOR_URL = bridge.url
      process.env.CONVOY_ADVISOR_TOKEN = bridge.token
      expect((await tool!.execute({}, { sessionID: "ses_1" })).content).toBe("Read the migration first.")

      // A rejected token degrades rather than throwing into the agent loop.
      process.env.CONVOY_ADVISOR_TOKEN = "wrong"
      expect((await tool!.execute({}, { sessionID: "ses_1" })).content).toContain("advisor bridge returned 401")
    } finally {
      bridge.close()
      delete process.env.CONVOY_ADVISOR_URL
      delete process.env.CONVOY_ADVISOR_TOKEN
    }
  })

  test("rewrites only when the content changed, so OpenCode's watcher isn't churned", async () => {
    const dir = await scratch()
    const [path] = await installAdvisorTool({ dir })
    const expected = await readFile(path, "utf8")
    const first = (await stat(path)).mtimeMs

    await new Promise((resolve) => setTimeout(resolve, 20))
    await installAdvisorTool({ dir })
    expect((await stat(path)).mtimeMs).toBe(first)

    await writeFile(path, "// stale shim from an older Convoy\n")
    await installAdvisorTool({ dir })
    expect(await readFile(path, "utf8")).toBe(expected)
  })
})
