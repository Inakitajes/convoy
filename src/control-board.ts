import { join } from "node:path"

import { detectBaseRef, execFile } from "./git"
import { listWorktrees } from "./worktree-inventory"
import { readCheckoutActiveChanges, readCheckoutArchives, readCheckoutCanonicalSpecs, type LocalActiveChange } from "./checkout-openspec"
import { observeBaseDivergence, observeDirt, observeExecutionActivity, observeUpstreamDivergence, type Observed } from "./worktree-observations"
import { PrCache, type PrAdapter, type PrFacts, type PrObservation } from "./pr-observations"

/**
 * The worktree control board's data layer (change `worktree-control-center`,
 * tasks 3.1–3.3, design D1/D2; gaps CC-1/CC-2): every Git-registered checkout
 * is a root inventory entry, and every fact on a row is an independent,
 * freshly observed observation — Git dirt, base/upstream divergence,
 * execution activity, and the checkout's own local OpenSpec artifacts. There
 * is no lifecycle stage, no feature registry consult, no landing receipt, and
 * no cross-checkout ownership: same-id changes in different checkouts stay
 * independent children of their containing checkout, and a failed probe is
 * `unknown`, never a negative fact.
 *
 * The old feature-stage join (`FeatureStage`/`deriveStage`,
 * `verifiedCloseReceipt`, registered-context reads) is retired, not extended:
 * the board's authority is the Git worktree inventory plus the selected
 * checkout's files.
 */

/** One checkout of the repository, from the shared Git inventory. */
export type BoardWorktree = {
  /** Absolute checkout path (the main checkout first, in `git worktree list` order). */
  path: string
  /** Checked-out branch without `refs/heads/`; undefined on a detached HEAD. */
  branch?: string
  detached: boolean
  /** The repository's main checkout (the first inventory entry). */
  main: boolean
  /** A bare entry is repository metadata, not an executable checkout. */
  bare: boolean
  /** False when the registered path is missing — shown as inaccessible with repair guidance. */
  accessible: boolean
  head?: string
  locked?: { reason?: string }
  prunable?: { reason?: string }
  /** Working-tree dirt; unknown is never reported as clean. */
  dirt?: Observed<{ dirty: boolean; fileCount: number }>
  /** Divergence against the explicitly selected base, when one is selected. */
  baseDivergence?: Observed<{ ahead: number; behind: number; baseContainedInSource: boolean }>
  /** Divergence against the branch's configured upstream; no upstream is a distinct condition. */
  upstream?: Observed<{ upstream?: string; ahead?: number; behind?: number }>
  /** Live managed writers attached to this checkout; client attachment is not activity. */
  activity?: Observed<{ liveRunIds: string[]; total: number }>
  /**
   * Scoped pull-request observation for this checkout's branch (task 2.6,
   * design D2): known (with the PR facts or a verified empty result),
   * unknown (missing tool, failed query — never "no PR"), or ambiguous.
   * A merged PR here is a fact about that PR, never a completion claim.
   */
  pr?: PrObservation
  /** This checkout's own local active changes (never borrowed from another checkout). */
  changes: LocalActiveChange[]
  /** Set when the local changes could not be read — unknown, not empty. */
  changesUnknown?: string
  /** Local archive count (browsable on demand; never a lifecycle summary). */
  archiveCount?: number
  /** Local canonical spec count. */
  specCount?: number
}

export type ControlBoard = {
  /** The repository's common directory, when Git reported one. */
  commonDir?: string
  /** The repository's detected base branch (a suggestion, never an assumption). */
  baseBranch?: string
  worktrees: BoardWorktree[]
}

export type BoardTasks = { done: number; total: number }

/**
 * The one assembly. Inventory first, then per-checkout detail (local
 * artifacts, dirt, activity) so a usable list never waits on a giant global
 * snapshot — and never on a hosting round-trip: PR evidence is observed
 * on demand per selected row (observeWorktreePr), bounded, cached, and
 * advisory there. Nothing here writes domain state, fetches, or consults
 * legacy feature records.
 */
