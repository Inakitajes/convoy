import { mkdir, realpath, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { log } from "./log"

type ExecOptions = {
  cwd: string
  env?: Record<string, string>
  allowFailure?: boolean
}

type ExecResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type RepoSnapshot = {
  head: string
  ref?: string
}

export type RepoBootstrapStatus = "ready" | "no-repo" | "no-commits"

// Never inherit status.showUntrackedFiles from repository/user config: safety
// checks and commits must see every untracked file, including nested ones.
const statusArgs = ["status", "--porcelain=v1", "--untracked-files=all"]

// Convoy's commits are always unsigned. They are machine commits authored by
// convoy@local — an identity no user signing key matches — and inheriting a
// global `commit.gpgsign = true` makes an unattended run block on an
// interactive signing prompt (1Password/gpg-agent) that times out, fails the
// commit, and takes the whole pipeline down with it.
//
// `commitAsUser` below is the deliberate exception, and the asymmetry is the
// point: step commits are machine commits and stay unsigned, while the single
// squashed commit automatic compaction creates belongs to the user and inherits
// their entire git config, signature included.
const commitArgs = ["commit", "--no-gpg-sign"]

/**
 * Shared with the control board's reads (`openspec list --json`, `git cherry`),
 * which need the same non-throwing `allowFailure` spawn semantics as the git
 * helpers below.
 */
export async function execFile(command: string, args: string[], options: ExecOptions): Promise<ExecResult> {
  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  })

  const stdoutPromise = new Response(proc.stdout).text()
  const stderrPromise = new Response(proc.stderr).text()
  const exitCode = await proc.exited
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])

  if (exitCode !== 0 && !options.allowFailure) {
    const output = (stderr || stdout).trim()
    throw new Error(`${command} ${args.join(" ")}: ${output || `exit ${exitCode}`}`)
  }

  return { stdout, stderr, exitCode }
}

export async function ensureRepoReady(cwd: string, options: { includeDirty?: boolean; baseRef?: string; allowDirty?: boolean } = {}) {
  await requireRepoRoot(cwd)

  if (options.baseRef) {
    const base = await execFile("git", ["rev-parse", "--verify", "--quiet", `${options.baseRef}^{commit}`], { cwd, allowFailure: true })
    if (base.exitCode !== 0) {
      const head = await execFile("git", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd, allowFailure: true })
      if (head.exitCode !== 0) {
        throw new Error(`repository at ${cwd} has no commits yet; create an initial commit first`)
      }
      throw new Error(
        `base ref "${options.baseRef}" doesn't exist in this repo; pass a --base <ref> that exists (e.g. --base master), or drop --base / defaults.baseRef to let convoy auto-detect the base branch`,
      )
    }
  }

  const status = await execFile("git", statusArgs, { cwd })
  if (status.stdout.trim() !== "") {
    // A resumed run defers the dirty-tree decision to the recovery step, which
    // can offer to commit an interrupted phase's leftover changes and continue.
    if (options.allowDirty) return
    if (!options.includeDirty) {
      throw dirtyTreeError(cwd, status.stdout)
    }
    log.warn("working tree is not clean; --include-dirty will include those changes in the first commit of the pipeline")
  }
}

export type BaseRefDetection = {
  ref: string
  source: "origin-head" | "probe" | "current-branch"
}

/** Branch names conventionally used as a repo's trunk, probed in order when origin/HEAD says nothing. */
const baseBranchNames = ["main", "master", "develop", "trunk"] as const

/**
 * Best-effort detection of the branch to diff against when neither --base nor
 * defaults.baseRef is set: the remote's default branch (origin/HEAD), then
 * common base names, then whatever is checked out. Never throws; undefined
 * when nothing resolves to a commit (not a repo, or a repo with no commits).
 */
