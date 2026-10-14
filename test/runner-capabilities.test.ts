import { describe, expect, test } from "bun:test"

import { capabilityAvailable, resolveRunnerCapabilities } from "../src/runners/capabilities"

describe("effective capability resolution", () => {
  test("OpenCode on a supported v2 exposes the full surface", () => {
    const caps = resolveRunnerCapabilities("opencode", { version: "2.0.28" })
    expect(capabilityAvailable(caps, "write")).toBe(true)
    expect(capabilityAvailable(caps, "native-live-attach")).toBe(true)
  })

  test("OpenCode on an unsupported runtime restricts everything with a reason", () => {
    const caps = resolveRunnerCapabilities("opencode", { version: "1.18.4" })
    expect(capabilityAvailable(caps, "write")).toBe(false)
    expect(caps.capabilities.every((entry) => entry.availability === "restricted")).toBe(true)
  })

  test("Claude supports the baseline but not native attach", () => {
    const caps = resolveRunnerCapabilities("claude-code", { enforcementReady: true })
    expect(capabilityAvailable(caps, "write")).toBe(true)
    expect(capabilityAvailable(caps, "verify")).toBe(true)
    expect(capabilityAvailable(caps, "model-fanout")).toBe(true)
    expect(capabilityAvailable(caps, "native-live-attach")).toBe(false)
    expect(caps.capabilities.find((entry) => entry.id === "explicit-handoff")?.availability).toBe("restricted")
  })

  test("Claude without enforcement restricts approvals", () => {
    const caps = resolveRunnerCapabilities("claude-code", { enforcementReady: false })
    expect(caps.capabilities.find((entry) => entry.id === "approvals")?.availability).toBe("restricted")
    // Read-only is still safe without enforcement.
    expect(capabilityAvailable(caps, "read-only")).toBe(true)
  })
})
