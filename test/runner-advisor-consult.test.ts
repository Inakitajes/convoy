import { describe, expect, test } from "bun:test"

import {
  AdvisorCheckpoint,
  AdvisorConsultationError,
  buildConsultationContext,
  type AdvisorRoute,
  type ConsultResult,
} from "../src/runners/advisor-consult"

const attempt = { runId: "run-1", phase: "implement", attempt: 1 }
const other = { runId: "run-1", phase: "implement", attempt: 2 }

function advice(text: string): ConsultResult {
  return { runner: "opencode", text }
}

describe("bounded consultation context", () => {
  test("normalises line endings, whitespace, and empty fragments", () => {
    expect(buildConsultationContext({ transcript: ["a\r\nb  ", "", "  c  "], maxBytes: 1_000 })).toBe("a\nb\n\nc")
  })

  test("bounds the context in bytes while keeping both ends", () => {
    const head = `TASK ${"A".repeat(500)}`
    const tail = `${"B".repeat(500)}-END-OF-TRANSCRIPT`
    const context = buildConsultationContext({ transcript: [head, tail], maxBytes: 300 })
    expect(Buffer.byteLength(context, "utf8")).toBeLessThanOrEqual(300)
    expect(context).toContain("omitted")
    expect(context.startsWith("TASK ")).toBe(true)
    expect(context.endsWith("-END-OF-TRANSCRIPT")).toBe(true)
  })

  test("never splits a multi-byte character at the byte bound", () => {
    const context = buildConsultationContext({ transcript: ["é".repeat(500)], maxBytes: 101 })
    expect(Buffer.byteLength(context, "utf8")).toBeLessThanOrEqual(101)
    expect(context).not.toContain("\uFFFD")
  })

  test("throws on a non-string transcript entry instead of dropping it", () => {
    const transcript = ["ok", 42] as unknown as string[]
    expect(() => buildConsultationContext({ transcript, maxBytes: 100 })).toThrow(TypeError)
  })
})

describe("mandatory advisor checkpoint", () => {
  test("protected work is blocked until a consultation succeeds", async () => {
    const checkpoint = new AdvisorCheckpoint({ executor: "claude-code", context: "transcript" })
    expect(checkpoint.requireBeforeWrite).toBe(true)
    expect(checkpoint.satisfied(attempt)).toBe(false)
    expect(checkpoint.isBlocked(attempt)).toBe(true)
    // A different attempt has its own gate.
    expect(checkpoint.satisfied(other)).toBe(false)

    const result = await checkpoint.consult(attempt, async () => advice("do the smaller thing first"))
    expect(result.text).toBe("do the smaller thing first")
    expect(checkpoint.satisfied(attempt)).toBe(true)
    expect(checkpoint.isBlocked(attempt)).toBe(false)
    // Satisfying one attempt does not satisfy a sibling.
    expect(checkpoint.satisfied(other)).toBe(false)
    expect(checkpoint.history()).toHaveLength(1)
  })

  test("a failed consultation leaves protected work blocked", async () => {
    const checkpoint = new AdvisorCheckpoint({ executor: "claude-code", context: "transcript" })
    const failing = async (): Promise<ConsultResult> => {
      throw new Error("bridge unavailable")
    }
    await expect(checkpoint.consult(attempt, failing)).rejects.toBeInstanceOf(AdvisorConsultationError)
    expect(checkpoint.satisfied(attempt)).toBe(false)
    expect(checkpoint.isBlocked(attempt)).toBe(true)
    expect(checkpoint.history()).toHaveLength(0)
  })

  test("an empty answer does not satisfy the checkpoint", async () => {
    const checkpoint = new AdvisorCheckpoint({ executor: "opencode", context: "transcript" })
    await expect(checkpoint.consult(attempt, async () => advice("   "))).rejects.toBeInstanceOf(AdvisorConsultationError)
    expect(checkpoint.satisfied(attempt)).toBe(false)
  })

  test("a failure after an earlier success does not revoke it", async () => {
    const checkpoint = new AdvisorCheckpoint({ executor: "opencode", context: "transcript" })
    await checkpoint.consult(attempt, async () => advice("first"))
    await expect(
      checkpoint.consult(attempt, async () => {
        throw new Error("later outage")
      }),
    ).rejects.toBeInstanceOf(AdvisorConsultationError)
    expect(checkpoint.satisfied(attempt)).toBe(true)
  })

  test("a non-required checkpoint never blocks and still records advice", async () => {
    const checkpoint = new AdvisorCheckpoint({ executor: "opencode", requireBeforeWrite: false, context: () => "per-attempt" })
    expect(checkpoint.satisfied(attempt)).toBe(true)
    expect(checkpoint.isBlocked(attempt)).toBe(false)
    await checkpoint.consult(attempt, async () => advice("optional advice"))
    expect(checkpoint.history()).toHaveLength(1)
  })
})

describe("advisor routing", () => {
  test("names runner, model, and authentication independently of the executor", () => {
    const route: AdvisorRoute = {
      runner: "opencode",
      model: { runner: "opencode", modelId: "anthropic/claude-sonnet-4-5", variant: "high" },
      auth: { mode: "subscription", billingPolicy: "included-only" },
    }
    expect(route.runner).toBe("opencode")
    expect(route.model.modelId).toBe("anthropic/claude-sonnet-4-5")
    expect(route.auth.mode).toBe("subscription")
  })
})
