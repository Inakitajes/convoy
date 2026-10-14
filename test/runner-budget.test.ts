import { describe, expect, test } from "bun:test"

import { assertEnforceable, evaluateBudget, type BudgetLimits, type BudgetState } from "../src/runners/budget"

const state: BudgetState = { turns: 4, elapsedMs: 40_000, costEstimateUsd: 0.4 }

describe("budget evaluation", () => {
  test("continues when every known limit has headroom", () => {
    const limits: BudgetLimits = { maxTurns: 10, maxElapsedMs: 100_000, maxCostEstimateUsd: 1 }
    expect(evaluateBudget(state, limits)).toEqual({ action: "continue", reason: "within budget" })
  })

  test("continues when no limits are configured", () => {
    expect(evaluateBudget({ turns: 999, elapsedMs: 9_000_000 }, {})).toEqual({ action: "continue", reason: "within budget" })
  })

  test("hard stops when a turn limit is reached or exceeded and names the limit", () => {
    const reached = evaluateBudget(state, { maxTurns: 4 })
    expect(reached.action).toBe("stop")
    expect(reached.reason).toContain("turn")

    const exceeded = evaluateBudget(state, { maxTurns: 3 })
    expect(exceeded.action).toBe("stop")
    expect(exceeded.reason).toContain("turn")
  })

  test("hard stops when an elapsed-time limit is reached", () => {
    const verdict = evaluateBudget(state, { maxElapsedMs: 40_000 })
    expect(verdict.action).toBe("stop")
    expect(verdict.reason).toContain("elapsed-time")
  })

  test("hard stops when a cost-estimate limit is reached", () => {
    const verdict = evaluateBudget(state, { maxCostEstimateUsd: 0.4 })
    expect(verdict.action).toBe("stop")
    expect(verdict.reason).toContain("cost-estimate")
  })

  test("soft-steers within 10% of a known limit", () => {
    const turns = evaluateBudget({ turns: 9, elapsedMs: 0 }, { maxTurns: 10 })
    expect(turns.action).toBe("soft")
    expect(turns.reason).toContain("turn")

    const elapsed = evaluateBudget({ turns: 0, elapsedMs: 90_000 }, { maxElapsedMs: 100_000 })
    expect(elapsed.action).toBe("soft")
    expect(elapsed.reason).toContain("elapsed-time")

    const cost = evaluateBudget(
      { turns: 0, elapsedMs: 0, costEstimateUsd: 0.9 },
      { maxCostEstimateUsd: 1 },
    )
    expect(cost.action).toBe("soft")
    expect(cost.reason).toContain("cost-estimate")
  })

  test("hard stop wins over a soft steer", () => {
    const verdict = evaluateBudget({ turns: 10, elapsedMs: 0 }, { maxTurns: 10 })
    expect(verdict.action).toBe("stop")
  })

  test("a set limit with an unavailable measurement stops instead of passing", () => {
    const verdict = evaluateBudget({ turns: 1, elapsedMs: 0 }, { maxCostEstimateUsd: 5 })
    expect(verdict.action).toBe("stop")
    expect(verdict.reason).toContain("unavailable")
  })

  test("a reached known limit is reported before an unavailable one", () => {
    const verdict = evaluateBudget({ turns: 10, elapsedMs: 0 }, { maxTurns: 10, maxCostEstimateUsd: 5 })
    expect(verdict.action).toBe("stop")
    expect(verdict.reason).toContain("turn")
  })
})

describe("budget enforceability", () => {
  test("no reasons when no guarantee is requested", () => {
    expect(assertEnforceable({ maxTurns: 5, maxElapsedMs: 1000 }, {})).toEqual([])
  })

  test("cost-estimate limit is enforceable only when the runner reports cost", () => {
    const limits: BudgetLimits = { maxCostEstimateUsd: 2 }
    expect(assertEnforceable(limits, { cost: true })).toEqual([])

    const unknown = assertEnforceable(limits, {})
    expect(unknown).toHaveLength(1)
    expect(unknown[0]).toContain("cost-estimate")

    const disabled = assertEnforceable(limits, { cost: false })
    expect(disabled).toHaveLength(1)
  })

  test("turn and time guarantees are always enforceable", () => {
    expect(assertEnforceable({ maxTurns: 1, maxElapsedMs: 1 }, { cost: false })).toEqual([])
  })
})
