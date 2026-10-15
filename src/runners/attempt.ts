/**
 * The common phase-attempt contract (change `unify-runner-system`, tasks 4.1–4.4).
 *
 * The engine prepares one attempt context for every runner and dispatches it
 * through the registry, so there is no harness-specific execution branch in
 * core. The adapter owns the attempt (protocol, sessions, event decoding,
 * checkpoints, permissions); core keeps scheduling, budgets, git boundaries,
 * retries and finalization (design D3).
 *
 * The context carries the Convoy policy objects the engine owns during the
 * migration (report/advisor runtimes, the shutdown handle, the progress
 * target). `prepareAttemptRequest` derives the neutral `ExecutionRequest` from
 * it, and `requiredServicesFor` expresses what a phase genuinely requires so
 * support is validated by capability before the attempt starts.
 */

import type { AdvisorUsage, ModelSelection } from "../advisor"
import type { AdvisorEvent } from "../advisor-events"
import type { AdvisorRuntime } from "../advisor-runtime"
import type { LoopGuard, LoopGuardConfig } from "../loop-guard"
import type { FilePartInput, OpencodeClient } from "../opencode-client"
import type { ProgressUI } from "../progress"
import type { QualityDimension } from "../quality-score"
import type { ReportRuntime } from "../report-runtime"
import type { AgentStep, DeliverableContract } from "../types"
import type { Workspace } from "../workspace"
import type { AttemptIdentity, ExecutionRequest, RunnerCapabilities, RunnerId, ServiceId } from "./contracts"
import { assertServicesSupported } from "./capabilities"
import type { AttemptSink } from "./attempt-sink"
import type { SessionRef } from "./opencode/session"

/** Everything one attempt needs; prepared once by the engine, consumed by the adapter. */
export type AttemptContext = {
  identity: AttemptIdentity
  runner: RunnerId
  workspace: Workspace
  phase: AgentStep
  targetDir: string
  prompt: string
  model: ModelSelection
  /** OpenCode file parts; a CLI adapter converts them to its own attachments. */
  attachments: FilePartInput[]
  /** The neutral event sink the attempt emits to; the engine renders it. */
  sink: AttemptSink
  /** Cancellation for the attempt; the engine owns the shutdown machinery. */
  signal: AbortSignal
  attempt: number
  sessionRef?: SessionRef
  /** Absent when no step in the run has an advisor. */
  advisors?: AdvisorRuntime
  /** Present for OpenCode runs; Claude keeps its assistant-text fallback. */
  reports?: ReportRuntime
  deliverableContract?: DeliverableContract
  rubricWeights?: Record<QualityDimension, number>
  /** The resolved guard configuration, already resolved by the engine. */
  loopGuardConfig: LoopGuardConfig
  /** Reused only after a budget-gate reset; ordinary attempts receive a fresh guard. */
  loopGuard?: LoopGuard
  /** Process environment for a CLI harness (Claude). */
  env?: NodeJS.ProcessEnv
  /** The run's OpenCode client, when the runner is OpenCode. */
  client?: OpencodeClient
}

/** The normalized attempt result the engine consumes, independent of the harness. */
export type AttemptResult = {
  assistantText: string
  sessionID?: string
  model: ModelSelection | string
  finish?: unknown
  cost?: number
  tokens?: unknown
  error?: unknown
  advisorUsage?: readonly AdvisorUsage[]
  advisorEvents?: readonly AdvisorEvent[]
}

/** One runner's phase attempt. Registered per runner; no harness branch in core. */
export type PhaseAttemptRunner = (context: AttemptContext) => Promise<AttemptResult>

export type AttemptResolution = {
  runner: RunnerId
  contract: DeliverableContract
  /** The runner's own declared capabilities. */
  capabilities(): Promise<RunnerCapabilities>
  /** The registered attempt, when the runner has one. */
  attempt: PhaseAttemptRunner | undefined
}

/**
 * Resolves the attempt to run: it validates the phase's required services
 * against the runner's own capabilities (refusing before any attempt) and
 * returns the registered attempt. Registering a new harness needs only its
 * adapter, its capability declaration and this registration — no engine change.
 */
export async function resolveAttempt(input: AttemptResolution): Promise<PhaseAttemptRunner> {
  const capabilities = await input.capabilities()
  assertServicesSupported(capabilities, requiredServicesFor(input.contract))
  if (!input.attempt) throw new Error(`no phase attempt registered for runner: ${input.runner}`)
  return input.attempt
}

/** The neutral request derived from an attempt context. */
export function prepareAttemptRequest(context: AttemptContext): ExecutionRequest {
  const { phase } = context
  return {
    identity: context.identity,
    runner: context.runner,
    checkout: context.targetDir,
    agent: {
      name: phase.agentName,
      mode: phase.readOnly ? (phase.verify ? "verify" : "read-only") : "write",
      model: {
        runner: context.runner,
        modelId: context.model.modelID,
        ...(context.model.variant ? { variant: context.model.variant } : {}),
      },
    },
    prompt: context.prompt,
    auth: { mode: "subscription" },
    mode: phase.readOnly ? (phase.verify ? "verify" : "read-only") : "write",
    approvals: "auto",
    ...(context.deliverableContract ? { deliverableContract: context.deliverableContract.kind } : {}),
    signal: context.signal,
  }
}

/**
 * The optional services a phase genuinely requires. Only the deliverable
 * contract is a hard requirement today: an advisor is advisory (a hold, not a
 * block) and the loop guard is a Convoy safety net the engine applies where the
 * runner can honor it, so neither is required of every runner.
 */
export function requiredServicesFor(contract: DeliverableContract): ServiceId[] {
  return contract.kind === "none" ? [] : ["deliverables"]
}
