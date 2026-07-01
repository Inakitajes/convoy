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
export type AgentStepSpec = {
  agent: string
  name?: string
  model?: string
  /** Fans this step out into one concurrent, forced-read-only invocation per model. Mutually exclusive with `model`. */
  models?: string[]
  maxAttempts?: number
  /** Which previous step reports to attach: the nearest group (default), all of them, none, or an explicit list of step names. */
  reports?: "previous" | "all" | "none" | string[]
  /** Attach the cumulative diff against the base branch. Defaults to true except for the first agent step. */
  diff?: boolean
}

/** A group of steps that run concurrently, forced read-only. No nesting, no human-review members. */
export type ParallelStepSpec = {
  parallel: (string | AgentStepSpec)[]
}

export type StepSpec = string | AgentStepSpec | ParallelStepSpec

export type PipelineSpec = {
  description?: string
  steps: StepSpec[]
}

/** Suffix reserved for archer's synthesized forced-read-only agent variants; project agents can't use it. */
export const readOnlyAgentSuffix = "__ro"

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
 *
 * Steps inside the same `parallel:` block, or produced by fanning one step
 * out across `models:`, share a `groupId` and are always forced read-only —
 * the runner batches same-groupId steps to run concurrently, and since none
 * of them can touch the working tree, they can't step on each other. Their
 * `inputFiles` are resolved against the steps that finished before their
 * group started, never against groupmates running concurrently with them.
 */
export function resolvePipeline(input: ResolvePipelineInput): Pipeline {
  const steps: Step[] = []
  const agentSteps: AgentStep[] = []
  const names = new Set<string>()
  let humanCount = 0

  const claimName = (name: string, position: string) => {
    if (name === humanReviewStep || name.startsWith(`${humanReviewStep}-`)) {
      throw new Error(`pipeline "${input.name}": step ${position} can't use the reserved name "${name}"`)
    }
    if (names.has(name)) {
      throw new Error(`pipeline "${input.name}": duplicate step name "${name}"; set an explicit name: on one of them`)
    }
    names.add(name)
  }

  for (const [index, raw] of input.spec.steps.entries()) {
    const position = String(index + 1)
    const groupId = `g${index + 1}`

    if (isParallelSpec(raw)) {
      if (raw.parallel.length === 0) {
        throw new Error(`pipeline "${input.name}": step ${position} is an empty parallel block`)
      }
      for (const inner of raw.parallel) {
        if (typeof inner === "object" && inner !== null && "parallel" in inner) {
          throw new Error(`pipeline "${input.name}": step ${position} can't nest a parallel block inside another`)
        }
      }
      const members = raw.parallel.flatMap((inner, innerIndex) =>
        resolveAgentStepSpec(inner, {
          input,
          position: `${position}.${innerIndex + 1}`,
          groupId,
          forcedReadOnly: true,
          priorSteps: agentSteps,
          claimName,
        }),
      )
      steps.push(...members)
      agentSteps.push(...members)
      continue
    }

    const spec = typeof raw === "string" ? { agent: raw } : raw

    if (spec.agent === humanReviewStep) {
      humanCount++
      const name = humanCount === 1 ? humanReviewStep : `${humanReviewStep}-${humanCount}`
      names.add(name)
      const step: HumanStep = { type: "human", name, description: humanReviewDescription }
      steps.push(step)
      continue
    }

    const members = resolveAgentStepSpec(spec, {
      input,
      position,
      groupId,
      forcedReadOnly: Boolean(spec.models && spec.models.length > 0),
      priorSteps: agentSteps,
      claimName,
    })
    steps.push(...members)
    agentSteps.push(...members)
  }

  if (agentSteps.length === 0) {
    throw new Error(`pipeline "${input.name}" has no agent steps`)
  }

  return { name: input.name, ...(input.spec.description ? { description: input.spec.description } : {}), steps }
}

export function isParallelSpec(raw: StepSpec): raw is ParallelStepSpec {
  return typeof raw === "object" && raw !== null && "parallel" in raw
}

type ResolveStepContext = {
  input: ResolvePipelineInput
  /** Human-readable position for error messages; may be dotted (e.g. "3.2") inside a parallel block. */
  position: string
  groupId: string
  /** True when every variant of this step must be forced read-only (inside a parallel block, or fanned out across models). */
  forcedReadOnly: boolean
  /** Steps that finished resolving before this step's group started; never includes groupmates. */
  priorSteps: readonly AgentStep[]
  claimName: (name: string, position: string) => void
}

