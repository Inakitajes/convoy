import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { createReportRuntime } from "../src/report-runtime"
import { createSessionDeliverableService } from "../src/runners/session-deliverables"
import { createSessionAdvisorService } from "../src/runners/session-advisor"
import type { AdvisorRuntime } from "../src/advisor-runtime"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("session-bound service-handle lifetime", () => {
  test("releasing the attempt's services makes a late submission and consult stale", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-opencode-lifecycle-"))
    dirs.push(dir)

    const runtime = createReportRuntime(dir)
    let calls = 0
    const phase = {
      type: "agent" as const,
      name: "review",
      stepName: "review",
      groupId: "g1",
      agentName: "bug-auditor",
      description: "Review",
      model: "openai/gpt-5.6-terra",
      inputFiles: [],
      inputDiff: false,
      reportPath: "reports/review.md",
    }
    runtime.begin("ses_1", phase, { kind: "markdown-report" }, { prd: 1, tests: 1, security: 1, maintainability: 1, operational: 1, scope: 1 })

    const advisorRuntime: AdvisorRuntime = {
      begin: () => undefined,
      handleFor: () => undefined,
      checkpoint: async () => ({ action: "allow" }),
    }
    calls += 1
    const deliverables = createSessionDeliverableService({ runtime, sessionID: "ses_1" })
    const advisor = createSessionAdvisorService({ runtime: advisorRuntime, sessionID: "ses_1" })

    // Before the phase decision, the services are live.
    expect((await deliverables.submit({ kind: "report", body: "# ok" })).ok).toBe(true)

    // The phase decision releases the attempt's handles.
    deliverables.release()
    advisor.release()

    const late = await deliverables.submit({ kind: "report", body: "# late" })
    expect(late.ok).toBe(false)
    if (!late.ok) expect(late.error).toContain("released")
    expect(advisor.satisfied()).toBe(true)
    expect(advisor.firstWriteGate).toBe("none")
    expect(calls).toBe(1)
  })
})
