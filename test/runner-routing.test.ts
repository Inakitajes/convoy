import { describe, expect, test } from "bun:test"

import { mergeConvoyConfigs, parseConvoyConfig, pipelineDefaultsOf, runnerAuthOf } from "../src/config"
import { helperModel } from "../src/helper-routes"
import { builtInAgents, resolvePipeline } from "../src/pipeline"
import { preflightRunPlan } from "../src/preflight"
import { preflightTargets } from "../src/preflight-validation"
import { buildRunPlan, plannedStepModel, soleCliRunner } from "../src/run-plan"
import { runNeedsOpencodeServer } from "../src/runner"
import { reviewedRunnerRoutes, runnerRouteSummary } from "../src/run-review"
import { codexModelRequirements } from "../src/runners/codex/preflight"
import { normalizeQualifiedModel, qualifiedRunnerOf, runnerDescriptor, runnerIds } from "../src/runners/descriptors"
import { collectPlanDependencies } from "../src/runners/plan-dependencies"
import { isRunnerExecutionRecord, runnerExecutionRecord } from "../src/runners/provenance"
import { normalizeStepRunnerModel, parseModelOverride, qualifiedModelRoute, runnerOfModelReference, stepRunnerFor } from "../src/step-runners"
import type { AgentStep, Pipeline, RunOptions } from "../src/types"

const parse = (yaml: string) => parseConvoyConfig(`version: 1\n${yaml}`, "config.yaml", "/tmp")

function options(pipeline: Pipeline, overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    prompt: "x",
    prdHistory: false,
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
    baseRef: "HEAD",
    targetDir: "/tmp",
    worktree: false,
    includeDirty: false,
    yolo: false,
    smart: false,
    smartJudgeModel: "openai/gpt-5.5",
    pipeline,
    agents: [],
    permissions: { allow: [], deny: [] },
    hooks: { pre: [], post: [], pipelines: {} },
    ...overrides,
  }
}

describe("runner descriptors", () => {
  test("every registered runner is described once", () => {
    expect([...runnerIds]).toEqual(["opencode", "claude-code", "codex"])
    for (const id of runnerIds) expect(runnerDescriptor(id).declaration.runner).toBe(id)
  })

  test("a model keeps one canonical spelling; each CLI runner maps it to its native model", () => {
    expect(normalizeQualifiedModel("codex", "openai/gpt-5.5")).toEqual({ model: "gpt-5.5" })
    expect(normalizeQualifiedModel("codex", "gpt-5.5#high")).toEqual({ model: "gpt-5.5", variant: "high" })
    expect(normalizeQualifiedModel("claude-code", "anthropic/claude-opus-5-5")).toEqual({ model: "claude-opus-5-5" })
    expect(normalizeQualifiedModel("claude-code", "anthropic/opus")).toEqual({ model: "opus" })
    expect(normalizeStepRunnerModel("opencode", "openai/gpt-5.5#xhigh")).toBe("openai/gpt-5.5#xhigh")
  })

  test("a runner refuses another provider's model and an effort it does not know", () => {
    expect(() => normalizeQualifiedModel("codex", "anthropic/claude-opus-5")).toThrow("runner codex executes OpenAI models")
    expect(() => normalizeQualifiedModel("claude-code", "openai/gpt-5.5")).toThrow("runner claude-code executes Anthropic models")
    expect(() => normalizeQualifiedModel("codex", "gpt-5.5#turbo")).toThrow('"#turbo" is not one of minimal, low, medium, high, xhigh')
    expect(() => normalizeStepRunnerModel("codex", "")).toThrow("runner codex needs a model")
  })

  test("a runner-qualified reference names its runner; a provider-qualified one names none", () => {
    expect(qualifiedRunnerOf("codex/gpt-5.5")).toBe("codex")
    expect(qualifiedRunnerOf("claude-code/opus")).toBe("claude-code")
    expect(qualifiedRunnerOf("openai/gpt-5.5")).toBeUndefined()
    // OpenCode Zen's own provider is not a runner scope.
    expect(qualifiedRunnerOf("opencode/big-pickle")).toBeUndefined()
    expect(qualifiedModelRoute("codex/gpt-5.5#low")).toEqual({ runner: "codex", model: "gpt-5.5", variant: "low" })
    expect(runnerOfModelReference({ providerID: "codex" })).toBe("codex")
    expect(runnerOfModelReference("openai/gpt-5.5")).toBe("opencode")
  })

  test("a --model override scopes to a runner by its qualifier", () => {
    expect(parseModelOverride("codex/gpt-5.5")).toEqual({ scope: "codex", model: "gpt-5.5" })
    expect(parseModelOverride("openai/gpt-5.5")).toEqual({ model: "openai/gpt-5.5" })
    expect(stepRunnerFor("codex").modelLabel("gpt-5.5", "high")).toBe("codex/gpt-5.5#high")
  })
})

