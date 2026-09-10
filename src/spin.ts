import { cp, mkdir, readFile, rename, rm, rmdir, stat } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"
import { stdout } from "node:process"

import { detectBaseRef, execFile, statusPorcelain } from "./git"
import {
  collectDirRelativeMarkdown,
  isOpenSpecChangeId,
  listChangeIds,
  openspecDirName,
} from "./openspec"
import { repoCommonDir } from "./repo-store"
import { acknowledgeStep, createOperation, ensureOperationsRoot, recordStepIntent, resolveOperation } from "./operation-journal"
import { branchNameForChange, branchNameTaken, createIsolatedWorktree, detectSpinPrefixOverride, inferChangePrefix } from "./worktree"

/**
 * `convoy spin` — the retained legacy proposal-transfer utility (capability
 * `feature-spin`, design D11). Given an uncommitted OpenSpec change on the
 * base checkout, spin creates an isolated worktree whose branch name is
 * `<prefix>/<change-id>` (the prefix inferred from the change's own
 * delta-spec operations), moves the uncommitted change files into the
 * worktree, commits nothing, reverts nothing, and prints the `/move` handoff.
 * Convoy never touches an OpenCode session, and spin registers nothing: the
 * created checkout appears through Git inventory like any other worktree.
 * Partial transfers keep operation-scoped recovery only (an unresolved
 * operation journal), never a feature record.
 */

export type SpinOptions = {
  targetDir: string
  /** Explicit change id (`--change`); wins over uncommitted-change resolution. */
  changeID?: string
  /** Prefix override (`--prefix`); wins over delta-operation inference. */
  prefix?: string
}

export type SpinResult = {
  changeID: string
  branch: string
  worktreeDir: string
  /** Uncommitted files carried into the worktree. */
  movedFiles: string[]
  /** True when the change was already committed on the base branch: nothing moved, the base ref carries it. */
  committedOnBase: boolean
  /** The inferred or overridden conventional prefix the branch got. */
  prefix: string
}

/**
 * The whole spin sequence. Throws `Error` with an operator-facing message on
 * every refusal path (dirty tree outside `openspec/`, ambiguous changes,
 * unknown change) — nothing has been created when those fire.
 */
