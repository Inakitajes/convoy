import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { SpecsResolution } from "../src/specs"

// The routing halves in cli.ts's openSpecsBrowser are thin, but tasks 1.2/1.4
// call for asserting the handoffs directly: apply-change must pass the preset
// change into launchRunTui, iterate-change must open the standalone session
// rooted at the resolved work context, and a feature-owned handoff must carry
// the feature's verified checkout. bun runs every test file's top-level code
// before any tests execute, so mock.module here is visible process-wide; each
// mock therefore DELEGATES to the real module unless this file's tests have
// raised `capturing`, keeping sibling files (opencode.test.ts, specs.test.ts,
// launch-tui.test.ts) on real behavior.
//
// The browser reopens after an action so a returning selection is restored
// (task 1.4): each test queues the action resolution followed by an exit, and
// the mock serves the queue in order.

const actualSpecs = await import("../src/specs")
const actualLaunchTui = await import("../src/launch-tui")
const actualOpencode = await import("../src/opencode")
const actualNotice = await import("../src/notice-tui")

// Snapshot the real functions BEFORE mock.module: bun patches the module
// record in place, so the namespace objects above reflect the mock once
// registered and would recurse if consulted through them.
const realBrowseSpecs = actualSpecs.browseSpecs
const realLoadSpecsView = actualSpecs.loadSpecsView
const realLaunchRunTui = actualLaunchTui.launchRunTui
const realOpenIterateWindow = actualOpencode.openIterateOpencodeWindow
const realShowNotice = actualNotice.showNoticeTui

let capturing = false
let resolutions: SpecsResolution[] = [{ type: "exit" }]
const launchCalls: Record<string, unknown>[] = []
const iterateCalls: Record<string, unknown>[] = []
const noticeCalls: Record<string, unknown>[] = []

mock.module("../src/specs", () => ({
  ...actualSpecs,
  browseSpecs: async (targetDir: string) => {
    if (!capturing) return realBrowseSpecs(targetDir)
    return resolutions.length > 1 ? resolutions.shift()! : resolutions[0]!
  },
}))

mock.module("../src/launch-tui", () => ({
  ...actualLaunchTui,
  launchRunTui: async (options: Record<string, unknown>) => {
    if (!capturing) return realLaunchRunTui(options as never)
    launchCalls.push(options)
    return undefined
  },
}))

mock.module("../src/opencode", () => ({
  ...actualOpencode,
  openIterateOpencodeWindow: async (input: Record<string, unknown>) => {
    if (!capturing) return realOpenIterateWindow(input as never)
    iterateCalls.push(input)
    return undefined
  },
}))

mock.module("../src/notice-tui", () => ({
  ...actualNotice,
  showNoticeTui: async (route: unknown, options: Record<string, unknown>) => {
    if (!capturing) return realShowNotice(route as never, options as never)
    noticeCalls.push(options)
    return undefined
  },
}))

const { openSpecsBrowser } = await import("../src/cli")

let root: string

beforeEach(async () => {
  capturing = true
  launchCalls.length = 0
  iterateCalls.length = 0
  noticeCalls.length = 0
  resolutions = [{ type: "exit" }]
  root = await makeChangeRepo()
})

afterEach(async () => {
  capturing = false
  await rm(root, { recursive: true, force: true })
})

async function makeChangeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-specs-routing-"))
  const change = join(dir, "openspec", "changes", "add-login")
  await mkdir(join(change, "specs", "cli"), { recursive: true })
  await writeFile(join(change, "proposal.md"), "---\n---\n# Add Login\n\nwhy\n")
  await writeFile(join(change, "design.md"), "# Design\n\napproach\n")
  await writeFile(join(change, "tasks.md"), "# Tasks\n\n- [ ] do it\n")
  await writeFile(join(change, "specs", "cli", "spec.md"), "## ADDED Requirements\n")
  return dir
}

/** Queues one action resolution; the browser reopens once more and exits. */
function action(resolution: SpecsResolution) {
  resolutions = [resolution, { type: "exit" }]
}

