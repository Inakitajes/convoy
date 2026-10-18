import { describe, expect, test } from "bun:test"

import type { PolicyConfig } from "../src/runners/policy"
import { decideToolCall, preToolUseOutput, resourceOf, toActionRequest, toolToIntent } from "../src/runners/claude/hook"
import { buildClaudeSettings, buildPermissionMcpConfig, encodeClaudeSettings, hasPreToolUseHook, permissionPromptArgs } from "../src/runners/claude/settings"

describe("claude pre-action hook", () => {
  test("maps built-in tools to neutral intents and resources", () => {
    expect(toolToIntent("Read")).toBe("read")
    expect(toolToIntent("Write")).toBe("write")
    expect(toolToIntent("Edit")).toBe("write")
    expect(toolToIntent("Bash")).toBe("execute")
    expect(toolToIntent("Task")).toBe("delegate")
    expect(toolToIntent("WebFetch")).toBe("network")
    expect(resourceOf("Bash", { command: "bun test" })).toBe("bun test")
    expect(resourceOf("Edit", { file_path: "/a.ts" })).toBe("/a.ts")
    expect(toActionRequest({ tool_name: "Write", tool_input: { file_path: "/x" } })).toEqual({
      tool: "Write",
      intent: "write",
      resource: "/x",
    })
  })

  test("mandatory checks cannot be bypassed by auto-approval", () => {
    const readOnly: PolicyConfig = { mode: "read-only", approvals: "auto" }
    expect(decideToolCall({ tool_name: "Write", tool_input: { file_path: "/x" } }, readOnly).effect).toBe("deny")

    const hardDeny: PolicyConfig = { mode: "write", approvals: "auto", hardDeny: [{ intent: "execute", resource: "rm -rf" }] }
    expect(decideToolCall({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }, hardDeny).effect).toBe("deny")

    const checkpoint: PolicyConfig = { mode: "write", approvals: "auto", requireAdvisorBeforeWrite: true }
    expect(decideToolCall({ tool_name: "Edit", tool_input: { file_path: "/x" } }, checkpoint, { advisorSatisfied: false }).effect).toBe("deny")
  })

  test("approval modes apply to ask-worthy actions", () => {
    const write = { tool_name: "Write", tool_input: { file_path: "/x" } }
    expect(decideToolCall(write, { mode: "write", approvals: "auto" }).effect).toBe("allow")
    expect(decideToolCall(write, { mode: "write", approvals: "interactive" }).effect).toBe("ask")
  })

  test("renders the hook's JSON decision", () => {
    const output = JSON.parse(preToolUseOutput({ effect: "deny", reason: "no" }))
    expect(output).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" },
    })
  })
})

describe("claude settings with interception", () => {
  test("registers a PreToolUse hook covering all tools", () => {
    const settings = buildClaudeSettings({ preToolUse: { command: "convoy hook", timeout: 5 } })
    expect(hasPreToolUseHook(settings)).toBe(true)
    const encoded = encodeClaudeSettings(settings)
    expect(encoded).toContain("PreToolUse")
    expect(encoded).toContain("convoy hook")
    expect(JSON.parse(encoded).hooks.PreToolUse[0].matcher).toBe("*")
  })

  test("detects settings without the hook", () => {
    expect(hasPreToolUseHook({})).toBe(false)
    expect(hasPreToolUseHook(null)).toBe(false)
    expect(hasPreToolUseHook({ hooks: { PreToolUse: [] } })).toBe(false)
  })

  test("renders the permission host's MCP config and prompt-tool args", () => {
    expect(buildPermissionMcpConfig("convoy", "convoy-mcp", ["permission"])).toEqual({
      mcpServers: { convoy: { command: "convoy-mcp", args: ["permission"] } },
    })
    expect(permissionPromptArgs("mcp__convoy__permission")).toEqual(["--permission-prompt-tool", "mcp__convoy__permission"])
  })
})
