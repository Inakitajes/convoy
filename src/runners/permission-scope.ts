/**
 * Permission request scoping and settlement (change `runner-parity-opencode-v2`,
 * design D7, task 6.3).
 *
 * A permission request is identified by its *full* execution identity — run,
 * phase, attempt, session, request, and generation — never by a native request
 * id alone. A reply therefore settles exactly the action it was raised for:
 * a foreign, stale, duplicate, unknown, cancelled, or timed-out reply resolves
 * to `false` and can never authorize another attempt, while sibling requests
 * stay independently responsive.
 *
 * This module only correlates decisions. Policy evaluation lives in `policy.ts`,
 * and interception/transport lives in the adapters (Claude hook + MCP host,
 * OpenCode permission events).
 */

export type PermissionScope = {
  runId: string
  phaseName: string
  attempt: number
  sessionId?: string
  /** Native request id, retained for diagnostics; never authority on its own. */
  requestId: string
  /** Incremented on retry so a reply for an earlier generation is stale. */
  generation: number
}

export type PermissionDecision = {
  scope: PermissionScope
  decision: "allow" | "deny" | "expired"
}

/**
 * Full-identity key. Every scope field participates, so a reply for one scope
 * can never address a different one. `sessionId` is normalized so `undefined`
 * and an empty string are not conflated with a real session.
 */
function scopeKey(scope: PermissionScope): string {
  return JSON.stringify([scope.runId, scope.phaseName, scope.attempt, scope.sessionId ?? null, scope.requestId, scope.generation])
}

export class PermissionLedger {
  private readonly byScope = new Map<string, PermissionScope>()
  /** Native request id -> full-identity key, so ids stay unique while pending. */
  private readonly requestIds = new Map<string, string>()
  private readonly settled: PermissionDecision[] = []

  /** Registers a pending request. Throws if its request id is already pending. */
  request(scope: PermissionScope): void {
    if (this.requestIds.has(scope.requestId)) {
      throw new Error(`permission request already pending: ${scope.requestId}`)
    }
    const key = scopeKey(scope)
    if (this.byScope.has(key)) {
      throw new Error(`permission scope already pending: ${scope.requestId}`)
    }
    // Store a snapshot: a caller mutating its scope object must not change identity.
    const stored = { ...scope }
    this.byScope.set(key, stored)
    this.requestIds.set(scope.requestId, key)
  }

  /** The pending scopes, as snapshots, in registration order. */
  pending(): PermissionScope[] {
    return [...this.byScope.values()].map((scope) => ({ ...scope }))
  }

  /** True only for the exact scope that is pending. */
  isPending(scope: PermissionScope): boolean {
    return this.byScope.has(scopeKey(scope))
  }

  /**
   * Settles one pending request. Returns `false` for a foreign, stale,
   * duplicate, unknown, or cancelled request, and never authorizes another
   * attempt.
   */
  settle(scope: PermissionScope, decision: "allow" | "deny"): boolean {
    const key = scopeKey(scope)
    const stored = this.byScope.get(key)
    if (!stored) return false
    this.remove(key)
    this.settled.push({ scope: stored, decision })
    return true
  }

  /**
   * Settles a deadline truthfully as `expired`. A later reply is then stale and
   * cannot silently permit work. Returns `undefined` if nothing matched.
   */
  expire(scope: PermissionScope): PermissionDecision | undefined {
    const key = scopeKey(scope)
    const stored = this.byScope.get(key)
    if (!stored) return undefined
    this.remove(key)
    const decision: PermissionDecision = { scope: stored, decision: "expired" }
    this.settled.push(decision)
    return decision
  }

  /** Cancels the exact pending scope (e.g. its attempt stopped). A no-op if it is not pending. */
  cancel(scope: PermissionScope): void {
    this.remove(scopeKey(scope))
  }

  /** The decisions recorded so far, in settlement order. */
  decisions(): readonly PermissionDecision[] {
    return this.settled.map((entry) => ({ scope: { ...entry.scope }, decision: entry.decision }))
  }

  private remove(key: string): void {
    const stored = this.byScope.get(key)
    if (!stored) return
    this.byScope.delete(key)
    this.requestIds.delete(stored.requestId)
  }
}
