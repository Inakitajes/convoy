import { describe, expect, test } from "bun:test"

import {
  builtInAgents,
  defaultPipeline,
  resolvePipeline,
  splitModelVariant,
  stepNames,
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
  test("matches the historical six phases plus the human gate", () => {
    const pipeline = defaultPipeline()

    expect(stepNames(pipeline)).toEqual(["implementer", "human-review", "patterns", "security", "design", "tests", "adversarial"])
    expect(pipeline.steps[1]?.type).toBe("human")
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

  test("keeps the historical model split: gpt for audits, opus for design and adversarial", () => {
    const byName = Object.fromEntries(
      defaultPipeline()
        .steps.filter((step): step is AgentStep => step.type === "agent")
        .map((step) => [step.name, step]),
    )

    expect(byName.implementer).toMatchObject({ model: "openai/gpt-5.5", variant: "xhigh" })
    expect(byName.design).toMatchObject({ model: "anthropic/claude-opus-4-7" })
    expect(byName.design?.variant).toBeUndefined()
    expect(byName.adversarial?.model).toBe("anthropic/claude-opus-4-7")
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
    const [, after] = agentSteps({ steps: ["implementer", "human-review", "tests"] })
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
    expect(withoutDefault[1]).toMatchObject({ model: "anthropic/claude-opus-4-7" })

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
})

describe("step filters", () => {
  test("validates --only/--skip names against the pipeline, tolerating human gates", () => {
    const pipeline = defaultPipeline()

    expect(() => validateStepFilters(pipeline, { onlySteps: ["implementer"], skipSteps: ["tests"] })).not.toThrow()
    expect(() => validateStepFilters(pipeline, { onlySteps: ["secuirty"], skipSteps: [] })).toThrow('unknown step "secuirty"')

    const headless = { ...pipeline, steps: pipeline.steps.filter((step) => step.type !== "human") }
    expect(() => validateStepFilters(headless, { onlySteps: [], skipSteps: ["human-review"] })).not.toThrow()
  })
})
