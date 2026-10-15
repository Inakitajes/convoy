/**
 * OpenCode approval service (change `unify-runner-system`, task 2.5).
 *
 * Routes an OpenCode permission ask through the same neutral policy and the
 * same cancellable request scope the engine uses, so a hard denial or the
 * advisor checkpoint cannot be bypassed. Hard policy is decided first; an
 * eligible ask-level request is settled by the injected interactive/auto/smart
 * decider, and a request with no decider fails closed. Every decision is bound
 * to the attempt's full identity, so a cancelled or foreign request can never
 * settle a sibling attempt's ask.
 */

import { PermissionLedger, type PermissionScope } from "../permission-scope"
import { decideOpencodePermission } from "./permission"
import type { PolicyConfig, PolicyState } from "../policy"
import type { ApprovalOutcome, ApprovalRequest } from "../contracts"

export type OpencodeApprovalOptions = {
  policy: PolicyConfig
  /** The exact attempt a decision is scoped to. */
  identity: { runId: string; phaseName: string; attempt: number }
  sessionId?: string
  /** Bumped on retry so a late reply for an earlier generation is stale. */
  generation?: number
  /** Current policy state (e.g. the advisor checkpoint), read per request. */
  state?: () => PolicyState | undefined
  /**
   * Ask-level decider for an eligible request (interactive prompt, auto-accept,
   * or the smart judge). When absent, an ask-level request is denied.
   */
  ask?: (request: ApprovalRequest) => Promise<ApprovalOutcome>
  /** Correlates pending requests across a run; defaults to a fresh ledger. */
  ledger?: PermissionLedger
}

export type OpencodeApprovalService = {
  decide(request: ApprovalRequest): Promise<ApprovalOutcome>
  cancel(requestId: string): void
  isPending(requestId: string): boolean
}

export function createOpencodeApprovalService(options: OpencodeApprovalOptions): OpencodeApprovalService {
  const ledger = options.ledger ?? new PermissionLedger()
  const scopes = new Map<string, PermissionScope>()
  const generation = options.generation ?? 1

  const scopeFor = (requestId: string): PermissionScope => ({
    ...options.identity,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    requestId,
    generation,
  })

  return {
    async decide(request: ApprovalRequest): Promise<ApprovalOutcome> {
      const scope = scopeFor(request.requestId)
      scopes.set(request.requestId, scope)
      try {
        ledger.request(scope)
      } catch {
        // A duplicate request id is already pending; decision still settles it.
      }
      const settle = (outcome: "allow" | "deny"): ApprovalOutcome => {
        ledger.settle(scope, outcome)
        scopes.delete(request.requestId)
        return outcome
      }

      // `tool` carries the native OpenCode action; the policy maps it to an intent.
      const decision = decideOpencodePermission(request.tool, request.resources, options.policy, options.state?.() ?? {})
      if (decision.effect === "deny") return settle("deny")
      if (decision.effect === "allow") return settle("allow")
      // ask-level: delegate to the selected decider, else fail closed.
      if (!options.ask) return settle("deny")
      return settle((await options.ask(request)) === "allow" ? "allow" : "deny")
    },
    cancel(requestId: string): void {
      const scope = scopes.get(requestId)
      if (!scope) return
      ledger.cancel(scope)
      scopes.delete(requestId)
    },
    isPending(requestId: string): boolean {
      const scope = scopes.get(requestId)
      return scope ? ledger.isPending(scope) : false
    },
  }
}
