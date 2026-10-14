import { describe, expect, test } from "bun:test"

import { handleMcpPermissionRequest, type McpPermissionDeps } from "../src/runners/claude/mcp-permission-server"

function deps(decision: "allow" | "deny" = "allow"): McpPermissionDeps {
  return { resolve: async () => ({ decision, reason: decision === "deny" ? "nope" : undefined }) }
}

describe("mcp permission host", () => {
  test("answers initialize with the tools capability", async () => {
    const response = await handleMcpPermissionRequest({ id: 1, method: "initialize" }, deps())
    expect(response).toMatchObject({ id: 1, result: { capabilities: { tools: {} } } })
  })

  test("does not answer notifications", async () => {
    expect(await handleMcpPermissionRequest({ method: "notifications/initialized" }, deps())).toBeUndefined()
  })

  test("lists the permission tool", async () => {
    const response = await handleMcpPermissionRequest({ id: 2, method: "tools/list" }, deps())
    const tools = (response as { result: { tools: { name: string }[] } }).result.tools
    expect(tools.map((tool) => tool.name)).toEqual(["permission"])
  })

  test("resolves a tool call to an allow behavior", async () => {
    const response = await handleMcpPermissionRequest(
      { id: 3, method: "tools/call", params: { name: "permission", arguments: { tool_name: "Write", input: { file_path: "/x" } } } },
      deps("allow"),
    )
    const text = (response as { result: { content: { text: string }[] } }).result.content[0]!.text
    expect(JSON.parse(text)).toEqual({ behavior: "allow" })
  })

  test("resolves a tool call to a deny behavior with a reason", async () => {
    const response = await handleMcpPermissionRequest(
      { id: 4, method: "tools/call", params: { name: "permission", arguments: { tool_name: "Bash" } } },
      deps("deny"),
    )
    const text = (response as { result: { content: { text: string }[] } }).result.content[0]!.text
    expect(JSON.parse(text)).toEqual({ behavior: "deny", message: "nope" })
  })

  test("rejects an unknown tool and an unknown method", async () => {
    expect(await handleMcpPermissionRequest({ id: 5, method: "tools/call", params: { name: "other" } }, deps())).toMatchObject({
      error: { code: -32602 },
    })
    expect(await handleMcpPermissionRequest({ id: 6, method: "nope" }, deps())).toMatchObject({ error: { code: -32601 } })
  })

  test("an unauthorized caller is rejected before any work", async () => {
    let resolved = false
    const guarded: McpPermissionDeps = {
      resolve: async () => {
        resolved = true
        return { decision: "allow" }
      },
      authorize: () => false,
    }
    const response = await handleMcpPermissionRequest({ id: 7, method: "tools/call", params: { name: "permission" } }, guarded)
    expect(response).toMatchObject({ error: { code: -32001 } })
    expect(resolved).toBe(false)
  })
})
