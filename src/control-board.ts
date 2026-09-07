import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { execFile } from "./git"
import { detectBaseRef, isAncestor, statusPorcelain } from "./git"
import {
  branchIdFromBranch,
  collectDirRelativeMarkdown,
  isOpenSpecChangeId,
  listChangeIds,
  openspecDirName,
  titleFromProposal,
} from "./openspec"
import { listRuns } from "./runs"
import { verifiedCloseReceipt } from "./feature-close"

/**
 * The control board's data layer: a live join over git, OpenSpec state, and
 * run history that derives every displayed fact at render time (design D1).
 *
 * `assembleControlBoard` is the pure join over injected reads — it owns all
 * the derivation logic and is unit-tested against fixture reads. The thin
 * `createBoardReads` adapter performs the actual filesystem/git/CLI reads.
 * Convoy persists nothing here: a row's existence in the world is its
 * existence on the board, so there is no cache to go stale.
 */

/** One checkout of the repo, from `git worktree list`. */
export type BoardWorktree = {
  dir: string
  /** The branch checked out here; undefined on a detached HEAD. */
  branch?: string
  /** The main checkout (the first `git worktree list` entry). */
  main: boolean
}

/** A convoy run as the board joins it: by frozen branch or by target directory. */
export type BoardRun = {
  runID: string
  branch?: string
  targetDir?: string
  live: boolean
}

export type BoardTasks = { done: number; total: number }

/**
 * The lifecycle stage of an active change, derived (never stored): stranded on
 * the base checkout, proposed in a worktree without runs, carrying live or
 * past runs, complete-but-unarchived, or probably squash-merged.
 */
export type FeatureStage = "stranded" | "proposing" | "implementing" | "ready" | "probably-merged"

export type FeatureRow = {
  id: string
  /** First heading of proposal.md; absent when the proposal is missing or unreadable. */
  title?: string
  /** Where the change's files live: the base checkout or a feature worktree. */
  location: "main" | "worktree"
  worktreeDir?: string
  /** The feature branch, only when the worktree's branch still matches the change id (the shared resolver rule). */
  branch?: string
  tasks?: BoardTasks
  runs: BoardRun[]
  liveRuns: number
  /** The proposal file sits uncommitted in this checkout. */
  uncommittedProposal: boolean
  /** Whether the feature branch contains the base branch's tip; undefined without a branch or base. */
  synced?: boolean
  /** Patch-equivalent with the base (`git cherry`): reported as probability, never certainty (design D6). */
  probablyMerged: boolean
  /** Set only when a verified close receipt exists — definite local close state (design D7). */
  landing?: { sha: string }
  stage: FeatureStage
}

export type WorktreeWithoutSpec = {
  dir: string
  branch?: string
  runCount: number
}

export type ControlBoard = {
  /** False when the main checkout has no `openspec/` at all. */
  present: boolean
  rows: FeatureRow[]
  worktreesWithoutSpec: WorktreeWithoutSpec[]
  specs: string[]
  baseBranch?: string
}

/** Everything the join needs from the world; every method is an injected read. */
export type BoardReads = {
  worktrees(): Promise<BoardWorktree[]>
  openspecPresent(dir: string): Promise<boolean>
  changeIds(dir: string): Promise<string[]>
  /** Whether `openspec/changes/<id>/` holds any markdown file; a husk holds none. */
  changeHasMarkdown(dir: string, id: string): Promise<boolean>
  changeTitle(dir: string, id: string): Promise<string | undefined>
  taskCounts(dir: string): Promise<ReadonlyMap<string, BoardTasks>>
  runs(): Promise<BoardRun[]>
  status(dir: string): Promise<string>
  /** Whether `branch` contains `ref`'s tip (ancestry). */
  contains(branch: string, ref: string): Promise<boolean>
  /** `git cherry` patch equivalence: true when the branch has commits but none are absent from `ref`. */
  patchEquivalent(ref: string, branch: string): Promise<boolean>
  baseBranch(): Promise<string | undefined>
  canonicalSpecs(dir: string): Promise<string[]>
  /**
   * Checkout paths registered as a feature's current context (read-only
   * lifecycle-store read). A registered feature's worktree stays in the
   * feature lifecycle surface — never downgraded to a specless worktree,
   * runs or no runs (delta control-board: "including those with no runs"
   * applies to *unassociated* worktrees only).
   */
  registeredContextDirs(): Promise<string[]>
}

