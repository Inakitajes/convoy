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

import { isAbsolute, relative, resolve } from "node:path"

import type { ApprovalMode, ExecutionMode } from "./contracts"

/** Environment variable carrying an attempt's reviewed policy to out-of-process enforcement. */
export const runnerPolicyEnv = "CONVOY_RUNNER_POLICY"

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
  /**
   * Ordered shell-command rules with OpenCode's semantics: `*` globs, the last
   * matching rule wins. `deny` is a hard denial in every mode, verification
   * runs only `allow` commands, and `ask` follows the approval mode. Every
   * segment of a chained command must pass on its own.
   */
  commands?: Readonly<Record<string, CommandEffect>>
  /** Absolute roots a write may target; a write elsewhere is denied. */
  writeRoots?: readonly string[]
  /** Absolute roots no action may touch (secrets), whatever the mode. */
  denyRoots?: readonly string[]
}

export type CommandEffect = "allow" | "deny" | "ask"

export type PolicyState = {
  /** True once the mandatory advisor consultation has happened. */
  advisorSatisfied?: boolean
}

const readOnlyDenied: ReadonlySet<ActionIntent> = new Set(["write", "execute", "delegate", "network"])
const verifyDenied: ReadonlySet<ActionIntent> = new Set(["write", "delegate", "network"])
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

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*")
  return new RegExp(`^${escaped}$`)
}

/** The effect of the last rule matching one simple command, as OpenCode evaluates it. */
export function commandEffect(command: string, rules: Readonly<Record<string, CommandEffect>>): CommandEffect | undefined {
  let effect: CommandEffect | undefined
  for (const [pattern, value] of Object.entries(rules)) {
    if (globToRegExp(pattern).test(command)) effect = value
  }
  return effect
}

// Redirections that cannot write a file: fd duplication and the null device.
const harmlessRedirect = /\d*>&\d+|\d*>>?\s*\/dev\/null/g

/**
 * Splits a shell command into its simple commands. Returns undefined when the
 * command writes through a redirection or substitutes a command, which no
 * prefix rule can vouch for.
 */
export function commandSegments(command: string): string[] | undefined {
  const cleaned = command.replace(harmlessRedirect, " ")
  if (/[<>`]|\$\(/.test(cleaned)) return undefined
  return cleaned
    .split(/&&|\|\||[;|&\n]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
}

const effectRank: Record<CommandEffect, number> = { allow: 0, ask: 1, deny: 2 }

/** The combined effect of a possibly chained command: its strictest segment, unknown segments ask. */
function chainedCommandEffect(command: string, rules: Readonly<Record<string, CommandEffect>>): CommandEffect {
  // A hard denial anywhere in the raw text wins before any parsing doubt.
  if (commandEffect(command.trim(), rules) === "deny") return "deny"
  const segments = commandSegments(command)
  if (!segments || segments.length === 0) return "ask"
  let worst: CommandEffect = "allow"
  for (const segment of segments) {
    const effect = commandEffect(segment, rules) ?? "ask"
    if (effectRank[effect] > effectRank[worst]) worst = effect
  }
  return worst
}

function within(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function touchesDeniedRoot(request: ActionRequest, roots: readonly string[]): boolean {
  const resource = request.resource!
  // A command names the protected path in its text; a file tool targets it directly.
  if (request.intent === "execute") return roots.some((root) => resource.includes(root))
  return isAbsolute(resource) && roots.some((root) => within(resource, root))
}

/** Decides one normalized action. Pure; no harness state is consulted. */
export function evaluateAction(request: ActionRequest, config: PolicyConfig, state: PolicyState = {}): PolicyDecision {
  for (const rule of config.hardDeny ?? []) {
    if (matchesRule(request, rule)) {
      return { effect: "deny", reason: `hard-denied ${request.tool}` }
    }
  }

  if (request.resource !== undefined && touchesDeniedRoot(request, config.denyRoots ?? [])) {
    return { effect: "deny", reason: `${request.tool} may not touch a protected path` }
  }

  const command = request.intent === "execute" && config.commands && request.resource !== undefined
    ? chainedCommandEffect(request.resource, config.commands)
    : undefined
  if (command === "deny") return { effect: "deny", reason: `hard-denied command for ${request.tool}` }

  // An unclassifiable action never gains access by default, in any mode.
  if (request.intent === "other") {
    return { effect: "deny", reason: `unclassifiable action ${request.tool}` }
  }

  if (config.mode === "read-only" && readOnlyDenied.has(request.intent)) {
    return { effect: "deny", reason: `read-only step may not ${request.intent}` }
  }

  if (config.mode === "verify") {
    if (verifyDenied.has(request.intent)) {
      return { effect: "deny", reason: `verification step may not ${request.intent}` }
    }
    if (request.intent === "execute" && command !== "allow" && !isVerifyAllowed(request, config.verifyAllow ?? [])) {
      return { effect: "deny", reason: "command is not an approved verification command" }
    }
  }

  if (request.intent === "write" && config.requireAdvisorBeforeWrite && !state.advisorSatisfied) {
    return { effect: "deny", reason: "blocked until the advisor consultation is satisfied" }
  }

  if (request.intent === "read") return { effect: "allow", reason: "read allowed" }

  if (request.intent === "write" && config.writeRoots) {
    const target = request.resource
    if (target !== undefined && isAbsolute(target) && config.writeRoots.some((root) => within(target, root))) {
      return { effect: "allow", reason: "write inside the step's checkout" }
    }
    return { effect: "deny", reason: "write outside the step's checkout and run directory" }
  }

  if (command === "allow") return { effect: "allow", reason: "allowlisted command" }
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
