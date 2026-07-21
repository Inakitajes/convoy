import { gatewayLabel, type ResolvedModel } from "./model-routing"
import { type OpenCodeList, unwrapOpenCodeList } from "./opencode-response"
import type { RunPlan } from "./types"

type DiscoveredProvider = { id?: unknown; integrationID?: unknown; disabled?: unknown; enabled?: unknown }
type DiscoveredModel = { providerID?: unknown; id?: unknown; enabled?: unknown }

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
  providers: OpenCodeList<DiscoveredProvider>,
  models: OpenCodeList<DiscoveredModel>,
): void {
  const discoveredProviders = unwrapOpenCodeList(providers)
  const discoveredModels = unwrapOpenCodeList(models)

  for (const target of targets) {
    const model = discoveredModels.find((entry) => entry.providerID === target.providerID && entry.id === target.modelID)

    // OpenCode 1.18 exposes availability on each model. Treat that as the
    // source of truth because the provider list no longer maps one-to-one to
    // model provider IDs. Older OpenCode versions need the provider fallback.
    if (model?.enabled === true) continue

    const provider = discoveredProviders.find((entry) => entry.id === target.providerID || entry.integrationID === target.providerID)
    if (!provider || provider.disabled === true || provider.enabled === false || model?.enabled === false) {
      const auth = target.providerID === "vercel"
        ? "Authenticate with `opencode providers login` (Vercel AI Gateway) or set AI_GATEWAY_API_KEY."
        : `Authenticate provider ${target.providerID} with \`opencode providers login\`.`
      throw new Error(`Cannot start run\n\nMissing provider credentials: ${target.providerID}\n\n${auth}`)
    }
    if (!model) {
      throw new Error(
        `Model unavailable through ${gatewayLabel(target.gateway)}:\n\n  logical: ${target.logical}\n  target:  ${target.target}\n\nAdd modelRouting.overrides or select --gateway configured.`,
      )
    }
  }
}
