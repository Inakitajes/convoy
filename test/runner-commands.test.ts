import { describe, expect, test } from "bun:test"

import { evaluateHookInput, policyFromEnv } from "../src/runners/commands"

describe("enforcement commands", () => {
  test("policyFromEnv fails closed and accepts a reviewed policy", () => {
    expect(policyFromEnv({})).toEqual({ mode: "read-only", approvals: "interactive" })
    expect(policyFromEnv({ CONVOY_RUNNER_POLICY: '{"mode":"write","approvals":"auto"}' })).toEqual({ mode: "write", approvals: "auto" })
    expect(policyFromEnv({ CONVOY_RUNNER_POLICY: "not json" })).toEqual({ mode: "read-only", approvals: "interactive" })
  })

  test("evaluateHookInput denies a write under read-only and allows a read", () => {
    const policy = { mode: "read-only" as const, approvals: "auto" as const }
    const denied = JSON.parse(evaluateHookInput(JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/x" } }), policy))
    expect(denied.hookSpecificOutput.permissionDecision).toBe("deny")
    const allowed = JSON.parse(evaluateHookInput(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x" } }), policy))
    expect(allowed.hookSpecificOutput.permissionDecision).toBe("allow")
  })

  test("malformed input fails closed", () => {
    const output = JSON.parse(evaluateHookInput("not json", { mode: "write", approvals: "auto" }))
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny")
  })

  test("the CLI `hook` command answers a PreToolUse payload", async () => {
    const proc = Bun.spawn(["bun", "src/main.ts", "hook"], {
      cwd: process.cwd(),
      stdin: new Blob([JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x" } })]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CONVOY_RUNNER_POLICY: '{"mode":"write","approvals":"auto"}' },
    })
    const out = await new Response(proc.stdout).text()
    const code = await proc.exited
    expect(code).toBe(0)
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("allow")
  }, 30_000)
})
