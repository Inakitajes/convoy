import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { createReportRuntime } from "../src/report-runtime"
import { createSessionDeliverableService } from "../src/runners/session-deliverables"
import { loadCommitSidecar, sidecarPathFor } from "../src/step-commit"
import { qualityDimensionWeights } from "../src/quality-score"
import type { AgentStep, DeliverableContract } from "../src/types"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-opencode-deliverables-"))
  dirs.push(dir)
  return dir
}

function phase(extra: Partial<AgentStep> = {}): AgentStep {
  return {
    type: "agent",
    name: "review",
    stepName: "review",
    groupId: "g1",
    agentName: "bug-auditor",
    description: "Review",
    model: "openai/gpt-5.6-terra",
    inputFiles: ["prd.md"],
    inputDiff: false,
    reportPath: "reports/review.md",
    ...extra,
  }
}

const markdownContract: DeliverableContract = { kind: "markdown-report" }
const dimensions = { prd: 92, tests: 70, security: 95, maintainability: 88, operational: 90, scope: 85 }

function service(dir: string, sessionID: string, phaseOverride: Partial<AgentStep> = {}) {
  const runtime = createReportRuntime(dir)
  const handle = runtime.begin(sessionID, phase(phaseOverride), markdownContract, qualityDimensionWeights)
  return { runtime, handle, service: createSessionDeliverableService({ runtime, sessionID }) }
}

describe("OpenCode deliverable service", () => {
  test("accepts a report and persists it through the write_report transport", async () => {
    const dir = await workspace()
    const { service: deliverables } = service(dir, "ses_1")
    expect(await deliverables.submit({ kind: "report", body: "# Findings\n\nNo blockers." })).toEqual({ ok: true })
    expect(await readFile(join(dir, "reports/review.md"), "utf8")).toBe("# Findings\n\nNo blockers.")
  })

  test("carries structured commit metadata onto the report sidecar", async () => {
    const dir = await workspace()
    const { service: deliverables } = service(dir, "ses_1")
    const committed = await deliverables.submit({
      kind: "report",
      body: "# Findings",
      commit: { subject: "tighten the review", details: ["cover the tests dimension"] },
    })
    expect(committed).toEqual({ ok: true })
    const sidecar = await loadCommitSidecar(join(dir, "reports/review.md"))
    expect(sidecar?.subject).toBe("tighten the review")
    expect(await readFile(sidecarPathFor(join(dir, "reports/review.md")), "utf8")).toContain("tighten the review")
  })

  test("accepts a scoring submission from a scoring agent", async () => {
    const dir = await workspace()
    const { handle, service: deliverables } = service(dir, "ses_1", { agentName: "quality-scorer" })
    const submitted = await deliverables.submit({
      kind: "score",
      body: JSON.stringify({ markdown: "# Score", dimensions, mustFix: ["add tests"] }),
    })
    expect(submitted).toEqual({ ok: true })
    expect(handle.candidate).toContain("# Score")
  })

  test("an invalid resubmission is rejected and preserves the last accepted artifact", async () => {
    const dir = await workspace()
    const { service: deliverables } = service(dir, "ses_1")
    expect(await deliverables.submit({ kind: "report", body: "# Good" })).toEqual({ ok: true })

    const rejected = await deliverables.submit({ kind: "report", body: "   " })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.retryable).toBe(true)
      expect(rejected.preserved).toBe(true)
    }
    // The good artifact is still on disk.
    expect(await readFile(join(dir, "reports/review.md"), "utf8")).toBe("# Good")
  })

  test("a submission for a released session is refused as stale", async () => {
    const dir = await workspace()
    const { service: deliverables, handle } = service(dir, "ses_1")
    handle.end()
    const stale = await deliverables.submit({ kind: "report", body: "# late" })
    expect(stale).toEqual({ ok: false, error: "no live report session for this attempt", retryable: false, preserved: false })

    const other = createSessionDeliverableService({ runtime: createReportRuntime(dir), sessionID: "ses_2" })
    other.release()
    const released = await other.submit({ kind: "report", body: "# late" })
    expect(released.ok).toBe(false)
    if (!released.ok) {
      expect(released.retryable).toBe(false)
      expect(released.error).toContain("released")
    }
  })

  test("a separate commit-description artifact is refused with a reason", async () => {
    const dir = await workspace()
    const { service: deliverables } = service(dir, "ses_1")
    const result = await deliverables.submit({ kind: "commit-description", body: "subject" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("commit metadata on the report")
  })
})
