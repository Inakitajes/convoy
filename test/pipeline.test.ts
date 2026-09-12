import { describe, expect, test } from "bun:test"

import {
  builtInAgents,
  builtInPipelines,
  defaultAdversarialModel,
  defaultImplementAuditModel,
  defaultImplementerModel,
  defaultImplementReviewModel,
  defaultOpusModel,
  defaultPipeline,
  defaultPipelineName,
  defaultDeliverableContract,
  deliverableContractForPhase,
  qualityScoreDeliverableContract,
  resolvePipeline,
  slugifyModel,
  splitModelVariant,
  stepNames,
  synthesizeReadOnlyAgents,
  synthesizeVerifyingAgents,
  agentsForPipeline,
  validateStepFilters,
  verifyAgentSuffix,
  type AgentStepSpec,
  type GoalImproveSpec,
  type GoalMeasureSpec,
  type GoalStepSpec,
  type PipelineSpec,
} from "../src/pipeline"
import type { AgentStep, DeliverableContract } from "../src/types"

const resolve = (spec: PipelineSpec, defaultModel?: string) =>
  resolvePipeline({ name: "test", spec, agents: builtInAgents, defaultModel })

const agentSteps = (spec: PipelineSpec) => resolve(spec).steps.filter((step): step is AgentStep => step.type === "agent")

/** Resolves the built-in `implement` pipeline explicitly, since it is no longer the default. */
const implement = () => resolvePipeline({ name: "implement", spec: builtInPipelines.implement!, agents: builtInAgents })

describe("model shorthand", () => {
  test("splits provider/model#variant", () => {
    expect(splitModelVariant("openai/gpt-5.5#xhigh")).toEqual({ model: "openai/gpt-5.5", variant: "xhigh" })
    expect(splitModelVariant("anthropic/claude-opus-4-7")).toEqual({ model: "anthropic/claude-opus-4-7" })
    expect(() => splitModelVariant("openai/gpt-5.5#")).toThrow("invalid model")
    expect(() => splitModelVariant("#xhigh")).toThrow("invalid model")
  })
})

describe("built-in implement pipeline", () => {
  test("matches the historical six phases plus the closing run recap", () => {
    const pipeline = implement()

    expect(stepNames(pipeline)).toEqual(["implementer", "patterns", "security", "design", "tests", "adversarial", "run-report"])
    expect(pipeline.steps.some((step) => step.type === "human")).toBe(false)
  })

  test("wires inputs by convention exactly like the static pipeline did", () => {
    const steps = Object.fromEntries(
      implement()
        .steps.filter((step): step is AgentStep => step.type === "agent")
        .map((step) => [step.name, step]),
    )

    expect(steps.implementer?.inputFiles).toEqual(["prd.md"])
    expect(steps.implementer?.inputDiff).toBe(false)
    expect(steps.patterns?.inputFiles).toEqual(["prd.md", "reports/implementer.md"])
    expect(steps.patterns?.inputDiff).toBe(true)
    expect(steps.security?.inputFiles).toEqual(["prd.md", "reports/patterns.md"])
    expect(steps.design?.inputFiles).toEqual(["prd.md", "reports/security.md"])
    expect(steps.tests?.inputFiles).toEqual(["prd.md"])
    expect(steps.tests?.inputDiff).toBe(true)
    expect(steps.adversarial?.inputFiles).toEqual([
      "prd.md",
      "reports/implementer.md",
      "reports/patterns.md",
      "reports/security.md",
      "reports/design.md",
      "reports/tests.md",
    ])
  })

  test("pins Terra xhigh for implementation, GLM 5.3 high for the audits, and Grok 4.6 high for design and adversarial", () => {
    const byName = Object.fromEntries(
      implement()
        .steps.filter((step): step is AgentStep => step.type === "agent")
        .map((step) => [step.name, step]),
    )

    expect(byName.implementer).toMatchObject({ model: "openai/gpt-5.6-terra", variant: "xhigh" })
    expect(byName.patterns).toMatchObject({ model: "openrouter/z-ai/glm-5.3", variant: "high" })
    expect(byName.security).toMatchObject({ model: "openrouter/z-ai/glm-5.3", variant: "high" })
    expect(byName.design).toMatchObject({ model: "openrouter/x-ai/grok-4.6", variant: "high" })
    expect(byName.tests).toMatchObject({ model: "openrouter/z-ai/glm-5.3", variant: "high" })
    expect(byName.adversarial).toMatchObject({ model: "openrouter/x-ai/grok-4.6", variant: "high" })
  })

  test("advises the implementation phase only: Sol xhigh at Terra's decision points", () => {
    const byName = Object.fromEntries(
      implement()
        .steps.filter((step): step is AgentStep => step.type === "agent")
        .map((step) => [step.name, step]),
    )

    expect(byName.implementer).toMatchObject({ advisor: "openai/gpt-5.6-sol", advisorVariant: "xhigh" })
    for (const name of ["patterns", "security", "design", "tests", "adversarial"]) {
      expect(byName[name]?.advisor).toBeUndefined()
    }
    // Exactly one step carries the advisor cost.
    expect(implement().steps.filter((step) => step.type === "agent" && step.advisor).length).toBe(1)
  })

  test("the audits opt out of the advisor explicitly, so defaults.advisor cannot re-advise them", () => {
    // `advisor: false` and an omitted key resolve identically until a project
    // sets defaults.advisor — which is exactly the case this pins down.
    const byName = Object.fromEntries(
      resolvePipeline({
        name: "implement",
        spec: builtInPipelines.implement!,
        agents: builtInAgents,
        defaultAdvisor: "openrouter/anthropic/claude-opus-5",
      })
        .steps.filter((step): step is AgentStep => step.type === "agent")
        .map((step) => [step.name, step]),
    )

    expect(byName.implementer).toMatchObject({ advisor: "openai/gpt-5.6-sol", advisorVariant: "xhigh" })
    for (const name of ["patterns", "security", "design", "tests", "adversarial"]) {
      expect(byName[name]?.advisor).toBeUndefined()
    }
  })

  test("does not score: measurement belongs to ship, not to the first draft", () => {
    expect(stepNames(implement())).not.toContain("score-report")
  })

  test("closes with the read-only run recap: every report, no diff, cheapest model", () => {
    const steps = implement()
      .steps.filter((step): step is AgentStep => step.type === "agent")
      .map((step) => [step.name, step] as const)
    const byName = Object.fromEntries(steps)

    const recap = byName["run-report"]
    expect(recap).toMatchObject({
      agentName: "run-reporter",
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      variant: "high",
      readOnly: true,
      inputDiff: false,
      reportPath: "reports/run-report.md",
    })
    expect(recap?.advisor).toBeUndefined()
    // The recap indexes every phase report — the adversarial verdict included.
    expect(recap?.inputFiles).toEqual([
      "prd.md",
      "reports/implementer.md",
      "reports/patterns.md",
      "reports/security.md",
      "reports/design.md",
      "reports/tests.md",
      "reports/adversarial.md",
    ])
  })

  test("keeps every implement step on its own model even when defaults.model is GPT", () => {
    const byName = Object.fromEntries(
      resolvePipeline({
        name: "implement",
        spec: builtInPipelines.implement!,
        agents: builtInAgents,
        defaultModel: "openai/gpt-5.5#xhigh",
      })
        .steps.filter((step): step is AgentStep => step.type === "agent")
        .map((step) => [step.name, step]),
    )

    // Every step is pinned now, so defaults.model moves nothing here at all.
    const pinned = (value: string) => {
      const [model, variant] = value.split("#")
      return variant ? { model, variant } : { model }
    }
    expect(byName.implementer).toMatchObject(pinned(defaultImplementerModel))
    expect(byName.patterns).toMatchObject(pinned(defaultImplementAuditModel))
    expect(byName.design).toMatchObject(pinned(defaultImplementReviewModel))
    expect(byName.adversarial).toMatchObject(pinned(defaultAdversarialModel))
  })
})

describe("default pipeline", () => {
  test("is the terminal goal pipeline full-cycle, not the plain implement", () => {
    expect(defaultPipelineName).toBe("full-cycle")
    const pipeline = defaultPipeline()
    expect(pipeline.name).toBe("full-cycle")
    expect(pipeline.goalPlan).toBeDefined()
    expect(pipeline.goalPlan?.target).toBe(90)
    expect(pipeline.goalPlan?.maxIterations).toBe(3)
    expect(pipeline.goalPlan?.plateau).toBe(3)
    expect(pipeline.goalPlan?.briefRecipient).toBe("fix")
    expect(pipeline.goalPlan?.scoreProducer).toBe("score-report")
  })

  test("starts with the writing phases and closes with the goal step, with no run recap", () => {
    const pipeline = defaultPipeline()
    expect(pipeline.steps.filter((step): step is AgentStep => step.type === "agent").map((step) => step.stepName)).toEqual([
      "implementer",
      "patterns",
      "security",
      "design",
      "tests",
    ])
    expect(pipeline.goalPlan).toBeDefined()
    expect(pipeline.steps.some((step) => step.type === "agent" && step.stepName === "run-report")).toBe(false)
  })

  test("advises the implementer with Grok 4.6, leaves design unadvised, and advises the fixer with Grok 4.6", () => {
    const prefix = Object.fromEntries(
      defaultPipeline()
        .steps.filter((step): step is AgentStep => step.type === "agent")
        .map((step) => [step.name, step]),
    )
    expect(prefix.implementer).toMatchObject({ advisor: "openrouter/x-ai/grok-4.6", advisorVariant: "high" })
    expect(prefix.design?.advisor).toBeUndefined()
    const [fix] = defaultPipeline().goalPlan!.improve.steps
    expect(fix).toMatchObject({ advisor: "openrouter/x-ai/grok-4.6", advisorVariant: "high" })
  })

  test("runs the whole cycle on cheap models with DeepSeek V4 Flash on the audits and fixer", () => {
    const prefix = Object.fromEntries(
      defaultPipeline()
        .steps.filter((step): step is AgentStep => step.type === "agent")
        .map((step) => [step.name, step]),
    )
    expect(prefix.implementer).toMatchObject({ model: "openrouter/z-ai/glm-5.3-flash", variant: "high" })
    expect(prefix.patterns).toMatchObject({ model: "openrouter/deepseek/deepseek-v4-flash-0731", variant: "high" })
    const [fix] = defaultPipeline().goalPlan!.improve.steps
    expect(fix).toMatchObject({ model: "openrouter/deepseek/deepseek-v4-flash-0731", variant: "high" })
  })
})