/**
 * The change's linked feature branch: the worktree's branch only while its id
 * still matches the change (the same rule `resolveChange` applies for
 * branch↔change matching). A renamed branch deliberately orphans run linkage —
 * the row degrades to showing the change without runs (design D1's accepted
 * trade-off).
 */
export function branchForChange(changeId: string, worktreeBranch?: string): string | undefined {
  if (!worktreeBranch) return undefined
  return branchIdFromBranch(worktreeBranch) === changeId ? worktreeBranch : undefined
}

/**
 * Whether a `git status --porcelain` output marks the change's proposal as
 * uncommitted. Matches the exact file so unrelated dirt (including other
 * changes' files) never flips the marker.
 */
export function hasUncommittedProposal(status: string, changeId: string): boolean {
  const path = `openspec/changes/${changeId}/proposal.md`
  return status
    .split("\n")
    .some((line) => {
      const file = line.length > 3 ? line.slice(3).trim() : ""
      return file === path || file === `"${path}"`
    })
}

/**
 * The one join. Worktree rows are built first so a change that exists both
 * stranded on main and inside its worktree renders as the worktree row; main
 * gets the leftovers. `worktreesWithoutSpec` collects non-main worktrees that
 * carry runs but no OpenSpec change.
 */
export async function assembleControlBoard(reads: BoardReads): Promise<ControlBoard> {
  const [worktrees, baseBranch, runs, registered] = await Promise.all([
    reads.worktrees(),
    reads.baseBranch(),
    reads.runs(),
    reads.registeredContextDirs(),
  ])
  const main = worktrees.find((worktree) => worktree.main) ?? worktrees[0]
  if (!main) return { present: false, rows: [], worktreesWithoutSpec: [], specs: [] }

  const present = await reads.openspecPresent(main.dir)
  const specs = present ? await reads.canonicalSpecs(main.dir) : []

  const rows: FeatureRow[] = []
  const seen = new Set<string>()
  const specless: WorktreeWithoutSpec[] = []

  // Feature worktrees first: their rows outrank a same-id row stranded on main.
  // Pass 1 collects every worktree listing each change id — a merge or leftover
  // tooling state can list one id in several worktrees. Pass 2 resolves which
  // checkout supplies the row (precedence, not first-listed-wins).
  const features = worktrees.filter((worktree) => !worktree.main)
  const candidates = new Map<string, BoardWorktree[]>()
  for (const worktree of features) {
    const changePresent = (await reads.openspecPresent(worktree.dir)) && (await reads.changeIds(worktree.dir)).length > 0
    if (!changePresent) {
      // Registered features stay in the feature lifecycle surface; only
      // unassociated worktrees land in the peer section — including those
      // with no runs (delta control-board), so the run count no longer gates
      // the listing.
      if (registered.some((dir) => sameCheckoutPath(dir, worktree.dir))) continue
      const worktreeRuns = worktreeRunsFor(worktree, runs)
      specless.push({ dir: worktree.dir, ...(worktree.branch ? { branch: worktree.branch } : {}), runCount: worktreeRuns.length })
      continue
    }
    for (const id of await reads.changeIds(worktree.dir)) {
      const list = candidates.get(id)
      if (list) list.push(worktree)
      else candidates.set(id, [worktree])
    }
  }

  for (const [id, list] of candidates) {
    const winner = await resolveClaim(reads, id, list)
    seen.add(id)
    rows.push(await buildRow(reads, { id, dir: winner.dir, worktree: winner, baseBranch, runs }))
  }

  // Whatever is left lives stranded on the base checkout.
  if (present) {
    for (const id of await reads.changeIds(main.dir)) {
      if (seen.has(id)) continue
      seen.add(id)
      rows.push(await buildRow(reads, { id, dir: main.dir, baseBranch, runs }))
    }
  }

  return { present, rows, worktreesWithoutSpec: specless, specs, ...(baseBranch ? { baseBranch } : {}) }
}

/** Runs recorded against a worktree's checked-out branch. */
function worktreeRunsFor(worktree: BoardWorktree, runs: BoardRun[]): BoardRun[] {
  if (!worktree.branch) return []
  return runs.filter((run) => run.branch === worktree.branch)
}

