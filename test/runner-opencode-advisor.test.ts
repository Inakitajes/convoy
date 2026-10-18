import { describe, expect, test } from "bun:test"

import type { AdvisorUsage as AdvisorCallUsage } from "../src/advisor"
import type { AdvisorPhaseHandle, AdvisorRuntime } from "../src/advisor-runtime"
import { createSessionAdvisorService } from "../src/runners/session-advisor"

const attemptTokens = { input: 10, output: 5, reasoning: 2, cacheRead: 3, cacheWrite: 1 }

function fakeHandle(maxCalls = 5): AdvisorPhaseHandle & { seen: { sessionID: string; reason: string; question?: string }[] } {
  let calls = 0
  const usage: AdvisorCallUsage[] = []
  const seen: { sessionID: string; reason: string; question?: string }[] = []
  return {
    seen,
    get calls() {
      return calls
    },
    get usage() {
      return usage
    },
    get events() {
      return []
    },
    async consult(reason, question) {
      calls += 1
      if (calls > maxCalls) return { text: `budget of ${maxCalls} consultations reached`, ok: false }
      usage.push({ cost: 0.01, tokens: attemptTokens, model: "advisor-model" })
      return { text: `advice for ${reason}: ${question ?? ""}`, ok: true }
    },
    async delivered() {},
    async feedback() {
      return true
    },
    end() {},
  }
}

/** A runtime that answers `handleFor`/`begin` with the given handle and records the session IDs it saw. */
function fakeRuntime(handle: AdvisorPhaseHandle | undefined, seen: string[] = []): AdvisorRuntime {
  return {
    begin: () => handle,
    handleFor: (sessionID: string) => {
      seen.push(sessionID)
      return handle
    },
    checkpoint: async () => ({ action: "allow" }),
  }
}

describe("OpenCode advisor service", () => {
  test("the first write is held once, then permitted (hold, not block)", async () => {
    const handle = fakeHandle()
    const service = createSessionAdvisorService({ runtime: fakeRuntime(handle), sessionID: "ses_1" })
    expect(service.firstWriteGate).toBe("hold")
    expect(service.satisfied()).toBe(false)

    const advice = await service.consult({ trigger: "first-write", question: "Proceed?" })
    expect(advice.ok).toBe(true)
    expect(advice.text).toContain("first-write")
    // The held write is released after the consultation.
    expect(service.satisfied()).toBe(true)
  })

  test("advisor usage is attributed separately from the executor", async () => {
    const handle = fakeHandle()
    const service = createSessionAdvisorService({ runtime: fakeRuntime(handle), sessionID: "ses_1" })
    const advice = await service.consult({ trigger: "on-demand", question: "Check this" })
    expect(advice.usage).toEqual({ input: 10, output: 5, reasoning: 2, cacheRead: 3, cacheWrite: 1, costEstimate: 0.01 })
  })

  test("a consultation is bounded and a failed consult still releases the hold", async () => {
    const handle = fakeHandle(1)
    const service = createSessionAdvisorService({ runtime: fakeRuntime(handle), sessionID: "ses_1" })
    expect((await service.consult({ trigger: "first-write", question: "one" })).ok).toBe(true)

    const exhausted = await service.consult({ trigger: "on-demand", question: "two" })
    expect(exhausted.ok).toBe(false)
    expect(exhausted.text).toContain("budget")
    // The hold stays released: a failed consult must not cost the executor a turn.
    expect(service.satisfied()).toBe(true)
  })

  test("a completion consultation uses the same session and trigger", async () => {
    const handle = fakeHandle()
    const seen: string[] = []
    const service = createSessionAdvisorService({ runtime: fakeRuntime(handle, seen), sessionID: "ses_live" })
    const advice = await service.consult({ trigger: "completion", question: "Anything wrong?" })
    expect(advice.text).toContain("completion")
    expect(seen).toContain("ses_live")
  })

  test("a phase with no advisor has no gate and no consultation", async () => {
    const service = createSessionAdvisorService({ runtime: fakeRuntime(undefined), sessionID: "ses_none" })
    expect(service.firstWriteGate).toBe("none")
    expect(service.satisfied()).toBe(true)
    const advice = await service.consult({ trigger: "first-write", question: "?" })
    expect(advice.ok).toBe(false)
    expect(advice.text).toContain("no advisor")
  })

  test("a released session finds no live advisor", async () => {
    const service = createSessionAdvisorService({ runtime: fakeRuntime(fakeHandle()), sessionID: "ses_1" })
    service.release()
    expect(service.firstWriteGate).toBe("none")
    expect(service.satisfied()).toBe(true)
  })
})
