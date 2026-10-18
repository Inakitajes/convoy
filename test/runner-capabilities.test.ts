import { describe, expect, test } from "bun:test"

import { buildEnforcementPlan } from "../src/runners/compose"
import { createClaudeRunner } from "../src/runners/claude/adapter"
import { opencodeCapabilities } from "../src/runners/opencode/registration"
import { capabilityAvailable, resolveRunnerCapabilities } from "../src/runners/capabilities"
import { capability } from "../src/runners/contracts"

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

describe("the adapter declaration is the single authoritative source", () => {
  test("the OpenCode adapter resolves from the shared declaration, including loop-guard", () => {
    const declared = opencodeCapabilities("2.0.28")
    expect(declared).toEqual(resolveRunnerCapabilities("opencode", { version: "2.0.28" }))
    // The surface the adapter advertises matches the preflight surface.
    expect(declared.capabilities.some((entry) => entry.id === "loop-guard")).toBe(true)
  })

  test("the Claude adapter resolves from the shared declaration and enforcement evidence", async () => {
    const bare = createClaudeRunner({ cwd: "/tmp", env: {} })
    const bareCaps = await bare.capabilities()
    expect(bareCaps).toEqual(resolveRunnerCapabilities("claude-code", { enforcementReady: false }))
    expect(capability(bareCaps, "approvals")?.availability).toBe("restricted")

    const guarded = createClaudeRunner({
      cwd: "/tmp",
      env: {},
      enforcement: buildEnforcementPlan({ hookCommand: "convoy hook", permissionCommand: "convoy mcp" }),
    })
    const guardedCaps = await guarded.capabilities()
    expect(capability(guardedCaps, "approvals")?.availability).toBe("available")
  })
})

describe("native versus bridged semantics", () => {
  test("Claude discloses that live observation is not a native attach", () => {
    const caps = resolveRunnerCapabilities("claude-code", { enforcementReady: true })
    const live = capability(caps, "live-observation")
    expect(live?.availability).toBe("available")
    if (live?.availability === "available") expect(live.semantics).toContain("not a native attach")
  })

  test("a capability the runner cannot honor is advertised as restricted, never dropped", () => {
    const caps = resolveRunnerCapabilities("claude-code", { enforcementReady: true })
    expect(capability(caps, "explicit-handoff")?.availability).toBe("restricted")
    expect((capability(caps, "explicit-handoff") as { remediation?: string }).remediation).toBeTruthy()
    // The advisor bridge is Claude's once its hook and permission host are installed.
    expect(capability(caps, "advisor-bridge")?.availability).toBe("available")
    expect(capability(resolveRunnerCapabilities("claude-code", { enforcementReady: false }), "advisor-bridge")?.availability).toBe("restricted")
  })
})
