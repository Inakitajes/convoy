import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFile as nodeExecFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { dirtyOutsideOpenspec, printSpinHandoff, runSpin } from "../src/spin"

const exec = promisify(nodeExecFile)
const dirs: string[] = []
let commandsDir: string

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd })
  return stdout.trim()
}

/** A repo with one commit on `main` and no openspec state yet. */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-spin-"))
  dirs.push(dir)
  await git(dir, "init", "-b", "main")
  await git(dir, "config", "user.email", "operator@example.com")
  await git(dir, "config", "user.name", "Operator")
  await writeFile(join(dir, "README.md"), "# repo\n")
  await git(dir, "add", ".")
  await git(dir, "commit", "-m", "chore: init")
  return dir
}

const deltaFeat = "## ADDED Requirements\n### Requirement: It works\n"
const deltaFix = "## REMOVED Requirements\n### Requirement: Old thing\n"

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function proposeUncommittedChange(repo: string, id: string, delta = deltaFeat): Promise<void> {
  const changeDir = join(repo, "openspec", "changes", id)
  await mkdir(join(changeDir, "specs", "cli"), { recursive: true })
  await writeFile(join(changeDir, "proposal.md"), `# ${id}\n`)
  await writeFile(join(changeDir, "specs", "cli", "spec.md"), delta)
}

beforeAll(() => {
  // Empty: each test creates its own scratch env via freshEnv so CONVOY_HOME
  // (and the worktree root it decides) never collides across tests.
})

async function freshEnv(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "convoy-spin-home-"))
  commandsDir = await mkdtemp(join(tmpdir(), "convoy-spin-cmds-"))
  dirs.push(home, commandsDir)
  process.env.CONVOY_HOME = home
  process.env.CONVOY_OPENCODE_COMMANDS_DIR = commandsDir
}