describe("runner configuration", () => {
  test("runners.<id>.auth configures each CLI runner; the legacy claudeAuth still reads", () => {
    const config = parse(`runners:
  codex:
    auth:
      authMode: api-key
      credentialRef: CONVOY_OPENAI_KEY
defaults:
  claudeAuth:
    billingPolicy: account-policy
`)
    expect(runnerAuthOf(config)).toEqual({
      "claude-code": { mode: "subscription", billingPolicy: "account-policy" },
      codex: { mode: "api-key", credentialRef: "CONVOY_OPENAI_KEY" },
    })
  })

  test("the project wins per runner", () => {
    const global = parse(`runners:\n  codex:\n    auth:\n      billingPolicy: account-policy\n  claude-code:\n    auth:\n      billingPolicy: account-policy\n`)
    const project = parse(`runners:\n  codex:\n    auth:\n      authMode: api-key\n      credentialRef: K\n`)
    expect(runnerAuthOf(mergeConvoyConfigs(global, project))).toEqual({ "claude-code": { mode: "subscription", billingPolicy: "account-policy" }, codex: { mode: "api-key", credentialRef: "K" } })
  })

  test("a project's auth block replaces the global one as a unit: billingPolicy alone selects subscription", () => {
    const global = parse(`runners:\n  codex:\n    auth:\n      authMode: api-key\n      credentialRef: K\n`)
    const project = parse(`runners:\n  codex:\n    auth:\n      billingPolicy: account-policy\n`)
    expect(runnerAuthOf(mergeConvoyConfigs(global, project))).toEqual({ codex: { mode: "subscription", billingPolicy: "account-policy" } })
  })

  test("an unknown runner, OpenCode auth, a secret-shaped reference and Codex authoring are refused", () => {
    expect(() => parse(`runners:\n  gemini: {}\n`)).toThrow('runners.gemini is not a runner; expected "opencode", "claude-code", or "codex"')
    expect(() => parse(`runners:\n  opencode:\n    auth:\n      authMode: subscription\n`)).toThrow("opencode authenticates through its own provider configuration")
    expect(() => parse(`runners:\n  codex:\n    auth:\n      authMode: api-key\n      credentialRef: sk-live-abc\n`)).toThrow("must name an environment variable")
    expect(() => parse(`defaults:\n  authoring:\n    runner: codex\n`)).toThrow("codex cannot host authoring conversations")
  })

  test("a route that selects api-key reuses its own runner's credential reference", () => {
    expect(() => parse(`defaults:\n  advisorRoute:\n    runner: codex\n    authMode: api-key\n`)).toThrow("api-key needs runners.codex.auth.credentialRef")
    expect(() => parse(`runners:\n  codex:\n    auth:\n      authMode: api-key\n      credentialRef: K\ndefaults:\n  advisorRoute:\n    runner: codex\n    authMode: api-key\n`)).not.toThrow()
  })

  test("a { runner, model } route keeps the model's own spelling and is stored runner-qualified", () => {
    const config = parse(`defaults:
  advisor: { runner: codex, model: openai/gpt-5.5#high }
  autoAcceptJudgeModel: { runner: claude-code, model: anthropic/haiku }
pipelines:
  p:
    steps:
      - agent: implementer
        runner: codex
        model: openai/gpt-5.5
        advisor: { runner: opencode, model: openai/gpt-5.5 }
      - agent: bug-auditor
        models:
          - openai/gpt-5.5
          - { runner: codex, model: openai/gpt-5.5 }
          - { runner: claude-code, model: anthropic/sonnet }
          - { runner: opencode, model: openai/gpt-5.5 }
`)
    expect(config.defaults.advisor).toBe("codex/gpt-5.5#high")
    expect(config.defaults.autoAcceptJudgeModel).toBe("claude-code/haiku")
    const steps = config.pipelines.p!.steps as { model?: string; models?: string[]; advisor?: string }[]
    expect(steps[0]).toMatchObject({ model: "gpt-5.5", advisor: "openai/gpt-5.5" })
    // A fan-out entry keeps its runner explicitly, OpenCode's included.
    expect(steps[1]!.models).toEqual(["openai/gpt-5.5", "codex/gpt-5.5", "claude-code/sonnet", "opencode/openai/gpt-5.5"])
  })

  test("a step's model: { runner, model } route is the step's runner and model", () => {
    const config = parse(`pipelines:
  p:
    steps:
      - agent: implementer
        model: { runner: codex, model: openai/gpt-5.5#high }
      - agent: bug-auditor
        runner: claude-code
        model: { runner: claude-code, model: anthropic/sonnet }
`)
    const steps = config.pipelines.p!.steps as { runner?: string; model?: string }[]
    expect(steps[0]).toMatchObject({ runner: "codex", model: "gpt-5.5#high" })
    expect(steps[1]).toMatchObject({ runner: "claude-code", model: "sonnet" })
    const pipeline = resolvePipeline({ name: "p", spec: config.pipelines.p!, agents: builtInAgents })
    expect(pipeline.steps[0]).toMatchObject({ runner: "codex", model: "gpt-5.5", variant: "high" })
    // A route that disagrees with the step's own runner is refused, not guessed.
    expect(() => parse(`pipelines:\n  p:\n    steps:\n      - agent: implementer\n        runner: opencode\n        model: { runner: codex, model: openai/gpt-5.5 }\n`)).toThrow("runner: opencode")
  })

  test("a route's model must be one its runner executes", () => {
    expect(() => parse(`defaults:\n  advisor: { runner: codex, model: anthropic/opus }\n`)).toThrow("defaults.advisor.model runner codex executes OpenAI models")
    expect(() => parse(`pipelines:\n  p:\n    steps:\n      - agent: implementer\n        runner: codex\n        model: anthropic/opus\n`)).toThrow("runner codex executes OpenAI models")
  })
})

