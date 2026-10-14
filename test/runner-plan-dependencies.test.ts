import { describe, expect, test } from "bun:test"

import { assertPlanDependenciesAvailable, collectPlanDependencies, missingDependencies, PlanDependencyError } from "../src/runners/plan-dependencies"
import type { AgentStep, Pipeline } from "../src/types"

function step(name: string, extra: Partial<AgentStep> = {}): AgentStep {
  return {
    type: "agent",
    name,
    agentName: name,
    description: name,
    model: "openai/gpt",
    inputFiles: [],
    inputDiff: false,
    reportPath: `${name}.md`,
    groupId: name,
    stepName: name,
    ...extra,
  }
}

const pipeline: Pipeline = {
  name: "p",
  steps: [step("implement"), step("review", { runner: "claude-code", advisor: "opus" })],
  goalPlan: {
    target: 90,
    maxIterations: 3,
    plateau: 1,
    briefRecipient: "fix",
    scoreProducer: "score",
    improve: { steps: [step("fix", { runner: "claude-code" })] },
    measure: { steps: [step("score")] },
  },
}

describe("plan dependency traversal", () => {
  test("collects ordinary steps, goal fragments, advisors, judge, and helpers", () => {
    const deps = collectPlanDependencies(pipeline, { judge: "claude-code", helpers: [{ role: "commit", runner: "claude-code" }] })
    const labels = deps.map((dependency) => dependency.label)
    expect(labels).toContain("implement")
    expect(labels).toContain("review advisor")
    expect(labels).toContain("fix")
    expect(labels).toContain("score")
    expect(labels).toContain("smart judge")
    expect(labels).toContain("helper:commit")
    // The goal fragment's Claude step is seen even though it runs late.
    expect(deps.some((dependency) => dependency.label === "fix" && dependency.runner === "claude-code")).toBe(true)
  })

  test("reports a missing future dependency before any writable phase", () => {
    const deps = collectPlanDependencies(pipeline)
    const missing = missingDependencies(deps, (runner) => runner === "opencode")
    expect(missing.map((dependency) => dependency.label).sort()).toEqual(["fix", "review", "review advisor"])
    expect(() => assertPlanDependenciesAvailable(pipeline, {}, (runner) => runner === "opencode")).toThrow(PlanDependencyError)
  })

  test("passes when every runner is available", () => {
    expect(() => assertPlanDependenciesAvailable(pipeline, {}, () => true)).not.toThrow()
    expect(missingDependencies(collectPlanDependencies(pipeline), () => true)).toEqual([])
  })
})
