import { readFile, stat } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"

import { execFile, realpathSafe } from "./git"

/**
 * The worktree inventory (change `worktree-control-center`, task 1.2, design
 * D1): one parse of `git worktree list --porcelain -z` over the current
 * repository. Every registered worktree is an entry — main, externally
 * created, detached, locked, prunable/stale, bare, and spec-less alike.
 * Entries are observed facts about Git's registration, not domain records:
 * nothing here is persisted, named, or deduplicated beyond Git's own list.
 */

/** A locked worktree; `reason` is whatever the operator (or tool) recorded, possibly empty. */
export type WorktreeLock = { reason?: string }

/** A stale registration Git still reports (e.g. its checkout directory was removed outside Git). */
export type WorktreePrunable = { reason?: string }

export type WorktreeInventoryEntry = {
  /** The checkout path exactly as Git reports it (absolute, physical). */
  path: string
  /** HEAD OID as Git's inventory reports it; absent for bare entries. */
  head?: string
  /** Checked-out branch without the `refs/heads/` prefix; absent when detached. */
  branch?: string
  /** True when the checkout is in detached-HEAD state. */
  detached?: boolean
  /** True for a bare repository entry (repository metadata, not an executable checkout). */
  bare?: boolean
  /** Present when the worktree is locked. */
  locked?: WorktreeLock
  /** Present when Git flags the registration as prunable. */
  prunable?: WorktreePrunable
  /**
   * The worktree's Git administrative directory, resolved from the checkout's
   * own `.git` (file or directory) — never reconstructed from the path.
   * Absent when the checkout does not exist on disk or is bare.
   */
  gitDir?: string
  /** True when the checkout path exists and is a directory. */
  accessible: boolean
}

export type WorktreeInventory = {
  /** The repository's common directory, resolved by Git (absolute, physical). */
  commonDir: string
  entries: WorktreeInventoryEntry[]
}

/**
 * Parses `git worktree list --porcelain -z` output. In `-z` mode every
 * attribute (including a `locked`/`prunable` reason that may contain
 * newlines) is one NUL-terminated field, and a record ends at an empty
 * field. Pure so parser tests can feed canned shapes.
 */
export function parseWorktreeInventory(zOutput: string): WorktreeInventoryEntry[] {
  const entries: WorktreeInventoryEntry[] = []
  let current: MutableEntry | undefined

  for (const field of zOutput.split("\0")) {
    if (field === "") {
      current = undefined
      continue
    }
    if (field.startsWith("worktree ")) {
      current = { path: field.slice("worktree ".length), accessible: false }
      entries.push(current)
      continue
    }
    if (!current) continue
    applyAttribute(current, field)
  }

  return entries
}

type MutableEntry = WorktreeInventoryEntry & { locked?: WorktreeLock; prunable?: WorktreePrunable }

function applyAttribute(entry: MutableEntry, field: string): void {
  if (field.startsWith("HEAD ")) {
    entry.head = field.slice("HEAD ".length).trim() || undefined
    return
  }
  if (field.startsWith("branch ")) {
    const ref = field.slice("branch ".length).trim()
    entry.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref || undefined
    return
  }
  if (field === "detached") {
    entry.detached = true
    return
  }
  if (field === "bare") {
    entry.bare = true
    return
  }
  if (field.startsWith("locked")) {
    entry.locked = { reason: field.slice("locked".length).trim() || undefined }
    return
  }
  if (field.startsWith("prunable")) {
    entry.prunable = { reason: field.slice("prunable".length).trim() || undefined }
    return
  }
  // Unknown attributes are kept out of the typed entry rather than guessed.
}

/** The administrative Git directory of a checkout, read from the checkout itself. */
async function resolveCheckoutGitDir(checkoutPath: string): Promise<string | undefined> {
  const dotGit = join(checkoutPath, ".git")
  let info
  try {
    info = await stat(dotGit)
  } catch {
    return undefined
  }
  if (info.isDirectory()) return dotGit
  if (!info.isFile()) return undefined
  // Linked worktrees carry a `.git` file: `gitdir: <path to admin dir>`.
  let text: string
  try {
    text = await readFile(dotGit, "utf8")
  } catch {
    return undefined
  }
  const match = /^\s*gitdir:\s*(.+)\s*$/.exec(text)
  if (!match) return undefined
  const target = match[1]!.trim()
  if (!target) return undefined
  return isAbsolute(target) ? target : resolve(checkoutPath, target)
}

async function isAccessibleDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Enumerates every registered worktree of the repository containing `cwd`.
 * Git is the single source of checkout discovery; a bare entry is metadata.
 * Throws when `cwd` is not inside a repository — callers decide how to
 * present that, and nothing here silently degrades to an empty list.
 */
export async function listWorktrees(cwd: string): Promise<WorktreeInventory> {
  const common = await execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd })
  const commonDir = (await realpathSafe(common.stdout.trim())) || common.stdout.trim()
  const listing = await execFile("git", ["worktree", "list", "--porcelain", "-z"], { cwd })
  const parsed = parseWorktreeInventory(listing.stdout)

  for (const entry of parsed) {
    if (entry.bare) continue
    if (!(await isAccessibleDir(entry.path))) {
      // Git keeps reporting stale registrations; they stay visible as
      // inaccessible with their prunable reason instead of disappearing here.
      entry.accessible = false
      continue
    }
    entry.accessible = true
    entry.gitDir = await resolveCheckoutGitDir(entry.path)
  }

  return { commonDir, entries: parsed }
}

/** The entry for a checkout path, compared physically (macOS `/private` prefixes, symlinks). */
export async function findEntryForCheckout(inventory: WorktreeInventory, checkoutPath: string): Promise<WorktreeInventoryEntry | undefined> {
  const wanted = await realpathSafe(checkoutPath)
  for (const entry of inventory.entries) {
    if ((await realpathSafe(entry.path)) === wanted) return entry
  }
  return undefined
}
