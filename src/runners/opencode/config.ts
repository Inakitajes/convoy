/**
 * Logical-agent → OpenCode v2 runtime configuration (change
 * `runner-parity-opencode-v2`, task 4.3).
 *
 * Convoy's core describes agents neutrally (`LogicalAgent`). This module renders
 * them into the native V2 plural shapes (`agents`, `permissions`) that OpenCode
 * injects through `OPENCODE_CONFIG_CONTENT`. It never reads or rewrites the
 * user's own configuration files: the rendered content is merged by OpenCode at
 * runtime, so a supported user V1 config keeps working unchanged.
 *
 * Permission actions use V2 names: `edit` (V1 write/patch/edit), `shell` (V1
 * bash), `subagent` (V1 task).
 */

import type { ExecutionMode, LogicalAgent, ModelReference } from "../contracts"

export type V2PermissionEffect = "allow" | "deny" | "ask"
export type V2PermissionRule = { action: string; resource: string; effect: V2PermissionEffect }

export type V2AgentConfig = {
  description?: string
  system?: string
  model?: string
  mode?: "primary" | "subagent" | "all"
  disabled?: boolean
  permissions?: V2PermissionRule[]
}

export type V2OpencodeConfig = {
  agents?: Record<string, V2AgentConfig>
  permissions?: V2PermissionRule[]
  model?: string
}

/** The V2 model reference string: `provider/model[#variant]`. */
export function modelString(model: ModelReference): string {
  return `${model.modelId}${model.variant ? `#${model.variant}` : ""}`
}

/** Maps a logical tool name to its V2 permission action. */
export function permissionAction(tool: string): string {
  switch (tool) {
    case "write":
    case "patch":
    case "edit":
      return "edit"
    case "bash":
    case "shell":
      return "shell"
    case "task":
      return "subagent"
    default:
      return tool
  }
}

/** The permission rules implied by an execution mode (deny the risky actions). */
export function modePermissionRules(mode: ExecutionMode): V2PermissionRule[] {
  const deny = (action: string): V2PermissionRule => ({ action, resource: "*", effect: "deny" })
  if (mode === "read-only") return [deny("edit"), deny("shell"), deny("subagent")]
  if (mode === "verify") return [deny("edit"), deny("subagent")]
  return []
}

/** The full permission ruleset for one logical agent (mode + explicit intent). */
export function permissionRulesFor(agent: LogicalAgent): V2PermissionRule[] {
  const rules = modePermissionRules(agent.mode)
  for (const tool of agent.tools?.deny ?? []) rules.push({ action: permissionAction(tool), resource: "*", effect: "deny" })
  for (const tool of agent.tools?.allow ?? []) rules.push({ action: permissionAction(tool), resource: "*", effect: "allow" })
  return rules
}

export function translateAgent(agent: LogicalAgent): V2AgentConfig {
  const permissions = permissionRulesFor(agent)
  return {
    ...(agent.instructions ? { system: agent.instructions } : {}),
    model: modelString(agent.model),
    mode: "all",
    ...(permissions.length > 0 ? { permissions } : {}),
  }
}

export function buildOpencodeConfig(input: {
  agents: readonly LogicalAgent[]
  defaultModel?: ModelReference
  /** Run-wide ordered policy rules (V2 last-match-wins). */
  permissions?: readonly V2PermissionRule[]
}): V2OpencodeConfig {
  const agents: Record<string, V2AgentConfig> = {}
  for (const agent of input.agents) agents[agent.name] = translateAgent(agent)
  return {
    ...(Object.keys(agents).length > 0 ? { agents } : {}),
    ...(input.defaultModel ? { model: modelString(input.defaultModel) } : {}),
    ...(input.permissions && input.permissions.length > 0 ? { permissions: [...input.permissions] } : {}),
  }
}

/** Serializes the config for `OPENCODE_CONFIG_CONTENT`. */
export function encodeOpencodeConfigContent(config: V2OpencodeConfig): string {
  return JSON.stringify(config)
}
