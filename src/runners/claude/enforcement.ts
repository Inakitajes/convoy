/**
 * Claude enforcement readiness (change `runner-parity-opencode-v2`, task 6.5).
 *
 * Before a Claude attempt runs, Convoy verifies that mandatory enforcement is
 * actually installed: the `PreToolUse` hook is registered and the permission
 * host is configured. If either is missing the plan fails closed rather than
 * running with weaker enforcement (for example an `ask` that no one can answer,
 * or a write that no hook checks).
 */

import { hasPreToolUseHook } from "./settings"

export type EnforcementPlan = {
  /** The `--settings` object the attempt will use. */
  settings: Record<string, unknown>
  /** The `--mcp-config` object declaring the permission host. */
  mcpConfig: Record<string, unknown>
  /** The `--permission-prompt-tool` name. */
  permissionPromptTool: string
}

export class EnforcementNotReadyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EnforcementNotReadyError"
  }
}

function hasPermissionServer(mcpConfig: Record<string, unknown>): boolean {
  const servers = mcpConfig.mcpServers
  if (typeof servers !== "object" || servers === null) return false
  return Object.keys(servers as Record<string, unknown>).length > 0
}

/** Throws unless both the hook and the permission host are present. */
export function assertEnforcementReady(plan: EnforcementPlan): void {
  if (!hasPreToolUseHook(plan.settings)) {
    throw new EnforcementNotReadyError("Claude enforcement is not ready: no PreToolUse hook is registered")
  }
  if (!hasPermissionServer(plan.mcpConfig)) {
    throw new EnforcementNotReadyError("Claude enforcement is not ready: the permission host is not configured")
  }
  if (typeof plan.permissionPromptTool !== "string" || plan.permissionPromptTool.length === 0) {
    throw new EnforcementNotReadyError("Claude enforcement is not ready: no permission-prompt tool is set")
  }
}