describe("pipeline resolution on Codex", () => {
  test("defaults.runner and defaults.model apply with one model spelling", () => {
    const config = parse(`defaults:\n  runner: codex\n  model: openai/gpt-5.5#high\n`)
    const pipeline = resolvePipeline({ name: "p", spec: { steps: [{ agent: "implementer" }, { agent: "bug-auditor", runner: "opencode" }] }, agents: builtInAgents, ...pipelineDefaultsOf(config.defaults) })
    const [codex, opencode] = pipeline.steps as AgentStep[]
    expect(codex).toMatchObject({ runner: "codex", model: "gpt-5.5", variant: "high" })
    // The same model, unchanged, on OpenCode.
    expect(opencode).toMatchObject({ model: "openai/gpt-5.5", variant: "high" })
    expect(opencode!.runner).toBeUndefined()
  })

  test("an inherited model another runner chose is skipped rather than guessed", () => {
    const pipeline = resolvePipeline({ name: "p", spec: { steps: [{ agent: "implementer", runner: "codex" }] }, agents: builtInAgents, defaultModel: "anthropic/claude-opus-5" })
    expect(pipeline.steps[0]).toMatchObject({ runner: "codex", model: "" })
  })

  test("a models: fan-out can mix runners, and phase names stay unique", () => {
    const pipeline = resolvePipeline({
      name: "p",
      spec: { steps: [{ agent: "bug-auditor", runner: "codex", models: ["openai/gpt-5.5", "opencode/openai/gpt-5.5", "claude-code/sonnet"] }] },
      agents: builtInAgents,
    })
    const steps = pipeline.steps as AgentStep[]
    expect(steps.map((step) => [step.name, step.runner, step.model])).toEqual([
      ["bug-auditor__gpt-5-5", "codex", "gpt-5.5"],
      ["bug-auditor__opencode-openai-gpt-5-5", undefined, "openai/gpt-5.5"],
      ["bug-auditor__claude-code-sonnet", "claude-code", "sonnet"],
    ])
  })

  test("an inherited Codex runner refuses another provider's model, naming where the runner came from", () => {
    expect(() => resolvePipeline({ name: "p", spec: { steps: [{ agent: "implementer", model: "anthropic/claude-opus-5" }] }, agents: builtInAgents, defaultRunner: "codex" })).toThrow(
      /runs on codex through defaults.runner but names the model "anthropic\/claude-opus-5", which codex does not execute/,
    )
  })
})