/** Path equality the way the lifecycle observations compare registered paths (trailing-slash insensitive). */
function sameCheckoutPath(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "")
}

/**
 * Which checkout supplies a change's row when several worktrees list the id:
 * the worktree whose branch matches the change id (the same resolver rule
 * `branchForChange` applies) outranks every other copy; among the rest, a copy
 * carrying change markdown outranks a husk directory with none; remaining ties
 * keep stable `git worktree list` order. Resolution never drops a row — when
 * no candidate bears markdown and no branch matches, the first-listed
 * candidate wins and the row degrades exactly as before (design D3).
 */
async function resolveClaim(reads: BoardReads, id: string, list: BoardWorktree[]): Promise<BoardWorktree> {
  const branchMatch = list.find((worktree) => branchForChange(id, worktree.branch) !== undefined)
  if (branchMatch) return branchMatch
  // A lone candidate wins on list order regardless of artifacts, so the
  // markdown read is spent only where it can change the outcome.
  if (list.length === 1) return list[0]!
  for (const worktree of list) {
    if (await reads.changeHasMarkdown(worktree.dir, id)) return worktree
  }
  return list[0]!
}

async function buildRow(
  reads: BoardReads,
  input: { id: string; dir: string; worktree?: BoardWorktree; baseBranch?: string; runs: BoardRun[] },
): Promise<FeatureRow> {
  const { id, dir, worktree, baseBranch, runs } = input
  const branch = branchForChange(id, worktree?.branch)
  const taskMap = await reads.taskCounts(dir)
  const status = await reads.status(dir)
  const uncommittedProposal = hasUncommittedProposal(status, id)

  // Worktree rows join runs on the exact branch; a stranded main row joins on
  // the shared id rule, so `feat/<id>` runs recorded before the worktree was
  // removed still link.
  const linkedRuns = branch
    ? runs.filter((run) => run.branch === branch)
    : runs.filter((run) => run.branch && branchIdFromBranch(run.branch) === id)

  const synced = branch && baseBranch ? await reads.contains(branch, baseBranch) : undefined
  // Landing receipts are definite local close state (design D7, task 6.2): a
  // verified receipt (landing still reachable from the base) settles a close
  // even though a squash landing left no merge ancestry for `git cherry` to
  // find. Probable patch-equivalence without a receipt stays probabilistic —
  // never upgraded to certainty, and never claimed as a hosted PR state.
  const receipt = branch ? await verifiedCloseReceipt(dir, branch, id).catch(() => undefined) : undefined
  const patchEquivalent =
    branch && baseBranch && synced === false ? await reads.patchEquivalent(baseBranch, branch) : false
  const probablyMerged = patchEquivalent || receipt !== undefined

  const stage = deriveStage({ id, worktree: worktree !== undefined, runs: linkedRuns, tasks: taskMap.get(id), probablyMerged })

  return {
    id,
    ...(await reads.changeTitle(dir, id).then((title) => (title ? { title } : {}))),
    location: worktree ? "worktree" : "main",
    ...(worktree ? { worktreeDir: worktree.dir } : {}),
    ...(branch ? { branch } : {}),
    ...(taskMap.has(id) ? { tasks: taskMap.get(id)! } : {}),
    runs: linkedRuns,
    liveRuns: linkedRuns.filter((run) => run.live).length,
    uncommittedProposal,
    ...(synced === undefined ? {} : { synced }),
    probablyMerged,
    // A verified receipt is definite local close state; patch equivalence is
    // never upgraded to certainty, and neither claims a hosted PR merged.
    ...(receipt ? { landing: { sha: receipt.landingSha } } : {}),
    stage,
  }
}

/**
 * Stage resolution order: probably-merged wins (it changes the offered
 * remediation), then completeness *in a worktree* (ready to close), then run
 * linkage (implementing), then mere presence in a worktree (proposing), then
 * stranded. `ready` requires a worktree because a completed-but-stranded change
 * (all tasks done, still on the base checkout) has no close/continue keys — it
 * can only be spun out, so it must read "stranded on main" (SC-9).
 */
