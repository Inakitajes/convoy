/**
 * Runner composition (change `runner-parity-opencode-v2`, tasks 2.2/5.1/6.2).
 *
 * The composition root is the single place that assembles a run's adapters:
 * it renders the Claude enforcement plan (PreToolUse hook + MCP permission
 * host) so write/verify attempts do not fail closed, and registers both
 * adapters behind the neutral registry.
 */

import { buildPermissionPromptTool } from "./claude/permission-broker"
import { buildClaudeSettings, buildPermissionMcpConfig } from "./claude/settings"
import { createClaudeRunner, type ClaudeRunnerOptions } from "./claude/adapter"
import { createOpencodeRunner } from "./opencode/adapter"
import { RunnerRegistry } from "./contracts"

import type { EnforcementPlan } from "./claude/enforcement"

export type EnforcementCommands = {
  /** Shell command Claude runs before every tool call (the PreToolUse hook). */
  hookCommand: string
  /** Executable that runs the MCP permission host. */
  permissionCommand: string
  permissionArgs?: readonly string[]
  serverName?: string
  toolName?: string
}

/** Renders a ready-to-use enforcement plan from concrete commands. */
export function buildEnforcementPlan(input: EnforcementCommands): EnforcementPlan {
  const serverName = input.serverName ?? "convoy"
  const toolName = input.toolName ?? "permission"
  return {
    settings: buildClaudeSettings({ preToolUse: { command: input.hookCommand } }),
    mcpConfig: buildPermissionMcpConfig(serverName, input.permissionCommand, input.permissionArgs ?? []),
    permissionPromptTool: buildPermissionPromptTool(serverName, toolName),
  }
}

export type ComposeOptions = {
  cwd: string
  env?: NodeJS.ProcessEnv
  /** Rendered OpenCode run config (`OPENCODE_CONFIG_CONTENT`). */
  opencodeConfigContent?: string
  /** Claude enforcement plan; without it, Claude write/verify attempts fail closed. */
  enforcement?: EnforcementPlan
  claude?: Omit<ClaudeRunnerOptions, "cwd" | "env" | "enforcement">
  opencode?: Omit<Parameters<typeof createOpencodeRunner>[0], "cwd" | "env" | "configContent">
}

export type Composition = { registry: RunnerRegistry; close(): Promise<void> }

/** Registers the built-in adapters with the assembled options. */
export function composeRunners(options: ComposeOptions): Composition {
  const registry = new RunnerRegistry()
  const opencode = createOpencodeRunner({
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    ...(options.opencodeConfigContent ? { configContent: options.opencodeConfigContent } : {}),
    ...(options.opencode ?? {}),
  })
  const claude = createClaudeRunner({
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    ...(options.enforcement ? { enforcement: options.enforcement } : {}),
    ...(options.claude ?? {}),
  })
  registry.register({ id: "opencode", execution: opencode })
  registry.register({ id: "claude-code", execution: claude })
  return {
    registry,
    async close() {
      await opencode.close().catch(() => undefined)
    },
  }
}
