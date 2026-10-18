import { resolveModel, type ModelGateway, type ModelRoutingOverrides, type ResolvedModel } from "./model-routing"
import type { OpenSpecBundle } from "./openspec"
import type { PrdHistoryPreview } from "./prd-history"
import { resolveBilling } from "./runners/billing"
import type { AuthenticationMode, AuthenticationSelection } from "./runners/contracts"
import { normalizeQualifiedModel, runnerDescriptor } from "./runners/descriptors"
import {
  defaultStepRunnerId,
  modelOverrideTargetsRunner,
  parseModelOverride,
  qualifiedModelRoute,
  runnerOfModelReference,
  stepRunnerFor,
  stepRunnerIds,
  type ModelOverride,
  type StepRunnerId,
} from "./step-runners"
import type { AgentStep, FeaturePlanLink, Pipeline, ResolvedGoalPlan, ReviewedRunnerAuth, RunOptions, RunPlan, Step } from "./types"

export type BuildRunPlanInput = RunOptions & {
  promptSource?: RunPlan["prompt"]["source"]
  worktree?: boolean
  /** Worktree runs: the branch name confirmed in the launcher, frozen into the plan the user reviews. */
  branch?: string
  /** Worktree runs: the directory that branch will be checked out in. */
  worktreeDir?: string
  /** The run's frozen gateway when resuming; recorded in the plan when an explicit --gateway replaces it. */
  resumeGateway?: ModelGateway
  /** Precomputed checkout preview; `buildRunPlan` does not touch the filesystem. */
  prdHistoryPreview?: PrdHistoryPreview
  /** Precomputed OpenSpec contract; `buildRunPlan` does not touch the filesystem. */
  openspec?: OpenSpecBundle
  /** Precomputed feature link (verified by the caller); frozen into the plan for execution-time revalidation. */
  feature?: FeaturePlanLink
}

/**
 * The resolved auth mode per planned step on a runner that authenticates. A
 * WeakMap keyed by the frozen step objects keeps the plan type vendor-neutral
 * without adding fields to `AgentStep`; a step that was never annotated
 * resolves to the documented `subscription` default.
 */
const stepAuthModes = new WeakMap<AgentStep, AuthenticationMode>()

function registerStepAuth(pipeline: Pipeline, modes: Partial<Record<StepRunnerId, AuthenticationMode>>): void {
  for (const step of planAgentSteps(pipeline)) {
    const mode = modes[stepRunnerFor(step.runner).id]
    if (mode) stepAuthModes.set(step, mode)
  }
}

/** Only non-secret selection fields are frozen; the key stays in its variable. */
function frozenSelection(selection: AuthenticationSelection | undefined): AuthenticationSelection {
  if (!selection) return { mode: "subscription" }
  return { mode: selection.mode, ...(selection.credentialRef ? { credentialRef: selection.credentialRef } : {}), ...(selection.billingPolicy ? { billingPolicy: selection.billingPolicy } : {}) }
}

/**
 * Every runner that authenticates and that the plan uses: a step, an advisor,
 * the judge, or the commit writer. Each one's billing decision is reviewed.
 */
export function planAuthenticatingRunners(pipeline: Pipeline, judge: RunPlan["smartJudge"], commitMessageModel: string | undefined): StepRunnerId[] {
  const used = new Set<StepRunnerId>(pipelineRunners(pipeline))
  for (const step of planAgentSteps(pipeline)) if (step.resolvedAdvisor) used.add(runnerOfModelReference(step.resolvedAdvisor))
  if (judge?.runner) used.add(judge.runner)
  if (commitMessageModel) used.add(runnerOfModelReference(commitMessageModel))
  return stepRunnerIds.filter((id) => used.has(id) && runnerDescriptor(id).authenticates)
}