export async function runSpin(options: SpinOptions): Promise<SpinResult> {
  const { targetDir } = options

  // 1. Refuse rather than interact with unrelated changes. Only dirt inside
  //    openspec/ is spin's business; anything else stops the sequence.
  const porcelain = await statusPorcelain(targetDir)
  const outside = dirtyOutsideOpenspec(porcelain)
  if (outside.length > 0) {
    throw new Error(
      `the working tree has changes outside ${openspecDirName}/; commit or stash them first so spin doesn't interact with unrelated work\n  ${outside.join("\n  ")}`,
    )
  }

  // 2. Resolve the change: --change wins; a single uncommitted change is auto;
  //    several uncommitted changes stop for a choice instead of guessing.
  const changeID = await resolveChangeID(targetDir, options.changeID)

  // 3. Derive the branch name from the change's own delta operations.
  const deltaBodies = await readDeltaBodies(targetDir, changeID)
  const prefix = options.prefix ? detectSpinPrefixOverride(options.prefix) : inferChangePrefix(deltaBodies)
  const branch = branchNameForChange(changeID, prefix)
  const baseRef = await spinBaseRef(targetDir)

  // Refuse a name that's already taken. `createIsolatedWorktree` would suffix
  // it to `feat/<id>-2`, but that breaks the deterministic naming contract.
  // If a branch or worktree for this change already exists, the change is
  // presumably already spun out — continue or close it from the worktree
  // control center (`convoy worktrees`) instead of minting a mis-linked twin.
  if (await branchNameTaken(branch, targetDir)) {
    throw new Error(
      `a branch or worktree for ${changeID} already exists (${branch}); if the change is already spun out, continue or close it from ` +
        "the worktree control center (`convoy worktrees`) rather than spinning a mis-linked twin",
    )
  }

  // 4. Create the worktree on the base ref a launcher-isolated run would use.
  const worktree = await createIsolatedWorktree({ targetDir, branch, baseRef })

  // 5. Record the transfer intent as an unresolved operation (capability
  //    feature-spin, design D11): source/destination evidence survives a
  //    crash mid-transfer and is reconciled through `convoy worktrees
  //    recover` — never a feature record, and released once resolved.
  const commonDir = await repoCommonDir(targetDir)
  let operationId: string | undefined
  if (commonDir) {
    try {
      await ensureOperationsRoot(commonDir)
      const created = await createOperation(commonDir, {
        kind: "spin-transfer",
        intent: { changeId: changeID, branch: worktree.branch, worktreeDir: worktree.dir, sourceDir: targetDir, baseRef },
        steps: ["transfer"],
      })
      if (created.ok) {
        operationId = created.operation.operationId
        await recordStepIntent(commonDir, operationId, "transfer", { changeId: changeID, worktreeDir: worktree.dir })
      }
    } catch {
      // A journal that cannot be written is disclosed below; the transfer
      // itself stays reversible by hand, so it is not blocked outright.
    }
  }

  // 6. Carry the uncommitted files over. Committed files stay exactly where
  //    they are — the worktree's base ref carries them, and overlap resolves
  //    at merge time.
  const untracked = await listUntrackedFilesUnder(targetDir, join(openspecDirName, "changes", changeID))
  // `committedOnBase` must be verified against the base ref, not inferred from
  // "no untracked files": a change committed on some *other* branch has no
  // untracked files here, and the worktree's base ref would not carry it (SC-9).
  const seenOnBase = await changePresentAtRef(baseRef, changeID, targetDir)
  const movedFiles =
    untracked.length > 0
      ? await moveFilesIntoWorktree(targetDir, worktree.dir, untracked, join(targetDir, openspecDirName, "changes", changeID))
      : []
  const committedOnBase = seenOnBase && movedFiles.length === 0
  if (!seenOnBase && untracked.length === 0) {
    throw new Error(
      `the change ${changeID} is not uncommitted here and not on the base ref (${baseRef}) — it is committed on another branch, ` +
        `so its files would not arrive in this worktree; check out the branch that carries it or spin a change that exists here. ` +
        `The created worktree at ${worktree.dir} is preserved${operationId ? `; inspect or cancel the pending transfer with \`convoy worktrees recover --operation ${operationId}\`` : ""}.`,
    )
  }

  // 7. Acknowledge the verified transfer and release the operation journal:
  //    a resolved transfer leaves no recovery record behind (design D9).
  if (commonDir && operationId) {
    await acknowledgeStep(commonDir, operationId, "transfer", { movedFiles: movedFiles.length }).catch(() => {})
    await resolveOperation({ commonDir, operationId, gitCwd: targetDir, outcome: "resolved" }).catch(() => {})
  }

  return { changeID, branch: worktree.branch, worktreeDir: worktree.dir, movedFiles, committedOnBase, prefix }
}

/**
 * The `/move` handoff. The spike verifying that OpenCode 1.18's picker lists a
 * freshly `git worktree add`-ed directory has not been run in this
 * environment, so the output deliberately covers both outcomes: it instructs
 * the operator to `/move` (D4's native path) and names the directory so the
 * documented fallback — opening a session there directly — stays available.
 */
export function printSpinHandoff(result: SpinResult): void {
  const lines: string[] = []
  lines.push(`spun out ${result.changeID} → ${result.worktreeDir}`)
  lines.push(`branch: ${result.branch}`)
  if (result.committedOnBase) {
    lines.push("nothing was moved: the change is already committed on the base branch, and the worktree's base ref carries it")
  } else {
    lines.push(`moved ${result.movedFiles.length} uncommitted file${result.movedFiles.length === 1 ? "" : "s"} into the worktree (nothing committed)`)
    for (const file of result.movedFiles.slice(0, 10)) lines.push(`  ${file}`)
    if (result.movedFiles.length > 10) lines.push(`  … and ${result.movedFiles.length - 10} more`)
    lines.push("next: commit the proposal inside the worktree")
  }
  lines.push("continue the same OpenCode conversation: run /move and pick the worktree above")
  lines.push(`(if /move doesn't list it, open a session in ${result.worktreeDir} instead)`)
  stdout.write(`\n${lines.join("\n")}\n`)
}

export function spinHelp(): string {
  return `convoy spin [--change <id>] [--prefix <type>]

Spin an uncommitted OpenSpec change out of the base checkout into an isolated
worktree on a conventionally named branch (<prefix>/<change-id>), move the
change files in, and print the /move handoff for the current OpenCode session.

The prefix is inferred from the change's own delta specs: any ADDED requirement
→ feat, only MODIFIED → change, only REMOVED → fix, no delta specs yet → feat.
A tree dirty outside openspec/ refuses to spin; a change already committed on
the base branch spins with nothing moved. The /convoy-spin OpenCode command is
opt-in: run \`convoy opencode install\` once to install the thin wrapper that
runs this command from a session (spin never touches your global config).

Usage:
  convoy spin [--change <id>] [--prefix <type>]

Options:
  --change <id>    Pin the OpenSpec change (default: the single uncommitted one)
  --prefix <type>  Override the inferred conventional prefix (change, feat, fix, …)
`
}

// ── resolution helpers ───────────────────────────────────────────────────

/** Porcelain entries whose path is outside `openspec/`. */
export function dirtyOutsideOpenspec(porcelain: string): string[] {
  const out: string[] = []
  for (const line of porcelain.split("\n")) {
    if (line.trim() === "") continue
    const path = porcelainPath(line)
    if (path && !path.startsWith(`${openspecDirName}/`)) out.push(line.trim())
  }
  return out
}

/** The path half of a porcelain line, handling quoting and rename arrows. */
function porcelainPath(line: string): string | undefined {
  const body = line.slice(3)
  const rename = / -> /.exec(body)
  const candidate = rename ? rename.input!.slice(rename.index + 4) : body
  const unquoted = candidate.replace(/^"|"$/g, "")
  return unquoted || undefined
}

/**
 * Which change to spin out. Explicit `--change` wins (and must be active).
 * Otherwise the uncommitted changes drive it: exactly one is auto-selected,
 * several stop with a list and a non-zero exit, and none (everything already
 * committed) falls back to a single active change — the committed-on-base path.
 */
async function resolveChangeID(targetDir: string, explicit: string | undefined): Promise<string> {
  const active = await listActiveChangeIds(targetDir)
  if (explicit) {
    if (!active.includes(explicit)) {
      throw new Error(`--change "${explicit}" matched no active change under ${openspecDirName}/changes/ (archived or absent)`)
    }
    return explicit
  }

  const uncommitted = await listUncommittedChangeIds(targetDir)
  if (uncommitted.length === 1) return uncommitted[0]!
  if (uncommitted.length > 1) {
    throw new Error(
      `several uncommitted changes; pick one with --change:\n  ${uncommitted.join("\n  ")}`,
    )
  }
  if (active.length === 1) return active[0]!
  if (active.length === 0) throw new Error(`no active change under ${openspecDirName}/changes/; propose one first (openspec)`)
  throw new Error(`several committed changes and no uncommitted one; pick one with --change:\n  ${active.join("\n  ")}`)
}

async function listActiveChangeIds(targetDir: string): Promise<string[]> {
  return listChangeIds(join(targetDir, openspecDirName, "changes"))
}

/** Change ids with at least one untracked file under `openspec/changes/<id>/`. */
async function listUncommittedChangeIds(targetDir: string): Promise<string[]> {
  const untracked = await listUntrackedFilesUnder(targetDir, join(openspecDirName, "changes"))
  const ids = new Set<string>()
  for (const file of untracked) {
    const rest = relative(join(targetDir, openspecDirName, "changes"), join(targetDir, file))
    const id = rest.split("/")[0]
    if (id && isOpenSpecChangeId(id)) ids.add(id)
  }
  return [...ids].sort()
}

/** Untracked, non-ignored files under `pathPrefix` (relative to the repo root). */
async function listUntrackedFilesUnder(targetDir: string, pathPrefix: string): Promise<string[]> {
  const result = await execFile("git", ["ls-files", "--others", "--exclude-standard", "--", pathPrefix], {
    cwd: targetDir,
    allowFailure: true,
  })
  if (result.exitCode !== 0) return []
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
}

/** The delta-spec bodies of a change (empty when it has none yet → `feat`). */
async function readDeltaBodies(targetDir: string, changeID: string): Promise<string[]> {
  const changeRoot = join(targetDir, openspecDirName, "changes", changeID)
  const relatives = await collectDirRelativeMarkdown(join(changeRoot, "specs"), "specs")
  const bodies: string[] = []
  for (const relativePath of relatives) {
    try {
      bodies.push(await readFile(join(changeRoot, relativePath), "utf8"))
    } catch {
      // A delta that vanished mid-read contributes nothing to the inference.
    }
  }
  return bodies
}

/** The base ref a launcher-isolated run would use: detected base, else HEAD. */
async function spinBaseRef(targetDir: string): Promise<string> {
  const detected = await detectBaseRef(targetDir).catch(() => undefined)
  return detected?.ref ?? "HEAD"
}

/** Whether the change's directory exists in the tree of `ref` (committed on that ref). */
async function changePresentAtRef(ref: string, changeID: string, targetDir: string): Promise<boolean> {
  const result = await execFile(
    "git",
    ["ls-tree", "-d", "--name-only", ref, "--", join(openspecDirName, "changes", changeID)],
    { cwd: targetDir, allowFailure: true },
  )
  return result.exitCode === 0 && result.stdout.trim() !== ""
}

/**
 * Moves the given repo-relative files into the worktree (same relative
 * layout), creating parent directories, then prunes every emptied source
 * ancestor through the selected change root. Nothing is committed on either
 * side.
 */
async function moveFilesIntoWorktree(
  sourceDir: string,
  worktreeDir: string,
  files: readonly string[],
  changeRoot: string,
): Promise<string[]> {
  const moved: string[] = []
  for (const file of files) {
    const from = join(sourceDir, file)
    const to = join(worktreeDir, file)
    await mkdir(dirname(to), { recursive: true })
    await moveFile(from, to)
    moved.push(file)
  }
  await pruneEmptiedAncestors(sourceDir, files, changeRoot)
  return moved
}

/**
 * Prunes the directories the move emptied: every former parent of each moved
 * artifact walked upward to and including the selected change root,
 * deduplicated and processed deepest first, so sibling artifact directories
 * are removed before their shared parents — and the change root disappears
 * only after its descendants are gone. Intermediate directories such as
 * `openspec/changes/<id>/specs/` cannot survive as invisible residue, because
 * git does not track empty directories.
 *
 * The boundary is explicit: artifacts outside the change root contribute no
 * candidates, and no walk ever rises above the root, so another active change
 * or a parent OpenSpec directory is never touched.
 */
async function pruneEmptiedAncestors(sourceDir: string, files: readonly string[], changeRoot: string): Promise<void> {
  const candidates = new Set<string>()
  for (const file of files) {
    let dir = dirname(join(sourceDir, file))
    if (!withinChangeRoot(dir, changeRoot)) continue
    while (true) {
      candidates.add(dir)
      if (dir === changeRoot) break
      const parent = dirname(dir)
      if (parent === dir) break // filesystem root guard; unreachable past the boundary check
      dir = parent
    }
  }
  const dirs = [...candidates].sort((a, b) => b.length - a.length)
  for (const dir of dirs) await removeDirIfEmpty(dir)
}

/** True when `dir` is `root` itself or strictly below it (no prefix false-positives like `<id>-2`). */
function withinChangeRoot(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(`${root}${sep}`)
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error) {
    // Cross-device moves (home dir on another volume than the repo) rename
    // can't do; copy-and-unlink is the same logical move.
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error
    await mkdir(dirname(to), { recursive: true })
    await cp(from, to, { recursive: true })
    await rm(from, { recursive: true })
  }
}

/**
 * Atomic empty-directory removal: `rmdir` succeeds only for an empty
 * directory, closing the readdir-then-remove race and guaranteeing that a
 * file, symlink, or other entry anchors its directory against deletion. An
 * already-absent or non-empty directory is a valid cleanup outcome;
 * unexpected filesystem errors are surfaced so spin never claims cleanup it
 * could not satisfy.
 */
async function removeDirIfEmpty(dir: string): Promise<void> {
  try {
    await rmdir(dir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return
    throw error
  }
}

/** Used by tests (and any caller) to confirm the worktree really exists. */
export async function dirExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
