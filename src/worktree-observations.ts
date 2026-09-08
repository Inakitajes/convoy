import { resolve } from "node:path"

import { currentBranch, execFile, isAncestor, realpathSafe as physical, resolveCommit, statusPorcelain, treeOf } from "./git"
import { listRuns } from "./runs"

/**
 * Live run IDs attached to a checkout path (realpath-compared), with the
 * typed unknown state (task 2.2's adapter seam, extracted from the retired
 * feature-lifecycle adapters): a run-discovery failure is `unknown`, never an
 * empty live-run set.
 */
async function observeLiveRunsAt(targetDir: string): Promise<{ kind: "known"; value: string[] } | { kind: "unknown"; reason: string }> {
  let entries: Awaited<ReturnType<typeof listRuns>>
  try {
    entries = await listRuns()
  } catch (error) {
    return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) }
  }
  let resolvedTarget: string
  try {
    resolvedTarget = await physical(targetDir)
  } catch {
    resolvedTarget = targetDir
  }
  const live: string[] = []
  for (const entry of entries) {
    if (!entry.live || !entry.targetDir) continue
    let same = false
    try {
      same = (await physical(entry.targetDir)) === resolvedTarget
    } catch {
      same = resolve(entry.targetDir) === resolvedTarget
    }
    if (same) live.push(entry.runID)
  }
  return { kind: "known", value: live }
}

/**
 * Independent local observations (change `worktree-control-center`, task
 * 1.5, design D2): small typed facts, each with its own known/unknown state
 * and collection time. Nothing here synthesizes a lifecycle — a failed probe
 * is `unknown`, never a negative fact; "no upstream" is a distinct condition,
 * never zero divergence; ancestry and tree equality say nothing about later
 * reverts or hosted merge state. Collection is read-only: no fetch, no
 * domain writes, no cross-checkout inference.
 */

/** A typed observation with the time it was collected (both kinds). */
export type Observed<T> = { kind: "known"; value: T; collectedAt: number } | { kind: "unknown"; reason: string; collectedAt: number }

export function known<T>(value: T): Observed<T> {
  return { kind: "known", value, collectedAt: Date.now() }
}

export function unknown<T = never>(reason: string): Observed<T> {
  return { kind: "unknown", reason, collectedAt: Date.now() }
}

/** Tracked + untracked working-tree state of one checkout. */
export type DirtFacts = {
  /** Unknown status is never reported as clean. */
  dirty: boolean
  /** Porcelain entry count (a file and its staged+unstaged pair count as git reports them). */
  fileCount: number
}

/** Working-tree dirt from `git status --porcelain`; unknown on any read failure. */
export async function observeDirt(checkout: string): Promise<Observed<DirtFacts>> {
  let porcelain: string
  try {
    porcelain = await statusPorcelain(checkout)
  } catch (error) {
    return unknown(error instanceof Error ? error.message : String(error))
  }
  const lines = porcelain.split("\n").filter((line) => line.trim() !== "")
  return known({ dirty: lines.length > 0, fileCount: lines.length })
}

/** Ahead/behind of one revision pair (`base...HEAD`), with base containment stated separately. */
export type BaseDivergence = {
  /** Commits on HEAD not on the base. */
  ahead: number
  /** Commits on the base not on HEAD. */
  behind: number
  /**
   * The selected base revision is contained in the source's history — the
   * actual up-to-date-with-that-revision fact. Sharing an ancestor is not
   * this; a merely related history is not this.
   */
  baseContainedInSource: boolean
}

/**
 * Divergence between the explicitly selected base and the checkout's HEAD.
 * Both operands are explicit: `base...HEAD` gives base-only/source-only
 * counts; containment is `merge-base --is-ancestor base HEAD`. Unknown when
 * Git cannot evaluate either operand — never collapsed to zero.
 */
export async function observeBaseDivergence(checkout: string, baseRef: string): Promise<Observed<BaseDivergence>> {
  const head = await resolveCommit("HEAD", checkout)
  if (!head) return unknown("HEAD has no commit to compare against the selected base")
  const base = await resolveCommit(baseRef, checkout)
  if (!base) return unknown(`base ref "${baseRef}" does not resolve to a commit`)

  const counts = await execFile("git", ["rev-list", "--left-right", "--count", `${base}...${head}`], {
    cwd: checkout,
    allowFailure: true,
  })
  if (counts.exitCode !== 0) {
    return unknown(`divergence between ${baseRef} and HEAD could not be computed: ${(counts.stderr || counts.stdout).trim()}`)
  }
  const [behind = "", ahead = ""] = counts.stdout.trim().split(/\s+/)
  const baseContainedInSource = await isAncestor(base, head, checkout)
  return known({
    ahead: Number.parseInt(ahead!, 10) || 0,
    behind: Number.parseInt(behind!, 10) || 0,
    baseContainedInSource,
  })
}

