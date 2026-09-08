import { lstat, readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"

/**
 * OpenSpec-native scoring contract.
 *
 * Convoy never writes OpenSpec state: `openspec/changes/<id>/{proposal.md,
 * specs/**, design.md, tasks.md}` is produced by the OpenSpec authoring tool
 * (outside this repo) and archived under `openspec/archive/`. This module only
 * reads that layout and turns it into a spec bundle — the current specs under
 * `openspec/specs/` plus the files of the active change(s) — that the runner
 * attaches to every agent step (proposal, design, tasks, and delta specs).
 *
 * The selection order (shared by the launcher, `--change`, and the runtime) is:
 *   1. explicit `--change <id>` (or a spec picked in the launcher);
 *   2. exactly one non-archived change in `openspec/changes/`;
 *   3. multiple, and the current branch name matches a change id (`feat/add-foo`
 *      ↔ `add-foo`);
 *   4. multiple, no branch match: compose the changes whose touched files appear
 *      in the diff against the base;
 *   5. none → no OpenSpec contract.
 *
 * `resolveChange` is pure and free of I/O so the whole selection order is
 * unit-testable; the thin `loadOpenSpecBundle` caller does the filesystem reads.
 */

export const openspecDirName = "openspec"

export type OpenSpecChange = {
  id: string
  /**
   * Files the change touches, matched against the working diff in the compose
   * path. Derived best-effort from the change's own markdown (proposal/design/
   * tasks and delta specs); an empty list simply means the compose rule will
   * never auto-select this change, which is the safe direction.
   */
  touchedFiles: readonly string[]
  /** Every markdown file the change carries, relative to the repo root. */
  specFiles: readonly string[]
}

/** A change the launcher can offer without building the full spec bundle. */
export type OpenSpecChangeSummary = {
  id: string
  /** First heading (or first non-empty line) of `proposal.md`; falls back to the id. */
  title: string
}

/** The resolved contract the run plan freezes and the runner attaches. */
export type OpenSpecBundle = {
  changeIds: readonly string[]
  /** Spec bundle file paths relative to the repo root: current specs + the active changes' files. */
  specFiles: readonly string[]
  /**
   * Absolute path of the checkout the bundle was resolved against (the launch
   * checkout). An isolated worktree starts from the base ref, so a freshly
   * proposed — still uncommitted — change exists only here; the runner falls
   * back to this root when a spec file is absent from the run's checkout.
   */
  rootDir?: string
}

/**
 * The short prompt injected when a change is the contract and the operator
 * did not type a brief. Pipeline-aware so review/ship/hunter do not say
 * "implement". The spec files themselves are the contract; this is only the
 * instruction that tells the agent to read them.
 */
export function openSpecPromptFor(pipelineName: string): string {
  switch (pipelineName) {
    case "review":
    case "review-lite":
    case "review-cc":
      return "Review the attached OpenSpec change."
    case "ship":
      return "Ship the attached OpenSpec change."
    case "fixer":
      return "Apply the attached OpenSpec change."
    case "hunter":
    case "hunter-max":
      return "Audit the attached OpenSpec change."
    default:
      return "Implement the attached OpenSpec change."
  }
}

/** Title shown in the launcher: first markdown heading, else first non-empty line. */
export function titleFromProposal(body: string, fallback: string): string {
  const stripped = stripYamlFrontmatter(body)
  const heading = stripped.match(/^#\s+(.+)$/m)
  const fromHeading = heading?.[1]?.trim()
  if (fromHeading) return fromHeading
  const line = stripped
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)
  return line || fallback
}

/**
 * Lists active (non-archived) changes for the launcher picker. Cheap: only
 * reads each change's `proposal.md` for a title. Returns `[]` when `openspec/`
 * is absent, so the launcher stays on today's manual-prompt path.
 */
export async function listOpenSpecChanges(targetDir: string): Promise<OpenSpecChangeSummary[]> {
  const changesDir = join(targetDir, openspecDirName, "changes")
  const entries = await readDirNames(changesDir)
  const out: OpenSpecChangeSummary[] = []
  for (const id of entries.filter(isOpenSpecChangeId)) {
    let title = id
    try {
      const body = await readFile(join(changesDir, id, "proposal.md"), "utf8")
      title = titleFromProposal(body, id)
    } catch {
      // A change without a readable proposal still lists by id.
    }
    out.push({ id, title })
  }
  return out
}

/**
 * Whether a `openspec/changes/` entry names a change dir. The archive binder,
 * dotfiles, and stray root drop-ins (a proposal.md accidentally left at the top
 * level) are not changes.
 */
export function isOpenSpecChangeId(id: string): boolean {
  if (!id) return false
  if (id === "archive") return false
  if (id.startsWith(".")) return false
  if (id.endsWith(".md")) return false
  return true
}

/** `feat/add-foo` (or a bare `add-foo`) → `add-foo`; `undefined` when there is no branch. */
export function branchIdFromBranch(branch?: string): string | undefined {
  if (!branch) return undefined
  const slash = branch.indexOf("/")
  const candidate = slash === -1 ? branch : branch.slice(slash + 1)
  return candidate || undefined
}

/**
 * The change-id directory names under an `openspec/changes/` root: real
 * (non-symlink) directories that pass `isOpenSpecChangeId`, sorted. One shared
 * rule for the launcher, the control board, the specs viewer, and spin, so the
 * three cannot drift apart (SC-8). Returns `[]` when the directory is absent.
 */
export async function listChangeIds(changesDir: string): Promise<string[]> {
  try {
    const dirents = await readdir(changesDir, { withFileTypes: true })
    return dirents
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter(isOpenSpecChangeId)
      .sort()
  } catch {
    return []
  }
}

export type ResolveChangeInput = {
  /**
   * The operator's explicit `--change <id>` selection, in review order
   * (repeatable). Selection is explicit only: no singleton, branch-name, or
   * diff heuristic may select or expand the list (run-launcher delta).
   */
  explicitIds?: readonly string[]
  /** Raw basename entries of `openspec/changes/` (including `archive/` and stray files). */
  changesDirEntries: readonly string[]
  /** Per-change context (touched files, spec files) keyed by change id. */
  changesById: ReadonlyMap<string, OpenSpecChange>
}

/**
 * The explicit selection as a pure function: the requested ids that name real
 * active changes, in the requested order, deduplicated. Without an explicit
 * selection this returns `[]` — never a guessed singleton or branch match.
 * Requested ids that match nothing are dropped here; the caller refuses the
 * run naming them, so a typo or an archived id surfaces before any effect.
 */
export function resolveChange(input: ResolveChangeInput): readonly string[] {
  const changes = input.changesDirEntries.filter(isOpenSpecChangeId)
  if (changes.length === 0) return []

  const selected: string[] = []
  for (const raw of input.explicitIds ?? []) {
    const id = raw.trim()
    if (id && changes.includes(id) && !selected.includes(id)) selected.push(id)
  }
  return selected
}

/**
 * Discovers the active change(s) and materializes the spec bundle. Returns
 * `undefined` when the repository has no `openspec/` at all — that is the
 * brownfield signal that keeps today's `.convoy/prd-history` behavior intact
 * (the bundle must be additive on detection only). A bundle with empty
 * `changeIds` means nothing was explicitly selected; the caller decides
 * whether that is the explicit no-change mode or a refusal (run-launcher
 * delta: no heuristic ever fills the list in).
 */
export async function loadOpenSpecBundle(input: {
  targetDir: string
  /** The operator's explicit `--change` selection, in review order. */
  explicitIds?: readonly string[]
}): Promise<OpenSpecBundle | undefined> {
  const openspecRoot = join(input.targetDir, openspecDirName)
  if (!(await dirExists(openspecRoot))) return undefined

  const changesDir = join(openspecRoot, "changes")
  const changesDirEntries = await readDirNames(changesDir)
  const changesById = new Map<string, OpenSpecChange>()
  for (const id of changesDirEntries.filter(isOpenSpecChangeId)) {
    const changeRoot = join(changesDir, id)
    const relativeMds = await collectMarkdownFiles(changeRoot)
    const touchedFiles = new Set<string>()
    for (const relative of relativeMds) {
      try {
        const body = await readFile(join(changeRoot, relative), "utf8")
        for (const token of filePathTokens(body)) touchedFiles.add(stripLeadingDotSlash(token))
      } catch {
        // A change that loses a file mid-edit still resolves by its id.
      }
    }
    changesById.set(id, {
      id,
      touchedFiles: [...touchedFiles].sort(),
      specFiles: relativeMds.map((relative) => join(openspecDirName, "changes", id, relative)),
    })
  }

  const currentSpecFiles = await collectDirRelativeMarkdown(join(openspecRoot, "specs"), join(openspecDirName, "specs"))

  const selected = resolveChange({
    explicitIds: input.explicitIds,
    changesDirEntries,
    changesById,
  })

  const changeSpecFiles = selected.flatMap((id) => changesById.get(id)?.specFiles ?? [])
  return {
    changeIds: selected,
    specFiles: [...currentSpecFiles, ...changeSpecFiles],
    rootDir: resolve(input.targetDir),
  }
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    await readdir(dir)
    return true
  } catch {
    return false
  }
}

