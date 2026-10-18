import { describe, expect, test } from "bun:test"

import { progressSink, toProgressUsage } from "../src/runners/attempt-sink"
import type { ProgressUI } from "../src/progress"

const identity = { runId: "run-1", phaseName: "build", attempt: 1 }

function recorder(): { progress: ProgressUI; calls: unknown[][] } {
  const calls: unknown[][] = []
  const push = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args])
  }
  const progress = {
    phaseSession: push("phaseSession"),
    phaseMessage: push("phaseMessage"),
    phaseActivity: push("phaseActivity"),
    phaseUsageTotal: push("phaseUsageTotal"),
    phaseStepUsage: push("phaseStepUsage"),
    phaseTodos: push("phaseTodos"),
    phaseDiff: push("phaseDiff"),
  } as unknown as ProgressUI
  return { progress, calls }
}

describe("the engine's attempt sink", () => {
  test("renders transcript, tool and session events", () => {
    const { progress, calls } = recorder()
    const sink = progressSink(progress, identity)
    sink({ type: "session", runner: "opencode", attempt: 1, session: { runner: "opencode", sessionId: "ses_1" } })
    sink({ type: "text", runner: "opencode", attempt: 1, text: "hi", partId: "p1" })
    sink({ type: "reasoning", runner: "opencode", attempt: 1, text: "why" })
    sink({ type: "tool", runner: "opencode", attempt: 1, name: "read", detail: "a.ts" })
    sink({ type: "tool", runner: "opencode", attempt: 1, name: "glob" })
    expect(calls).toEqual([
      ["phaseSession", "build", "ses_1"],
      ["phaseMessage", "build", { channel: "response", text: "hi", partID: "p1" }],
      ["phaseMessage", "build", { channel: "reasoning", text: "why" }],
      ["phaseActivity", "build", "read: a.ts", "tool"],
      ["phaseActivity", "build", "glob", "tool"],
    ])
  })

  test("renders the widened progress detail", () => {
    const { progress, calls } = recorder()
    const sink = progressSink(progress, identity)
    sink({ type: "usage", runner: "opencode", attempt: 1, usage: { input: 10, output: 5, reasoning: 2, cacheRead: 3, cacheWrite: 1, costEstimate: 0.02 } })
    sink({ type: "activity", runner: "opencode", attempt: 1, message: "thinking", kind: "think", pulse: true, stepUsage: { cost: 0.01 } })
    sink({ type: "todos", runner: "opencode", attempt: 1, todos: [{ content: "a", status: "pending" }], message: "2 todos" })
    sink({ type: "diff", runner: "opencode", attempt: 1, summary: { files: 1 } as never })
    expect(calls[0]).toEqual([
      "phaseUsageTotal",
      "build",
      { cost: 0.02, tokens: { input: 10, output: 5, reasoning: 2, cacheRead: 3, cacheWrite: 1, total: 17 } },
    ])
    expect(calls[1]).toEqual(["phaseStepUsage", "build", { cost: 0.01 }])
    expect(calls[2]).toEqual(["phaseActivity", "build", "thinking", "think", true])
    expect(calls[3]).toEqual(["phaseTodos", "build", [{ content: "a", status: "pending" }]])
    expect(calls[4]).toEqual(["phaseActivity", "build", "2 todos", "todo"])
    expect(calls[5]).toEqual(["phaseDiff", "build", { files: 1 }])
  })

  test("permission and terminal events are not rendered here", () => {
    const { progress, calls } = recorder()
    const sink = progressSink(progress, identity)
    sink({ type: "permission-settled", runner: "opencode", attempt: 1, requestId: "r", decision: "allow" })
    sink({ type: "terminal", runner: "opencode", attempt: 1, outcome: { status: "completed" } })
    expect(calls).toEqual([])
  })

  test("usage without tokens is not fabricated as zero", () => {
    expect(toProgressUsage({ costEstimate: 0.5 })).toEqual({ cost: 0.5 })
    expect(toProgressUsage({ input: 1 })).toEqual({ tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 } })
  })
})
