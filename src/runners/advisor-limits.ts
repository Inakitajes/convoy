/**
 * Advisor call, output, time, and recursion limits (change
 * `runner-parity-opencode-v2`, task 7.6, design D8/D9).
 *
 * Consultation usage is attributed to the requesting attempt, separately from
 * the executor's own usage, and counted exactly once. `applyLimits` is the pure
 * accounting rule; `AdvisorBudget` tracks per-attempt budgets, refuses a
 * consultation that starts inside another (recursion), enforces the deadline,
 * and lets a concurrent sibling attempt consult independently.
 *
 * Limits with a non-positive value are treated as "no bound" so a caller can
 * disable one dimension without inventing a sentinel.
 */

export type AdvisorLimits = {
  maxCalls: number
  maxOutputChars: number
  deadlineMs: number
}

export type AdvisorUsage = {
  calls: number
  outputChars: number
  costEstimateUsd?: number
}

/** Convoy-owned attempt identity. */
export type AdvisorAttempt = {
  runId: string
  phase: string
  attempt: number
}

export type AdvisorLimitResult = {
  ok: boolean
  /** The resulting usage, returned even when a limit was exceeded (the spend happened). */
  usage: AdvisorUsage
  reason?: string
}

/** What one consultation contributed. It is always exactly one call. */
export type AdvisorAddition = {
  outputChars: number
  costEstimateUsd?: number
}

function limitReason(usage: AdvisorUsage, limits: AdvisorLimits): string | undefined {
  if (limits.maxCalls > 0 && usage.calls > limits.maxCalls) {
    return `advisor call limit exceeded (${usage.calls}/${limits.maxCalls})`
  }
  if (limits.maxOutputChars > 0 && usage.outputChars > limits.maxOutputChars) {
    return `advisor output limit exceeded (${usage.outputChars}/${limits.maxOutputChars} chars)`
  }
  return undefined
}

/**
 * Folds one consultation into `current`: calls increase by one and output
 * characters are added. `costEstimateUsd` stays absent unless some value is
 * known, so an unknown estimate is never fabricated as zero.
 *
 * A deadline is time-based and therefore enforced by `AdvisorBudget`, not here.
 */
export function applyLimits(current: AdvisorUsage, add: AdvisorAddition, limits: AdvisorLimits): AdvisorLimitResult {
  const outputChars = Math.max(0, add.outputChars)
  const usage: AdvisorUsage = {
    calls: current.calls + 1,
    outputChars: current.outputChars + outputChars,
  }
  const knownCost = current.costEstimateUsd !== undefined || add.costEstimateUsd !== undefined
  usage.costEstimateUsd = (current.costEstimateUsd ?? 0) + (add.costEstimateUsd ?? 0)
  if (!knownCost) delete usage.costEstimateUsd

  const reason = limitReason(usage, limits)
  return reason ? { ok: false, usage, reason } : { ok: true, usage }
}

// ---------------------------------------------------------------------------
// Per-attempt budget with recursion prevention
// ---------------------------------------------------------------------------

export type AdvisorBudgetOptions = {
  limits: AdvisorLimits
  now?: () => number
}

export type AdvisorBudgetDecision = { ok: true; call: AdvisorCall } | { ok: false; reason: string }

export type AdvisorBudgetSettlement = {
  ok: boolean
  usage: AdvisorUsage
  reason?: string
}

export type AdvisorCall = {
  readonly attempt: AdvisorAttempt
  /** Completes the call once; a second call is a no-op and never double-counts. */
  settle(add: AdvisorAddition): AdvisorBudgetSettlement
  /** Releases a call that was cancelled before it produced output. */
  cancel(): AdvisorBudgetSettlement
}

function attemptKey(attempt: AdvisorAttempt): string {
  return `${attempt.runId}\u0000${attempt.phase}\u0000${attempt.attempt}`
}

function emptyUsage(): AdvisorUsage {
  return { calls: 0, outputChars: 0 }
}

/**
 * Tracks calls/output per attempt and serializes each attempt's consultations:
 * a consultation already in flight for an attempt makes a nested `begin` fail
 * with a recursion reason, while a different attempt may consult concurrently.
 */
export class AdvisorBudget {
  private readonly limits: AdvisorLimits
  private readonly now: () => number
  private readonly usageByKey = new Map<string, AdvisorUsage>()
  private readonly startedAt = new Map<string, number>()
  private readonly inflight = new Map<string, { settlement?: AdvisorBudgetSettlement }>()

  constructor(options: AdvisorBudgetOptions) {
    this.limits = options.limits
    this.now = options.now ?? Date.now
  }

  /** Admits a consultation or explains why it must not start. */
  begin(attempt: AdvisorAttempt): AdvisorBudgetDecision {
    const key = attemptKey(attempt)
    if (this.inflight.has(key)) {
      return { ok: false, reason: "recursive advisor consultation is not allowed" }
    }

    const usage = this.usage(attempt)
    if (this.limits.maxCalls > 0 && usage.calls >= this.limits.maxCalls) {
      return { ok: false, reason: `advisor call limit reached (${usage.calls}/${this.limits.maxCalls})` }
    }

    const started = this.startedAt.get(key) ?? this.now()
    this.startedAt.set(key, started)
    if (this.limits.deadlineMs > 0 && this.now() - started > this.limits.deadlineMs) {
      return { ok: false, reason: `advisor deadline exceeded (${this.limits.deadlineMs} ms)` }
    }

    const state: { settlement?: AdvisorBudgetSettlement } = {}
    this.inflight.set(key, state)
    const call: AdvisorCall = {
      attempt,
      settle: (add) => this.settle(key, state, add),
      cancel: () => this.cancel(key, state),
    }
    return { ok: true, call }
  }

  /** Usage attributed to one attempt so far. */
  usage(attempt: AdvisorAttempt): AdvisorUsage {
    return this.usageByKey.get(attemptKey(attempt)) ?? emptyUsage()
  }

  /** Usage across every attempt in this budget. */
  total(): AdvisorUsage {
    const total = emptyUsage()
    for (const usage of this.usageByKey.values()) {
      total.calls += usage.calls
      total.outputChars += usage.outputChars
      if (usage.costEstimateUsd !== undefined) {
        total.costEstimateUsd = (total.costEstimateUsd ?? 0) + usage.costEstimateUsd
      }
    }
    return total
  }

  private settle(key: string, state: { settlement?: AdvisorBudgetSettlement }, add: AdvisorAddition): AdvisorBudgetSettlement {
    // Attributed once: a duplicate settle returns the recorded result unchanged.
    if (state.settlement) return state.settlement
    this.inflight.delete(key)
    const applied = applyLimits(this.usageByKey.get(key) ?? emptyUsage(), add, this.limits)
    this.usageByKey.set(key, applied.usage)
    state.settlement = { ok: applied.ok, usage: applied.usage, ...(applied.reason ? { reason: applied.reason } : {}) }
    return state.settlement
  }

  private cancel(key: string, state: { settlement?: AdvisorBudgetSettlement }): AdvisorBudgetSettlement {
    if (state.settlement) return state.settlement
    this.inflight.delete(key)
    // A cancelled consultation produced no measurable output: it is not charged
    // as a call, and the originating attempt's existing usage is untouched.
    const settlement: AdvisorBudgetSettlement = {
      ok: false,
      usage: this.usageByKey.get(key) ?? emptyUsage(),
      reason: "consultation cancelled",
    }
    state.settlement = settlement
    return settlement
  }
}
