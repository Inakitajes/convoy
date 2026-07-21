import { startOpencode } from "./opencode"
import { providerDiscovery } from "./opencode-discovery"
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
    const providerResult = await withinPreflightTimeout(
      handle.client.provider.list({ directory: plan.target.directory }),
      timeout,
    )
    if (providerResult.error) throw new Error("OpenCode could not list connected providers and models")
    const discovery = providerDiscovery(providerResult.data)
    validatePreflightTargets(targets, discovery.providers, discovery.models)
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
