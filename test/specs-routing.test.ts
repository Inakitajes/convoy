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
const actualRemovalConfirm = await import("../src/removal-confirm-tui")

// Snapshot the real functions BEFORE mock.module: bun patches the module
// record in place, so the namespace objects above reflect the mock once
// registered and would recurse if consulted through them.
const realBrowseSpecs = actualSpecs.browseSpecs
const realLoadSpecsView = actualSpecs.loadSpecsView
const realLaunchRunTui = actualLaunchTui.launchRunTui
const realOpenIterateWindow = actualOpencode.openIterateOpencodeWindow
const realShowNotice = actualNotice.showNoticeTui
const realShowRemovalConfirm = actualRemovalConfirm.showRemovalConfirmTui

let capturing = false
let resolutions: SpecsResolution[] = [{ type: "exit" }]
let confirmResult: "confirm" | "cancel" = "confirm"
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

mock.module("../src/removal-confirm-tui", () => ({
  ...actualRemovalConfirm,
  showRemovalConfirmTui: async (route: unknown, options: Record<string, unknown>) => {
    if (!capturing) return realShowRemovalConfirm(route as never, options as never)
    return confirmResult
  },
}))

const { openSpecsBrowser, dispatchWorkAction } = await import("../src/cli")

let root: string

beforeEach(async () => {
  capturing = true
  launchCalls.length = 0
  iterateCalls.length = 0
  noticeCalls.length = 0
  resolutions = [{ type: "exit" }]
  confirmResult = "confirm"
  root = await makeChangeRepo()
})

afterEach(async () => {
  capturing = false
  await rm(root, { recursive: true, force: true })
})

async function makeChangeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-specs-routing-"))
  // A checkout is a Git checkout: the handoff validates the target before the
  // launcher opens, so the fixture is a real repository.
  const { execFile } = await import("../src/git")
  await execFile("git", ["init", "-q", "-b", "main"], { cwd: dir })
  await writeFile(join(dir, "README.md"), "# repo\n")
  await execFile("git", ["add", "."], { cwd: dir })
  await execFile("git", ["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-q", "-m", "init"], { cwd: dir })
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
    action({ type: "apply-change", changeID: "add-login", checkout: root })
    await openSpecsBrowser(root)
    expect(launchCalls).toHaveLength(1)
    expect(launchCalls[0]?.targetDir).toBe(root)
    expect(launchCalls[0]?.presetChanges).toEqual(["add-login"])
    expect(typeof launchCalls[0]?.prepareRun).toBe("function")
    expect(iterateCalls).toHaveLength(0)
  })

  test("iterate-change opens the standalone session rooted at the repo dir with the change's files", async () => {
    action({ type: "iterate-change", changeID: "add-login", checkout: root })
    await openSpecsBrowser(root)
    expect(iterateCalls).toHaveLength(1)
    const input = iterateCalls[0] as { targetDir: string; runDir: string; prompt: string }
    // Repo-rooted on purpose: the session reads surrounding code and specs.
    // The change's checkout is resolved physically (Git reports /private on macOS).
    expect(input.targetDir).toBe(await realpath(root))
    expect(input.runDir).toBe(await realpath(root))
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
      { type: "apply-change", changeID: "add-login", checkout: root },
      { type: "apply-change", changeID: "add-login", checkout: root },
      { type: "exit" },
    ]
    await openSpecsBrowser(root)
    expect(launchCalls).toHaveLength(2)
  })
})