describe("built-in implement-lite pipeline", () => {
  const implementLite = (defaultModel?: string) =>
    resolvePipeline({ name: "implement-lite", spec: builtInPipelines["implement-lite"]!, agents: builtInAgents, defaultModel })

  test("keeps the implement workflow and agents while writing on GLM 5.3 Flash and auditing on DeepSeek V4 Flash advised by GLM 5.3", () => {
    const lite = implementLite().steps.filter((step): step is AgentStep => step.type === "agent")
    const standard = implement().steps.filter((step): step is AgentStep => step.type === "agent")

    const workflowShape = (step: AgentStep) => ({
      name: step.name,
      stepName: step.stepName,
      agentName: step.agentName,
      inputFiles: step.inputFiles,
      inputDiff: step.inputDiff,
      reportPath: step.reportPath,
    })
    expect(lite.map(workflowShape)).toEqual(standard.map(workflowShape))

    const byName = Object.fromEntries(lite.map((step) => [step.name, step]))
    expect(byName.implementer?.model).toBe("openrouter/z-ai/glm-5.3-flash")
    expect(byName.implementer?.variant).toBe("high")
    expect(byName.patterns?.model).toBe("openrouter/deepseek/deepseek-v4-flash-0731")
    expect(byName.security?.model).toBe("openrouter/deepseek/deepseek-v4-flash-0731")
    expect(byName.tests?.model).toBe("openrouter/deepseek/deepseek-v4-flash-0731")
    expect(byName.design?.model).toBe("openrouter/x-ai/grok-4.6")
    expect(byName.adversarial?.model).toBe("openrouter/z-ai/glm-5.3")
  })

  test("does not reintroduce GPT through defaults.model", () => {
    const byName = Object.fromEntries(
      implementLite("openai/gpt-5.5#xhigh")
        .steps.filter((step): step is AgentStep => step.type === "agent")
        .map((step) => [step.name, step]),
    )

    expect(byName.implementer).toMatchObject({ model: "openrouter/z-ai/glm-5.3-flash", variant: "high" })
    expect(byName.patterns).toMatchObject({ model: "openrouter/deepseek/deepseek-v4-flash-0731", variant: "high" })
    expect(byName.security).toMatchObject({ model: "openrouter/deepseek/deepseek-v4-flash-0731", variant: "high" })
    expect(byName.tests).toMatchObject({ model: "openrouter/deepseek/deepseek-v4-flash-0731", variant: "high" })
    expect(byName.design).toMatchObject({ model: "openrouter/x-ai/grok-4.6", variant: "high" })
    expect(byName.adversarial).toMatchObject({ model: "openrouter/z-ai/glm-5.3", variant: "high" })
  })

  test("distinguishes itself from implement by the phases that write, audit, and judge", () => {
    const lite = Object.fromEntries(implementLite().steps.filter((s): s is AgentStep => s.type === "agent").map((step) => [step.name, step]))
    const standard = Object.fromEntries(implement().steps.filter((s): s is AgentStep => s.type === "agent").map((step) => [step.name, step]))

    // Lite writes on GLM 5.3 Flash and audits on DeepSeek advised by GLM 5.3 high;
    // implement writes on Terra and audits unadvised on GLM 5.3 high.
    expect(lite.implementer?.model).not.toBe(standard.implementer?.model)
    expect(lite.patterns?.model).not.toBe(standard.patterns?.model)
    expect(lite.patterns?.advisor).toBe("openrouter/z-ai/glm-5.3")
    expect(standard.patterns?.advisor).toBeUndefined()
    expect(lite.adversarial?.model).not.toBe(standard.adversarial?.model)
    // The run recap is the same cheap model on both.
    expect(lite["run-report"]?.model).toBe(standard["run-report"]?.model)
  })

  test("closes with the same read-only run recap as implement", () => {
    const lite = implementLite().steps.filter((step): step is AgentStep => step.type === "agent")
    const standard = implement().steps.filter((step): step is AgentStep => step.type === "agent")
    const liteRecap = lite.find((step) => step.stepName === "run-report")
    const standardRecap = standard.find((step) => step.stepName === "run-report")

    expect(liteRecap).toMatchObject({
      agentName: "run-reporter",
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      variant: "high",
      readOnly: true,
      inputDiff: false,
      reportPath: "reports/run-report.md",
    })
    // Identical wiring on both variants: the recap is cheap on purpose, so the
    // low-cost pipeline has no reason to drop it.
    expect(liteRecap?.inputFiles).toEqual(standardRecap?.inputFiles)
    expect(liteRecap?.advisor).toBeUndefined()
  })
})


describe("built-in ship pipeline", () => {
  const ship = () => resolvePipeline({ name: "ship", spec: builtInPipelines.ship!, agents: builtInAgents })

  test("carries a defaultPrompt and suggestions so `convoy -p ship` works without typing one", () => {
    expect(ship().defaultPrompt).toBe("Sync this branch with its base, review and fix it to the quality bar, then open the pull request.")
    expect(ship().suggestedPrompts?.length).toBeGreaterThan(0)
  })
  const shipSteps = () => ship().steps.filter((step): step is AgentStep => step.type === "agent")

  test("the prefix is sync → report-only review → triage/fix → recap; measurement lives in the goal step", () => {
    expect(shipSteps().map((step) => step.stepName)).toEqual([
      "sync",
      "scope",
      "clean-code",
      "clean-code",
      "security",
      "security",
      "bugs",
      "bugs",
      "report",
      "triage",
      "fixes",
      "run-report",
    ])
  })

  test("syncs the base in before anything reads the diff, so the review describes the merged result", () => {
    const [sync] = shipSteps()

    expect(sync).toMatchObject({ agentName: "sync-with-base", model: "openrouter/deepseek/deepseek-v4-flash-0731", variant: "high" })
    // The merge writes to the repository: goal mode refuses a report-only
    // pipeline, so this step is also what makes ship goal-eligible.
    expect(sync?.readOnly).toBeFalsy()
  })

  test("scopes and audits across two cheap OpenRouter models before any fix", () => {
    const byName = Object.fromEntries(shipSteps().map((step) => [step.name, step]))
    expect(byName.scope).toMatchObject({ agentName: "review-scope", readOnly: true, verify: true })
    for (const base of ["clean-code", "security", "bugs"] as const) {
      const fan = shipSteps().filter((step) => step.stepName === base)
      expect(fan).toHaveLength(2)
      expect(fan.map((step) => step.model)).toEqual([
        "openrouter/deepseek/deepseek-v4-flash-0731",
        "openrouter/z-ai/glm-5.3-flash",
      ])
      expect(fan.every((step) => step.readOnly)).toBe(true)
    }
    expect(byName.report).toMatchObject({ agentName: "review-report", readOnly: true })
  })

  test("triages adversarially, lets only the fixer write in the prefix, and recaps the run", () => {
    const byName = Object.fromEntries(shipSteps().map((step) => [step.name, step]))

    expect(byName.triage).toMatchObject({ agentName: "review-adversary", model: "openrouter/z-ai/glm-5.3", variant: "high", readOnly: true })
    expect(byName.fixes).toMatchObject({
      agentName: "review-fixer",
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      variant: "high",
      advisor: "openai/gpt-6-astra",
      advisorVariant: "xhigh",
    })
    expect(byName.fixes?.readOnly).toBeFalsy()
    expect(byName.fixes?.inputFiles).toContain("reports/triage.md")
    expect(byName["run-report"]).toMatchObject({ agentName: "run-reporter", readOnly: true, inputDiff: false })
  })

  test("declares its own goal, so the improve/re-score loop runs without any flag", () => {
    const goal = ship().goalPlan
    expect(goal?.target).toBe(90)
    expect(goal?.maxIterations).toBe(5)
    expect(goal?.plateau).toBe(3)
    expect(goal?.briefRecipient).toBe("fix")
    expect(goal?.scoreProducer).toBe("score-report")
  })

  test("the improve fragment is the directed fixer: writable, diff attached, PRD attached", () => {
    const goal = ship().goalPlan!
    const [fix] = goal.improve.steps

    expect(goal.improve.steps.map((step) => step.name)).toEqual(["fix"])
    expect(fix).toMatchObject({ agentName: "goal-fixer", model: "openrouter/deepseek/deepseek-v4-flash-0731", variant: "high", inputDiff: true, prdHistory: true })
    expect(fix?.advisor).toBe("openai/gpt-6-astra")
    expect(fix?.readOnly).toBeFalsy()
  })

  test("fans the scorers across Grok 4.6 high + GLM 5.3 high as forced read-only", () => {
    const goal = ship().goalPlan!
    const scorers = goal.measure.steps.filter((step) => step.stepName === "score")

    expect(scorers).toHaveLength(2)
    expect(scorers.map((step) => ({ model: step.model, variant: step.variant }))).toEqual([
      { model: "openrouter/x-ai/grok-4.6", variant: "high" },
      { model: "openrouter/z-ai/glm-5.3", variant: "high" },
    ])
    // Fanned out across models: already read-only, so no __ro and no bash.
    for (const step of scorers) {
      expect(step.agentName).toBe("quality-scorer")
      expect(step.readOnly).toBe(true)
      expect(step.verify).toBeUndefined()
      // The fixer's report restates the previous score, so the re-scorers stay
      // blind to it: they grade the current artifact with the PRD and the diff,
      // never a report from the round before.
      expect(step.inputDiff).toBe(true)
      expect(step.inputFiles).toEqual(["prd.md"])
    }
  })

  test("consensus step keeps bash to verify the scorers' claims and reads every scorer report", () => {
    const goal = ship().goalPlan!
    const report = goal.measure.steps.find((step) => step.name === "score-report")

    expect(report).toMatchObject({
      agentName: "quality-score-report",
      model: "openrouter/z-ai/glm-5.3",
      variant: "high",
      readOnly: true,
      verify: true,
    })
    expect(report?.inputFiles).toEqual([
      "prd.md",
      "reports/score__openrouter-x-ai-grok-4-6-high.md",
      "reports/score__openrouter-z-ai-glm-5-3-high.md",
    ])
  })

  test("runs on OpenRouter only: no machine-local provider alias in the built-in", () => {
    expect(JSON.stringify(builtInPipelines.ship)).not.toContain("nan/")
  })
})

