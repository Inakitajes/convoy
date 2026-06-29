import type { AgentSpec, AgentStep, HumanStep, Pipeline, Step } from "./types"

export const defaultGptModel = "openai/gpt-5.5"
export const defaultGptVariant = "xhigh"
export const defaultOpusModel = "anthropic/claude-opus-4-7"

const fallbackModel = `${defaultGptModel}#${defaultGptVariant}`

/** Reserved step keyword: pauses the pipeline for the manual review gate. */
export const humanReviewStep = "human-review"
const humanReviewDescription = "Manual review checkpoint"

export const builtInAgents: readonly AgentSpec[] = [
  {
    name: "implementer",
    description: "Implements the feature described in the PRD respecting repo patterns",
    defaultModel: fallbackModel,
    builtIn: true,
  },
  {
    name: "pattern-auditor",
    description: "Audits patterns and best practices, applies refactoring without changing behavior",
    defaultModel: fallbackModel,
    builtIn: true,
  },
  {
    name: "security-auditor",
    description: "Audits the new implementation for security issues and fixes them",
    defaultModel: fallbackModel,
    builtIn: true,
  },
  {
    name: "design-polisher",
    description: "Polishes new UI following the repo's design system, without redesigning",
    defaultModel: defaultOpusModel,
    temperature: 0.2,
    builtIn: true,
  },
  {
    name: "test-engineer",
    description: "Ensures automated tests and relevant E2E coverage",
    defaultModel: fallbackModel,
    builtIn: true,
  },
  {
    name: "adversarial-reviewer",
    description: "Final adversarial reviewer before PR creation",
    defaultModel: defaultOpusModel,
    temperature: 0.1,
    builtIn: true,
  },
]

/** Short names accepted in pipeline steps for the built-in agents. */
export const agentAliases: Record<string, string> = {
  patterns: "pattern-auditor",
  security: "security-auditor",
  design: "design-polisher",
  tests: "test-engineer",
  adversarial: "adversarial-reviewer",
}

/**
 * A pipeline as written in config: a list of steps referencing agents by name
 * (or alias), plus the reserved "human-review" keyword. Strings are shorthand
 * for `{ agent: <string> }`.
 */
export type StepSpec =
  | string
  | {
      agent: string
      name?: string
      model?: string
      maxAttempts?: number
      /** Which previous step reports to attach: the nearest one (default), all of them, none, or an explicit list of step names. */
      reports?: "previous" | "all" | "none" | string[]
      /** Attach the cumulative diff against the base branch. Defaults to true except for the first agent step. */
      diff?: boolean
    }

export type PipelineSpec = {
  description?: string
  steps: StepSpec[]
}

export const builtInPipelines: Record<string, PipelineSpec> = {
  default: {
    description: "Implementation, pattern/security audits, design polish, tests, and adversarial review",
    steps: [
      { agent: "implementer", reports: "none" },
      humanReviewStep,
      "patterns",
      "security",
      "design",
      { agent: "tests", reports: "none" },
      { agent: "adversarial", reports: "all" },
    ],
  },
}

/** Splits the `provider/model#variant` shorthand used everywhere a model is configured. */
export function splitModelVariant(value: string): { model: string; variant?: string } {
  const index = value.indexOf("#")
  if (index === -1) return { model: value }
  const model = value.slice(0, index)
  const variant = value.slice(index + 1)
  if (!model || !variant) throw new Error(`invalid model: ${value}`)
  return { model, variant }
}

export type ResolvePipelineInput = {
  name: string
  spec: PipelineSpec
  agents: readonly AgentSpec[]
  /** Project-wide defaults.model; beats built-in agent preferences, loses to step/agent models. */
  defaultModel?: string
}

/**
 * Turns a pipeline spec into concrete steps: resolves agent aliases, derives
 * step names and report paths, applies the model precedence chain
 * (step > agent > defaults.model > built-in preference > gpt default), and
 * wires each step's inputs (prd + previous reports + diff) by convention.
 */
