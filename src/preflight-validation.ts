import { gatewayLabel, type ResolvedModel } from "./model-routing"
import type { RunPlan } from "./types"

type DiscoveredProvider = { id?: unknown; enabled?: unknown }
type DiscoveredModel = { providerID?: unknown; id?: unknown }

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
  providers: readonly DiscoveredProvider[],
  models: readonly DiscoveredModel[],
): void {
  for (const target of targets) {
    const provider = providers.find((entry) => entry.id === target.providerID)
    if (!provider || provider.enabled === false) {
      const auth = target.providerID === "vercel"
        ? "Authenticate with `opencode providers login` (Vercel AI Gateway) or set AI_GATEWAY_API_KEY."
        : `Authenticate provider ${target.providerID} with \`opencode providers login\`.`
      throw new Error(`Cannot start run\n\nMissing provider credentials: ${target.providerID}\n\n${auth}`)
    }
    if (!models.some((model) => model.providerID === target.providerID && model.id === target.modelID)) {
      throw new Error(
        `Model unavailable through ${gatewayLabel(target.gateway)}:\n\n  logical: ${target.logical}\n  target:  ${target.target}\n\nAdd modelRouting.overrides or select --gateway configured.`,
      )
    }
  }
}
