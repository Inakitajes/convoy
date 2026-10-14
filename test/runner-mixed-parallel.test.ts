import { describe, expect, test } from "bun:test"

import { createConcurrencyLimiter, planBatches } from "../src/runner"
import type { AgentStep, Step } from "../src/types"

function step(name: string, groupId: string, runner?: "claude-code"): Step {
  const base: AgentStep = {
    type: "agent",
    name,
    agentName: name,
    description: name,
    model: runner ? "sonnet" : "openai/gpt",
    inputFiles: [],
    inputDiff: false,
    reportPath: `${name}.md`,
    groupId,
    stepName: name,
    ...(runner ? { runner } : {}),
  }
  return base
}

describe("mixed-runner parallel planning", () => {
  test("a group batches mixed Claude and OpenCode steps together", () => {
    const batches = planBatches([step("a", "g1", "claude-code"), step("b", "g1"), step("c", "g2")])
    expect(batches.map((batch) => batch.map((entry) => entry.name))).toEqual([["a", "b"], ["c"]])
  })

  test("sibling runners in one group keep their own identity", () => {
    const [group] = planBatches([step("a", "g1", "claude-code"), step("b", "g1")])
    const runners = group.map((entry) => (entry.type === "agent" ? entry.runner ?? "opencode" : "human"))
    expect(runners).toEqual(["claude-code", "opencode"])
  })

  test("the concurrency limiter bounds live attempts", async () => {
    const limit = createConcurrencyLimiter(2)
    let active = 0
    let peak = 0
    const jobs = Array.from({ length: 6 }, () =>
      limit(async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active--
      }),
    )
    await Promise.all(jobs)
    expect(peak).toBeLessThanOrEqual(2)
    expect(active).toBe(0)
  })
})