export async function detectBaseRef(cwd: string): Promise<BaseRefDetection | undefined> {
  const commitExists = async (ref: string) => {
    const result = await execFile("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd, allowFailure: true })
    return result.exitCode === 0
  }

  const originHead = await execFile("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd, allowFailure: true })
  if (originHead.exitCode === 0) {
    const remoteBranch = originHead.stdout.trim()
    // Branch names may contain "/", so strip the known prefix instead of splitting.
    const localName = remoteBranch.startsWith("origin/") ? remoteBranch.slice("origin/".length) : remoteBranch
    if (localName && (await commitExists(localName))) return { ref: localName, source: "origin-head" }
    // No local checkout of the default branch: the remote-tracking ref still
    // works as a diff base. An origin/HEAD left pointing at a deleted branch
    // fails both checks and falls through.
    if (await commitExists(remoteBranch)) return { ref: remoteBranch, source: "origin-head" }
  }

  for (const name of baseBranchNames) {
    if (await commitExists(name)) return { ref: name, source: "probe" }
  }

  const current = await execFile("git", ["branch", "--show-current"], { cwd, allowFailure: true })
  const branch = current.stdout.trim()
  // An unborn branch (zero-commit repo) prints a name that has no commit yet.
  if (branch && (await commitExists(branch))) return { ref: branch, source: "current-branch" }
  if (await commitExists("HEAD")) return { ref: "HEAD", source: "current-branch" }

  return undefined
}

export async function repoBootstrapStatus(cwd: string): Promise<RepoBootstrapStatus> {
  const rootResult = await execFile("git", ["rev-parse", "--show-toplevel"], { cwd, allowFailure: true })
  if (rootResult.exitCode !== 0) return "no-repo"

  await assertRepoRoot(cwd, rootResult.stdout.trim())
  const head = await execFile("git", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd, allowFailure: true })
  return head.exitCode === 0 ? "ready" : "no-commits"
}

export async function initializeRepoWithInitialCommit(cwd: string, options: { baseRef?: string } = {}) {
  const status = await repoBootstrapStatus(cwd)
  if (status === "no-repo") {
    const args = ["init", "-q"]
    if (options.baseRef && isSafeInitialBranch(options.baseRef)) args.push("-b", options.baseRef)
    await execFile("git", args, { cwd })
  } else if (status === "ready") {
    return
  }

  const currentStatus = await repoBootstrapStatus(cwd)
  if (currentStatus === "ready") return
  if (currentStatus === "no-repo") throw new Error("couldn't initialize git repository")

  if (options.baseRef && isSafeInitialBranch(options.baseRef)) {
    await execFile("git", ["symbolic-ref", "HEAD", `refs/heads/${options.baseRef}`], { cwd })
  }

  await execFile("git", ["add", "-A"], { cwd })
  const porcelain = await execFile("git", statusArgs, { cwd })
  const suspicious = findSuspiciousStagedFiles(porcelain.stdout)
  if (suspicious.length > 0) {
    await execFile("git", ["reset"], { cwd })
    throw new Error(
      `refusing to create initial commit with files that look like secrets: ${suspicious.join(", ")}. ` +
        `Add them to .gitignore (or remove them) and re-run.`,
    )
  }

  const initialCommitArgs =
    porcelain.stdout.trim() === "" ? [...commitArgs, "--allow-empty", "-m", "convoy: initial commit"] : [...commitArgs, "-m", "convoy: initial commit"]
  await execFile("git", initialCommitArgs, { cwd, env: convoyGitEnv })
}

export async function statusPorcelain(cwd: string): Promise<string> {
  const status = await execFile("git", statusArgs, { cwd })
  return status.stdout
}

// On resume the target dir comes from the run's metadata, not the user's cwd —
// name the repo and the files or the error is impossible to act on.
export function dirtyTreeError(cwd: string, porcelain: string, options: { resuming?: boolean } = {}) {
  const hint = options.resuming
    ? "resume in an interactive terminal to commit these changes as the interrupted phase and continue, or commit/stash them manually"
    : "do commit/stash or use --include-dirty to include those changes"
  return new Error(`working tree at ${cwd} is not clean; ${hint}\n${dirtyFilesPreview(porcelain)}`)
}

const maxDirtyPreview = 5

export function dirtyFilesPreview(porcelain: string) {
  const lines = porcelain.split("\n").filter(Boolean)
  const shown = lines.slice(0, maxDirtyPreview).map((line) => `  ${line}`)
  if (lines.length > shown.length) shown.push(`  … and ${lines.length - shown.length} more`)
  return shown.join("\n")
}

/** Returns the current HEAD commit SHA, or undefined when the repo has no commits or git fails. */
export async function currentHead(cwd: string): Promise<string | undefined> {
  try {
    const result = await execFile("git", ["rev-parse", "HEAD"], { cwd, allowFailure: true })
    return result.exitCode === 0 ? result.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

export async function createCleanRepoSnapshot(cwd: string): Promise<RepoSnapshot | undefined> {
  const status = await execFile("git", statusArgs, { cwd })
  if (status.stdout.trim() !== "") return undefined

  const [head, ref] = await Promise.all([
    execFile("git", ["rev-parse", "HEAD"], { cwd }),
    execFile("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, allowFailure: true }),
  ])
  return { head: head.stdout.trim(), ...(ref.exitCode === 0 ? { ref: ref.stdout.trim() } : {}) }
}

export async function restoreRepoSnapshot(snapshot: RepoSnapshot, cwd: string) {
  // Capture the current HEAD as a backup ref before the restore sequence so a
  // crash or command failure mid-sequence leaves a recoverable point instead
  // of a half-reset repository. Without this, a crash between the six git
  // commands leaves HEAD detached, the branch un-updated, and the working tree
  // in an undefined state that requires manual `git fsck` / `git reflog`
  // (HN-009).
  const backupRef = `refs/convoy/snapshot/restore-${Date.now()}`
  let backupCreated = false
  try {
    await execFile("git", ["update-ref", backupRef, "HEAD"], { cwd })
    backupCreated = true
  } catch {
    // If we can't create a backup ref, proceed best-effort — the restore is
    // still needed, and update-ref failure is extremely unlikely.
  }

  try {
    await execFile("git", ["reset", "--hard"], { cwd })
    await execFile("git", ["clean", "-fd"], { cwd })
    await execFile("git", ["checkout", "--detach", snapshot.head], { cwd })
    if (snapshot.ref) await execFile("git", ["checkout", "-B", snapshot.ref, snapshot.head], { cwd })
    await execFile("git", ["reset", "--hard", snapshot.head], { cwd })
    await execFile("git", ["clean", "-fd"], { cwd })
  } catch (error) {
    if (backupCreated) {
      log.error(
        `restoreRepoSnapshot failed mid-sequence; the repository may be in an inconsistent state. ` +
          `The pre-restore HEAD was saved as ${backupRef}. Recover with:\n` +
          `  git reset --hard ${backupRef}\n` +
          `Then re-run convoy to resume.`,
      )
    }
    throw error
  }

  // Clean up the backup ref on success to avoid ref namespace pollution.
  if (backupCreated) await execFile("git", ["update-ref", "-d", backupRef], { cwd, allowFailure: true })
}

export async function describeRepoSnapshotDifference(snapshot: RepoSnapshot, cwd: string): Promise<string | undefined> {
  const [status, head, ref] = await Promise.all([
    execFile("git", statusArgs, { cwd }),
    execFile("git", ["rev-parse", "HEAD"], { cwd, allowFailure: true }),
    execFile("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, allowFailure: true }),
  ])
  const details: string[] = []
  const currentHead = head.exitCode === 0 ? head.stdout.trim() : "<missing>"
  const currentRef = ref.exitCode === 0 ? ref.stdout.trim() : undefined
  if (currentHead !== snapshot.head) details.push(`HEAD changed from ${snapshot.head} to ${currentHead}`)
  if (currentRef !== snapshot.ref) details.push(`branch changed from ${snapshot.ref ?? "<detached>"} to ${currentRef ?? "<detached>"}`)
  if (status.stdout.trim() !== "") details.push(dirtyFilesPreview(status.stdout))
  return details.length > 0 ? details.join("\n") : undefined
}

/**
 * Creates `<dir>` as a new worktree on a fresh `<branch>` based off `<baseRef>`
 * (a commit/ref in `cwd`'s repo). Used by the launcher's "isolate in a worktree"
 * flow so Convoy runs against a clean checkout on a new branch.
 */
/**
 * Whether `<name>` is already a local branch. Used before `git worktree add -b`
 * so a name collision is caught (and suffixed) while the user can still see it,
 * instead of failing the run after it has been confirmed.
 */
export async function branchExists(name: string, cwd: string): Promise<boolean> {
  if (!name) return false
  const result = await execFile("git", ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { cwd, allowFailure: true })
  return result.exitCode === 0
}

export async function addWorktree(dir: string, branch: string, baseRef: string, cwd: string) {
  // `--` terminates option parsing so a `dir`/`baseRef` starting with `-`
  // (e.g. a caller-supplied ref like `--detach`) can't be misread as a flag.
  await execFile("git", ["worktree", "add", "-b", branch, "--", dir, baseRef], { cwd })
}

export async function writeDiff(path: string, baseRef: string, cwd: string) {
  let diff = await execFile("git", ["diff", baseRef], { cwd, allowFailure: true })
  if (diff.exitCode !== 0) {
    log.warn(`couldn't diff against "${baseRef}"; falling back to "git diff HEAD" (likely empty right after a commit). Pass --base <ref> to fix the phase diffs.`)
    diff = await execFile("git", ["diff", "HEAD"], { cwd, allowFailure: true })
  }

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, diff.stdout)
}

/**
 * The file paths changed in the working-tree diff against `baseRef`. Used by
 * OpenSpec's compose rule (active-change selection when multiple changes exist
 * and no branch matches). Best-effort: a failed diff resolves to an empty list.
 */
export async function listChangedFiles(baseRef: string, cwd: string): Promise<string[]> {
  const names = await execFile("git", ["diff", "--name-only", baseRef], { cwd, allowFailure: true })
  if (names.exitCode !== 0) return []
  return names.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * Evidence about the exact staged change set, parsed from NUL-delimited
 * `git diff --cached --name-status -z` after `git add -A` (design D5). Renames
 * contribute their new path; a failed probe yields empty evidence so message
 * composition degrades to an honest fallback instead of blocking the commit.
 */
export type StagedChangeEvidence = {
  /** Staged paths, in name-status order (rename targets for R/C entries). */
  paths: string[]
  /** One status code per path (`A`, `M`, `D`, `R100`, …). */
  statuses: string[]
}

export async function stagedChangeEvidence(cwd: string): Promise<StagedChangeEvidence> {
  const nameStatus = await execFile("git", ["diff", "--cached", "--name-status", "-z"], { cwd, allowFailure: true })
  if (nameStatus.exitCode !== 0) return { paths: [], statuses: [] }
  return parseStagedEvidence(nameStatus.stdout)
}

/**
 * Parses `--name-status -z` output: NUL-separated records of `<status>` then
 * one path — two for renames/copies, where git emits the original path first
 * and the new path second (verified empirically). A trailing NUL yields an
 * empty field that terminates the loop.
 */
export function parseStagedEvidence(zOutput: string): StagedChangeEvidence {
  const fields = zOutput.split("\0")
  const paths: string[] = []
  const statuses: string[] = []
  for (let index = 0; index < fields.length; index++) {
    const status = fields[index]!
    if (!status) continue
    const first = fields[++index] ?? ""
    if (!first) continue
    if (/^[RC]/.test(status)) {
      const renamed = fields[++index] ?? ""
      if (!renamed) continue
      statuses.push(status)
      paths.push(renamed)
      continue
    }
    statuses.push(status)
    paths.push(first)
  }
  return { paths, statuses }
}

/**
 * The commit message: either a fixed string or an asynchronous factory invoked
 * only after staging and secret scanning, so it can describe the exact staged
 * change set (design D5) and never runs when there is nothing to commit.
 */
export type CommitMessageInput = string | ((evidence: StagedChangeEvidence) => Promise<string>)

export async function addAllAndCommit(message: CommitMessageInput, cwd: string) {
  await execFile("git", ["add", "-A"], { cwd })

  const status = await execFile("git", statusArgs, { cwd })
  if (status.stdout.trim() === "") {
    return false
  }

  const suspicious = findSuspiciousStagedFiles(status.stdout)
  if (suspicious.length > 0) {
    await execFile("git", ["reset"], { cwd })
    throw new Error(
      `refusing to commit files that look like secrets: ${suspicious.join(", ")}. ` +
        `Add them to .gitignore (or remove them) and re-run.`,
    )
  }

  const resolved = typeof message === "function" ? await message(await stagedChangeEvidence(cwd)) : message
  await execFile("git", [...commitArgs, "-m", resolved], {
    cwd,
    env: convoyGitEnv,
  })
  return true
}

const convoyGitEnv = {
  GIT_AUTHOR_NAME: "convoy",
  GIT_AUTHOR_EMAIL: "convoy@local",
  GIT_COMMITTER_NAME: "convoy",
  GIT_COMMITTER_EMAIL: "convoy@local",
}

/** The identity every convoy step commit carries; automatic run compaction verifies its own commits by it. */
export const convoyAuthorEmail = convoyGitEnv.GIT_AUTHOR_EMAIL

/**
 * Runs git with the terminal attached, for the few commands that legitimately
 * talk to the user: signing (1Password/gpg-agent), commit hooks, an editor,
 * push credentials. Nothing is captured, so git's own output is the error
 * report; callers driving a TUI must suspend it first.
 */
async function execFileInherited(args: string[], cwd: string): Promise<number> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env })
  return await proc.exited
}

export type CommitAsUserOptions = {
  /** Forces `-S` for users who sign deliberately rather than via `commit.gpgsign`. */
  sign?: boolean
  /** Opens the user's editor on the message before committing. */
  edit?: boolean
  /** Skips pre-commit/commit-msg hooks, which already ran on every step commit being replaced. */
  noVerify?: boolean
}

/**
 * Commits whatever is already staged **as the user**: no convoyGitEnv, no
 * `--no-gpg-sign`, and deliberately no `git add -A`. This is the one commit
 * convoy makes on the user's behalf (automatic compaction, close's squash-merge), so it must inherit their
 * whole git config — user.name, commit.gpgsign, gpg.format, hooks — and land in
 * history signed and attributed exactly like a hand-written commit.
 *
 * Throws on a non-zero exit (signature declined, hook rejection, empty editor):
 * the caller is mid-rewrite and has to restore the branch.
 */
export async function commitAsUser(message: string, cwd: string, options: CommitAsUserOptions = {}) {
  const args = ["commit", "-m", message]
  if (options.sign) args.push("-S")
  if (options.edit) args.push("--edit")
  if (options.noVerify) args.push("--no-verify")

  const exitCode = await execFileInherited(args, cwd)
  if (exitCode !== 0) throw new Error(`git commit exited with code ${exitCode}; the commit was not created`)
}

/** Pushes `<branch>` and sets its upstream, with the terminal attached for credential prompts. */
export async function pushBranch(branch: string, remote: string, cwd: string) {
  const exitCode = await execFileInherited(["push", "-u", remote, branch], cwd)
  if (exitCode !== 0) throw new Error(`git push exited with code ${exitCode}`)
}

/**
 * Pushes an explicit refspec (`<local>:<remote>`) without touching upstream
 * config — the shape close uses for the base branch, whose remote mapping is
 * resolved from its configured upstream rather than guessed.
 */
export async function pushRefspec(remote: string, refspec: string, cwd: string) {
  const exitCode = await execFileInherited(["push", remote, refspec], cwd)
  if (exitCode !== 0) throw new Error(`git push exited with code ${exitCode}`)
}

export async function removeWorktree(dir: string, cwd: string, force = false) {
  await execFile("git", ["worktree", "remove", ...(force ? ["--force"] : []), "--", dir], { cwd })
}

/**
 * The checkout of `<branch>` among the repo's worktrees, or undefined when no
 * worktree has that branch checked out. With configurable worktree locations
 * the branch name alone can't reconstruct a path, so `git worktree list` is the
 * source of truth for lookups (`convoy close --branch`).
 */
export async function findWorktreeDirForBranch(branch: string, cwd: string): Promise<string | undefined> {
  const result = await execFile("git", ["worktree", "list", "--porcelain"], { cwd, allowFailure: true })
  if (result.exitCode !== 0) return undefined
  let dir: string | undefined
  let current: string | undefined
  const flush = () => {
    if (current === branch && dir) return dir
    dir = undefined
    current = undefined
    return undefined
  }
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) dir = line.slice("worktree ".length)
    else if (line.startsWith("branch ")) current = line.slice("branch refs/heads/".length)
    else if (line === "") {
      const found = flush()
      if (found) return found
    }
  }
  return flush()
}

