import { describe, expect, test } from "bun:test"

import { assertServicesSupported, filterSupportedServices, resolveRunnerCapabilities, supportsService, UnsupportedServiceError } from "../src/runners/capabilities"
import type { AttemptOutcome, ExecutionAdapter, ExecutionRequest, ExecutionServices, RunnerEvent } from "../src/runners/contracts"

describe("runner service capabilities", () => {
  test("OpenCode supports every optional service; Claude supports all but the loop guard", () => {
    const opencode = resolveRunnerCapabilities("opencode", { version: "2.0.28" })
    expect(supportsService(opencode, "approvals")).toBe(true)
    expect(supportsService(opencode, "deliverables")).toBe(true)
    expect(supportsService(opencode, "advisor")).toBe(true)
    expect(supportsService(opencode, "loop-guard")).toBe(true)

    const claude = resolveRunnerCapabilities("claude-code", { enforcementReady: true })
    expect(supportsService(claude, "deliverables")).toBe(true)
    expect(supportsService(claude, "advisor")).toBe(true)
    expect(supportsService(claude, "loop-guard")).toBe(false)
  })

  test("a required unimplemented service is refused naming runner and service", () => {
    const claude = resolveRunnerCapabilities("claude-code", { enforcementReady: true })
    expect(() => assertServicesSupported(claude, ["deliverables"])).not.toThrow()
    try {
      assertServicesSupported(claude, ["loop-guard"])
      throw new Error("expected a refusal")
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedServiceError)
      expect((error as UnsupportedServiceError).service).toBe("loop-guard")
      expect((error as Error).message).toContain("claude-code")
    }
  })

  test("unsupported services are dropped rather than silently wrong", () => {
    const claude = resolveRunnerCapabilities("claude-code", { enforcementReady: true })
    const { supported, unsupported } = filterSupportedServices(claude, {
      deliverables: { submit: async () => ({ ok: true }) },
      "loop-guard": { observe: () => {} },
    })
    expect(Object.keys(supported)).toEqual(["deliverables"])
    expect(unsupported).toEqual(["loop-guard"])
  })
})

describe("attempt service delivery", () => {
  function adapter(seen: string[]): ExecutionAdapter {
    return {
      id: "claude-code",
      async capabilities() {
        return resolveRunnerCapabilities("claude-code", { enforcementReady: true })
      },
      async executeAttempt(_request: ExecutionRequest, sink: (event: RunnerEvent) => void, services?: ExecutionServices): Promise<AttemptOutcome> {
        for (const key of Object.keys(services ?? {})) seen.push(key)
        sink({ type: "terminal", runner: "claude-code", attempt: 1, outcome: { status: "completed" } })
        return { status: "completed" }
      },
      async cancelAttempt() {},
    }
  }

  const request: ExecutionRequest = {
    identity: { runId: "r", phaseName: "p", attempt: 1 },
    runner: "claude-code",
    checkout: "/tmp",
    agent: { name: "a", mode: "write", model: { runner: "claude-code", modelId: "haiku" } },
    prompt: "x",
    auth: { mode: "subscription" },
    mode: "write",
    approvals: "auto",
    signal: new AbortController().signal,
  }

  test("a runner runs with no services and receives one when provided", async () => {
    const none: string[] = []
    await adapter(none).executeAttempt(request, () => {})
    expect(none).toEqual([])

    const some: string[] = []
    await adapter(some).executeAttempt(request, () => {}, { deliverables: { expected: [], submit: async () => ({ ok: true }) } })
    expect(some).toEqual(["deliverables"])
  })
})
