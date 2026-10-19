/**
 * MCP permission host (change `runner-parity-opencode-v2`, tasks 6.2/6.5).
 *
 * A minimal Model Context Protocol server exposing one tool that Claude calls as
 * its `--permission-prompt-tool`. The request handler is pure and transport-free
 * so it can be tested directly; a thin stdio loop can drive it.
 *
 * The tool delegates every decision to Convoy's permission arbiter, so ask-level
 * actions reach the operator and never bypass the hook's mandatory checks. An
 * optional authorize hook rejects an unauthenticated caller.
 */

import type { PreToolUseInput } from "./hook"

export type PermissionResolution = { decision: "allow" | "deny"; reason?: string }

/** Convoy's own agent-facing tools (write_report, advisor), served beside the permission tool. */
export type McpToolHost = {
  definitions: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[]
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>
}

export type McpPermissionDeps = {
  /** Resolve the tool call to a decision (Convoy's arbiter). */
  resolve(call: PreToolUseInput): Promise<PermissionResolution>
  /** Reject an unauthenticated caller before doing any work. */
  authorize?(request: McpRequest): boolean
  /** The attempt's Convoy tools, when its bridge serves any. */
  tools?: McpToolHost
  /** False for a host that serves only Convoy's tools (a runner that asks for approvals in-band). */
  permissionTool?: boolean
}

export type McpRequest = {
  jsonrpc?: "2.0"
  id?: string | number | null
  method?: string
  params?: unknown
}

export type McpResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } }

const permissionToolName = "permission"
const protocolVersion = "2025-06-18"

const permissionTool = {
  name: permissionToolName,
  description: "Return an allow/deny decision for a tool call Convoy's policy marked for approval.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string", description: "The tool the agent wants to use." },
      input: { type: "object", description: "The tool's input." },
    },
    required: ["tool_name"],
  },
} as const

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function ok(id: string | number | null, result: unknown): McpResponse {
  return { jsonrpc: "2.0", id, result }
}

function fail(id: string | number | null, code: number, message: string): McpResponse {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

function callFromArguments(args: Record<string, unknown>): PreToolUseInput {
  const toolName = typeof args.tool_name === "string" ? args.tool_name : "unknown"
  const input = asRecord(args.input) ?? asRecord(args.tool_input)
  return { tool_name: toolName, ...(input ? { tool_input: input } : {}) }
}

/**
 * Handles one MCP request. Returns `undefined` for a notification (no response),
 * which the caller must not answer.
 */
export async function handleMcpPermissionRequest(
  request: McpRequest,
  deps: McpPermissionDeps,
): Promise<McpResponse | undefined> {
  const id = request.id ?? null
  const method = typeof request.method === "string" ? request.method : ""

  if (method.startsWith("notifications/")) return undefined

  if (deps.authorize && !deps.authorize(request)) {
    return fail(id, -32001, "unauthorized")
  }

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "convoy-permission", version: "1.0.0" },
      })
    case "ping":
      return ok(id, {})
    case "tools/list":
      return ok(id, { tools: [...(deps.permissionTool === false ? [] : [permissionTool]), ...(deps.tools?.definitions ?? [])] })
    case "tools/call": {
      const params = asRecord(request.params)
      const name = params && typeof params.name === "string" ? params.name : ""
      if (name !== permissionToolName || deps.permissionTool === false) {
        if (!deps.tools?.definitions.some((tool) => tool.name === name)) return fail(id, -32602, `unknown tool: ${name}`)
        const result = await deps.tools.call(name, params ? asRecord(params.arguments) ?? {} : {})
        return ok(id, { content: [{ type: "text", text: result.text }], isError: result.isError })
      }
      const args = params ? asRecord(params.arguments) ?? {} : {}
      const resolution = await deps.resolve(callFromArguments(args))
      const payload = { behavior: resolution.decision, ...(resolution.reason ? { message: resolution.reason } : {}) }
      return ok(id, { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false })
    }
    default:
      return fail(id, -32601, `method not found: ${method}`)
  }
}