/** The checked-out branch, or undefined when HEAD is detached. */
export async function currentBranch(cwd: string): Promise<string | undefined> {
  const result = await execFile("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, allowFailure: true })
  if (result.exitCode !== 0) return undefined
  return result.stdout.trim() || undefined
}

export type WorktreeDefault = {
  isolate: boolean
  /** Short human-readable justification, shown next to the launcher's toggle so the default never looks arbitrary. */
  reason: string
}

/**
 * Whether a run should isolate itself in a fresh worktree when nothing said
 * otherwise: you're on the trunk, so committing here is probably not what you
 * meant. Already on a branch, the branch is almost certainly where you want the
 * work to land.
 *
 * Two criteria, unioned. `detectBaseRef` is the repo-accurate one but answers
 * for a single base, so a repo whose origin/HEAD is `main` would not recognize
 * `develop`; the conventional names cover that. Never throws — anything
 * unexpected falls back to isolating, which is the older, safer behavior.
 */
export async function resolveWorktreeDefault(cwd: string): Promise<WorktreeDefault> {
  try {
    // Covers both a detached HEAD and "not a repo at all"; the latter fails in
    // ensureRepoReady moments later with a message that actually explains it.
    const branch = await currentBranch(cwd)
    if (!branch) return { isolate: true, reason: "no branch is checked out" }

    if (baseBranchNames.includes(branch as (typeof baseBranchNames)[number])) {
      return { isolate: true, reason: `${branch} is a base branch` }
    }

    const detected = await detectBaseRef(cwd)
    // detectBaseRef can answer with the remote-tracking form when no local
    // checkout of the default branch exists (see the origin/HEAD path above).
    if (detected && (detected.ref === branch || detected.ref === `origin/${branch}`)) {
      return { isolate: true, reason: `${branch} is this repo's base branch` }
    }

    return { isolate: false, reason: `${branch} is not a base branch` }
  } catch {
    return { isolate: true, reason: "could not read the current branch" }
  }
}

/** Resolves `<ref>` to a commit sha, or undefined when it doesn't name one. */
export async function resolveCommit(ref: string, cwd: string): Promise<string | undefined> {
  const result = await execFile("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd, allowFailure: true })
  if (result.exitCode !== 0) return undefined
  return result.stdout.trim() || undefined
}

/** The best common ancestor of two refs, or undefined when their histories are unrelated. */
export async function mergeBase(refA: string, refB: string, cwd: string): Promise<string | undefined> {
  const result = await execFile("git", ["merge-base", refA, refB], { cwd, allowFailure: true })
  if (result.exitCode !== 0) return undefined
  return result.stdout.trim() || undefined
}

export type CommitInfo = {
  sha: string
  authorEmail: string
  subject: string
}

/**
 * Commits reachable from `head` but not from `base`, newest first; an empty
 * `base` walks the whole history. The unit separator keeps subjects containing
 * anything (including tabs) parseable.
 */
export async function commitsBetween(base: string, head: string, cwd: string): Promise<CommitInfo[]> {
  const range = base ? `${base}..${head}` : head
  const result = await execFile("git", ["log", "--format=%H%x1f%ae%x1f%s", range], { cwd, allowFailure: true })
  if (result.exitCode !== 0) return []
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", authorEmail = "", ...rest] = line.split("\x1f")
      return { sha, authorEmail, subject: rest.join("\x1f") }
    })
    .filter((commit) => commit.sha !== "")
}