/** Returns every markdown file under `root`, as paths relative to `root`. */
async function collectMarkdownFiles(root: string): Promise<string[]> {
  return collectDirRelativeMarkdown(root, ".")
}

/**
 * Walks `root` and returns every hidden-skipping `.md` path, relative to `root`,
 * sorted. Symlinks are never followed — file links, directory links, and a
 * symlinked walk root (e.g. `openspec/specs` → somewhere outside the repo)
 * contribute nothing rather than attaching out-of-repo files to the contract.
 *
 * Shared with the specs viewer (`specs.ts`), which lists the same layout for
 * humans instead of building a runner bundle.
 */
export async function collectDirRelativeMarkdown(root: string, relativeRoot: string): Promise<string[]> {
  let dirents
  try {
    // lstat, not stat/readdir: a symlinked root is not a directory here, so the
    // walk stops instead of silently following the link out of the repository.
    if (!(await lstat(root)).isDirectory()) return []
    dirents = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of dirents) {
    if (entry.name.startsWith(".")) continue
    if (entry.isSymbolicLink()) continue
    const relative = join(relativeRoot, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await collectDirRelativeMarkdown(join(root, entry.name), relative)))
    } else if (entry.name.endsWith(".md")) {
      out.push(relative)
    }
  }
  return out.sort()
}

/**
 * Returns the sorted names of a directory's real (non-symlink) entries, or an
 * empty list when absent. A symlink named like a change id is not a change.
 */
async function readDirNames(dir: string): Promise<string[]> {
  try {
    const dirents = await readdir(dir, { withFileTypes: true })
    return dirents
      .filter((entry) => !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** Relative path tokens that look like files (contain a `/` and an extension). */
const filePathTokenPattern = /\b(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]+\b/g

function filePathTokens(content: string): string[] {
  return [...new Set(content.match(filePathTokenPattern) ?? [])]
}

function stripLeadingDotSlash(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path
}

/** Drops a leading YAML frontmatter block so titles and renderers see the body. */
export function stripYamlFrontmatter(body: string): string {
  if (!body.startsWith("---")) return body
  const end = body.indexOf("\n---", 3)
  if (end === -1) return body
  return body.slice(end + 4)
}