describe("plans on Codex", () => {
  const codexOnly = (): Pipeline =>
    resolvePipeline({ name: "codex", spec: { steps: [{ agent: "implementer", runner: "codex", model: "openai/gpt-5.5#high", advisor: "codex/gpt-6.1-sol" }] }, agents: builtInAgents })

  test("a Codex-only plan needs no OpenCode, and its judge and helpers inherit Codex", () => {
    const pipeline = codexOnly()
    expect(soleCliRunner(pipeline)).toBe("codex")
    expect(runNeedsOpencodeServer(pipeline, { providerID: "codex" })).toBe(false)
    expect(helperModel("commitMessage", {}, "openai/gpt-5.5", "codex")).toBe("codex/default#low")
    const plan = buildRunPlan(options(pipeline, { smart: true, smartJudgeModel: "codex/default#low", commitMessageModel: "codex/default#low" }))
    expect(plan.smartJudge).toMatchObject({ runner: "codex", model: { providerID: "codex", modelID: "default", variant: "low" } })
    expect(preflightTargets(plan)).toEqual([])
    expect(collectPlanDependencies(plan.pipeline, { judge: "codex", helpers: [{ role: "commit-message", runner: "codex" }] }).map((dependency) => dependency.runner)).toEqual(["codex", "codex", "codex", "codex"])
  })

  test("each CLI runner a plan uses gets its own reviewed route", () => {
    const pipeline = resolvePipeline({
      name: "mixed",
      spec: { steps: [{ agent: "implementer", runner: "codex", model: "gpt-5.5", advisor: "claude-code/opus" }, { agent: "bug-auditor" }] },
      agents: builtInAgents,
    })
    const plan = buildRunPlan(options(pipeline, { runnerAuth: { codex: { mode: "api-key", credentialRef: "CONVOY_OPENAI_KEY" } } }))
    expect(Object.keys(plan.runnerAuth ?? {})).toEqual(["claude-code", "codex"])
    expect(reviewedRunnerRoutes(plan).map(([runner, reviewed]) => `${runner}: ${runnerRouteSummary(reviewed)}`)).toEqual([
      "claude-code: subscription · account policy — usage credits or paid features may apply",
      "codex: api-key (CONVOY_OPENAI_KEY) · billed to the API account",
    ])
    expect(plannedStepModel(plan.pipeline.steps[0] as AgentStep)).toBe("codex/gpt-5.5 · auth api-key")
  })

  test("a runner-scoped --model reaches only that runner's steps", () => {
    const pipeline = resolvePipeline({ name: "p", spec: { steps: [{ agent: "implementer", runner: "codex", model: "gpt-5.5" }, { agent: "bug-auditor" }] }, agents: builtInAgents })
    const plan = buildRunPlan(options(pipeline, { modelOverride: "codex/gpt-6.1-sol#xhigh" }))
    const [codex, opencode] = plan.pipeline.steps as AgentStep[]
    expect(codex).toMatchObject({ model: "gpt-6.1-sol", variant: "xhigh" })
    expect(opencode!.model).not.toBe("gpt-6.1-sol")
  })

  test("preflight checks every Codex model the plan names, and the billing decision", async () => {
    const plan = buildRunPlan(options(codexOnly(), { smart: true, smartJudgeModel: "codex/gpt-5.5#low" }))
    expect(codexModelRequirements(plan)).toEqual([
      { model: "gpt-5.5", effort: "high", label: "step implementer" },
      { model: "gpt-6.1-sol", label: "step implementer's advisor" },
      { model: "gpt-5.5", effort: "low", label: "the smart judge" },
    ])
    const seen: unknown[] = []
    const ready = { available: () => true, codexPreflight: async (input: unknown) => (seen.push(input), undefined) }
    await expect(preflightRunPlan(plan, undefined, ready)).rejects.toThrow("Codex billing: an unattended launch must state its billing decision")
    await expect(preflightRunPlan(plan, undefined, { ...ready, reviewed: true })).resolves.toBeUndefined()
    expect(seen).toHaveLength(1)
    await expect(preflightRunPlan(plan, undefined, { ...ready, reviewed: true, codexPreflight: async () => 'step a names the Codex model "gpt-9"' })).rejects.toThrow("Set runners.codex.auth")
    await expect(preflightRunPlan(plan, undefined, { reviewed: true, available: (runner) => runner !== "codex" })).rejects.toThrow("implementer (codex)")
  })

  test("a Codex attempt's provenance is recorded and read back", () => {
    const record = runnerExecutionRecord({ runner: "codex", auth: { mode: "subscription" }, checkout: "/repo", model: { modelId: "gpt-5.5" }, sessionId: "thread-1", attempt: { runId: "r", phase: "p", attempt: 1 } })
    expect(isRunnerExecutionRecord(record)).toBe(true)
  })
})
