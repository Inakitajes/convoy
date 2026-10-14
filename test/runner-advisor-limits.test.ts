import { describe, expect, test } from "bun:test"

import { AdvisorBudget, applyLimits, type AdvisorLimits } from "../src/runners/advisor-limits"

const limits: AdvisorLimits = { maxCalls: 5, maxOutputChars: 100, deadlineMs: 1_000 }
const attemptA = { runId: "run-1", phase: "implement", attempt: 1 }
const attemptB = { runId: "run-1", phase: "implement", attempt: 2 }

describe("applyLimits", () => {
  test("adds one call and the output, staying within bounds", () => {
    const result = applyLimits({ calls: 0, outputChars: 0 }, { outputChars: 40 }, limits)
    expect(result.ok).toBe(true)
    expect(result.usage).toEqual({ calls: 1, outputChars: 40 })
    expect(result.reason).toBeUndefined()
  })

  test("reports the call limit without losing the resulting usage", () => {
    const result = applyLimits({ calls: 5, outputChars: 0 }, { outputChars: 1 }, limits)
    expect(result.ok).toBe(false)
    expect(result.usage.calls).toBe(6)
    expect(result.reason).toBe("advisor call limit exceeded (6/5)")
  })

  test("reports the output limit", () => {
    const result = applyLimits({ calls: 0, outputChars: 90 }, { outputChars: 20 }, limits)
    expect(result.ok).toBe(false)
    expect(result.usage.outputChars).toBe(110)
    expect(result.reason).toBe("advisor output limit exceeded (110/100 chars)")
  })

  test("sums cost estimates and keeps an unknown estimate unknown", () => {
    const known = applyLimits({ calls: 0, outputChars: 0, costEstimateUsd: 0.5 }, { outputChars: 1, costEstimateUsd: 0.25 }, limits)
    expect(known.usage.costEstimateUsd).toBeCloseTo(0.75)

    const unknown = applyLimits({ calls: 0, outputChars: 0 }, { outputChars: 1 }, limits)
    expect("costEstimateUsd" in unknown.usage).toBe(false)
  })

  test("a non-positive limit means no bound", () => {
    const unbounded: AdvisorLimits = { maxCalls: 0, maxOutputChars: 0, deadlineMs: 0 }
    const result = applyLimits({ calls: 999, outputChars: 999_999 }, { outputChars: 5 }, unbounded)
    expect(result.ok).toBe(true)
  })
})

describe("advisor budget", () => {
  test("enforces the per-attempt call limit", () => {
    const budget = new AdvisorBudget({ limits: { maxCalls: 2, maxOutputChars: 100, deadlineMs: 0 } })
    const first = budget.begin(attemptA)
    expect(first.ok).toBe(true)
    if (first.ok) first.call.settle({ outputChars: 1 })
    const second = budget.begin(attemptA)
    expect(second.ok).toBe(true)
    if (second.ok) second.call.settle({ outputChars: 1 })

    const third = budget.begin(attemptA)
    expect(third.ok).toBe(false)
    if (!third.ok) expect(third.reason).toBe("advisor call limit reached (2/2)")
  })

  test("settles calls and attributes output exactly once", () => {
    const budget = new AdvisorBudget({ limits: { maxCalls: 3, maxOutputChars: 100, deadlineMs: 0 } })
    const decision = budget.begin(attemptA)
    expect(decision.ok).toBe(true)
    if (!decision.ok) return

    const settled = decision.call.settle({ outputChars: 12, costEstimateUsd: 0.1 })
    expect(settled.ok).toBe(true)
    expect(settled.usage).toEqual({ calls: 1, outputChars: 12, costEstimateUsd: 0.1 })

    // A duplicate settle returns the same result and never double-counts.
    const again = decision.call.settle({ outputChars: 12, costEstimateUsd: 0.1 })
    expect(again).toBe(settled)
    expect(budget.usage(attemptA).calls).toBe(1)
    expect(budget.usage(attemptA).outputChars).toBe(12)
  })

  test("rejects a nested consultation for the same attempt", () => {
    const budget = new AdvisorBudget({ limits })
    expect(budget.begin(attemptA).ok).toBe(true)
    const nested = budget.begin(attemptA)
    expect(nested.ok).toBe(false)
    if (!nested.ok) expect(nested.reason).toBe("recursive advisor consultation is not allowed")
  })

  test("enforces the deadline against the attempt's first call", () => {
    let clock = 1_000
    const budget = new AdvisorBudget({ limits: { maxCalls: 10, maxOutputChars: 1_000, deadlineMs: 100 }, now: () => clock })
    const first = budget.begin(attemptA)
    expect(first.ok).toBe(true)
    if (first.ok) first.call.settle({ outputChars: 1 })

    clock = 1_200
    const expired = budget.begin(attemptA)
    expect(expired.ok).toBe(false)
    if (!expired.ok) expect(expired.reason).toBe("advisor deadline exceeded (100 ms)")
  })

  test("reports the output limit at settlement", () => {
    const budget = new AdvisorBudget({ limits: { maxCalls: 10, maxOutputChars: 5, deadlineMs: 0 } })
    const decision = budget.begin(attemptA)
    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    const settled = decision.call.settle({ outputChars: 9 })
    expect(settled.ok).toBe(false)
    expect(settled.reason).toBe("advisor output limit exceeded (9/5 chars)")
  })

  test("concurrent attempts consult independently", () => {
    const budget = new AdvisorBudget({ limits: { maxCalls: 2, maxOutputChars: 100, deadlineMs: 0 } })
    const a = budget.begin(attemptA)
    const b = budget.begin(attemptB)
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (a.ok) a.call.settle({ outputChars: 10 })
    if (b.ok) b.call.settle({ outputChars: 20 })

    expect(budget.usage(attemptA)).toEqual({ calls: 1, outputChars: 10 })
    expect(budget.usage(attemptB)).toEqual({ calls: 1, outputChars: 20 })
    expect(budget.total().calls).toBe(2)
    // Each attempt has one call left under its own ceiling.
    expect(budget.begin(attemptA).ok).toBe(true)
    expect(budget.begin(attemptB).ok).toBe(true)
  })

  test("cancelling one consultation charges nothing and leaves the sibling untouched", () => {
    const budget = new AdvisorBudget({ limits })
    const a = budget.begin(attemptA)
    const b = budget.begin(attemptB)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return

    const cancelled = a.call.cancel()
    expect(cancelled.ok).toBe(false)
    expect(cancelled.reason).toBe("consultation cancelled")
    // A later settle of the cancelled call is a no-op.
    expect(a.call.settle({ outputChars: 5 })).toBe(cancelled)

    b.call.settle({ outputChars: 7 })
    expect(budget.usage(attemptA).calls).toBe(0)
    expect(budget.usage(attemptB)).toEqual({ calls: 1, outputChars: 7 })
  })
})
