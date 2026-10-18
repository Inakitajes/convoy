import { describe, expect, test } from "bun:test"

import type { ExecutionRequest } from "../src/runners/contracts"
import { buildClaudeInvocation, enforcementRequired } from "../src/runners/claude/adapter"
import { EnforcementNotReadyError, type EnforcementPlan } from "../src/runners/claude/enforcement"
import { buildPermissionPromptTool } from "../src/runners/claude/permission-broker"
import { buildClaudeSettings, buildPermissionMcpConfig } from "../src/runners/claude/settings"

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    identity: { runId: "run-claude", phaseName: "implement", attempt: 1 },
    runner: "claude-code",
    checkout: "/tmp/checkout",
    agent: { name: "implementer", mode: "write", model: { runner: "claude-code", modelId: "sonnet" } },
    prompt: "do the thing",
    auth: { mode: "subscription" },
    mode: "write",
    approvals: "auto",
    signal: new AbortController().signal,
    ...overrides,
  }
}

function enforcementPlan(): EnforcementPlan {
  return {
    settings: buildClaudeSettings({ preToolUse: { command: "convoy hook pre-tool-use" } }),
    mcpConfig: buildPermissionMcpConfig("convoy", "convoy-mcp"),
    permissionPromptTool: buildPermissionPromptTool("convoy", "permission"),
  }
}

/** The value following a flag in an argv, or undefined when the flag is absent. */
function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

describe("claude invocation gating", () => {
  test("requires enforcement unless the attempt is read-only + auto", () => {
    expect(enforcementRequired(request({ mode: "read-only", approvals: "auto" }))).toBe(false)
    expect(enforcementRequired(request({ mode: "read-only", approvals: "interactive" }))).toBe(true)
    expect(enforcementRequired(request({ mode: "read-only", approvals: "smart" }))).toBe(true)
    expect(enforcementRequired(request({ mode: "verify", approvals: "auto" }))).toBe(true)
    expect(enforcementRequired(request({ mode: "write", approvals: "auto" }))).toBe(true)
  })

  test("fails closed when enforcement is required but absent", () => {
    expect(() => buildClaudeInvocation(request({ mode: "write", approvals: "auto" }), undefined, { env: {} })).toThrow(
      EnforcementNotReadyError,
    )
    expect(() => buildClaudeInvocation(request({ mode: "verify", approvals: "auto" }), undefined, { env: {} })).toThrow(
      EnforcementNotReadyError,
    )
    expect(() => buildClaudeInvocation(request({ mode: "read-only", approvals: "interactive" }), undefined, { env: {} })).toThrow(
      EnforcementNotReadyError,
    )
  })

  test("fails closed when the supplied plan is incomplete", () => {
    const incomplete: EnforcementPlan = { settings: {}, mcpConfig: { mcpServers: {} }, permissionPromptTool: "" }
    expect(() => buildClaudeInvocation(request({ mode: "write", approvals: "auto" }), incomplete, { env: {} })).toThrow(
      EnforcementNotReadyError,
    )
  })

  test("passes the reviewed settings, mcp-config, and prompt tool for a writable attempt", () => {
    const enforcement = enforcementPlan()
    const { args } = buildClaudeInvocation(request({ mode: "write", approvals: "auto" }), enforcement, { env: {} })

    const settings = JSON.parse(valueOf(args, "--settings") ?? "{}")
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("convoy hook pre-tool-use")

    const mcp = JSON.parse(valueOf(args, "--mcp-config") ?? "{}")
    expect(mcp.mcpServers.convoy.command).toBe("convoy-mcp")

    expect(valueOf(args, "--permission-prompt-tool")).toBe("mcp__convoy__permission")
  })

  test("read-only + auto runs without the permission host and keeps its restricted tools", () => {
    const { args } = buildClaudeInvocation(
      request({
        mode: "read-only",
        approvals: "auto",
        agent: { name: "reviewer", mode: "read-only", model: { runner: "claude-code", modelId: "sonnet" } },
      }),
      undefined,
      { env: {} },
    )
    expect(args).toEqual(expect.arrayContaining(["--tools", "Read,Glob,Grep", "--permission-mode", "dontAsk"]))
    expect(args).not.toContain("--settings")
    expect(args).not.toContain("--mcp-config")
    expect(args).not.toContain("--permission-prompt-tool")
  })

  test("never passes --bare or --safe-mode and preserves subscription isolation", () => {
    const { args, env } = buildClaudeInvocation(
      request({ mode: "write", approvals: "auto", auth: { mode: "subscription" } }),
      enforcementPlan(),
      { env: { ANTHROPIC_API_KEY: "sk-ambient", ANTHROPIC_AUTH_TOKEN: "tok", PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "oauth" } },
    )
    expect(args).not.toContain("--bare")
    expect(args).not.toContain("--safe-mode")
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.PATH).toBe("/bin")
    // The operator's subscription login is left in place for the child.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth")
  })

  test("validates and passes enforcement even for read-only + auto when supplied", () => {
    const { args } = buildClaudeInvocation(
      request({ mode: "read-only", approvals: "auto" }),
      enforcementPlan(),
      { env: {} },
    )
    expect(valueOf(args, "--permission-prompt-tool")).toBe("mcp__convoy__permission")
  })

  test("rejects an incomplete plan even when enforcement is not required", () => {
    const incomplete: EnforcementPlan = { settings: {}, mcpConfig: { mcpServers: {} }, permissionPromptTool: "" }
    expect(() => buildClaudeInvocation(request({ mode: "read-only", approvals: "auto" }), incomplete, { env: {} })).toThrow(
      EnforcementNotReadyError,
    )
  })
})
