import { startOpencode, type OpencodeHandle } from "./opencode"
import type { RunPlan } from "./types"
import { type ProviderCatalog, preflightTargets, validatePreflightTargets } from "./preflight-validation"

const preflightTimeoutMs = 15_000
export type PreflightDiscovery = (directory: string, signal: AbortSignal) => Promise<ProviderCatalog>

/** Validate the exact physical OpenCode targets after approval and before run/worktree creation. */
export async function preflightRunPlan(plan: RunPlan, discover?: PreflightDiscovery): Promise<void> {
  const targets = preflightTargets(plan)
  if (targets.length === 0) return

  const timeout = AbortSignal.timeout(preflightTimeoutMs)
  if (!discover) {
    // Production path: discovery owns a bounded helper whose stop must settle
    // before a timeout-returning caller resumes (design D2).
    const tracked = createTrackedDiscovery()
    try {
      const catalog = await withinPreflightTimeout(tracked.discover(plan.target.directory, timeout), timeout, tracked.cancel)
      validatePreflightTargets(targets, catalog)
    } finally {
      await tracked.cancel()
    }
    return
  }
  const catalog = await withinPreflightTimeout(discover(plan.target.directory, timeout), timeout)
  validatePreflightTargets(targets, catalog)
}

/**
 * Discovery owns a bounded helper server. The timeout path must not return
 * while that server is still shutting down (design D2): the helper handle is
 * recorded here and cancelled before the timeout rejection reaches the caller.
 */
export function createTrackedDiscovery(): { discover: PreflightDiscovery; cancel: () => Promise<void> } {
  let handle: OpencodeHandle | undefined
  return {
    discover: (directory, signal) => discoverProviderCatalog(directory, signal, (next) => (handle = next)),
    cancel: async () => {
      await handle?.stop()
      handle = undefined
    },
  }
}

async function discoverProviderCatalog(
  directory: string,
  signal: AbortSignal,
  track?: (handle: OpencodeHandle) => void,
): Promise<ProviderCatalog> {
  const handle = await startOpencode({}, signal)
  track?.(handle)
  try {
    // Runs use the classic session API, whose provider catalog owns the
    // credential connections and exact model IDs accepted by session.prompt.
    // The newer client.v2 catalog is a separate provider system and can omit
    // working classic providers such as an authenticated OpenAI connection.
    const providerResult = await handle.client.provider.list({ directory })
    if (providerResult.error || !providerResult.data) throw new Error("OpenCode could not list connected providers and models")
    return providerResult.data
  } finally {
    await handle.close()
  }
}

/**
 * Races the operation against its timeout. On timeout the cancel hook runs to
 * completion *before* the rejection settles, so the caller never returns ahead
 * of the bounded owned-server stop — and never awaits the original request.
 * The operation's own `finally` also closes the handle; the stop is idempotent.
 */
export function withinPreflightTimeout<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  cancel?: () => Promise<void>,
): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("OpenCode preflight timed out"))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    signal.addEventListener(
      "abort",
      () => {
        if (settled) return
        settled = true
        void (async () => {
          try {
            await cancel?.()
          } catch {
            // Cleanup failure never masks the timeout itself.
          }
          reject(new Error("OpenCode preflight timed out"))
        })()
      },
      { once: true },
    )
    operation.then(
      (value) => {
        if (settled) return
        settled = true
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        reject(error)
      },
    )
  })
}
