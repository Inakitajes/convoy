import { describe, expect, test } from "bun:test"

import { assertEnforcementReady, EnforcementNotReadyError } from "../src/runners/claude/enforcement"
import { serveMcpPermissionStdio } from "../src/runners/claude/mcp-stdio"
import { buildClaudeSettings, buildPermissionMcpConfig } from "../src/runners/claude/settings"
import type { McpPermissionDeps } from "../src/runners/claude/mcp-permission-server"

function plan(overrides: Partial<Parameters<typeof assertEnforcementReady>[0]> = {}) {
  return {
    settings: buildClaudeSettings({ preToolUse: { command: "convoy hook" } }),
    mcpConfig: buildPermissionMcpConfig("convoy", "convoy-mcp"),
    permissionPromptTool: "mcp__convoy__permission",
    ...overrides,
  }
}

describe("claude enforcement readiness", () => {
  test("accepts a plan with a hook and a permission host", () => {
    expect(() => assertEnforcementReady(plan())).not.toThrow()
  })

  test("fails closed without the hook, the host, or the tool name", () => {
    expect(() => assertEnforcementReady(plan({ settings: {} }))).toThrow(EnforcementNotReadyError)
    expect(() => assertEnforcementReady(plan({ mcpConfig: { mcpServers: {} } }))).toThrow(EnforcementNotReadyError)
    expect(() => assertEnforcementReady(plan({ permissionPromptTool: "" }))).toThrow(EnforcementNotReadyError)
  })
})

async function* chunks(...values: string[]): AsyncGenerator<string> {
  for (const value of values) yield value
}

describe("mcp permission stdio transport", () => {
  test("answers requests and ignores notifications", async () => {
    const deps: McpPermissionDeps = { resolve: async () => ({ decision: "allow" }) }
    const writes: string[] = []
    await serveMcpPermissionStdio(deps, {
      input: chunks(
        `{"jsonrpc":"2.0","id":1,"method":"initialize"}\n`,
        `{"jsonrpc":"2.0","method":"notifications/initialized"}\n`,
        `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"permission","arguments":{"tool_name":"Read"}}}`,
      ),
      write: (line) => writes.push(line),
    })
    const responses = writes.map((line) => JSON.parse(line))
    expect(responses.map((response) => response.id)).toEqual([1, 2])
    expect(responses[1].result.content[0].text).toContain("allow")
  })

  test("ignores malformed lines without crashing", async () => {
    const deps: McpPermissionDeps = { resolve: async () => ({ decision: "deny" }) }
    const writes: string[] = []
    await serveMcpPermissionStdio(deps, {
      input: chunks("not json\n", `{"jsonrpc":"2.0","id":9,"method":"ping"}\n`),
      write: (line) => writes.push(line),
    })
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0]!).id).toBe(9)
  })
})
