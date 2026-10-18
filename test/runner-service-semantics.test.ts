/**
 * Semantic conformance for the optional service contracts (change
 * `unify-runner-system`, task 1.5).
 *
 * These tests do more than assert that a callback was invoked: they wire the
 * real Convoy domain logic (report runtime, advisor runtime, loop guard)
 * behind the neutral service vocabulary and assert the semantics an adapter
 * relies on — a rejection preserves the last accepted artifact, a protected
 * write stays blocked until the checkpoint is satisfied, and a repeated call
 * yields a stop decision rather than a silent observation.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LoopGuard, resolveLoopGuard, type LoopGuardObservation } from "../src/loop-guard"
import { createAdvisorRuntime } from "../src/advisor-runtime"
import { createReportRuntime } from "../src/report-runtime"
import { assertServicesSupported, resolveRunnerCapabilities, UnsupportedServiceError } from "../src/runners/capabilities"
import { createSessionAdvisorService } from "../src/runners/session-advisor"
import { createSessionDeliverableService } from "../src/runners/session-deliverables"
import type {
  AdvisorService,
  AttemptIdentity,
  DeliverableService,
  LoopGuardService,
  LoopObservation,
} from "../src/runners/contracts"
import type { AgentStep } from "../src/types"

const identity: AttemptIdentity = { runId: "run-1", phaseName: "implement", attempt: 1 }
const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("deliverable service semantics", () => {
  async function service(): Promise<DeliverableService> {
    const dir = await mkdtemp(join(tmpdir(), "convoy-service-semantics-"))
    dirs.push(dir)
    const runtime = createReportRuntime(dir)
    const phase = { type: "agent" as const, name: "review", stepName: "review", groupId: "g", agentName: "bug-auditor", description: "Review", model: "m", inputFiles: [], inputDiff: false, reportPath: "reports/review.md" }
    runtime.begin("ses_1", phase, { kind: "markdown-report" }, { prd: 1, tests: 1, security: 1, maintainability: 1, operational: 1, scope: 1 })
    return createSessionDeliverableService({ runtime, sessionID: "ses_1" })
  }

  test("an invalid submission is rejected without replacing the last accepted artifact", async () => {
    const deliverables = await service()
    expect(await deliverables.submit({ kind: "report", body: "# report" })).toEqual({ ok: true })

    const rejected = await deliverables.submit({ kind: "report", body: "   " })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      // The good artifact is preserved and the attempt may still correct it.
      expect(rejected.preserved).toBe(true)
      expect(rejected.retryable).toBe(true)
    }
    expect(deliverables.candidate?.()).toContain("# report")

    // A correction is accepted.
    expect(await deliverables.submit({ kind: "report", body: "# fixed" })).toEqual({ ok: true })
    expect(deliverables.candidate?.()).toContain("# fixed")
  })
})

describe("advisor service semantics", () => {
  function service(consult: () => Promise<{ text: string; ok: boolean; callId?: string }>): AdvisorService {
    const step = { type: "agent", name: "implement", resolvedAdvisor: { providerID: "claude-code", modelID: "opus" } } as unknown as AgentStep
    const runtime = createAdvisorRuntime({
      directory: "/tmp",
      consult: async () => {
        const advice = await consult()
        return advice.ok ? { kind: "advice", text: advice.text } : { kind: "error", code: "unavailable", message: advice.text }
      },
    })
    runtime.begin("ses_1", step)
    return createSessionAdvisorService({ runtime, sessionID: "ses_1" })
  }

  test("the first protected write is held for one consultation, then permitted", async () => {
    const advisor = service(async () => ({ text: "check the edge case", ok: true }))
    expect(advisor.firstWriteGate).toBe("hold")
    expect(advisor.satisfied()).toBe(false)
    const advice = await advisor.consult({ trigger: "first-write", question: "" })
    expect(advice).toMatchObject({ ok: true, text: "check the edge case" })
    expect(advisor.satisfied()).toBe(true)
  })

  test("a failed consultation degrades to guidance and still releases the hold", async () => {
    const advisor = service(async () => ({ text: "provider down", ok: false }))
    const advice = await advisor.consult({ trigger: "first-write", question: "" })
    expect(advice.ok).toBe(false)
    expect(advice.text).toContain("No advice this time")
    expect(advisor.satisfied()).toBe(true)
  })
})

describe("loop-guard service semantics", () => {
  function toGuardObservation(observation: LoopObservation): LoopGuardObservation {
    switch (observation.kind) {
      case "call":
        return { kind: "call", name: observation.tool, input: observation.args, callID: observation.callId }
      case "named":
        return { kind: "named", name: observation.tool, callID: observation.callId }
      case "result":
        return { kind: "result", name: observation.tool, callID: observation.callId, failed: observation.failed }
      case "step":
        return { kind: "step" }
      case "usage":
        return { kind: "cost", messageID: observation.messageId ?? "message", cost: observation.usage.costEstimate ?? 0 }
    }
  }

  function service(): LoopGuardService {
    const guard = new LoopGuard(resolveLoopGuard({ identicalCalls: 2, maxPhaseCost: false }))
    return {
      observe(observation) {
        const trip = guard.observe(toGuardObservation(observation))
        if (!trip) return { action: "continue" }
        if (trip.reason === "soft-nudge") return { action: "nudge", reason: trip.message }
        return { action: "stop", code: trip.reason, reason: trip.message }
      },
    }
  }

  test("repeated calls yield a stop decision, not a silent observation", () => {
    const loopGuard = service()
    expect(loopGuard.observe({ kind: "call", tool: "read", args: { path: "a" }, callId: "1" })).toEqual({ action: "continue" })
    const decision = loopGuard.observe({ kind: "call", tool: "read", args: { path: "a" }, callId: "2" })
    expect(decision.action).toBe("stop")
    if (decision.action === "stop") {
      expect(decision.code).toBe("identical-calls")
      expect(decision.reason).toContain("read")
    }
  })

  test("a model step is observed without stopping", () => {
    expect(service().observe({ kind: "step" })).toEqual({ action: "continue" })
  })
})

describe("required-service refusal", () => {
  test("a runner that does not implement a required service is refused by capability", () => {
    const claude = resolveRunnerCapabilities("claude-code", { enforcementReady: true })
    try {
      assertServicesSupported(claude, ["loop-guard"])
      throw new Error("expected a refusal")
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedServiceError)
      expect((error as UnsupportedServiceError).service).toBe("loop-guard")
    }

    const opencode = resolveRunnerCapabilities("opencode", { version: "2.0.28" })
    expect(() => assertServicesSupported(opencode, ["deliverables", "advisor", "loop-guard"])).not.toThrow()
  })
})
