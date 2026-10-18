/**
 * Claude reconciliation with the completed contract (change
 * `unify-runner-system`, tasks 3.4–3.6).
 *
 * The Claude adapter's supported services and session/lifecycle facets are
 * reconciled with its effective capabilities, and its flows are exercised
 * through the registered composition rather than a bare adapter.
 */

import { describe, expect, test } from "bun:test"

import { buildEnforcementPlan, composeRunners } from "../src/runners/compose"
import { assertServicesSupported, assertSessionOperationSupported, resolveRunnerCapabilities, supportsSessionOperation, UnsupportedServiceError, UnsupportedSessionOperationError } from "../src/runners/capabilities"
import { capability, type ExecutionAdapter } from "../src/runners/contracts"
import { buildClaudeArgs, type ClaudeProcess } from "../src/runners/claude/adapter"
import { makeRequest } from "./helpers/runner-conformance"

const fixture = [
  `{"type":"system","subtype":"init","session_id":"ses_claude_1"}`,
  `{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"Hello "}}}`,
  `{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"world"}}}`,
  `{"type":"result","subtype":"success","result":"Hello world","total_cost_usd":0.02,"usage":{"input_tokens":10,"output_tokens":5}}`,
]

function fakeProcess(): ClaudeProcess {
  const encoder = new TextEncoder()
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${fixture.join("\n")}\n`))
      controller.close()
    },
  })
  const stderr = new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
  return { stdout, stderr, exited: Promise.resolve(0), exitCode: 0, kill: () => {} }
}

const enforcement = buildEnforcementPlan({ hookCommand: "convoy hook", permissionCommand: "convoy mcp" })

describe("Claude capability matrix (task 3.5)", () => {
  test("unsupported services are refused explicitly, not silently dropped", () => {
    const claude = resolveRunnerCapabilities("claude-code", { enforcementReady: true })
    expect(() => assertServicesSupported(claude, ["deliverables"])).not.toThrow()
    try {
      assertServicesSupported(claude, ["loop-guard"])
      throw new Error("expected a refusal")
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedServiceError)
    }
    expect(() => assertServicesSupported(claude, ["advisor"])).not.toThrow()
    expect(() => assertServicesSupported(claude, ["approvals"])).not.toThrow()
  })

  test("only the session operations the runner honors are claimed", () => {
    const claude = resolveRunnerCapabilities("claude-code", { enforcementReady: true })
    expect(supportsSessionOperation(claude, "resume")).toBe(true)
    expect(supportsSessionOperation(claude, "history")).toBe(false)
    expect(() => assertSessionOperationSupported(claude, "history")).toThrow(UnsupportedSessionOperationError)
    expect(capability(claude, "live-observation")?.availability).toBe("available")
  })
})

describe("Claude through registered composition (task 3.6)", () => {
  test("a read-only attempt completes through the registry", async () => {
    const composition = composeRunners({
      cwd: "/tmp",
      claude: { deps: { spawn: () => fakeProcess(), probeAuth: async () => ({ authMethod: "claude.ai" }) } },
      enforcement,
    })
    try {
      const adapter = composition.registry.require("claude-code").execution as ExecutionAdapter
      const caps = await adapter.capabilities()
      expect(caps.runner).toBe("claude-code")
      const request = makeRequest({ runner: "claude-code", mode: "read-only", agent: { name: "reviewer", mode: "read-only", model: { runner: "claude-code", modelId: "haiku" } } })
      const outcome = await adapter.executeAttempt(request, () => {})
      expect(outcome.status).toBe("completed")
      expect(outcome.assistantText).toBe("Hello world")
    } finally {
      await composition.close()
    }
  })

  test("a write attempt without enforcement fails closed", async () => {
    const composition = composeRunners({ cwd: "/tmp", claude: { deps: { spawn: () => fakeProcess() } } })
    try {
      const adapter = composition.registry.require("claude-code").execution as ExecutionAdapter
      const capabilities = await adapter.capabilities()
      expect(capability(capabilities, "approvals")?.availability).toBe("restricted")
      const request = makeRequest({ runner: "claude-code", mode: "write", approvals: "auto" })
      const outcome = await adapter.executeAttempt(request, () => {})
      expect(outcome.status).toBe("failed")
      expect(outcome.error).toContain("enforcement")
    } finally {
      await composition.close()
    }
  })

  test("a continuation resumes the exact recorded session", () => {
    const args = buildClaudeArgs(makeRequest({ runner: "claude-code", continueSession: { runner: "claude-code", sessionId: "ses_prev" } }))
    expect(args).toEqual(expect.arrayContaining(["--resume", "ses_prev"]))
    // A continuation for another runner is not silently applied.
    const foreign = buildClaudeArgs(makeRequest({ runner: "claude-code", continueSession: { runner: "opencode", sessionId: "ses_x" } }))
    expect(foreign).not.toContain("--resume")
  })
})
