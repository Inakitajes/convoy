import { describe, expect, test } from "bun:test"

import { attemptKey, type AttemptIdentity, type ExecutionAdapter } from "../src/runners/contracts"
import { makeRequest } from "./helpers/runner-conformance"

describe("attempt identity", () => {
  test("run + phase + attempt names exactly one attempt", () => {
    const build: AttemptIdentity = { runId: "run-1", phaseName: "build", attempt: 1 }
    const testPhase: AttemptIdentity = { runId: "run-1", phaseName: "test", attempt: 1 }
    const otherRun: AttemptIdentity = { runId: "run-2", phaseName: "build", attempt: 1 }
    const retry: AttemptIdentity = { runId: "run-1", phaseName: "build", attempt: 2 }

    // Same run and local ordinal as `build`, different phase: a bare number
    // would collide, the full identity does not.
    expect(attemptKey(build)).not.toBe(attemptKey(testPhase))
    expect(new Set([attemptKey(build), attemptKey(testPhase), attemptKey(otherRun), attemptKey(retry)]).size).toBe(4)
    expect(attemptKey(build)).toBe("run-1:build:1")
  })

  test("parallel phases with the same local attempt number are distinguished on cancellation", async () => {
    const cancelled: AttemptIdentity[] = []
    const execution: ExecutionAdapter = {
      id: "claude-code",
      async capabilities() {
        return { runner: "claude-code", capabilities: [] }
      },
      async executeAttempt(request, sink) {
        sink({ type: "terminal", runner: "claude-code", attempt: request.identity.attempt, outcome: { status: "completed" } })
        return { status: "completed" }
      },
      async cancelAttempt(attempt) {
        cancelled.push(attempt)
      },
    }

    const build = makeRequest({ identity: { runId: "run-par", phaseName: "build", attempt: 1 } })
    const testPhase = makeRequest({ identity: { runId: "run-par", phaseName: "test", attempt: 1 } })
    await execution.executeAttempt(build, () => {})
    await execution.executeAttempt(testPhase, () => {})
    await execution.cancelAttempt(testPhase.identity)

    // Only the addressed attempt is named, even though both are on attempt 1.
    expect(cancelled).toEqual([testPhase.identity])
    expect(attemptKey(cancelled[0]!)).toBe(attemptKey(testPhase.identity))
    expect(attemptKey(cancelled[0]!)).not.toBe(attemptKey(build.identity))
  })

  test("the identity is a plain Convoy value object, independent of any vendor type", () => {
    const identity: AttemptIdentity = { runId: "r", phaseName: "p", attempt: 3 }
    expect(attemptKey(identity)).toBe("r:p:3")
  })
})
