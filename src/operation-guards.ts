import { validateCheckoutTarget, observeCheckoutTarget, type ObservedCheckoutTarget } from "./worktree-target"
import { observeBaseDivergence, observeDirt, observeExecutionActivity, observeUpstreamDivergence } from "./worktree-observations"
import { readWriterClaim, claimLiveness, writerConflictGuidance, type WriterClaim } from "./writer-claims"
import { legacyConflictsForBranch } from "./legacy-operations"

/**
 * Shared operation guards (change `worktree-control-center`, task 2.2,
 * design D4): one inspect/review/execute assessment per action, consumed by
 * CLI commands, TUI menus, and direct handlers alike. No workflow engine and
 * no lifecycle assessment — each action's requirements are explicit, the
 * result names concrete blockers with remediation, and executing handlers
 * must re-run the same inspection before any effect. UI enabled states are
 * advisory projections of these guards; disabled actions stay inspectable.
 */

/** The actions the worktree control center exposes. */
export type OperationAction =
  | "fetch"
  | "sync"
  | "push"
  | "pr"
  | "archive"
  | "run"
  | "conversation"
  | "squash"
  | "close"
  | "remove"
  | "delete-branch"

export type OperationBlocker = {
  reason: string
  remediation: string
}

/** What the inspection observed, with unknown kept distinct from negative facts. */
export type OperationFacts = {
  branch?: string
  detached?: boolean
  head?: string
  dirt: { known: boolean; dirty?: boolean; fileCount?: number; reason?: string }
  base?: { ref: string; known: boolean; ahead?: number; behind?: number; baseContainedInSource?: boolean; reason?: string }
  upstream?: { known: boolean; upstream?: string; ahead?: number; behind?: number; reason?: string }
  activity: { known: boolean; liveRunIds?: string[]; reason?: string }
  writerClaim?: { claim: WriterClaim; liveness: "live" | "stale" | "uncertain" }
}

export type OperationInspection = {
  action: OperationAction
  /** The observed target; undefined when the checkout itself is unusable. */
  target?: ObservedCheckoutTarget
  /** The HEAD OID a mutation would pin (present when the target was observed). */
  pinnedHead?: string
  available: boolean
  blockers: OperationBlocker[]
  facts: OperationFacts
}

export type OperationRequirements = {
  /** A branch selector that must agree with the checkout's actual branch. */
  requireBranch?: string
  /** The action cannot run on a detached checkout (e.g. sync pushes to a branch). */
  requireAttachedBranch?: boolean
  /** The working tree must be readable and clean; unknown dirt blocks. */
  requireClean?: boolean
  /** No live or uncertain managed writer may own the checkout. */
  requireWriterFree?: boolean
  /** The action needs a resolvable base ref. */
  requireBase?: boolean
  /** The action needs a readable base comparison (same as requireBase plus divergence facts). */
  requireBaseFacts?: boolean
  /** The checkout must belong to this repository (common dir match). */
  requireCommonDir?: string
  /** Revalidate against a previously reviewed target before effects. */
  reviewedTarget?: ObservedCheckoutTarget
  /** The action needs execution activity to be readable (e.g. before close). */
  requireActivityKnown?: boolean
}

/** Per-action default requirements (design D4: each action owns its prerequisites). */
export function defaultRequirements(action: OperationAction): OperationRequirements {
  switch (action) {
    case "sync":
    case "squash":
    case "close":
      return { requireAttachedBranch: true, requireClean: true, requireWriterFree: true, requireBase: true, requireBaseFacts: true, requireActivityKnown: action === "close" }
    case "archive":
      return { requireAttachedBranch: true, requireClean: true, requireWriterFree: true }
    case "push":
      return { requireAttachedBranch: true, requireWriterFree: true }
    case "pr":
      return { requireAttachedBranch: true }
    case "run":
    case "conversation":
      return { requireWriterFree: true }
    case "remove":
    case "delete-branch":
      return { requireWriterFree: true }
    case "fetch":
      return {}
  }
}

