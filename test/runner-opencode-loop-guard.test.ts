import { describe, expect, test } from "bun:test"

import { LoopGuard, resolveLoopGuard } from "../src/loop-guard"
import { createOpencodeLoopGuardService, decideFromTrip, toGuardObservation } from "../src/runners/opencode/loop-guard"

function service(settings: Parameters<typeof resolveLoopGuard>[0] = {}): ReturnType<typeof createOpencodeLoopGuardService> {
  return createOpencodeLoopGuardService(new LoopGuard(resolveLoopGuard({ maxPhaseCost: false, ...settings })))
}

describe("OpenCode loop-guard service", () => {
  test("repeated identical calls stop the attempt", () => {
    const guard = service({ identicalCalls: 2 })
    expect(guard.observe({ kind: "call", tool: "read", args: { path: "a" }, callId: "1" })).toEqual({ action: "continue" })
    const decision = guard.observe({ kind: "call", tool: "read", args: { path: "a" }, callId: "2" })
    expect(decision.action).toBe("stop")
    if (decision.action === "stop") {
      expect(decision.code).toBe("identical-calls")
      expect(decision.reason).toContain("read")
    }
  })

  test("repeated failures of the same correlated tool stop the attempt", () => {
    const guard = service({ sameToolFailures: 2 })
    expect(guard.observe({ kind: "result", tool: "bash", callId: "1", failed: true })).toEqual({ action: "continue" })
    const decision = guard.observe({ kind: "result", tool: "bash", callId: "2", failed: true })
    expect(decision.action).toBe("stop")
    if (decision.action === "stop") expect(decision.code).toBe("same-tool-failures")
  })

  test("a soft nudge is a nudge, then the hard cap stops", () => {
    const guard = service({ maxSteps: 4 })
    expect(guard.observe({ kind: "step" })).toEqual({ action: "continue" })
    const nudge = guard.observe({ kind: "step" })
    expect(nudge.action).toBe("nudge")
    expect(guard.observe({ kind: "step" })).toEqual({ action: "continue" })
    const stop = guard.observe({ kind: "step" })
    expect(stop.action).toBe("stop")
    if (stop.action === "stop") expect(stop.code).toBe("max-steps")
  })

  test("cumulative usage for one message is folded as a delta and never double-counted", () => {
    const guard = service({ maxPhaseCost: 0.05 })
    const usage = (costEstimate: number) => guard.observe({ kind: "usage", usage: { costEstimate }, messageId: "m1" })
    expect(usage(0.02)).toEqual({ action: "continue" })
    // Repeated cumulative value: no new delta, no double count.
    expect(usage(0.04)).toEqual({ action: "continue" })
    expect(usage(0.04)).toEqual({ action: "continue" })
    const stop = usage(0.06)
    expect(stop.action).toBe("stop")
    if (stop.action === "stop") expect(stop.code).toBe("max-cost")
  })

  test("a step-budget reset clears steps but retains the cost history", () => {
    const live = new LoopGuard(resolveLoopGuard({ maxPhaseCost: 0.05 }))
    const withReset = createOpencodeLoopGuardService(live)
    expect(withReset.observe({ kind: "usage", usage: { costEstimate: 0.04 }, messageId: "m1" })).toEqual({ action: "continue" })
    live.resetSteps()
    const stop = withReset.observe({ kind: "usage", usage: { costEstimate: 0.02 }, messageId: "m2" })
    expect(stop.action).toBe("stop")
    if (stop.action === "stop") expect(stop.code).toBe("max-cost")
  })

  test("a usage observation without a cost estimate feeds nothing", () => {
    expect(toGuardObservation({ kind: "usage", usage: { input: 10 } })).toBeUndefined()
    expect(toGuardObservation({ kind: "call", tool: "read", args: { a: 1 }, callId: "c" })).toEqual({ kind: "call", name: "read", input: { a: 1 }, callID: "c" })
  })

  test("a soft-nudge trip maps to a nudge, other trips to a stop", () => {
    expect(decideFromTrip({ reason: "soft-nudge", message: "half budget", count: 50 })).toEqual({ action: "nudge", reason: "half budget" })
    expect(decideFromTrip({ reason: "max-steps", message: "cap", count: 100 })).toEqual({ action: "stop", code: "max-steps", reason: "cap" })
  })
})