describe("openSpecsBrowser checkout routing (work-context handoffs)", () => {
  test("an apply in another checkout launches with that checkout as the preset", async () => {
    const { main, worktreeDir, branch } = await makeWorktreeRepo("routing-apply")
    try {
      capturing = true
      action({ type: "apply-change", changeID: "add-widget", checkout: worktreeDir })
      await openSpecsBrowser(main)
      expect(launchCalls).toHaveLength(1)
      const options = launchCalls[0] as Record<string, any>
      // The launcher keeps running in the launch checkout; the preset carries
      // the change's own checkout, which resource loading and preparation
      // resolve against (design D1: no chdir, no launch-directory fallback).
      expect(options.targetDir).toBe(main)
      expect(options.presetChanges).toEqual(["add-widget"])
      expect(options.presetFeature.worktreeDir).toBe(await realpath(worktreeDir))
      expect(options.presetFeature.branch).toBe(branch)
    } finally {
      await rm(main, { recursive: true, force: true })
    }
  })

  test("a stale checkout reports the blocker and launches nothing", async () => {
    const { main } = await makeWorktreeRepo("routing-stale")
    try {
      capturing = true
      action({ type: "apply-change", changeID: "add-widget", checkout: "/no/such/checkout" })
      await openSpecsBrowser(main, {} as never)
      expect(launchCalls).toHaveLength(0)
      expect(iterateCalls).toHaveLength(0)
      expect(noticeCalls).toHaveLength(1)
      const notice = noticeCalls[0] as { title: string; message: string }
      expect(notice.message).toContain("no longer a valid target")
    } finally {
      await rm(main, { recursive: true, force: true })
    }
  })

  test("a continue handoff re-resolves its destination before launching", async () => {
    const { main, worktreeDir, branch } = await makeWorktreeRepo("routing-continue")
    try {
      capturing = true
      action({ type: "continue-change", changeID: "add-widget", worktreeDir, branch })
      await openSpecsBrowser(main)
      expect(launchCalls).toHaveLength(1)
      const options = launchCalls[0] as Record<string, any>
      expect(options.presetFeature.worktreeDir).toBe(await realpath(worktreeDir))
      expect(options.presetFeature.branch).toBe(branch)
    } finally {
      await rm(main, { recursive: true, force: true })
    }
  })

  test("a continue handoff whose branch moved reports the blocker instead of launching", async () => {
    const { main, worktreeDir } = await makeWorktreeRepo("routing-moved")
    try {
      capturing = true
      action({ type: "continue-change", changeID: "add-widget", worktreeDir, branch: "feat/stale" })
      await openSpecsBrowser(main, {} as never)
      expect(launchCalls).toHaveLength(0)
      expect(noticeCalls).toHaveLength(1)
      expect((noticeCalls[0] as { message: string }).message).toContain("no longer a valid target")
    } finally {
      await rm(main, { recursive: true, force: true })
    }
  })
})

describe("blocked close handoffs (task 7.9)", () => {
  /**
   * Commits the worktree's change so the checkout is clean, then plants a live
   * managed writer claim on its branch: the writer conflict is then the only
   * blocker a close review reports.
   */
  async function blockWithLiveWriter(main: string, worktreeDir: string): Promise<void> {
    await git(worktreeDir, ["add", "."])
    await git(worktreeDir, ["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-q", "-m", "add-widget"])
    const { repoCommonDir } = await import("../src/repo-store")
    const { writerClaimPath } = await import("../src/writer-claims")
    const commonDir = (await repoCommonDir(main))!
    await mkdir(join(commonDir, "convoy", "writer-claims"), { recursive: true })
    await writeFile(
      writerClaimPath(commonDir, "feat/add-widget"),
      JSON.stringify({
        schemaVersion: 1,
        branch: "feat/add-widget",
        checkoutPath: worktreeDir,
        kind: "authoring",
        owner: "ses_test",
        pid: process.pid,
        startedAt: Date.now(),
        heartbeatAt: Date.now(),
      }),
    )
  }

  test("the specs close-review surfaces a refused close as a visible notice", async () => {
    const { main, worktreeDir } = await makeWorktreeRepo("routing-specs-close-blocked")
    try {
      capturing = true
      await blockWithLiveWriter(main, worktreeDir)
      action({ type: "close-change", changeID: "add-widget", worktreeDir, branch: "feat/add-widget" })
      await openSpecsBrowser(main, {} as never)
      expect(noticeCalls).toHaveLength(1)
      expect((noticeCalls[0] as { message: string }).message).toContain("managed writer")
    } finally {
      await rm(main, { recursive: true, force: true })
    }
  })

  test("the Home close action surfaces a refused close instead of returning silently", async () => {
    const { main, worktreeDir } = await makeWorktreeRepo("routing-home-close-blocked")
    try {
      capturing = true
      confirmResult = "confirm"
      await blockWithLiveWriter(main, worktreeDir)
      await dispatchWorkAction(main, {} as never, worktreeDir, "close")
      expect(noticeCalls).toHaveLength(1)
      expect((noticeCalls[0] as { message: string }).message).toContain("managed writer")
    } finally {
      await rm(main, { recursive: true, force: true })
    }
  })
})

/** A repo whose worktree carries the change (no registry involved). */
async function makeWorktreeRepo(
  label: string,
): Promise<{ main: string; worktreeDir: string; branch: string }> {
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
  return { main, worktreeDir, branch: "feat/add-widget" }
}

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
