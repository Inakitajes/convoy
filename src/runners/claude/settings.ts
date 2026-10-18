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

/**
 * The MCP config with `env` added to every declared server. Claude passes a
 * server's own `env` to that server only, so a secret placed here never
 * reaches the agent's tools the way Claude's inherited environment does.
 */
export function withServerEnv(mcpConfig: Record<string, unknown>, env: Record<string, string>): Record<string, unknown> {
  const servers = (mcpConfig.mcpServers ?? {}) as Record<string, Record<string, unknown>>
  const withEnv: Record<string, Record<string, unknown>> = {}
  for (const [name, server] of Object.entries(servers)) {
    withEnv[name] = { ...server, env: { ...((server.env ?? {}) as Record<string, string>), ...env } }
  }
  return { ...mcpConfig, mcpServers: withEnv }
}

/**
 * The settings with an environment prefix on every hook command. Claude runs
 * hooks through a shell, so the variables reach the hook process only — not
 * Claude, and so not the agent's tools.
 */
export function withHookEnv(settings: Record<string, unknown>, env: Record<string, string>): Record<string, unknown> {
  const prefix = Object.entries(env)
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid hook environment variable: ${key}`)
      return `${key}='${value.replace(/'/g, `'\\''`)}'`
    })
    .join(" ")
  const clone = structuredClone(settings) as { hooks?: Record<string, { hooks?: { command?: string }[] }[]> }
  for (const entries of Object.values(clone.hooks ?? {})) {
    for (const entry of entries) for (const hook of entry.hooks ?? []) if (typeof hook.command === "string") hook.command = `${prefix} ${hook.command}`
  }
  return clone
}

/** The `--permission-prompt-tool` argument pair for a hosted permission tool. */
export function permissionPromptArgs(tool: string): string[] {
  return ["--permission-prompt-tool", tool]
}
