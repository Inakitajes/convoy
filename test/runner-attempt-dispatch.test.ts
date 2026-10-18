/**
 * The engine's common attempt dispatch (change `unify-runner-system`, task 4.1).
 *
 * The engine prepares one neutral context and validates the required services
 * by capability; the runner's attempt is resolved from the registry, so there
 * is no harness-specific execution branch in core.
 */

import { describe, expect, test } from "bun:test"

import { requiredServicesFor } from "../src/runners/attempt"
import { assertServicesSupported, resolveRunnerCapabilities, UnsupportedServiceError } from "../src/runners/capabilities"
import { composeRunners } from "../src/runners/compose"
import type { Capability, RunnerCapabilities, RunnerId } from "../src/runners/contracts"
import type { DeliverableContract } from "../src/types"

const markdown: DeliverableContract = { kind: "markdown-report" }
const none: DeliverableContract = { kind: "none" }

describe("registered attempt dispatch", () => {
  test("both built-in runners register an attempt; an unknown runner does not", () => {
    const composition = composeRunners({ cwd: "/tmp" })
    expect(typeof composition.attemptFor("opencode")).toBe("function")
    expect(typeof composition.attemptFor("claude-code")).toBe("function")
    expect(composition.attemptFor("pi" as RunnerId)).toBeUndefined()
  })

  test("a run-lifetime composition exposes the registry and the attempts together", () => {
    const composition = composeRunners({ cwd: "/tmp" })
    expect([...composition.registry.list()].sort()).toEqual(["claude-code", "codex", "opencode"])
    void composition.close()
  })
})

describe("required-service validation before an attempt", () => {
  test("a deliverable contract requires the deliverable service; none requires nothing", () => {
    expect(requiredServicesFor(markdown)).toEqual(["deliverables"])
    expect(requiredServicesFor(none)).toEqual([])
  })

  test("a runner without the required service is refused, naming it", () => {
    const bare: RunnerCapabilities = {
      runner: "pi" as RunnerId,
      capabilities: [{ id: "write", availability: "available" }] as readonly Capability[],
    }
    try {
      assertServicesSupported(bare, requiredServicesFor(markdown))
      throw new Error("expected a refusal")
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedServiceError)
      expect((error as UnsupportedServiceError).service).toBe("deliverables")
      expect((error as Error).message).toContain("pi")
    }
  })

  test("both built-in runners satisfy a markdown deliverable contract", () => {
    expect(() => assertServicesSupported(resolveRunnerCapabilities("opencode", { version: "2.0.28" }), requiredServicesFor(markdown))).not.toThrow()
    expect(() => assertServicesSupported(resolveRunnerCapabilities("claude-code", { enforcementReady: true }), requiredServicesFor(markdown))).not.toThrow()
  })
})
