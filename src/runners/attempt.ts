/**
 * The common phase-attempt contract (change `unify-runner-system`, tasks 4.1–4.4).
 *
 * The engine prepares one attempt context for every runner and dispatches it
 * through the registry, so there is no harness-specific execution branch in
 * core. The adapter owns the attempt (protocol, sessions, event decoding,
 * checkpoints, permissions); core keeps scheduling, budgets, git boundaries,
 * retries and finalization (design D3).
 *
 * The context carries phase data, the neutral sink, the cancellation signal,
 * the services the runner's composition bound, and the reviewed action policy
 * — never an engine-owned runtime. `requiredServicesFor` expresses what a
 * phase genuinely requires so support is validated by capability before the
 * attempt starts.
 */

import type { AdvisorUsage, ModelSelection } from "../advisor"
import type { AdvisorEvent } from "../advisor-events"
import type { FilePartInput, OpencodeClient } from "../opencode-client"
import type { AgentStep, DeliverableContract } from "../types"
import type { AttemptIdentity, AuthenticationSelection, ExecutionServices, RunnerCapabilities, RunnerId, ServiceId } from "./contracts"
import { assertServicesSupported } from "./capabilities"
import type { AttemptSink } from "./attempt-sink"
import type { PolicyConfig } from "./policy"

/** Everything one attempt needs; prepared once by the engine, consumed by the adapter. */
export type AttemptContext = {
  identity: AttemptIdentity
  runner: RunnerId
  /** The phase being run: Convoy data, not an engine policy object. */
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
  /** The services this runner honors; the engine owns their implementations. */
  services: ExecutionServices
  /** Convoy's reviewed action policy for the attempt, for adapters that enforce it themselves. */
  policy?: PolicyConfig
  /** The reviewed authentication for a harness that selects one (Claude); absent means subscription. */
  auth?: AuthenticationSelection
  /** Process environment for a CLI harness (Claude). */
  env?: NodeJS.ProcessEnv
  /** Where a CLI harness tees its raw event stream (`logs/<step>.<attempt>.claude.jsonl`); absent writes none. */
  streamLogPath?: string
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

/**
 * The optional services a phase genuinely requires. Only the deliverable
 * contract is a hard requirement today: an advisor is advisory (a hold, not a
 * block) and the loop guard is a Convoy safety net the engine applies where the
 * runner can honor it, so neither is required of every runner.
 */
export function requiredServicesFor(contract: DeliverableContract): ServiceId[] {
  return contract.kind === "none" ? [] : ["deliverables"]
}
