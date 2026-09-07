import { stat } from "node:fs/promises"
import { join } from "node:path"

import { currentBranch, execFile, findWorktreeDirForBranch, isAncestor, mainWorktreeDir, resolveCommit } from "../git"
import { collectDirRelativeMarkdown, listChangeIds, openspecDirName } from "../openspec"
import { observeLiveRunsAt, observeStatus, observeTaskCounts, observeUpstream } from "./adapters"
import type { LifecycleObservations } from "./assessment"
import { changeHasMarkdown, type Discovery } from "./discovery"
import { listReceiptIds, readReceipt, type FeatureRecord } from "./records"
import type { ContractObservation } from "./assessment"
import { isLandingReachableFrom } from "./refs"

/**
 * Observation builders (task 2.2/2.5): assemble the typed observations the
 * pure assessment consumes from live Git/run/artifact evidence for one
 * feature record. Every failure is represented as unknown/unreadable — a
 * failed read is never a negative fact (design D5).
 */

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Builds observations for a feature: context verification (actual worktree,
 * actual branch), per-contract artifact state and tasks, execution liveness,
 * integration (verified receipt / probable patch-equivalence / pending),
 * publication, and cleanup state.
 */
export async function buildObservationsForFeature(input: { cwd: string; commonDir: string; feature: FeatureRecord }): Promise<LifecycleObservations> {
  const feature = input.feature
  const mainDir = (await mainWorktreeDir(input.cwd).catch(() => undefined)) ?? input.cwd

  // Context: verified only when Git currently reports the branch checked out
  // at (or reconcilable with) the recorded checkout.
  let context: LifecycleObservations["context"]
  if (!feature.context) {
    context = { verification: "unassociated" }
  } else {
    const registered = await findWorktreeDirForBranch(feature.context.branch, input.cwd).catch(() => undefined)
    if (!registered) {
      context = { verification: "missing", branch: feature.context.branch, reason: `branch "${feature.context.branch}" is not checked out anywhere` }
    } else {
      const actual = await currentBranch(registered).catch(() => undefined)
      if (actual !== feature.context.branch) {
        context = { verification: "ambiguous", branch: actual, reason: `worktree for "${feature.context.branch}" has "${actual ?? "a detached HEAD"}" checked out` }
      } else if (feature.context.checkoutPath && registered.replace(/\/+$/, "") !== feature.context.checkoutPath.replace(/\/+$/, "")) {
        context = { verification: "ambiguous", branch: actual, checkoutPath: registered, reason: `worktree moved from ${feature.context.checkoutPath} to ${registered}` }
      } else {
        context = { verification: "verified", branch: actual, checkoutPath: registered }
      }
    }
  }
  const checkout = context.verification === "verified" ? context.checkoutPath! : undefined

  // Contracts: artifact state + tasks from the associated source.
  const contracts: ContractObservation[] = []
  for (const contract of feature.contracts) {
    const sourceRoot = join(checkout ?? input.cwd, contract.sourcePath)
    if (contract.kind === "active") {
      const present = await exists(sourceRoot)
      if (!present) {
        contracts.push({ changeId: contract.changeId, state: "missing", reason: `${contract.sourcePath} is absent` })
        continue
      }
      const hasMarkdown = await changeHasMarkdown(checkout ?? input.cwd, contract.changeId)
      const counts = await observeTaskCounts(checkout ?? input.cwd)
      const tasks = counts.kind === "known" ? counts.value.get(contract.changeId) ?? "unknown" : "unknown"
      if (hasMarkdown) {
        // Verified archive evidence outranks a stale branch copy (capability
        // work-context): when the base state carries verified archive
        // markdown for this change id and the branch sits behind its recorded
        // base (never synced that state), the branch's unarchived copy is a
        // leftover, not current state — report archived with the discrepancy
        // disclosed instead of presenting the stale copy as active work.
        const archiveRoot = join(mainDir, openspecDirName, "changes", "archive", contract.changeId)
        const archiveHasMarkdown = (await exists(archiveRoot)) && (await collectDirRelativeMarkdown(archiveRoot, ".")).length > 0
        // "Behind its recorded base": the branch does not contain the base's
        // current tip, so the archive state that landed there has not been
        // synced into this branch's copy.
        const branchBehindBase =
          feature.intendedBaseRef && feature.context?.branch
            ? !(await isAncestor(feature.intendedBaseRef, feature.context.branch, mainDir).catch(() => false))
            : false
        if (archiveHasMarkdown && branchBehindBase) {
          contracts.push({
            changeId: contract.changeId,
            state: "verified-archived",
            reason: `stale branch copy: verified archive evidence for ${contract.changeId} exists in the base state (${feature.intendedBaseRef}) while this branch has not synced it`,
          })
          continue
        }
        contracts.push({ changeId: contract.changeId, state: "active", tasks })
        continue
      }
      contracts.push({ changeId: contract.changeId, state: "missing", ...(hasMarkdown ? {} : { reason: "no markdown artifacts (husk)" }), tasks })
      continue
    }
    // Archived contract: positively verified only when the archive tree
    // carries markdown at the recorded source path.
    const archivePresent = await exists(sourceRoot)
    const hasMarkdown = archivePresent ? (await collectDirRelativeMarkdown(sourceRoot, ".")).length > 0 : false
    contracts.push({
      changeId: contract.changeId,
      state: archivePresent && hasMarkdown ? "verified-archived" : archivePresent ? "missing" : "missing",
      reason: archivePresent && hasMarkdown ? undefined : `archive source ${contract.sourcePath} is ${archivePresent ? "a husk" : "absent"}`,
    })
  }

  // Execution: live runs attached to the verified checkout.
  let execution: LifecycleObservations["execution"]
  if (checkout) {
    const live = await observeLiveRunsAt(checkout)
    execution = live.kind === "known" ? { kind: "known", liveRunIds: live.value, totalRuns: live.value.length } : { kind: "unknown", reason: live.reason }
  } else {
    execution = { kind: "known", liveRunIds: [], totalRuns: 0 }
  }

  // Integration: verified only through a receipt whose landing remains
  // reachable and whose feature tip is unchanged (design D8); probable via
  // patch equivalence (never upgraded); stale when evidence disagrees.
  let integration: LifecycleObservations["integration"] = "pending"
  if (feature.context?.branch) {
    const tip = await resolveCommit(feature.context.branch, mainDir).catch(() => undefined)
    const receiptId = (await listReceiptIds(input.commonDir, feature.featureId)).at(-1)
    const receipt = receiptId ? await readReceipt(input.commonDir, feature.featureId, receiptId) : undefined
    if (receipt && receipt.status === "found") {
      const verified = receipt.value
      const reachable = await isLandingReachableFrom(verified.landingSha, verified.baseRef, mainDir)
      const tipUnchanged = tip === undefined || tip === verified.featureTip
      integration = reachable && tipUnchanged ? "verified" : "stale"
    } else if (tip && context.verification === "verified" && feature.intendedBaseRef) {
      const synced = await isAncestor(feature.intendedBaseRef, feature.context.branch, mainDir).catch(() => false)
      if (!synced) {
        const cherry = await execFile("git", ["cherry", feature.intendedBaseRef, feature.context!.branch], { cwd: mainDir, allowFailure: true })
        if (cherry.exitCode === 0) {
          const lines = cherry.stdout.split("\n").filter((line) => line.trim() !== "")
          if (lines.length > 0 && lines.every((line) => line.startsWith("-"))) integration = "probable"
        }
      }
    }
  }

  // Publication: upstream observation only; never interpreted as PR state.
  let publication: LifecycleObservations["publication"]
  if (feature.context?.branch) {
    const upstream = await observeUpstream(feature.context.branch, mainDir)
    publication = upstream.kind === "known" ? { kind: "known", ...(upstream.value ? { upstream: upstream.value } : {}), published: upstream.value !== undefined } : { kind: "unknown", reason: upstream.reason }
  } else {
    publication = { kind: "known", published: false }
  }

  // Cleanup: worktree/branch presence relative to a verified landing.
  let cleanup: LifecycleObservations["cleanup"]
  if (integration === "verified") {
    const worktreePresent = feature.context ? (await findWorktreeDirForBranch(feature.context.branch, input.cwd).catch(() => undefined)) !== undefined : false
    const branchPresent = feature.context ? (await resolveCommit(feature.context.branch, mainDir).catch(() => undefined)) !== undefined : false
    cleanup = { kind: "known", worktreePresent, branchPresent }
  } else {
    cleanup = { kind: "known", worktreePresent: false, branchPresent: false }
  }

  return {
    feature,
    context,
    contracts,
    execution,
    integration,
    publication,
    cleanup,
  }
}

