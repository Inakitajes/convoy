/**
 * Claude ask-level permission arbitration (change `runner-parity-opencode-v2`,
 * tasks 6.2/6.5).
 *
 * The `PreToolUse` hook handles mandatory checks. Actions the policy marks
 * `ask` are delivered to the operator through an authenticated MCP permission
 * host (`--permission-prompt-tool`). This module is the transport-agnostic
 * arbiter: it evaluates Convoy's policy, forwards an `ask` to an operator
 * approval provider, and fails **closed** — a missing provider, a rejection, or
 * a timeout denies, so nothing is silently allowed.
 */

import { decideToolCall, type PreToolUseInput } from "./hook"

import type { PolicyConfig, PolicyDecision, PolicyState } from "../policy"

import type { ApprovalProvider, PermissionAsk } from "../attempt-bridge"

export type { ApprovalProvider, PermissionAsk }

export type ResolvePermissionInput = {
  call: PreToolUseInput
  config: PolicyConfig
  state?: PolicyState
  /** Absent when no operator can answer; an `ask` then denies. */
  requestApproval?: ApprovalProvider
  /** Upper bound on waiting for the operator (default 5 minutes). */
  timeoutMs?: number
  /** Injectable clock for tests. */
  now?: () => number
}

export type ResolvedPermission = {
  decision: "allow" | "deny"
  reason: string
  /** The policy effect before arbitration (useful for diagnostics). */
  policy: PolicyDecision["effect"]
}

const defaultTimeoutMs = 5 * 60_000

export async function resolvePermission(input: ResolvePermissionInput): Promise<ResolvedPermission> {
  const decision = decideToolCall(input.call, input.config, input.state)

  if (decision.effect === "allow") return { decision: "allow", reason: decision.reason, policy: "allow" }
  if (decision.effect === "deny") return { decision: "deny", reason: decision.reason, policy: "deny" }

  // ask
  if (!input.requestApproval) {
    return { decision: "deny", reason: "no operator is available to approve this action", policy: "ask" }
  }

  const timeoutMs = input.timeoutMs ?? defaultTimeoutMs
  const ask: PermissionAsk = {
    tool: input.call.tool_name ?? "unknown",
    ...(typeof input.call.tool_input === "object" && input.call.tool_input
      ? { resource: typeof input.call.tool_input.command === "string" ? input.call.tool_input.command : typeof input.call.tool_input.file_path === "string" ? input.call.tool_input.file_path : undefined }
      : {}),
    reason: decision.reason,
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
    timer.unref?.()
  })

  try {
    const approved = await Promise.race([input.requestApproval(ask).catch(() => false), timeout])
    return approved
      ? { decision: "allow", reason: "operator approved", policy: "ask" }
      : { decision: "deny", reason: "operator did not approve in time", policy: "ask" }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** The `--permission-prompt-tool` name for an MCP server exposing the tool. */
export function buildPermissionPromptTool(server: string, tool: string): string {
  return `mcp__${server}__${tool}`
}
