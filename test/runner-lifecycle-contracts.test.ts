/**
 * Conformance for the neutral accounting, lifecycle and session facets (change
 * `unify-runner-system`, task 1.6).
 *
 * Covers cumulative usage folding, executor/advisor attribution, observed
 * release outcomes, capability-gated session operations and exact session
 * references.
 */

import { describe, expect, test } from "bun:test"

import { assertSessionOperationSupported, supportsSessionOperation, UnsupportedSessionOperationError } from "../src/runners/capabilities"
import { foldUsage, isConfirmedRelease } from "../src/runners/contracts"
import type {
  AttemptOutcome,
  ExecutionAdapter,
  ReleaseOutcome,
  RunnerEvent,
  RunnerSessionRef,
  SessionControls,
} from "../src/runners/contracts"
import { resolveRunnerCapabilities } from "../src/runners/capabilities"

describe("usage accounting", () => {
  test("a cumulative report replaces the total; a delta adds to it", () => {
    const first = foldUsage(undefined, { input: 10, output: 5, costEstimate: 0.1 })
    expect(first).toEqual({ input: 10, output: 5, costEstimate: 0.1 })

    const added = foldUsage(first, { input: 2, output: 1 })
    expect(added).toEqual({ input: 12, output: 6, costEstimate: 0.1 })

    // The harness re-reports the whole turn: replace, never double count.
    const replaced = foldUsage(added, { input: 40, output: 20, costEstimate: 0.4, cumulative: true })
    expect(replaced).toEqual({ input: 40, output: 20, costEstimate: 0.4 })
  })

  test("absent fields are not fabricated as zero", () => {
    expect(foldUsage(undefined, {})).toEqual({})
    const folded = foldUsage(undefined, { reasoning: 3 })
    expect(folded).toEqual({ reasoning: 3 })
    expect("input" in folded).toBe(false)
  })
})

describe("executor and advisor attribution", () => {
  test("the two are folded into separate totals", () => {
    const outcome: AttemptOutcome = {
      status: "completed",
      usage: { input: 100, output: 50, costEstimate: 1.5 },
      advisorUsage: { input: 20, output: 10, costEstimate: 0.05 },
    }
    const executor = foldUsage(undefined, outcome.usage ?? {})
    const advisor = foldUsage(undefined, outcome.advisorUsage ?? {})
    expect(executor.costEstimate).toBe(1.5)
    expect(advisor.costEstimate).toBe(0.05)
    // The advisor is a small fraction, and never folded into the executor total.
    expect(executor.input).toBe(100)
  })
})

describe("release outcomes", () => {
  test("an unresolved release is never reported as confirmed", async () => {
    const adapters: ExecutionAdapter[] = [
      { id: "opencode", async capabilities() { return { runner: "opencode", capabilities: [] } }, async executeAttempt() { return { status: "completed" } }, async cancelAttempt() {}, async release() { return { status: "released" } } },
      { id: "opencode", async capabilities() { return { runner: "opencode", capabilities: [] } }, async executeAttempt() { return { status: "completed" } }, async cancelAttempt() {}, async release() { return { status: "unresolved", reason: "child exit not observed" } } },
    ]
    const outcome = await adapters[0]!.release!()
    expect(isConfirmedRelease(outcome)).toBe(true)
    const unresolved = (await adapters[1]!.release!()) as ReleaseOutcome
    expect(unresolved.status).toBe("unresolved")
    expect(isConfirmedRelease(unresolved)).toBe(false)
  })
})

describe("capability-gated session operations", () => {
  test("attach is refused where the runner has no native live attach", () => {
    const claude = resolveRunnerCapabilities("claude-code", { enforcementReady: true })
    // Claude has no recorded-transcript reconstruction and no native attach.
    expect(supportsSessionOperation(claude, "history")).toBe(false)
    expect(supportsSessionOperation(claude, "resume")).toBe(true)
    expect(supportsSessionOperation(claude, "attach")).toBe(false)
    try {
      assertSessionOperationSupported(claude, "attach")
      throw new Error("expected a refusal")
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedSessionOperationError)
      expect((error as UnsupportedSessionOperationError).operation).toBe("attach")
      expect((error as Error).message).toContain("claude-code")
    }
  })

  test("a capable runner is accepted for every operation", () => {
    const opencode = resolveRunnerCapabilities("opencode", { version: "2.0.28" })
    expect(() => assertSessionOperationSupported(opencode, "history")).not.toThrow()
    expect(() => assertSessionOperationSupported(opencode, "resume")).not.toThrow()
    expect(() => assertSessionOperationSupported(opencode, "attach")).not.toThrow()
  })
})

describe("exact session references", () => {
  test("an operation refuses a session that belongs to another runner", async () => {
    const controls: SessionControls = {
      async history({ session }) {
        if (session.runner !== "opencode") return { ok: false, error: `not an opencode session: ${session.runner}` }
        return { ok: true, events: [{ type: "text", runner: "opencode", attempt: 1, text: "hi" } as RunnerEvent] }
      },
    }
    const address: RunnerSessionRef = { runner: "opencode", sessionId: "ses_1" }
    const identity = { runId: "run-1", phaseName: "implement", attempt: 1 }
    const accepted = await controls.history({ session: address, identity })
    expect(accepted.ok).toBe(true)
    if (accepted.ok) expect(accepted.events[0]?.type).toBe("text")

    const foreign = await controls.history({ session: { runner: "claude-code", sessionId: "ses_1" }, identity })
    expect(foreign.ok).toBe(false)
    if (!foreign.ok) expect(foreign.error).toContain("not an opencode session")
  })

  test("a history result never fabricates missing history", async () => {
    const controls: SessionControls = {
      async history() {
        return { ok: false, error: "session unavailable" }
      },
    }
    const result = await controls.history({ session: { runner: "opencode", sessionId: "gone" }, identity: { runId: "run-1", phaseName: "implement", attempt: 1 } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("session unavailable")
  })
})
