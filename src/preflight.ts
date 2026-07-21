import { startOpencode } from "./opencode"
import { discoveryData } from "./opencode-discovery"
import type { RunPlan } from "./types"
import { preflightTargets, validatePreflightTargets } from "./preflight-validation"

const preflightTimeoutMs = 15_000

/** Validate the exact physical OpenCode targets after approval and before run/worktree creation. */
export async function preflightRunPlan(plan: RunPlan): Promise<void> {
  const targets = preflightTargets(plan)
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
    validatePreflightTargets(
      targets,
      discoveryData(providerResult.data, "providers"),
      discoveryData(modelResult.data, "models"),
    )
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