/** Whether `ancestor` is reachable from `descendant`; false when either ref is missing. */
export async function isAncestor(ancestor: string, descendant: string, cwd: string): Promise<boolean> {
  const result = await execFile("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, allowFailure: true })
  return result.exitCode === 0
}

/** The upstream of the current branch (e.g. "origin/feat/x"), or undefined when it has none. */
export async function upstreamRef(cwd: string): Promise<string | undefined> {
  const result = await execFile("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd, allowFailure: true })
  if (result.exitCode !== 0) return undefined
  return result.stdout.trim() || undefined
}

/** The configured upstream of any branch (e.g. "origin/main"), or undefined when it has none. */
export async function branchUpstream(branch: string, cwd: string): Promise<string | undefined> {
  const result = await execFile("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`], { cwd, allowFailure: true })
  if (result.exitCode !== 0) return undefined
  return result.stdout.trim() || undefined
}

/** The remote branch tip a `git ls-remote` receipt observed, or why it could not be read. */
export type RemoteBranchTip =
  | { kind: "known"; tip?: string }
  | { kind: "unknown"; reason: string }

/**
 * The tip OID `remote` reports for `refs/heads/<ref>` through `git ls-remote`
 * — a read-only receipt, never a fetch. A query that could not run is
 * `unknown` (distinct from a known-but-absent branch), so callers never read
 * an unreadable remote as "nothing pushed".
 */
export async function remoteBranchTip(remote: string, ref: string, cwd: string): Promise<RemoteBranchTip> {
  const result = await execFile("git", ["ls-remote", "--", remote, `refs/heads/${ref}`], { cwd, allowFailure: true })
  if (result.exitCode !== 0) return { kind: "unknown", reason: (result.stderr || result.stdout).trim().slice(0, 200) }
  const tip = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)[0]?.split(/\s+/)[0]
  return { kind: "known", ...(tip ? { tip } : {}) }
}

export async function diffStat(base: string, head: string, cwd: string): Promise<string> {
  const result = await execFile("git", ["diff", "--stat", `${base}..${head}`], { cwd, allowFailure: true })
  return result.exitCode === 0 ? result.stdout : ""
}

/** Points `<ref>` at `<sha>`. Used to stash a pre-rewrite HEAD under refs/convoy/. */
export async function updateRef(ref: string, sha: string, cwd: string) {
  await execFile("git", ["update-ref", ref, sha], { cwd })
}

/** Moves the branch to `<sha>` keeping index and working tree, so the tree survives a squash. */
export async function resetSoft(sha: string, cwd: string) {
  await execFile("git", ["reset", "--soft", sha], { cwd })
}

/** The repo the worktree at `cwd` belongs to (its main checkout), for worktree bookkeeping. */
export async function mainWorktreeDir(cwd: string): Promise<string | undefined> {
  const result = await execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, allowFailure: true })
  if (result.exitCode !== 0) return undefined
  const gitDir = result.stdout.trim()
  if (!gitDir.endsWith("/.git")) return undefined
  return gitDir.slice(0, -"/.git".length)
}

