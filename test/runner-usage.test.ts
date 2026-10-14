import { describe, expect, test } from "bun:test"

import { hasUsage, mergeUsage, usageDelta } from "../src/runners/usage"

describe("usage merging", () => {
  test("sums two usages field by field", () => {
    expect(mergeUsage({ input: 1, output: 2 }, { input: 3, reasoning: 4 })).toEqual({
      input: 4,
      output: 2,
      reasoning: 4,
    })
  })

  test("a field unknown on both sides stays unknown", () => {
    const merged = mergeUsage({ input: 1 }, { output: 2 })
    expect(merged).toEqual({ input: 1, output: 2 })
    expect(merged?.costEstimate).toBeUndefined()
    expect(merged?.cacheRead).toBeUndefined()
  })

  test("missing operands pass the other through", () => {
    expect(mergeUsage(undefined, { input: 5 })).toEqual({ input: 5 })
    expect(mergeUsage({ input: 5 }, undefined)).toEqual({ input: 5 })
    expect(mergeUsage(undefined, undefined)).toBeUndefined()
  })

  test("merging marks the result cumulative when either side is cumulative", () => {
    expect(mergeUsage({ input: 1, cumulative: true }, { input: 2 })?.cumulative).toBe(true)
    expect(mergeUsage({ input: 1 }, { input: 2 })?.cumulative).toBeUndefined()
  })

  test("a usage with no known measurement merges to undefined", () => {
    expect(mergeUsage({}, {})).toBeUndefined()
  })
})

describe("usage delta", () => {
  test("non-cumulative usage passes through unchanged", () => {
    const turn = { input: 3, output: 4 }
    expect(usageDelta({ input: 100, output: 100 }, turn)).toEqual(turn)
  })

  test("cumulative with a baseline subtracts and floors at zero", () => {
    const delta = usageDelta({ input: 100, output: 50 }, { input: 130, output: 40, cumulative: true })
    expect(delta).toEqual({ cumulative: false, input: 30, output: 0 })
  })

  test("cumulative without a baseline stays cumulative (unknown delta)", () => {
    const current = { input: 130, output: 90, cumulative: true }
    const delta = usageDelta(undefined, current)
    expect(delta).toEqual(current)
    expect(delta?.cumulative).toBe(true)
  })

  test("undefined current yields no delta", () => {
    expect(usageDelta({ input: 1 }, undefined)).toBeUndefined()
  })
})

describe("usage presence", () => {
  test("true only when at least one measurement is known", () => {
    expect(hasUsage({ input: 0 })).toBe(true)
    expect(hasUsage({ cumulative: true })).toBe(false)
    expect(hasUsage({})).toBe(false)
    expect(hasUsage(undefined)).toBe(false)
  })
})
