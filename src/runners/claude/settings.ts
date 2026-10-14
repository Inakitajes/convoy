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

/** True when the settings object installs a PreToolUse hook. */
export function hasPreToolUseHook(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null) return false
  const hooks = (settings as { hooks?: unknown }).hooks
  if (typeof hooks !== "object" || hooks === null) return false
  const pre = (hooks as { PreToolUse?: unknown }).PreToolUse
  return Array.isArray(pre) && pre.length > 0
}
