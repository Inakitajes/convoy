import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { execFile as nodeExecFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { loadSpecsView, printSpecsList } from "../src/specs"

/**
 * The headless level (delta specs-viewer): the piped listing prints the
 * worktree inventory with each checkout's local changes and independent
 * observations — no feature rows, no lifecycle summaries, no registry reads
 * or writes.
 */

const exec = promisify(nodeExecFile)
const dirs: string[] = []

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd })
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "convoy-specs-lifecycle-"))
  dirs.push(root)
  const main = join(root, "main")
  const wt = join(root, "wt")
  await mkdir(main, { recursive: true })
  await git(main, "init", "-b", "main")
  await writeFile(join(main, "README.md"), "# repo\n")
  await git(main, "add", ".")
  await git(main, "-c", "user.email=t@x", "-c", "user.name=T", "commit", "-m", "init")
  await git(main, "worktree", "add", "-b", "feat/add-widget", wt)
  const changeDir = join(wt, "openspec", "changes", "add-widget")
  await mkdir(changeDir, { recursive: true })
  await writeFile(join(changeDir, "proposal.md"), "# Add widget\n")
  await writeFile(join(changeDir, "tasks.md"), "- [x] one\n- [x] two\n")
  return main
}

beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), "convoy-specs-lifecycle-home-"))
  dirs.push(home)
  process.env.CONVOY_HOME = home
})

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("specs view worktree rows (delta specs-viewer)", () => {
  test("the view lists every registered checkout with its own local changes", async () => {
    const main = await makeRepo()
    const view = await loadSpecsView(main)
    // Two root entries: main and the external worktree.
    expect(view.board.worktrees).toHaveLength(2)
    const wtPath = view.board.worktrees.find((worktree) => !worktree.main)!.path
    const local = view.changes.filter((change) => change.checkout === wtPath)
    expect(local.map((change) => change.id)).toEqual(["add-widget"])
    expect(local[0]!.title).toBe("Add widget")
    // No feature rows exist anywhere on the view.
    expect(view).not.toHaveProperty("features")
  })

  test("the piped listing prints worktrees, local changes, and observations without feature vocabulary", async () => {
    const main = await makeRepo()
    const view = await loadSpecsView(main)
    const writes: string[] = []
    const spy = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write)
    try {
      printSpecsList(view)
    } finally {
      spy.mockRestore()
    }
    const output = writes.join("")
    expect(output).toContain("worktrees:")
    expect(output).toContain("add-widget — Add widget")
    expect(output).toContain("canonical specs:")
    expect(output).not.toContain("\u001b")
    // No feature/lifecycle vocabulary in the plain listing.
    expect(output).not.toMatch(/features:/)
    expect(output).not.toMatch(/ready to close/i)
  })
})