describe("built-in review pipeline", () => {
  const scored = () => resolvePipeline({ name: "review", spec: builtInPipelines.review!, agents: builtInAgents })

  test("carries a non-empty defaultPrompt and suggestedPrompts for zero-friction review runs", () => {
    const pipeline = scored()
    expect(pipeline.defaultPrompt).toBe(
      "Review the current branch against its base and report prioritized findings with a verified quality score.",
    )
    expect(pipeline.suggestedPrompts).toEqual(["Review the open PR for this branch", "Review only the last commit's diff"])
  })

  test("is report-only: every step is read-only and there is no human gate", () => {
    const pipeline = scored()
    const agents = pipeline.steps.filter((step): step is AgentStep => step.type === "agent")
    expect(agents.length).toBeGreaterThan(0)
    expect(agents.every((step) => step.readOnly)).toBe(true)
    expect(pipeline.steps.some((step) => step.type === "human")).toBe(false)
  })

  test("scope verifies: review-scope is a standalone read-only step with bash, so it runs the checks once", () => {
    const pipeline = scored()
    const scope = pipeline.steps.find((step): step is AgentStep => step.type === "agent" && step.name === "scope")

    expect(scope).toMatchObject({
      agentName: "review-scope",
      readOnly: true,
      verify: true,
      prdHistory: true,
    })
    // Not fanned out, so it keeps its own name (no __ro suffix).
    expect(scope?.agentName.endsWith("__ro")).toBe(false)
  })

  test("scopes, runs the three audits fanned across two models, synthesizes a findings report, then scores", () => {
    expect(stepNames(scored())).toEqual([
      "scope",
      "clean-code__openai-gpt-5-6-terra-xhigh",
      "clean-code__openrouter-x-ai-grok-4-6-high",
      "security__openai-gpt-5-6-terra-xhigh",
      "security__openrouter-x-ai-grok-4-6-high",
      "bugs__openai-gpt-5-6-terra-xhigh",
      "bugs__openrouter-x-ai-grok-4-6-high",
      "report",
      "score__openai-gpt-5-6-sol-xhigh",
      "score__openrouter-x-ai-grok-4-6-high",
      "score-report",
    ])
  })

  test("the findings report synthesizes every audit and the consensus step reads it alongside the scores", () => {
    const findings = scored().steps.find((step): step is AgentStep => step.type === "agent" && step.name === "report")
    expect(findings).toMatchObject({ agentName: "review-report", readOnly: true })
    expect(findings?.inputFiles).toEqual([
      "prd.md",
      "reports/scope.md",
      "reports/clean-code__openai-gpt-5-6-terra-xhigh.md",
      "reports/clean-code__openrouter-x-ai-grok-4-6-high.md",
      "reports/security__openai-gpt-5-6-terra-xhigh.md",
      "reports/security__openrouter-x-ai-grok-4-6-high.md",
      "reports/bugs__openai-gpt-5-6-terra-xhigh.md",
      "reports/bugs__openrouter-x-ai-grok-4-6-high.md",
    ])

    const report = scored().steps.find((step): step is AgentStep => step.type === "agent" && step.name === "score-report")

    expect(report).toMatchObject({ agentName: "quality-score-report", readOnly: true, verify: true })
    expect(report?.inputFiles).toEqual([
      "prd.md",
      "reports/scope.md",
      "reports/clean-code__openai-gpt-5-6-terra-xhigh.md",
      "reports/clean-code__openrouter-x-ai-grok-4-6-high.md",
      "reports/security__openai-gpt-5-6-terra-xhigh.md",
      "reports/security__openrouter-x-ai-grok-4-6-high.md",
      "reports/bugs__openai-gpt-5-6-terra-xhigh.md",
      "reports/bugs__openrouter-x-ai-grok-4-6-high.md",
      "reports/report.md",
      "reports/score__openai-gpt-5-6-sol-xhigh.md",
      "reports/score__openrouter-x-ai-grok-4-6-high.md",
    ])
  })
})

describe("PRD history pipeline plumbing", () => {
  test("marks the built-in scored pipelines for historical PRD attachment on their scoring steps", () => {
    // Review-style pipelines attach the PRD on the scope step AND on every
    // scoring step (the fan-out scorers and the consensus), because the
    // rubric's `prd` dimension (30% of the score) can only be graded against
    // the original PRD.
    for (const name of ["review", "review-lite"] as const) {
      const steps = resolvePipeline({ name, spec: builtInPipelines[name]!, agents: builtInAgents }).steps
      const scope = steps.find((step): step is AgentStep => step.type === "agent" && step.name === "scope")
      const scorers = steps.filter((step): step is AgentStep => step.type === "agent" && step.name === "score")
      const consensus = steps.find((step): step is AgentStep => step.type === "agent" && step.name === "score-report")
      expect(scope?.prdHistory).toBe(true)
      expect(scorers.every((step) => step.prdHistory === true)).toBe(true)
      expect(consensus?.prdHistory).toBe(true)
    }

    // review-cc ends at the findings report — it has no scoring steps — so it
    // attaches the PRD only on its scope step.
    {
      const steps = resolvePipeline({ name: "review-cc", spec: builtInPipelines["review-cc"]!, agents: builtInAgents }).steps
      const scope = steps.find((step): step is AgentStep => step.type === "agent" && step.name === "scope")
      expect(scope?.prdHistory).toBe(true)
      expect(steps.filter((step): step is AgentStep => step.type === "agent" && step.name !== "scope").every((step) => step.prdHistory === undefined)).toBe(true)
    }

    // ship's measurement lives in its goal step: the fragment's scorers and
    // consensus carry the PRD so the measurement is graded against the original
    // requirements, and the fixer does too, so it knows the original
    // requirements while closing exactly the reported gaps.
    {
      const goal = resolvePipeline({ name: "ship", spec: builtInPipelines.ship!, agents: builtInAgents }).goalPlan!
      expect(goal.measure.steps.filter((step) => step.name === "score").every((step) => step.prdHistory === true)).toBe(true)
      expect(goal.measure.steps.find((step) => step.name === "score-report")?.prdHistory).toBe(true)
      expect(goal.improve.steps.find((step) => step.name === "fix")?.prdHistory).toBe(true)
    }

    // Non-scored pipelines attach no historical PRD anywhere.
    for (const name of ["implement", "hunter"] as const) {
      const steps = resolvePipeline({ name, spec: builtInPipelines[name]!, agents: builtInAgents }).steps
      expect(steps.every((step) => step.type !== "agent" || step.prdHistory === undefined)).toBe(true)
    }
  })

  test("threads enabled custom step history and omits disabled history", () => {
    expect(agentSteps({ steps: [{ agent: "review-scope", prdHistory: true }] })[0]?.prdHistory).toBe(true)
    expect(agentSteps({ steps: [{ agent: "review-scope", prdHistory: false }] })[0]?.prdHistory).toBeUndefined()
  })
})

describe("built-in review-lite pipeline", () => {
  const reviewLite = () => resolvePipeline({ name: "review-lite", spec: builtInPipelines["review-lite"]!, agents: builtInAgents })

  test("carries the same defaultPrompt and suggestedPrompts as review", () => {
    const pipeline = reviewLite()
    expect(pipeline.defaultPrompt).toBe(
      "Review the current branch against its base and report prioritized findings with a verified quality score.",
    )
    expect(pipeline.suggestedPrompts).toEqual(["Review the open PR for this branch", "Review only the last commit's diff"])
  })

  test("is report-only: every step is read-only and there is no human gate", () => {
    const pipeline = reviewLite()
    const agents = pipeline.steps.filter((step): step is AgentStep => step.type === "agent")
    expect(agents.length).toBeGreaterThan(0)
    expect(agents.every((step) => step.readOnly)).toBe(true)
    expect(pipeline.steps.some((step) => step.type === "human")).toBe(false)
  })

  test("scope verifies on the cheap model too, so the checks run once per review", () => {
    const scope = reviewLite().steps.find((step): step is AgentStep => step.type === "agent" && step.name === "scope")
    expect(scope).toMatchObject({ agentName: "review-scope", readOnly: true, verify: true })
  })

  test("runs entirely on low-cost models: DeepSeek V4 Flash scopes, audits, and reports, and the scoring stays on GLM 5.3 + Grok 4.6", () => {
    const pipeline = reviewLite()
    expect(stepNames(pipeline)).toEqual([
      "scope",
      "clean-code__openrouter-deepseek-deepseek-v4-flash-0731-high",
      "clean-code__openrouter-z-ai-glm-5-3-flash-high",
      "security__openrouter-deepseek-deepseek-v4-flash-0731-high",
      "security__openrouter-z-ai-glm-5-3-flash-high",
      "bugs__openrouter-deepseek-deepseek-v4-flash-0731-high",
      "bugs__openrouter-z-ai-glm-5-3-flash-high",
      "report",
      "score__openrouter-z-ai-glm-5-3-high",
      "score__openrouter-x-ai-grok-4-6-high",
      "score-report",
    ])

    const byName = Object.fromEntries(
      pipeline.steps.filter((step): step is AgentStep => step.type === "agent").map((step) => [step.name, step]),
    )
    expect(byName.scope?.model).toBe("openrouter/deepseek/deepseek-v4-flash-0731")
    expect(byName.report?.model).toBe("openrouter/deepseek/deepseek-v4-flash-0731")
    expect(byName.report?.inputFiles).toEqual([
      "prd.md",
      "reports/scope.md",
      "reports/clean-code__openrouter-deepseek-deepseek-v4-flash-0731-high.md",
      "reports/clean-code__openrouter-z-ai-glm-5-3-flash-high.md",
      "reports/security__openrouter-deepseek-deepseek-v4-flash-0731-high.md",
      "reports/security__openrouter-z-ai-glm-5-3-flash-high.md",
      "reports/bugs__openrouter-deepseek-deepseek-v4-flash-0731-high.md",
      "reports/bugs__openrouter-z-ai-glm-5-3-flash-high.md",
    ])
  })

  test("never reaches for Opus, which is what separates it from review", () => {
    // The scorer agents default to Opus, so the scorer steps have to pin their
    // models explicitly; an omitted `models:` would reintroduce exactly the cost
    // this pipeline exists to avoid.
    expect(JSON.stringify(builtInPipelines["review-lite"])).not.toContain("opus")
    const scorers = reviewLite().steps.filter((step): step is AgentStep => step.type === "agent" && step.stepName === "score")
    expect(scorers).toHaveLength(2)
    for (const step of scorers) {
      expect(step.model).not.toContain("opus")
    }
  })

  test("measures like review does, on its own models", () => {
    const report = reviewLite().steps.find((step): step is AgentStep => step.type === "agent" && step.name === "score-report")
    expect(report).toMatchObject({ agentName: "quality-score-report", model: "openrouter/z-ai/glm-5.3", variant: "high", readOnly: true, verify: true })
  })
})

