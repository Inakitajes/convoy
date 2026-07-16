import { describe, expect, test } from "bun:test"

import {
  builtInAgents,
  builtInPipelines,
  defaultImplementReviewModel,
  defaultPipeline,
  resolvePipeline,
  slugifyModel,
  splitModelVariant,
  stepNames,
  synthesizeReadOnlyAgents,
  validateStepFilters,
  type PipelineSpec,
} from "../src/pipeline"
import type { AgentStep } from "../src/types"

const resolve = (spec: PipelineSpec, defaultModel?: string) =>
  resolvePipeline({ name: "test", spec, agents: builtInAgents, defaultModel })

const agentSteps = (spec: PipelineSpec) => resolve(spec).steps.filter((step): step is AgentStep => step.type === "agent")

describe("model shorthand", () => {
  test("splits provider/model#variant", () => {
    expect(splitModelVariant("openai/gpt-5.5#xhigh")).toEqual({ model: "openai/gpt-5.5", variant: "xhigh" })
    expect(splitModelVariant("anthropic/claude-opus-4-7")).toEqual({ model: "anthropic/claude-opus-4-7" })
    expect(() => splitModelVariant("openai/gpt-5.5#")).toThrow("invalid model")
    expect(() => splitModelVariant("#xhigh")).toThrow("invalid model")
  })
})

