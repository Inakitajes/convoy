import { describe, expect, test } from "bun:test"

import { mapOpencodeEvent, mapSessionLog, mapSessionLogItem } from "../src/runners/opencode/log-events"

describe("opencode v2 session-log decoding", () => {
  test("maps ended text and reasoning to neutral events", () => {
    expect(
      mapSessionLogItem({ type: "session.text.ended", data: { sessionID: "ses_1", assistantMessageID: "m", ordinal: 0, text: "hello" } }, 3),
    ).toEqual({ type: "text", runner: "opencode", attempt: 3, text: "hello" })

    expect(
      mapSessionLogItem({ type: "session.reasoning.ended", data: { sessionID: "ses_1", assistantMessageID: "m", ordinal: 0, text: "why" } }, 3),
    ).toEqual({ type: "reasoning", runner: "opencode", attempt: 3, text: "why" })
  })

  test("maps execution outcomes to terminal events", () => {
    const failed = mapSessionLogItem(
      { type: "session.execution.failed", data: { sessionID: "ses_1", error: { message: "boom" } } },
      1,
    ) as { outcome: { status: string; error?: string } }
    expect(failed.outcome.status).toBe("failed")
    expect(failed.outcome.error).toBe("boom")

    const interrupted = mapSessionLogItem({ type: "session.execution.interrupted", data: { sessionID: "ses_1", reason: "user" } }, 1) as {
      outcome: { status: string }
    }
    expect(interrupted.outcome.status).toBe("interrupted")

    const succeeded = mapSessionLogItem({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } }, 1) as {
      outcome: { status: string }
    }
    expect(succeeded.outcome.status).toBe("completed")
  })

  test("ignores unrelated and malformed items instead of inventing events", () => {
    expect(mapSessionLogItem({ type: "session.step.streamed", data: { sessionID: "ses_1" } }, 1)).toBeUndefined()
    expect(mapSessionLogItem({ type: "session.text.ended", data: { sessionID: "ses_1" } }, 1)).toBeUndefined()
    expect(mapSessionLogItem(null, 1)).toBeUndefined()
    expect(mapSessionLogItem({ type: "x" }, 1)).toBeUndefined()
  })

  test("maps a batch, dropping unknowns", () => {
    const events = mapSessionLog(
      [
        { type: "session.text.ended", data: { text: "a" } },
        { type: "session.step.streamed", data: {} },
        { type: "session.reasoning.ended", data: { text: "b" } },
      ],
      2,
    )
    expect(events.map((event) => event.type)).toEqual(["text", "reasoning"])
  })
})

describe("opencode v2 live event decoding", () => {
  test("maps text and reasoning deltas", () => {
    expect(mapOpencodeEvent({ type: "session.text.delta", data: { sessionID: "s", delta: "Hi" } }, 1, "s")).toEqual({
      type: "text",
      runner: "opencode",
      attempt: 1,
      text: "Hi",
    })
    expect(mapOpencodeEvent({ type: "session.reasoning.delta", data: { sessionID: "s", delta: "why" } }, 1, "s")).toEqual({
      type: "reasoning",
      runner: "opencode",
      attempt: 1,
      text: "why",
    })
  })

  test("maps usage updates to a usage event", () => {
    const mapped = mapOpencodeEvent(
      { type: "session.usage.updated", data: { sessionID: "s", cost: 0.02, tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 0 } } } },
      1,
      "s",
    )
    expect(mapped).toEqual({ type: "usage", runner: "opencode", attempt: 1, usage: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 0, costEstimate: 0.02 } })
  })

  test("filters to the requested session and drops unknown events", () => {
    expect(mapOpencodeEvent({ type: "session.text.delta", data: { sessionID: "other", delta: "x" } }, 1, "s")).toBeUndefined()
    expect(mapOpencodeEvent({ type: "project.updated", data: { sessionID: "s" } }, 1, "s")).toBeUndefined()
    expect(mapOpencodeEvent({ type: "session.text.delta", data: { sessionID: "s", delta: "x" } }, 1)).toBeDefined()
  })
})
