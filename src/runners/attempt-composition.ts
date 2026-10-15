/**
 * Run-lifetime attempt composition (change `unify-runner-system`, task 6.1).
 *
 * The engine builds one composition per run directory and reuses it across that
 * run's phase attempts, instead of rebuilding the adapters per attempt. The
 * adapters are stateless here (the run coordinator owns the OpenCode server), so
 * a cached composition holds no process resources; `releaseAttemptCompositions`
 * drops the cache and closes what it holds.
 */

import { composeRunners, type ComposeOptions, type Composition } from "./compose"

const cache = new Map<string, Composition>()

export type AttemptCompositionOptions = {
  cwd: string
  env?: NodeJS.ProcessEnv
  enforcement?: ComposeOptions["enforcement"]
}

function cacheKey(options: AttemptCompositionOptions): string {
  return `${options.cwd}\u0000${options.enforcement ? "enforced" : "plain"}`
}

/** The run-lifetime composition for a run directory, reused across its attempts. */
export function attemptCompositionFor(options: AttemptCompositionOptions): Composition {
  const key = cacheKey(options)
  const existing = cache.get(key)
  if (existing) return existing

  const composition = composeRunners({
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    ...(options.enforcement ? { enforcement: options.enforcement } : {}),
  })
  cache.set(key, composition)
  return composition
}

/** Drops every cached composition and closes it (run teardown, or tests). */
export async function releaseAttemptCompositions(): Promise<void> {
  const all = [...cache.values()]
  cache.clear()
  await Promise.all(all.map((composition) => composition.close().catch(() => undefined)))
}
