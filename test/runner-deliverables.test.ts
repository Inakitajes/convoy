import { describe, expect, test } from "bun:test"

import {
  DeliverableLedger,
  validateDeliverable,
  type DeliverableSubmission,
} from "../src/runners/deliverables"

const attempt = { runId: "run-1", phase: "implement", attempt: 1 }

function submission(kind: DeliverableSubmission["kind"], body: string, overrides: Partial<DeliverableSubmission> = {}): DeliverableSubmission {
  return { kind, attempt, body, ...overrides }
}

describe("runner-neutral deliverable validation", () => {
  test("a report must be non-empty markdown", () => {
    expect(validateDeliverable(submission("report", "## Result\n\nDone."))).toEqual({ ok: true })
    expect(validateDeliverable(submission("report", "   \n\t "))).toEqual({ ok: false, error: "report must be non-empty markdown" })
  })

  test("a score must be valid JSON with a numeric score in range", () => {
    expect(validateDeliverable(submission("score", JSON.stringify({ score: 87 })))).toEqual({ ok: true })
    expect(validateDeliverable(submission("score", JSON.stringify({ score: 0 })))).toEqual({ ok: true })
    expect(validateDeliverable(submission("score", JSON.stringify({ score: 100 })))).toEqual({ ok: true })

    expect(validateDeliverable(submission("score", "{not json"))).toEqual({ ok: false, error: "score must be valid JSON" })
    expect(validateDeliverable(submission("score", "[1,2]"))).toEqual({ ok: false, error: "score JSON must be an object" })
    expect(validateDeliverable(submission("score", JSON.stringify({ score: "high" })))).toEqual({ ok: false, error: "score must be a finite number" })
    expect(validateDeliverable(submission("score", JSON.stringify({ score: 101 })))).toEqual({ ok: false, error: "score must be between 0 and 100" })
    expect(validateDeliverable(submission("score", JSON.stringify({ score: -1 })))).toEqual({ ok: false, error: "score must be between 0 and 100" })
  })

  test("a score bound can be narrowed per contract", () => {
    expect(validateDeliverable(submission("score", JSON.stringify({ score: 5 })), { maxScore: 5 })).toEqual({ ok: true })
    expect(validateDeliverable(submission("score", JSON.stringify({ score: 6 })), { maxScore: 5 })).toEqual({
      ok: false,
      error: "score must be between 0 and 5",
    })
  })

  test("a commit description is one subject plus at most three detail lines", () => {
    expect(validateDeliverable(submission("commit-description", "Add runner parity"))).toEqual({ ok: true })
    expect(validateDeliverable(submission("commit-description", "Add runner parity\n\n- reports\n- advisors\n- limits"))).toEqual({ ok: true })
    expect(validateDeliverable(submission("commit-description", "Subject\n- a\n- b\n- c\n- d"))).toEqual({
      ok: false,
      error: "commit description allows at most 3 detail lines",
    })
    expect(validateDeliverable(submission("commit-description", "  \n "))).toEqual({
      ok: false,
      error: "commit description needs a subject line",
    })
  })

  test("attempt identity is Convoy-owned and validated", () => {
    expect(validateDeliverable(submission("report", "ok", { attempt: { runId: "", phase: "p", attempt: 1 } }))).toEqual({
      ok: false,
      error: "attempt.runId must be a non-empty string",
    })
    expect(validateDeliverable(submission("report", "ok", { attempt: { runId: "r", phase: "p", attempt: 0 } }))).toEqual({
      ok: false,
      error: "attempt.attempt must be a positive integer",
    })
  })
})

describe("deliverable ledger", () => {
  test("accepts at most one artifact per (kind, attempt)", () => {
    const ledger = new DeliverableLedger({ now: () => 111 })
    const first = ledger.submit(submission("report", "first"))
    expect(first.ok).toBe(true)
    if (first.ok) expect(first.accepted.acceptedAt).toBe(111)

    const replacement = ledger.submit(submission("report", "second"))
    expect(replacement.ok).toBe(true)
    expect(ledger.accepted("report", attempt)?.body).toBe("second")
    expect(ledger.acceptedList()).toHaveLength(1)
  })

  test("a malformed replacement preserves the last valid candidate", () => {
    const ledger = new DeliverableLedger({ maxCorrections: 3 })
    ledger.submit(submission("score", JSON.stringify({ score: 80 })))

    const malformed = ledger.submit(submission("score", "not json"))
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) {
      expect(malformed.candidate?.body).toBe(JSON.stringify({ score: 80 }))
      expect(malformed.limitReached).toBe(false)
    }
    // The accepted artifact is untouched.
    expect(ledger.accepted("score", attempt)?.body).toBe(JSON.stringify({ score: 80 }))
  })

  test("bounded correction accepts a valid fix and then refuses more", () => {
    const ledger = new DeliverableLedger({ maxCorrections: 1 })
    const malformed = ledger.submit(submission("score", "{oops"))
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) {
      expect(malformed.correctionsRemaining).toBe(1)
      expect(malformed.limitReached).toBe(false)
    }

    const fixed = ledger.submit(submission("score", JSON.stringify({ score: 42 })))
    expect(fixed.ok).toBe(true)
    if (fixed.ok) expect(fixed.correctionsRemaining).toBe(0)

    const over = ledger.submit(submission("score", JSON.stringify({ score: 43 })))
    expect(over.ok).toBe(false)
    if (!over.ok) {
      expect(over.limitReached).toBe(true)
      expect(over.error).toBe("correction limit reached (1)")
      expect(over.candidate?.body).toBe(JSON.stringify({ score: 42 }))
    }
    // The valid artifact survives the refused correction.
    expect(ledger.accepted("score", attempt)?.body).toBe(JSON.stringify({ score: 42 }))
  })

  test("correction budget is per (kind, attempt)", () => {
    const ledger = new DeliverableLedger({ maxCorrections: 0 })
    expect(ledger.submit(submission("report", "ok")).ok).toBe(true)
    // A different kind at the same attempt has its own budget.
    expect(ledger.submit(submission("commit-description", "subject")).ok).toBe(true)
    // No corrections remain for the report.
    const refused = ledger.submit(submission("report", "changed"))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.limitReached).toBe(true)
  })

  test("snapshot and restore preserve identity and the correction bound", () => {
    const ledger = new DeliverableLedger({ maxCorrections: 1, maxScore: 50, now: () => 7 })
    ledger.submit(submission("report", "kept"))
    ledger.submit(submission("report", "bad")) // consumes one correction

    const restored = DeliverableLedger.restore(ledger.snapshot())
    expect(restored.accepted("report", attempt)).toEqual(ledger.accepted("report", attempt))
    // The single correction is already used, so a further submit is refused.
    const refused = restored.submit(submission("report", "again"))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.limitReached).toBe(true)
  })
})
