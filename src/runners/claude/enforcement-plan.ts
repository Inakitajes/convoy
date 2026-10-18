/**
 * Reviewed Claude enforcement plan (change `unify-runner-system`, task 4.1).
 *
 * Moved out of the composition root so the Claude attempt can build its own
 * plan without importing the composition (which imports the attempt modules for
 * registration), keeping the dependency graph acyclic.
 *
 * By default the plan points at this Convoy's own `hook` and `mcp` subcommands,
 * so Claude write and verify steps are enforced out of the box; the
 * `CONVOY_CLAUDE_*` variables only override the commands.
 */

import { convoySourceEntry, isOfficialStandaloneExecutable } from "../../update"
import { buildPermissionPromptTool } from "./permission-broker"
import { buildClaudeSettings, buildPermissionMcpConfig } from "./settings"
import type { EnforcementPlan } from "./enforcement"

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

/** The enforcement plan from the environment, when the app exposes hook/MCP commands. */
export function claudeEnforcementFromEnv(env: NodeJS.ProcessEnv = process.env): EnforcementPlan | undefined {
  const hookCommand = env.CONVOY_CLAUDE_HOOK_COMMAND
  const permissionCommand = env.CONVOY_CLAUDE_MCP_COMMAND
  if (!hookCommand || !permissionCommand) return undefined
  return buildEnforcementPlan({ hookCommand, permissionCommand })
}

/**
 * The argv that re-invokes this Convoy with an internal subcommand: a release
 * executable runs `execPath <sub>`, a source checkout re-runs its entry script
 * with the same runtime flags.
 */
export function convoySubcommandArgv(sub: string, standalone = isOfficialStandaloneExecutable()): string[] {
  if (standalone) return [process.execPath, sub]
  return [process.execPath, ...process.execArgv, convoySourceEntry, sub]
}

/** POSIX-quotes an argv into one shell command line (Claude runs hooks through a shell). */
export function shellCommandLine(argv: readonly string[]): string {
  return argv.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(" ")
}

/** The enforcement plan that routes Claude's hook and permission host to this Convoy. */
export function convoyEnforcementPlan(argvFor: (sub: string) => string[] = convoySubcommandArgv): EnforcementPlan {
  const mcp = argvFor("mcp")
  return buildEnforcementPlan({
    hookCommand: shellCommandLine(argvFor("hook")),
    permissionCommand: mcp[0]!,
    permissionArgs: mcp.slice(1),
  })
}

/** The plan a run uses: an explicit environment override, else this Convoy's own commands. */
export function resolveClaudeEnforcement(env: NodeJS.ProcessEnv = process.env): EnforcementPlan {
  return claudeEnforcementFromEnv(env) ?? convoyEnforcementPlan()
}
