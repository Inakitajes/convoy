import { mkdir, writeFile } from "node:fs/promises"
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

export async function ensureRepoReady(cwd: string, options: { includeDirty?: boolean; maxAttempts?: number } = {}) {
  const rootResult = await execFile("git", ["rev-parse", "--show-toplevel"], { cwd, allowFailure: true })
  if (rootResult.exitCode !== 0) {
    throw new Error("archer must be run at the root of a git repo")
  }

  const root = resolve(rootResult.stdout.trim())
  if (root !== resolve(cwd)) {
    throw new Error(`archer must be run at the root of the git repo (${root})`)
  }

  const status = await execFile("git", ["status", "--porcelain"], { cwd })
  if (status.stdout.trim() !== "") {
    if (!options.includeDirty) {
      throw new Error("working tree is not clean; do commit/stash or use --include-dirty to include those changes")
    }
    if ((options.maxAttempts ?? 1) > 1) {
      throw new Error("--include-dirty can't be combined with --max-attempts > 1; use --max-attempts 1")
    }
    log.warn("working tree is not clean; --include-dirty will include those changes in the first commit of the pipeline")
  }
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
