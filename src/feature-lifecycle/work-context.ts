import { stat } from "node:fs/promises"
import { join } from "node:path"

import { lifecycleCommonDir } from "./store"
import { resolveFeature } from "./resolver"
import type { FeatureRecord } from "./records"

/**
 * The work-context projection (capability work-context, design D1): a thin,
 * plain-data view over the shared resolver (`feature-lifecycle/resolver.ts`)
 * that makes an action's repository, execution checkout, feature identity,
 * complete reviewed contract set, and focused contract explicit *before* any
 * resource loading or effect.
 *
 * This is deliberately not a second resolver: every resolution question goes
 * through `resolveFeature`, every status maps 1:1 onto its tagged variants,
 * and every unavailable outcome carries the resolver's reason plus the
 * matching remediation. Consumers (the specs handoffs, the launcher's resource
 * loading, execution-time revalidation) read this projection instead of
 * re-deriving context from branch spelling or launch-directory heuristics.
 *
 * The projection never mutates anything and never calls `process.chdir()`:
 * the launch directory stays where Convoy runs; the resolved execution
 * checkout is a plain string the caller passes down explicitly.
 */

/** Why a work context could not validate, mirroring the resolver's statuses. */
export type WorkContextCondition = "missing" | "ambiguous" | "unreadable"

/**
 * The validated destination of one work-scoped action (design D1's
 * plain-data projection). Every field is derived at validation time; callers
 * revalidate immediately before effects because Git state may move.
 */
export type WorkContext = {
  /** Where Convoy itself runs — never chdir'd, never mutated by selection. */
  launchDir: string
  /** The Git common directory hosting the feature registry, when resolved. */
  commonDir?: string
  /** The validated checkout reads, preparation, and effects target. */
  executionCheckout: string
  /** The execution checkout's actual branch, when Git could read it. */
  branch?: string
  /** The registered feature the context resolves through, when one exists. */
  feature?: FeatureRecord
  /**
   * The feature's complete reviewed contract set (change ids, record order).
   * A focused contract never reduces this set — close and pipeline review
   * assess the whole feature.
   */
  contracts: readonly string[]
  /** The change this action focuses, when the action names one. */
  focusedContract?: { changeId: string; sourceRoot?: string }
  /** The feature's recorded intended local base ref. */
  intendedBase?: string
  /** The association revision validated here; cross-checked again before effects. */
  associationRevision?: number
  /** How the checkout was selected. */
  origin: "verified-association" | "launch-directory"
}

/** The outcome of resolving one work context. */
export type ValidatedWorkContext = { status: "validated"; context: WorkContext }

export type WorkContextResolution =
  | ValidatedWorkContext
  | {
      status: "unavailable"
      condition: WorkContextCondition
      reason: string
      remediation: readonly string[]
    }

async function checkoutExists(dir: string): Promise<boolean> {
  try {
    await stat(dir)
    return true
  } catch {
    return false
  }
}

/**
 * Resolves the work context for an action in `launchDir`, optionally carrying
 * an explicit feature identity and/or focused change.
 *
 * - A verified association supplies the execution checkout (Git's registered
 *   worktree for the recorded branch), the complete contract set, the intended
 *   base, and the association revision. A checkout Git lists but the filesystem
 *   no longer has is unavailable (`missing`), not silently downgraded to the
 *   launch directory.
 * - An explicit feature whose association does not verify is unavailable with
 *   the matching condition — it never falls back to the launch directory and
 *   borrows another checkout's facts (design D1).
 * - Without an explicit feature, an unassociated launch directory stays a
 *   valid context (`origin: "launch-directory"`): plain work keeps working.
 */
