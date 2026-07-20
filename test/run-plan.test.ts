import { expect, test } from "bun:test"

import { buildRunPlan } from "../src/run-plan"
import type { RunOptions } from "../src/types"

test("the immutable plan filters and freezes exact routed targets", () => {
  const options: RunOptions = {
    prompt: "ship it",
    files: [],
    onlySteps: ["build"],
    skipSteps: [],
    resumeRunID: "",
    keepRunDir: true,
    modelOverride: "anthropic/claude-opus-4.8",
    gateway: "vercel",
    tui: false,
    humanReview: false,
    maxAttempts: 2,
    baseRef: "main",
    targetDir: "/repo",
    includeDirty: false,
    yolo: false,
    smart: false,
    smartJudgeModel: "openai/gpt-5.6-sol",
    pipeline: {
      name: "p",
      steps: [
        { type: "agent", name: "build", stepName: "build", groupId: "g1", agentName: "a", description: "a", model: "openai/gpt-5.6-sol", inputFiles: ["prd.md"], inputDiff: false, reportPath: "reports/build.md" },
        { type: "agent", name: "audit", stepName: "audit", groupId: "g2", agentName: "a", description: "a", model: "openai/gpt-5.6-sol", inputFiles: ["prd.md"], inputDiff: true, reportPath: "reports/audit.md" },
      ],
    },
    agents: [],
    permissions: { allow: [], deny: [] },
    hooks: { pre: [{ command: "bun test" }], post: [], pipelines: {} },
  }
  const plan = buildRunPlan(options)
  expect(plan.pipeline.steps).toHaveLength(1)
  const step = plan.pipeline.steps[0]
  expect(step?.type === "agent" && step.resolvedModel?.target).toBe("vercel/anthropic/claude-opus-4.8")
  expect(Object.isFrozen(plan)).toBe(true)
  expect(Object.isFrozen(plan.pipeline.steps)).toBe(true)
  expect(Object.isFrozen(options.pipeline.steps[0]?.inputFiles)).toBe(false)
  expect(Object.isFrozen(options.hooks.pre[0])).toBe(false)
})