const secretPatterns: RegExp[] = [
  /(^|\/)\.env(\..+)?$/i,
  /(^|\/)\.envrc$/i,
  /(^|\/)secrets?\.(json|yaml|yml|toml|ini|env|txt)$/i,
  /(^|\/)credentials?(\..+)?$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.keystore$/i,
  /\.jks$/i,
  /\.mobileprovision$/i,
  /\.gpg$/i,
  /(^|\/)service[-_]account\.json$/i,
  /(^|\/)gcloud[-_]key\.json$/i,
  /(^|\/)aws[-_]credentials$/i,
]

export function findSuspiciousStagedFiles(porcelain: string): string[] {
  const out: string[] = []
  for (const raw of porcelain.split("\n")) {
    if (!raw) continue
    const code = raw.slice(0, 2)
    if (!/[AMRCT?]/.test(code[0] ?? "") && !/[AMT?]/.test(code[1] ?? "")) continue
    const rest = raw.slice(3)
    const path = rest.includes(" -> ") ? rest.split(" -> ").pop()! : rest
    const clean = unquotePorcelainPath(path)
    if (secretPatterns.some((pattern) => pattern.test(clean))) out.push(clean)
  }
  return out
}

// git C-quotes paths with spaces or non-ASCII bytes; the secret patterns must
// match the decoded name, not the escaped one ("\303\251" would never match).
function unquotePorcelainPath(path: string) {
  if (!(path.startsWith('"') && path.endsWith('"'))) return path
  const escapes: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", '"': '"' }
  return path.slice(1, -1).replace(/\\(?:([abfnrtv\\"])|([0-7]{1,3}))/g, (_, esc: string | undefined, octal: string | undefined) => {
    if (octal) return String.fromCharCode(parseInt(octal, 8))
    return escapes[esc ?? ""] ?? (esc ?? "")
  })
}

/**
 * Physical form of a path: the `realpath` when it resolves, the resolved
 * absolute path otherwise (the path may not exist yet). Shared by the
 * worktree inventory/target/observation layers so path comparison has one
 * implementation (change `worktree-control-center`, task 1.4 consolidation).
 */
export async function realpathSafe(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

/**
 * The tree OID of a ref, or undefined when the ref does not resolve to a
 * commit. Shared by the observation layer and close's candidate verification.
 */
export async function treeOf(ref: string, cwd: string): Promise<string | undefined> {
  const result = await execFile("git", ["rev-parse", "--verify", "--quiet", `${ref}^{tree}`], { cwd, allowFailure: true })
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined
}

async function requireRepoRoot(cwd: string) {
  const rootResult = await execFile("git", ["rev-parse", "--show-toplevel"], { cwd, allowFailure: true })
  if (rootResult.exitCode !== 0) {
    throw new Error("convoy must be run at the root of a git repo")
  }
  await assertRepoRoot(cwd, rootResult.stdout.trim())
}

async function assertRepoRoot(cwd: string, rootPath: string) {
  // git reports the physical path; resolve symlinks on our side too so a
  // symlinked --dir (e.g. /tmp on macOS) doesn't false-positive.
  const root = await realpathSafe(rootPath)
  if (root !== (await realpathSafe(cwd))) {
    throw new Error(`convoy must be run at the root of the git repo (${root})`)
  }
}

function isSafeInitialBranch(value: string) {
  return value !== "HEAD" && !value.startsWith("-") && !/[~^:?*[\\\s]/.test(value) && !value.includes("..")
}
