import { resolveModel, type ModelGateway, type ModelRoutingOverrides, type ResolvedModel } from "./model-routing"
import { splitModelVariant } from "./pipeline"
import type { OpenSpecBundle } from "./openspec"
import type { PrdHistoryPreview } from "./prd-history"
import { resolveBilling } from "./runners/billing"
import type { AuthenticationMode, AuthenticationSelection } from "./runners/contracts"
import { modelOverrideTargetsRunner, normalizeStepRunnerModel, parseModelOverride, stepRunnerFor, type ModelOverride } from "./step-runners"
import type { AgentStep, FeaturePlanLink, Pipeline, ResolvedGoalPlan, RunOptions, RunPlan, Step } from "./types"

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
  /**
   * The reviewed Claude authentication mode (design D3). New Claude routes
   * default to `subscription`; an explicit `api-key` selection is recorded so
   * the plan preview shows the billing route per Claude step. The credential
   * value itself never enters the plan.
   */
  claudeAuthMode?: AuthenticationMode
}

/**
 * The resolved Claude auth mode per planned Claude step. A WeakMap keyed by the
 * frozen step objects keeps the plan type vendor-neutral without adding fields
 * to `AgentStep`; a Claude step that was never annotated resolves to the
 * documented `subscription` default.
 */
const claudeAuthModes = new WeakMap<AgentStep, AuthenticationMode>()

function registerClaudeAuth(pipeline: Pipeline, mode: AuthenticationMode): void {
  const steps: Step[] = [
    ...pipeline.steps,
    ...(pipeline.goalPlan ? [...pipeline.goalPlan.improve.steps, ...pipeline.goalPlan.measure.steps] : []),
  ]
  for (const step of steps) if (step.type === "agent" && step.runner === "claude-code") claudeAuthModes.set(step, mode)
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
  const claudeAuthMode = input.claudeAuthMode ?? input.claudeAuth?.mode
  if (claudeAuthMode) registerClaudeAuth(pipeline, claudeAuthMode)
  const judge = input.smart ? resolveJudge(input.smartJudgeModel, gateway, overrides) : undefined
  const hooks = hooksForPlan(input, pipeline.name)
  const usesClaude =
    pipelineRunners(pipeline).has("claude-code") ||
    judge?.runner === "claude-code" ||
    planAgentSteps(pipeline).some((step) => step.resolvedAdvisor?.providerID === "claude-code") ||
    (input.commitMessageModel?.startsWith("claude-code/") ?? false)
  // Only non-secret selection fields are frozen; the key stays in its variable.
  const claudeAuth: AuthenticationSelection = input.claudeAuth
    ? { mode: input.claudeAuth.mode, ...(input.claudeAuth.credentialRef ? { credentialRef: input.claudeAuth.credentialRef } : {}), ...(input.claudeAuth.billingPolicy ? { billingPolicy: input.claudeAuth.billingPolicy } : {}) }
    : { mode: claudeAuthMode ?? "subscription" }
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
    // The Claude CLI exposes no control that enforces included-only usage,
    // so the billing decision is never claimed verified (design D3).
    ...(usesClaude ? { claude: { auth: claudeAuth, billing: resolveBilling(claudeAuth, { canVerifyIncludedOnly: false }) } } : {}),
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
 * The judge route: `claude-code/<model>` judges through the Claude CLI and is
 * never gateway-routed (Claude's model id is opaque to OpenCode's catalog);
 * anything else is an OpenCode model routed like a step's.
 */
function resolveJudge(configured: string, gateway: ModelGateway, overrides: ModelRoutingOverrides): NonNullable<RunPlan["smartJudge"]> {
  const model = resolveRunnerQualifiedModel(configured, gateway, overrides, "haiku")
  return model.providerID === "claude-code" ? { runner: "claude-code", model } : { model }
}

/** Every agent step of the pipeline, goal fragments included. */
export function planAgentSteps(pipeline: Pipeline): AgentStep[] {
  const steps: Step[] = [...pipeline.steps, ...(pipeline.goalPlan ? [...pipeline.goalPlan.improve.steps, ...pipeline.goalPlan.measure.steps] : [])]
  return steps.filter((step): step is AgentStep => step.type === "agent")
}

/** Every runner an agent step of the pipeline (goal fragments included) executes on. */
export function pipelineRunners(pipeline: Pipeline): Set<"opencode" | "claude-code"> {
  return new Set(planAgentSteps(pipeline).map((step) => stepRunnerFor(step.runner).id))
}

/** True when every agent step runs on Claude: such a plan never needs OpenCode by default. */
export function isClaudeOnlyPipeline(pipeline: Pipeline): boolean {
  const runners = pipelineRunners(pipeline)
  return runners.size > 0 && !runners.has("opencode")
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
  if (stepRunnerFor(step.runner).id !== "opencode") {
    // Claude's CLI identifier is opaque to the gateway router; only a
    // Claude-scoped override replaces it. An unqualified override is
    // OpenCode-only and leaves Claude steps untouched (design D5). Its
    // advisor routes like any other step's.
    const routed = { ...structuredClone(step), ...routeAdvisor(step, gateway, overrides, advisor) }
    if (!modelOverrideTargetsRunner(override, "claude-code")) return routed
    return { ...routed, model: normalizeStepRunnerModel("claude-code", override.model), variant: undefined }
  }
  // A runner-scoped override that names another runner does not replace the
  // OpenCode model; the step still routes its own configured model normally.
  const configured = modelOverrideTargetsRunner(override, "opencode")
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
 * A helper model reference (advisor, judge): `claude-code/<model>` runs on the
 * Claude CLI and is never gateway-routed, since Claude's model id is opaque to
 * OpenCode's catalog; anything else is an OpenCode model routed like a step's.
 */
export function resolveRunnerQualifiedModel(configured: string, gateway: ModelGateway, overrides: ModelRoutingOverrides, claudeDefault = "sonnet"): ResolvedModel {
  const scoped = parseModelOverride(splitModelVariant(configured).model)
  if (scoped.scope !== "claude-code") return resolveModel(configured, gateway, overrides)
  const modelID = normalizeStepRunnerModel("claude-code", scoped.model || claudeDefault)
  return { configured, logical: modelID, gateway: "configured", providerID: "claude-code", modelID, target: `claude-code/${modelID}` }
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
 * The reviewed auth mode for a Claude step. Only Claude routes carry one;
 * OpenCode uses its own provider credentials and reports `undefined`.
 */
export function plannedStepAuthMode(step: AgentStep): AuthenticationMode | undefined {
  if (step.runner !== "claude-code") return undefined
  return claudeAuthModes.get(step) ?? "subscription"
}

export function plannedStepModel(step: AgentStep): string {
  if (step.runner === "claude-code") {
    const auth = plannedStepAuthMode(step)
    return `claude-code/${step.model || "default"} · auth ${auth}`
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
    if (step.type !== "agent" || stepRunnerFor(step.runner).id !== "opencode") continue
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
