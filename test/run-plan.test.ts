import { describe, expect, test } from "bun:test"

import { builtInAgents, builtInPipelines, resolvePipeline } from "../src/pipeline"
import { logicalModel } from "../src/model-routing"
import { buildRunPlan, plannedStepAdvisor, routePipeline, throughputRoutedModels } from "../src/run-plan"
import { stepRunnerFor } from "../src/step-runners"
import type { AgentStep, RunOptions } from "../src/types"

test("the immutable plan filters and freezes exact routed targets", () => {
  const options: RunOptions = {
    prompt: "ship it",
    prdHistory: true,
    files: [],
    onlySteps: ["build"],
    skipSteps: ["audit"],
    resumeRunID: "",
    keepRunDir: true,
    modelOverride: "anthropic/claude-opus-4.8",
    advisorOverride: "",
    advisorDisabled: false,
    gateway: "vercel",
    tui: false,
    notify: false,
    notifications: {},
    humanReview: false,
    baseRef: "main",
    targetDir: "/repo",
    worktree: false,
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

test("freezes a precomputed PRD history preview onto the reviewed plan", () => {
  const preview = {
    action: "attach" as const,
    branch: "feat/history",
    found: { runID: "old", pipeline: "implement", branch: "feat/history", timestamp: 1, file: "old.prd.md" },
  }
  const plan = buildRunPlan({
    prompt: "review",
    prdHistory: true,
    files: [],
    onlySteps: [],
    skipSteps: [],
    resumeRunID: "",
    keepRunDir: true,
    modelOverride: "",
    advisorOverride: "",
    advisorDisabled: false,
    tui: false,
    notify: false,
    notifications: {},
    humanReview: false,
    baseRef: "main",
    targetDir: "/repo",
    worktree: false,
    includeDirty: false,
    yolo: false,
    smart: false,
    smartJudgeModel: "openai/gpt-5.6-sol",
    pipeline: { name: "review", steps: [] },
    agents: [],
    permissions: { allow: [], deny: [] },
    hooks: { pre: [], post: [], pipelines: {} },
    prdHistoryPreview: preview,
  })
  expect(plan.prdHistory).toEqual(preview)
  expect(Object.isFrozen(plan.prdHistory)).toBe(true)
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

    for (const gateway of ["configured", "direct", "openrouter", "nitro", "vercel"] as const) {
      const routed = routePipeline(original, gateway, {})
      const routedAgents = routed.steps.filter((step): step is AgentStep => step.type === "agent")

      expect(routedAgents.map(shape)).toEqual(originalAgents.map(shape))
      for (const [index, step] of routedAgents.entries()) {
        const originalStep = originalAgents[index]!
        // Non-OpenCode runners (review-cc's claude-code steps) carry a CLI alias
        // like "opus" rather than provider/model, and routing passes them through.
        if (stepRunnerFor(originalStep.runner).id !== "opencode") {
          expect(step.model).toBe(originalStep.model)
          expect(step.resolvedModel).toBeUndefined()
          continue
        }
        const configured = `${originalStep.model}${originalStep.variant ? `#${originalStep.variant}` : ""}`
        const recovered = logicalModel(configured)
        const physicalModel = recovered.model.replace(/^zai\//, "z-ai/").replace(/^xai\//, "x-ai/")
        const variant = recovered.variant ? `#${recovered.variant}` : ""
        const expectedTarget =
          gateway === "configured"
            ? configured
            : gateway === "direct"
              ? `${recovered.model}${variant}`
              : gateway === "openrouter" || gateway === "nitro"
                ? `openrouter/${physicalModel}${variant}`
                : `vercel/${recovered.model}${variant}`

        expect(step.resolvedModel?.gateway).toBe(gateway)
        expect(step.resolvedModel?.target).toBe(expectedTarget)
      }
    }
  }
})

test("the plan routes fan-out and the smart judge while leaving Claude Code untouched", () => {
  const options: RunOptions = {
    prompt: "review the change",
    prdHistory: true,
    files: ["docs/architecture.md"],
    onlySteps: [],
    skipSteps: [],
    resumeRunID: "20260720-135802-5bbh",
    keepRunDir: true,
    modelOverride: "",
    advisorOverride: "",
    advisorDisabled: false,
    gateway: "vercel",
    modelRoutingOverrides: {},
    tui: false,
    notify: false,
    notifications: {},
    humanReview: true,
    baseRef: "main",
    targetDir: "/repo",
    worktree: false,
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
    prdHistory: true,
    files: [],
    onlySteps: [],
    skipSteps: [],
    resumeRunID: "20260720-135802-5bbh",
    keepRunDir: true,
    modelOverride: "",
    advisorOverride: "",
    advisorDisabled: false,
    gateway: "openrouter",
    modelRoutingOverrides: {},
    tui: false,
    notify: false,
    notifications: {},
    humanReview: false,
    baseRef: "main",
    targetDir: "/repo",
    worktree: false,
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

  const overridden = buildRunPlan({
    ...options,
    promptSource: "resume",
    resumeGateway: "vercel",
    worktree: true,
    branch: "feat/runtime-guard-limits",
    worktreeDir: "/home/dev/.convoy/worktrees/feat-runtime-guard-limits",
  })
  expect(overridden.resume).toEqual({ runID: "20260720-135802-5bbh", gatewayOverride: { original: "vercel", pending: "openrouter" } })
  // The branch the user confirmed in the launcher is frozen into the plan.
  expect(overridden.target.branch).toBe("feat/runtime-guard-limits")
  expect(overridden.target.worktreeDir).toBe("/home/dev/.convoy/worktrees/feat-runtime-guard-limits")
  expect(Object.isFrozen(overridden.target)).toBe(true)

  // Resuming with the frozen gateway (or no explicit override) leaves no banner.
  const unchanged = buildRunPlan({ ...options, gateway: "vercel", promptSource: "resume", resumeGateway: "vercel" })
  expect(unchanged.resume).toEqual({ runID: "20260720-135802-5bbh" })
  expect(unchanged.target).not.toHaveProperty("branch")
})

test("resuming an openrouter run with --gateway nitro marks a nitro pending override", () => {
  const options: RunOptions = {
    prompt: "review the change",
    prdHistory: true,
    files: [],
    onlySteps: [],
    skipSteps: [],
    resumeRunID: "20260720-135802-5bbh",
    keepRunDir: true,
    modelOverride: "",
    advisorOverride: "",
    advisorDisabled: false,
    gateway: "nitro",
    modelRoutingOverrides: {},
    tui: false,
    notify: false,
    notifications: {},
    humanReview: false,
    baseRef: "main",
    targetDir: "/repo",
    worktree: false,
    includeDirty: false,
    yolo: false,
    smart: false,
    smartJudgeModel: "openai/gpt-5.6-sol",
    pipeline: { name: "review", steps: [] },
    agents: [],
    permissions: { allow: [], deny: [] },
    hooks: { pre: [], post: [], pipelines: {} },
  }

  const plan = buildRunPlan({ ...options, promptSource: "resume", resumeGateway: "openrouter" })
  expect(plan.resume).toEqual({ runID: "20260720-135802-5bbh", gatewayOverride: { original: "openrouter", pending: "nitro" } })
})

test("nitro routes the smart judge and the goal-fix pipeline through the same gateway", () => {
  const options: RunOptions = {
    prompt: "score and fix",
    prdHistory: true,
    files: [],
    onlySteps: [],
    skipSteps: [],
    resumeRunID: "",
    keepRunDir: true,
    modelOverride: "",
    advisorOverride: "",
    advisorDisabled: false,
    gateway: "nitro",
    modelRoutingOverrides: {},
    tui: false,
    notify: false,
    notifications: {},
    humanReview: false,
    baseRef: "main",
    targetDir: "/repo",
    worktree: false,
    includeDirty: false,
    yolo: false,
    smart: true,
    smartJudgeModel: "anthropic/claude-haiku-4.5",
    pipeline: {
      name: "ship",
      steps: [
        { type: "agent", name: "implementer", stepName: "implementer", groupId: "g1", agentName: "implementer", description: "Implement", model: "openai/gpt-5.6-sol", inputFiles: ["prd.md"], inputDiff: false, reportPath: "reports/implementer.md" },
      ],
      // The terminal goal step's fragments are frozen with the pipeline, so
      // nitro routes their models through the same gateway as the prefix.
      goalPlan: {
        target: 90,
        maxIterations: 2,
        plateau: 3,
        briefRecipient: "fixer",
        improve: {
          steps: [
            { type: "agent", name: "fixer", stepName: "fixer", groupId: "improve-g1", agentName: "goal-fixer", description: "Fix", model: "openai/gpt-5.6-sol", inputFiles: ["prd.md"], inputDiff: true, reportPath: "reports/fixer.md" },
          ],
        },
        measure: { steps: [] },
        scoreProducer: "score-report",
      },
    },
    agents: [],
    permissions: { allow: [], deny: [] },
    hooks: { pre: [], post: [], pipelines: {} },
  }

  const plan = buildRunPlan(options)
  expect(plan.smartJudge?.model).toMatchObject({ gateway: "nitro", target: "openrouter/anthropic/claude-haiku-4.5" })
  const fixer = plan.goal?.improve.steps[0]
  expect(fixer?.type === "agent" && fixer.resolvedModel?.target).toBe("openrouter/openai/gpt-5.6-sol")
})

test("throughputRoutedModels collects the run's OpenRouter models, deduplicated", () => {
  const routed = routePipeline(
    {
      name: "review",
      steps: [
        {
          type: "agent",
          name: "scope",
          stepName: "scope",
          groupId: "g1",
          agentName: "review-scope",
          description: "Scope",
          model: "zai/glm-5.2",
          inputFiles: ["prd.md"],
          inputDiff: false,
          reportPath: "reports/scope.md",
        },
        {
          type: "agent",
          name: "audit",
          stepName: "audit",
          groupId: "g2",
          agentName: "auditor",
          description: "Audit",
          model: "zai/glm-5.2",
          advisor: "anthropic/claude-opus-5",
          inputFiles: ["prd.md"],
          inputDiff: false,
          reportPath: "reports/audit.md",
        },
        {
          type: "agent",
          name: "external",
          stepName: "external",
          groupId: "g3",
          agentName: "external",
          description: "External audit",
          runner: "claude-code",
          model: "opus",
          inputFiles: ["prd.md"],
          inputDiff: false,
          reportPath: "reports/external.md",
          readOnly: true,
        },
      ],
    },
    "nitro",
    {},
  )

  // GLM appears twice (scope + audit) but is collected once; the advisor and
  // the judge are included; claude-code steps and non-OpenRouter judges are not.
  expect(throughputRoutedModels(routed)).toEqual([
    { providerID: "openrouter", modelID: "z-ai/glm-5.2" },
    { providerID: "openrouter", modelID: "anthropic/claude-opus-5" },
  ])
  expect(throughputRoutedModels(routed, { providerID: "openrouter", modelID: "deepseek/deepseek-v4.1-flash" })).toEqual([
    { providerID: "openrouter", modelID: "z-ai/glm-5.2" },
    { providerID: "openrouter", modelID: "anthropic/claude-opus-5" },
    { providerID: "openrouter", modelID: "deepseek/deepseek-v4.1-flash" },
  ])
  expect(throughputRoutedModels(routed, { providerID: "openai", modelID: "gpt-5.6-sol" })).toHaveLength(2)
  expect(throughputRoutedModels({ name: "empty", steps: [] })).toEqual([])
})

describe("advisor routing", () => {
  const step = (extra: Partial<AgentStep> = {}): AgentStep => ({
    type: "agent",
    name: "build",
    stepName: "build",
    groupId: "g1",
    agentName: "implementer",
    description: "Implement",
    model: "openai/gpt-5.6-sol",
    inputFiles: ["prd.md"],
    inputDiff: false,
    reportPath: "reports/build.md",
    ...extra,
  })

  const route = (agentStep: AgentStep, gateway: Parameters<typeof routePipeline>[1] = "configured", advisor: Parameters<typeof routePipeline>[4] = {}) =>
    routePipeline({ name: "p", steps: [agentStep] }, gateway, {}, "", advisor).steps[0] as AgentStep

  test("routes the advisor through the run's gateway, like the executor's model", () => {
    const routed = route(step({ advisor: "anthropic/claude-opus-5", advisorVariant: "high" }), "openrouter")

    expect(routed.resolvedAdvisor).toMatchObject({
      logical: "anthropic/claude-opus-5#high",
      target: "openrouter/anthropic/claude-opus-5#high",
      providerID: "openrouter",
    })
    expect(routed.advisor).toBe("openrouter/anthropic/claude-opus-5")
    expect(routed.advisorVariant).toBe("high")
  })

  test("routes the advisor through nitro exactly like openrouter, without a suffix", () => {
    const routed = route(step({ advisor: "anthropic/claude-opus-5", advisorVariant: "high" }), "nitro")

    expect(routed.resolvedAdvisor).toMatchObject({
      logical: "anthropic/claude-opus-5#high",
      target: "openrouter/anthropic/claude-opus-5#high",
      providerID: "openrouter",
    })
    expect(routed.advisor).toBe("openrouter/anthropic/claude-opus-5")
    expect(routed.advisorVariant).toBe("high")
  })

  test("leaves a step with no advisor alone", () => {
    const routed = route(step())

    expect(routed.advisor).toBeUndefined()
    expect(routed.resolvedAdvisor).toBeUndefined()
  })

  test("--advisor forces one onto every step and --no-advisor strips them all", () => {
    const forced = route(step(), "configured", { advisorOverride: "anthropic/claude-opus-5" })
    expect(forced.resolvedAdvisor?.target).toBe("anthropic/claude-opus-5")

    const stripped = route(step({ advisor: "anthropic/claude-opus-5" }), "configured", { advisorDisabled: true })
    expect(stripped.advisor).toBeUndefined()
    expect(stripped.resolvedAdvisor).toBeUndefined()

    // Disabling wins over an override, so the eval protocol's three configs stay distinct.
    const both = route(step(), "configured", { advisorOverride: "anthropic/claude-opus-5", advisorDisabled: true })
    expect(both.advisor).toBeUndefined()
  })

  test("plannedStepAdvisor shows the routed target, or nothing when the step has no advisor", () => {
    expect(plannedStepAdvisor(route(step({ advisor: "anthropic/claude-opus-5" }), "openrouter"))).toBe("openrouter/anthropic/claude-opus-5")
    expect(plannedStepAdvisor(route(step()))).toBeUndefined()
  })

  test("claude-code steps are never given an advisor by the global override", () => {
    const routed = route(step({ runner: "claude-code", model: "opus", readOnly: true }), "configured", { advisorOverride: "anthropic/claude-opus-5" })

    expect(routed.advisor).toBeUndefined()
  })
})