afterAll(async () => {
  // Restore rather than delete: the preload sets CONVOY_HOME for the whole
  // process, and dropping it would expose the operator's real home to later
  // test files.
  delete process.env.CONVOY_OPENCODE_COMMANDS_DIR
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("spin", () => {
  test("happy path: worktree on the inferred branch, change moved, base clean", async () => {
    await freshEnv()
    const repo = await makeRepo()
    await proposeUncommittedChange(repo, "add-widget", deltaFeat)

    const result = await runSpin({ targetDir: repo })

    expect(result.branch).toBe("feat/add-widget")
    expect(result.committedOnBase).toBe(false)
    expect(result.movedFiles.length).toBeGreaterThan(0)
    // The worktree exists and carries the change untracked.
    expect((await stat(result.worktreeDir)).isDirectory()).toBe(true)
    await expect(readFile(join(result.worktreeDir, "openspec", "changes", "add-widget", "proposal.md"), "utf8")).resolves.toContain("add-widget")
    expect((await git(result.worktreeDir, "status", "--porcelain")).split("\n").every((line) => line.startsWith("?? openspec/"))).toBe(true)
    // The base checkout shows no trace of the change.
    const baseStatus = await git(repo, "status", "--porcelain")
    expect(baseStatus).not.toContain("add-widget")
    // …and no empty-directory residue either: git does not track empty dirs,
    // so the physical change tree must be gone, not just quiet.
    expect(await pathExists(join(repo, "openspec", "changes", "add-widget"))).toBe(false)
    expect(await pathExists(join(repo, "openspec", "changes", "add-widget", "specs"))).toBe(false)
    expect(await pathExists(join(repo, "openspec", "changes", "add-widget", "specs", "cli"))).toBe(false)
    // The branch exists in the repo and is checked out in the worktree.
    expect(await git(repo, "branch", "--list", "feat/add-widget")).toContain("feat/add-widget")
    expect(await git(result.worktreeDir, "branch", "--show-current")).toBe("feat/add-widget")
  })

  test("cleanup stops at the change root and preserves the parent OpenSpec tree", async () => {
    await freshEnv()
    const repo = await makeRepo()
    await proposeUncommittedChange(repo, "add-widget")

    await runSpin({ targetDir: repo })

    // The selected change root is fully removed…
    expect(await pathExists(join(repo, "openspec", "changes", "add-widget"))).toBe(false)
    // …but the bounded ancestor walk never rises into the parent OpenSpec
    // directories, which a recursive sweep outside the change tree would.
    expect(await pathExists(join(repo, "openspec", "changes"))).toBe(true)
    expect(await pathExists(join(repo, "openspec"))).toBe(true)
  })

  test("spin never installs the /convoy-spin command — that is `convoy opencode install`'s job", async () => {
    await freshEnv()
    const repo = await makeRepo()
    await proposeUncommittedChange(repo, "add-quiet")

    await runSpin({ targetDir: repo })

    expect(await readdir(commandsDir)).toEqual([])
  })

  test("prefix follows REMOVED-only deltas: fix/<id>", async () => {
    await freshEnv()
    const repo = await makeRepo()
    await proposeUncommittedChange(repo, "drop-legacy", deltaFix)

    const result = await runSpin({ targetDir: repo })
    expect(result.branch).toBe("fix/drop-legacy")
  })

  test("--prefix overrides the inference", async () => {
    await freshEnv()
    const repo = await makeRepo()
    await proposeUncommittedChange(repo, "add-widget")

    const result = await runSpin({ targetDir: repo, prefix: "chore" })
    expect(result.branch).toBe("chore/add-widget")
  })

  test("--change targets a specific change when several are uncommitted", async () => {
    await freshEnv()
    const repo = await makeRepo()
    await proposeUncommittedChange(repo, "add-one")
    await proposeUncommittedChange(repo, "add-two")

    const result = await runSpin({ targetDir: repo, changeID: "add-two" })
    expect(result.branch).toBe("feat/add-two")
    expect(result.changeID).toBe("add-two")
    // The selected change's emptied source directories are gone…
    expect(await pathExists(join(repo, "openspec", "changes", "add-two"))).toBe(false)
    // …and every other active change stays physically intact.
    expect(await pathExists(join(repo, "openspec", "changes", "add-one"))).toBe(true)
    await expect(readFile(join(repo, "openspec", "changes", "add-one", "proposal.md"), "utf8")).resolves.toContain("add-one")
  })

  test("retained content prevents directory deletion", async () => {
    await freshEnv()
    const repo = await makeRepo()
    // Ignored content is never moved, so the directory it lives in must survive.
    await writeFile(join(repo, ".gitignore"), "*.local\n")
    await git(repo, "add", ".gitignore")
    await git(repo, "commit", "-m", "chore: ignore local scratch files")
    await proposeUncommittedChange(repo, "add-widget")
    await writeFile(join(repo, "openspec", "changes", "add-widget", "specs", "cli", "scratch.local"), "keep me\n")

    const result = await runSpin({ targetDir: repo })
    expect(result.movedFiles).not.toContain("openspec/changes/add-widget/specs/cli/scratch.local")
    // The ignored file anchors its directory chain: nothing above it is removed.
    expect(await pathExists(join(repo, "openspec", "changes", "add-widget", "specs", "cli", "scratch.local"))).toBe(true)
    expect(await pathExists(join(repo, "openspec", "changes", "add-widget", "specs", "cli"))).toBe(true)
    expect(await pathExists(join(repo, "openspec", "changes", "add-widget", "specs"))).toBe(true)
    expect(await pathExists(join(repo, "openspec", "changes", "add-widget"))).toBe(true)
  })

  test("several uncommitted changes without --change list and stop", async () => {
    await freshEnv()
    const repo = await makeRepo()
    await proposeUncommittedChange(repo, "add-one")
    await proposeUncommittedChange(repo, "add-two")

    expect(runSpin({ targetDir: repo })).rejects.toThrow(/add-one[\s\S]*add-two|--change/)
  })

  test("dirty outside openspec/ refuses before creating anything", async () => {
    await freshEnv()
    const repo = await makeRepo()
    await proposeUncommittedChange(repo, "add-widget")
    await writeFile(join(repo, "README.md"), "# changed\n")

    await expect(runSpin({ targetDir: repo })).rejects.toThrow(/outside openspec/)
    // Nothing was created: no worktree home, no branches beyond main.
    const branches = await git(repo, "branch", "--list")
    expect(branches).not.toContain("feat/add-widget")
  })

  test("committed-on-base change: worktree created, nothing moved", async () => {
    await freshEnv()
    const repo = await makeRepo()
    await proposeUncommittedChange(repo, "already-in")
    await git(repo, "add", ".")
    await git(repo, "commit", "-m", "feat(openspec): add already-in change proposal")

    const result = await runSpin({ targetDir: repo })
    expect(result.branch).toBe("feat/already-in")
    expect(result.committedOnBase).toBe(true)
    expect(result.movedFiles).toHaveLength(0)
    // The committed change arrives via the base ref.
    await expect(readFile(join(result.worktreeDir, "openspec", "changes", "already-in", "proposal.md"), "utf8")).resolves.toContain("already-in")
    // Main's tree is untouched.
    expect(await git(repo, "status", "--porcelain")).toBe("")
  })

  test("unknown --change id refuses without creating a worktree", async () => {
    await freshEnv()
    const repo = await makeRepo()
    await proposeUncommittedChange(repo, "add-widget")

    await expect(runSpin({ targetDir: repo, changeID: "nope" })).rejects.toThrow(/nope/)
    expect(await git(repo, "branch", "--list")).not.toContain("feat")
  })

  test("spin registers no feature identity and its output advertises no retired feature command (CC-4)", async () => {
    await freshEnv()
    const repo = await makeRepo()
    await proposeUncommittedChange(repo, "add-widget")

    const chunks: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    let result: Awaited<ReturnType<typeof runSpin>> | undefined
    try {
      result = await runSpin({ targetDir: repo })
      printSpinHandoff(result)
    } finally {
      process.stdout.write = originalWrite
    }
    const output = chunks.join("")
    // No feature id in the result, no registration line, no retired command.
    expect(result).toBeDefined()
    expect(result! as Record<string, unknown>).not.toHaveProperty("featureId")
    expect(output).not.toContain("convoy feature")
    expect(output).not.toMatch(/registered/)
    // The lifecycle registry was never written: spin's success is Git state.
    const commonDir = (await git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir")).trim()
    const featureRecords = await readdir(join(commonDir, "convoy", "features").replace(/^\/private/, "/")).catch(() => [])
    expect(featureRecords).toEqual([])
  })

  test("handoff output names the worktree, the branch, and /move", async () => {
    const chunks: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      printSpinHandoff({
        changeID: "add-widget",
        branch: "feat/add-widget",
        worktreeDir: "/somewhere/wt",
        movedFiles: ["openspec/changes/add-widget/proposal.md"],
        committedOnBase: false,
        prefix: "feat",
      })
    } finally {
      process.stdout.write = originalWrite
    }
    const output = chunks.join("")
    expect(output).toContain("/somewhere/wt")
    expect(output).toContain("feat/add-widget")
    expect(output).toContain("/move")
    expect(output).toContain("moved 1 uncommitted file")
  })

  test("nothing-committed handoff reports the base ref carries the change", () => {
    const chunks: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      printSpinHandoff({
        changeID: "already-in",
        branch: "feat/already-in",
        worktreeDir: "/somewhere/wt",
        movedFiles: [],
        committedOnBase: true,
        prefix: "feat",
      })
    } finally {
      process.stdout.write = originalWrite
    }
    expect(chunks.join("")).toContain("nothing was moved")
  })
})

describe("dirtyOutsideOpenspec", () => {
  test("flags paths outside openspec/ and tolerates quoted paths", () => {
    const porcelain = [
      "?? openspec/changes/add-foo/proposal.md",
      '?? "weird dir/file.md"',
      " M src/cli.ts",
    ].join("\n")
    const flagged = dirtyOutsideOpenspec(porcelain)
    expect(flagged).toHaveLength(2)
    expect(flagged[0]).toContain("weird dir")
  })

  test("empty porcelain flags nothing", () => {
    expect(dirtyOutsideOpenspec("")).toEqual([])
  })
})