describe("built-in fixer pipeline", () => {
  const fixer = () =>
    resolvePipeline({ name: "fixer", spec: builtInPipelines.fixer!, agents: builtInAgents }).steps.filter(
      (step): step is AgentStep => step.type === "agent",
    )

  test("runs reproduction, fixes, and validation in that order", () => {
    expect(fixer().map((step) => step.name)).toEqual(["reproduction", "fixes", "validation"])
  })

  test("carries every phase on Terra xhigh", () => {
    const byName = Object.fromEntries(fixer().map((step) => [step.name, step]))

    expect(byName.reproduction).toMatchObject({ model: "openai/gpt-5.6-terra", variant: "xhigh" })
    expect(byName.fixes).toMatchObject({ model: "openai/gpt-5.6-terra", variant: "xhigh" })
    expect(byName.validation).toMatchObject({ model: "openai/gpt-5.6-terra", variant: "xhigh" })
  })

  test("advises the writing phases with Astra 6 extra high and leaves validation unadvised", () => {
    const byName = Object.fromEntries(fixer().map((step) => [step.name, step]))

    expect(byName.reproduction).toMatchObject({ advisor: "openai/gpt-6-astra", advisorVariant: "xhigh" })
    expect(byName.fixes).toMatchObject({ advisor: "openai/gpt-6-astra", advisorVariant: "xhigh" })
    expect(byName.validation?.advisor).toBeUndefined()
  })

  test("lets reproduction and fixes write, and lets validation run checks without editing", () => {
    const byName = Object.fromEntries(fixer().map((step) => [step.name, step]))

    expect(byName.reproduction?.readOnly).toBeUndefined()
    expect(byName.fixes?.readOnly).toBeUndefined()
    // The point of the phase: it cannot edit, but it can rerun the proofs its
    // prompt tells it to rerun.
    expect(byName.validation?.readOnly).toBe(true)
    expect(byName.validation?.verify).toBe(true)
  })

  test("gives every phase the exact evidence trail its prompt reads by path", () => {
    const byName = Object.fromEntries(fixer().map((step) => [step.name, step]))

    // reproduction opens on the findings alone; the diff is what it proves them against.
    expect(byName.reproduction?.inputFiles).toEqual(["prd.md"])
    expect(byName.reproduction?.inputDiff).toBe(true)
    expect(byName.fixes?.inputFiles).toEqual(["prd.md", "reports/reproduction.md"])
    expect(byName.validation?.inputFiles).toEqual(["prd.md", "reports/reproduction.md", "reports/fixes.md"])
  })
})

describe("built-in review-cc pipeline", () => {
  test("carries a defaultPrompt and suggestedPrompts for zero-friction review runs", () => {
    const pipeline = resolvePipeline({ name: "review-cc", spec: builtInPipelines["review-cc"]!, agents: builtInAgents })
    expect(pipeline.defaultPrompt).toBe("Review the current branch against its base and report prioritized findings.")
    expect(pipeline.suggestedPrompts).toEqual(["Review the open PR for this branch", "Review only the last commit's diff"])
  })
  const reviewCc = () => resolvePipeline({ name: "review-cc", spec: builtInPipelines["review-cc"]!, agents: builtInAgents })

  test("is report-only: every step is read-only and there is no human gate", () => {
    const pipeline = reviewCc()
    const agents = pipeline.steps.filter((step): step is AgentStep => step.type === "agent")
    expect(agents.length).toBeGreaterThan(0)
    expect(agents.every((step) => step.readOnly)).toBe(true)
    expect(pipeline.steps.some((step) => step.type === "human")).toBe(false)
  })

  test("scope verifies on the Terra leg too, and the claude-code audits stay bash-less", () => {
    const scope = reviewCc().steps.find((step): step is AgentStep => step.type === "agent" && step.name === "scope")
    expect(scope).toMatchObject({ agentName: "review-scope", readOnly: true, verify: true })
  })

  test("pairs each Terra audit with a Claude Code audit and feeds every report to one Sol report step", () => {
    const pipeline = reviewCc()
    expect(stepNames(pipeline)).toEqual(["scope", "clean-code", "clean-code-cc", "security", "security-cc", "bugs", "bugs-cc", "report"])

    const byName = Object.fromEntries(
      pipeline.steps.filter((step): step is AgentStep => step.type === "agent").map((step) => [step.name, step]),
    )
    // The `-cc` slots run the local Claude Code CLI, so they carry its bare alias rather than provider/model.
    for (const name of ["clean-code-cc", "security-cc", "bugs-cc"]) {
      expect(byName[name]).toMatchObject({ runner: "claude-code", model: "opus" })
    }
    expect(byName.report).toMatchObject({ model: "openai/gpt-5.6-sol", variant: "xhigh" })
    expect(byName.report?.inputFiles).toEqual([
      "prd.md",
      "reports/scope.md",
      "reports/clean-code.md",
      "reports/clean-code-cc.md",
      "reports/security.md",
      "reports/security-cc.md",
      "reports/bugs.md",
      "reports/bugs-cc.md",
    ])
  })
})

