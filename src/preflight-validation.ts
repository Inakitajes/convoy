import { gatewayLabel, stripOpenRouterNitro, type ResolvedModel } from "./model-routing"
import type { RunPlan } from "./types"

type DiscoveredModel = { variants?: unknown }
type DiscoveredProvider = { id?: unknown; models?: unknown }
export type ProviderCatalog = { all: readonly DiscoveredProvider[]; connected: readonly string[] }

/**
 * The exact OpenCode targets that must be available before a run can begin.
 * Claude-routed models (`claude-code/<model>` advisors and judges) are not
 * OpenCode catalog entries: the Claude CLI's own auth probe checks them.
 */
export function preflightTargets(plan: RunPlan): ResolvedModel[] {
  return opencodeTargets(plan).filter((target) => target.providerID !== "claude-code")
}

function opencodeTargets(plan: RunPlan): ResolvedModel[] {
  const targets = plan.pipeline.steps.flatMap((step) =>
    step.type === "agent" && step.runner !== "claude-code" && step.resolvedModel ? [step.resolvedModel] : [],
  )
  // The goal fragments preflight with the prefix: an unavailable model must
  // reject the parent plan before the first run is paid for, even when it
  // would only run in a later iteration.
  if (plan.goal) {
    for (const step of [...plan.goal.improve.steps, ...plan.goal.measure.steps]) {
      if (step.runner !== "claude-code" && step.resolvedModel) targets.push(step.resolvedModel)
      if (step.resolvedAdvisor) targets.push(step.resolvedAdvisor)
    }
  }
  // Advising models are validated as themselves, not as the synthetic capped
  // alias the advisor is actually invoked with: the alias only exists inside the
  // run's own OpenCode config, so a clean discovery server would never see it.
  for (const step of plan.pipeline.steps) {
    if (step.type === "agent" && step.resolvedAdvisor) targets.push(step.resolvedAdvisor)
  }
  // A Claude judge is checked by the Claude CLI's own auth probe, not the OpenCode catalog.
  if (plan.smartJudge && plan.smartJudge.runner !== "claude-code") targets.push(plan.smartJudge.model)
  // No branch namer here: naming happens in the launcher, before the plan is
  // built, so nothing is left to call once the run is confirmed.
  return targets
}

/** Throws actionable errors for provider and physical-model discovery results. */
export function validatePreflightTargets(
  targets: readonly ResolvedModel[],
  catalog: ProviderCatalog,
): void {
  const connected = new Set(catalog.connected)

  for (const target of targets) {
    const provider = catalog.all.find((entry) => entry.id === target.providerID)
    if (!provider) throw modelUnavailable(target)
    if (!connected.has(target.providerID)) {
      const auth = target.providerID === "vercel"
        ? "Authenticate with `opencode providers login` (Vercel AI Gateway) or set AI_GATEWAY_API_KEY."
        : `Authenticate provider ${target.providerID} with \`opencode providers login\`.`
      throw new Error(`Cannot start run\n\nMissing provider credentials: ${target.providerID}\n\n${auth}`)
    }

    const models = isRecord(provider.models) ? provider.models : {}
    // `:nitro` is an OpenRouter routing alias, not a models.dev model: the
    // catalog carries the unsuffixed ID. Strip for lookup only — the error and
    // the frozen plan keep showing the full physical target.
    const catalogID = stripOpenRouterNitro(target.modelID)
    if (!Object.hasOwn(models, catalogID)) throw modelUnavailable(target)
    const model = models[catalogID] as DiscoveredModel | undefined
    if (!model) throw modelUnavailable(target)

    if (target.variant) {
      const variants = isRecord(model.variants) ? model.variants : {}
      if (!Object.hasOwn(variants, target.variant)) throw modelUnavailable(target)
    }
  }
}

function modelUnavailable(target: ResolvedModel) {
  return new Error(
    `Model unavailable through ${gatewayLabel(target.gateway)}:\n\n  logical: ${target.logical}\n  target:  ${target.target}\n\nAdd modelRouting.overrides or select --gateway configured.`,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
