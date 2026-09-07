import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFile as nodeExecFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { loadLifecycleFeatureRows, loadSpecsView, printSpecsList } from "../src/specs"
import { featureAdopt, featureNewWork } from "../src/feature-lifecycle/commands"

/**
 * Tasks 6.1/6.3 (data + headless level): the specs view exposes registered
 * lifecycle features with their shared-assessment summaries alongside the
 * active changes, and the piped listing prints them with blockers — without
 * ever writing the registry.
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

describe("specs view lifecycle rows (tasks 6.1/6.3)", () => {
  test("registered features appear with assessment summaries; unregistered work stays unassociated", async () => {
    const main = await makeRepo()
    // Nothing registered yet: no feature rows.
    expect(await loadLifecycleFeatureRows(main)).toEqual([])

    const wt = join(main, "..", "wt")
    const { feature } = await featureAdopt({ cwd: main, branch: "feat/add-widget", changeIds: ["add-widget"], base: "main" })
    const rows = await loadLifecycleFeatureRows(main)
    expect(rows).toHaveLength(1)
    expect(rows![0]!.featureId).toBe(feature.featureId)
    expect(rows![0]!.displayName).toBe("add-widget")
    expect(rows![0]!.branch).toBe("feat/add-widget")
    // Complete tasks and a verified context: ready to close.
    expect(rows![0]!.summary).toBe("Ready to close")
    expect(rows![0]!.tasks).toEqual({ done: 2, total: 2 })
  })

  test("loadSpecsView includes lifecycle rows and the empty board still opens for features alone", async () => {
    const main = await makeRepo()
    await featureAdopt({ cwd: main, branch: "feat/add-widget", changeIds: ["add-widget"], base: "main" })
    const view = await loadSpecsView(main)
    expect(view.features).toHaveLength(1)
    expect(view.features![0]!.summary).toBe("Ready to close")
  })

  test("headless listing prints feature summaries and blockers without control sequences", async () => {
    const main = await makeRepo()
    await featureAdopt({ cwd: main, branch: "feat/add-widget", changeIds: ["add-widget"], base: "main" })
    const view = await loadSpecsView(main)
    const chunks: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      printSpecsList({ present: view.present, changes: view.changes, specs: view.specs, features: view.features, worktreesWithoutSpec: view.worktreesWithoutSpec })
    } finally {
      process.stdout.write = originalWrite
    }
    const output = chunks.join("")
    expect(output).toContain("features:")
    expect(output).toContain("add-widget")
    expect(output).toContain("Ready to close")
    expect(output).toContain("tasks 2/2")
    expect(output).not.toMatch(/\u001b\[/)
  })

  test("discovery and listing write no registry files (assert store untouched)", async () => {
    const main = await makeRepo()
    await featureAdopt({ cwd: main, branch: "feat/add-widget", changeIds: ["add-widget"], base: "main" })
    const { lifecycleCommonDir } = await import("../src/feature-lifecycle/store")
    const commonDir = (await lifecycleCommonDir(main))!
    const { readdir } = await import("node:fs/promises")
    const before = await readdir(join(commonDir, "convoy"), { recursive: true })
    await loadLifecycleFeatureRows(main)
    await loadSpecsView(main)
    const after = await readdir(join(commonDir, "convoy"), { recursive: true })
    expect(after.sort()).toEqual(before.sort())
  })

  test("a pre-proposal feature with no contracts stays in Features, not an unassociated worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "convoy-specs-lifecycle-prep-"))
    dirs.push(root)
    const main = join(root, "main")
    const wt = join(root, "wt")
    await mkdir(main, { recursive: true })
    await git(main, "init", "-b", "main")
    await writeFile(join(main, "README.md"), "# repo\n")
    await git(main, "add", ".")
    await git(main, "-c", "user.email=t@x", "-c", "user.name=T", "commit", "-m", "init")
    await git(main, "worktree", "add", "-b", "feat/pre-proposal", wt)

    // Created before any spec exists: an empty contract set and an
    // independent display name (work-context: "Work exists before a
    // specification").
    const feature = await featureNewWork({
      cwd: main,
      branch: "feat/pre-proposal",
      worktree: wt,
      changeIds: [],
      base: "main",
      displayName: "Widget redesign",
    })

    const rows = await loadLifecycleFeatureRows(main)
    expect(rows).toHaveLength(1)
    expect(rows![0]!.featureId).toBe(feature.featureId)
    expect(rows![0]!.displayName).toBe("Widget redesign")
    expect(rows![0]!.summary).toBe("Awaiting proposal")
    expect(rows![0]!.contracts).toEqual([])

    // The specs view keeps it under Features; it is never downgraded to the
    // unassociated-worktree section (it is registered, not specless).
    const view = await loadSpecsView(main)
    const featureRow = view.features?.find((row) => row.featureId === feature.featureId)
    expect(featureRow?.summary).toBe("Awaiting proposal")
    expect(view.worktreesWithoutSpec?.some((worktree) => worktree.dir === wt)).toBe(false)
  })

  test("the verified associated source supplies artifacts, even on an arbitrary branch with a launch-checkout husk (task 6.2)", async () => {
    const root = await mkdtemp(join(tmpdir(), "convoy-specs-lifecycle-62-"))
    dirs.push(root)
    const main = join(root, "main")
    const wt = join(root, "wt")
    await mkdir(main, { recursive: true })
    await git(main, "init", "-b", "main")
    await writeFile(join(main, "README.md"), "# repo\n")
    await git(main, "add", ".")
    await git(main, "-c", "user.email=t@x", "-c", "user.name=T", "commit", "-m", "init")
    await git(main, "worktree", "add", "-b", "team/alice/release-42", wt)
    // Full change in the worktree…
    const changeDir = join(wt, "openspec", "changes", "add-widget")
    await mkdir(changeDir, { recursive: true })
    await writeFile(join(changeDir, "proposal.md"), "# Add widget (real)\n")
    await writeFile(join(changeDir, "tasks.md"), "- [x] one\n")
    // …and only a husk in the launch checkout.
    await mkdir(join(main, "openspec", "changes", "add-widget"), { recursive: true })

    await featureAdopt({ cwd: main, branch: "team/alice/release-42", changeIds: ["add-widget"], base: "main" })
    const view = await loadSpecsView(main)
    const entry = view.changes.find((change) => change.id === "add-widget")
    expect(entry).toBeDefined()
    expect(entry!.title).toBe("Add widget (real)")
    // Artifacts are addressed absolutely, so they read from any cwd.
    const proposal = entry!.artifacts.find((artifact) => artifact.section === "proposal")
    expect(proposal?.file.startsWith("/")).toBe(true)
  })
})
