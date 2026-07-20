import { startOpencode } from "./opencode"
import { gatewayLabel } from "./model-routing"
import type { RunPlan } from "./types"

const preflightTimeoutMs = 15_000

/** Validate the exact physical OpenCode targets after approval and before run/worktree creation. */
export async function preflightRunPlan(plan: RunPlan): Promise<void> {
  const targets = plan.pipeline.steps.flatMap((step) =>
    step.type === "agent" && step.runner !== "claude-code" && step.resolvedModel ? [step.resolvedModel] : [],
  )
  if (plan.smartJudge) targets.push(plan.smartJudge.model)
  if (targets.length === 0) return

  const timeout = AbortSignal.timeout(preflightTimeoutMs)
  const handle = await startOpencode({}, timeout)
  try {
    const [providerResult, modelResult] = await withinPreflightTimeout(
      Promise.all([
        handle.client.v2.provider.list({ location: { directory: plan.target.directory } }),
        handle.client.v2.model.list({ location: { directory: plan.target.directory } }),
      ]),
      timeout,
    )
    if (providerResult.error || modelResult.error) throw new Error("OpenCode could not list enabled providers and models")
    const providers = providerResult.data ?? []
    const models = modelResult.data ?? []
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
  } finally {
    handle.close()
  }
}

function withinPreflightTimeout<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("OpenCode preflight timed out"))
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("OpenCode preflight timed out")), { once: true })
    }),
  ])
}
