/**
 * Session-bound handle registration and release (change `unify-runner-system`, task 4.3).
 *
 * The report and advisor handles are bound to one session and must be released
 * at the phase's decision — never while a human gate is still open — so a late
 * submission from a resolved window cannot reach a later attempt. This is the
 * common, capability-agnostic operation the engine uses; the runner supplies the
 * handle source, core decides when to release.
 */

import type { AdvisorRuntime } from "../advisor-runtime"
import type { QualityDimension } from "../quality-score"
import type { ReportRuntime } from "../report-runtime"
import type { AgentStep, DeliverableContract } from "../types"
import type { ExecutionServices } from "./contracts"

export type SessionHandle = { end(): void }

/** A runtime that owns handles keyed by session id (report/advisor runtimes). */
export type HandleSource = { handleFor(sessionID: string): SessionHandle | undefined }

/**
 * Ends the handles for one exact session. Idempotent: a handle that was already
 * ended, or a session that never began one, is a no-op.
 */
export function releaseSessionHandles(sessionID: string | undefined, ...sources: readonly (HandleSource | undefined)[]): void {
  if (!sessionID) return
  for (const source of sources) source?.handleFor(sessionID)?.end()
}

export type BeginSessionHandlesInput = {
  /** The services the runner's composition bound; only those get a handle. */
  services: ExecutionServices
  reports?: ReportRuntime
  advisors?: AdvisorRuntime
  phase: AgentStep
  contract: DeliverableContract
  weights: Record<QualityDimension, number>
  attempt: number
}

/**
 * Registers the attempt's session with the runtimes behind its bound services.
 * The write_report and advisor bridges resolve a call by session id, so a
 * bound service is unreachable until its session begins here; the handles live
 * until `releaseSessionHandles` at the phase's decision.
 */
export function beginSessionHandles(sessionID: string, input: BeginSessionHandlesInput): void {
  if (input.services.deliverables) input.reports?.begin(sessionID, input.phase, input.contract, input.weights)
  if (input.services.advisor) input.advisors?.begin(sessionID, input.phase, input.attempt)
}