function deriveStage(input: {
  id: string
  worktree: boolean
  runs: BoardRun[]
  tasks?: BoardTasks
  probablyMerged: boolean
}): FeatureStage {
  if (input.probablyMerged) return "probably-merged"
  const tasks = input.tasks
  if (input.worktree && tasks && tasks.total > 0 && tasks.done >= tasks.total) return "ready"
  if (input.runs.length > 0) return "implementing"
  if (input.worktree) return "proposing"
  return "stranded"
}

// ── the filesystem/git/CLI adapter ───────────────────────────────────────

/**
 * Real reads against `targetDir`'s repo. Kept dumb on purpose: every decision
 * lives in the pure join above so the board's logic stays testable without a
 * repository on disk. The subprocess-spawning reads (`worktrees`, `taskCounts`,
 * `status`) are memoized per adapter instance — one board assembly — so a
 * checkout with N changes costs one `openspec list` and one `git status` per
 * directory, not per row (design D1's stated bound).
 */
export function createBoardReads(targetDir: string): BoardReads {
  let worktreesCache: Promise<BoardWorktree[]> | undefined
  const taskCountsCache = new Map<string, Promise<ReadonlyMap<string, BoardTasks>>>()
  const statusCache = new Map<string, Promise<string>>()
  const markdownCache = new Map<string, Promise<boolean>>()
  return {
    async worktrees() {
      worktreesCache ??= (async () => {
        const result = await execFile("git", ["worktree", "list", "--porcelain"], { cwd: targetDir, allowFailure: true })
        if (result.exitCode !== 0) return []
        const out: BoardWorktree[] = []
        let dir: string | undefined
        let branch: string | undefined
        const flush = () => {
          if (dir) out.push({ dir, ...(branch ? { branch } : {}), main: out.length === 0 })
          dir = undefined
          branch = undefined
        }
        for (const line of result.stdout.split("\n")) {
          if (line.startsWith("worktree ")) dir = line.slice("worktree ".length)
          else if (line.startsWith("branch refs/heads/")) branch = line.slice("branch refs/heads/".length)
          else if (line === "") flush()
        }
        flush()
        return out
      })()
      return worktreesCache
    },

    async openspecPresent(dir) {
      try {
        await readdir(join(dir, openspecDirName))
        return true
      } catch {
        return false
      }
    },

    async changeIds(dir) {
      return listChangeIds(join(dir, openspecDirName, "changes"))
    },

    async changeHasMarkdown(dir, id) {
      const root = join(dir, openspecDirName, "changes", id)
      let cached = markdownCache.get(root)
      if (!cached) {
        // collectDirRelativeMarkdown's traversal stance (hidden entries and
        // symlinks skipped, errors answer empty) with a boolean collapse:
        // true when any `.md` file exists, false on error or an empty husk.
        cached = collectDirRelativeMarkdown(root, ".").then((files) => files.length > 0)
        markdownCache.set(root, cached)
      }
      return cached
    },

    async changeTitle(dir, id) {
      try {
        const body = await readFile(join(dir, openspecDirName, "changes", id, "proposal.md"), "utf8")
        return titleFromProposal(body, id)
      } catch {
        return undefined
      }
    },

    async taskCounts(dir) {
      let counts = taskCountsCache.get(dir)
      if (!counts) {
        counts = openspecTaskCounts(dir)
        taskCountsCache.set(dir, counts)
      }
      return counts
    },

    async runs() {
      let entries
      try {
        entries = await listRuns()
      } catch {
        return []
      }
      // A run's frozen branch is not persisted; it is recovered from the
      // checkout it targeted — a worktree directory whose branch is on record
      // via `git worktree list`.
      const worktrees = await this.worktrees()
      const branchByDir = new Map(worktrees.filter((worktree) => worktree.branch).map((worktree) => [worktree.dir, worktree.branch!]))
      return entries.map((entry) => ({
        runID: entry.runID,
        ...(entry.targetDir && branchByDir.has(entry.targetDir) ? { branch: branchByDir.get(entry.targetDir)! } : {}),
        ...(entry.targetDir ? { targetDir: entry.targetDir } : {}),
        live: entry.live,
      }))
    },

    async status(dir) {
      let cached = statusCache.get(dir)
      if (!cached) {
        cached = statusPorcelain(dir).catch(() => "")
        statusCache.set(dir, cached)
      }
      return cached
    },

    async contains(branch, ref) {
      return isAncestor(ref, branch, targetDir)
    },

    async patchEquivalent(ref, branch) {
      const result = await execFile("git", ["cherry", ref, branch], { cwd: targetDir, allowFailure: true })
      if (result.exitCode !== 0) return false
      const lines = result.stdout.split("\n").filter((line) => line.trim() !== "")
      // No commits outside the ref, or nothing to compare: nothing is proven.
      if (lines.length === 0) return false
      // Every listed commit is patch-equivalent to one in the ref — a squash
      // merge erases ancestry, so this is the honest strongest claim (D6).
      return lines.every((line) => line.startsWith("-"))
    },

    async baseBranch() {
      const detected = await detectBaseRef(targetDir).catch(() => undefined)
      return detected?.ref
    },

    async canonicalSpecs(dir) {
      return collectDirRelativeMarkdown(join(dir, openspecDirName, "specs"), join(openspecDirName, "specs"))
    },

    async registeredContextDirs() {
      // Read-only lifecycle-store read (the board never writes the registry):
      // every valid feature record's current context checkout path. A store
      // failure degrades to no registered contexts — the same failure also
      // removes the feature rows from the view, so the degradation is
      // consistent rather than a silent ownership claim.
      try {
        const { lifecycleCommonDir, isFound } = await import("./feature-lifecycle/store")
        const { listFeatureIds, readFeatureRecord } = await import("./feature-lifecycle/records")
        const commonDir = await lifecycleCommonDir(targetDir)
        if (!commonDir) return []
        const ids = await listFeatureIds(commonDir)
        const dirs: string[] = []
        for (const featureId of ids) {
          const read = await readFeatureRecord(commonDir, featureId)
          if (isFound(read) && read.value.context?.checkoutPath) dirs.push(read.value.context.checkoutPath)
        }
        return dirs
      } catch {
        return []
      }
    },
  }
}