describe("openSpecsBrowser routing (specs viewer handoffs)", () => {
  test("the loaded view carries the normalized target directory", async () => {
    const view = await realLoadSpecsView(join(root, "."))
    expect(view.targetDir).toBe(root)
  })

  test("apply-change hands the change id to the launcher as the preset", async () => {
    action({ type: "apply-change", changeID: "add-login" })
    await openSpecsBrowser(root)
    expect(launchCalls).toHaveLength(1)
    expect(launchCalls[0]?.targetDir).toBe(root)
    expect(launchCalls[0]?.presetChange).toBe("add-login")
    expect(typeof launchCalls[0]?.prepareRun).toBe("function")
    expect(iterateCalls).toHaveLength(0)
  })

  test("iterate-change opens the standalone session rooted at the repo dir with the change's files", async () => {
    action({ type: "iterate-change", changeID: "add-login" })
    await openSpecsBrowser(root)
    expect(iterateCalls).toHaveLength(1)
    const input = iterateCalls[0] as { targetDir: string; runDir: string; prompt: string }
    // Repo-rooted on purpose: the session reads surrounding code and specs.
    expect(input.targetDir).toBe(root)
    expect(input.runDir).toBe(root)
    for (const file of [
      join("openspec", "changes", "add-login", "proposal.md"),
      join("openspec", "changes", "add-login", "design.md"),
      join("openspec", "changes", "add-login", "tasks.md"),
      join("openspec", "changes", "add-login", "specs", "cli", "spec.md"),
    ]) {
      expect(input.prompt).toContain(file)
    }
    expect(launchCalls).toHaveLength(0) // no launcher was involved
  })

  test("exit ends quietly without touching the launcher or the session opener", async () => {
    resolutions = [{ type: "exit" }]
    await openSpecsBrowser(root)
    expect(launchCalls).toHaveLength(0)
    expect(iterateCalls).toHaveLength(0)
  })

  test("an action resolution returns to the browser once before exiting (task 1.4)", async () => {
    // Two apply-change rounds then exit: the mock's queue proves the browser
    // reopened after the (cancelled) launcher instead of ending the session.
    resolutions = [
      { type: "apply-change", changeID: "add-login" },
      { type: "apply-change", changeID: "add-login" },
      { type: "exit" },
    ]
    await openSpecsBrowser(root)
    expect(launchCalls).toHaveLength(2)
  })
})

describe("openSpecsBrowser feature routing (work-context handoffs, tasks 1.2/1.4)", () => {
  test("a feature-owned apply launches in the feature's verified worktree with its identity", async () => {
    const { main, worktreeDir, branch, featureId } = await makeFeatureRepo("routing-apply")
    try {
      capturing = true
      action({ type: "apply-change", changeID: "add-widget", featureId })
      await openSpecsBrowser(main)
      expect(launchCalls).toHaveLength(1)
      const options = launchCalls[0] as Record<string, any>
      // The launcher keeps running in the launch checkout; the preset carries
      // the feature's verified checkout, which resource loading and
      // preparation resolve against (design D1: no chdir).
      expect(options.targetDir).toBe(main)
      expect(options.presetChange).toBe("add-widget")
      expect(options.presetFeature.worktreeDir).toBe(await realpath(worktreeDir))
      expect(options.presetFeature.branch).toBe(branch)
      expect(options.presetFeature.featureId).toBe(featureId)
      expect(options.presetFeature.baseRef).toBe("main")
      expect(options.presetFeature.associationRevision).toBe(1)
      expect(options.presetFeature.contracts).toEqual(["add-widget"])
    } finally {
      await rm(main, { recursive: true, force: true })
    }
  })

  test("a feature-owned iterate opens the session at the verified worktree", async () => {
    const { main, worktreeDir, featureId } = await makeFeatureRepo("routing-iterate")
    try {
      capturing = true
      action({ type: "iterate-change", changeID: "add-widget", featureId })
      await openSpecsBrowser(main)
      expect(iterateCalls).toHaveLength(1)
      const input = iterateCalls[0] as { targetDir: string; runDir: string; prompt: string }
      expect(input.targetDir).toBe(await realpath(worktreeDir))
      expect(input.runDir).toBe(await realpath(worktreeDir))
      expect(input.prompt).toContain(join(worktreeDir, "openspec", "changes", "add-widget", "proposal.md"))
      expect(launchCalls).toHaveLength(0)
    } finally {
      await rm(main, { recursive: true, force: true })
    }
  })

  test("an unavailable feature association reports the blocker and launches nothing", async () => {
    const { main, featureId } = await makeFeatureRepo("routing-ghost", { context: { branch: "feat/never-checked-out" } })
    try {
      capturing = true
      action({ type: "apply-change", changeID: "add-widget", featureId })
      await openSpecsBrowser(main, {} as never)
      expect(launchCalls).toHaveLength(0)
      expect(iterateCalls).toHaveLength(0)
      expect(noticeCalls).toHaveLength(1)
      const notice = noticeCalls[0] as { title: string; message: string }
      expect(notice.title).toContain("unavailable")
      // The recorded branch is checked out nowhere — the refusal says so.
      expect(notice.message).toContain("feat/never-checked-out")
    } finally {
      await rm(main, { recursive: true, force: true })
    }
  })

  test("a continue handoff re-resolves its destination through identity before launching", async () => {
    const { main, worktreeDir, branch, featureId } = await makeFeatureRepo("routing-continue")
    try {
      capturing = true
      action({ type: "continue-change", changeID: "add-widget", featureId, worktreeDir: "/stale/row-path", branch: "feat/stale" })
      await openSpecsBrowser(main)
      expect(launchCalls).toHaveLength(1)
      const options = launchCalls[0] as Record<string, any>
      // The stale row path never reaches the launcher: the validated context
      // supplies the actual checkout and branch (task 1.4).
      expect(options.presetFeature.worktreeDir).toBe(await realpath(worktreeDir))
      expect(options.presetFeature.branch).toBe(branch)
      expect(options.presetFeature.featureId).toBe(featureId)
    } finally {
      await rm(main, { recursive: true, force: true })
    }
  })
})

