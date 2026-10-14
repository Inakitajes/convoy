import { describe, expect, test } from "bun:test"

import { LoopGuard, resolveLoopGuard } from "../src/loop-guard"
import { describeMessageChunk, describeSessionActivity, guardObservationFrom, newActivityState } from "../src/runner"

/**
 * Validation against the released V2 event stream (change `migrate-opencode-v2`).
 *
 * Every payload below is copied verbatim from a real `opencode v2.0.26` server's
 * event stream (captured against an isolated runtime), so this pins the mapping
 * from V2's renamed events and `data` envelope onto Convoy's activity and
 * transcript — the part that cannot be derived from declarations alone.
 */

const activity = (event: unknown) => describeSessionActivity(event, newActivityState())

describe("V2 event stream → activity", () => {
  test("a text delta drives the response activity", () => {
    const signal = describeSessionActivity(
      {
        type: "session.text.delta",
        data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, delta: "# Hello Convoy" },
      },
      (() => {
        const s = newActivityState()
        s.lastTextUpdate = 0
        return s
      })(),
    )
    expect(signal).toMatchObject({ type: "activity", kind: "write" })
    expect((signal as { message: string }).message).toContain("writing")
  })

  test("a tool call is named from the preceding input.started event", () => {
    const state = newActivityState()
    describeSessionActivity(
      { type: "session.tool.input.started", data: { sessionID: "ses_1", id: "toolu_1", name: "read" } },
      state,
    )
    const called = describeSessionActivity(
      {
        type: "session.tool.called",
        data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "toolu_1", input: { path: "/repo/README.md" }, executed: false },
      },
      state,
    )
    expect(called).toMatchObject({ type: "activity", kind: "tool" })
    expect((called as { message: string }).message).toContain("read")
    expect((called as { message: string }).message).toContain("README.md")
  })

  test("a tool success reports the content", () => {
    const signal = activity({
      type: "session.tool.success",
      data: { sessionID: "ses_1", id: "toolu_1", content: [{ type: "text", text: "# Hello Convoy" }] },
    })
    expect(signal).toMatchObject({ type: "activity", kind: "tool" })
    expect((signal as { message: string }).message).toContain("Hello Convoy")
  })

  test("a shell command is read from the nested V2 shell record", () => {
    const signal = activity({
      type: "session.shell.started",
      data: { sessionID: "ses_1", shell: { command: "git status", status: "running", cwd: "/repo" } },
    })
    expect(signal).toMatchObject({ type: "activity", kind: "bash", message: "git status" })
  })

  test("a permission request is named from the V2 action field", () => {
    const signal = activity({
      type: "permission.asked",
      data: { id: "perm_1", sessionID: "ses_1", action: "bash", resources: ["git push"] },
    })
    expect((signal as { message: string }).message).toContain("bash")
  })
})

describe("V2 event stream → settlement and usage", () => {
  test("session.execution.succeeded settles the turn as idle", () => {
    expect(activity({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })).toEqual({ type: "idle" })
  })

  test("session.execution.failed is an error, not a silent success", () => {
    const signal = activity({
      type: "session.execution.failed",
      data: { sessionID: "ses_1", error: { message: "provider exploded" } },
    })
    expect(signal).toMatchObject({ type: "error" })
  })

  test("session.usage.updated reports the cumulative session usage", () => {
    const state = newActivityState()
    const signal = describeSessionActivity(
      {
        type: "session.usage.updated",
        data: { sessionID: "ses_1", cost: 0.00040256, tokens: { input: 4, output: 123, reasoning: 0, cache: { read: 5216, write: 2308 } } },
      },
      state,
    )
    expect(signal).toMatchObject({ type: "usage", usage: { cost: 0.00040256 } })
    // The same cumulative value observed twice is deduplicated.
    const again = describeSessionActivity(
      {
        type: "session.usage.updated",
        data: { sessionID: "ses_1", cost: 0.00040256, tokens: { input: 4, output: 123, reasoning: 0, cache: { read: 5216, write: 2308 } } },
      },
      state,
    )
    expect(again).toBeUndefined()
  })
})

