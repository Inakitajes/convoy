/**
 * A minimal registered test harness (change `unify-runner-system`, task 4.5).
 *
 * Adding a harness needs only its adapter, its capability declaration and its
 * attempt registration — the engine path is unchanged and carries no
 * harness-specific branch.
 */

import { describe, expect, test } from "bun:test"

import { resolveAttempt, type AttemptContext, type PhaseAttemptRunner } from "../src/runners/attempt"
import { UnsupportedServiceError } from "../src/runners/capabilities"
import { RunnerRegistry, type AttemptOutcome, type ExecutionAdapter, type RunnerEvent, type RunnerId } from "../src/runners/contracts"
import type { DeliverableContract } from "../src/types"

const markdown: DeliverableContract = { kind: "markdown-report" }
const none: DeliverableContract = { kind: "none" }

/** A third harness: an adapter declaring what it honors, plus its attempt. */
function testHarness(options: { deliverables: boolean }): { id: RunnerId; execution: ExecutionAdapter; attempt: PhaseAttemptRunner } {
  const id = "test-harness" as RunnerId
  const execution: ExecutionAdapter = {
    id,
    async capabilities() {
      return {
        runner: id,
        capabilities: [
          { id: "write", availability: "available" },
          ...(options.deliverables ? [{ id: "structured-deliverables" as const, availability: "available" as const }] : []),
        ],
      }
    },
    async executeAttempt(_request, sink: (event: RunnerEvent) => void): Promise<AttemptOutcome> {
      sink({ type: "text", runner: id, attempt: 1, text: "hi" })
      return { status: "completed", assistantText: "hi" }
    },
    async cancelAttempt() {},
  }
  const attempt: PhaseAttemptRunner = async () => ({ assistantText: "hi", model: "test-model" })
  return { id, execution, attempt }
}

describe("a minimal registered harness", () => {
  test("needs only its adapter, declaration and attempt — no engine change", async () => {
    const harness = testHarness({ deliverables: true })
    const registry = new RunnerRegistry()
    registry.register({ id: harness.id, execution: harness.execution })

    const runner = await resolveAttempt({
      runner: harness.id,
      contract: markdown,
      capabilities: () => registry.require(harness.id).execution.capabilities(),
      attempt: harness.attempt,
    })
    const result = await runner({} as AttemptContext)
    expect(result.assistantText).toBe("hi")
  })

  test("a harness that lacks a required service is refused before running", async () => {
    const harness = testHarness({ deliverables: false })
    const registry = new RunnerRegistry()
    registry.register({ id: harness.id, execution: harness.execution })
    await expect(
      resolveAttempt({
        runner: harness.id,
        contract: markdown,
        capabilities: () => registry.require(harness.id).execution.capabilities(),
        attempt: harness.attempt,
      }),
    ).rejects.toBeInstanceOf(UnsupportedServiceError)
  })

  test("a contract that needs no deliverable runs without one", async () => {
    const harness = testHarness({ deliverables: false })
    const registry = new RunnerRegistry()
    registry.register({ id: harness.id, execution: harness.execution })
    await expect(
      resolveAttempt({
        runner: harness.id,
        contract: none,
        capabilities: () => registry.require(harness.id).execution.capabilities(),
        attempt: harness.attempt,
      }),
    ).resolves.toBe(harness.attempt)
  })

  test("a runner with no registered attempt is refused", async () => {
    const harness = testHarness({ deliverables: true })
    const registry = new RunnerRegistry()
    registry.register({ id: harness.id, execution: harness.execution })
    await expect(
      resolveAttempt({ runner: harness.id, contract: markdown, capabilities: () => registry.require(harness.id).execution.capabilities(), attempt: undefined }),
    ).rejects.toThrow(/no phase attempt registered/)
  })
})
