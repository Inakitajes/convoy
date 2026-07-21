import { gatewayLabel, type ResolvedModel } from "./model-routing"
import type { DiscoveredModel, DiscoveredProvider } from "./opencode-discovery"
import type { RunPlan } from "./types"

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
  providers: readonly Pick<DiscoveredProvider, "id" | "disabled">[],
  models: readonly (Pick<DiscoveredModel, "providerID" | "id"> & { variants?: readonly { id: string }[] })[],
): void {
  for (const target of targets) {
    const provider = providers.find((entry) => entry.id === target.providerID)
    if (!provider || provider.disabled === true) {
      const auth = target.providerID === "vercel"
        ? "Authenticate with `opencode providers login` (Vercel AI Gateway) or set AI_GATEWAY_API_KEY."
        : `Authenticate provider ${target.providerID} with \`opencode providers login\`.`
      throw new Error(`Cannot start run\n\nMissing provider credentials: ${target.providerID}\n\n${auth}`)
    }
    const model = models.find((entry) => entry.providerID === target.providerID && entry.id === target.modelID)
    if (!model) {
      throw new Error(
        `Model unavailable through ${gatewayLabel(target.gateway)}:\n\n  logical: ${target.logical}\n  target:  ${target.target}\n\nAdd modelRouting.overrides or select --gateway configured.`,
      )
    }
    if (target.variant && !model.variants?.some((variant) => variant.id === target.variant)) {
      throw new Error(
        `Model variant unavailable through ${gatewayLabel(target.gateway)}:\n\n  logical: ${target.logical}\n  target:  ${target.target}\n\nSelect a variant reported by OpenCode.`,
      )
    }
  }
}