export async function assembleControlBoard(targetDir: string, options: { base?: string } = {}): Promise<ControlBoard> {
  const inventory = await listWorktrees(targetDir)
  const detectedBase = options.base ?? (await detectBaseRef(targetDir).catch(() => undefined))?.ref

  const worktrees: BoardWorktree[] = []
  // PR evidence is deliberately absent from the assembly: the home fires one
  // on-demand observation per checkout when the operator's selection lands on
  // its row (see observeWorktreePr), so the list load never fans out a `gh`
  // subprocess per worktree and never stalls on a hosting round-trip.
  for (const [index, entry] of inventory.entries.entries()) {
    const row: BoardWorktree = {
      path: entry.path,
      ...(entry.branch ? { branch: entry.branch } : {}),
      detached: entry.detached === true,
      main: index === 0,
      bare: entry.bare === true,
      accessible: entry.accessible,
      ...(entry.head ? { head: entry.head } : {}),
      ...(entry.locked ? { locked: entry.locked } : {}),
      ...(entry.prunable ? { prunable: entry.prunable } : {}),
      changes: [],
    }
    if (entry.accessible && !entry.bare) {
      const [changes, archives, specs, dirt, activity] = await Promise.all([
        readCheckoutActiveChanges(entry.path),
        readCheckoutArchives(entry.path),
        readCheckoutCanonicalSpecs(entry.path),
        observeDirt(entry.path),
        observeExecutionActivity(entry.path),
      ])
      if (changes.kind === "known") row.changes = changes.value
      else row.changesUnknown = changes.reason
      if (archives.kind === "known" && archives.value.length > 0) row.archiveCount = archives.value.length
      if (specs.kind === "known" && specs.value.length > 0) row.specCount = specs.value.length
      row.dirt = dirt
      row.activity = activity
      if (row.branch && detectedBase) {
        row.baseDivergence = await observeBaseDivergence(entry.path, detectedBase)
        row.upstream = await observeUpstreamDivergence(entry.path, row.branch)
      } else if (row.branch) {
        row.upstream = await observeUpstreamDivergence(entry.path, row.branch)
      }
    }
    worktrees.push(row)
  }

  return {
    ...(inventory.commonDir ? { commonDir: inventory.commonDir } : {}),
    ...(detectedBase ? { baseBranch: detectedBase } : {}),
    worktrees,
  }
}

/**
 * The on-demand PR observation for one checkout: the home fires it when the
 * operator's selection lands on the row — never as a board-load side effect
 * — so a slow `gh` only ever delays one row's evidence, on its own 10-second
 * bound, while the rest of the board renders instantly. The shared bounded
 * cache serves repeated landings within its TTL; every failure mode degrades
 * to unknown with its reason, never absence.
 */
export async function observeWorktreePr(input: {
  targetDir: string
  worktree: { path: string; branch?: string; detached: boolean }
  base?: string
  adapter?: PrAdapter
  cache?: PrCache
}): Promise<PrObservation> {
  if (!input.worktree.branch) {
    return { availability: "unknown", reason: "the checkout has no attached branch to scope a pull-request query", observedAt: Date.now() }
  }
  const hostingRepo = input.adapter ? "injected-adapter" : await resolveHostingRepo(input.targetDir)
  if (!hostingRepo) {
    return { availability: "unknown", reason: "the hosting repository could not be resolved (is the GitHub CLI installed and authenticated?)", observedAt: Date.now() }
  }
  const base = input.base ?? (await detectBaseRef(input.targetDir).catch(() => undefined))?.ref
  return observeBoardPr({
    branch: input.worktree.branch,
    base,
    hostingRepo,
    scopeResolved: true,
    adapter: input.adapter ?? ghPrAdapter(input.worktree.path),
    cache: input.cache ?? boardPrCache,
  })
}

/**
 * The advisory in-memory PR cache (30s TTL, one bounded `gh` call at a time
 * per query, each on its own 10-second bound — a hung `gh` reads as unknown,
 * not as absence). Shared with the on-demand observeWorktreePr path, so a
 * landing on the same row within the TTL never re-queries.
 */
