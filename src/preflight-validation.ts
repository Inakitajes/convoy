import { gatewayLabel, type ResolvedModel } from "./model-routing"
import type { RunPlan } from "./types"

type DiscoveredModel = { variants?: unknown }
type DiscoveredProvider = { id?: unknown; models?: unknown }
export type ProviderCatalog = { all: readonly DiscoveredProvider[]; connected: readonly string[] }

/** The exact OpenCode targets that must be available before a run can begin. */
export function preflightTargets(plan: RunPlan): ResolvedModel[] {
  const targets = plan.pipeline.steps.flatMap((step) =>
    step.type === "agent" && step.runner !== "claude-code" && step.resolvedModel ? [step.resolvedModel] : [],
  )
  if (plan.smartJudge) targets.push(plan.smartJudge.model)
  if (plan.branchNamer) targets.push(plan.branchNamer.model)
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
    if (!Object.hasOwn(models, target.modelID)) throw modelUnavailable(target)
    const model = models[target.modelID] as DiscoveredModel | undefined
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
