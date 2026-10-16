/**
 * Run-lifetime attempt composition (change `unify-runner-system`, task 6.1).
 *
 * The engine builds one composition per run directory and reuses it across that
 * run's phase attempts, instead of rebuilding the adapters per attempt. The
 * adapters are stateless here (the run coordinator owns the OpenCode server), so
 * a cached composition holds no process resources; `releaseAttemptCompositions`
 * drops the cache and closes what it holds.
 */

import { resolveClaudeEnforcement } from "./claude/enforcement-plan"
import { composeRunners, type ComposeOptions, type Composition } from "./compose"

const cache = new Map<string, Composition>()

export type AttemptCompositionOptions = {
  cwd: string
  env?: NodeJS.ProcessEnv
  /** Defaults to the environment override, else this Convoy's own hook and permission host. */
  enforcement?: ComposeOptions["enforcement"]
}

function cacheKey(options: AttemptCompositionOptions): string {
  return `${options.cwd}\u0000${options.enforcement ? JSON.stringify(options.enforcement) : "default"}`
}

/** The run-lifetime composition for a run directory, reused across its attempts. */
export function attemptCompositionFor(options: AttemptCompositionOptions): Composition {
  const key = cacheKey(options)
  const existing = cache.get(key)
  if (existing) return existing

  const composition = composeRunners({
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    enforcement: options.enforcement ?? resolveClaudeEnforcement(options.env ?? process.env),
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
