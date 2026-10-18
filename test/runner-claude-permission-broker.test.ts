import { describe, expect, test } from "bun:test"

import { buildPermissionPromptTool, resolvePermission, type PermissionAsk } from "../src/runners/claude/permission-broker"
import type { PolicyConfig } from "../src/runners/policy"

const write = { tool_name: "Write", tool_input: { file_path: "/x" } }

describe("claude ask-level permission arbitration", () => {
  test("an allowed action needs no operator", async () => {
    const result = await resolvePermission({ call: { tool_name: "Read", tool_input: { file_path: "/x" } }, config: { mode: "write", approvals: "auto" } })
    expect(result).toMatchObject({ decision: "allow", policy: "allow" })
  })

  test("a hard denial is denied without asking", async () => {
    const config: PolicyConfig = { mode: "write", approvals: "interactive", hardDeny: [{ intent: "execute", resource: "rm -rf" }] }
    let asked = false
    const result = await resolvePermission({
      call: { tool_name: "Bash", tool_input: { command: "rm -rf /" } },
      config,
      requestApproval: async () => {
        asked = true
        return true
      },
    })
    expect(result.decision).toBe("deny")
    expect(asked).toBe(false)
  })

  test("an ask is forwarded to the operator and approved", async () => {
    let seen: PermissionAsk | undefined
    const result = await resolvePermission({
      call: write,
      config: { mode: "write", approvals: "interactive" },
      requestApproval: async (ask) => {
        seen = ask
        return true
      },
    })
    expect(result.decision).toBe("allow")
    expect(seen?.tool).toBe("Write")
    expect(seen?.resource).toBe("/x")
  })

  test("a rejected ask is denied", async () => {
    const result = await resolvePermission({ call: write, config: { mode: "write", approvals: "interactive" }, requestApproval: async () => false })
    expect(result.decision).toBe("deny")
  })

  test("fails closed without an operator or on a timeout", async () => {
    expect((await resolvePermission({ call: write, config: { mode: "write", approvals: "interactive" } })).decision).toBe("deny")
    const timedOut = await resolvePermission({
      call: write,
      config: { mode: "write", approvals: "interactive" },
      requestApproval: () => new Promise<boolean>(() => {}),
      timeoutMs: 20,
    })
    expect(timedOut.decision).toBe("deny")
  })

  test("builds the MCP permission prompt tool name", () => {
    expect(buildPermissionPromptTool("convoy", "permission")).toBe("mcp__convoy__permission")
  })
})
