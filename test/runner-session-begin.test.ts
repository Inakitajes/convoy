/**
 * Session registration behind the bound services.
 *
 * Regression: once the attempt received services instead of the engine's
 * runtimes, nothing began the attempt's session with the report and advisor
 * runtimes. Every OpenCode `write_report` hit the bridge as an unknown session
 * (404), the deliverable candidate was never seen, and the advisor never had a
 * live phase. These tests drive the real bridge and the OpenCode binding.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { createAdvisorRuntime } from "../src/advisor-runtime"
import type { OpencodeClient } from "../src/opencode-client"
import { qualityDimensionWeights } from "../src/quality-score"
import { startReportBridge } from "../src/report-bridge"
import { createReportRuntime } from "../src/report-runtime"
import { validateDeliverableContract } from "../src/runners/quality-contract"
import { resolveRunnerCapabilities } from "../src/runners/capabilities"
import { bindOpencodeServices } from "../src/runners/opencode/services"
import type { ServiceRuntimes } from "../src/runners/service-runtimes"
import { beginSessionHandles, releaseSessionHandles } from "../src/runners/session-handles"
import { LoopGuard, resolveLoopGuard } from "../src/loop-guard"
import type { AgentStep, DeliverableContract } from "../src/types"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "convoy-session-begin-"))
  dirs.push(dir)
  return dir
}

const phase: AgentStep = {
  type: "agent",
  name: "scope",
  stepName: "scope",
  groupId: "g1",
  agentName: "review-scope",
  description: "Scope",
  model: "openrouter/deepseek/deepseek-v4.1-flash",
  inputFiles: ["prd.md"],
  inputDiff: false,
  reportPath: "reports/scope.md",
  readOnly: true,
}

const advisedPhase: AgentStep = {
  ...phase,
  name: "build",
  readOnly: false,
  advisor: "anthropic/claude-opus-5",
  resolvedAdvisor: {
    configured: "anthropic/claude-opus-5",
    logical: "anthropic/claude-opus-5",
    gateway: "configured",
    providerID: "anthropic",
    modelID: "claude-opus-5",
    target: "anthropic/claude-opus-5",
  },
}

const markdown: DeliverableContract = { kind: "markdown-report" }
const opencode = resolveRunnerCapabilities("opencode", { version: "2.0.28" })

function bind(runtimes: Partial<ServiceRuntimes> & { session: () => string | undefined }) {
  return bindOpencodeServices({ loopGuard: new LoopGuard(resolveLoopGuard({})), expected: ["report"], ...runtimes }, opencode)
}

async function post(url: string, token: string, body: unknown) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
}

describe("session registration behind the bound services", () => {
  test("write_report reaches the bridge only once the attempt's session began, and not after its release", async () => {
    const dir = await scratch()
    const reports = createReportRuntime(dir)
    const bridge = await startReportBridge({ reports: () => reports })
    let session: string | undefined
    const services = bind({ reports, session: () => session })
    try {
      session = "ses_1"
      // The bound service alone is not enough: this is the 404 every phase saw.
      expect((await post(bridge.url, bridge.token, { sessionID: "ses_1", payload: { markdown: "# Scope" } })).status).toBe(404)

      beginSessionHandles("ses_1", { services, reports, phase, contract: markdown, weights: qualityDimensionWeights, attempt: 1 })
      expect((await post(bridge.url, bridge.token, { sessionID: "ses_1", payload: { markdown: "# Scope" } })).status).toBe(200)
      expect(services.deliverables?.candidate?.()).toBe("# Scope")

      releaseSessionHandles("ses_1", reports)
      expect((await post(bridge.url, bridge.token, { sessionID: "ses_1", payload: { markdown: "late" } })).status).toBe(404)
    } finally {
      bridge.close()
    }
  })

  test("a runner that binds no services gets no handle", async () => {
    const reports = createReportRuntime(await scratch())
    beginSessionHandles("ses_claude", { services: {}, reports, phase, contract: markdown, weights: qualityDimensionWeights, attempt: 1 })
    expect(reports.handleFor("ses_claude")).toBeUndefined()
  })

  test("an advised phase has a live advisor once its session began", () => {
    const advisors = createAdvisorRuntime({
      client: {} as OpencodeClient,
      directory: "/repo",
      consult: async () => ({ kind: "advice", text: "ok" }),
    })
    let session: string | undefined
    const services = bind({ advisors, session: () => session })
    session = "ses_2"
    expect(services.advisor?.firstWriteGate).toBe("none")

    beginSessionHandles("ses_2", { services, advisors, phase: advisedPhase, contract: markdown, weights: qualityDimensionWeights, attempt: 1 })
    expect(advisors.handleFor("ses_2")).toBeDefined()
    expect(services.advisor?.firstWriteGate).toBe("hold")
  })
})

describe("deliverable acceptance for the report reminder", () => {
  async function setup() {
    const dir = await scratch()
    const reports = createReportRuntime(dir)
    const accepts = async (candidate: string | undefined) => {
      const text = candidate ?? (await Bun.file(join(dir, phase.reportPath)).text().catch(() => undefined))
      return text !== undefined && validateDeliverableContract(markdown, text, qualityDimensionWeights).valid
    }
    const services = bind({ reports, accepts, session: () => "ses_1" })
    beginSessionHandles("ses_1", { services, reports, phase, contract: markdown, weights: qualityDimensionWeights, attempt: 1 })
    return { dir, reports, services }
  }

  test("nothing written yet is not accepted", async () => {
    const { services } = await setup()
    expect(await services.deliverables?.accepted?.()).toBe(false)
  })

  test("an accepted write_report satisfies the contract", async () => {
    const { reports, services } = await setup()
    await reports.handleFor("ses_1")!.write({ markdown: "# Findings" })
    expect(await services.deliverables?.accepted?.()).toBe(true)
  })

  test("a report file written directly satisfies it too, so no reminder is sent", async () => {
    const { dir, services } = await setup()
    await mkdir(join(dir, "reports"), { recursive: true })
    await writeFile(join(dir, phase.reportPath), "# Findings")
    expect(await services.deliverables?.accepted?.()).toBe(true)
  })
})