const boardPrCache = new PrCache({ ttlMs: 30_000, timeoutMs: 10_000 })

/** Hosting lookups must never stall the board: a hung `gh` reads as unknown. */
const hostingResolveTimeoutMs = 1_000

/** The hosting resolution is advisory and short-lived, like the PR cache itself. */
const hostingCacheTtlMs = 30_000
let hostingCache: { dir: string; repo?: string; at: number } | undefined

/** Resolves `owner/repo` for the repository through `gh`; unknown when it cannot answer in time. */
async function resolveHostingRepo(dir: string): Promise<string | undefined> {
  if (hostingCache && hostingCache.dir === dir && Date.now() - hostingCache.at <= hostingCacheTtlMs) return hostingCache.repo
  const outcome = await Promise.race([
    execFile("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd: dir, allowFailure: true }).catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), hostingResolveTimeoutMs).unref?.()),
  ])
  const result = outcome
  const repo = result && result.exitCode === 0 ? (result.stdout.trim().includes("/") ? result.stdout.trim() : undefined) : undefined
  hostingCache = { dir, ...(repo !== undefined ? { repo } : {}), at: Date.now() }
  return repo
}

/**
 * The board's PR observation for one checkout: scoped to the hosting
 * repository, the checkout's branch as head, and the selected base. Served
 * through the shared bounded cache; every failure mode degrades to unknown
 * with its reason and observation time.
 */
async function observeBoardPr(input: {
  branch?: string
  base?: string
  hostingRepo?: string
  /** False when the hosting repository could not be resolved for the gh-backed adapter. */
  scopeResolved: boolean
  adapter: PrAdapter
  cache: PrCache
}): Promise<PrObservation> {
  if (!input.branch) {
    return { availability: "unknown", reason: "the checkout has no attached branch to scope a pull-request query", observedAt: Date.now() }
  }
  if (!input.base) {
    return { availability: "unknown", reason: "no base could be detected to scope the pull-request query", observedAt: Date.now() }
  }
  if (!input.scopeResolved || !input.hostingRepo) {
    return { availability: "unknown", reason: "the hosting repository could not be resolved (is the GitHub CLI installed and authenticated?)", observedAt: Date.now() }
  }
  const query = { hostingRepo: input.hostingRepo, headRepo: input.hostingRepo, headBranch: input.branch, baseRepo: input.hostingRepo, baseBranch: input.base }
  return input.cache.observe(query, input.adapter)
}

/** The `gh`-backed adapter: every PR state for the exact head/base scope, tolerant of failure. */
function ghPrAdapter(checkout: string): PrAdapter {
  return async (query) => {
    let result
    try {
      result = await execFile(
        "gh",
        [
          "pr",
          "list",
          "--repo",
          query.hostingRepo,
          "--state",
          "all",
          "--head",
          query.headBranch,
          "--base",
          query.baseBranch,
          "--json",
          "number,title,url,state,headRefOid",
        ],
        { cwd: checkout, allowFailure: true },
      )
    } catch (error) {
      return { error: `the pull-request query failed: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (result.exitCode !== 0) {
      return { error: `the pull-request query failed: ${(result.stderr || result.stdout).trim().slice(0, 200)}` }
    }
    try {
      const parsed = JSON.parse(result.stdout) as Array<{ number: number; title: string; url: string; state: string; headRefOid?: string }>
      if (!Array.isArray(parsed)) return { error: "the pull-request query returned an unexpected shape" }
      const facts: PrFacts[] = parsed.map((pr) => ({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: pr.state,
        ...(pr.headRefOid ? { headSha: pr.headRefOid } : {}),
      }))
      return facts
    } catch (error) {
      return { error: `the pull-request query returned unreadable output: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
}

/** The checkout folder basename: the visible worktree name (design D1). */
export function worktreeDisplayName(worktree: { path: string; branch?: string; detached: boolean }): string {
  const base = worktree.path.split("/").filter(Boolean).pop() ?? worktree.path
  return base
}

/** Re-exported shared task-count read (OpenSpec CLI with checkbox fallback). */
export { openspecTaskCounts } from "./task-counts"