export async function resolveWorkContext(input: {
  launchDir: string
  /** Explicit feature identity; a failed explicit request never heuristically falls back. */
  featureId?: string
  /** The change the action focuses, cross-checked against the feature's contracts. */
  changeId?: string
}): Promise<WorkContextResolution> {
  const commonDir = (await lifecycleCommonDir(input.launchDir).catch(() => undefined)) ?? undefined
  const resolution = await resolveFeature({
    cwd: input.launchDir,
    ...(commonDir ? { commonDir } : {}),
    ...(input.featureId ? { featureId: input.featureId } : {}),
    ...(input.changeId ? { changeId: input.changeId } : {}),
  })

  if (resolution.status === "verified") {
    const checkout = resolution.context.checkoutPath
    if (!checkout || !(await checkoutExists(checkout))) {
      return {
        status: "unavailable",
        condition: "missing",
        reason: `the worktree for "${resolution.context.branch}" is no longer present on disk${checkout ? ` (${checkout})` : ""} — rebind or recover`,
        remediation: ["rebind: `convoy feature bind <feature-id> --branch <name> --worktree <path>`", "or inspect: `convoy feature show`"],
      }
    }
    const focused = input.changeId
      ? resolution.feature.contracts.find((contract) => contract.changeId === input.changeId)
      : undefined
    return {
      status: "validated",
      context: {
        launchDir: input.launchDir,
        ...(commonDir ? { commonDir } : {}),
        executionCheckout: checkout,
        ...(resolution.context.branch ? { branch: resolution.context.branch } : {}),
        feature: resolution.feature,
        contracts: resolution.feature.contracts.map((contract) => contract.changeId),
        ...(focused ? { focusedContract: { changeId: focused.changeId, sourceRoot: join(checkout, focused.sourcePath) } } : {}),
        intendedBase: resolution.feature.intendedBaseRef,
        associationRevision: resolution.context.associationRevision,
        origin: "verified-association",
      },
    }
  }

  const reason = "reason" in resolution && resolution.reason ? resolution.reason : `context ${resolution.status}`
  const bindRemediation = input.featureId
    ? [
        `rebind: \`convoy feature bind ${input.featureId} --branch <name> --worktree <path>\``,
        "or inspect: `convoy feature show`",
      ]
    : ["adopt the work explicitly: `convoy feature adopt --branch <name> --change <id> --base <local-ref>`"]

  // An explicit feature request must never silently land on the launch
  // directory: every non-verified outcome for an explicit feature is
  // unavailable with the resolver's own condition.
  if (input.featureId) {
    // A moved worktree and a vanished one both fail verification, but a
    // checkout no longer on disk is missing (the actionable condition), not
    // merely ambiguous: path aliasing on a deleted directory can make the
    // resolver's recorded-vs-registered comparison disagree without a real
    // move having happened.
    if (resolution.status === "ambiguous") {
      const candidate = resolution.candidates.find((entry) => entry.featureId === input.featureId)
      const recorded = candidate?.context?.checkoutPath
      if (recorded && !(await checkoutExists(recorded))) {
        return {
          status: "unavailable",
          condition: "missing",
          reason: `the worktree for "${candidate?.context?.branch}" is no longer present on disk (${recorded}) — rebind or recover`,
          remediation: bindRemediation,
        }
      }
    }
    const condition: WorkContextCondition =
      resolution.status === "missing" || resolution.status === "unreadable"
        ? resolution.status
        : // unassociated with the feature in candidates: the record exists but
          // its context does not verify; ambiguous: a selector or move conflict.
          resolution.status === "ambiguous"
          ? "ambiguous"
          : "missing"
    return { status: "unavailable", condition, reason, remediation: bindRemediation }
  }

  // Unassociated plain work is still valid: the launch directory is the
  // checkout, exactly as standalone launches behave today (design D1).
  if (resolution.status === "unassociated") {
    return {
      status: "validated",
      context: {
        launchDir: input.launchDir,
        ...(commonDir ? { commonDir } : {}),
        executionCheckout: input.launchDir,
        contracts: [],
        origin: "launch-directory",
      },
    }
  }

  // ambiguous/missing/unreadable without an explicit feature: report rather
  // than guessing (a moved worktree or unreadable registry is real evidence).
  const condition: WorkContextCondition =
    resolution.status === "ambiguous" ? "ambiguous" : resolution.status === "unreadable" ? "unreadable" : "missing"
  return { status: "unavailable", condition, reason, remediation: bindRemediation }
}
