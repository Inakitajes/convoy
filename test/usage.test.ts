import { describe, expect, test } from "bun:test"

import type { ProgressTokens } from "../src/progress"
import { PhaseUsage, addTokens, cloneTokens, emptyTokens, safeCost, sumRunUsage, tokensFromValue } from "../src/usage"

function tk(input: number, output: number): ProgressTokens {
  return { input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: input + output }
}

describe("token helpers", () => {
  test("empty / clone / add", () => {
    expect(emptyTokens()).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 })

    const a = tk(10, 5)
    const clone = cloneTokens(a)
    expect(clone).toEqual(a)
    expect(clone).not.toBe(a)

    expect(addTokens(tk(10, 5), tk(1, 2))).toEqual({ input: 11, output: 7, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 18 })
  })

  test("safeCost drops non-finite values to zero", () => {
    expect(safeCost(0.42)).toBe(0.42)
    expect(safeCost(undefined)).toBe(0)
    expect(safeCost(Number.NaN)).toBe(0)
    expect(safeCost(Number.POSITIVE_INFINITY)).toBe(0)
  })

  test("tokensFromValue normalizes opencode's nested cache shape", () => {
    expect(tokensFromValue({ input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } })).toEqual({
      input: 10,
      output: 5,
      reasoning: 2,
      cacheRead: 3,
      cacheWrite: 1,
      // total derived from input + output + reasoning when absent
      total: 17,
    })
    // an explicit total wins over the derived sum
    expect(tokensFromValue({ input: 10, output: 5, total: 99 })?.total).toBe(99)
    expect(tokensFromValue(null)).toBeUndefined()
    expect(tokensFromValue("nope")).toBeUndefined()
  })
})

describe("PhaseUsage", () => {
  test("accumulates step deltas and dedups by stepID", () => {
    const usage = new PhaseUsage()
    expect(usage.isEmpty).toBe(true)

    expect(usage.addStep({ stepID: "s1", sessionID: "ses_1", cost: 0.01, tokens: tk(100, 10), model: "openai/gpt" })).toBe(true)
    expect(usage.addStep({ stepID: "s2", sessionID: "ses_1", cost: 0.02, tokens: tk(50, 5) })).toBe(true)
    // a replay of s1 is ignored, not re-counted
    expect(usage.addStep({ stepID: "s1", sessionID: "ses_1", cost: 99, tokens: tk(999, 999) })).toBe(false)

    const totals = usage.totals()
    expect(totals.cost).toBeCloseTo(0.03)
    expect(totals.tokens.input).toBe(150)
    expect(totals.tokens.output).toBe(15)
    expect(totals.steps).toBe(2)
    expect(totals.reported).toBe(true)
    expect(totals.model).toBe("openai/gpt")
    expect(usage.isEmpty).toBe(false)
  })

  test("an authoritative total wins over step deltas, before and after", () => {
    const usage = new PhaseUsage()
    usage.addStep({ stepID: "s1", sessionID: "ses_1", cost: 0.01, tokens: tk(100, 10) })
    usage.setTotal({ sessionID: "ses_1", cost: 0.05, tokens: tk(500, 50), model: "anthropic/claude" })
    // a delta after the total must not double-count its cost/tokens
    usage.addStep({ stepID: "s2", sessionID: "ses_1", cost: 99, tokens: tk(999, 999) })

    const totals = usage.totals()
    expect(totals.cost).toBeCloseTo(0.05)
    expect(totals.tokens.input).toBe(500)
    expect(totals.model).toBe("anthropic/claude")
    // the suppressed step still counts toward the visible step counter
    expect(totals.steps).toBe(2)
  })

  test("aggregates across sessions and reports the last model seen", () => {
    const usage = new PhaseUsage()
    usage.addStep({ stepID: "a", sessionID: "ses_1", cost: 1, tokens: tk(10, 0), model: "m1" })
    usage.addStep({ stepID: "b", sessionID: "ses_2", cost: 2, tokens: tk(20, 0), model: "m2" })

    const totals = usage.totals()
    expect(totals.cost).toBe(3)
    expect(totals.tokens.input).toBe(30)
    expect(totals.model).toBe("m2")
  })

  test("usage without a sessionID resolves to the fallback bucket", () => {
    const usage = new PhaseUsage()
    usage.fallbackSessionID = "ses_main"
    usage.setTotal({ sessionID: "ses_main", cost: 5, tokens: tk(50, 0) })
    // a later delta with no sessionID lands in ses_main, which is already
    // total-reported, so its cost is suppressed rather than added on top
    usage.addStep({ stepID: "x", cost: 99, tokens: tk(999, 0) })
    expect(usage.totals().cost).toBe(5)
  })
})

describe("sumRunUsage", () => {
  test("sums executor and advisor usage, tokens, and recorded durations", () => {
    expect(sumRunUsage([
      { cost: 0.5, tokens: tk(1_000, 200), durationMs: 60_000, advisor: { cost: 0.2 } },
      { cost: 0.25, tokens: tk(400, 100), durationMs: 30_000 },
      { durationMs: 500 },
    ])).toEqual({
      cost: 0.95,
      advisorCost: 0.2,
      tokens: { input: 1_400, output: 300, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_700 },
      durationMs: 90_500,
    })
  })

  test("keeps independently recorded usage groups and ignores invalid numbers", () => {
    // Advisor-only spend is still spend: the total counts it, tokens stay absent.
    expect(sumRunUsage([{ advisor: { cost: 0.2 } }])).toEqual({ cost: 0.2, advisorCost: 0.2 })
    expect(sumRunUsage([{ durationMs: 10 }, { advisor: { cost: 0 } }])).toEqual({ cost: 0, durationMs: 10 })
    expect(sumRunUsage([{ cost: Number.NaN, tokens: tk(1, 1), durationMs: Number.POSITIVE_INFINITY, advisor: { cost: Number.NaN } }])).toBeUndefined()
    expect(sumRunUsage([])).toBeUndefined()
  })
})
