/**
 * Usage normalization (change `runner-parity-opencode-v2`, task 10.1).
 *
 * Different harnesses report tokens and cost with different semantics: some
 * report a delta for the turn, some report a cumulative conversation total.
 * Merging must not double-count, and a delta that cannot be derived from a
 * missing baseline stays unknown rather than becoming zero.
 */

import type { Usage } from "./contracts"

const numericFields = ["input", "output", "reasoning", "cacheRead", "cacheWrite", "costEstimate"] as const

/** Sums two usages field by field; a field unknown on both sides stays unknown. */
export function mergeUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b
  if (!b) return a
  const merged: Usage = {}
  for (const field of numericFields) {
    const left = a[field]
    const right = b[field]
    if (left === undefined && right === undefined) continue
    merged[field] = (left ?? 0) + (right ?? 0)
  }
  if (a.cumulative || b.cumulative) merged.cumulative = true
  return Object.keys(merged).length > 0 ? merged : undefined
}

/** True when a usage carries at least one known measurement. */
export function hasUsage(usage: Usage | undefined): boolean {
  return usage !== undefined && numericFields.some((field) => usage[field] !== undefined)
}

/**
 * Converts a possibly-cumulative usage into this turn's delta.
 *  - non-cumulative: returned unchanged,
 *  - cumulative with a baseline: each field is `current - previous` (floored at 0),
 *  - cumulative without a baseline: left cumulative (the delta is unknown).
 */
export function usageDelta(previous: Usage | undefined, current: Usage | undefined): Usage | undefined {
  if (!current) return undefined
  if (!current.cumulative) return current
  if (!previous) return current
  const delta: Usage = { cumulative: false }
  for (const field of numericFields) {
    const now = current[field]
    const before = previous[field]
    if (now === undefined || before === undefined) continue
    delta[field] = Math.max(0, now - before)
  }
  return Object.keys(delta).length > 1 ? delta : undefined
}
