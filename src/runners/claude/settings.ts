/**
 * Claude per-invocation settings that install Convoy's interception (change
 * `runner-parity-opencode-v2`, task 6.2).
 *
 * The `PreToolUse` hook must run for every tool call, so it is registered with a
 * matching entry that covers all tools. Rendering the settings here keeps the
 * hook wiring declarative and testable; the adapter passes the JSON through
 * `--settings` without touching the operator's own configuration.
 */

export type ClaudeHookCommand = {
  /** Shell command Claude runs before a tool call. */
  command: string
  /** Optional per-hook timeout in seconds. */
  timeout?: number
}

/** The `--settings` object registering Convoy's pre-action hook for all tools. */
export function buildClaudeSettings(input: { preToolUse: ClaudeHookCommand }): Record<string, unknown> {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: input.preToolUse.command,
              ...(input.preToolUse.timeout !== undefined ? { timeout: input.preToolUse.timeout } : {}),
            },
          ],
        },
      ],
    },
  }
}

export function encodeClaudeSettings(settings: Record<string, unknown>): string {
  return JSON.stringify(settings)
}

/** Serializes an MCP config object for the `--mcp-config` argument. */
export function encodeClaudeMcpConfig(mcpConfig: Record<string, unknown>): string {
  return JSON.stringify(mcpConfig)
}

/** True when the settings object installs a PreToolUse hook. */
export function hasPreToolUseHook(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null) return false
  const hooks = (settings as { hooks?: unknown }).hooks
  if (typeof hooks !== "object" || hooks === null) return false
  const pre = (hooks as { PreToolUse?: unknown }).PreToolUse
  return Array.isArray(pre) && pre.length > 0
}

/**
 * The `--mcp-config` object declaring the local server that hosts the
 * permission prompt tool. Passed per invocation; the operator's own MCP
 * configuration is untouched.
 */
export function buildPermissionMcpConfig(server: string, command: string, args: readonly string[] = []): Record<string, unknown> {
  return { mcpServers: { [server]: { command, args: [...args] } } }
}

/** The `--permission-prompt-tool` argument pair for a hosted permission tool. */
export function permissionPromptArgs(tool: string): string[] {
  return ["--permission-prompt-tool", tool]
}
