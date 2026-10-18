/**
 * Shared runner conformance suite (change `runner-parity-opencode-v2`, task 2.5).
 *
 * Any neutral execution adapter must satisfy the same contract; the real
 * Claude adapter is run through {@link runExecutionConformance} in
 * `test/runner-conformance.test.ts`, so parity is asserted once, in one place.
 */

import { describe, expect, test } from "bun:test"

import type { AttemptOutcome, ExecutionAdapter, ExecutionRequest, RunnerEvent, RunnerId } from "../../src/runners/contracts"

export function makeRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    identity: { runId: "run-conformance", phaseName: "implement", attempt: 1 },
    runner: "opencode",
    checkout: "/tmp/checkout",
    agent: { name: "implementer", mode: "write", model: { runner: "opencode", modelId: "openai/gpt" } },
    prompt: "do the thing",
    auth: { mode: "subscription", billingPolicy: "included-only" },
    mode: "write",
    approvals: "auto",
    signal: new AbortController().signal,
    ...overrides,
  }
}

const terminalStatuses: readonly AttemptOutcome["status"][] = ["completed", "failed", "interrupted", "uncertain"]

/**
 * Registers the neutral-contract conformance checks for one adapter.
 * `makeAdapter` must return a fresh adapter so attempts do not share state.
 */
export function runExecutionConformance(id: RunnerId, makeAdapter: () => ExecutionAdapter): void {
  describe(`runner conformance: ${id}`, () => {
    test("declares capabilities for its own runner", async () => {
      const caps = await makeAdapter().capabilities()
      expect(caps.runner).toBe(id)
      expect(Array.isArray(caps.capabilities)).toBe(true)
      expect(caps.capabilities.every((entry) => typeof entry.id === "string")).toBe(true)
    })

    test("normalizes attempt events and resolves a terminal outcome", async () => {
      const adapter = makeAdapter()
      const request = makeRequest({ runner: id, agent: { name: "a", mode: "write", model: { runner: id, modelId: "m" } } })
      const events: RunnerEvent[] = []
      const outcome = await adapter.executeAttempt(request, (event) => events.push(event))

      expect(terminalStatuses).toContain(outcome.status)
      expect(events.length).toBeGreaterThan(0)
      expect(events.every((event) => event.runner === id)).toBe(true)
      expect(events.every((event) => event.attempt === request.identity.attempt)).toBe(true)
      if (outcome.status === "completed") {
        expect(events.some((event) => event.type === "terminal")).toBe(true)
      }
    })

    test("cancellation resolves without throwing for an unknown attempt", async () => {
      await expect(makeAdapter().cancelAttempt({ runId: "run-conformance", phaseName: "implement", attempt: 99 })).resolves.toBeUndefined()
    })
  })
}
