import { afterAll, describe, expect, test } from "bun:test"
import { execFile as nodeExecFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { printSpinHandoff, runSpin } from "../src/spin"
import { lifecycleCommonDir, readRepositoryRecord } from "../src/feature-lifecycle/store"
import { listFeatureIds } from "../src/feature-lifecycle/records"
import { listPendingOperations, readOperation } from "../src/operation-journal"

/**
 * Spin retirement (capability feature-spin delta, gap CC-4): successful spin
 * registers NO feature association — the created checkout appears through Git
 * inventory like any other worktree, the handoff advertises no retired
 * feature command, and a partial transfer keeps operation-scoped recovery
 * only (an unresolved `spin-transfer` journal), never a feature record.
 */

const exec = promisify(nodeExecFile)
const dirs: string[] = []

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd })
  return stdout.trim()
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-spin-register-"))
  dirs.push(dir)
  await git(dir, "init", "-b", "main")
  await git(dir, "config", "user.email", "operator@example.com")
  await git(dir, "config", "user.name", "Operator")
  await writeFile(join(dir, "README.md"), "# repo\n")
  await git(dir, "add", ".")
  await git(dir, "commit", "-m", "chore: init")
  return dir
}

async function proposeUncommittedChange(repo: string, id: string): Promise<void> {
  const changeDir = join(repo, "openspec", "changes", id)
  await mkdir(join(changeDir, "specs", "cli"), { recursive: true })
  await writeFile(join(changeDir, "proposal.md"), `# ${id}\n`)
  await writeFile(join(changeDir, "specs", "cli", "spec.md"), "## ADDED Requirements\n### Requirement: It works\n")
}

async function freshEnv(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "convoy-spin-reg-home-"))
  dirs.push(home)
  process.env.CONVOY_HOME = home
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("spin retirement (capability feature-spin delta)", () => {
  test("successful spin creates no feature record and the handoff names no feature", async () => {
    await freshEnv()
    const repo = await makeRepo()
    await proposeUncommittedChange(repo, "add-widget")

    const result = await runSpin({ targetDir: repo })
    expect(result).not.toHaveProperty("featureId")

    // The lifecycle registry was never written: no repository record, no
    // feature records — spin's success is Git state plus the transferred
    // files, nothing else.
    const commonDir = (await lifecycleCommonDir(repo))!
    expect((await readRepositoryRecord(commonDir)).status).toBe("missing")
    expect(await listFeatureIds(commonDir)).toEqual([])

    // The handoff output names the worktree, branch, and /move — and no
    // retired feature command.
    const chunks: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      printSpinHandoff(result)
    } finally {
      process.stdout.write = originalWrite
    }
    const output = chunks.join("")
    expect(output).toContain(result.worktreeDir)
    expect(output).toContain("/move")
    expect(output).not.toContain("convoy feature")
    expect(output).not.toMatch(/registered/)

    // The transfer journal was released on success: a resolved operation
    // leaves no recovery record behind.
    expect(await listPendingOperations(commonDir)).toEqual([])

    // Nothing was committed in the worktree (spin transfer unchanged).
    const status = await git(result.worktreeDir, "status", "--porcelain")
    expect(status).toContain("openspec/")
  })

  test("a refused spin persists nothing — no registry, no journal", async () => {
    await freshEnv()
    const repo = await makeRepo()
    await proposeUncommittedChange(repo, "one")
    await proposeUncommittedChange(repo, "two")
    try {
      await runSpin({ targetDir: repo })
      expect.unreachable("ambiguous changes must stop spin")
    } catch (error) {
      expect((error as Error).message).toMatch(/--change/)
    }
    const commonDir = (await lifecycleCommonDir(repo))!
    expect((await readRepositoryRecord(commonDir)).status).toBe("missing")
    expect(await listFeatureIds(commonDir)).toEqual([])
    expect(await listPendingOperations(commonDir)).toEqual([])
  })

  test("a spin whose change is committed elsewhere leaves an operation-scoped journal, not a feature record", async () => {
    await freshEnv()
    const repo = await makeRepo()
    // The change is committed on another branch: the transfer would move
    // nothing and the worktree's base ref would not carry it — spin refuses
    // after creating the worktree, and the pending transfer stays
    // recoverable through the operation journal.
    await proposeUncommittedChange(repo, "elsewhere")
    await git(repo, "checkout", "-b", "staging/elsewhere")
    await git(repo, "add", "-A")
    await git(repo, "commit", "-m", "feat: elsewhere")
    await git(repo, "checkout", "main")
    await git(repo, "branch", "-D", "staging/elsewhere")
    // The change id remains active on main only as an empty husk directory
    // (its files lived on the deleted branch): active by listing, uncommitted
    // nowhere, and absent from the base ref's tree.
    await mkdir(join(repo, "openspec", "changes", "elsewhere"), { recursive: true })

    try {
      await runSpin({ targetDir: repo, changeID: "elsewhere" })
      expect.unreachable("spin refuses a change its base ref does not carry")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toMatch(/not on the base ref/)
      expect(message).toMatch(/convoy worktrees recover --operation/)
      expect(message).not.toMatch(/convoy feature/)
    }
    const commonDir = (await lifecycleCommonDir(repo))!
    expect(await listFeatureIds(commonDir)).toEqual([])
    const pending = await listPendingOperations(commonDir)
    expect(pending).toHaveLength(1)
    const read = await readOperation(commonDir, pending[0]!)
    if (read.status !== "found") throw new Error("journal vanished")
    expect(read.value.kind).toBe("spin-transfer")
    // The created worktree is preserved for the operator.
    const intent = read.value.intent as { worktreeDir?: string }
    expect(intent.worktreeDir).toBeTruthy()
    await expect(readFile(join(intent.worktreeDir!, ".git"), "utf8")).resolves.toBeTruthy()
  })
})
