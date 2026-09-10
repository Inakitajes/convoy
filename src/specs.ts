import { readdir, readFile, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { stdin, stdout } from "node:process"

import { assembleControlBoard, worktreeDisplayName, type ControlBoard, type BoardWorktree } from "./control-board"
import { readCheckoutActiveChanges } from "./checkout-openspec"
import type { TuiRoute } from "./tui-session"
import {
  collectDirRelativeMarkdown,
  openspecDirName,
  stripYamlFrontmatter,
  titleFromProposal,
} from "./openspec"

/**
 * Read-only specs viewer data layer (change `worktree-control-center`, tasks
 * 3.2–3.3, design D3/D4; gap CC-2). `convoy specs` is the control board's
 * artifact-focused reader entry: discovery is the repository's Git worktree
 * inventory, and every change, archive, and canonical spec is read only from
 * its own containing checkout — keyed by (checkout, local path). There is no
 * global change-id deduplication, no cross-checkout source overlay, and no
 * feature registry consult: same-id copies in different checkouts are
 * independent entries, and presence is never ownership.
 */

/** The artifact groups a change's markdown files fall into. */
export type SpecArtifactSection = "proposal" | "design" | "tasks" | "delta" | "other"

export type SpecArtifact = {
  section: SpecArtifactSection
  /** First path segment under the change's `specs/` — delta files group per capability. */
  capability?: string
  /** Markdown path (absolute when the entry carries its checkout). */
  file: string
}

export type SpecsChangeEntry = {
  kind: "change"
  id: string
  /** The checkout this copy was read from — its own local source, never borrowed. */
  checkout: string
  /** First heading of this copy's proposal.md; falls back to the id when it's missing or unreadable. */
  title: string
  artifacts: SpecArtifact[]
}

export type SpecsView = {
  /** Absolute normalized project directory the view was loaded from. */
  targetDir: string
  /** False when the launch checkout has no `openspec/` directory at all. */
  present: boolean
  /** The worktree-rooted inventory: one entry per Git-registered checkout. */
  board: ControlBoard
  /**
   * Every accessible checkout's local active changes, each keyed to its
   * containing checkout. Same-id copies appear once per checkout.
   */
  changes: SpecsChangeEntry[]
  /** The launch checkout's canonical specs (repo-relative paths). */
  specs: string[]
  /** The repository's detected base branch, for the sync/close disclosures. */
  baseBranch?: string
}

/** Artifact order in the detail view: the named planning sections first, then deltas, then leftovers. */
const sectionOrder: Record<SpecArtifactSection, number> = { proposal: 0, design: 1, tasks: 2, delta: 3, other: 4 }

/**
 * What the specs browser can ask Convoy to do next. Every handoff names its
 * explicit checkout-local target — the containing checkout of the selected
 * change, or the reviewed worktree for whole-branch actions — never a feature
 * identity or a launch-directory fallback (capability work-context delta).
 */
export type SpecsResolution =
  | { type: "exit" }
  | { type: "apply-change"; changeID: string; checkout: string }
  | { type: "iterate-change"; changeID: string; checkout: string; presentation?: "foreground" | "external" }
  /** Spin out a stranded change into its own worktree (`convoy spin`'s flow). */
  | { type: "spin-change"; changeID: string }
  /** Continue a change: the launcher preselects its containing worktree and branch. */
  | { type: "continue-change"; changeID: string; worktreeDir: string; branch: string }
  /** Close: the worktree composite (sync → selected archive → whole-branch squash). */
  | { type: "close-change"; changeID: string; worktreeDir: string; branch: string }
  /** Archive one explicitly selected change through the guarded archive operation. */
  | { type: "archive-change"; changeID: string; worktreeDir: string }

/**
 * Maps a change-relative markdown path to its artifact section. Name-based on
 * purpose: `proposal.md`, `design.md`, and `tasks.md` are the planning trio;
 * anything under `specs/` is a delta grouped by its first path segment.
 * Unmatched files land in the nearest fitting group (delta under `specs/`,
 * otherwise "Other") so nothing disappears from the view.
 */
export function classifySpecArtifact(relativePath: string): { section: SpecArtifactSection; capability?: string } {
  const base = relativePath.split("/").pop() ?? relativePath
  if (base === "proposal.md") return { section: "proposal" }
  if (base === "design.md") return { section: "design" }
  if (base === "tasks.md") return { section: "tasks" }
  const parts = relativePath.split("/")
  if (parts[0] === "specs") {
    // A capability needs a directory below `specs/`; a lone `specs/foo.md`
    // still belongs to the delta view, just without a capability grouping.
    const capability = parts.length >= 3 ? parts[1] : undefined
    return { section: "delta", ...(capability ? { capability } : {}) }
  }
  return { section: "other" }
}

/** The label the detail view gives an artifact group. */
export function specArtifactLabel(section: SpecArtifactSection, capability?: string): string {
  switch (section) {
    case "proposal":
      return "Proposal"
    case "design":
      return "Design"
    case "tasks":
      return "Tasks"
    case "delta":
      return capability ? `Delta Specs (${capability})` : "Delta Specs"
    case "other":
      return "Other"
  }
}

/**
 * Loads everything the specs browser shows: the worktree inventory first,
 * then each accessible checkout's own local active changes read from that
 * checkout's filesystem (absolute artifact paths), then the launch checkout's
 * canonical specs. A checkout without `openspec/` is a fact, not an error;
 * unreadable evidence stays unknown and never suppresses the inventory.
 */
export async function loadSpecsView(targetDir: string): Promise<SpecsView> {
  targetDir = resolve(targetDir)
  const openspecRoot = join(targetDir, openspecDirName)
  const present = await dirExists(openspecRoot)
  let specs: string[] = []
  if (present) {
    specs = await collectDirRelativeMarkdown(join(openspecRoot, "specs"), join(openspecDirName, "specs"))
  }

  // The board join is additive: a failure (git missing, unreadable inventory)
  // degrades to an empty inventory instead of failing the browser — the
  // launch checkout's own artifact reads still serve.
  let board: ControlBoard
  try {
    board = await assembleControlBoard(targetDir)
  } catch {
    board = { worktrees: [] }
  }
  const changes: SpecsChangeEntry[] = []
  for (const worktree of board.worktrees) {
    for (const local of worktree.changes) {
      changes.push(await loadSpecsChangeAt(local.sourcePath, local.changeId, local.checkout))
    }
  }
  // The launch checkout is always a readable local source: when the inventory
  // could not report it (git unavailable, degraded board) its own changes are
  // still listed, keyed to the launch checkout — never dropped. The comparison
  // is physical: Git reports /private-prefixed paths on macOS where /var is a
  // symlink.
  const { realpathSafe } = await import("./git")
  const physicalTarget = await realpathSafe(targetDir).catch(() => targetDir)
  if (!board.worktrees.some((worktree) => worktree.path === targetDir || worktree.path === physicalTarget)) {
    const local = await readCheckoutActiveChanges(targetDir)
    if (local.kind === "known") {
      for (const change of local.value) {
        changes.push(await loadSpecsChangeAt(change.sourcePath, change.changeId, targetDir))
      }
    }
  }
  changes.sort((a, b) => a.checkout.localeCompare(b.checkout) || a.id.localeCompare(b.id))

  return {
    targetDir,
    present,
    board,
    changes,
    specs,
    ...(board.baseBranch ? { baseBranch: board.baseBranch } : {}),
  }
}

/**
 * Loads one change's entry from an explicit change root in an explicit
 * checkout — the only source a change entry ever has (design D3: files are
 * local inputs, never ownership).
 */
export async function loadSpecsChangeAt(changeRoot: string, id: string, checkout: string): Promise<SpecsChangeEntry> {
  let title = id
  try {
    const body = await readFile(join(changeRoot, "proposal.md"), "utf8")
    title = titleFromProposal(body, id)
  } catch {
    // A change without a readable proposal still lists by its id.
  }
  const relatives = await collectDirRelativeMarkdown(changeRoot, ".")
  // Absolute so the browser's readFile resolves regardless of its cwd.
  const fileBase = resolve(changeRoot)
  const artifacts = relatives.map((relative) => ({
    ...classifySpecArtifact(relative),
    file: join(fileBase, relative),
  }))
  artifacts.sort((a, b) => sectionOrder[a.section] - sectionOrder[b.section] || a.file.localeCompare(b.file))
  return { kind: "change", id, checkout, title, artifacts }
}

/**
 * Plain-text listing for pipes and CI (delta specs-viewer): the worktree
 * inventory with each checkout's independent observations, its local active
 * changes and artifact inventories, then the launch checkout's canonical
 * specs. No colors, no control sequences, no global deduplicated change list.
 */
export function printSpecsList(view: Pick<SpecsView, "board" | "changes" | "specs">): void {
  stdout.write(`\nworktrees:\n`)
  for (const worktree of view.board.worktrees) {
    const branch = worktree.detached ? "detached HEAD" : (worktree.branch ?? "(no branch)")
    const conditions: string[] = []
    if (worktree.bare) conditions.push("bare (repository metadata)")
    if (worktree.locked) conditions.push(`locked${worktree.locked.reason ? `: ${worktree.locked.reason}` : ""}`)
    if (worktree.prunable) conditions.push(`prunable${worktree.prunable.reason ? `: ${worktree.prunable.reason}` : ""}`)
    if (!worktree.accessible) conditions.push("inaccessible (registered path missing — repair or `git worktree prune`)")
    const suffix = conditions.length > 0 ? ` — ${conditions.join("; ")}` : ""
    stdout.write(`  ${worktreeDisplayName(worktree)}  ${worktree.path}  ${branch}${suffix}\n`)
    if (worktree.dirt) {
      stdout.write(worktree.dirt.kind === "known" ? `    dirt: ${worktree.dirt.value.dirty ? `${worktree.dirt.value.fileCount} file(s) uncommitted` : "clean"}\n` : `    dirt: unknown (${worktree.dirt.reason})\n`)
    }
    if (worktree.activity) {
      stdout.write(worktree.activity.kind === "known" ? `    activity: ${worktree.activity.value.total} live run(s)\n` : `    activity: unknown (${worktree.activity.reason})\n`)
    }
    if (worktree.changesUnknown) stdout.write(`    active changes: unknown (${worktree.changesUnknown})\n`)
    const local = view.changes.filter((change) => change.checkout === worktree.path)
    if (local.length > 0) {
      stdout.write("    active changes:\n")
      for (const change of local) {
        const heading = change.title === change.id ? change.id : `${change.id} — ${change.title}`
        stdout.write(`      ${heading}\n`)
        for (const artifact of change.artifacts) stdout.write(`        ${specArtifactLabel(artifact.section, artifact.capability).toLowerCase()}: ${artifact.file}\n`)
      }
    }
    if (worktree.archiveCount) stdout.write(`    archived changes: ${worktree.archiveCount} (browsable on demand)\n`)
    if (worktree.specCount) stdout.write(`    canonical specs: ${worktree.specCount}\n`)
  }
  // Changes whose checkout the degraded inventory could not report still list
  // under their own checkout path — never silently dropped.
  const knownPaths = new Set(view.board.worktrees.map((worktree) => worktree.path))
  for (const change of view.changes.filter((entry) => !knownPaths.has(entry.checkout))) {
    stdout.write(`  ${change.checkout}\n`)
    const heading = change.title === change.id ? change.id : `${change.id} — ${change.title}`
    stdout.write(`    active changes:\n      ${heading}\n`)
    for (const artifact of change.artifacts) stdout.write(`        ${specArtifactLabel(artifact.section, artifact.capability).toLowerCase()}: ${artifact.file}\n`)
  }
  stdout.write("\ncanonical specs:\n")
  if (view.specs.length === 0) {
    stdout.write("    (none)\n")
    return
  }
  for (const spec of view.specs) stdout.write(`    ${spec}\n`)
}

/**
 * The selection a returning specs browser restores (capability work-context /
 * specs-viewer: returning from a cancelled launcher, a dashboard, or an
 * authoring conversation restores the originating selection and refreshes the
 * assessment). Identity-keyed; never a list position.
 */
export type SpecsResumeSelection = {
  changeId?: string
  checkout?: string
  specPath?: string
  detail?: boolean
}

/**
 * Interactive entry point for `convoy specs`. A repository with registered
 * worktrees always opens the board — absence of OpenSpec artifacts never
 * suppresses the inventory (delta specs-viewer). Pipes get the plain listing
 * instead of the TUI. The browser itself is lazy-imported so non-interactive
 * invocations never pull in opentui. `resume` restores a returning selection
 * after an action; the caller reloads the view each round so restored state is
 * freshly assessed.
 */
export async function browseSpecs(targetDir: string, route?: TuiRoute, resume?: SpecsResumeSelection): Promise<SpecsResolution> {
  let view: SpecsView
  if (route && stdin.isTTY && stdout.isTTY) {
    // The home session's handoff: the loading transition covers a genuinely
    // slow board load; fast loads and non-interactive paths never see it.
    const { withLoadingTransition, isLoadingInterrupted } = await import("./loading-transition")
    const loaded = await withLoadingTransition(route, "specs", () => loadSpecsView(targetDir), { targetDir }).catch((error: unknown) => {
      // Ctrl+C during the transition already flagged the home session as
      // interrupted; exit quietly instead of opening the destination.
      if (!isLoadingInterrupted(error)) throw error
      return undefined
    })
    if (!loaded) return { type: "exit" }
    view = loaded
  } else {
    view = await loadSpecsView(targetDir)
  }
  if (view.board.worktrees.length === 0 && view.changes.length === 0 && view.specs.length === 0) {
    if (route) {
      const { showNoticeTui } = await import("./notice-tui")
      await showNoticeTui(route, { title: "specs", message: `No worktrees or specs found under ${join(view.targetDir, openspecDirName)}` })
      return { type: "exit" }
    }
    stdout.write(`no worktrees or specs found under ${join(view.targetDir, openspecDirName)}\n`)
    return { type: "exit" }
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    printSpecsList(view)
    return { type: "exit" }
  }
  const { browseSpecsTui } = await import("./specs-browser")
  return browseSpecsTui(
    view,
    route,
    resume
      ? {
          level: resume.detail ? "detail" : "root",
          ...(resume.changeId ? { changeId: resume.changeId } : {}),
          ...(resume.checkout ? { checkout: resume.checkout } : {}),
          ...(resume.specPath ? { specPath: resume.specPath } : {}),
        }
      : undefined,
  )
}

/**
 * The iterate window's opening message for a change — the sibling of
 * `tui.ts`'s `iteratePrompt`. Lists the change's planning files as initial
 * context; edits happen through OpenSpec authoring commands inside the session,
 * not by Convoy. Single line because the whole command travels through `zsh -lc`.
 */
export function specsIteratePrompt(changeID: string, files: readonly string[]): string {
  const list = files.length > 0 ? files.join(", ") : `openspec/changes/${changeID}/`
  return (
    `Continuing the OpenSpec change ${changeID}. First read these planning files: ${list}. ` +
    "proposal.md is the motivation, design.md the approach, tasks.md the checklist, and each delta spec under specs/ records what the change adds or modifies. " +
    "Revise the change with the OpenSpec authoring commands where my instructions ask. After reading, give a one-line status and wait for my instructions."
  )
}

/** The arguments handed to openIterateOpencodeWindow for an iterate handoff. */
export type IterateSessionInput = { targetDir: string; prompt: string; runDir: string }

/**
 * Builds the standalone-session opener input, rooted at the change's own
 * checkout (where its `openspec/changes/<id>/` lives). The run-dir grant lets
 * the session read its own planning files without prompting.
 */
export function buildIterateSessionInput(targetDir: string, view: SpecsView, changeID: string): IterateSessionInput {
  const change = view.changes.find((entry) => entry.id === changeID)
  const files = change?.artifacts.map((artifact) => artifact.file) ?? []
  const root = change?.checkout ?? targetDir
  return { targetDir: root, prompt: specsIteratePrompt(changeID, files), runDir: root }
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    await readdir(dir)
    return true
  } catch {
    return false
  }
}

