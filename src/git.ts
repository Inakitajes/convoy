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
}

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
  const rootResult = await execFile("git", ["rev-parse", "--show-toplevel"], { cwd, allowFailure: true })
  if (rootResult.exitCode !== 0) {
    throw new Error("archer must be run at the root of a git repo")
  }

  // git reports the physical path; resolve symlinks on our side too so a
  // symlinked --dir (e.g. /tmp on macOS) doesn't false-positive.
  const root = await realpathSafe(rootResult.stdout.trim())
  if (root !== (await realpathSafe(cwd))) {
    throw new Error(`archer must be run at the root of the git repo (${root})`)
  }

  if (options.baseRef) {
    const base = await execFile("git", ["rev-parse", "--verify", "--quiet", `${options.baseRef}^{commit}`], { cwd, allowFailure: true })
    if (base.exitCode !== 0) {
      throw new Error(`base ref "${options.baseRef}" doesn't exist in this repo; pass --base <ref> (e.g. --base master)`)
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

  const head = await execFile("git", ["rev-parse", "HEAD"], { cwd })
  return { head: head.stdout.trim() }
}

export async function restoreRepoSnapshot(snapshot: RepoSnapshot, cwd: string) {
  await execFile("git", ["reset", "--hard", snapshot.head], { cwd })
  await execFile("git", ["clean", "-fd"], { cwd })
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
    env: {
      GIT_AUTHOR_NAME: "archer",
      GIT_AUTHOR_EMAIL: "archer@local",
      GIT_COMMITTER_NAME: "archer",
      GIT_COMMITTER_EMAIL: "archer@local",
    },
  })
  return true
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
