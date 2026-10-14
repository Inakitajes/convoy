import { describe, expect, test } from "bun:test"

import { advanceHandoff, assertAuthorityBeforeOpen, HandoffError, isHandoffComplete, nextHandoffStep, type HandoffState } from "../src/runners/handoff"

function complete(): HandoffState {
  let state: HandoffState = {}
  for (const step of ["quiesce", "verify-no-write", "persist-checkpoint", "transfer-writer", "open-session"] as const) {
    state = advanceHandoff(state, step)
  }
  return state
}

describe("quiesced handoff", () => {
  test("steps must be performed in order", () => {
    expect(nextHandoffStep({})).toBe("quiesce")
    expect(() => advanceHandoff({}, "transfer-writer")).toThrow(HandoffError)
    expect(() => advanceHandoff({}, "open-session")).toThrow(HandoffError)
  })

  test("cannot open before writer authority is transferred", () => {
    let state = advanceHandoff({}, "quiesce")
    state = advanceHandoff(state, "verify-no-write")
    state = advanceHandoff(state, "persist-checkpoint")
    // transfer-writer is next; opening is refused.
    expect(() => advanceHandoff(state, "open-session")).toThrow(HandoffError)
    state = advanceHandoff(state, "transfer-writer")
    state = advanceHandoff(state, "open-session")
    expect(isHandoffComplete(state)).toBe(true)
  })

  test("a complete handoff reports done and refuses further steps", () => {
    const state = complete()
    expect(nextHandoffStep(state)).toBe("done")
    expect(() => advanceHandoff(state, "open-session")).toThrow(HandoffError)
  })

  test("assertAuthorityBeforeOpen rejects an illegitimate opened state", () => {
    expect(() => assertAuthorityBeforeOpen({ opened: true, writerTransferred: false })).toThrow(HandoffError)
    expect(() => assertAuthorityBeforeOpen({ opened: true, writerTransferred: true })).not.toThrow()
  })
})