// ── artifact grouping (the board's reading level) ────────────────────────

/**
 * One reading-level group of a subject's artifacts. Delta specs always merge
 * into a single "Delta Specs" group no matter how many capabilities they span
 * — the tab strip stays short and the merged source carries per-capability
 * headings (design D9).
 */
export type SpecGroup = {
  label: string
  /** True when this group merges delta specs across capabilities. */
  delta: boolean
  entries: Array<{ file: string; capability?: string }>
}

/**
 * Groups a change's artifacts into the reading level's stable order:
 * Proposal, Design, Tasks, one merged Delta Specs, then Other. A change with
 * a single group hides the tab strip entirely in the browser.
 */
export function groupChangeArtifacts(change: SpecsChangeEntry): SpecGroup[] {
  const groups: SpecGroup[] = []
  const byLabel = new Map<string, SpecGroup>()
  for (const artifact of change.artifacts) {
    const label = specArtifactLabel(artifact.section, artifact.section === "delta" ? undefined : artifact.capability)
    let group = byLabel.get(label)
    if (!group) {
      group = { label, delta: artifact.section === "delta", entries: [] }
      byLabel.set(label, group)
      groups.push(group)
    }
    group.entries.push({ file: artifact.file, ...(artifact.capability ? { capability: artifact.capability } : {}) })
  }
  return groups
}

/**
 * Builds the one source string a group's readers share — the detail pane's
 * markdown and the copy-to-clipboard payload are the same bytes. Delta groups
 * inject a small heading naming each capability before that capability's
 * files, so a merged tab still says what came from where.
 */
export function specGroupSource(group: SpecGroup, bodyOf: (file: string) => string): string {
  const parts: string[] = []
  for (const entry of group.entries) {
    const body = bodyOf(entry.file)
    if (group.delta && entry.capability) parts.push(`## ${entry.capability}\n\n${body}`)
    else parts.push(body)
  }
  return parts.join("\n\n")
}

/** Re-exported for the browser's worktree rows. */
export { worktreeDisplayName }
export type { BoardWorktree }
