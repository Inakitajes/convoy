import { describe, expect, test } from "bun:test"

import { evaluateAction, type ActionRequest, type PolicyConfig } from "../src/runners/policy"

const base: PolicyConfig = { mode: "write", approvals: "auto" }

describe("runner-neutral action policy", () => {
  test("hard denials win in every approval mode", () => {
    const config: PolicyConfig = { ...base, approvals: "auto", hardDeny: [{ intent: "execute", resource: "rm -rf" }] }
    expect(evaluateAction({ tool: "Bash", intent: "execute", resource: "rm -rf /" }, config).effect).toBe("deny")
    expect(evaluateAction({ tool: "Read", intent: "read" }, config).effect).toBe("allow")
  })

  test("read-only denies any mutation and allows reads", () => {
    const config: PolicyConfig = { mode: "read-only", approvals: "auto" }
    expect(evaluateAction({ tool: "Write", intent: "write" }, config).effect).toBe("deny")
    expect(evaluateAction({ tool: "Bash", intent: "execute" }, config).effect).toBe("deny")
    expect(evaluateAction({ tool: "Agent", intent: "delegate" }, config).effect).toBe("deny")
    expect(evaluateAction({ tool: "Read", intent: "read" }, config).effect).toBe("allow")
  })

  test("verify allows only approved commands and denies writes", () => {
    const config: PolicyConfig = { mode: "verify", approvals: "auto", verifyAllow: ["bun test", "tsc"] }
    expect(evaluateAction({ tool: "Bash", intent: "execute", resource: "bun test" }, config).effect).toBe("allow")
    expect(evaluateAction({ tool: "Bash", intent: "execute", resource: "curl evil" }, config).effect).toBe("deny")
    expect(evaluateAction({ tool: "Write", intent: "write" }, config).effect).toBe("deny")
  })

  test("the advisor checkpoint blocks writes until satisfied", () => {
    const config: PolicyConfig = { mode: "write", approvals: "auto", requireAdvisorBeforeWrite: true }
    expect(evaluateAction({ tool: "Write", intent: "write" }, config, { advisorSatisfied: false }).effect).toBe("deny")
    expect(evaluateAction({ tool: "Write", intent: "write" }, config, { advisorSatisfied: true }).effect).toBe("allow")
  })

  test("approval modes map ask-worthy actions", () => {
    const write: ActionRequest = { tool: "Write", intent: "write" }
    expect(evaluateAction(write, { mode: "write", approvals: "auto" }).effect).toBe("allow")
    expect(evaluateAction(write, { mode: "write", approvals: "interactive" }).effect).toBe("ask")
    expect(evaluateAction(write, { mode: "write", approvals: "smart" }).effect).toBe("ask")
  })

  test("equivalent actions across runners yield identical decisions", () => {
    const config: PolicyConfig = { mode: "verify", approvals: "auto", verifyAllow: ["bun test"] }
    // OpenCode: edit/shell. Claude: Write/Bash. Same intents => same decisions.
    const cases: [ActionRequest, ActionRequest][] = [
      [{ tool: "edit", intent: "write" }, { tool: "Write", intent: "write" }],
      [{ tool: "shell", intent: "execute", resource: "bun test" }, { tool: "Bash", intent: "execute", resource: "bun test" }],
      [{ tool: "shell", intent: "execute", resource: "rm -rf /" }, { tool: "Bash", intent: "execute", resource: "rm -rf /" }],
    ]
    for (const [a, b] of cases) {
      expect(evaluateAction(a, config).effect).toBe(evaluateAction(b, config).effect)
    }
  })
})
