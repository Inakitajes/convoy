/**
 * Run-lifetime attempt composition (change `unify-runner-system`, task 6.1).
 *
 * The engine builds one composition per run and reuses it across that run's
 * phase attempts, instead of rebuilding the adapters per attempt. The adapters
 * are stateless here (the run coordinator owns the OpenCode server), so a
 * cached composition holds no process resources; the run's teardown calls
 * `releaseAttemptCompositions(runId)` to drop and close exactly its own.
 */

import { resolveClaudeEnforcement } from "./claude/enforcement-plan"
import { composeRunners, type ComposeOptions, type Composition } from "./compose"

const cache = new Map<string, Composition>()

export type AttemptCompositionOptions = {
  /** The run the composition belongs to; its teardown releases it. */
  runId?: string
  cwd: string
  env?: NodeJS.ProcessEnv
  /** Defaults to the environment override, else this Convoy's own hook and permission host. */
  enforcement?: ComposeOptions["enforcement"]
}

function cacheKey(options: AttemptCompositionOptions): string {
  return `${options.runId ?? ""}\u0000${options.cwd}\u0000${options.enforcement ? JSON.stringify(options.enforcement) : "default"}`
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

/** Drops and closes one run's cached compositions, or every one when no run is named (tests). */
export async function releaseAttemptCompositions(runId?: string): Promise<void> {
  const released: Composition[] = []
  for (const [key, composition] of cache) {
    if (runId !== undefined && !key.startsWith(`${runId}\u0000`)) continue
    cache.delete(key)
    released.push(composition)
  }
  await Promise.all(released.map((composition) => composition.close().catch(() => undefined)))
}

/** The number of cached compositions (tests). */
export function cachedCompositionCount(): number {
  return cache.size
}