/** Divergence relative to the branch's configured upstream, with no-upstream kept distinct. */
export type UpstreamDivergence = {
  /** The configured upstream (e.g. `origin/feat/x`); undefined when the branch has none. */
  upstream?: string
  ahead?: number
  behind?: number
}

/**
 * Upstream divergence computed from locally known remote-tracking refs. A
 * branch without an upstream is known `upstream: undefined` — a distinct
 * condition, not zero divergence — and these values always describe the
 * last fetch, never live server state.
 */
export async function observeUpstreamDivergence(cwd: string, branch: string): Promise<Observed<UpstreamDivergence>> {
  const upstream = await execFile("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`], {
    cwd,
    allowFailure: true,
  })
  if (upstream.exitCode !== 0) return known({ upstream: undefined })
  const upstreamRef = upstream.stdout.trim()
  if (!upstreamRef) return known({ upstream: undefined })

  const counts = await execFile("git", ["rev-list", "--left-right", "--count", `${upstreamRef}...${branch}`], {
    cwd,
    allowFailure: true,
  })
  if (counts.exitCode !== 0) {
    return unknown(`upstream divergence for ${branch} could not be computed: ${(counts.stderr || counts.stdout).trim()}`)
  }
  const [behind = "", ahead = ""] = counts.stdout.trim().split(/\s+/)
  return known({ upstream: upstreamRef, ahead: Number.parseInt(ahead!, 10) || 0, behind: Number.parseInt(behind!, 10) || 0 })
}

/** Whether `tip` is reachable from `base` — and nothing more. */
export type Ancestry = { tipReachableFromBase: boolean }

/**
 * ancestry fact for the two explicit revisions. Unknown when either ref
 * cannot be resolved; a false is a fact about reachability, not about
 * integration, publication, or content coverage.
 */
export async function observeAncestry(tip: string, base: string, cwd: string): Promise<Observed<Ancestry>> {
  const tipCommit = await resolveCommit(tip, cwd)
  if (!tipCommit) return unknown(`tip ref "${tip}" does not resolve to a commit`)
  const baseCommit = await resolveCommit(base, cwd)
  if (!baseCommit) return unknown(`base ref "${base}" does not resolve to a commit`)
  return known({ tipReachableFromBase: await isAncestor(tipCommit, baseCommit, cwd) })
}

/** Whether two revisions hold identical trees — a content fact, not an integration fact. */
export type TreeEquality = { equalTrees: boolean }

export async function observeTreeEquality(tip: string, base: string, cwd: string): Promise<Observed<TreeEquality>> {
  const [tipTree, baseTree] = await Promise.all([treeOf(tip, cwd), treeOf(base, cwd)])
  if (!tipTree) return unknown(`tree of "${tip}" could not be resolved`)
  if (!baseTree) return unknown(`tree of "${base}" could not be resolved`)
  return known({ equalTrees: tipTree === baseTree })
}

/** Execution activity observed at one checkout path. */
export type ExecutionActivity = {
  /** Live run IDs attached to this checkout (realpath-compared). */
  liveRunIds: string[]
  total: number
}

/**
 * Live managed writers attached to a checkout. Client attachment is not
 * activity; only actual live runs count. Unknown when run history cannot be
 * read — never reported as "no live runs".
 */
export async function observeExecutionActivity(checkout: string): Promise<Observed<ExecutionActivity>> {
  const live = await observeLiveRunsAt(checkout)
  if (live.kind === "unknown") return unknown(live.reason)
  return known({ liveRunIds: live.value, total: live.value.length })
}

/** The checked-out branch of a checkout, typed (undefined = detached). */
export async function observeCheckedOutBranch(checkout: string): Promise<Observed<string | undefined>> {
  try {
    return known(await currentBranch(checkout))
  } catch (error) {
    return unknown(error instanceof Error ? error.message : String(error))
  }
}