describe("built-in hunter pipelines", () => {
  const hunter = () => resolvePipeline({ name: "hunter", spec: builtInPipelines.hunter!, agents: builtInAgents })
  const hunterMax = () => resolvePipeline({ name: "hunter-max", spec: builtInPipelines["hunter-max"]!, agents: builtInAgents })

  test("both are report-only with no human gate", () => {
    for (const pipeline of [hunter(), hunterMax()]) {
      const agents = pipeline.steps.filter((step): step is AgentStep => step.type === "agent")
      expect(agents.length).toBeGreaterThan(0)
      expect(agents.every((step) => step.readOnly)).toBe(true)
      expect(pipeline.steps.some((step) => step.type === "human")).toBe(false)
    }
  })

  test("hunter pairs Terra with one specialty model per track and reconciles them on Sol", () => {
    const pipeline = hunter()
    expect(stepNames(pipeline)).toEqual([
      "hunter-correctness__openai-gpt-5-6-terra-xhigh",
      "hunter-correctness__openrouter-z-ai-glm-5-3-high",
      "hunter-memory__openai-gpt-5-6-terra-xhigh",
      "hunter-memory__openrouter-x-ai-grok-4-6-high",
      "hunter-performance__openai-gpt-5-6-terra-xhigh",
      "hunter-performance__openrouter-x-ai-grok-4-6-high",
      "hunter-security__openai-gpt-5-6-terra-xhigh",
      "hunter-security__openrouter-moonshotai-kimi-k3",
      "hunter-reliability__openai-gpt-5-6-terra-xhigh",
      "hunter-reliability__openrouter-z-ai-glm-5-2",
      "hunter-supply-chain__openai-gpt-5-6-terra-xhigh",
      "hunter-supply-chain__openrouter-z-ai-glm-5-2",
      "hunter-report",
    ])

    const report = pipeline.steps.find((step): step is AgentStep => step.type === "agent" && step.stepName === "hunter-report")
    expect(report).toMatchObject({ model: "openai/gpt-5.6-sol", variant: "xhigh" })
    // `reports: previous` pulls in the whole parallel group: 6 tracks x 2 models.
    expect(report?.inputFiles.filter((file) => file.startsWith("reports/"))).toHaveLength(12)
  })

  test("hunter-max fans all six tracks across the same five models", () => {
    const pipeline = hunterMax()
    const agents = pipeline.steps.filter((step): step is AgentStep => step.type === "agent")
    const tracks = agents.filter((step) => step.stepName !== "hunter-max-report")

    expect(tracks).toHaveLength(30)
    expect(new Set(tracks.map((step) => step.stepName)).size).toBe(6)
    for (const track of new Set(tracks.map((step) => step.stepName))) {
      const models = tracks.filter((step) => step.stepName === track).map((step) => `${step.model}${step.variant ? `#${step.variant}` : ""}`)
      expect(models).toEqual([
        "openai/gpt-5.6-terra#xhigh",
        "openrouter/anthropic/claude-opus-5",
        "openrouter/z-ai/glm-5.3#high",
        "openrouter/moonshotai/kimi-k3",
        "openrouter/x-ai/grok-4.6#high",
      ])
    }

    const report = agents.find((step) => step.stepName === "hunter-max-report")
    expect(report).toMatchObject({ model: "openai/gpt-5.6-sol", variant: "xhigh" })
    expect(report?.inputFiles.filter((file) => file.startsWith("reports/"))).toHaveLength(30)
  })

  test("every track step attaches the diff and reads no earlier report", () => {
    for (const pipeline of [hunter(), hunterMax()]) {
      const tracks = pipeline.steps.filter(
        (step): step is AgentStep => step.type === "agent" && !step.stepName.endsWith("-report"),
      )
      expect(tracks.every((step) => step.inputDiff)).toBe(true)
      expect(tracks.every((step) => !step.inputFiles.some((file) => file.startsWith("reports/")))).toBe(true)
    }
  })
})

describe("built-in default prompts", () => {
  test("concrete-action pipelines carry a non-empty defaultPrompt and suggestions", () => {
    for (const name of ["review", "review-lite", "review-cc", "hunter", "hunter-max", "ship"]) {
      const pipeline = resolvePipeline({ name, spec: builtInPipelines[name]!, agents: builtInAgents })
      expect(pipeline.defaultPrompt, `${name} should have a defaultPrompt`).toBeTruthy()
    }
    for (const name of ["review", "review-lite", "review-cc", "hunter", "hunter-max"]) {
      const pipeline = resolvePipeline({ name, spec: builtInPipelines[name]!, agents: builtInAgents })
      expect(pipeline.suggestedPrompts?.length, `${name} should have suggestions`).toBeGreaterThan(0)
    }
  })

  test("pipelines where the prompt IS the description carry no defaultPrompt", () => {
    for (const name of ["implement", "implement-lite", "fixer"]) {
      const pipeline = resolvePipeline({ name, spec: builtInPipelines[name]!, agents: builtInAgents })
      expect(pipeline.defaultPrompt, `${name} should not have a defaultPrompt`).toBeUndefined()
      expect(pipeline.suggestedPrompts, `${name} should not have suggestions`).toBeUndefined()
    }
  })

  test("an empty suggestedPrompts list resolves to no suggestions", () => {
    const pipeline = resolvePipeline({ name: "x", spec: { steps: ["implementer"], suggestedPrompts: [] }, agents: builtInAgents })
    expect(pipeline.suggestedPrompts).toBeUndefined()
    expect(pipeline.defaultPrompt).toBeUndefined()
  })
})

describe("pipeline resolution", () => {
  test("accepts agent names, aliases, and the human-review keyword as string steps", () => {
    const pipeline = resolve({ steps: ["implementer", "human-review", "pattern-auditor", "tests"] })

    expect(stepNames(pipeline)).toEqual(["implementer", "human-review", "pattern-auditor", "tests"])
    const auditor = pipeline.steps[2]
    expect(auditor?.type).toBe("agent")
    if (auditor?.type === "agent") expect(auditor.agentName).toBe("pattern-auditor")
    const tests = pipeline.steps[3]
    if (tests?.type === "agent") expect(tests.agentName).toBe("test-engineer")
  })

  test("accepts generic named human steps", () => {
    const pipeline = resolve({
      steps: ["implementer", { type: "human", name: "planning", description: "Plan interactively" }, "tests", { type: "human" }],
    })

    expect(stepNames(pipeline)).toEqual(["implementer", "planning", "tests", "human"])
    expect(pipeline.steps[1]).toMatchObject({ type: "human", name: "planning", description: "Plan interactively" })
    expect(pipeline.steps[3]).toMatchObject({ type: "human", name: "human" })
  })

  test("derives report paths and commit step names from the step name", () => {
    const [implementer, review] = agentSteps({
      steps: ["implementer", { agent: "adversarial", name: "final-check" }],
    })

    expect(implementer?.reportPath).toBe("reports/implementer.md")
    expect(review?.name).toBe("final-check")
    expect(review?.reportPath).toBe("reports/final-check.md")
  })

  test("reports modes: previous is the default, all/none/list override it", () => {
    const [first, second, third, fourth] = agentSteps({
      steps: [
        "implementer",
        "tests",
        { agent: "security", reports: "all" },
        { agent: "adversarial", reports: ["implementer"] },
      ],
    })

    expect(first?.inputFiles).toEqual(["prd.md"])
    expect(second?.inputFiles).toEqual(["prd.md", "reports/implementer.md"])
    expect(third?.inputFiles).toEqual(["prd.md", "reports/implementer.md", "reports/tests.md"])
    expect(fourth?.inputFiles).toEqual(["prd.md", "reports/implementer.md"])
  })

  test("human gates never leak into report wiring", () => {
    const [, after] = agentSteps({ steps: ["implementer", { type: "human", name: "planning" }, "tests"] })
    expect(after?.inputFiles).toEqual(["prd.md", "reports/implementer.md"])
  })

  test("diff defaults to everything but the first agent step", () => {
    const [first, second] = agentSteps({ steps: ["human-review", "implementer", { agent: "tests", diff: false }] })
    expect(first?.inputDiff).toBe(false)
    expect(second?.inputDiff).toBe(false)
  })

  test("model precedence: step > defaults.model > built-in preference", () => {
    const spec: PipelineSpec = {
      steps: ["implementer", "design", { agent: "tests", model: "openrouter/z-ai/glm-4.7#max" }],
    }

    const withoutDefault = agentSteps(spec)
    expect(withoutDefault[1]).toMatchObject({ model: "openrouter/x-ai/grok-4.6", variant: "high" })

    const [implementer, design, tests] = resolvePipeline({
      name: "test",
      spec,
      agents: builtInAgents,
      defaultModel: "anthropic/claude-sonnet-4-6",
    }).steps.filter((step): step is AgentStep => step.type === "agent")

    expect(implementer?.model).toBe("anthropic/claude-sonnet-4-6")
    expect(design?.model).toBe("anthropic/claude-sonnet-4-6")
    expect(tests).toMatchObject({ model: "openrouter/z-ai/glm-4.7", variant: "max" })
  })

  test("project agents override built-in preferences via their model field", () => {
    const agents = builtInAgents.map((agent) =>
      agent.name === "design-polisher" ? { ...agent, model: "openai/gpt-5.5#xhigh" } : agent,
    )
    const [design] = resolvePipeline({ name: "test", spec: { steps: ["design"] }, agents }).steps as AgentStep[]
    expect(design).toMatchObject({ model: "openai/gpt-5.5", variant: "xhigh" })
  })

  test("resolved steps keep read-only agent enforcement metadata", () => {
    const agents = builtInAgents.map((agent) => (agent.name === "security-auditor" ? { ...agent, readOnly: true } : agent))
    const [security] = resolvePipeline({ name: "test", spec: { steps: ["security"] }, agents }).steps as AgentStep[]

    expect(security).toMatchObject({ agentName: "security-auditor", readOnly: true })
  })

  test("numbers repeated human gates and threads per-step settings", () => {
    const pipeline = resolve({
      steps: ["implementer", "human-review", { agent: "tests" }, "human-review"],
    })

    expect(stepNames(pipeline)).toEqual(["implementer", "human-review", "tests", "human-review-2"])
    const tests = pipeline.steps[2]
    expect(tests).toMatchObject({ type: "agent", agentName: "test-engineer" })
  })

  test("rejects broken specs with errors that name the offender", () => {
    expect(() => resolve({ steps: ["implementer", "implementer"] })).toThrow('duplicate step name "implementer"')
    expect(() => resolve({ steps: [{ agent: "implementer", name: "human-review" }] })).toThrow("reserved name")
    expect(() => resolve({ steps: ["imaginary-agent"] })).toThrow('unknown agent "imaginary-agent"')
    expect(() => resolve({ steps: ["human-review"] })).toThrow("no agent steps")
    expect(() => resolve({ steps: [{ agent: "tests", reports: ["later"] }, { agent: "security", name: "later" }] })).toThrow(
      "not an earlier agent step",
    )
  })

  test("rejects unsafe step names when resolving programmatic pipeline specs", () => {
    expect(() => resolve({ steps: [{ agent: "security", name: "../../../../tmp/owned" }] })).toThrow(
      "filesystem-safe identifier",
    )
  })
})

describe("step filters", () => {
  test("validates --only/--skip names against the pipeline, tolerating human gates", () => {
    const pipeline = implement()

    expect(() => validateStepFilters(pipeline, { onlySteps: ["implementer"], skipSteps: ["tests"] })).not.toThrow()
    expect(() => validateStepFilters(pipeline, { onlySteps: ["secuirty"], skipSteps: [] })).toThrow('unknown step "secuirty"')

    const headless = { ...pipeline, steps: pipeline.steps.filter((step) => step.type !== "human") }
    expect(() => validateStepFilters(headless, { onlySteps: [], skipSteps: ["human-review"] })).not.toThrow()
  })

  test("accepts a fanned-out step's shared stepName alongside its full disambiguated name", () => {
    const pipeline = resolve({
      steps: ["implementer", { agent: "adversarial", name: "clean-code", models: ["anthropic/claude-opus-4-7", "openai/gpt-5.5#xhigh"] }],
    })
    expect(() => validateStepFilters(pipeline, { onlySteps: ["clean-code"], skipSteps: [] })).not.toThrow()
    expect(() => validateStepFilters(pipeline, { onlySteps: ["clean-code__anthropic-claude-opus-4-7"], skipSteps: [] })).not.toThrow()
  })

  test("rejects filters naming internal goal phases, even ones that also match prefix steps", () => {
    // A goal pipeline whose prefix happens to share a step name with the
    // measure fragment: the filter must still refuse, because partially
    // compiling a loop is never valid.
    const pipeline = resolvePipeline({
      name: "scored",
      spec: {
        steps: [
          { agent: "implementer", name: "score" },
          {
            goal: {
              target: 85,
              improve: { briefStep: "fix", steps: [{ agent: "review-fixer", name: "fix" }] },
              measure: { steps: [{ agent: "quality-score-report", name: "score-report" }] },
            },
          },
        ],
      },
      agents: builtInAgents,
    })
    expect(() => validateStepFilters(pipeline, { onlySteps: [], skipSteps: ["fix"] })).toThrow(/goal improve phase/)
    expect(() => validateStepFilters(pipeline, { onlySteps: [], skipSteps: ["score-report"] })).toThrow(/goal measure phase/)
    // A prefix step that only exists in the prefix stays filterable.
    expect(() => validateStepFilters(pipeline, { onlySteps: [], skipSteps: ["score"] })).not.toThrow()
  })
})

describe("parallel groups", () => {
  test("resolves a parallel block into steps sharing one groupId, forced read-only with a synthesized agent name", () => {
    const [, patterns, security] = agentSteps({ steps: ["implementer", { parallel: ["patterns", "security"] }] })

    expect(patterns?.groupId).toBeDefined()
    expect(patterns?.groupId).toBe(security?.groupId)
    expect(patterns?.readOnly).toBe(true)
    expect(security?.readOnly).toBe(true)
    // pattern-auditor/security-auditor aren't read-only by default, so parallel execution synthesizes a "__ro" variant
    expect(patterns?.agentName).toBe("pattern-auditor__ro")
    expect(security?.agentName).toBe("security-auditor__ro")
  })

  test("doesn't double-suffix an agent that's already configured read-only", () => {
    const agents = builtInAgents.map((agent) => (agent.name === "security-auditor" ? { ...agent, readOnly: true } : agent))
    const [security] = resolvePipeline({ name: "test", spec: { steps: [{ parallel: ["security"] }] }, agents }).steps as AgentStep[]
    expect(security?.agentName).toBe("security-auditor")
    expect(security?.readOnly).toBe(true)
  })

  test("a verifying step loses bash in a parallel block", () => {
    const pipeline = resolvePipeline({
      name: "test",
      spec: { steps: [{ parallel: [{ agent: "review-scope", name: "scope", verify: true }, "patterns"] }] },
      agents: builtInAgents,
    })
    const [scope] = pipeline.steps as AgentStep[]

    expect(scope?.readOnly).toBe(true)
    expect(scope?.verify).toBeUndefined()
    // Already read-only, and verify was dropped, so no __ro / __verify for scope.
    expect(scope?.agentName).toBe("review-scope")
  })

  test("a step inside a parallel block never sees its own siblings' reports, only earlier groups'", () => {
    const [, patterns, security] = agentSteps({ steps: ["implementer", { parallel: ["patterns", "security"] }] })
    expect(patterns?.inputFiles).toEqual(["prd.md", "reports/implementer.md"])
    expect(security?.inputFiles).toEqual(["prd.md", "reports/implementer.md"])
  })

  test("reports: previous after a group expands to every member of that group", () => {
    const steps = agentSteps({
      steps: ["implementer", { parallel: ["patterns", "security"] }, { agent: "adversarial", name: "triage" }],
    })
    const triage = steps.find((step) => step.name === "triage")
    expect(triage?.inputFiles).toEqual(["prd.md", "reports/patterns.md", "reports/security.md"])
  })

  test("reports: all includes every member of every earlier group", () => {
    const steps = agentSteps({
      steps: ["implementer", { parallel: ["patterns", "security"] }, { agent: "adversarial", name: "triage", reports: "all" }],
    })
    const triage = steps.find((step) => step.name === "triage")
    expect(triage?.inputFiles).toEqual(["prd.md", "reports/implementer.md", "reports/patterns.md", "reports/security.md"])
  })

  test("empty parallel block is rejected", () => {
    expect(() => resolve({ steps: ["implementer", { parallel: [] }] })).toThrow("empty parallel block")
  })

  test("nested parallel blocks are rejected", () => {
    // Nesting isn't representable in StepSpec's types; simulate config-loaded data that bypassed validation.
    const nested = { parallel: ["patterns"] } as unknown as string
    expect(() => resolve({ steps: ["implementer", { parallel: [nested, "security"] }] })).toThrow("nest a parallel block")
  })

  test("human steps can't run inside a parallel block", () => {
    expect(() => resolve({ steps: ["implementer", { parallel: ["patterns", "human-review"] }] })).toThrow("inside a parallel block")
    expect(() => resolve({ steps: ["implementer", { parallel: ["patterns", { agent: "human-review" }] }] })).toThrow("inside a parallel block")
    expect(() => resolve({ steps: ["implementer", { parallel: ["patterns", { type: "human", name: "planning" } as never] }] })).toThrow(
      "inside a parallel block",
    )
  })
})

describe("model fan-out", () => {
  test("slugifies provider/model#variant into a filesystem-safe suffix", () => {
    expect(slugifyModel("anthropic/claude-opus-4-7")).toBe("anthropic-claude-opus-4-7")
    expect(slugifyModel("openai/gpt-5.5#xhigh")).toBe("openai-gpt-5-5-xhigh")
  })

  test("fans a step out across models, one forced-read-only invocation per model, sharing groupId/stepName", () => {
    const [clean1, clean2] = agentSteps({
      steps: [{ agent: "implementer", name: "clean-code", models: ["anthropic/claude-opus-4-7", "openai/gpt-5.5#xhigh"] }],
    })

    expect(clean1?.stepName).toBe("clean-code")
    expect(clean2?.stepName).toBe("clean-code")
    expect(clean1?.groupId).toBe(clean2?.groupId)
    expect(clean1?.name).toBe("clean-code__anthropic-claude-opus-4-7")
    expect(clean2?.name).toBe("clean-code__openai-gpt-5-5-xhigh")
    expect(clean1).toMatchObject({ model: "anthropic/claude-opus-4-7" })
    expect(clean2).toMatchObject({ model: "openai/gpt-5.5", variant: "xhigh" })
    expect(clean1?.reportPath).toBe("reports/clean-code__anthropic-claude-opus-4-7.md")
    expect(clean1?.readOnly).toBe(true)
    expect(clean2?.readOnly).toBe(true)
    expect(clean1?.agentName).toBe("implementer__ro")
  })

  test("a models: fan-out also strips bash from a verifying step", () => {
    const [first] = resolvePipeline({
      name: "test",
      spec: { steps: [{ agent: "review-validator", name: "validator", verify: true, models: ["anthropic/claude-opus-4-7", "openai/gpt-5.5#xhigh"] }] },
      agents: builtInAgents,
    }).steps as AgentStep[]

    expect(first?.readOnly).toBe(true)
    expect(first?.verify).toBeUndefined()
    expect(first?.agentName).toBe("review-validator")
  })

  test("reports: [stepName] on a fanned-out step expands to every model variant", () => {
    const steps = agentSteps({
      steps: [
        { agent: "implementer", name: "clean-code", models: ["anthropic/claude-opus-4-7", "openai/gpt-5.5#xhigh"] },
        { agent: "adversarial", name: "triage", reports: ["clean-code"] },
      ],
    })
    const triage = steps.find((step) => step.name === "triage")
    expect(triage?.inputFiles).toEqual(["prd.md", "reports/clean-code__anthropic-claude-opus-4-7.md", "reports/clean-code__openai-gpt-5-5-xhigh.md"])
  })

  test("a fanned-out step can also be targeted by one specific variant's full name", () => {
    const steps = agentSteps({
      steps: [
        { agent: "implementer", name: "clean-code", models: ["anthropic/claude-opus-4-7", "openai/gpt-5.5#xhigh"] },
        { agent: "adversarial", name: "triage", reports: ["clean-code__anthropic-claude-opus-4-7"] },
      ],
    })
    const triage = steps.find((step) => step.name === "triage")
    expect(triage?.inputFiles).toEqual(["prd.md", "reports/clean-code__anthropic-claude-opus-4-7.md"])
  })

  test("models needs at least 2 entries", () => {
    expect(() => resolve({ steps: [{ agent: "implementer", models: ["anthropic/claude-opus-4-7"] }] })).toThrow("at least 2 entries")
  })

  test("can't set both model and models", () => {
    expect(() =>
      resolve({
        steps: [{ agent: "implementer", model: "anthropic/claude-opus-4-7", models: ["anthropic/claude-opus-4-7", "openai/gpt-5.5#xhigh"] }],
      }),
    ).toThrow('both "model" and "models"')
  })

  test("models inside a parallel block compose: fan-out members join the block's shared group", () => {
    const steps = agentSteps({
      steps: [
        "implementer",
        {
          parallel: ["patterns", { agent: "implementer", name: "clean-code", models: ["anthropic/claude-opus-4-7", "openai/gpt-5.5#xhigh"] }],
        },
      ],
    })
    expect(steps.length).toBe(4) // implementer + patterns + 2 clean-code variants
    const groupIds = new Set(steps.slice(1).map((step) => step.groupId))
    expect(groupIds.size).toBe(1)
  })
})

describe("synthesizeReadOnlyAgents", () => {
  test("builds one forced-read-only agent spec per distinct base agent referenced, deduped", () => {
    const pipeline = resolve({
      steps: [
        "implementer",
        { parallel: ["patterns", "security"] },
        { agent: "implementer", name: "clean-code", models: ["anthropic/claude-opus-4-7", "openai/gpt-5.5#xhigh"] },
      ],
    })
    const synthesized = synthesizeReadOnlyAgents(pipeline, builtInAgents)
    expect(synthesized.map((agent) => agent.name).sort()).toEqual(["implementer__ro", "pattern-auditor__ro", "security-auditor__ro"])
    expect(synthesized.every((agent) => agent.readOnly)).toBe(true)
  })

  test("returns nothing when no step needed a synthesized variant", () => {
    expect(synthesizeReadOnlyAgents(implement(), builtInAgents)).toEqual([])
  })
})

describe("step-level verify", () => {
  test("a read-only agent only gets bash when the step asks", () => {
    const [checking, staticScope] = agentSteps({
      steps: [
        { agent: "review-scope", name: "scope", verify: true },
        { agent: "review-scope", name: "scope-static" },
      ],
    })

    expect(checking).toMatchObject({ agentName: `review-scope${verifyAgentSuffix}`, readOnly: true, verify: true })
    expect(staticScope).toMatchObject({ agentName: "review-scope", readOnly: true })
    expect(staticScope?.verify).toBeUndefined()
  })

  test("verify on a writable agent is ignored", () => {
    const [step] = agentSteps({ steps: [{ agent: "implementer", verify: true }] })
    expect(step?.readOnly).toBeUndefined()
    expect(step?.verify).toBeUndefined()
    expect(step?.agentName).toBe("implementer")
  })

  test("an exclusive verifying use keeps the base agent name", () => {
    const [scope] = agentSteps({ steps: [{ agent: "review-scope", name: "scope", verify: true }] })
    expect(scope?.agentName).toBe("review-scope")
    expect(scope?.verify).toBe(true)
  })

  test("agentsForPipeline sets verify on exclusive uses and synthesizes mixed ones", () => {
    const pipeline = resolvePipeline({
      name: "test",
      spec: {
        steps: [
          { agent: "review-scope", name: "scope", verify: true },
          { agent: "review-scope", name: "scope-static" },
          { agent: "quality-score-report", name: "score-report", verify: true },
        ],
      },
      agents: builtInAgents,
    })
    const agents = agentsForPipeline(pipeline, builtInAgents)
    const byName = Object.fromEntries(agents.map((agent) => [agent.name, agent]))

    expect(byName["review-scope"]?.verify).toBeUndefined()
    expect(byName[`review-scope${verifyAgentSuffix}`]).toMatchObject({ readOnly: true, verify: true })
    expect(byName["quality-score-report"]?.verify).toBe(true)
    expect(synthesizeVerifyingAgents(pipeline, builtInAgents).map((agent) => agent.name)).toEqual([`review-scope${verifyAgentSuffix}`])
  })
})

describe("claude-code runner steps", () => {
  test("propagates runner and passes the model verbatim (claude CLI aliases allowed)", () => {
    const steps = agentSteps({
      steps: [
        { agent: "review-scope", name: "scope", model: "openai/gpt-5.5#xhigh", reports: "none", diff: true },
        { agent: "security-reviewer", name: "external-security", runner: "claude-code", model: "opus", reports: ["scope"] },
      ],
    })

    const external = steps.find((step) => step.name === "external-security")
    expect(external?.runner).toBe("claude-code")
    expect(external?.model).toBe("opus")
    expect(external?.variant).toBeUndefined()
    expect(external?.readOnly).toBe(true)
  })

  test("defaults to the claude CLI's own model when the step has none", () => {
    const steps = agentSteps({
      steps: [{ agent: "bug-auditor", name: "bugs", runner: "claude-code", reports: "none", diff: true }],
    })

    expect(steps[0]?.runner).toBe("claude-code")
    expect(steps[0]?.model).toBe("")
  })

  test("normalizes and validates Claude models for programmatic pipeline specs", () => {
    const steps = agentSteps({
      steps: [{ agent: "bug-auditor", runner: "claude-code", model: "anthropic/claude-opus-4-8", reports: "none", diff: true }],
    })

    expect(steps[0]?.model).toBe("claude-opus-4-8")
    expect(() =>
      agentSteps({ steps: [{ agent: "bug-auditor", runner: "claude-code", model: "openai/gpt-5.6", reports: "none", diff: true }] }),
    ).toThrow("runner claude-code executes Anthropic models")
  })

  test("opencode steps carry no runner field", () => {
    const steps = agentSteps({ steps: [{ agent: "bug-auditor", name: "bugs", reports: "none", diff: true }] })
    expect(steps[0]?.runner).toBeUndefined()
  })

  test("an explicit runner: opencode resolves like the default", () => {
    const steps = agentSteps({ steps: [{ agent: "bug-auditor", name: "bugs", runner: "opencode", reports: "none", diff: true }] })
    expect(steps[0]?.runner).toBeUndefined()
    expect(steps[0]?.model).toContain("/")
  })

  test("rejects claude-code on a step that can write (v1 is audit-only)", () => {
    expect(() => agentSteps({ steps: [{ agent: "implementer", runner: "claude-code" }] })).toThrow(/read-only/)
  })

  test("accepts claude-code inside a parallel block (forced read-only)", () => {
    const steps = agentSteps({
      steps: [
        { agent: "review-scope", name: "scope", reports: "none", diff: true },
        {
          parallel: [
            { agent: "bug-auditor", name: "bugs", reports: ["scope"] },
            { agent: "bug-auditor", name: "bugs-claude", runner: "claude-code", reports: ["scope"] },
          ],
        },
      ],
    })

    const claude = steps.find((step) => step.name === "bugs-claude")
    expect(claude?.runner).toBe("claude-code")
    expect(claude?.readOnly).toBe(true)
  })

  test("rejects claude-code on a verifying step, which needs bash it cannot give", () => {
    expect(() => agentSteps({ steps: [{ agent: "review-validator", name: "validator", runner: "claude-code", verify: true }] })).toThrow(/can't run commands/)
  })

  test("accepts claude-code on a verifying step forced read-only, where bash is dropped anyway", () => {
    const steps = agentSteps({
      steps: [
        { agent: "review-scope", name: "scope", reports: "none", diff: true },
        {
          parallel: [
            { agent: "bug-auditor", name: "bugs", reports: ["scope"] },
            { agent: "review-validator", name: "validator-claude", runner: "claude-code", reports: ["scope"], verify: true },
          ],
        },
      ],
    })

    const claude = steps.find((step) => step.name === "validator-claude")
    expect(claude?.readOnly).toBe(true)
    expect(claude?.verify).toBeUndefined()
  })

  test("rejects claude-code combined with a models: fan-out", () => {
    expect(() =>
      agentSteps({
        steps: [{ agent: "bug-auditor", runner: "claude-code", models: ["openai/gpt-5.5#xhigh", "anthropic/claude-opus-4-8"] }],
      }),
    ).toThrow(/models/)
  })
})

describe("advisor resolution", () => {
  const withAdvisor = (spec: PipelineSpec, advisor?: string, maxCalls?: number) =>
    resolvePipeline({
      name: "test",
      spec,
      agents: builtInAgents,
      defaultAdvisor: advisor,
      defaultAdvisorMaxCalls: maxCalls,
    }).steps.filter((step): step is AgentStep => step.type === "agent")

  test("absent everywhere means no advisor, so an untouched config costs the same as before", () => {
    const [step] = agentSteps({ steps: ["implementer"] })

    expect(step?.advisor).toBeUndefined()
    expect(step?.advisorVariant).toBeUndefined()
    expect(step?.advisorMaxCalls).toBeUndefined()
  })

  test("splits the advisor's variant like any other model", () => {
    const [step] = agentSteps({ steps: [{ agent: "implementer", advisor: "anthropic/claude-opus-5#high" }] })

    expect(step?.advisor).toBe("anthropic/claude-opus-5")
    expect(step?.advisorVariant).toBe("high")
  })

  test("precedence runs step > agent > defaults", () => {
    const agents = builtInAgents.map((agent) => (agent.name === "implementer" ? { ...agent, advisor: "anthropic/claude-opus-4-8" } : agent))
    const steps = resolvePipeline({
      name: "test",
      spec: {
        steps: [
          { agent: "implementer", name: "from-step", advisor: "anthropic/claude-opus-5" },
          { agent: "implementer", name: "from-agent" },
          { agent: "tests", name: "from-defaults" },
        ],
      },
      agents,
      defaultAdvisor: "openai/gpt-5.6-sol",
    }).steps.filter((step): step is AgentStep => step.type === "agent")

    expect(steps.find((step) => step.name === "from-step")?.advisor).toBe("anthropic/claude-opus-5")
    expect(steps.find((step) => step.name === "from-agent")?.advisor).toBe("anthropic/claude-opus-4-8")
    expect(steps.find((step) => step.name === "from-defaults")?.advisor).toBe("openai/gpt-5.6-sol")
  })

  test("advisor: false cuts the chain so one step can opt out of a broader default", () => {
    const steps = withAdvisor(
      { steps: [{ agent: "implementer", name: "advised" }, { agent: "tests", name: "solo", advisor: false }] },
      "anthropic/claude-opus-5",
    )

    expect(steps.find((step) => step.name === "advised")?.advisor).toBe("anthropic/claude-opus-5")
    expect(steps.find((step) => step.name === "solo")?.advisor).toBeUndefined()
  })

  test("advisorMaxCalls comes from the step, else defaults, and only with an advisor", () => {
    const steps = withAdvisor(
      { steps: [{ agent: "implementer", name: "capped", advisorMaxCalls: 1 }, { agent: "tests", name: "inherited" }] },
      "anthropic/claude-opus-5",
      4,
    )

    expect(steps.find((step) => step.name === "capped")?.advisorMaxCalls).toBe(1)
    expect(steps.find((step) => step.name === "inherited")?.advisorMaxCalls).toBe(4)
    expect(() => agentSteps({ steps: [{ agent: "implementer", advisorMaxCalls: 2 }] })).toThrow("advisorMaxCalls without an advisor")
  })

  test("an advisor named on a claude-code step is an error; an inherited one is dropped", () => {
    expect(() =>
      agentSteps({ steps: [{ agent: "bug-auditor", runner: "claude-code", advisor: "anthropic/claude-opus-5", reports: "none" }] }),
    ).toThrow(/runner: claude-code does not support/)

    const steps = withAdvisor({ steps: [{ agent: "bug-auditor", runner: "claude-code", reports: "none" }] }, "anthropic/claude-opus-5")
    expect(steps[0]?.runner).toBe("claude-code")
    expect(steps[0]?.advisor).toBeUndefined()
  })

  test("every variant of a models: fan-out inherits the same advisor", () => {
    const steps = withAdvisor(
      { steps: [{ agent: "bug-auditor", name: "bugs", models: ["openai/gpt-5.6-sol", "anthropic/claude-opus-5"], reports: "none" }] },
      "anthropic/claude-opus-5",
    )

    expect(steps).toHaveLength(2)
    for (const step of steps) expect(step.advisor).toBe("anthropic/claude-opus-5")
  })
})

describe("deliverable contracts", () => {
  test("the quality-score contract is a v1 schema with a single automatic retry", () => {
    expect(qualityScoreDeliverableContract).toEqual({
      kind: "quality-score-report",
      schemaVersion: 1,
      retryOnMissingOrInvalid: 1,
    })
  })

  test("defaultDeliverableContract selects the quality-score contract for the scorer agent", () => {
    expect(defaultDeliverableContract("quality-score-report", false)).toEqual(qualityScoreDeliverableContract)
    // read-only status does not change the scorer's contract: it is always a
    // scored report, never a plain markdown report.
    expect(defaultDeliverableContract("quality-score-report", true)).toEqual(qualityScoreDeliverableContract)
  })

  test("defaultDeliverableContract selects markdown-report for every ordinary phase", () => {
    expect(defaultDeliverableContract("review-scope", true)).toEqual({ kind: "markdown-report" })
    expect(defaultDeliverableContract("implementer", false)).toEqual({ kind: "markdown-report" })
    // Read-only status no longer decides whether an ordinary phase owns a report.
    expect(defaultDeliverableContract("implementer", true)).toEqual({ kind: "markdown-report" })
  })

  test("deliverableContractForPhase prefers an explicit contract over the inferred default", () => {
    const explicit: DeliverableContract = { kind: "none" }
    const phase = {
      agentName: "quality-score-report",
      readOnly: true,
      deliverableContract: explicit,
    }
    expect(deliverableContractForPhase(phase)).toBe(explicit)
  })

  test("deliverableContractForPhase falls back to the inferred default for legacy metadata without a contract", () => {
    // Run metadata persisted before contracts existed has no deliverableContract
    // field; the resolver must still infer the right contract so historical runs
    // stay readable and executable.
    expect(deliverableContractForPhase({ agentName: "quality-score-report", readOnly: true })).toEqual(qualityScoreDeliverableContract)
    expect(deliverableContractForPhase({ agentName: "review-scope", readOnly: true })).toEqual({ kind: "markdown-report" })
    expect(deliverableContractForPhase({ agentName: "implementer", readOnly: false })).toEqual({ kind: "markdown-report" })
  })

  test("a resolved review pipeline gives the scorer the quality-score contract and read-only audits the markdown-report contract", () => {
    const steps = agentSteps(builtInPipelines.review!)
    const byName = Object.fromEntries(steps.map((step) => [step.name, step]))

    // The consensus step is the scored deliverable.
    expect(byName["score-report"]?.deliverableContract).toEqual(qualityScoreDeliverableContract)
    expect(byName["score-report"]?.readOnly).toBe(true)

    // Read-only report phases produce a markdown report, not a score.
    expect(byName["scope"]?.deliverableContract).toEqual({ kind: "markdown-report" })
    expect(byName["report"]?.deliverableContract).toEqual({ kind: "markdown-report" })

    // A writable phase gets the same markdown-report contract as a read-only
    // phase; the tool persists every agent step's deliverable.
    const defaultSteps = Object.fromEntries(
      implement()
        .steps.filter((step): step is AgentStep => step.type === "agent")
        .map((step) => [step.name, step]),
    )
    expect(defaultSteps["implementer"]?.deliverableContract).toEqual({ kind: "markdown-report" })
    // readOnly is only set when true; a writable phase leaves it undefined.
    expect(defaultSteps["implementer"]?.readOnly).toBeFalsy()
  })
})

describe("terminal goal step", () => {
  const prefix = (): AgentStepSpec[] => [{ agent: "implementer", reports: "none" }]

  const goalImprove = (): GoalImproveSpec => ({
    briefStep: "fix",
    steps: [{ agent: "review-fixer", name: "fix", reports: "none", diff: true }],
  })

  const goalMeasure = (): GoalMeasureSpec => ({
    steps: [
      { parallel: [{ agent: "quality-scorer", name: "score", models: [defaultAdversarialModel, "openrouter/z-ai/glm-5.3#high"], reports: "none" }] },
      { agent: "quality-score-report", name: "score-report", reports: ["score"] },
    ],
  })

  const goalNode = (overrides: Partial<GoalStepSpec["goal"]> = {}): GoalStepSpec => ({
    goal: {
      target: 85,
      improve: goalImprove(),
      measure: goalMeasure(),
      ...overrides,
    },
  })

  // A valid embedded goal: a writable prefix, an improve fragment whose fixer
  // is the brief recipient, and a read-only measure fragment ending in the
  // consensus score. Deliberately uses writable/read-only agents that exist in
  // the catalogue without leaning on any goal-reserved step name.
  const goalSpec = (): PipelineSpec => ({ steps: [...prefix(), goalNode({ target: 90 })] })

  const resolveGoal = (spec: PipelineSpec = goalSpec()) => resolvePipeline({ name: "scored", spec, agents: builtInAgents })

  test("a pipeline with one terminal goal step resolves a goal plan beside its prefix", () => {
    const pipeline = resolveGoal()

    // The prefix is the ordinary step list; the goal node is not a step in it.
    expect(pipeline.steps.map((step) => step.name)).toEqual(["implementer"])

    const goal = pipeline.goalPlan
    expect(goal).toBeDefined()
    expect(goal?.target).toBe(90)
    // Omitted cap/plateau use the documented defaults of three.
    expect(goal?.maxIterations).toBe(3)
    expect(goal?.plateau).toBe(3)
  })

  test("explicit maxIterations and plateau are respected", () => {
    const goal = resolveGoal({ steps: [...prefix(), goalNode({ target: 85, maxIterations: 5, plateau: 2 })] }).goalPlan
    expect(goal?.maxIterations).toBe(5)
    expect(goal?.plateau).toBe(2)
  })

  test("fragments resolve to ordered concrete steps with the improve brief recipient by structure", () => {
    const goal = resolveGoal().goalPlan!

    expect(goal.briefRecipient).toBe("fix")
    expect(goal.improve.steps.map((step) => step.name)).toEqual(["fix"])

    // Fan-out members keep their model-disambiguated physical names.
    const names = goal.measure.steps.map((step) => step.name)
    expect(names).toEqual([
      "score__openrouter-x-ai-grok-4-6-high",
      "score__openrouter-z-ai-glm-5-3-high",
      "score-report",
    ])
    // The score producer is the unique final quality-score deliverable.
    expect(goal.scoreProducer).toBe("score-report")
  })

  test("improve keeps a writable step and measure is entirely read-only", () => {
    const goal = resolveGoal().goalPlan!
    expect(goal.improve.steps.some((step) => !step.readOnly)).toBe(true)
    for (const step of goal.measure.steps) {
      expect(step.readOnly).toBe(true)
    }
  })

  test("target bounds are enforced with a path-specific error", () => {
    for (const target of [0, 101, -1]) {
      expect(() => resolveGoal({ steps: [...prefix(), goalNode({ target })] })).toThrow(/goal\.target/)
    }
  })

  test("a missing target is rejected", () => {
    const node = goalNode()
    delete (node.goal as { target?: number }).target
    expect(() => resolveGoal({ steps: [...prefix(), node] })).toThrow(/goal\.target/)
  })

  test("a pipeline without a goal step stays ordinary", () => {
    const pipeline = resolvePipeline({ name: "plain", spec: { steps: [{ agent: "implementer" }] }, agents: builtInAgents })
    expect(pipeline.goalPlan).toBeUndefined()
    expect(pipeline.steps.map((step) => step.name)).toEqual(["implementer"])
  })

  test("rejects two goal steps", () => {
    expect(() => resolveGoal({ steps: [...prefix(), goalNode(), goalNode()] })).toThrow(/more than one goal step/)
  })

  test("rejects a step after the goal step", () => {
    expect(() => resolveGoal({ steps: [goalNode(), ...prefix()] })).toThrow(/final step/)
  })

  test("rejects a goal step nested in a parallel block", () => {
    expect(() => resolveGoal({ steps: [{ parallel: [{ agent: "implementer" }, goalNode() as never] }] })).toThrow(/parallel/)
  })

  test("rejects a goal step nested inside a goal fragment", () => {
    expect(() =>
      resolveGoal({
        steps: [...prefix(), goalNode({ improve: { briefStep: "fix", steps: [goalNode()] } })],
      }),
    ).toThrow(/nest a goal step inside a goal fragment/)
  })

  test("rejects empty improve and measure fragments", () => {
    expect(() => resolveGoal({ steps: [...prefix(), goalNode({ improve: { briefStep: "fix", steps: [] } })] })).toThrow(
      /goal\.improve\.steps must be a non-empty list/,
    )
    expect(() => resolveGoal({ steps: [...prefix(), goalNode({ measure: { steps: [] } })] })).toThrow(
      /goal\.measure\.steps must be a non-empty list/,
    )
  })

  test("rejects human steps inside a goal fragment", () => {
    expect(() =>
      resolveGoal({
        steps: [...prefix(), goalNode({ improve: { briefStep: "fix", steps: [{ agent: "review-fixer", name: "fix" }, { type: "human", name: "gate" }] } })],
      }),
    ).toThrow(/human step inside a goal fragment/)
  })

  test("rejects a briefStep that names no improve step or names several", () => {
    expect(() => resolveGoal({ steps: [...prefix(), goalNode({ improve: { briefStep: "nope", steps: [{ agent: "review-fixer", name: "fix" }] } })] })).toThrow(
      /briefStep "nope" does not name an improve step/,
    )

    // A models fan-out produces several resolved steps under one briefStep
    // name: the brief would go to every variant, so it is ambiguous rather
    // than directed.
    expect(() =>
      resolveGoal({
        steps: [
          ...prefix(),
          goalNode({
            improve: { briefStep: "fix", steps: [{ agent: "review-fixer", name: "fix", models: [defaultAdversarialModel, "openrouter/z-ai/glm-5.3#high"] }] },
          }),
        ],
      }),
    ).toThrow(/matches 2 improve steps/)
  })

  test("rejects a measure fragment that can modify the repository", () => {
    expect(() =>
      resolveGoal({ steps: [...prefix(), goalNode({ measure: { steps: [{ agent: "implementer", name: "score" }] } })] }),
    ).toThrow(/goal\.measure must be read-only/)
  })

  test("rejects a measure fragment that does not end in exactly one quality-score deliverable", () => {
    expect(() =>
      resolveGoal({ steps: [...prefix(), goalNode({ measure: { steps: [{ agent: "review-scope", name: "check", reports: "none" }] } })] }),
    ).toThrow(/quality score/)
    expect(() =>
      resolveGoal({
        steps: [
          ...prefix(),
          goalNode({
            measure: { steps: [{ agent: "quality-score-report", name: "score-report", reports: "none" }, { agent: "review-scope", name: "after", reports: "none" }] },
          }),
        ],
      }),
    ).toThrow(/must end in exactly one/)
  })

  test("fragment report selectors resolve only within their own invocation", () => {
    // The pipeline prefix has a "report" step, but a measure fragment that
    // names it must fail: fragments resolve with an empty report namespace, so
    // a measurement cannot read prefix or previous-round reports.
    const crossRound: PipelineSpec = {
      steps: [
        { agent: "review-scope", name: "scope", reports: "none" },
        goalNode({
          measure: {
            steps: [
              { agent: "review-scope", name: "evidence", reports: ["scope"] },
              { agent: "quality-score-report", name: "score-report", reports: ["evidence"] },
            ],
          },
        }),
      ],
    }
    expect(() => resolveGoal(crossRound)).toThrow(/not an earlier agent step/)
  })

  test("an arbitrarily named repair and consensus resolve without reserved names", () => {
    const spec: PipelineSpec = {
      steps: [
        ...prefix(),
        {
          goal: {
            target: 80,
            improve: {
              briefStep: "repair",
              steps: [{ agent: "implementation-fixer", name: "repair", reports: "none", diff: true, deliverable: "markdown" }],
            },
            measure: {
              steps: [
                { parallel: [{ agent: "quality-scorer", name: "grade", models: [defaultAdversarialModel, "openrouter/z-ai/glm-5.3#high"], reports: "none" }] },
                { agent: "review-report", name: "arbiter", model: "openai/gpt-5.6-sol#xhigh", reports: ["grade"], deliverable: "quality-score" },
              ],
            },
          },
        },
      ],
    }
    const goal = resolveGoal(spec).goalPlan!
    expect(goal.briefRecipient).toBe("repair")
    expect(goal.scoreProducer).toBe("arbiter")
  })
})