/** Purely resolves the complete execution shape; it performs no filesystem or process effects. */
export function buildRunPlan(input: BuildRunPlanInput): RunPlan {
  const gateway = input.gateway ?? "configured"
  const overrides = input.modelRoutingOverrides ?? {}
  // The immutable plan must never recursively freeze caller-owned config.
  // The pipeline's terminal goal step — policy and both fragments — is part of
  // that frozen copy, so the reviewed plan is the sole authority for the goal
  // cycle: nothing is re-resolved or re-routed between iterations.
  const pipeline = routePipeline(filterPipeline(structuredClone(input.pipeline), input.onlySteps, input.skipSteps), gateway, overrides, input.modelOverride, {
    advisorOverride: input.advisorOverride,
    advisorDisabled: input.advisorDisabled,
  })
  const judge = input.smart ? resolveJudge(input.smartJudgeModel, gateway, overrides) : undefined
  const hooks = hooksForPlan(input, pipeline.name)
  // Every CLI runner the plan uses gets a reviewed route. Neither CLI exposes a
  // control that enforces included-only usage, so the billing decision is
  // never claimed verified (design D3).
  const runnerAuth: Partial<Record<StepRunnerId, ReviewedRunnerAuth>> = {}
  for (const runner of planAuthenticatingRunners(pipeline, judge, input.commitMessageModel)) {
    const auth = frozenSelection(input.runnerAuth?.[runner])
    runnerAuth[runner] = { auth, billing: resolveBilling(auth, { canVerifyIncludedOnly: false }) }
  }
  registerStepAuth(pipeline, Object.fromEntries(Object.entries(input.runnerAuth ?? {}).map(([runner, auth]) => [runner, auth!.mode])))
  return deepFreeze({
    prompt: { source: input.promptSource ?? (input.resumeRunID ? "resume" : "inline"), text: input.prompt },
    target: {
      directory: input.targetDir,
      baseRef: input.baseRef,
      worktree: input.worktree ?? false,
      dirty: input.includeDirty,
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.worktreeDir ? { worktreeDir: input.worktreeDir } : {}),
    },
    pipeline,
    modelRouting: { gateway },
    ...(judge ? { smartJudge: judge } : {}),
    ...(Object.keys(runnerAuth).length > 0 ? { runnerAuth } : {}),
    ...(input.commitMessageModel ? { commitMessageModel: input.commitMessageModel } : {}),
    hooks,
    attachments: [...input.files],
    ...(input.openspec ? { openspec: input.openspec } : {}),
    ...(input.feature ? { feature: input.feature } : {}),
    ...(input.prdHistoryPreview ? { prdHistory: input.prdHistoryPreview } : {}),
    permissions: input.yolo ? "yolo" : input.smart ? "smart" : "interactive",
    ...(pipeline.goalPlan ? { goal: pipeline.goalPlan } : {}),
    ...(input.resumeRunID
      ? {
          resume: {
            runID: input.resumeRunID,
            ...(input.resumeGateway && input.resumeGateway !== gateway
              ? { gatewayOverride: { original: input.resumeGateway, pending: gateway } }
              : {}),
          },
        }
      : {}),
  })
}

/**
 * The judge route: a runner-qualified route (`claude-code/<model>`,
 * `codex/<model>`) judges through that runner's CLI and is never
 * gateway-routed (the CLI's model id is opaque to OpenCode's catalog);
 * anything else is an OpenCode model routed like a step's.
 */
function resolveJudge(configured: string, gateway: ModelGateway, overrides: ModelRoutingOverrides): NonNullable<RunPlan["smartJudge"]> {
  const model = resolveRunnerQualifiedModel(configured, gateway, overrides, "helper")
  const runner = runnerOfModelReference(model)
  return runner === defaultStepRunnerId ? { model } : { runner, model }
}

/** Every agent step of the pipeline, goal fragments included. */
export function planAgentSteps(pipeline: Pipeline): AgentStep[] {
  const steps: Step[] = [...pipeline.steps, ...(pipeline.goalPlan ? [...pipeline.goalPlan.improve.steps, ...pipeline.goalPlan.measure.steps] : [])]
  return steps.filter((step): step is AgentStep => step.type === "agent")
}

/** Every runner an agent step of the pipeline (goal fragments included) executes on. */
export function pipelineRunners(pipeline: Pipeline): Set<StepRunnerId> {
  return new Set(planAgentSteps(pipeline).map((step) => stepRunnerFor(step.runner).id))
}

/**
 * The one CLI runner every agent step runs on, when there is exactly one: such
 * a plan never needs OpenCode by default, so its judge and helpers inherit it.
 */
export function soleCliRunner(pipeline: Pipeline): StepRunnerId | undefined {
  const runners = [...pipelineRunners(pipeline)]
  return runners.length === 1 && stepRunnerFor(runners[0]).qualifiedModels ? runners[0] : undefined
}

/**
 * The runner-qualified default helper route for a CLI runner
 * (`claude-code/haiku`, `codex/default#low`); `default` keeps the CLI's own
 * model.
 */
