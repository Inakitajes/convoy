import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { createReportRuntime } from "../src/report-runtime"
import { isConfirmedRelease } from "../src/runners/contracts"
import { createOpencodeRunner, releaseOutcomeOf } from "../src/runners/opencode/adapter"
import { createOpencodeDeliverableService } from "../src/runners/opencode/deliverables"
import { createOpencodeAdvisorService } from "../src/runners/opencode/advisor"
import type { AdvisorRuntime } from "../src/advisor-runtime"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("release outcome mapping", () => {
  test("an observed stop is a confirmed release; an unresolved stop is not", () => {
    expect(releaseOutcomeOf({ status: "stopped", via: "graceful" })).toEqual({ status: "released" })
    expect(releaseOutcomeOf({ status: "stopped", via: "already-gone" })).toEqual({ status: "released" })
    const unresolved = releaseOutcomeOf({ status: "unresolved", reason: "child exit not observed" })
    expect(unresolved).toEqual({ status: "unresolved", reason: "child exit not observed" })

    expect(isConfirmedRelease({ status: "released" })).toBe(true)
    expect(isConfirmedRelease({ status: "not-owned" })).toBe(true)
    expect(isConfirmedRelease(unresolved)).toBe(false)
  })
})

describe("adapter runtime release", () => {
  test("releasing an adapter that never booted is not-owned, not a false stop", async () => {
    const runner = createOpencodeRunner({ cwd: "/tmp" })
    expect(await runner.release()).toEqual({ status: "not-owned" })
    // Close stays idempotent.
    await runner.close()
    await runner.close()
  })
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
    const deliverables = createOpencodeDeliverableService({ runtime, sessionID: "ses_1" })
    const advisor = createOpencodeAdvisorService({ runtime: advisorRuntime, sessionID: "ses_1" })

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