/** `openspec list --json` when the CLI answers; checkbox parsing otherwise. Shared with close's preflight. */
export async function openspecTaskCounts(dir: string): Promise<ReadonlyMap<string, BoardTasks>> {
  return (await taskCountsFromOpenspecCli(dir)) ?? (await taskCountsFromTasksFiles(dir))
}

/**
 * `openspec list --json` — the tool that owns OpenSpec state counts tasks. A
 * missing CLI binary throws at spawn time (not a non-zero exit), so the spawn
 * itself is guarded: absence means the checkbox fallback serves, exactly like
 * a non-zero exit or an unexpected output shape.
 */
async function taskCountsFromOpenspecCli(dir: string): Promise<ReadonlyMap<string, BoardTasks> | undefined> {
  let result
  try {
    result = await execFile("openspec", ["list", "--json"], { cwd: dir, allowFailure: true })
  } catch {
    return undefined
  }
  if (result.exitCode !== 0) return undefined
  try {
    const parsed = JSON.parse(result.stdout) as { changes?: Array<{ name?: string; completedTasks?: number; totalTasks?: number }> }
    if (!Array.isArray(parsed.changes)) return undefined
    const out = new Map<string, BoardTasks>()
    for (const change of parsed.changes) {
      if (typeof change.name !== "string") continue
      out.set(change.name, { done: change.completedTasks ?? 0, total: change.totalTasks ?? 0 })
    }
    return out
  } catch {
    return undefined
  }
}

/**
 * Fallback when the CLI is absent or its output changed shape: count the
 * checkbox states in each change's `tasks.md` directly. Same numbers, one
 * file read per change, no CLI dependency.
 */
async function taskCountsFromTasksFiles(dir: string): Promise<ReadonlyMap<string, BoardTasks>> {
  const out = new Map<string, BoardTasks>()
  const ids = await readdir(join(dir, openspecDirName, "changes")).catch(() => [])
  for (const id of ids.filter(isOpenSpecChangeId)) {
    const body = await readFile(join(dir, openspecDirName, "changes", id, "tasks.md"), "utf8").catch(() => undefined)
    if (body === undefined) continue
    const total = (body.match(/^\s*[-*+]\s+\[[ xX]\]/gm) ?? []).length
    const done = (body.match(/^\s*[-*+]\s+\[[xX]\]/gm) ?? []).length
    out.set(id, { done, total })
  }
  return out
}
