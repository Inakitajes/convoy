/**
 * Runner composition (change `runner-parity-opencode-v2`, tasks 2.2/5.1/6.2).
 *
 * The composition root is the single place that assembles a run's adapters:
 * it takes the Claude enforcement plan (PreToolUse hook + MCP permission
 * host) so write/verify attempts are enforced rather than refused, registers
 * both adapters behind the neutral registry, and owns how each binds Convoy's
 * services.
 */

import { createClaudeRunner, type ClaudeRunnerOptions } from "./claude/adapter"
import { createOpencodeRunner } from "./opencode/adapter"
import { executeClaudeAttempt } from "./claude/attempt"
import { executeOpencodeAttempt } from "./opencode/attempt"
import { bindOpencodeServices } from "./opencode/services"
import { RunnerRegistry, type ExecutionServices, type RunnerCapabilities, type RunnerId } from "./contracts"
import type { ServiceRuntimes } from "./service-runtimes"

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
  /**
   * Binds the engine's runtimes into the services this runner honors. A runner
   * that binds none still runs; its requirements were already validated by
   * capability.
   */
  servicesFor(id: RunnerId, runtimes: ServiceRuntimes, capabilities: RunnerCapabilities): ExecutionServices
  /**
   * True when the runner's attempt session lives on the run's server and must
   * be aborted there on shutdown. A process-owned session (Claude) ends with
   * the attempt's cancellation signal instead.
   */
  abortsSessionOnShutdown(id: RunnerId): boolean
  close(): Promise<void>
}

type AttemptRegistration = {
  run: PhaseAttemptRunner
  bindServices?: (runtimes: ServiceRuntimes, capabilities: RunnerCapabilities) => ExecutionServices
  serverSession: boolean
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
  const attempts: Partial<Record<RunnerId, AttemptRegistration>> = {
    "opencode": { run: executeOpencodeAttempt, bindServices: bindOpencodeServices, serverSession: true },
    // Claude binds no engine runtime: its report is the final assistant text or
    // the report file, which core resolves and validates after exit, and it
    // honors neither the advisor bridge nor the loop guard.
    "claude-code": { run: (context) => executeClaudeAttempt(context, claude), serverSession: false },
  }
  return {
    registry,
    attemptFor: (id) => attempts[id]?.run,
    servicesFor: (id, runtimes, capabilities) => attempts[id]?.bindServices?.(runtimes, capabilities) ?? {},
    abortsSessionOnShutdown: (id) => attempts[id]?.serverSession ?? false,
    async close() {
      await opencode.close().catch(() => undefined)
    },
  }
}