export function defaultHelperRoute(runner: StepRunnerId, model?: string): string {
  const fallback = runnerDescriptor(runner).helperModel
  const chosen = model ? { model } : (fallback ?? { model: "" })
  return `${runner}/${chosen.model || "default"}${"variant" in chosen && chosen.variant ? `#${chosen.variant}` : ""}`
}

export type AdvisorPlanOverrides = {
  /** Forces this advising model on every advisor-capable step. Empty leaves each step's own resolution alone. */
  advisorOverride?: string
  /** Strips the advisor from every step; wins over advisorOverride. */
  advisorDisabled?: boolean
}

export function routePipeline(
  pipeline: Pipeline,
  gateway: ModelGateway,
  overrides: ModelRoutingOverrides,
  modelOverride = "",
  advisor: AdvisorPlanOverrides = {},
): Pipeline {
  const override = parseModelOverride(modelOverride)
  return {
    ...pipeline,
    steps: pipeline.steps.map((step): Step => routeStep(step, gateway, overrides, override, advisor)),
    // The goal fragments are frozen with the plan: their models and advisors
    // route exactly once, so every iteration runs the reviewed models.
    ...(pipeline.goalPlan
      ? {
          goalPlan: {
            ...pipeline.goalPlan,
            improve: { steps: pipeline.goalPlan.improve.steps.map((step) => routeStep(step, gateway, overrides, override, advisor) as AgentStep) },
            measure: { steps: pipeline.goalPlan.measure.steps.map((step) => routeStep(step, gateway, overrides, override, advisor) as AgentStep) },
          },
        }
      : {}),
  }
}

function routeStep(
  step: Step,
  gateway: ModelGateway,
  overrides: ModelRoutingOverrides,
  override: ModelOverride,
  advisor: AdvisorPlanOverrides,
): Step {
  if (step.type !== "agent") return structuredClone(step)
  const runner = stepRunnerFor(step.runner)
  if (runner.qualifiedModels) {
    // A CLI runner's model identifier is opaque to the gateway router; only an
    // override scoped to that runner replaces it. An unqualified override is
    // for provider-qualified runners and leaves CLI steps untouched (design
    // D5). Its advisor routes like any other step's.
    const routed = { ...structuredClone(step), ...routeAdvisor(step, gateway, overrides, advisor) }
    if (!modelOverrideTargetsRunner(override, runner.id)) return routed
    const selected = normalizeQualifiedModel(runner.id, override.model)
    return { ...routed, model: selected.model, variant: selected.variant }
  }
  // A runner-scoped override that names another runner does not replace the
  // OpenCode model; the step still routes its own configured model normally.
  const configured = modelOverrideTargetsRunner(override, runner.id)
    ? override.model
    : `${step.model}${step.variant ? `#${step.variant}` : ""}`
  const resolvedModel = resolveModel(configured, gateway, overrides)
  return {
    ...step,
    model: `${resolvedModel.providerID}/${resolvedModel.modelID}`,
    ...(resolvedModel.variant ? { variant: resolvedModel.variant } : { variant: undefined }),
    resolvedModel,
    ...routeAdvisor(step, gateway, overrides, advisor),
  }
}

/**
 * The advisor is routed through the run's gateway exactly like the executor's
 * model, so a `--gateway openrouter` run doesn't consult the advisor direct.
 * Returns the full set of advisor fields (explicitly undefined when off) so the
 * spread always overwrites whatever the step carried in.
 */
