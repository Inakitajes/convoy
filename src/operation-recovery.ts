import type { OperationRecord, OperationStep } from "./operation-journal"
import { acknowledgeStep, cancelStep, readOperation, resolveOperation } from "./operation-journal"

/**
 * Recovery dispatch (change `worktree-control-center`, task 2.4, design D9):
 * reconcile an unresolved operation against reality before any replay.
 * Recovery never blindly repeats a step: every unacknowledged effect is
 * inspected through the caller's `reconcile` probe, verified effects are
 * acknowledged, unexplained evidence blocks, and continuing or cancelling
 * requires the operator's explicit consent. A missing acknowledgement is not
 * evidence that an effect failed — which is exactly why the probe exists.
 */

/** What the reality probe found for one unacknowledged step. */
export type ReconcileFinding =
  | { finding: "verified"; evidence?: unknown }
  | { finding: "pending"; reason?: string }
  | { finding: "unexplained"; reason: string }

export type ReconcileProbe = (step: OperationStep, record: OperationRecord) => Promise<ReconcileFinding>

/** The per-step result recovery reports back to the operator. */
export type Reconciliation =
  | { stepId: string; state: "verified"; evidence?: unknown }
  | { stepId: string; state: "pending"; reason?: string }
  | { stepId: string; state: "unexplained"; reason: string }
  | { stepId: string; state: "cancelled" }
  | { stepId: string; state: "already-done" }

export type RecoveryOutcome =
  | { status: "unknown-operation"; reason: string }
  | { status: "awaiting-consent"; reason: string; reconciliation: Reconciliation[] }
  | { status: "reconciled"; reconciliation: Reconciliation[] }
  | { status: "needs-work"; reconciliation: Reconciliation[]; remaining: string[] }
  | { status: "cancelled"; reconciliation: Reconciliation[] }
  | { status: "blocked"; reconciliation: Reconciliation[]; reason: string }

export type RecoveryConsent = "inspect" | "continue" | "cancel"

/**
 * Inspects (and, with consent, resolves) one pending operation. `inspect`
 * consent never mutates: it only reconciles in memory and reports. `continue`
 * acknowledges verified effects and leaves genuinely pending work for the
 * caller's fresh preflight; `cancel` explicitly cancels remaining steps and
 * resolves the operation. Unexplained evidence blocks in every mode.
 */
export async function recoverOperation(input: {
  commonDir: string
  operationId: string
  gitCwd: string
  probe: ReconcileProbe
  consent?: RecoveryConsent
}): Promise<RecoveryOutcome> {
  const read = await readOperation(input.commonDir, input.operationId)
  if (read.status === "unsupported") {
    return { status: "unknown-operation", reason: `operation ${input.operationId} uses an unsupported schema version and must not be interpreted` }
  }
  if (read.status !== "found") {
    return { status: "unknown-operation", reason: `operation ${input.operationId} is not a readable pending operation in this repository` }
  }
  const record = read.value

  const reconciliation: Reconciliation[] = []
  let unexplained: string | undefined
  const pendingSteps: string[] = []

  for (const step of record.steps) {
    if (step.acknowledgement) {
      reconciliation.push({ stepId: step.id, state: "already-done" })
      continue
    }
    if (step.cancelled) {
      reconciliation.push({ stepId: step.id, state: "cancelled" })
      continue
    }
    const finding = await input.probe(step, record)
    if (finding.finding === "verified") {
      // A verified effect is acknowledged even under inspect-only consent:
      // recording observed reality is evidence-keeping, not an effect.
      const mutation = await acknowledgeStep(input.commonDir, input.operationId, step.id, finding.evidence)
      if (!mutation.ok) {
        return { status: "blocked", reason: `could not record the verified effect of ${step.id}: ${mutation.reason}`, reconciliation }
      }
      reconciliation.push({ stepId: step.id, state: "verified", ...(finding.evidence !== undefined ? { evidence: finding.evidence } : {}) })
      continue
    }
    if (finding.finding === "unexplained") {
      unexplained = unexplained ? `${unexplained}; ${step.id}: ${finding.reason}` : `${step.id}: ${finding.reason}`
      reconciliation.push({ stepId: step.id, state: "unexplained", reason: finding.reason })
      continue
    }
    pendingSteps.push(step.id)
    reconciliation.push({ stepId: step.id, state: "pending", ...(finding.reason !== undefined ? { reason: finding.reason } : {}) })
  }

  if (unexplained) {
    return { status: "blocked", reason: `unexplained repository state — inspect before any retry (${unexplained})`, reconciliation }
  }

  const consent = input.consent ?? "inspect"
  if (consent === "inspect") {
    if (pendingSteps.length > 0) {
      return { status: "awaiting-consent", reason: `operation ${input.operationId} still has pending steps: ${pendingSteps.join(", ")}`, reconciliation }
    }
    // Everything is verified or explicitly cancelled: the journal is fully
    // reconciled and can be resolved without further consent.
    const resolution = await resolveOperation({ commonDir: input.commonDir, operationId: input.operationId, gitCwd: input.gitCwd, outcome: "resolved" })
    if (!resolution.ok) return { status: "blocked", reason: resolution.reason, reconciliation }
    return { status: "reconciled", reconciliation }
  }

  if (consent === "cancel") {
    for (const stepId of pendingSteps) {
      const mutation = await cancelStep(input.commonDir, input.operationId, stepId)
      if (!mutation.ok) {
        return { status: "blocked", reason: `could not cancel ${stepId}: ${mutation.reason}`, reconciliation }
      }
    }
    const resolution = await resolveOperation({ commonDir: input.commonDir, operationId: input.operationId, gitCwd: input.gitCwd, outcome: "cancelled" })
    if (!resolution.ok) return { status: "blocked", reason: resolution.reason, reconciliation }
    return { status: "cancelled", reconciliation }
  }

  // consent === "continue": pending steps stay pending for the caller's fresh
  // preflight; verified effects are recorded so they are never replayed.
  return { status: "needs-work", reconciliation, remaining: pendingSteps }
}
