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

import { isAbsolute, join } from "node:path"

import { evaluateAction, staticGlobPrefix, type ActionIntent, type ActionRequest, type PolicyConfig, type PolicyDecision, type PolicyState } from "../policy"

export type PreToolUseInput = {
  hook_event_name?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  /** The session's working directory; relative tool paths resolve against it. */
  cwd?: string
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

function stringField(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Extracts the action's target resource from a hook's tool input. A search
 * targets its directory — Grep's `pattern` is a regex, never a path — and a
 * Glob also reaches wherever its pattern's fixed prefix points.
 */
export function resourceOf(toolName: string, input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined
  if (toolName === "Bash") return stringField(input, "command")
  if (toolName === "Grep") return stringField(input, "path") ?? "."
  if (toolName === "Glob") {
    const pattern = stringField(input, "pattern")
    const base = stringField(input, "path") ?? "."
    if (!pattern) return base
    const prefix = staticGlobPrefix(pattern)
    return isAbsolute(prefix) ? prefix : join(base, prefix)
  }
  for (const key of ["file_path", "path", "notebook_path", "command", "query", "url"]) {
    const value = stringField(input, key)
    if (value) return value
  }
  return undefined
}

/** Convoy's own MCP tools (`mcp__convoy__write_report`, …): mediated and scoped by the attempt's bridge. */
const convoyMcpToolPattern = /^mcp__convoy__(write_report|advisor|advisor_feedback)$/

export function isConvoyMcpTool(toolName: string | undefined): boolean {
  return typeof toolName === "string" && convoyMcpToolPattern.test(toolName)
}

/** The neutral action request for a hook input. */
export function toActionRequest(input: PreToolUseInput): ActionRequest {
  const tool = typeof input.tool_name === "string" && input.tool_name.length > 0 ? input.tool_name : "unknown"
  return {
    tool,
    intent: toolToIntent(tool),
    resource: resourceOf(tool, input.tool_input),
    ...(tool === "Grep" || tool === "Glob" ? { scope: "tree" as const } : {}),
    ...(typeof input.cwd === "string" && input.cwd.length > 0 ? { cwd: input.cwd } : {}),
  }
}

/** Convoy's decision for one tool call (used by the hook and by OpenCode). */
export function decideToolCall(input: PreToolUseInput, config: PolicyConfig, state?: PolicyState): PolicyDecision {
  // Submitting a report or consulting the advisor never touches the checkout
  // directly; the attempt's bridge decides what each call may do. Any other
  // MCP tool stays unclassifiable, and so denied.
  if (isConvoyMcpTool(input.tool_name)) return { effect: "allow", reason: "Convoy tool" }
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
