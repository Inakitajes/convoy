import { describe, expect, test } from "bun:test"

import { LaunchPicker, detectInsideWorktree, loadLauncherResources } from "../src/launch-tui"
import { buildRunPlan } from "../src/run-plan"
import { createTestRenderer } from "@opentui/core/testing"
import { execFile as nodeExecFile } from "node:child_process"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterAll } from "bun:test"

const exec = promisify(nodeExecFile)
const dirs: string[] = []

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd })
  return stdout.trim()
}

/** A repo with main plus one feature worktree, like the board's rows join them. */
async function makeRepoWithWorktree(): Promise<{ mainDir: string; worktreeDir: string }> {
  const mainDir = await mkdtemp(join(tmpdir(), "convoy-launch-wt-"))
  dirs.push(mainDir)
  await git(mainDir, "init", "-b", "main")
  await git(mainDir, "config", "user.email", "o@e.com")
  await git(mainDir, "config", "user.name", "O")
  await Bun.write(join(mainDir, "README.md"), "# repo\n")
  await git(mainDir, "add", ".")
  await git(mainDir, "commit", "-m", "chore: init")
  const worktreeDir = join(mainDir, "wt")
  await git(mainDir, "worktree", "add", "-b", "feat/add-foo", worktreeDir)
  return { mainDir: await realpath(mainDir), worktreeDir: await realpath(worktreeDir) }
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

type PickerView = {
  toggleState: { worktree: boolean; [key: string]: unknown }
  selectedChangeId?: string
  runSelection(pipelineName: string, initializeGit?: boolean): {
    targetDir: string
    isolateWorktree: boolean
    branchName?: string
    worktreeDir?: string
    change?: string
  }
  optionsDetail(width: number): { chunks: Array<{ text: string }> }
}

const feature = { changeID: "add-foo", worktreeDir: "/wt/feat-add-foo", branch: "feat/add-foo" }

function launcherChoices() {
  return [
    {
      name: "implement",
      description: "A test pipeline.",
      source: "built-in" as const,
      isDefault: true,
      steps: [],
      hooks: [],
      valid: true,
      advisedSteps: 0,
    },
  ]
}

async function createPicker(options: { presetFeature?: typeof feature; insideWorktree?: { dir: string; branch?: string }; isolateDefault?: boolean; dirtReader?: (dir: string) => Promise<string> }) {
  const testRenderer = await createTestRenderer({ width: 120, height: 40 })
  const picker = new LaunchPicker(
    testRenderer.renderer,
    "/repo",
    launcherChoices(),
    "configured",
    { isolate: options.isolateDefault ?? true, reason: "test" },
    {
      // Default to a clean tree so scripted readers are the only dirt source.
      readDirtyStatus: options.dirtReader ?? (async () => ""),
    } as never,
    { enabled: true, entries: [] },
    [{ id: feature.changeID, title: "Add foo" }],
    [],
    undefined,
    options.presetFeature,
    options.insideWorktree,
  )
  return { ...testRenderer, picker }
}

async function closePicker(session: Awaited<ReturnType<typeof createPicker>>) {
  session.mockInput.pressKey("c", { ctrl: true })
  await session.picker.result.catch(() => {})
}

describe("the launcher's feature-row continue handoff", () => {
  test("a preset feature disables new-worktree isolation even when the default is on", async () => {
    const session = await createPicker({ presetFeature: feature, isolateDefault: true })
    const view = session.picker as unknown as PickerView
    expect(view.toggleState.worktree).toBe(false)
    expect(view.selectedChangeId).toBe("add-foo")
    await closePicker(session)
  })

  test("the selection targets the existing worktree with its branch frozen, and no namer runs", async () => {
    const session = await createPicker({ presetFeature: feature })
    const view = session.picker as unknown as PickerView
    const selection = view.runSelection("implement")
    expect(selection.targetDir).toBe("/wt/feat-add-foo")
    expect(selection.isolateWorktree).toBe(false)
    expect(selection.branchName).toBe("feat/add-foo")
    expect(selection.worktreeDir).toBe("/wt/feat-add-foo")
    expect(selection.change).toBe("add-foo")
    await closePicker(session)
  })

  test("the frozen selection lands in the plan verbatim: the second run names the same branch and worktree", async () => {
    const { worktreeDir } = await makeRepoWithWorktree()
    const plan = buildRunPlan({
      prompt: { source: "inline", text: "continue add-foo" },
      targetDir: worktreeDir,
      baseRef: "main",
      worktree: false,
      dirty: false,
      branch: "feat/add-foo",
      worktreeDir,
      pipeline: { name: "implement", steps: [] } as never,
      hooks: { pre: [], post: [], pipelines: {} },
      files: [],
      permissions: "yolo",
    } as never)
    expect(plan.target.branch).toBe("feat/add-foo")
    expect(plan.target.worktreeDir).toBe(worktreeDir)
    expect(plan.target.worktree).toBe(false)
  })
})

describe("the nested-isolation warning", () => {
  test("enabling isolation inside a worktree names the fork point, informationally", async () => {
    const session = await createPicker({ insideWorktree: { dir: "/wt/feat-add-foo", branch: "feat/add-foo" } })
    const view = session.picker as unknown as PickerView
    view.toggleState.worktree = true
    const chunks = view.optionsDetail(120).chunks.map((chunk) => chunk.text).join("")
    expect(chunks).toContain("branch feat/add-foo of worktree /wt/feat-add-foo")
    expect(chunks).toContain("the new worktree forks from this branch")
    await closePicker(session)
  })

  test("no warning outside a worktree, and the default-off behavior is untouched", async () => {
    const session = await createPicker({ isolateDefault: false })
    const view = session.picker as unknown as PickerView
    expect(view.toggleState.worktree).toBe(false)
    view.toggleState.worktree = true
    const chunks = view.optionsDetail(120).chunks.map((chunk) => chunk.text).join("")
    expect(chunks).not.toContain("truly mean it")
    await closePicker(session)
  })
})

describe("detectInsideWorktree", () => {
  test("the main checkout is not inside a worktree; a linked worktree is", async () => {
    const { mainDir, worktreeDir } = await makeRepoWithWorktree()
    expect(await detectInsideWorktree(mainDir)).toBeUndefined()
    const inside = await detectInsideWorktree(worktreeDir)
    expect(inside?.dir).toBe(worktreeDir)
    expect(inside?.branch).toBe("feat/add-foo")
  })
})

describe("the continue handoff's dirty preflight", () => {
  test("dirt in the feature worktree drives the notice and the counted toggle, reading the worktree itself", async () => {
    const dirty = " M leftover.ts\n"
    const dirsRead: string[] = []
    const session = await createPicker({
      presetFeature: feature,
      dirtReader: async (dir) => {
        dirsRead.push(dir)
        return dirty
      },
    })
    try {
      const view = session.picker as unknown as PickerView & { mode: string; refreshDirt(): Promise<void> }
      view.mode = "options"
      await view.refreshDirt()
      await session.renderOnce()
      // The execution dir is the preset worktree (D1), not the launcher's cwd.
      expect(dirsRead).toEqual([feature.worktreeDir])
      const chunks = view.optionsDetail(120).chunks.map((chunk) => chunk.text).join("")
      expect(chunks).toContain("1 file uncommitted")
      expect(chunks).toContain("Include dirty tree (1 uncommitted)")
    } finally {
      await closePicker(session)
    }
  })

  test("a clean feature worktree stays quiet", async () => {
    const session = await createPicker({ presetFeature: feature })
    try {
      const view = session.picker as unknown as PickerView & { mode: string; refreshDirt(): Promise<void> }
      view.mode = "options"
      await view.refreshDirt()
      await session.renderOnce()
      expect(view.optionsDetail(120).chunks.map((chunk) => chunk.text).join("")).not.toContain("uncommitted")
    } finally {
      await closePicker(session)
    }
  })
})

describe("launcher resource loading (task 1.3: work-scoped preparation)", () => {
  test("a feature handoff loads config, history, and specs from the worktree, not the launch checkout", async () => {
    const { mainDir, worktreeDir } = await makeRepoWithWorktree()
    // Main and the worktree deliberately disagree: main forces isolation and
    // disables history; the worktree disables isolation and enables history,
    // and carries the only spec.
    await Bun.write(join(mainDir, ".convoy", "config.yaml"), "defaults:\n  worktree: true\n  prdHistory: false\n")
    await Bun.write(join(worktreeDir, ".convoy", "config.yaml"), "defaults:\n  worktree: false\n  prdHistory: true\n")
    const changeDir = join(worktreeDir, "openspec", "changes", "add-foo")
    await Bun.write(join(changeDir, "proposal.md"), "# Add foo\n")
    await Bun.write(join(mainDir, "unrelated-dirt.txt"), "dirty main, clean worktree\n")

    const fromFeature = await loadLauncherResources({
      targetDir: mainDir,
      presetFeature: { changeID: "add-foo", worktreeDir, branch: "feat/add-foo" },
      proposeBranchName: undefined as never,
      checkBranchName: undefined as never,
    } as never)

    // The worktree's configuration drives the launcher (differing main/worktree config).
    expect(fromFeature.config?.defaults.worktree).toBe(false)
    expect(fromFeature.config?.defaults.prdHistory).toBe(true)
    expect(fromFeature.history.enabled).toBe(true)
    // The spec that exists only in the worktree is visible; main's dirt is irrelevant.
    expect(fromFeature.specs.map((spec) => spec.id)).toContain("add-foo")
    // The nested-isolation probe still watches where the launcher itself runs
    // (main here), not the handoff's destination.
    expect(fromFeature.insideWorktree).toBeUndefined()
  })

  test("a plain launch keeps loading resources from the launch checkout", async () => {
    const { mainDir, worktreeDir } = await makeRepoWithWorktree()
    await Bun.write(join(mainDir, ".convoy", "config.yaml"), "defaults:\n  worktree: true\n")
    await Bun.write(join(worktreeDir, ".convoy", "config.yaml"), "defaults:\n  worktree: false\n")
    const changeDir = join(mainDir, "openspec", "changes", "on-main")
    await Bun.write(join(changeDir, "proposal.md"), "# On main\n")

    const standalone = await loadLauncherResources({
      targetDir: mainDir,
      proposeBranchName: undefined as never,
      checkBranchName: undefined as never,
    } as never)
    expect(standalone.config?.defaults.worktree).toBe(true)
    expect(standalone.specs.map((spec) => spec.id)).toContain("on-main")
    expect(standalone.insideWorktree).toBeUndefined()
  })
})