/** Resolves one step spec into one or more AgentSteps: more than one only when `models:` fans it out. */
function resolveAgentStepSpec(raw: string | AgentStepSpec, ctx: ResolveStepContext): AgentStep[] {
  const spec = typeof raw === "string" ? { agent: raw } : raw

  if (spec.agent === humanReviewStep) {
    throw new Error(`pipeline "${ctx.input.name}": step ${ctx.position} can't use "human-review" inside a parallel block`)
  }

  const agent = findAgent(spec.agent, ctx.input.agents)
  if (!agent) {
    const known = [...ctx.input.agents.map((candidate) => candidate.name), ...Object.keys(agentAliases), humanReviewStep]
    throw new Error(`pipeline "${ctx.input.name}": step ${ctx.position} references unknown agent "${spec.agent}" (known: ${known.join(", ")})`)
  }

  const baseName = spec.name ?? spec.agent
  if (spec.models !== undefined && spec.model !== undefined) {
    throw new Error(`pipeline "${ctx.input.name}": step ${ctx.position} ("${baseName}") can't set both "model" and "models"`)
  }
  if (spec.models !== undefined && spec.models.length < 2) {
    throw new Error(`pipeline "${ctx.input.name}": step ${ctx.position} ("${baseName}")'s "models" needs at least 2 entries; use "model" for a single one`)
  }

  const models = spec.models
  const forced = ctx.forcedReadOnly || Boolean(models)
  const variants = models ?? [spec.model ?? agent.model ?? ctx.input.defaultModel ?? agent.defaultModel ?? fallbackModel]
  const agentName = forced && !agent.readOnly ? `${agent.name}${readOnlyAgentSuffix}` : agent.name

  return variants.map((modelValue, variantIndex) => {
    const name = models ? `${baseName}__${slugifyModel(modelValue)}` : baseName
    ctx.claimName(name, models ? `${ctx.position}[${variantIndex + 1}]` : ctx.position)

    const { model, variant } = splitModelVariant(modelValue)
    const step: AgentStep = {
      type: "agent",
      name,
      stepName: baseName,
      groupId: ctx.groupId,
      agentName,
      description: agent.description,
      model,
      ...(variant ? { variant } : {}),
      inputFiles: ["prd.md", ...reportInputs(ctx.input.name, name, spec.reports ?? "previous", ctx.priorSteps)],
      inputDiff: spec.diff ?? ctx.priorSteps.length > 0,
      reportPath: `reports/${name}.md`,
      ...(forced || agent.readOnly ? { readOnly: true } : {}),
      ...(spec.maxAttempts !== undefined ? { maxAttempts: spec.maxAttempts } : {}),
    }
    return step
  })
}

function findAgent(ref: string, agents: readonly AgentSpec[]): AgentSpec | undefined {
  const name = agentAliases[ref] ?? ref
  return agents.find((agent) => agent.name === name)
}

function reportInputs(pipelineName: string, stepName: string, mode: "previous" | "all" | "none" | string[], previous: readonly AgentStep[]): string[] {
  if (mode === "none") return []
  if (mode === "previous") {
    const lastGroupId = previous[previous.length - 1]?.groupId
    if (lastGroupId === undefined) return []
    return previous.filter((step) => step.groupId === lastGroupId).map((step) => step.reportPath)
  }
  if (mode === "all") return previous.map((step) => step.reportPath)

  // A name can match every model variant of a fanned-out step (by its shared
  // stepName) as well as one specific variant (by its full disambiguated name).
  return mode.flatMap((name) => {
    const matches = previous.filter((candidate) => candidate.name === name || candidate.stepName === name)
    if (matches.length === 0) {
      throw new Error(`pipeline "${pipelineName}": step "${stepName}" wants the report of "${name}", which is not an earlier agent step`)
    }
    return matches.map((step) => step.reportPath)
  })
}

/** Turns a `provider/model#variant` string into a filesystem/identifier-safe slug, used to disambiguate a step fanned out across `models:`. */
export function slugifyModel(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

/**
 * Builds the forced-read-only agent variants a resolved pipeline references:
 * steps whose `agentName` was suffixed by `resolvePipeline` because their
 * base agent isn't already read-only. Register these alongside the normal
 * agent registry so the OpenCode server config has a matching entry for each.
 */
export function synthesizeReadOnlyAgents(pipeline: Pipeline, baseAgents: readonly AgentSpec[]): AgentSpec[] {
  const synthesized = new Map<string, AgentSpec>()
  for (const step of pipeline.steps) {
    if (step.type !== "agent" || !step.agentName.endsWith(readOnlyAgentSuffix)) continue
    if (synthesized.has(step.agentName)) continue
    const baseName = step.agentName.slice(0, -readOnlyAgentSuffix.length)
    const base = baseAgents.find((agent) => agent.name === baseName)
    if (!base) {
      throw new Error(`pipeline "${pipeline.name}": step "${step.name}" needs forced-read-only agent "${step.agentName}", but base agent "${baseName}" is not defined`)
    }
    synthesized.set(step.agentName, { ...base, name: step.agentName, readOnly: true })
  }
  return [...synthesized.values()]
}

/** Step names valid for --only/--skip in this pipeline: each step's full name plus, for fanned-out steps, their shared logical name. */
export function stepNames(pipeline: Pipeline): string[] {
  return pipeline.steps.map((step) => step.name)
}

export function validateStepFilters(pipeline: Pipeline, filters: { onlySteps: string[]; skipSteps: string[] }) {
  const valid = new Set(stepNames(pipeline))
  for (const step of pipeline.steps) {
    if (step.type === "agent") valid.add(step.stepName)
  }
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