/** Builds observations for the discovery-level candidates (unassociated work). */
export async function buildObservationsForCandidate(input: { cwd: string; candidate: { changeId: string; dir: string; branch?: string; main: boolean } }): Promise<LifecycleObservations> {
  const counts = await observeTaskCounts(input.candidate.dir)
  const tasks = counts.kind === "known" ? counts.value.get(input.candidate.changeId) ?? "unknown" : "unknown"
  return {
    context: { verification: "unassociated" },
    contracts: [{ changeId: input.candidate.changeId, state: "active", tasks }],
    execution: { kind: "known", liveRunIds: [], totalRuns: 0 },
    integration: "pending",
    publication: { kind: "known", published: false },
    cleanup: { kind: "known", worktreePresent: false, branchPresent: false },
  }
}

/** Lists the active change ids of a checkout (shared adapter helper). */
export async function activeChangeIdsAt(dir: string): Promise<string[]> {
  return listChangeIds(join(dir, openspecDirName, "changes"))
}

/** Compact serializable snapshot of a discovery pass for JSON consumers. */
export function summarizeDiscovery(discovery: Discovery): { features: number; candidates: number; unreadable: number } {
  return { features: discovery.features.length, candidates: discovery.candidates.length, unreadable: discovery.unreadableFeatures.length }
}

/** Status observation shared with close preflights (typed wrapper). */
export async function observeCheckoutStatus(dir: string): Promise<string | "unknown"> {
  const status = await observeStatus(dir)
  return status.kind === "known" ? status.value : "unknown"
}
