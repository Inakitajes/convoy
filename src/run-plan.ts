import { resolveModel, type ModelGateway, type ModelRoutingOverrides } from "./model-routing"
import { stepRunnerFor } from "./step-runners"
import type { AgentStep, Pipeline, RunOptions, RunPlan, Step } from "./types"

export type BuildRunPlanInput = RunOptions & {
  promptSource?: RunPlan["prompt"]["source"]
  worktree?: boolean
  /** Configured branch-naming model; resolved into the plan so the post-confirmation naming call uses the reviewed target. */
  branchNameModel?: string
  /** The run's frozen gateway when resuming; recorded in the plan when an explicit --gateway replaces it. */
  resumeGateway?: ModelGateway
}

/** Purely resolves the complete execution shape; it performs no filesystem or process effects. */
export function buildRunPlan(input: BuildRunPlanInput): RunPlan {
  const gateway = input.gateway ?? "configured"
  const overrides = input.modelRoutingOverrides ?? {}
  // The immutable plan must never recursively freeze caller-owned config.
  const pipeline = routePipeline(filterPipeline(structuredClone(input.pipeline), input.onlySteps, input.skipSteps), gateway, overrides, input.modelOverride)
  const judge = input.smart
    ? resolveModel(input.smartJudgeModel, gateway, overrides)
    : undefined
  const branchNamer = input.branchNameModel ? resolveModel(input.branchNameModel, gateway, overrides) : undefined
  const hooks = hooksForPlan(input, pipeline.name)
  return deepFreeze({
    prompt: { source: input.promptSource ?? (input.resumeRunID ? "resume" : "inline"), text: input.prompt },
    target: {
      directory: input.targetDir,
      baseRef: input.baseRef,
      worktree: input.worktree ?? false,
      dirty: input.includeDirty,
    },
    pipeline,
    modelRouting: { gateway },
    ...(judge ? { smartJudge: { model: judge } } : {}),
    ...(branchNamer ? { branchNamer: { model: branchNamer } } : {}),
    hooks,
    attachments: [...input.files],
    permissions: input.yolo ? "yolo" : input.smart ? "smart" : "interactive",
    maxAttempts: input.maxAttempts,
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

export function routePipeline(pipeline: Pipeline, gateway: ModelGateway, overrides: ModelRoutingOverrides, modelOverride = ""): Pipeline {
  return {
    ...pipeline,
    steps: pipeline.steps.map((step): Step => {
      if (step.type !== "agent" || stepRunnerFor(step.runner).id !== "opencode") return structuredClone(step)
      const configured = modelOverride || `${step.model}${step.variant ? `#${step.variant}` : ""}`
      const resolvedModel = resolveModel(configured, gateway, overrides)
      return {
        ...step,
        model: `${resolvedModel.providerID}/${resolvedModel.modelID}`,
        ...(resolvedModel.variant ? { variant: resolvedModel.variant } : { variant: undefined }),
        resolvedModel,
      }
    }),
  }
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

export function plannedStepModel(step: AgentStep): string {
  if (step.runner === "claude-code") return `claude-code/${step.model || "default"}`
  return step.resolvedModel?.target ?? `${step.model}${step.variant ? `#${step.variant}` : ""}`
}
