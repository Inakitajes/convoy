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

async function execFile(command: string, args: string[], options: ExecOptions): Promise<ExecResult> {
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

export async function ensureRepoReady(cwd: string, options: { includeDirty?: boolean; maxAttempts?: number; baseRef?: string; allowDirty?: boolean } = {}) {
  await requireRepoRoot(cwd)

  if (options.baseRef) {
    const base = await execFile("git", ["rev-parse", "--verify", "--quiet", `${options.baseRef}^{commit}`], { cwd, allowFailure: true })
    if (base.exitCode !== 0) {
      const head = await execFile("git", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd, allowFailure: true })
      if (head.exitCode !== 0) {
        throw new Error(`repository at ${cwd} has no commits yet; create an initial commit first`)
      }
      throw new Error(
        `base ref "${options.baseRef}" doesn't exist in this repo; pass a --base <ref> that exists (e.g. --base master), or drop --base / defaults.baseRef to let archer auto-detect the base branch`,
      )
    }
  }

  const status = await execFile("git", ["status", "--porcelain"], { cwd })
  if (status.stdout.trim() !== "") {
    // A resumed run defers the dirty-tree decision to the recovery step, which
    // can offer to commit an interrupted phase's leftover changes and continue.
    if (options.allowDirty) return
    if (!options.includeDirty) {
      throw dirtyTreeError(cwd, status.stdout)
    }
    if ((options.maxAttempts ?? 1) > 1) {
      throw new Error("--include-dirty can't be combined with --max-attempts > 1; use --max-attempts 1")
    }
    log.warn("working tree is not clean; --include-dirty will include those changes in the first commit of the pipeline")
  }
}

export type BaseRefDetection = {
  ref: string
  source: "origin-head" | "probe" | "current-branch"
}

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

  for (const name of ["main", "master", "develop", "trunk"]) {
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
  const porcelain = await execFile("git", ["status", "--porcelain"], { cwd })
  const suspicious = findSuspiciousStagedFiles(porcelain.stdout)
  if (suspicious.length > 0) {
    await execFile("git", ["reset"], { cwd })
    throw new Error(
      `refusing to create initial commit with files that look like secrets: ${suspicious.join(", ")}. ` +
        `Add them to .gitignore (or remove them) and re-run.`,
    )
  }

  const commitArgs = porcelain.stdout.trim() === "" ? ["commit", "--allow-empty", "-m", "archer: initial commit"] : ["commit", "-m", "archer: initial commit"]
  await execFile("git", commitArgs, { cwd, env: archerGitEnv })
}

export async function statusPorcelain(cwd: string): Promise<string> {
  const status = await execFile("git", ["status", "--porcelain"], { cwd })
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

export async function createCleanRepoSnapshot(cwd: string): Promise<RepoSnapshot | undefined> {
  const status = await execFile("git", ["status", "--porcelain"], { cwd })
  if (status.stdout.trim() !== "") return undefined

  const [head, ref] = await Promise.all([
    execFile("git", ["rev-parse", "HEAD"], { cwd }),
    execFile("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, allowFailure: true }),
  ])
  return { head: head.stdout.trim(), ...(ref.exitCode === 0 ? { ref: ref.stdout.trim() } : {}) }
}

export async function restoreRepoSnapshot(snapshot: RepoSnapshot, cwd: string) {
  await execFile("git", ["reset", "--hard"], { cwd })
  await execFile("git", ["clean", "-fd"], { cwd })
  await execFile("git", ["checkout", "--detach", snapshot.head], { cwd })
  if (snapshot.ref) await execFile("git", ["checkout", "-B", snapshot.ref, snapshot.head], { cwd })
  await execFile("git", ["reset", "--hard", snapshot.head], { cwd })
  await execFile("git", ["clean", "-fd"], { cwd })
}

export async function describeRepoSnapshotDifference(snapshot: RepoSnapshot, cwd: string): Promise<string | undefined> {
  const [status, head, ref] = await Promise.all([
    execFile("git", ["status", "--porcelain"], { cwd }),
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
 * flow so Archer runs against a clean checkout on a new branch.
 */
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

export async function addAllAndCommit(message: string, cwd: string) {
  await execFile("git", ["add", "-A"], { cwd })

  const status = await execFile("git", ["status", "--porcelain"], { cwd })
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

  await execFile("git", ["commit", "-m", message], {
    cwd,
    env: archerGitEnv,
  })
  return true
}

const archerGitEnv = {
  GIT_AUTHOR_NAME: "archer",
  GIT_AUTHOR_EMAIL: "archer@local",
  GIT_COMMITTER_NAME: "archer",
  GIT_COMMITTER_EMAIL: "archer@local",
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

async function realpathSafe(path: string) {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

async function requireRepoRoot(cwd: string) {
  const rootResult = await execFile("git", ["rev-parse", "--show-toplevel"], { cwd, allowFailure: true })
  if (rootResult.exitCode !== 0) {
    throw new Error("archer must be run at the root of a git repo")
  }
  await assertRepoRoot(cwd, rootResult.stdout.trim())
}

async function assertRepoRoot(cwd: string, rootPath: string) {
  // git reports the physical path; resolve symlinks on our side too so a
  // symlinked --dir (e.g. /tmp on macOS) doesn't false-positive.
  const root = await realpathSafe(rootPath)
  if (root !== (await realpathSafe(cwd))) {
    throw new Error(`archer must be run at the root of the git repo (${root})`)
  }
}

function isSafeInitialBranch(value: string) {
  return value !== "HEAD" && !value.startsWith("-") && !/[~^:?*[\\\s]/.test(value) && !value.includes("..")
}
