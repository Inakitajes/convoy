import { normalizeStepRunnerModel, stepRunnerFor } from "./step-runners"
import type { AgentSpec, AgentStep, HumanStep, Pipeline, Step, StepRunner } from "./types"

export const defaultGptModel = "openai/gpt-5.6-terra"
export const defaultGptVariant = "xhigh"
export const defaultOpusModel = "anthropic/claude-opus-4-8"
export const defaultImplementReviewModel = "openrouter/z-ai/glm-5.2"

const fallbackModel = `${defaultGptModel}#${defaultGptVariant}`

/** Second model the built-in ultra pipelines fan their audits across; a project can override per step. */
const sonnetModel = "openrouter/anthropic/claude-sonnet-5"
/** Lower-cost replacement for the GPT xhigh phases in the lightweight pipelines. */
const glmModel = "openrouter/z-ai/glm-5.2"

/** Legacy reserved step keyword: pauses the pipeline for a manual human gate. */
export const humanReviewStep = "human-review"
export const humanStepType = "human"
const humanReviewDescription = "Manual review checkpoint"
const humanStepDescription = "Human checkpoint"

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
  // Review pipelines: shared audit agents (report-only `review` and change-applying `refine`/`ultra-refine`).
  {
    name: "review-scope",
    description: "Audit-only collector for branch scope and repository patterns",
    defaultModel: fallbackModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "bug-auditor",
    description: "Audit-only reviewer for bugs, regressions, and functional risks",
    defaultModel: fallbackModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "clean-code-auditor",
    description: "Audit-only reviewer for pattern alignment and maintainability risks",
    defaultModel: fallbackModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "security-reviewer",
    description: "Audit-only reviewer for security, privacy, and operational risks",
    defaultModel: fallbackModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "review-adversary",
    description: "Adversarial reviewer that validates and filters audit findings before fixes",
    defaultModel: defaultOpusModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "review-fixer",
    description: "Applies only triaged review fixes without adding new scope",
    defaultModel: fallbackModel,
    temperature: 0.1,
    builtIn: true,
  },
  {
    name: "review-validator",
    description: "Final no-edit validator for applied review fixes",
    defaultModel: fallbackModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "review-report",
    description: "Synthesizes parallel audits into one prioritized, report-only findings summary",
    defaultModel: defaultOpusModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  // ultra-implement: final-review stage over the whole PR.
  {
    name: "implementation-triage",
    description: "Synthesizes parallel pattern/security/adversarial findings into one action plan",
    defaultModel: defaultOpusModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "implementation-final-review",
    description: "Final audit-only adversarial review of the whole PR; classifies blocking vs non-blocking findings",
    defaultModel: defaultOpusModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "implementation-fixer",
    description: "Applies only the blocking findings from the final review",
    defaultModel: fallbackModel,
    temperature: 0.1,
    builtIn: true,
  },
  {
    name: "implementation-validator",
    description: "Final no-edit validator for applied blocking-finding fixes",
    defaultModel: defaultOpusModel,
    temperature: 0.1,
    readOnly: true,
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
 * (or alias), plus human gate steps. Strings are shorthand for
 * `{ agent: <string> }`, except the legacy `human-review` string which remains
 * a shorthand for a human gate.
 */
export type AgentStepSpec = {
  agent: string
  name?: string
  model?: string
  /** Fans this step out into one concurrent, forced-read-only invocation per model. Mutually exclusive with `model`. */
  models?: string[]
  /** Execution engine. Default is OpenCode; "claude-code" spawns the local `claude` CLI (read-only audit steps only). */
  runner?: "opencode" | StepRunner
  maxAttempts?: number
  /** Which previous step reports to attach: the nearest group (default), all of them, none, or an explicit list of step names. */
  reports?: "previous" | "all" | "none" | string[]
  /** Attach the cumulative diff against the base branch. Defaults to true except for the first agent step. */
  diff?: boolean
}

export type HumanStepSpec = {
  type: typeof humanStepType
  /** Optional step/report name. Defaults to `human`, `human-2`, etc. */
  name?: string
  /** Optional dashboard/report description. */
  description?: string
}

/** A group of steps that run concurrently, forced read-only. No nesting, no human members. */
export type ParallelStepSpec = {
  parallel: (string | AgentStepSpec)[]
}

export type StepSpec = string | AgentStepSpec | HumanStepSpec | ParallelStepSpec

export type PipelineSpec = {
  description?: string
  steps: StepSpec[]
}

/** Suffix reserved for convoy's synthesized forced-read-only agent variants; project agents can't use it. */
export const readOnlyAgentSuffix = "__ro"

/** The pipeline run when none is selected (no -p flag and no defaults.pipeline). */
export const defaultPipelineName = "implement"

export const builtInPipelines: Record<string, PipelineSpec> = {
  implement: {
    description: "Implementation, pattern/security audits, design polish, tests, and adversarial review",
    steps: [
      { agent: "implementer", reports: "none" },
      "patterns",
      "security",
      { agent: "design", model: defaultImplementReviewModel },
      { agent: "tests", reports: "none" },
      { agent: "adversarial", model: defaultImplementReviewModel, reports: "all" },
    ],
  },
  "implement-lite": {
    description: "Like implement, but swaps GPT 5.6 Terra xhigh phases for GLM 5.2 to reduce cost",
    steps: [
      { agent: "implementer", model: glmModel, reports: "none" },
      { agent: "patterns", model: glmModel },
      { agent: "security", model: glmModel },
      { agent: "design", model: defaultOpusModel },
      { agent: "tests", model: glmModel, reports: "none" },
      { agent: "adversarial", model: defaultOpusModel, reports: "all" },
    ],
  },
  review: {
    description:
      "Report-only PR review: scope, then parallel bug/clean-code/security audits across two models, then one prioritized findings report. Makes no changes.",
    steps: [
      { agent: "review-scope", name: "scope", model: defaultOpusModel, reports: "none", diff: true },
      {
        parallel: [
          { agent: "clean-code-auditor", name: "clean-code", models: [fallbackModel, defaultOpusModel], reports: ["scope"] },
          { agent: "security-reviewer", name: "security", models: [fallbackModel, defaultOpusModel], reports: ["scope"] },
          { agent: "bug-auditor", name: "bugs", models: [fallbackModel, defaultOpusModel], reports: ["scope"] },
        ],
      },
      { agent: "review-report", name: "report", model: defaultOpusModel, reports: "all" },
    ],
  },
  "review-lite": {
    description:
      "Like review, but swaps GPT 5.6 Terra xhigh for GLM 5.2 in scope and the audit fan-out; the report and the parallel audit slot keep Opus.",
    steps: [
      { agent: "review-scope", name: "scope", model: glmModel, reports: "none", diff: true },
      {
        parallel: [
          { agent: "clean-code-auditor", name: "clean-code", models: [glmModel, defaultOpusModel], reports: ["scope"] },
          { agent: "security-reviewer", name: "security", models: [glmModel, defaultOpusModel], reports: ["scope"] },
          { agent: "bug-auditor", name: "bugs", models: [glmModel, defaultOpusModel], reports: ["scope"] },
        ],
      },
      { agent: "review-report", name: "report", model: defaultOpusModel, reports: "all" },
    ],
  },
  refine: {
    description: "Audit-only PR review, adversarial finding triage, targeted fixes, and final validation — applies changes.",
    steps: [
      { agent: "review-scope", name: "scope", model: glmModel, reports: "none", diff: true },
      { agent: "bug-auditor", name: "bugs", model: fallbackModel, reports: ["scope"] },
      { agent: "clean-code-auditor", name: "clean-code", model: fallbackModel, reports: ["scope"] },
      { agent: "security-reviewer", name: "security", model: fallbackModel, reports: ["scope"] },
      { agent: "review-adversary", name: "triage", model: defaultOpusModel, reports: ["scope", "bugs", "clean-code", "security"] },
      { agent: "review-fixer", name: "fixes", model: fallbackModel, reports: ["triage"] },
      { agent: "review-validator", name: "validator", model: fallbackModel, reports: "all" },
    ],
  },
  "ultra-refine": {
    description: "Like refine, but every read-only audit runs in parallel across two models before triage, targeted fixes, and validation.",
    steps: [
      { agent: "review-scope", name: "scope", models: [sonnetModel, fallbackModel], reports: "none", diff: true },
      {
        parallel: [
          { agent: "bug-auditor", name: "bugs", models: [sonnetModel, fallbackModel], reports: ["scope"] },
          { agent: "clean-code-auditor", name: "clean-code", models: [sonnetModel, fallbackModel], reports: ["scope"] },
          { agent: "security-reviewer", name: "security", models: [sonnetModel, fallbackModel], reports: ["scope"] },
        ],
      },
      { agent: "review-adversary", name: "triage", model: defaultOpusModel, reports: ["scope", "bugs", "clean-code", "security"] },
      { agent: "review-fixer", name: "fixes", model: sonnetModel, reports: ["triage"] },
      { agent: "review-validator", name: "validator", model: defaultOpusModel, reports: "all" },
    ],
  },
  "ultra-implement": {
    description:
      "Like implement, but pattern/security/adversarial reviews of the initial diff run in parallel across two models feeding a triage step, then design and tests, then an audit-only final review, a fixer that applies only blocking findings, and a final validator.",
    steps: [
      { agent: "implementer", reports: "none" },
      {
        parallel: [
          { agent: "patterns", models: [sonnetModel, fallbackModel] },
          { agent: "security", models: [sonnetModel, fallbackModel] },
          { agent: "adversarial", models: [sonnetModel, fallbackModel] },
        ],
      },
      { agent: "implementation-triage", name: "triage", model: defaultOpusModel },
      { agent: "design", model: defaultOpusModel },
      { agent: "tests", reports: "none" },
      { agent: "implementation-final-review", name: "final-review", model: defaultOpusModel, reports: "all" },
      { agent: "implementation-fixer", name: "fixes", reports: ["final-review"] },
      { agent: "implementation-validator", name: "validator", model: defaultOpusModel, reports: "all" },
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
  let legacyHumanCount = 0
  let genericHumanCount = 0

  const claimAgentName = (name: string, position: string) => {
    if (name === humanReviewStep || name.startsWith(`${humanReviewStep}-`)) {
      throw new Error(`pipeline "${input.name}": step ${position} can't use the reserved name "${name}"`)
    }
    claimStepName(name, position)
  }

  const claimStepName = (name: string, position: string) => {
    if (!isSafeStepName(name)) {
      throw new Error(
        `pipeline "${input.name}": step ${position} name "${name}" must be a filesystem-safe identifier using letters, numbers, hyphens, or underscores`,
      )
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
      const members = raw.parallel.flatMap((inner, innerIndex) => {
        if (asHumanStepSpec(inner as StepSpec)) {
          throw new Error(`pipeline "${input.name}": step ${position}.${innerIndex + 1} can't use a human step inside a parallel block`)
        }
        return resolveAgentStepSpec(inner, {
          input,
          position: `${position}.${innerIndex + 1}`,
          groupId,
          forcedReadOnly: true,
          priorSteps: agentSteps,
          claimName: claimAgentName,
        })
      })
      steps.push(...members)
      agentSteps.push(...members)
      continue
    }

    const humanSpec = asHumanStepSpec(raw)
    if (humanSpec) {
      const isLegacy = "agent" in humanSpec
      const defaultName = isLegacy ? humanReviewStep : humanStepType
      let name = humanSpec.name
      if (!name) {
        if (isLegacy) legacyHumanCount++
        else genericHumanCount++
        const index = isLegacy ? legacyHumanCount : genericHumanCount
        name = index === 1 ? defaultName : `${defaultName}-${index}`
      }
      claimStepName(name, position)
      const description = humanSpec.description ?? (isLegacy ? humanReviewDescription : humanStepDescription)
      const step: HumanStep = { type: "human", name, description }
      steps.push(step)
      continue
    }

    const spec: AgentStepSpec = typeof raw === "string" ? { agent: raw } : (raw as AgentStepSpec)

    const members = resolveAgentStepSpec(spec, {
      input,
      position,
      groupId,
      forcedReadOnly: Boolean(spec.models && spec.models.length > 0),
      priorSteps: agentSteps,
      claimName: claimAgentName,
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

export function isHumanStepSpec(raw: StepSpec): raw is HumanStepSpec {
  return typeof raw === "object" && raw !== null && "type" in raw && raw.type === humanStepType
}

const safeStepNamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export function isSafeStepName(name: string): boolean {
  return safeStepNamePattern.test(name)
}

type LegacyHumanStepSpec = { agent: typeof humanReviewStep; name?: string; description?: string }

function asHumanStepSpec(raw: StepSpec): HumanStepSpec | LegacyHumanStepSpec | undefined {
  if (raw === humanReviewStep) return { agent: humanReviewStep }
  if (isHumanStepSpec(raw)) return raw
  if (typeof raw === "object" && raw !== null && !isParallelSpec(raw) && "agent" in raw && raw.agent === humanReviewStep) {
    return {
      agent: humanReviewStep,
      ...(raw.name !== undefined ? { name: raw.name } : {}),
    }
  }
  return undefined
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

  const runnerDefinition = stepRunnerFor(spec.runner)
  // "opencode" is accepted for symmetry but resolves to the default (no runner field).
  const runner: StepRunner | undefined = runnerDefinition.id === "claude-code" ? "claude-code" : undefined
  if (!runnerDefinition.capabilities.modelFanout && spec.models !== undefined) {
    throw new Error(
      `pipeline "${ctx.input.name}": step ${ctx.position} ("${baseName}") can't combine runner: ${runnerDefinition.id} with a "models" fan-out; give the step a single model (or none for the CLI default)`,
    )
  }
  if (!runnerDefinition.capabilities.writeSteps && !ctx.forcedReadOnly && !agent.readOnly) {
    throw new Error(
      `pipeline "${ctx.input.name}": step ${ctx.position} ("${baseName}") uses runner: ${runnerDefinition.id}, which currently supports read-only audit steps only — agent "${agent.name}" can modify the repo`,
    )
  }

  const models = spec.models
  const forced = ctx.forcedReadOnly || Boolean(models)
  // Runners without global override support own their model namespace and use
  // an empty string for their own configured default.
  const variants = runnerDefinition.capabilities.globalModelOverride
    ? (models ?? [spec.model ?? agent.model ?? ctx.input.defaultModel ?? agent.defaultModel ?? fallbackModel])
    : [spec.model ? normalizeStepRunnerModel(runnerDefinition.id, spec.model) : ""]
  const agentName = forced && !agent.readOnly ? `${agent.name}${readOnlyAgentSuffix}` : agent.name

  return variants.map((modelValue, variantIndex) => {
    const name = models ? `${baseName}__${slugifyModel(modelValue)}` : baseName
    ctx.claimName(name, models ? `${ctx.position}[${variantIndex + 1}]` : ctx.position)

    const { model, variant } = runner ? { model: modelValue, variant: undefined } : splitModelVariant(modelValue)
    const step: AgentStep = {
      type: "agent",
      name,
      stepName: baseName,
      groupId: ctx.groupId,
      agentName,
      description: agent.description,
      model,
      ...(variant ? { variant } : {}),
      ...(runner ? { runner } : {}),
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
      // Human gates may already be filtered out (--no-human-step/--no-human-review, no TTY);
      // referencing them must not turn into a typo error.
      if (name === humanReviewStep || name.startsWith(`${humanReviewStep}-`)) continue
      throw new Error(`${flag}: unknown step "${name}" in pipeline "${pipeline.name}" (valid: ${[...valid].join(", ")})`)
    }
  }
}

export function defaultPipeline(): Pipeline {
  return resolvePipeline({ name: defaultPipelineName, spec: builtInPipelines[defaultPipelineName]!, agents: builtInAgents })
}
