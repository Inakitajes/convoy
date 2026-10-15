import { describe, expect, test } from "bun:test"

import {
  capability,
  isAvailable,
  RunnerRegistry,
  type AttemptOutcome,
  type ExecutionAdapter,
  type ExecutionRequest,
  type RunnerCapabilities,
  type RunnerEvent,
} from "../src/runners/contracts"

/** A vendor-free fake adapter: proves the port is usable without any SDK type. */
function fakeAdapter(id: "opencode" | "claude-code", outcome: AttemptOutcome): ExecutionAdapter {
  const capabilities: RunnerCapabilities = {
    runner: id,
    version: "test",
    capabilities: [
      { id: "write", availability: "available" },
      { id: "native-live-attach", availability: "unavailable", reason: "no listener" },
    ],
  }
  return {
    id,
    async capabilities() {
      return capabilities
    },
    async executeAttempt(request: ExecutionRequest, sink: (event: RunnerEvent) => void): Promise<AttemptOutcome> {
      sink({ type: "session", runner: id, attempt: request.identity.attempt, session: { runner: id, sessionId: "ses_fake" } })
      sink({ type: "text", runner: id, attempt: request.identity.attempt, text: "hello" })
      sink({ type: "terminal", runner: id, attempt: request.identity.attempt, outcome })
      return outcome
    },
    async cancelAttempt() {},
  }
}

function request(): ExecutionRequest {
  return {
    identity: { runId: "run-1", phaseName: "implement", attempt: 1 },
    runner: "claude-code",
    checkout: "/tmp/checkout",
    agent: { name: "implementer", mode: "write", model: { runner: "claude-code", modelId: "sonnet" } },
    prompt: "do the thing",
    auth: { mode: "subscription", billingPolicy: "included-only" },
    mode: "write",
    approvals: "auto",
    signal: new AbortController().signal,
  }
}

describe("runner contracts", () => {
  test("a fake adapter executes through the port and emits normalized events", async () => {
    const adapter = fakeAdapter("claude-code", { status: "completed", finish: "stop" })
    const events: RunnerEvent[] = []
    const outcome = await adapter.executeAttempt(request(), (event) => events.push(event))

    expect(outcome.status).toBe("completed")
    expect(events.map((event) => event.type)).toEqual(["session", "text", "terminal"])
    expect(events.every((event) => event.runner === "claude-code" && event.attempt === 1)).toBe(true)
  })

  test("capabilities are described, not bare booleans", async () => {
    const caps = await fakeAdapter("opencode", { status: "completed" }).capabilities()
    expect(isAvailable(caps, "write")).toBe(true)
    expect(isAvailable(caps, "native-live-attach")).toBe(false)
    expect(capability(caps, "native-live-attach")).toMatchObject({ availability: "unavailable" })
  })

  test("registry rejects duplicates, mismatched ids, and unknown lookups", () => {
    const registry = new RunnerRegistry()
    registry.register({ id: "opencode", execution: fakeAdapter("opencode", { status: "completed" }) })

    expect(() => registry.register({ id: "opencode", execution: fakeAdapter("opencode", { status: "completed" }) })).toThrow(
      /already registered/,
    )
    expect(() => registry.register({ id: "claude-code", execution: fakeAdapter("opencode", { status: "completed" }) })).toThrow(
      /does not match/,
    )
    expect(registry.has("claude-code")).toBe(false)
    expect(() => registry.require("claude-code")).toThrow(/no adapter registered/)
    expect(registry.list()).toEqual(["opencode"])
  })
})
