import { describe, expect, test } from "bun:test"

import type { RunnerCapabilities } from "../src/runners/contracts"
import { planConversation } from "../src/runners/conversation"

const caps = (ids: RunnerCapabilities["capabilities"]): RunnerCapabilities => ({ runner: "claude-code", capabilities: ids })

const observeOnly = caps([{ id: "live-observation", availability: "available" }])
const withAttach = caps([
  { id: "live-observation", availability: "available" },
  { id: "native-live-attach", availability: "available" },
  { id: "explicit-handoff", availability: "available" },
  { id: "post-exit-resume", availability: "available" },
])
const session = { runner: "claude-code" as const, sessionId: "ses_1" }

describe("conversation planning", () => {
  test("observation is always available", () => {
    expect(planConversation({ requested: "observe", runner: "claude-code", capabilities: observeOnly }).ok).toBe(true)
  })

  test("native attach depends on the capability", () => {
    const denied = planConversation({ requested: "native-attach", runner: "claude-code", capabilities: observeOnly })
    expect(denied.ok).toBe(false)
    expect(denied.steps).toEqual(["observe"])
    expect(planConversation({ requested: "native-attach", runner: "claude-code", capabilities: withAttach }).ok).toBe(true)
  })

  test("a quiesced handoff requires the capability and a free writer slot", () => {
    expect(planConversation({ requested: "quiesced-handoff", runner: "claude-code", capabilities: withAttach }).ok).toBe(true)
    expect(
      planConversation({ requested: "quiesced-handoff", runner: "claude-code", capabilities: withAttach, anotherWriterHolds: true }).ok,
    ).toBe(false)
    expect(planConversation({ requested: "quiesced-handoff", runner: "claude-code", capabilities: observeOnly }).ok).toBe(false)
  })

  test("post-exit resume needs a stopped, matching session", () => {
    expect(
      planConversation({ requested: "post-exit-resume", runner: "claude-code", capabilities: withAttach, session, sessionRunning: false }).ok,
    ).toBe(true)
    expect(
      planConversation({ requested: "post-exit-resume", runner: "claude-code", capabilities: withAttach, session, sessionRunning: true }).ok,
    ).toBe(false)
    expect(planConversation({ requested: "post-exit-resume", runner: "claude-code", capabilities: withAttach }).ok).toBe(false)
  })

  test("a session from another runner is refused", () => {
    const plan = planConversation({
      requested: "post-exit-resume",
      runner: "claude-code",
      capabilities: withAttach,
      session: { runner: "opencode", sessionId: "ses_x" },
    })
    expect(plan.ok).toBe(false)
  })
})