describe("default pipeline", () => {
  test("matches the historical six phases", () => {
    const pipeline = defaultPipeline()

    expect(stepNames(pipeline)).toEqual(["implementer", "patterns", "security", "design", "tests", "adversarial"])
    expect(pipeline.steps.some((step) => step.type === "human")).toBe(false)
  })

  test("wires inputs by convention exactly like the static pipeline did", () => {
    const steps = Object.fromEntries(
      defaultPipeline()
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

  test("uses GPT for implementation/audits and GLM 5.2 for design/adversarial", () => {
    const byName = Object.fromEntries(
      defaultPipeline()
        .steps.filter((step): step is AgentStep => step.type === "agent")
        .map((step) => [step.name, step]),
    )

    expect(byName.implementer).toMatchObject({ model: "openai/gpt-5.6-terra", variant: "xhigh" })
    expect(byName.design).toMatchObject({ model: defaultImplementReviewModel })
    expect(byName.design?.variant).toBeUndefined()
    expect(byName.adversarial?.model).toBe(defaultImplementReviewModel)
  })

  test("keeps implement design/adversarial on GLM 5.2 even when defaults.model is GPT", () => {
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

    expect(byName.design?.model).toBe(defaultImplementReviewModel)
    expect(byName.adversarial?.model).toBe(defaultImplementReviewModel)
  })
})

describe("built-in implement-lite pipeline", () => {
  const implementLite = (defaultModel?: string) =>
    resolvePipeline({ name: "implement-lite", spec: builtInPipelines["implement-lite"]!, agents: builtInAgents, defaultModel })

  test("keeps the implement workflow and agents while swapping GPT phases to GLM 5.2", () => {
    const lite = implementLite().steps.filter((step): step is AgentStep => step.type === "agent")
    const standard = defaultPipeline().steps.filter((step): step is AgentStep => step.type === "agent")

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
    expect(byName.implementer?.model).toBe("openrouter/z-ai/glm-5.2")
    expect(byName.patterns?.model).toBe("openrouter/z-ai/glm-5.2")
    expect(byName.security?.model).toBe("openrouter/z-ai/glm-5.2")
    expect(byName.tests?.model).toBe("openrouter/z-ai/glm-5.2")
    expect(byName.design?.model).toBe("anthropic/claude-opus-4-8")
    expect(byName.adversarial?.model).toBe("anthropic/claude-opus-4-8")
  })

  test("does not reintroduce GPT through defaults.model", () => {
    const byName = Object.fromEntries(
      implementLite("openai/gpt-5.5#xhigh")
        .steps.filter((step): step is AgentStep => step.type === "agent")
        .map((step) => [step.name, step]),
    )

    expect(byName.implementer).toMatchObject({ model: "openrouter/z-ai/glm-5.2" })
    expect(byName.patterns).toMatchObject({ model: "openrouter/z-ai/glm-5.2" })
    expect(byName.security).toMatchObject({ model: "openrouter/z-ai/glm-5.2" })
    expect(byName.tests).toMatchObject({ model: "openrouter/z-ai/glm-5.2" })
    expect(byName.design).toMatchObject({ model: "anthropic/claude-opus-4-8" })
    expect(byName.adversarial).toMatchObject({ model: "anthropic/claude-opus-4-8" })
  })

  test("keeps GLM 5.2 scoped to the implementation, lite, and refine pipelines", () => {
    const glmPipelines = Object.entries(builtInPipelines)
      .filter(([, spec]) => JSON.stringify(spec).includes("openrouter/z-ai/glm-5.2"))
      .map(([name]) => name)

    expect(glmPipelines).toEqual(["implement", "implement-lite", "review-lite", "refine"])
  })
})

describe("built-in review pipeline", () => {
  const review = () => resolvePipeline({ name: "review", spec: builtInPipelines.review!, agents: builtInAgents })

  test("is report-only: every step is read-only and there is no human gate", () => {
    const pipeline = review()
    const agents = pipeline.steps.filter((step): step is AgentStep => step.type === "agent")
    expect(agents.length).toBeGreaterThan(0)
    expect(agents.every((step) => step.readOnly)).toBe(true)
    expect(pipeline.steps.some((step) => step.type === "human")).toBe(false)
  })

  test("fans each audit across GPT 5.6 Terra xhigh + opus and feeds a single report step with every audit", () => {
    const pipeline = review()
    expect(stepNames(pipeline)).toEqual([
      "scope",
      "clean-code__openai-gpt-5-6-terra-xhigh",
      "clean-code__anthropic-claude-opus-4-8",
      "security__openai-gpt-5-6-terra-xhigh",
      "security__anthropic-claude-opus-4-8",
      "bugs__openai-gpt-5-6-terra-xhigh",
      "bugs__anthropic-claude-opus-4-8",
      "report",
    ])

    const report = pipeline.steps.find((step): step is AgentStep => step.type === "agent" && step.stepName === "report")
    expect(report?.inputFiles).toEqual([
      "prd.md",
      "reports/scope.md",
      "reports/clean-code__openai-gpt-5-6-terra-xhigh.md",
      "reports/clean-code__anthropic-claude-opus-4-8.md",
      "reports/security__openai-gpt-5-6-terra-xhigh.md",
      "reports/security__anthropic-claude-opus-4-8.md",
      "reports/bugs__openai-gpt-5-6-terra-xhigh.md",
      "reports/bugs__anthropic-claude-opus-4-8.md",
    ])
  })
})

describe("built-in review-lite pipeline", () => {
  const reviewLite = () => resolvePipeline({ name: "review-lite", spec: builtInPipelines["review-lite"]!, agents: builtInAgents })

  test("is report-only: every step is read-only and there is no human gate", () => {
    const pipeline = reviewLite()
    const agents = pipeline.steps.filter((step): step is AgentStep => step.type === "agent")
    expect(agents.length).toBeGreaterThan(0)
    expect(agents.every((step) => step.readOnly)).toBe(true)
    expect(pipeline.steps.some((step) => step.type === "human")).toBe(false)
  })

  test("swaps scope and the first audit slot to GLM 5.2 while keeping opus for the second slot and the report", () => {
    const pipeline = reviewLite()
    expect(stepNames(pipeline)).toEqual([
      "scope",
      "clean-code__openrouter-z-ai-glm-5-2",
      "clean-code__anthropic-claude-opus-4-8",
      "security__openrouter-z-ai-glm-5-2",
      "security__anthropic-claude-opus-4-8",
      "bugs__openrouter-z-ai-glm-5-2",
      "bugs__anthropic-claude-opus-4-8",
      "report",
    ])

    const byName = Object.fromEntries(
      pipeline.steps.filter((step): step is AgentStep => step.type === "agent").map((step) => [step.name, step]),
    )
    expect(byName.scope?.model).toBe("openrouter/z-ai/glm-5.2")
    expect(byName.report?.model).toBe("anthropic/claude-opus-4-8")
    expect(byName.report?.inputFiles).toEqual([
      "prd.md",
      "reports/scope.md",
      "reports/clean-code__openrouter-z-ai-glm-5-2.md",
      "reports/clean-code__anthropic-claude-opus-4-8.md",
      "reports/security__openrouter-z-ai-glm-5-2.md",
      "reports/security__anthropic-claude-opus-4-8.md",
      "reports/bugs__openrouter-z-ai-glm-5-2.md",
      "reports/bugs__anthropic-claude-opus-4-8.md",
    ])
  })
})

describe("built-in refine pipeline", () => {
  test("scopes with GLM 5.2, audits/fixes/validates with GPT 5.6 Terra xhigh, and triages with opus", () => {
    const byName = Object.fromEntries(
      resolvePipeline({ name: "refine", spec: builtInPipelines.refine!, agents: builtInAgents })
        .steps.filter((step): step is AgentStep => step.type === "agent")
        .map((step) => [step.name, step]),
    )

    expect(byName.scope).toMatchObject({ model: "openrouter/z-ai/glm-5.2" })
    expect(byName.bugs).toMatchObject({ model: "openai/gpt-5.6-terra", variant: "xhigh" })
    expect(byName["clean-code"]).toMatchObject({ model: "openai/gpt-5.6-terra", variant: "xhigh" })
    expect(byName.security).toMatchObject({ model: "openai/gpt-5.6-terra", variant: "xhigh" })
    expect(byName.triage).toMatchObject({ model: "anthropic/claude-opus-4-8" })
    expect(byName.fixes).toMatchObject({ model: "openai/gpt-5.6-terra", variant: "xhigh" })
    expect(byName.validator).toMatchObject({ model: "openai/gpt-5.6-terra", variant: "xhigh" })
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
    expect(withoutDefault[1]).toMatchObject({ model: "anthropic/claude-opus-4-8" })

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

  test("numbers repeated human gates and threads per-step attempts", () => {
    const pipeline = resolve({
      steps: ["implementer", "human-review", { agent: "tests", maxAttempts: 3 }, "human-review"],
    })

    expect(stepNames(pipeline)).toEqual(["implementer", "human-review", "tests", "human-review-2"])
    const tests = pipeline.steps[2]
    if (tests?.type === "agent") expect(tests.maxAttempts).toBe(3)
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
    const pipeline = defaultPipeline()

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
    expect(synthesizeReadOnlyAgents(defaultPipeline(), builtInAgents)).toEqual([])
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

  test("rejects claude-code combined with a models: fan-out", () => {
    expect(() =>
      agentSteps({
        steps: [{ agent: "bug-auditor", runner: "claude-code", models: ["openai/gpt-5.5#xhigh", "anthropic/claude-opus-4-8"] }],
      }),
    ).toThrow(/models/)
  })
})
