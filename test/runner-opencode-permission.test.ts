import { describe, expect, test } from "bun:test"

import { decideToolCall } from "../src/runners/claude/hook"
import { decideOpencodePermission, opencodeActionToIntent, toActionRequest } from "../src/runners/opencode/permission"
import type { PolicyConfig } from "../src/runners/policy"

describe("opencode permission mapping", () => {
  test("maps v2 permission actions to neutral intents", () => {
    expect(opencodeActionToIntent("edit")).toBe("write")
    expect(opencodeActionToIntent("bash")).toBe("execute")
    expect(opencodeActionToIntent("task")).toBe("delegate")
    expect(opencodeActionToIntent("webfetch")).toBe("network")
    expect(opencodeActionToIntent("grep")).toBe("read")
    expect(toActionRequest("bash", ["bun test"])).toEqual({ tool: "bash", intent: "execute", resource: "bun test" })
  })

  test("both runners decide equivalent actions identically", () => {
    const configs: PolicyConfig[] = [
      { mode: "read-only", approvals: "auto" },
      { mode: "verify", approvals: "auto", verifyAllow: ["bun test"] },
      { mode: "write", approvals: "interactive" },
      { mode: "write", approvals: "auto", hardDeny: [{ intent: "execute", resource: "rm -rf" }] },
      { mode: "write", approvals: "auto", requireAdvisorBeforeWrite: true },
    ]
    // (expected decision) is the same for the OpenCode and Claude forms.
    const pairs: { opencodeAction: string; resources?: string[]; claudeTool: string; claudeInput: Record<string, unknown> }[] = [
      { opencodeAction: "edit", claudeTool: "Write", claudeInput: { file_path: "/x" } },
      { opencodeAction: "bash", resources: ["bun test"], claudeTool: "Bash", claudeInput: { command: "bun test" } },
      { opencodeAction: "bash", resources: ["rm -rf /"], claudeTool: "Bash", claudeInput: { command: "rm -rf /" } },
      { opencodeAction: "read", claudeTool: "Read", claudeInput: { file_path: "/x" } },
    ]
    for (const config of configs) {
      for (const pair of pairs) {
        const opencode = decideOpencodePermission(pair.opencodeAction, pair.resources, config, { advisorSatisfied: false }).effect
        const claude = decideToolCall({ tool_name: pair.claudeTool, tool_input: pair.claudeInput }, config, { advisorSatisfied: false }).effect
        expect(opencode).toBe(claude)
      }
    }
  })
})
