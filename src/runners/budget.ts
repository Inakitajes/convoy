/**
 * Budget and loop policy (change `runner-parity-opencode-v2`, task 10.2).
 *
 * Core owns turn, elapsed-time, and cost-estimate limits so both runners stop
 * under the same bounded policy. The verdict distinguishes a hard stop from a
 * soft steer (within 10% of a known limit) and never lets a missing measurement
 * masquerade as being under budget: a configured limit whose measurement the
 * harness does not expose is a stop, not a silent pass.
 *
 * In-flight requests can overshoot an estimated cost threshold, and a
 * subscription estimate is not an invoice or a remaining-quota balance; callers
 * should present the result as bounded headroom, not an exact cap.
 */

export type BudgetLimits = {
  maxTurns?: number
  maxElapsedMs?: number
  maxCostEstimateUsd?: number
}

export type BudgetState = {
  turns: number
  elapsedMs: number
  /** Omitted when the harness reports no cost estimate. */
  costEstimateUsd?: number
}

export type BudgetVerdict = {
  action: "continue" | "soft" | "stop"
  reason: string
}

/** Fraction of a limit at which the loop is steered rather than stopped. */
const softThreshold = 0.9

type LimitCheck = { name: string; limit: number; value: number | undefined }

function knownLimits(state: BudgetState, limits: BudgetLimits): LimitCheck[] {
  const checks: LimitCheck[] = []
  if (limits.maxTurns !== undefined) checks.push({ name: "turn", limit: limits.maxTurns, value: state.turns })
  if (limits.maxElapsedMs !== undefined) checks.push({ name: "elapsed-time", limit: limits.maxElapsedMs, value: state.elapsedMs })
  if (limits.maxCostEstimateUsd !== undefined) {
    checks.push({ name: "cost-estimate", limit: limits.maxCostEstimateUsd, value: state.costEstimateUsd })
  }
  return checks
}

/**
 * Evaluates one budget observation against configured limits. Hard stops name
 * the limit that was reached; a limit whose required measurement is unavailable
 * stops as unenforceable; otherwise a limit within 10% yields a soft steer.
 */
export function evaluateBudget(state: BudgetState, limits: BudgetLimits): BudgetVerdict {
  const checks = knownLimits(state, limits)

  for (const check of checks) {
    if (check.value !== undefined && check.value >= check.limit) {
      return { action: "stop", reason: `${check.name} limit reached (${check.value} of ${check.limit})` }
    }
  }

  for (const check of checks) {
    if (check.value === undefined) {
      return { action: "stop", reason: `${check.name} limit cannot be enforced: the required measurement is unavailable` }
    }
  }

  for (const check of checks) {
    if (check.value !== undefined && check.value >= check.limit * softThreshold) {
      return { action: "soft", reason: `approaching ${check.name} limit (${check.value} of ${check.limit})` }
    }
  }

  return { action: "continue", reason: "within budget" }
}

/**
 * Reports why a requested budget guarantee cannot be enforced by the selected
 * runner. An empty result means every configured limit is measurable.
 *
 * Turn and elapsed-time limits are always observable. A cost-estimate limit
 * needs the runner to actually report a cost; `available.cost` must be
 * explicitly true, since an unknown capability is not a guarantee. `tokens` is
 * accepted for callers that already track token availability; token budgets are
 * not part of `BudgetLimits` yet and therefore produce no reason today.
 */
export function assertEnforceable(
  limits: BudgetLimits,
  available: { cost?: boolean; tokens?: boolean },
): string[] {
  const reasons: string[] = []
  if (limits.maxCostEstimateUsd !== undefined && available.cost !== true) {
    reasons.push("cost-estimate limit cannot be enforced: the runner does not report a usable cost estimate")
  }
  return reasons
}
