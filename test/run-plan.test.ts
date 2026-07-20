import { expect, test } from "bun:test"

import { builtInAgents, builtInPipelines, resolvePipeline } from "../src/pipeline"
import { logicalModel } from "../src/model-routing"
import { buildRunPlan, routePipeline } from "../src/run-plan"
import type { AgentStep, RunOptions } from "../src/types"

test("the immutable plan filters and freezes exact routed targets", () => {
  const options: RunOptions = {
    prompt: "ship it",
    files: [],
    onlySteps: ["build"],
    skipSteps: ["audit"],
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
  const originalStep = options.pipeline.steps[0]
  if (originalStep?.type !== "agent") throw new Error("expected an agent step")
  expect(Object.isFrozen(originalStep.inputFiles)).toBe(false)
  expect(Object.isFrozen(options.hooks.pre[0])).toBe(false)
})

test("routing preserves every built-in pipeline's execution structure", () => {
  for (const [name, spec] of Object.entries(builtInPipelines)) {
    const original = resolvePipeline({ name, spec, agents: builtInAgents })
    const shape = (step: AgentStep) => ({
      name: step.name,
      stepName: step.stepName,
      groupId: step.groupId,
      reportPath: step.reportPath,
      inputFiles: step.inputFiles,
      readOnly: step.readOnly,
    })
    const originalAgents = original.steps.filter((step): step is AgentStep => step.type === "agent")

    for (const gateway of ["configured", "direct", "openrouter", "vercel"] as const) {
      const routed = routePipeline(original, gateway, {})
      const routedAgents = routed.steps.filter((step): step is AgentStep => step.type === "agent")

      expect(routedAgents.map(shape)).toEqual(originalAgents.map(shape))
      for (const [index, step] of routedAgents.entries()) {
        const originalStep = originalAgents[index]!
        const configured = `${originalStep.model}${originalStep.variant ? `#${originalStep.variant}` : ""}`
        const recovered = logicalModel(configured)
        const logical = `${recovered.model}${recovered.variant ? `#${recovered.variant}` : ""}`
        const expectedTarget =
          gateway === "configured"
            ? configured
            : gateway === "direct"
              ? logical
              : gateway === "openrouter"
                ? `openrouter/${logical.replace(/^zai\//, "z-ai/")}`
                : `vercel/${logical}`

        expect(step.resolvedModel?.gateway).toBe(gateway)
        expect(step.resolvedModel?.target).toBe(expectedTarget)
      }
    }
  }
})

test("the plan routes fan-out and the smart judge while leaving Claude Code untouched", () => {
  const options: RunOptions = {
    prompt: "review the change",
    files: ["docs/architecture.md"],
    onlySteps: [],
    skipSteps: [],
    resumeRunID: "20260720-135802-5bbh",
    keepRunDir: true,
    modelOverride: "",
    gateway: "vercel",
    modelRoutingOverrides: {},
    tui: false,
    humanReview: true,
    maxAttempts: 3,
    baseRef: "main",
    targetDir: "/repo",
    includeDirty: true,
    yolo: false,
    smart: true,
    smartJudgeModel: "anthropic/claude-haiku-4.5",
    pipeline: {
      name: "review",
      steps: [
        { type: "agent", name: "audit__openai", stepName: "audit", groupId: "parallel", agentName: "audit", description: "Audit", model: "openai/gpt-5.6-sol", inputFiles: ["prd.md"], inputDiff: true, reportPath: "reports/audit__openai.md", readOnly: true },
        { type: "agent", name: "audit__anthropic", stepName: "audit", groupId: "parallel", agentName: "audit", description: "Audit", model: "anthropic/claude-opus-4.8", inputFiles: ["prd.md"], inputDiff: true, reportPath: "reports/audit__anthropic.md", readOnly: true },
        { type: "agent", name: "external", stepName: "external", groupId: "g2", agentName: "external", description: "External audit", runner: "claude-code", model: "opus", inputFiles: ["prd.md"], inputDiff: false, reportPath: "reports/external.md", readOnly: true },
      ],
    },
    agents: [],
    permissions: { allow: [], deny: [] },
    hooks: { pre: [{ command: "bun test" }], post: [], pipelines: { review: { pre: [], post: [{ command: "bun run lint", when: "always" }] } } },
  }

  const plan = buildRunPlan({ ...options, promptSource: "resume", worktree: true })
  const [openai, anthropic, claude] = plan.pipeline.steps

  expect(plan.prompt).toEqual({ source: "resume", text: "review the change" })
  expect(plan.target).toEqual({ directory: "/repo", baseRef: "main", worktree: true, dirty: true })
  expect(plan.resume).toEqual({ runID: "20260720-135802-5bbh" })
  expect(plan.permissions).toBe("smart")
  expect(plan.attachments).toEqual(["docs/architecture.md"])
  expect(plan.hooks).toEqual({ pre: [{ command: "bun test" }], post: [{ command: "bun run lint", when: "always" }] })
  expect(openai).toMatchObject({ name: "audit__openai", stepName: "audit", groupId: "parallel", resolvedModel: { logical: "openai/gpt-5.6-sol", target: "vercel/openai/gpt-5.6-sol" } })
  expect(anthropic).toMatchObject({ name: "audit__anthropic", stepName: "audit", groupId: "parallel", resolvedModel: { logical: "anthropic/claude-opus-4.8", target: "vercel/anthropic/claude-opus-4.8" } })
  expect(claude).toMatchObject({ runner: "claude-code", model: "opus" })
  expect(claude).not.toHaveProperty("resolvedModel")
  expect(plan.smartJudge?.model).toMatchObject({ logical: "anthropic/claude-haiku-4.5", target: "vercel/anthropic/claude-haiku-4.5" })
})

test("the plan freezes the routed branch namer and marks an explicit resume gateway override", () => {
  const options: RunOptions = {
    prompt: "review the change",
    files: [],
    onlySteps: [],
    skipSteps: [],
    resumeRunID: "20260720-135802-5bbh",
    keepRunDir: true,
    modelOverride: "",
    gateway: "openrouter",
    modelRoutingOverrides: {},
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
      name: "review",
      steps: [
        { type: "agent", name: "audit", stepName: "audit", groupId: "g1", agentName: "audit", description: "Audit", model: "openai/gpt-5.6-sol", inputFiles: ["prd.md"], inputDiff: true, reportPath: "reports/audit.md", readOnly: true },
      ],
    },
    agents: [],
    permissions: { allow: [], deny: [] },
    hooks: { pre: [], post: [], pipelines: {} },
  }

  const overridden = buildRunPlan({ ...options, promptSource: "resume", resumeGateway: "vercel", branchNameModel: "anthropic/claude-haiku-4-5" })
  expect(overridden.resume).toEqual({ runID: "20260720-135802-5bbh", gatewayOverride: { original: "vercel", pending: "openrouter" } })
  expect(overridden.branchNamer?.model).toMatchObject({ logical: "anthropic/claude-haiku-4-5", target: "openrouter/anthropic/claude-haiku-4-5" })
  expect(Object.isFrozen(overridden.branchNamer)).toBe(true)

  // Resuming with the frozen gateway (or no explicit override) leaves no banner.
  const unchanged = buildRunPlan({ ...options, gateway: "vercel", promptSource: "resume", resumeGateway: "vercel" })
  expect(unchanged.resume).toEqual({ runID: "20260720-135802-5bbh" })
  expect(unchanged).not.toHaveProperty("branchNamer")
})
