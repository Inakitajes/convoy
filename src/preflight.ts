import { startOpencode } from "./opencode"
import type { RunPlan } from "./types"
import { type ProviderCatalog, preflightTargets, validatePreflightTargets } from "./preflight-validation"

const preflightTimeoutMs = 15_000
export type PreflightDiscovery = (directory: string, signal: AbortSignal) => Promise<ProviderCatalog>

/** Validate the exact physical OpenCode targets after approval and before run/worktree creation. */
export async function preflightRunPlan(plan: RunPlan, discover: PreflightDiscovery = discoverProviderCatalog): Promise<void> {
  const targets = preflightTargets(plan)
  if (targets.length === 0) return

  const timeout = AbortSignal.timeout(preflightTimeoutMs)
  const catalog = await withinPreflightTimeout(discover(plan.target.directory, timeout), timeout)
  validatePreflightTargets(targets, catalog)
}

async function discoverProviderCatalog(directory: string, signal: AbortSignal): Promise<ProviderCatalog> {
  const handle = await startOpencode({}, signal)
  try {
    // Runs use the classic session API, whose provider catalog owns the
    // credential connections and exact model IDs accepted by session.prompt.
    // The newer client.v2 catalog is a separate provider system and can omit
    // working classic providers such as an authenticated OpenAI connection.
    const providerResult = await handle.client.provider.list({ directory })
    if (providerResult.error || !providerResult.data) throw new Error("OpenCode could not list connected providers and models")
    return providerResult.data
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