/** Actions that mutate the branch's Git state or remove its checkout: an unresolved legacy close on the same branch conflicts. */
const mutatingActions = new Set<OperationAction>(["sync", "archive", "push", "squash", "close", "remove", "delete-branch"])

/**
 * Inspects one action against one checkout. Read-only: no fetch, no claim
 * writes, no mutation. A failed probe is a blocker with remediation — never
 * a negative fact and never a silent pass.
 */
export async function inspectOperation(input: {
  action: OperationAction
  checkout: string
  base?: string
  commonDir: string
  requirements?: Partial<OperationRequirements>
}): Promise<OperationInspection> {
  const requirements = { ...defaultRequirements(input.action), ...input.requirements }
  const blockers: OperationBlocker[] = []
  const facts: OperationFacts = {
    dirt: { known: false },
    activity: { known: false },
  }

  // 1. The target itself.
  let target: ObservedCheckoutTarget | undefined
  try {
    target = await observeCheckoutTarget(input.checkout)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    blockers.push({
      reason,
      remediation: "select a valid registered worktree (see `convoy worktrees`), or repair/prune the stale Git registration",
    })
    return { action: input.action, available: false, blockers, facts }
  }
  facts.branch = target.branch
  facts.detached = target.detached
  facts.head = target.head
  const pinnedHead = target.head

  // 2. Continuity with a previously reviewed target.
  if (requirements.reviewedTarget) {
    const validation = await validateCheckoutTarget(requirements.reviewedTarget, {
      ...(requirements.requireBranch !== undefined ? { requireBranch: requirements.requireBranch } : {}),
    })
    if (!validation.ok) {
      blockers.push({ reason: validation.reason, remediation: "re-review the target: the reviewed checkout is no longer the one in front of you" })
    }
  } else if (requirements.requireBranch !== undefined && target.branch !== requirements.requireBranch) {
    blockers.push({
      reason: `checkout ${input.checkout} has ${target.branch ?? "a detached HEAD"} checked out, not ${requirements.requireBranch}`,
      remediation: "select the checkout that actually carries the reviewed branch, or re-review with the actual branch",
    })
  }

  // 3. Repository membership.
  if (requirements.requireCommonDir && target.commonDir !== requirements.requireCommonDir) {
    blockers.push({
      reason: `checkout ${input.checkout} belongs to a different repository (${target.commonDir}) than the reviewed one (${requirements.requireCommonDir})`,
      remediation: "select a checkout of the reviewed repository",
    })
  }

  // 4. Detached-HEAD incompatibilities.
  if (requirements.requireAttachedBranch && target.detached) {
    blockers.push({
      reason: `checkout ${input.checkout} is in detached-HEAD state; ${input.action} needs an attached branch`,
      remediation: "attach the checkout to a branch (`git switch -c <branch>` or `git switch <branch>`) before retrying",
    })
  }

  // 5. Working-tree dirt: unknown is not clean.
  if (requirements.requireClean) {
    const dirt = await observeDirt(input.checkout)
    if (dirt.kind === "known") {
      facts.dirt = { known: true, dirty: dirt.value.dirty, fileCount: dirt.value.fileCount }
      if (dirt.value.dirty) {
        blockers.push({
          reason: `checkout ${input.checkout} has ${dirt.value.fileCount} uncommitted change(s)`,
          remediation: "commit, stash, or explicitly accept the dirty tree for this action",
        })
      }
    } else {
      blockers.push({
        reason: `working-tree state of ${input.checkout} could not be read: ${dirt.reason}`,
        remediation: "resolve the read failure; unknown status is never treated as clean",
      })
    }
  }

  // 6. Base facts.
  if (requirements.requireBase || requirements.requireBaseFacts) {
    if (!input.base) {
      blockers.push({
        reason: `${input.action} needs an explicitly selected base ref`,
        remediation: "pass --base <ref> (e.g. the branch this work branched from)",
      })
    } else {
      const divergence = await observeBaseDivergence(input.checkout, input.base)
      if (divergence.kind === "known") {
        facts.base = { ref: input.base, known: true, ...divergence.value }
      } else {
        facts.base = { ref: input.base, known: false, reason: divergence.reason }
        if (requirements.requireBase) {
          blockers.push({ reason: divergence.reason, remediation: "select a base ref that resolves in this repository" })
        }
      }
    }
  }

  // 7. Upstream facts are always observed (distinct from base) but never blocking on their own.
  if (target.branch) {
    const upstream = await observeUpstreamDivergence(input.checkout, target.branch)
    facts.upstream =
      upstream.kind === "known"
        ? { known: true, ...(upstream.value.upstream !== undefined ? { upstream: upstream.value.upstream, ahead: upstream.value.ahead, behind: upstream.value.behind } : {}) }
        : { known: false, reason: upstream.reason }
  }

  // 8. Execution activity.
  const activity = await observeExecutionActivity(input.checkout)
  if (activity.kind === "known") {
    facts.activity = { known: true, liveRunIds: activity.value.liveRunIds }
  } else {
    facts.activity = { known: false, reason: activity.reason }
    if (requirements.requireActivityKnown) {
      blockers.push({
        reason: `execution activity could not be read: ${activity.reason}`,
        remediation: 'restore run-history readability; unknown liveness is never treated as "no live runs"',
      })
    }
  }

  // 9. Managed writer conflict.
  if (requirements.requireWriterFree) {
    if (!target.branch) {
      blockers.push({
        reason: `checkout ${input.checkout} has no branch to key a writer claim on`,
        remediation: "attach the checkout to a branch before claiming or inspecting writers",
      })
    } else {
      const read = await readWriterClaim(input.commonDir, target.branch)
      if (read.status === "found") {
        const liveness = claimLiveness(read.value)
        facts.writerClaim = { claim: read.value, liveness }
        if (liveness === "live" || liveness === "uncertain") {
          const guidance = writerConflictGuidance(read.value)
          blockers.push({
            reason: guidance[0]! + (liveness === "uncertain" ? " (the writer's liveness is uncertain — its process state disagrees with its heartbeat)" : ""),
            remediation: guidance[1]!,
          })
        }
        // A stale claim is provably not writing: not a blocker.
      }
      // Missing, corrupt, or unreadable claims: absence of a found claim is
      // not proof of a free checkout, but it is also not a live writer; the
      // acquire step at execution time re-checks under the lock.
    }
  }

  // 10. Legacy unresolved operations: a half-applied close on the same branch
  // blocks mutations until the operator reconciles it explicitly.
  if (mutatingActions.has(input.action) && target.branch) {
    const legacy = await legacyConflictsForBranch({ commonDir: input.commonDir, branch: target.branch })
    for (const conflict of legacy) {
      blockers.push({ reason: `legacy unresolved operation: ${conflict.reason}`, remediation: conflict.remediation })
    }
  }

  return {
    action: input.action,
    target,
    pinnedHead,
    available: blockers.length === 0,
    blockers,
    facts,
  }
}

/**
 * Effect-time revalidation (task 2.2): the same inspection re-run immediately
 * before a mutation, with the reviewed inspection's target/head pinned. Any
 * drift refuses the stale review instead of mutating the replacement.
 */
export async function revalidateForExecution(input: {
  action: OperationAction
  checkout: string
  base?: string
  commonDir: string
  reviewed: OperationInspection
  requirements?: Partial<OperationRequirements>
}): Promise<OperationInspection> {
  if (!input.reviewed.target || input.reviewed.pinnedHead === undefined) {
    return {
      ...input.reviewed,
      available: false,
      blockers: [
        ...input.reviewed.blockers,
        { reason: "the reviewed inspection did not observe a usable target", remediation: "re-inspect before executing" },
      ],
    }
  }
  return inspectOperation({
    action: input.action,
    checkout: input.checkout,
    base: input.base,
    commonDir: input.commonDir,
    requirements: {
      ...input.requirements,
      reviewedTarget: input.reviewed.target,
      requireBranch: input.reviewed.target.branch,
    },
  })
}
