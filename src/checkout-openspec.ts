import { readFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"

import { isOpenSpecChangeId, listChangeIds, openspecDirName, titleFromProposal } from "./openspec"

/**
 * Checkout-local OpenSpec readers (change `worktree-control-center`, task
 * 1.4, design D3): active changes, archives, and canonical specs are read
 * only from the selected checkout and keyed by (checkout, local path). No
 * global change-id deduplication, no cross-checkout source overlay — two
 * same-id copies in two worktrees are two independent facts. A husk or an
 * unreadable file is reported as such, never borrowed from another checkout.
 */

/** Typed read result: unreadable evidence stays unknown, never a negative fact. */
export type ReadResult<T> = { kind: "known"; value: T } | { kind: "unknown"; reason: string }

export type LocalArtifactInventory = {
  /** `proposal.md` present and readable. */
  proposal: boolean
  /** `design.md` present and readable. */
  design: boolean
  /** `tasks.md` present and readable. */
  tasks: boolean
  /** Delta spec files under `specs/`, relative to the change directory. */
  deltaSpecs: string[]
  /** Any other markdown files, relative to the change directory. */
  other: string[]
}

export type LocalActiveChange = {
  /** The checkout this copy was read from (absolute path). */
  checkout: string
  changeId: string
  /** Absolute local source path of the change directory in that checkout. */
  sourcePath: string
  /** Title parsed from this copy's proposal; undefined when unreadable or missing (listed by id instead). */
  title?: string
  /** False for a husk: the directory exists but carries no markdown artifacts. */
  hasMarkdown: boolean
  artifacts: LocalArtifactInventory
  /** Known done/total from the shared task-count read; "unknown" when uncountable; undefined when the change has no tasks file. */
  tasks?: { done: number; total: number } | "unknown"
}

export type LocalArchiveEntry = {
  checkout: string
  /** The change id, with any date prefix stripped. */
  changeId: string
  /** The real destination directory on disk (e.g. `archive/2026-09-08-add-widget`). */
  sourcePath: string
  /** The date-prefixed directory name, when OpenSpec dated the archive. */
  datedDir?: string
  hasMarkdown: boolean
}

export type LocalCanonicalSpec = {
  checkout: string
  /** Capability path (e.g. `cli` or `nested/group/capability`). */
  capability: string
  /** Absolute path of the spec markdown file. */
  sourcePath: string
}

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Reads one checkout's active changes from its own filesystem. `kind:
 * "unknown"` only when the checkout's changes directory exists but cannot be
 * read (permissions, I/O); an absent `openspec/` is a known empty list — a
 * checkout without OpenSpec is a fact, not an error.
 */
export async function readCheckoutActiveChanges(checkout: string): Promise<ReadResult<LocalActiveChange[]>> {
  const changesDir = join(checkout, openspecDirName, "changes")
  if (!(await dirExists(changesDir))) return { kind: "known", value: [] }
  let ids: string[]
  try {
    ids = await listChangeIds(changesDir)
  } catch (error) {
    return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) }
  }
  const countsRead = await observeCheckoutTaskCounts(checkout)
  const countsByChange = countsRead.kind === "known" ? countsRead.value : undefined
  const changes: LocalActiveChange[] = []
  for (const changeId of ids) {
    const sourcePath = join(changesDir, changeId)
    const change = await describeLocalChange(checkout, changeId, sourcePath)
    if (!change.artifacts.tasks) change.tasks = undefined
    else {
      const counts = countsByChange?.get(changeId)
      change.tasks = counts ? { ...counts } : "unknown"
    }
    changes.push(change)
  }
  return { kind: "known", value: changes }
}

/**
 * Known done/total through the shared read-only task query (OpenSpec CLI in
 * the checkout, checkbox fallback otherwise), keyed by change id. "unknown"
 * when neither source can read the checkout — a failed read is never 0/0.
 */
async function observeCheckoutTaskCounts(checkout: string): Promise<ReadResult<ReadonlyMap<string, { done: number; total: number }>>> {
  const { openspecTaskCounts } = await import("./task-counts")
  try {
    return { kind: "known", value: await openspecTaskCounts(checkout) }
  } catch (error) {
    return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) }
  }
}

/** One change's facts from exactly one checkout-local directory. */
async function describeLocalChange(checkout: string, changeId: string, sourcePath: string): Promise<LocalActiveChange> {
  const artifacts = await describeArtifacts(sourcePath)
  const change: LocalActiveChange = {
    checkout,
    changeId,
    sourcePath,
    hasMarkdown: artifacts.proposal || artifacts.design || artifacts.tasks || artifacts.deltaSpecs.length > 0 || artifacts.other.length > 0,
    artifacts,
  }
  if (artifacts.proposal) {
    try {
      const body = await readFile(join(sourcePath, "proposal.md"), "utf8")
      change.title = titleFromProposal(body, changeId)
    } catch {
      // Listed by id; the unreadable proposal is disclosed, not replaced.
    }
  }
  return change
}

/** Walks the change directory (bounded to its real size) and classifies markdown artifacts. */
async function describeArtifacts(sourcePath: string): Promise<LocalArtifactInventory> {
  const inventory: LocalArtifactInventory = { proposal: false, design: false, tasks: false, deltaSpecs: [], other: [] }
  const walk = async (dir: string, relativeDir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(dir, entry.name)
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(child, relative)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue
      try {
        await stat(child)
      } catch {
        continue
      }
      if (relativeDir === "" && entry.name === "proposal.md") inventory.proposal = true
      else if (relativeDir === "" && entry.name === "design.md") inventory.design = true
      else if (relativeDir === "" && entry.name === "tasks.md") inventory.tasks = true
      else if (relativeDir === "specs" || relativeDir.startsWith("specs/")) inventory.deltaSpecs.push(relative)
      else inventory.other.push(relative)
    }
  }
  await walk(sourcePath, "")
  return inventory
}

/**
 * Reads one checkout's local archives as they actually exist on disk,
 * including OpenSpec's date-prefixed destinations (`2026-01-02-add-widget`).
 * No fixed undated lookup: the destination is whatever the archive created.
 */
export async function readCheckoutArchives(checkout: string): Promise<ReadResult<LocalArchiveEntry[]>> {
  const archiveDir = join(checkout, openspecDirName, "changes", "archive")
  if (!(await dirExists(archiveDir))) return { kind: "known", value: [] }
  let entries
  try {
    entries = await readdir(archiveDir, { withFileTypes: true })
  } catch (error) {
    return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) }
  }
  const archives: LocalArchiveEntry[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (entry.name.startsWith(".")) continue
    const datedMatch = /^\d{4}-\d{2}-\d{2}-(.+)$/.exec(entry.name)
    const changeId = datedMatch?.[1] ?? entry.name
    if (!changeId) continue
    const sourcePath = join(archiveDir, entry.name)
    const artifacts = await describeArtifacts(sourcePath)
    archives.push({
      checkout,
      changeId,
      sourcePath,
      ...(datedMatch ? { datedDir: entry.name } : {}),
      hasMarkdown: artifacts.proposal || artifacts.design || artifacts.tasks || artifacts.deltaSpecs.length > 0 || artifacts.other.length > 0,
    })
  }
  return { kind: "known", value: archives }
}

/** Reads one checkout's canonical specs from its own `openspec/specs/**`. */
export async function readCheckoutCanonicalSpecs(checkout: string): Promise<ReadResult<LocalCanonicalSpec[]>> {
  const specsRoot = join(checkout, openspecDirName, "specs")
  if (!(await dirExists(specsRoot))) return { kind: "known", value: [] }
  const specs: LocalCanonicalSpec[] = []
  const walk = async (dir: string, capability: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      throw new Error(`canonical specs under ${specsRoot} are unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isFile()) continue
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue
        await walk(join(dir, entry.name), capability ? `${capability}/${entry.name}` : entry.name)
        continue
      }
      if (entry.name !== "spec.md") continue
      specs.push({ checkout, capability, sourcePath: join(dir, entry.name) })
    }
  }
  try {
    await walk(specsRoot, "")
  } catch (error) {
    return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) }
  }
  return { kind: "known", value: specs }
}

/** Re-exports the id rule so consumers never re-implement the directory filter. */
export { isOpenSpecChangeId as isLocalChangeId }
