import { afterEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

import { opencodeConfig } from "../src/agents"
import { validateAuthoringSession } from "../src/conversations"
import { createOpencodeClient } from "../src/opencode-client"
import { builtInAgents } from "../src/pipeline"
import { installWriteReportTool } from "../src/report-bridge"
import { writeReportToolName } from "../src/report"
import { serverAuthPath } from "../src/server-auth"
import { runPrivateDir } from "../src/workspace"
import {
  answersToolResult,
  bootRuntime,
  createIsolatedRuntime,
  offeredTool,
  offeredTools,
  opencodeAvailable,
  scriptedProviderConfig,
  startScriptedProvider,
  waitFor,
  type BootedRuntime,
  type IsolatedRuntime,
  type ScriptedProvider,
} from "./helpers/opencode-v2"

/**
 * Behavior of Convoy's V2 integration against the real `opencode` runtime
 * (change `migrate-opencode-v2`). Model turns go to a scripted local provider,
 * so these run deterministically and never reach a paid model. Skipped when no
 * `opencode` binary is on PATH.
 */

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Fixture = { runtime: IsolatedRuntime; provider: ScriptedProvider; booted: BootedRuntime; runDir: string }

// A run configures only its pipeline's agents. All built-ins together exceed
// Linux's 128 KiB limit on a single environment variable (E2BIG at spawn).
const fixtureAgents = builtInAgents.filter((agent) => agent.name === "implementer" || agent.name === "bug-auditor" || agent.name === "quality-scorer")

async function boot(reply: Parameters<typeof startScriptedProvider>[0], withPlugin = false): Promise<Fixture> {
  const provider = startScriptedProvider(reply)
  cleanups.push(() => provider.stop())
  const runtime = await createIsolatedRuntime(scriptedProviderConfig(provider.url))
  cleanups.push(() => runtime.cleanup())
  const runDir = join(runtime.root, "run")
  await mkdir(runDir, { recursive: true })
  const plugins = withPlugin ? [dirname(await installWriteReportTool({ url: "http://127.0.0.1:1/report", token: "t", dir: join(runtime.root, "convoy-opencode"), agents: fixtureAgents }))] : []
  const booted = await bootRuntime(runtime, opencodeConfig(runDir, runtime.checkout, fixtureAgents, undefined, { plugins }))
  cleanups.push(() => booted.server.stop())
  return { runtime, provider, booted, runDir }
}

async function prompt(fixture: Fixture, input: { agent?: string; variant?: string; text?: string } = {}): Promise<string> {
  const { client } = fixture.booted
  const session = await client.session.create({ directory: fixture.runtime.checkout })
  const sessionID = session.data!.id
  const admitted = await client.session.promptAsync({
    sessionID,
    directory: fixture.runtime.checkout,
    ...(input.agent ? { agent: input.agent } : {}),
    model: { providerID: "mock", modelID: "mock-model" },
    ...(input.variant ? { variant: input.variant } : {}),
    parts: [{ type: "text", text: input.text ?? "go" }],
  })
  expect(admitted.error).toBeUndefined()
  return sessionID
}

async function settled(fixture: Fixture, sessionID: string): Promise<void> {
  // Settled: the session is no longer active and its last assistant message completed.
  const done = await waitFor(async () => {
    const status = await fixture.booted.client.session.status({})
    if (status.data === undefined || status.data[sessionID] !== undefined) return false
    const messages = await fixture.booted.client.session.messages({ sessionID })
    const last = messages.data?.filter((message) => message.info.role === "assistant").at(-1)
    return last !== undefined && last.info.role === "assistant" && last.info.time.completed !== undefined
  }, 15_000)
  expect(done).toBe(true)
}

// Has the implementer read a run-dir file (seeded with a sentinel), returning
// what the model saw and the tool call's outcome.
async function readRunFile(pathIn: (runDir: string) => string): Promise<{ result: string; status: unknown }> {
  let path = ""
  const fixture = await boot((body) =>
    answersToolResult(body) ? { text: "done" } : offeredTools(body).length ? { tool: "read", args: { path } } : { text: "title" },
  )
  path = pathIn(fixture.runDir)
  await Bun.write(path, "SECRET-SENTINEL\n")
  const sessionID = await prompt(fixture, { agent: "implementer" })
  await settled(fixture, sessionID)
  const answered = fixture.provider.requests.find(answersToolResult)
  const messages = await fixture.booted.client.session.messages({ sessionID })
  const tool = messages.data!.flatMap((message) => message.parts).find((part) => part.type === "tool") as { state?: { status?: unknown } } | undefined
  const toolMessages = ((answered?.messages ?? []) as Array<{ role?: string }>).filter((message) => message.role === "tool")
  return { result: JSON.stringify(toolMessages), status: tool?.state?.status }
}

const gitLog = async (checkout: string) => (await Bun.$`git log --format=%s`.cwd(checkout).quiet().text()).trim()

describe.if(opencodeAvailable)("Convoy run config on the real V2 runtime", () => {
  test("a hard-denied shell command is denied by the runtime, never asked", async () => {
    const fixture = await boot((body) =>
      answersToolResult(body) ? { text: "done" } : offeredTools(body).length ? { tool: "shell", args: { command: "git commit --allow-empty -m bypassed", description: "probe" } } : { text: "title" },
    )
    const asked: unknown[] = []
    const controller = new AbortController()
    cleanups.push(() => controller.abort())
    const events = await fixture.booted.client.event.subscribe({}, { signal: controller.signal })
    void (async () => {
      try {
        for await (const event of events.stream) if ((event as { type?: string }).type === "permission.asked") asked.push(event)
      } catch {
        // aborted at cleanup
      }
    })()
    const sessionID = await prompt(fixture, { agent: "implementer" })
    await settled(fixture, sessionID)
    expect(asked).toEqual([])
    expect(await gitLog(fixture.runtime.checkout)).toBe("init")
  }, 40_000)

  test("an allowlisted check runs without asking", async () => {
    const fixture = await boot((body) =>
      answersToolResult(body) ? { text: "done" } : offeredTools(body).length ? { tool: "shell", args: { command: "git status", description: "probe" } } : { text: "title" },
    )
    const sessionID = await prompt(fixture, { agent: "implementer" })
    await settled(fixture, sessionID)
    const messages = await fixture.booted.client.session.messages({ sessionID })
    const tool = messages.data!.flatMap((message) => message.parts).find((part) => part.type === "tool")
    expect(tool).toMatchObject({ type: "tool", state: { status: "completed" } })
  }, 40_000)

  // The run dir is readable for reports, but the server password and the
  // plugins' bridge tokens in it are not: with them an agent could talk to the
  // server or the bridges past Convoy's gate.
  for (const [label, path] of [
    ["the server password", (runDir: string) => serverAuthPath(runDir)],
    ["a plugin's bridge token", (runDir: string) => join(runPrivateDir(runDir), "plugins", writeReportToolName, "index.ts")],
  ] as const) {
    test(`an agent cannot read ${label} from the run dir`, async () => {
      const fixture = await readRunFile(path)
      expect(fixture.result).not.toContain("SECRET-SENTINEL")
      expect(fixture.status).toBe("error")
    }, 40_000)
  }

  test("an agent still reads the run dir's other files", async () => {
    const fixture = await readRunFile((runDir) => join(runDir, "notes.md"))
    expect(fixture.result).toContain("SECRET-SENTINEL")
    expect(fixture.status).toBe("completed")
  }, 40_000)

  // Parity blocker (recorded in the change's acceptance matrix): V2 normalizes
  // an agent's temperature into its `request.body`, but opencode 2.0.26 does
  // not forward agent request overlays to the provider. Flips to passing when
  // the runtime does, which is the signal to drop `.failing`.
  test.failing("an agent's configured temperature reaches the model request", async () => {
    const fixture = await boot(() => ({ text: "done" }))
    const sessionID = await prompt(fixture, { agent: "bug-auditor" })
    await settled(fixture, sessionID)
    const turn = fixture.provider.requests.find((body) => offeredTools(body).length > 0)
    expect(turn?.temperature).toBe(0.1)
  }, 40_000)

  test("the write_report plugin tool is offered to the model directly", async () => {
    const fixture = await boot(() => ({ text: "done" }), true)
    const sessionID = await prompt(fixture, { agent: "implementer" })
    await settled(fixture, sessionID)
    const turn = fixture.provider.requests.find((body) => offeredTools(body).length > 0)
    expect(offeredTools(turn)).toContain("write_report")
  }, 40_000)

  test("each agent is offered the write_report schema of its own phase scope", async () => {
    const fixture = await boot(() => ({ text: "done" }), true)
    const schemas: Record<string, { properties: Record<string, unknown>; required: string[] } | undefined> = {}
    for (const agent of ["implementer", "bug-auditor", "quality-scorer"]) {
      const before = fixture.provider.requests.length
      const sessionID = await prompt(fixture, { agent })
      await settled(fixture, sessionID)
      const turn = fixture.provider.requests.slice(before).find((body) => offeredTools(body).length > 0)
      schemas[agent] = offeredTool(turn, writeReportToolName)
    }
    expect(Object.keys(schemas.implementer!.properties).sort()).toEqual(["commit", "markdown"])
    expect(Object.keys(schemas["bug-auditor"]!.properties)).toEqual(["markdown"])
    const scorer = schemas["quality-scorer"]!
    expect(scorer.properties.commit).toBeUndefined()
    expect(scorer.required).toEqual(["markdown", "dimensions"])
    expect(scorer.properties.dimensions).toMatchObject({ required: ["prd", "tests", "security", "maintainability", "operational", "scope"], properties: { prd: { type: "number", minimum: 0, maximum: 100 } } })
  }, 60_000)

  test("the operator's global provider config still loads alongside the run config", async () => {
    const fixture = await boot(() => ({ text: "done" }), true)
    const sessionID = await prompt(fixture)
    await settled(fixture, sessionID)
    expect(fixture.provider.requests.length).toBeGreaterThan(0)
  }, 40_000)
})

describe.if(opencodeAvailable)("Convoy V2 client boundary on the real runtime", () => {
  test("a selected variant reaches the model request", async () => {
    const fixture = await boot(() => ({ text: "done" }))
    const sessionID = await prompt(fixture, { variant: "deep" })
    await settled(fixture, sessionID)
    const turn = fixture.provider.requests.find((body) => offeredTools(body).length > 0)
    expect(turn?.reasoning_effort).toBe("high")
  }, 40_000)

  test("history carries its session id and tool call identities", async () => {
    const fixture = await boot((body) =>
      answersToolResult(body) ? { text: "done" } : offeredTools(body).length ? { tool: "read", args: { path: "README.md" } } : { text: "title" },
    )
    const sessionID = await prompt(fixture)
    await settled(fixture, sessionID)
    const messages = await fixture.booted.client.session.messages({ sessionID })
    expect(messages.data!.length).toBeGreaterThan(0)
    for (const message of messages.data!) expect(message.info.sessionID).toBe(sessionID)
    const tool = messages.data!.flatMap((message) => message.parts).find((part) => part.type === "tool")
    expect(tool).toMatchObject({ type: "tool", tool: "read" })
    expect(typeof (tool as { callID?: unknown }).callID).toBe("string")
    // The attempt log records why each assistant turn ended.
    const finishes = messages.data!.flatMap((message) => (message.info.role === "assistant" ? [message.info.finish] : []))
    expect(finishes).toContain("tool-calls")
    expect(finishes.at(-1)).toBe("stop")
  }, 40_000)
})

describe.if(opencodeAvailable)("Convoy prompt admission on the real runtime", () => {
  // The prompt was admitted but its response never arrived: the turn must be
  // reconciled by its identity, never reported as failed (a caller's retry
  // would then run the same turn twice).
  test("an admitted prompt whose response is lost is reconciled, not failed", async () => {
    const fixture = await boot(() => ({ text: "done" }))
    let dropped = false
    const lossy = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const response = await fetch(input, init)
        const url = input instanceof Request ? input.url : String(input)
        const method = input instanceof Request ? input.method : (init?.method ?? "GET")
        if (!dropped && method === "POST" && /\/prompt$/.test(new URL(url).pathname)) {
          dropped = true
          throw new TypeError("connection reset after admission")
        }
        return response
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch
    const client = createOpencodeClient({ baseUrl: fixture.booted.server.url, password: fixture.booted.server.password!, fetch: lossy })
    const session = await client.session.create({ directory: fixture.runtime.checkout })
    const sessionID = session.data!.id

    const admitted = await client.session.promptAsync({ sessionID, model: { providerID: "mock", modelID: "mock-model" }, parts: [{ type: "text", text: "go" }] })

    expect(dropped).toBe(true)
    expect(admitted.error).toBeUndefined()
    expect(admitted.data).toMatchObject({ id: expect.stringMatching(/^msg_/) })
    await settled(fixture, sessionID)
    const history = await fixture.booted.client.session.messages({ sessionID })
    expect(history.data!.filter((message) => message.info.role === "user")).toHaveLength(1)
  }, 40_000)

  // V2's `wait` returns at once when the turn has not started executing yet
  // (seen with gpt-6-luna on the commit writer): a helper must still wait for
  // its own turn instead of failing with no reply.
  test("a helper prompt settles its turn even when wait returns before execution starts", async () => {
    const fixture = await boot(() => ({ text: "the reply" }))
    let early = false
    const racing = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (!early && url.pathname.endsWith("/wait")) {
          early = true
          return new Response(null, { status: 204 })
        }
        return await fetch(input, init)
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch
    const client = createOpencodeClient({ baseUrl: fixture.booted.server.url, password: fixture.booted.server.password!, fetch: racing })
    const session = await client.session.create({ directory: fixture.runtime.checkout })

    const reply = await client.session.prompt({ sessionID: session.data!.id, model: { providerID: "mock", modelID: "mock-model" }, parts: [{ type: "text", text: "go" }] })

    expect(early).toBe(true)
    expect(reply.error).toBeUndefined()
    const text = reply.data!.parts.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("")
    expect(text).toBe("the reply")
  }, 40_000)

  // A helper's blocking prompt settles its own turn: a turn that fails must not
  // hand back the previous turn's assistant output as its result.
  test("a helper prompt never returns an earlier turn's reply as its result", async () => {
    const fixture = await boot((body) => (JSON.stringify(body.messages).includes("second") ? { status: 400 } : { text: "first answer" }))
    const { client } = fixture.booted
    const session = await client.session.create({ directory: fixture.runtime.checkout })
    const sessionID = session.data!.id
    const model = { providerID: "mock", modelID: "mock-model" }

    const first = await client.session.prompt({ sessionID, model, parts: [{ type: "text", text: "first" }] })
    expect(first.error).toBeUndefined()
    const second = await client.session.prompt({ sessionID, model, parts: [{ type: "text", text: "second" }] })

    const text = second.data?.parts.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("") ?? ""
    expect(text).not.toContain("first answer")
    expect(second.error !== undefined || second.data?.info.error !== undefined).toBe(true)
  }, 40_000)
})

describe.if(opencodeAvailable)("Stored session verification on the real runtime", () => {
  // V2's `--session <id>` creates a missing session, so continuation relies on
  // this lookup refusing an unknown id rather than creating one.
  test("an existing session verifies and an unknown one is refused without being created", async () => {
    const runtime = await createIsolatedRuntime()
    cleanups.push(() => runtime.cleanup())
    const booted = await bootRuntime(runtime)
    cleanups.push(() => booted.server.stop())
    const server = { url: booted.server.url, password: booted.server.password! }
    const session = await booted.client.session.create({ directory: runtime.checkout, title: "stored" })

    const found = await validateAuthoringSession({ ref: { harness: "opencode", sessionId: session.data!.id }, checkout: runtime.checkout, server })
    expect(found.status).toBe("available")
    const missing = await validateAuthoringSession({ ref: { harness: "opencode", sessionId: "ses_doesnotexist" }, checkout: runtime.checkout, server })
    expect(missing.status).toBe("unavailable")
    const listed = await booted.client.session.list({ directory: runtime.checkout })
    expect(listed.data!.map((entry) => entry.id)).toEqual([session.data!.id])
  }, 40_000)
})
