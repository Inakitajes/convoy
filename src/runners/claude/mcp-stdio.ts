/**
 * Stdio transport for the MCP permission host (change
 * `runner-parity-opencode-v2`, task 6.2).
 *
 * Reads newline-delimited JSON-RPC from an input stream, drives the pure
 * permission handler, and writes each response as one line. Notifications get
 * no response. Malformed lines are ignored rather than crashing the host.
 */

import { handleMcpPermissionRequest, type McpPermissionDeps } from "./mcp-permission-server"

export type StdioServerOptions = {
  /** Async chunks (or lines) of input. */
  input: AsyncIterable<Uint8Array | string>
  /** Receives each response line (without the trailing newline). */
  write: (line: string) => void
}

/** Runs the permission host over a stdio-like stream until the input ends. */
export async function serveMcpPermissionStdio(deps: McpPermissionDeps, options: StdioServerOptions): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ""
  const handleLine = async (line: string) => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let request: unknown
    try {
      request = JSON.parse(trimmed)
    } catch {
      return
    }
    if (typeof request !== "object" || request === null) return
    const response = await handleMcpPermissionRequest(request as Parameters<typeof handleMcpPermissionRequest>[0], deps)
    if (response) options.write(JSON.stringify(response))
  }

  for await (const chunk of options.input) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) await handleLine(line)
  }
  if (buffer.trim().length > 0) await handleLine(buffer)
}