/** A repo whose worktree carries the change and a registered feature association. */
async function makeFeatureRepo(
  label: string,
  overrides: { context?: { branch: string } } = {},
): Promise<{ main: string; worktreeDir: string; branch: string; featureId: string }> {
  const rootDir = await mkdtemp(join(tmpdir(), `convoy-specs-feature-${label}-`))
  const main = join(rootDir, "main")
  const worktreeDir = join(rootDir, "wt")
  await mkdir(main, { recursive: true })
  await git(main, ["init", "-q", "-b", "main"])
  await writeFile(join(main, "README.md"), "# repo\n")
  await git(main, ["add", "."])
  await git(main, ["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-q", "-m", "init"])
  await git(main, ["worktree", "add", "-q", "-b", "feat/add-widget", worktreeDir])
  const change = join(worktreeDir, "openspec", "changes", "add-widget")
  await mkdir(join(change, "specs", "cli"), { recursive: true })
  await writeFile(join(change, "proposal.md"), "# Add widget\n")
  await writeFile(join(change, "tasks.md"), "- [ ] do it\n")
  await writeFile(join(change, "specs", "cli", "spec.md"), "## ADDED Requirements\n")

  const { execFile } = await import("../src/git")
  const { lifecycleCommonDir, ensureRepositoryRecord, isFound } = await import("../src/feature-lifecycle/store")
  const { writeFeatureRecord } = await import("../src/feature-lifecycle/records")
  const commonDir = (await lifecycleCommonDir(main))!
  const repoRecord = await ensureRepositoryRecord(commonDir)
  if (!isFound(repoRecord)) throw new Error("no repository record")
  const featureId = "bbbbbbbb-0000-4000-8000-00000000abc2"
  await writeFeatureRecord(
    commonDir,
    {
      schemaVersion: 1,
      featureId,
      repositoryId: repoRecord.value.repositoryId,
      displayName: "add-widget",
      associationRevision: 1,
      contracts: [{ changeId: "add-widget", kind: "active", sourcePath: "openspec/changes/add-widget", provenance: "adopt", selectedAtRevision: 1 }],
      intendedBaseRef: "main",
      context: overrides.context ?? { branch: "feat/add-widget", checkoutPath: worktreeDir },
      runIds: [],
      closeAttemptIds: [],
      history: [],
      createdAt: 1,
      updatedAt: 1,
    },
    0,
  )
  return { main, worktreeDir, branch: "feat/add-widget", featureId }
}

async function git(cwd: string, args: string[]): Promise<void> {
  const { execFile } = await import("../src/git")
  const result = await execFile("git", args, { cwd, allowFailure: true })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
}
