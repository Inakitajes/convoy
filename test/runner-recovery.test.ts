import { describe, expect, test } from "bun:test"

import { decideRecovery, type RecoveryEvidence } from "../src/runners/recovery"

const verified: RecoveryEvidence = {
  runnerAvailable: true,
  checkoutMatches: true,
  sessionExists: true,
  authValid: true,
  versionSupported: true,
}
const session = { runner: "opencode" as const, sessionId: "ses_1" }

describe("attempt recovery decisions", () => {
  test("continues an exact verified session in place", () => {
    const decision = decideRecovery(verified, { session })
    expect(decision.action).toBe("continue-exact")
    expect(decision.session).toEqual(session)
  })

  test("never auto-retries an uncertain prompt or write", () => {
    expect(decideRecovery({ ...verified, uncertainOutcome: true }, { session }).action).toBe("request-explicit-choice")
  })

  test("asks for an explicit choice when the session is gone or the target moved", () => {
    expect(decideRecovery({ ...verified, sessionExists: false }, { session }).action).toBe("request-explicit-choice")
    expect(decideRecovery({ ...verified, sessionExists: undefined }, { session }).action).toBe("request-explicit-choice")
    expect(decideRecovery({ ...verified, checkoutMatches: false }, { session }).action).toBe("request-explicit-choice")
    expect(decideRecovery({ ...verified, authValid: false }, { session }).action).toBe("request-explicit-choice")
    expect(decideRecovery({ ...verified, versionSupported: false }, { session }).action).toBe("request-explicit-choice")
  })

  test("refuses when the runner is unavailable", () => {
    expect(decideRecovery({ ...verified, runnerAvailable: false }, { session }).action).toBe("refuse")
  })

  test("continues past an accepted deliverable instead of repeating the write", () => {
    expect(decideRecovery({ ...verified, reportAccepted: true }, {}).action).toBe("continue-exact")
  })

  test("a fresh attempt is only chosen when nothing needs reconciling", () => {
    expect(decideRecovery({ runnerAvailable: true, checkoutMatches: true, authValid: true, versionSupported: true }, {}).action).toBe(
      "retry-fresh",
    )
  })
})
