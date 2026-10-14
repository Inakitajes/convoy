/**
 * Adapter composition (change `runner-parity-opencode-v2`, task 2.2).
 *
 * The composition root is the one place that knows which concrete adapters
 * exist. It registers them in a `RunnerRegistry` keyed by runner id, so the
 * scheduler can dispatch an attempt by runner without importing a vendor type.
 */

import { RunnerRegistry, type RunnerId } from "./contracts"
import { createClaudeRunner, type ClaudeRunnerOptions } from "./claude/adapter"
import { createOpencodeRunner, type OpencodeRunner } from "./opencode/adapter"

export type RegistryOptions = {
  /** Checkout the run executes in. */
  cwd: string
  env?: NodeJS.ProcessEnv
  /** Overrides for the OpenCode adapter (config, binary, injected seams). */
  opencode?: Omit<OpencodeRunnerOptionsSubset, "cwd" | "env">
  /** Overrides for the Claude adapter (binary, injected seams). */
  claude?: Omit<ClaudeRunnerOptions, "cwd" | "env">
}

type OpencodeRunnerOptionsSubset = Parameters<typeof createOpencodeRunner>[0]

export type RunnerComposition = {
  registry: RunnerRegistry
  /** Stops every owned resource (currently the OpenCode server). */
  close(): Promise<void>
}

/** Registers the built-in adapters. Adapters boot lazily on first use. */
export function createDefaultRegistry(options: RegistryOptions): RunnerComposition {
  const registry = new RunnerRegistry()
  const opencode = createOpencodeRunner({
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    ...(options.opencode ?? {}),
  })
  const claude = createClaudeRunner({
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    ...(options.claude ?? {}),
  })

  registry.register({ id: "opencode", execution: opencode })
  registry.register({ id: "claude-code", execution: claude })

  return {
    registry,
    async close() {
      await opencode.close().catch(() => undefined)
    },
  }
}

/** Convenience: the runner ids the composition supports. */
export function supportedRunners(composition: RunnerComposition): RunnerId[] {
  return [...composition.registry.list()]
}

export type { OpencodeRunner }