function routeAdvisor(
  step: AgentStep,
  gateway: ModelGateway,
  overrides: ModelRoutingOverrides,
  { advisorOverride = "", advisorDisabled = false }: AdvisorPlanOverrides,
): Pick<AgentStep, "advisor" | "advisorVariant" | "resolvedAdvisor"> {
  const off = { advisor: undefined, advisorVariant: undefined, resolvedAdvisor: undefined }
  if (advisorDisabled) return off
  const configured = advisorOverride || (step.advisor ? `${step.advisor}${step.advisorVariant ? `#${step.advisorVariant}` : ""}` : "")
  if (!configured) return off

  const resolvedAdvisor = resolveRunnerQualifiedModel(configured, gateway, overrides)
  return {
    advisor: `${resolvedAdvisor.providerID}/${resolvedAdvisor.modelID}`,
    advisorVariant: resolvedAdvisor.variant,
    resolvedAdvisor,
  }
}

/**
 * A helper model reference (advisor, judge): a runner-qualified route
 * (`claude-code/<model>`, `codex/<model>[#effort]`) runs on that runner's CLI
 * and is never gateway-routed, since its model id is opaque to OpenCode's
 * catalog; anything else is an OpenCode model routed like a step's. An empty
 * model takes the runner's default for the purpose.
 */
export function resolveRunnerQualifiedModel(configured: string, gateway: ModelGateway, overrides: ModelRoutingOverrides, purpose: "advisor" | "helper" = "advisor"): ResolvedModel {
  const route = qualifiedModelRoute(configured)
  if (!route) return resolveModel(configured, gateway, overrides)
  const fallback = purpose === "helper" ? runnerDescriptor(route.runner).helperModel : runnerDescriptor(route.runner).advisorModel
  const named = route.model && route.model !== "default" ? route.model : undefined
  const variant = route.variant ?? (named ? undefined : fallback?.variant)
  const selected = normalizeQualifiedModel(route.runner, `${named ?? fallback?.model ?? ""}${variant ? `#${variant}` : ""}`)
  const modelID = selected.model || "default"
  const target = `${route.runner}/${modelID}${selected.variant ? `#${selected.variant}` : ""}`
  return { configured, logical: modelID, gateway: "configured", providerID: route.runner, modelID, ...(selected.variant ? { variant: selected.variant } : {}), target }
}

function filterPipeline(pipeline: Pipeline, only: string[], skip: string[]): Pipeline {
  const selected = (step: Step) => {
    const logicalName = step.type === "agent" ? step.stepName : step.name
    if (only.length > 0 && !only.includes(step.name) && !only.includes(logicalName)) return false
    return !skip.includes(step.name) && !skip.includes(logicalName)
  }
  return { ...pipeline, steps: pipeline.steps.filter(selected) }
}

function hooksForPlan(input: RunOptions, pipelineName: string) {
  const pipeline = input.hooks.pipelines[pipelineName]
  return structuredClone({
    pre: [...input.hooks.pre, ...(pipeline?.pre ?? [])],
    post: [...input.hooks.post, ...(pipeline?.post ?? [])],
  })
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/**
 * The reviewed auth mode for a step on a runner that authenticates. OpenCode
 * uses its own provider credentials and reports `undefined`.
 */
export function plannedStepAuthMode(step: AgentStep): AuthenticationMode | undefined {
  if (!runnerDescriptor(stepRunnerFor(step.runner).id).authenticates) return undefined
  return stepAuthModes.get(step) ?? "subscription"
}

export function plannedStepModel(step: AgentStep): string {
  const runner = stepRunnerFor(step.runner)
  if (runner.qualifiedModels) {
    const auth = plannedStepAuthMode(step)
    return `${runner.modelLabel(step.model, step.variant)}${auth ? ` · auth ${auth}` : ""}`
  }
  return step.resolvedModel?.target ?? `${step.model}${step.variant ? `#${step.variant}` : ""}`
}

/**
 * Every OpenRouter model a nitro run must route by throughput: executors,
 * advisors, and (when smart mode consults one) the permission judge. The goal
 * fragments live in the same reviewed pipeline as the prefix, so their OpenRouter
 * models are collected here once and preflighted with the parent plan — including
 * models that would only run in a later iteration. Deduplicated by model id — a
 * model shared by an executor and an advisor needs the option declared exactly once.
 */
export function throughputRoutedModels(
  pipeline: Pipeline,
  judge?: { providerID: string; modelID: string },
): { providerID: string; modelID: string }[] {
  const models = new Map<string, { providerID: string; modelID: string }>()
  const add = (model: { providerID: string; modelID: string } | undefined) => {
    if (model && model.providerID === "openrouter") models.set(model.modelID, { providerID: model.providerID, modelID: model.modelID })
  }
  // The goal fragments preflight with the prefix: a model unavailable through
  // the selected gateway rejects the parent plan before any phase starts, even
  // when it would only run in a later iteration.
  for (const step of [...pipeline.steps, ...(pipeline.goalPlan ? [...pipeline.goalPlan.improve.steps, ...pipeline.goalPlan.measure.steps] : [])]) {
    if (step.type !== "agent" || stepRunnerFor(step.runner).qualifiedModels) continue
    add(step.resolvedModel)
    add(step.resolvedAdvisor)
  }
  add(judge)
  return [...models.values()]
}

/** The step's advising model as the reviewed plan shows it, or undefined when the step runs without one. */
export function plannedStepAdvisor(step: AgentStep): string | undefined {
  if (!step.advisor) return undefined
  return step.resolvedAdvisor?.target ?? `${step.advisor}${step.advisorVariant ? `#${step.advisorVariant}` : ""}`
}
