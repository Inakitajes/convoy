/**
 * Runner-neutral action policy evaluation (change `runner-parity-opencode-v2`,
 * task 6.1).
 *
 * Core decides whether a normalized action is read, write, execute, delegate, or
 * read-only-forbidden; adapters map their native tools to that intent. This keeps
 * one policy for both runners instead of two harness-specific permission systems,
 * while preserving hard denials, read-only/verification restrictions, the
 * mandatory advisor checkpoint, and the interactive/auto/smart approval modes.
 *
 * Enforcement (intercepting the request in the harness) is a separate, adapter
 * concern; this module only decides.
 */

import type { ApprovalMode, ExecutionMode } from "./contracts"

export type ActionIntent = "read" | "write" | "execute" | "delegate" | "network" | "other"

export type ActionRequest = {
  /** Native tool name, retained for diagnostics only. */
  tool: string
  intent: ActionIntent
  /** The resource the action targets (a path or a command), when known. */
  resource?: string
}

export type PolicyDecision = {
  effect: "allow" | "deny" | "ask"
  reason: string
}

export type HardDenyRule = { intent?: ActionIntent; resource?: string }

export type PolicyConfig = {
  mode: ExecutionMode
  approvals: ApprovalMode
  /** Actions never allowed in any mode (hard denials). */
  hardDeny?: readonly HardDenyRule[]
  /** Resource patterns an execution may run under read-only/verify (e.g. tests). */
  verifyAllow?: readonly string[]
  /** Block writes until the advisor checkpoint is satisfied (D8). */
  requireAdvisorBeforeWrite?: boolean
}

export type PolicyState = {
  /** True once the mandatory advisor consultation has happened. */
  advisorSatisfied?: boolean
}

const mutating: ReadonlySet<ActionIntent> = new Set(["write", "execute", "delegate"])
const askWorthy: ReadonlySet<ActionIntent> = new Set(["write", "execute", "delegate", "network"])

function matchesRule(request: ActionRequest, rule: HardDenyRule): boolean {
  if (rule.intent !== undefined && rule.intent !== request.intent) return false
  if (rule.resource !== undefined) {
    if (request.resource === undefined) return false
    if (!request.resource.includes(rule.resource)) return false
  }
  return true
}

function isVerifyAllowed(request: ActionRequest, patterns: readonly string[]): boolean {
  if (request.resource === undefined) return false
  return patterns.some((pattern) => request.resource!.includes(pattern))
}

/** Decides one normalized action. Pure; no harness state is consulted. */
export function evaluateAction(request: ActionRequest, config: PolicyConfig, state: PolicyState = {}): PolicyDecision {
  for (const rule of config.hardDeny ?? []) {
    if (matchesRule(request, rule)) {
      return { effect: "deny", reason: `hard-denied ${request.tool}` }
    }
  }

  if (config.mode === "read-only" && mutating.has(request.intent)) {
    return { effect: "deny", reason: `read-only step may not ${request.intent}` }
  }

  if (config.mode === "verify") {
    if (request.intent === "write" || request.intent === "delegate") {
      return { effect: "deny", reason: `verification step may not ${request.intent}` }
    }
    if (request.intent === "execute" && !isVerifyAllowed(request, config.verifyAllow ?? [])) {
      return { effect: "deny", reason: "command is not an approved verification command" }
    }
  }

  if (request.intent === "write" && config.requireAdvisorBeforeWrite && !state.advisorSatisfied) {
    return { effect: "deny", reason: "blocked until the advisor consultation is satisfied" }
  }

  if (request.intent === "read") return { effect: "allow", reason: "read allowed" }
  if (!askWorthy.has(request.intent)) return { effect: "allow", reason: `${request.intent} allowed` }

  switch (config.approvals) {
    case "auto":
      return { effect: "allow", reason: "auto-approved" }
    case "smart":
      return { effect: "ask", reason: "judge decides" }
    case "interactive":
    default:
      return { effect: "ask", reason: "operator decides" }
  }
}
