/**
 * Runner composition (change `runner-parity-opencode-v2`, tasks 2.2/5.1/6.2).
 *
 * The composition root is the single place that assembles a run's adapters:
 * it takes the Claude enforcement plan (PreToolUse hook + MCP permission
 * host) so write/verify attempts are enforced rather than refused, registers
 * every adapter behind the neutral registry, and owns how each binds Convoy's
 * services.
 */

import { createClaudeRunner, type ClaudeRunnerOptions } from "./claude/adapter"
import { createCodexRunner, type CodexRunnerOptions } from "./codex/adapter"
import { codexMcpHost, executeCodexAttempt } from "./codex/attempt"
import { createOpencodeRegistration } from "./opencode/registration"
import { executeClaudeAttempt } from "./claude/attempt"
import { executeOpencodeAttempt } from "./opencode/attempt"
import { bindOpencodeServices } from "./opencode/services"
import { createLoopGuardService } from "./loop-guard-service"
import { createSessionAdvisorService } from "./session-advisor"
import { createSessionDeliverableService } from "./session-deliverables"
import { supportsService } from "./capabilities"
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
  /** Claude enforcement plan; without it, Claude write/verify attempts fail closed. */
  enforcement?: EnforcementPlan
  claude?: Omit<ClaudeRunnerOptions, "cwd" | "env" | "enforcement">
  codex?: Omit<CodexRunnerOptions, "cwd" | "env">
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

/**
 * A CLI runner (Claude, Codex) binds the operator's approval gate, the
 * session-scoped deliverable service its `write_report` MCP tool submits
 * through, and the advisor its checkpoint and `advisor` tool consult — all
 * keyed by the session the attempt reports, so a call can never land in a
 * sibling attempt. A runner that can apply a nudge or a stop (Codex) also
 * gets the loop guard.
 */
function bindCliServices(runtimes: ServiceRuntimes, capabilities: RunnerCapabilities): ExecutionServices {
  const services: ExecutionServices = {}
  if (supportsService(capabilities, "loop-guard")) services.loopGuard = createLoopGuardService(runtimes.loopGuard)
  if (runtimes.approvals && supportsService(capabilities, "approvals")) services.approvals = runtimes.approvals
  if (runtimes.reports && supportsService(capabilities, "deliverables")) {
    services.deliverables = createSessionDeliverableService({
      runtime: runtimes.reports,
      session: runtimes.session,
      expected: runtimes.expected,
      ...(runtimes.accepts ? { accepts: runtimes.accepts } : {}),
    })
  }
  if (runtimes.advisors && supportsService(capabilities, "advisor")) {
    services.advisor = createSessionAdvisorService({ runtime: runtimes.advisors, session: runtimes.session })
  }
  return services
}

/** Registers the built-in adapters with the assembled options. */
export function composeRunners(options: ComposeOptions): Composition {
  const registry = new RunnerRegistry()
  const opencode = createOpencodeRegistration()
  const claude = createClaudeRunner({
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    ...(options.enforcement ? { enforcement: options.enforcement } : {}),
    ...(options.claude ?? {}),
  })
  const codex = createCodexRunner({
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    mcpHost: codexMcpHost(options.env),
    ...(options.codex ?? {}),
  })
  registry.register({ id: "opencode", execution: opencode })
  registry.register({ id: "claude-code", execution: claude })
  registry.register({ id: "codex", execution: codex })
  const attempts: Partial<Record<RunnerId, AttemptRegistration>> = {
    "opencode": { run: executeOpencodeAttempt, bindServices: bindOpencodeServices, serverSession: true },
    // Claude binds approvals, deliverables, and the advisor (see
    // bindCliServices); print mode cannot take a mid-turn nudge, so it
    // does not honor the loop guard.
    "claude-code": { run: (context) => executeClaudeAttempt(context, claude), bindServices: bindCliServices, serverSession: false },
    // Codex binds the same services plus the loop guard: a nudge steers its
    // running turn and a stop interrupts it.
    codex: { run: (context) => executeCodexAttempt(context, codex), bindServices: bindCliServices, serverSession: false },
  }
  return {
    registry,
    attemptFor: (id) => attempts[id]?.run,
    servicesFor: (id, runtimes, capabilities) => attempts[id]?.bindServices?.(runtimes, capabilities) ?? {},
    abortsSessionOnShutdown: (id) => attempts[id]?.serverSession ?? false,
    // No registration owns a process: OpenCode's server is the run's, and
    // each Claude or Codex attempt owns and ends its own child.
    async close() {},
  }
}
