import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { execFile } from "../../src/git"

/**
 * Disposable multi-worktree fixtures (change `worktree-control-center`,
 * task 1.1). Creates a real repository in a temp directory with the worktree
 * shapes the control-center inventory must enumerate — main, external branch
 * checkouts (including paths with spaces), detached checkouts, locked
 * checkouts, and stale registrations whose path was removed outside Git — so
 * parser and validation tests exercise Git's actual behavior instead of
 * canned output.
 */

export type FixtureWorktreeSpec = {
  /** Key the fixture reports the created path under. */
  name: string
  /** Create this branch and check it out (default: a branch named after `name`). */
  branch?: string
  /** Detached HEAD checkout instead of a branch. */
  detach?: boolean
  /** Lock the worktree with this reason after creating it. */
  lock?: string
  /** Remove the checkout directory after registering it (stale/prunable entry). */
  removeAfterCreate?: boolean
}

export type FixtureRepo = {
  /** Absolute path of the main checkout. */
  root: string
  /** Absolute paths of every created worktree, keyed by spec name. */
  worktrees: Record<string, string>
  /** Runs git in the main checkout and resolves the trimmed stdout. */
  git(args: string[]): Promise<string>
  /** Stages everything and commits in the given checkout (default: main). */
  commitAll(message: string, dir?: string): Promise<void>
  /** Writes a file (creating directories) inside a checkout. */
  write(dir: string, relativePath: string, contents: string): Promise<void>
  cleanup(): Promise<void>
}

let fixtureCounter = 0

export async function createFixtureRepo(options: { worktrees?: FixtureWorktreeSpec[] } = {}): Promise<FixtureRepo> {
  const parent = await mkdtemp(join(tmpdir(), `convoy-fixture-${process.pid}-`))
  fixtureCounter += 1
  const root = join(parent, `repo-${fixtureCounter}`)
  const worktrees: Record<string, string> = {}

  const git = async (args: string[]): Promise<string> => {
    const result = await execFile("git", args, { cwd: root })
    return result.stdout
  }

  const commitAll = async (message: string, dir: string = root) => {
    await execFile("git", ["add", "-A"], { cwd: dir, env: { GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@local", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@local" } })
    await execFile("git", ["commit", "-m", message, "--no-gpg-sign"], { cwd: dir, env: { GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@local", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@local" } })
  }

  const write = async (dir: string, relativePath: string, contents: string) => {
    const target = join(dir, relativePath)
    await mkdir(join(target, ".."), { recursive: true })
    await writeFile(target, contents)
  }

  await execFile("git", ["init", "-q", "-b", "main", root], { cwd: parent })
  await execFile("git", ["config", "user.email", "fixture@local"], { cwd: root })
  await execFile("git", ["config", "user.name", "fixture"], { cwd: root })
  await execFile("git", ["config", "commit.gpgsign", "false"], { cwd: root })
  await write(root, "README.md", "# fixture\n")
  await commitAll("initial commit")

  for (const spec of options.worktrees ?? []) {
    const branch = spec.detach ? undefined : (spec.branch ?? spec.name)
    const target = join(parent, spec.name)
    const args = ["worktree", "add"]
    if (spec.detach) args.push("--detach")
    else args.push("-b", branch!)
    args.push("--", target, "HEAD")
    await execFile("git", args, { cwd: root })
    worktrees[spec.name] = target
    if (spec.lock) await execFile("git", ["worktree", "lock", "--reason", spec.lock, "--", target], { cwd: root, allowFailure: true })
    if (spec.removeAfterCreate) await rm(target, { recursive: true, force: true })
  }

  const cleanup = async () => {
    // Best-effort: unregister whatever still exists so temp dirs don't leak
    // prunable registrations, then remove the whole fixture tree.
    await execFile("git", ["worktree", "prune"], { cwd: root, allowFailure: true })
    await rm(parent, { recursive: true, force: true })
  }

  return { root, worktrees, git, commitAll, write, cleanup }
}
