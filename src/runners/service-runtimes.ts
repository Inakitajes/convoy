/**
 * The engine-owned runtimes a runner may bind into attempt services.
 *
 * The engine owns these Convoy policy objects for the whole run; each adapter
 * decides which of them it can honor and binds them to its attempt's session.
 * The attempt itself only ever receives the bound services.
 */

import type { AdvisorRuntime } from "../advisor-runtime"
import type { LoopGuard } from "../loop-guard"
import type { ReportRuntime } from "../report-runtime"
import type { ApprovalService, DeliverableKind } from "./contracts"

export type ServiceRuntimes = {
  /** The operator's approval gate, for a runner whose asks arrive out of process. */
  approvals?: ApprovalService
  reports?: ReportRuntime
  advisors?: AdvisorRuntime
  loopGuard: LoopGuard
  /** Artifacts the phase's deliverable contract expects. */
  expected: readonly DeliverableKind[]
  /** Core's contract check for the attempt's deliverable so far (candidate, else the report file). */
  accepts?: (candidate: string | undefined) => Promise<boolean>
  /** The attempt's session, known once the attempt reports it. */
  session: () => string | undefined
}
