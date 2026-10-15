/**
 * Semantic conformance for the optional service contracts (change
 * `unify-runner-system`, task 1.5).
 *
 * These tests do more than assert that a callback was invoked: they wire the
 * real Convoy domain logic (deliverable ledger, advisor checkpoint, loop guard)
 * behind the neutral service vocabulary and assert the semantics an adapter
 * relies on — a rejection preserves the last accepted artifact, a protected
 * write stays blocked until the checkpoint is satisfied, and a repeated call
 * yields a stop decision rather than a silent observation.
 */

import { describe, expect, test } from "bun:test"

import { LoopGuard, resolveLoopGuard, type LoopGuardObservation } from "../src/loop-guard"
import { AdvisorCheckpoint } from "../src/runners/advisor-consult"
import { assertServicesSupported, resolveRunnerCapabilities, UnsupportedServiceError } from "../src/runners/capabilities"
import { DeliverableLedger } from "../src/runners/deliverables"
import type {
  AdvisorService,
  AttemptIdentity,
  DeliverableService,
  LoopGuardService,
  LoopObservation,
} from "../src/runners/contracts"

const identity: AttemptIdentity = { runId: "run-1", phaseName: "implement", attempt: 1 }
const attempt = { runId: identity.runId, phase: identity.phaseName, attempt: identity.attempt }

describe("deliverable service semantics", () => {
  function service(maxCorrections = 2): DeliverableService {
    const ledger = new DeliverableLedger({ maxCorrections })
    return {
      expected: ["report"],
      async submit(submission) {
        const result = ledger.submit({
          kind: submission.kind,
          attempt,
          body: submission.body,
        })
        if (result.ok) return { ok: true }
        return {
          ok: false,
          error: result.error,
          retryable: result.correctionsRemaining > 0,
          preserved: result.candidate !== undefined,
        }
      },
    }
  }

  test("an invalid submission is rejected without replacing the last accepted artifact", async () => {
    const deliverables = service()
    expect(await deliverables.submit({ kind: "report", body: "# report" })).toEqual({ ok: true })

    const rejected = await deliverables.submit({ kind: "report", body: "   " })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.error).toContain("non-empty")
      // The good artifact is preserved and the attempt may still correct it.
      expect(rejected.preserved).toBe(true)
      expect(rejected.retryable).toBe(true)
    }

    // A correction is accepted.
    expect(await deliverables.submit({ kind: "report", body: "# fixed" })).toEqual({ ok: true })
  })
})

describe("advisor service semantics", () => {
  function service(): AdvisorService {
    const checkpoint = new AdvisorCheckpoint({ executor: "opencode", requireBeforeWrite: true })
    return {
      firstWriteGate: "block",
      satisfied: () => checkpoint.satisfied(attempt),
      async consult(consultation) {
        const result = await checkpoint.consult(attempt, async () => ({ runner: "claude-code", text: consultation.question }))
        return { text: result.text, ok: true }
      },
    }
  }

  /** The protected-work gate an adapter applies before a mutation. */
  function mayWrite(advisor: AdvisorService): boolean {
    return advisor.firstWriteGate !== "block" || advisor.satisfied()
  }

  test("a blocking gate holds a protected write until the checkpoint is satisfied", async () => {
    const advisor = service()
    expect(advisor.firstWriteGate).toBe("block")
    expect(mayWrite(advisor)).toBe(false)

    const advice = await advisor.consult({ trigger: "first-write", question: "Proceed?" })
    expect(advice.ok).toBe(true)
    expect(mayWrite(advisor)).toBe(true)
  })

  test("a failed consultation leaves the checkpoint blocked", async () => {
    const checkpoint = new AdvisorCheckpoint({ executor: "opencode", requireBeforeWrite: true })
    await expect(checkpoint.consult(attempt, async () => ({ runner: "claude-code", text: "  " }))).rejects.toThrow()
    expect(checkpoint.satisfied(attempt)).toBe(false)
  })
})

describe("loop-guard service semantics", () => {
  function toGuardObservation(observation: LoopObservation): LoopGuardObservation {
    switch (observation.kind) {
      case "call":
        return { kind: "call", name: observation.tool, input: observation.args, callID: observation.callId }
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
