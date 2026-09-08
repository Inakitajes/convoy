import { isAncestor, resolveCommit, statusPorcelain } from "./git"
import { readCheckoutActiveChanges } from "./checkout-openspec"
import { openspecDirName } from "./openspec"
import type { OperationRecord, OperationStep } from "./operation-journal"
import type { ReconcileFinding } from "./operation-recovery"

/**
 * Kind-specific reality probes for recovery (change `worktree-control-center`,
 * task 2.4, design D9; gap CC-7): recovery inspects what actually happened
 * instead of trusting the journal's last phase label. Each operation family
 * records its frozen intent before its effect; this module re-observes the
 * repository against that intent and reports `verified` only when current Git
 * or filesystem evidence proves the effect happened, `pending` when it
 * plausibly has not run yet, and `unexplained` when reality contradicts the
 * record. A missing acknowledgement is never treated as a failed effect.
 *
 * Recorded intent shapes (the frozen inputs each effect needs to be
 * re-observable):
 * - landing/squash step: `{ candidateSha, base }` — the candidate commit and
 *   the reviewed base ref. Verified when the candidate is reachable from the
 *   base (the crash-after-landing-before-acknowledgement case).
 * - push step: `{ remote, remoteRef, oid }` — verified when the locally known
 *   remote-tracking ref holds exactly the pinned OID.
 * - archive step: `{ changeId, checkout }` — verified when the change has
 *   left that checkout's active set.
 */

type EffectIntent = {
  candidateSha?: unknown
  base?: unknown
  remote?: unknown
  remoteRef?: unknown
  oid?: unknown
  changeId?: unknown
  changes?: unknown
  checkout?: unknown
  hostingRepo?: unknown
  headRepo?: unknown
  headBranch?: unknown
  baseRepo?: unknown
  baseBranch?: unknown
}

function intentOf(step: OperationStep, record: OperationRecord): EffectIntent {
  const raw = (step.intent ?? record.intent) as unknown
  return typeof raw === "object" && raw !== null ? (raw as EffectIntent) : {}
}

const landingKinds = new Set(["close", "squash"])

/**
 * The reality probe `convoy worktrees recover` runs. Unknown step shapes stay
 * pending — recovery never guesses an effect it cannot re-observe.
 */
export async function reconcileStepReality(step: OperationStep, record: OperationRecord, gitCwd: string): Promise<ReconcileFinding> {
  const intent = intentOf(step, record)

  if (landingKinds.has(record.kind) && typeof intent.candidateSha === "string" && typeof intent.base === "string") {
    const candidate = await resolveCommit(intent.candidateSha, gitCwd)
    if (!candidate) {
      // Intent was recorded before the effect, so a missing candidate means
      // the landing never completed — pending, not unexplained and not failed.
      return { finding: "pending", reason: `the recorded candidate ${intent.candidateSha.slice(0, 8)} is not a commit in this repository — the landing step has not completed` }
    }
    const contained = await isAncestor(intent.candidateSha, intent.base, gitCwd)
    if (contained) {
      return { finding: "verified", evidence: { candidateSha: intent.candidateSha, base: intent.base } }
    }
    // The candidate exists but the base does not contain it: the stale
    // candidate must not be re-landed, and the divergence is for inspection.
    return { finding: "unexplained", reason: `the recorded candidate ${intent.candidateSha.slice(0, 8)} is not reachable from the reviewed base ${intent.base} — inspect before any retry` }
  }

  if (record.kind === "push" && typeof intent.remote === "string" && typeof intent.remoteRef === "string" && typeof intent.oid === "string") {
    const remoteTip = await resolveCommit(`${intent.remote}/${intent.remoteRef}`, gitCwd)
    if (remoteTip === intent.oid) {
      return { finding: "verified", evidence: { remote: intent.remote, remoteRef: intent.remoteRef, oid: intent.oid } }
    }
    return { finding: "pending", reason: `${intent.remote}/${intent.remoteRef} is ${remoteTip ? remoteTip.slice(0, 8) : "unresolvable"} locally, not the pinned ${intent.oid.slice(0, 8)} — fetch to refresh remote-tracking refs before deciding` }
  }

  if (record.kind === "archive" && typeof intent.changeId === "string" && typeof intent.checkout === "string") {
    const local = await readCheckoutActiveChanges(intent.checkout)
    if (local.kind !== "known") {
      return { finding: "pending", reason: `the checkout's active changes could not be read: ${local.reason}` }
    }
    if (!local.value.some((change) => change.changeId === intent.changeId)) {
      return { finding: "verified", evidence: { changeId: intent.changeId, checkout: intent.checkout } }
    }
    return { finding: "pending", reason: `${intent.changeId} is still an active change of ${intent.checkout}` }
  }

  // The archive operation's commit step (task 6.4): verified only when the
  // recorded changes have all left the active set AND no uncommitted OpenSpec
  // output remains — archived-but-uncommitted output is pending, never done.
  if (record.kind === "archive" && Array.isArray(intent.changes) && typeof intent.checkout === "string") {
    const changes = intent.changes.filter((entry): entry is string => typeof entry === "string")
    const local = await readCheckoutActiveChanges(intent.checkout)
    if (local.kind !== "known") {
      return { finding: "pending", reason: `the checkout's active changes could not be read: ${local.reason}` }
    }
    const stillActive = changes.filter((id) => local.value.some((change) => change.changeId === id))
    if (stillActive.length > 0) {
      return { finding: "pending", reason: `${stillActive.join(", ")} ${stillActive.length === 1 ? "is" : "are"} still active — the archive steps have not completed` }
    }
    const status = await statusPorcelain(intent.checkout).catch(() => undefined)
    if (status === undefined) {
      return { finding: "pending", reason: "the checkout's working-tree state could not be read" }
    }
    const uncommitted = status.split("\n").filter((line) => line.trim() !== "" && line.slice(3).trim().startsWith(`${openspecDirName}/`))
    if (uncommitted.length > 0) {
      return { finding: "pending", reason: "the archive output is still uncommitted in the checkout — the commit step has not completed" }
    }
    return { finding: "verified", evidence: { checkout: intent.checkout, changes } }
  }

  if (record.kind === "pr" && typeof intent.hostingRepo === "string" && typeof intent.headBranch === "string" && typeof intent.baseBranch === "string") {
    // The create step's effect is re-observed through the same scoped query
    // the operation used: an open PR with the exact recorded scope proves the
    // creation (or the reuse) happened; a failed query stays unknown.
    const { queryOpenPr } = await import("./pr-operations")
    const checkout = typeof intent.checkout === "string" ? intent.checkout : gitCwd
    const existing = await queryOpenPr(
      {
        hostingRepo: intent.hostingRepo,
        headRepo: typeof intent.headRepo === "string" ? intent.headRepo : intent.hostingRepo,
        headBranch: intent.headBranch,
        baseRepo: typeof intent.baseRepo === "string" ? intent.baseRepo : intent.hostingRepo,
        baseBranch: intent.baseBranch,
      },
      checkout,
    )
    if (existing.kind === "known" && existing.pr) {
      return { finding: "verified", evidence: { pr: existing.pr.number, url: existing.pr.url } }
    }
    return { finding: "pending", reason: existing.kind === "unknown" ? `the open-PR query is unavailable: ${existing.reason}` : `no open PR matches ${intent.headBranch} → ${intent.baseBranch} yet` }
  }

  return { finding: "pending", reason: "no re-observable effect was recorded for this step" }
}
