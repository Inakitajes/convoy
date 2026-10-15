/**
 * Runner composition (change `runner-parity-opencode-v2`, tasks 2.2/5.1/6.2).
 *
 * The composition root is the single place that assembles a run's adapters:
 * it renders the Claude enforcement plan (PreToolUse hook + MCP permission
 * host) so write/verify attempts do not fail closed, and registers both
 * adapters behind the neutral registry.
 */

import { createClaudeRunner, type ClaudeRunnerOptions } from "./claude/adapter"
import { createOpencodeRunner } from "./opencode/adapter"
import { executeClaudeAttempt } from "./claude/attempt"
import { executeOpencodeAttempt } from "./opencode/attempt"
import { RunnerRegistry, type RunnerId } from "./contracts"

import { buildEnforcementPlan, type EnforcementCommands } from "./claude/enforcement-plan"
import type { EnforcementPlan } from "./claude/enforcement"
import type { PhaseAttemptRunner } from "./attempt"

export { buildEnforcementPlan }
export type { EnforcementCommands }

export type ComposeOptions = {
  cwd: string
  env?: NodeJS.ProcessEnv
  /** Rendered OpenCode run config (`OPENCODE_CONFIG_CONTENT`). */
  opencodeConfigContent?: string
  /** Claude enforcement plan; without it, Claude write/verify attempts fail closed. */
  enforcement?: EnforcementPlan
  claude?: Omit<ClaudeRunnerOptions, "cwd" | "env" | "enforcement">
  opencode?: Omit<Parameters<typeof createOpencodeRunner>[0], "cwd" | "env" | "configContent">
}

export type Composition = {
  registry: RunnerRegistry
  /** The registered rich phase attempt for a runner, so core has no harness branch. */
  attemptFor(id: RunnerId): PhaseAttemptRunner | undefined
  close(): Promise<void>
}

/** Registers the built-in adapters with the assembled options. */
export function composeRunners(options: ComposeOptions): Composition {
  const registry = new RunnerRegistry()
  const opencode = createOpencodeRunner({
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    ...(options.opencodeConfigContent ? { configContent: options.opencodeConfigContent } : {}),
    ...(options.opencode ?? {}),
  })
  const claude = createClaudeRunner({
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    ...(options.enforcement ? { enforcement: options.enforcement } : {}),
    ...(options.claude ?? {}),
  })
  registry.register({ id: "opencode", execution: opencode })
  registry.register({ id: "claude-code", execution: claude })
  const attempts: Partial<Record<RunnerId, PhaseAttemptRunner>> = {
    "opencode": executeOpencodeAttempt,
    "claude-code": executeClaudeAttempt,
  }
  return {
    registry,
    attemptFor: (id) => attempts[id],
    async close() {
      await opencode.close().catch(() => undefined)
    },
  }
}