describe("V2 event stream → transcript", () => {
  test("text and reasoning deltas become transcript chunks", () => {
    const state = newActivityState()
    expect(
      describeMessageChunk(
        { type: "session.reasoning.delta", data: { sessionID: "ses_1", assistantMessageID: "m", ordinal: 0, delta: "thinking" } },
        state,
      ),
    ).toMatchObject({ channel: "reasoning", text: "thinking" })
    expect(
      describeMessageChunk(
        { type: "session.text.delta", data: { sessionID: "ses_1", assistantMessageID: "m", ordinal: 0, delta: "answer" } },
        state,
      ),
    ).toMatchObject({ channel: "response", text: "answer" })
  })
})

describe("V2 event stream → loop guard fuses", () => {
  // Payload shapes captured from a real `opencode v2.0.26` server: the tool name
  // only rides `input.started`, the call identity is `id`, and usage is the
  // session's cumulative cost.
  const named = (id: string, name: string) => ({ type: "session.tool.input.started", data: { sessionID: "ses_1", assistantMessageID: "msg_1", id, name } })
  const called = (id: string, input: unknown) => ({ type: "session.tool.called", data: { sessionID: "ses_1", assistantMessageID: "msg_1", id, input, executed: false } })
  const failed = (id: string) => ({ type: "session.tool.failed", data: { sessionID: "ses_1", assistantMessageID: "msg_1", id, error: { type: "tool.execution", message: "boom" } } })
  const usage = (cost: number) => ({ type: "session.usage.updated", data: { sessionID: "ses_1", cost, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } })

  const feed = (guard: LoopGuard, events: unknown[]) => {
    for (const event of events) {
      const observation = guardObservationFrom(event)
      const trip = observation ? guard.observe(observation) : undefined
      if (trip) return trip
    }
    return undefined
  }

  test("repeated identical V2 tool calls trip the identical-calls fuse", () => {
    const guard = new LoopGuard(resolveLoopGuard({ identicalCalls: 4 }))
    const events = [1, 2, 3, 4].flatMap((n) => [named(`call_${n}`, "read"), called(`call_${n}`, { path: "/repo/README.md" })])
    expect(feed(guard, events)).toMatchObject({ reason: "identical-calls", tool: "read" })
  })

  test("repeated V2 failures of one tool trip the same-tool fuse", () => {
    const guard = new LoopGuard(resolveLoopGuard({ sameToolFailures: 3 }))
    const events = [1, 2, 3].flatMap((n) => [named(`call_${n}`, "read"), called(`call_${n}`, { path: `/repo/${n}.md` }), failed(`call_${n}`)])
    expect(feed(guard, events)).toMatchObject({ reason: "same-tool-failures", tool: "read" })
  })

  test("V2 step events feed the step ceiling", () => {
    const guard = new LoopGuard(resolveLoopGuard({ maxSteps: 2 }))
    const step = { type: "session.step.started", data: { sessionID: "ses_1", agent: "build", assistantMessageID: "msg_1", started: 1 } }
    expect(feed(guard, [step])).toMatchObject({ reason: "soft-nudge" })
    expect(feed(guard, [step])).toMatchObject({ reason: "max-steps" })
  })

  test("cumulative V2 session usage trips the cost cap once, without double counting", () => {
    const guard = new LoopGuard(resolveLoopGuard({ maxPhaseCost: 1 }))
    expect(feed(guard, [usage(0.4), usage(0.4), usage(0.8)])).toBeUndefined()
    expect(guard.getTotalCost()).toBeCloseTo(0.8)
    expect(feed(guard, [usage(1.05)])).toMatchObject({ reason: "max-cost" })
  })
})
