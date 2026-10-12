import { afterEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

import { opencodeConfig } from "../src/agents"
import { validateAuthoringSession } from "../src/conversations"
import { createOpencodeClient } from "../src/opencode-client"
import { toModelChoices } from "../src/model-catalog"
import { installWriteReportTool } from "../src/report-bridge"
import {
  answersToolResult,
  bootRuntime,
  createIsolatedRuntime,
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

async function boot(reply: Parameters<typeof startScriptedProvider>[0], withPlugin = false): Promise<Fixture> {
  const provider = startScriptedProvider(reply)
  cleanups.push(() => provider.stop())
  const runtime = await createIsolatedRuntime(scriptedProviderConfig(provider.url))
  cleanups.push(() => runtime.cleanup())
  const runDir = join(runtime.root, "run")
  await mkdir(runDir, { recursive: true })
  const plugins = withPlugin ? [dirname(await installWriteReportTool({ url: "http://127.0.0.1:1/report", token: "t", dir: join(runtime.root, "convoy-opencode") }))] : []
  const booted = await bootRuntime(runtime, opencodeConfig(runDir, runtime.checkout, undefined, undefined, { plugins }))
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

  test("the catalog lists custom providers and their variants as soon as the server is up", async () => {
    const fixture = await boot(() => ({ text: "done" }))
    const listed = await fixture.booted.client.provider.list({ directory: fixture.runtime.checkout })
    expect(listed.error).toBeUndefined()
    const choices = toModelChoices(listed.data!.all, listed.data!.connected).map((choice) => choice.value)
    expect(choices).toContain("mock/mock-model")
    expect(choices).toContain("mock/mock-model#deep")
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