export function resolvePipeline(input: ResolvePipelineInput): Pipeline {
  const steps: Step[] = []
  const agentSteps: AgentStep[] = []
  const names = new Set<string>()
  let humanCount = 0

  const claimName = (name: string, position: number) => {
    if (name === humanReviewStep || name.startsWith(`${humanReviewStep}-`)) {
      throw new Error(`pipeline "${input.name}": step ${position} can't use the reserved name "${name}"`)
    }
    if (names.has(name)) {
      throw new Error(`pipeline "${input.name}": duplicate step name "${name}"; set an explicit name: on one of them`)
    }
    names.add(name)
  }

  for (const [index, raw] of input.spec.steps.entries()) {
    const position = index + 1
    const spec = typeof raw === "string" ? { agent: raw } : raw

    if (spec.agent === humanReviewStep) {
      humanCount++
      const name = humanCount === 1 ? humanReviewStep : `${humanReviewStep}-${humanCount}`
      names.add(name)
      const step: HumanStep = { type: "human", name, description: humanReviewDescription }
      steps.push(step)
      continue
    }

    const agent = findAgent(spec.agent, input.agents)
    if (!agent) {
      const known = [...input.agents.map((candidate) => candidate.name), ...Object.keys(agentAliases), humanReviewStep]
      throw new Error(`pipeline "${input.name}": step ${position} references unknown agent "${spec.agent}" (known: ${known.join(", ")})`)
    }

    const name = spec.name ?? spec.agent
    claimName(name, position)

    const { model, variant } = splitModelVariant(spec.model ?? agent.model ?? input.defaultModel ?? agent.defaultModel ?? fallbackModel)
    const step: AgentStep = {
      type: "agent",
      name,
      agentName: agent.name,
      description: agent.description,
      model,
      ...(variant ? { variant } : {}),
      inputFiles: ["prd.md", ...reportInputs(input.name, name, spec.reports ?? "previous", agentSteps)],
      inputDiff: spec.diff ?? agentSteps.length > 0,
      reportPath: `reports/${name}.md`,
      ...(agent.readOnly ? { readOnly: true } : {}),
      ...(spec.maxAttempts !== undefined ? { maxAttempts: spec.maxAttempts } : {}),
    }
    steps.push(step)
    agentSteps.push(step)
  }

  if (agentSteps.length === 0) {
    throw new Error(`pipeline "${input.name}" has no agent steps`)
  }

  return { name: input.name, ...(input.spec.description ? { description: input.spec.description } : {}), steps }
}

function findAgent(ref: string, agents: readonly AgentSpec[]): AgentSpec | undefined {
  const name = agentAliases[ref] ?? ref
  return agents.find((agent) => agent.name === name)
}

function reportInputs(pipelineName: string, stepName: string, mode: "previous" | "all" | "none" | string[], previous: readonly AgentStep[]): string[] {
  if (mode === "none") return []
  if (mode === "previous") {
    const last = previous[previous.length - 1]
    return last ? [last.reportPath] : []
  }
  if (mode === "all") return previous.map((step) => step.reportPath)

  return mode.map((name) => {
    const step = previous.find((candidate) => candidate.name === name)
    if (!step) {
      throw new Error(`pipeline "${pipelineName}": step "${stepName}" wants the report of "${name}", which is not an earlier agent step`)
    }
    return step.reportPath
  })
}

/** Step names valid for --only/--skip in this pipeline. */
export function stepNames(pipeline: Pipeline): string[] {
  return pipeline.steps.map((step) => step.name)
}

export function validateStepFilters(pipeline: Pipeline, filters: { onlySteps: string[]; skipSteps: string[] }) {
  const valid = new Set(stepNames(pipeline))
  for (const [flag, names] of [
    ["--only", filters.onlySteps],
    ["--skip", filters.skipSteps],
  ] as const) {
    for (const name of names) {
      if (valid.has(name)) continue
      // Human gates may already be filtered out (--no-human-review, no TTY);
      // referencing them must not turn into a typo error.
      if (name === humanReviewStep || name.startsWith(`${humanReviewStep}-`)) continue
      throw new Error(`${flag}: unknown step "${name}" in pipeline "${pipeline.name}" (valid: ${[...valid].join(", ")})`)
    }
  }
}

export function defaultPipeline(): Pipeline {
  return resolvePipeline({ name: "default", spec: builtInPipelines.default!, agents: builtInAgents })
}
