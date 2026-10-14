/**
 * Claude pre-action interception (change `runner-parity-opencode-v2`, task 6.2).
 *
 * A `PreToolUse` hook runs before every other Claude permission step and cannot
 * be skipped by an allow rule or auto-approval, so it is the interception point
 * that makes Convoy's policy mandatory. This module maps a hook input to a
 * normalised action, evaluates Convoy's policy, and renders the hook's JSON
 * decision.
 *
 * The same decision function serves the OpenCode adapter, which maps its own
 * permission events to the same intents.
 */

import { evaluateAction, type ActionIntent, type ActionRequest, type PolicyConfig, type PolicyDecision, type PolicyState } from "../policy"

export type PreToolUseInput = {
  hook_event_name?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
}

/** Maps a Claude built-in tool name to a neutral intent. */
export function toolToIntent(toolName: string): ActionIntent {
  switch (toolName) {
    case "Read":
    case "Glob":
    case "Grep":
    case "NotebookRead":
      return "read"
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "write"
    case "Bash":
    case "BashOutput":
    case "KillShell":
      return "execute"
    case "Task":
    case "Agent":
      return "delegate"
    case "WebFetch":
    case "WebSearch":
      return "network"
    default:
      return "other"
  }
}

/** Extracts the action's target resource from a hook's tool input. */
export function resourceOf(toolName: string, input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined
  const keys = toolName === "Bash" ? ["command"] : ["file_path", "path", "notebook_path", "command", "pattern", "query", "url"]
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

/** The neutral action request for a hook input. */
export function toActionRequest(input: PreToolUseInput): ActionRequest {
  const tool = typeof input.tool_name === "string" && input.tool_name.length > 0 ? input.tool_name : "unknown"
  return { tool, intent: toolToIntent(tool), resource: resourceOf(tool, input.tool_input) }
}

/** Convoy's decision for one tool call (used by the hook and by OpenCode). */
export function decideToolCall(input: PreToolUseInput, config: PolicyConfig, state?: PolicyState): PolicyDecision {
  return evaluateAction(toActionRequest(input), config, state ?? {})
}

/** The Claude `PreToolUse` hook's stdout payload. */
export function preToolUseOutput(decision: PolicyDecision): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.effect,
      permissionDecisionReason: decision.reason,
    },
  })
}
