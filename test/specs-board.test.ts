import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { SpecsBrowser } from "../src/specs-browser"
import type { FeatureRow, WorktreeWithoutSpec } from "../src/control-board"
import type { LifecycleFeatureRow, SpecsChangeEntry, SpecsResolution, SpecsView } from "../src/specs"

function keyEvent(name: string, options: { ctrl?: boolean; shift?: boolean; sequence?: string } = {}) {
  return {
    name,
    ctrl: options.ctrl ?? false,
    meta: false,
    shift: options.shift ?? false,
    option: false,
    sequence: options.sequence ?? name,
    number: false,
    raw: name,
    eventType: "keypress" as const,
    source: "raw" as const,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as any
}

const worktreeDir = "/wt/feat-add-foo"

function featureRow(overrides: Partial<FeatureRow> & { id: string }): FeatureRow {
  return {
    location: "main",
    runs: [],
    liveRuns: 0,
    uncommittedProposal: false,
    probablyMerged: false,
    stage: "stranded",
    ...overrides,
  }
}

function change(id: string, title = id): SpecsChangeEntry {
  return { kind: "change", id, title, artifacts: [] }
}

function viewWith(rows: FeatureRow[], worktreesWithoutSpec: WorktreeWithoutSpec[] = []): SpecsView {
  return {
    targetDir: "/repo",
    present: true,
    changes: rows.map((row) => change(row.id, `Title of ${row.id}`)),
    specs: [],
    rows,
    worktreesWithoutSpec,
  }
}

async function openBoard(view: SpecsView) {
  const testRenderer = await createTestRenderer({ width: 120, height: 40 })
  const instance = new SpecsBrowser(testRenderer.renderer, view, async () => "copied-native")
  await testRenderer.renderOnce()
  return {
    ...testRenderer,
    instance,
    press(key: string, options: { ctrl?: boolean; shift?: boolean; sequence?: string } = {}) {
      testRenderer.renderer.keyInput.emit("keypress", keyEvent(key, options))
    },
  }
}

async function frameOf(view: SpecsView) {
  const session = await openBoard(view)
  try {
    return session.captureCharFrame()
  } finally {
    session.press("c", { ctrl: true })
    await session.instance.result.catch(() => {})
  }
}

/** The only change row's ordinal in the list: 1-based, skipping headers. */
async function selectFirstChange(session: Awaited<ReturnType<typeof openBoard>>) {
  // The first selectable row after the leading header is the first change.
  session.press("g")
  await session.renderOnce()
  session.press("down")
  await session.renderOnce()
}

describe("board rows derive their lifecycle state", () => {
  test("a stranded change on main shows its stage and the non-empty worktree section stays a peer", async () => {
    const frame = await frameOf(
      viewWith([featureRow({ id: "add-foo", stage: "stranded" })], [{ dir: "/wt/iso", branch: "feat/quick-fix", runCount: 2 }]),
    )
    expect(frame).toContain("stranded on main")
    expect(frame).toContain("WORKTREES WITHOUT SPEC")
    expect(frame).toContain("feat/quick-fix")
    expect(frame).toContain("2 runs")
    // Non-empty sections render in order; the empty canonical section has no title.
    const lines = frame.split("\n")
    const changes = lines.findIndex((line) => line.includes("ACTIVE CHANGES"))
    const worktrees = lines.findIndex((line) => line.includes("WORKTREES WITHOUT SPEC"))
    expect(changes).toBeGreaterThanOrEqual(0)
    expect(worktrees).toBeGreaterThan(changes)
    expect(frame).not.toContain("CANONICAL SPECS")
  })

  test("an implementing feature marks the live run and its task counts", async () => {
    const frame = await frameOf(
      viewWith([
        featureRow({
          id: "add-bar",
          location: "worktree",
          worktreeDir,
          branch: "feat/add-bar",
          stage: "implementing",
          tasks: { done: 3, total: 11 },
          runs: [{ runID: "r1", branch: "feat/add-bar", live: false }, { runID: "r2", branch: "feat/add-bar", live: true }],
          liveRuns: 1,
          uncommittedProposal: true,
          synced: false,
        }),
      ]),
    )
    expect(frame).toContain("implementing")
    expect(frame).toContain("3/11")
    // The full run signal lives in the detail pane (the row column truncates).
    expect(frame).toContain("runs: 2 (1 live)")
    expect(frame).toContain("uncommitted")
    expect(frame).toContain("unsynced")
    expect(frame).toContain("details")
    expect(frame).not.toContain("WORKTREES WITHOUT SPEC")
    expect(frame).not.toContain("CANONICAL SPECS")
  })

  test("a completed-unarchived change reads ready to close; probably-merged reads honestly", async () => {
    const ready = await frameOf(viewWith([featureRow({ id: "add-baz", stage: "ready", tasks: { done: 11, total: 11 } })]))
    expect(ready).toContain("ready to close")

    const merged = await frameOf(viewWith([featureRow({ id: "old-one", stage: "probably-merged", probablyMerged: true })]))
    expect(merged).toContain("probably merged")
  })

  test("a worktree-only board remains useful and omits both empty section titles", async () => {
    const frame = await frameOf(viewWith([], [{ dir: "/wt/iso", branch: "feat/quick-fix", runCount: 2 }]))
    expect(frame).toContain("WORKTREES WITHOUT SPEC")
    expect(frame).toContain("feat/quick-fix")
    expect(frame).toContain("2 runs")
    expect(frame).toContain("no OpenSpec change")
    expect(frame).toContain("details")
    expect(frame).not.toContain("ACTIVE CHANGES")
    expect(frame).not.toContain("CANONICAL SPECS")
  })
})

describe("row actions route to the right handoff", () => {
  test("s on a stranded row spins it out", async () => {
    const session = await openBoard(viewWith([featureRow({ id: "add-foo", stage: "stranded" })]))
    await selectFirstChange(session)
    session.press("s")
    await expect(session.instance.result).resolves.toEqual({ type: "spin-change", changeID: "add-foo" })
  })

  test("c continues a feature with its worktree and branch", async () => {
    const session = await openBoard(
      viewWith([featureRow({ id: "add-foo", location: "worktree", worktreeDir, branch: "feat/add-foo", stage: "proposing" })]),
    )
    await selectFirstChange(session)
    session.press("c")
    await expect(session.instance.result).resolves.toEqual({ type: "continue-change", changeID: "add-foo", worktreeDir, branch: "feat/add-foo" })
  })

  test("x confirms before it closes a feature that has a worktree and branch", async () => {
    const session = await openBoard(
      viewWith([featureRow({ id: "add-foo", location: "worktree", worktreeDir, branch: "feat/add-foo", stage: "ready", tasks: { done: 4, total: 4 } })]),
    )
    await selectFirstChange(session)
    session.press("x")
    await session.renderOnce()
    // The confirmation arms first; nothing resolves until y.
    expect(session.captureCharFrame()).toContain("Close this feature?")
    session.press("y")
    await expect(session.instance.result).resolves.toEqual({ type: "close-change", changeID: "add-foo", worktreeDir, branch: "feat/add-foo" })
  })

  test("m archives a probably-merged change on main", async () => {
    const session = await openBoard(viewWith([featureRow({ id: "add-foo", stage: "probably-merged", probablyMerged: true })]))
    await selectFirstChange(session)
    session.press("m")
    await expect(session.instance.result).resolves.toEqual({ type: "archive-change-main", changeID: "add-foo" })
  })

  test("actions stay inert on rows they do not apply to", async () => {
    // s on a worktree row does nothing; the browser stays open.
    const session = await openBoard(
      viewWith([featureRow({ id: "add-foo", location: "worktree", worktreeDir, branch: "feat/add-foo", stage: "proposing" })]),
    )
    await selectFirstChange(session)
    session.press("s")
    session.press("m")
    await session.renderOnce()
    expect(session.instance.result).toBeInstanceOf(Promise)
    session.press("c", { ctrl: true })
    await expect(session.instance.result).resolves.toEqual({ type: "exit" })
  })
})

describe("the fullscreen reader stays at the detail level", () => {
  test("v is a no-op at the root level", async () => {
    const session = await openBoard(viewWith([featureRow({ id: "add-foo" })]))
    session.press("v")
    await session.renderOnce()
    // The header is still visible: the reader never opened.
    expect(session.captureCharFrame()).toContain("project  /repo")
    session.press("c", { ctrl: true })
    await expect(session.instance.result).resolves.toEqual({ type: "exit" })
  })
})

describe("compact stacking", () => {
  test("stacked panels sit flush and every bottom border stays visible", async () => {
    const testRenderer = await createTestRenderer({ width: 84, height: 55 })
    const instance = new SpecsBrowser(testRenderer.renderer, viewWith([featureRow({ id: "add-foo" })]), async () => "copied-native")
    try {
      await testRenderer.renderOnce()
      const frame = testRenderer.captureCharFrame()
      // The bare header row rides above the panels.
      expect(frame).toContain("project  /repo")
      const lines = frame.split("\n")
      const tops = lines.flatMap((line, index) => (line.trimStart().startsWith("╭") ? [index] : []))
      const bottoms = lines.flatMap((line, index) => (line.trimStart().startsWith("╰") ? [index] : []))
      // Browse, details, footer: all three bordered panels fully drawn, with
      // the details panel's bottom border above the footer's top border.
      expect(tops).toHaveLength(3)
      expect(bottoms).toHaveLength(3)
      // Flush stacking: no blank separator row between stacked panels.
      for (let index = 1; index < tops.length; index++) expect(tops[index]).toBe(bottoms[index - 1]! + 1)
    } finally {
      testRenderer.renderer.keyInput.emit("keypress", keyEvent("c", { ctrl: true }))
      await instance.result.catch(() => {})
    }
  })
})

// ── registered lifecycle features (tasks 6.3/6.4/6.5) ───────────────────────

function lifecycleRow(overrides: Partial<LifecycleFeatureRow> = {}): LifecycleFeatureRow {
  return {
    featureId: "aaaaaaaa-0000-4000-8000-000000000009",
    displayName: "add-widget",
    branch: "feat/add-widget",
    checkoutPath: "/wt/add-widget",
    summary: "Ready to close",
    blockers: [],
    tasks: { done: 11, total: 11 },
    liveRuns: 0,
    integration: "pending",
    contracts: [{ changeId: "add-widget", state: "active" }],
    actions: [
      { id: "close", label: "Close review", enabled: true, blockers: [] },
      { id: "continue", label: "Continue implementation", enabled: true, blockers: [] },
    ],
    ...overrides,
  }
}

function viewWithFeatures(features: LifecycleFeatureRow[]): SpecsView {
  return {
    targetDir: "/repo",
    present: true,
    changes: [],
    specs: [],
    features,
    worktreesWithoutSpec: [],
  }
}

describe("registered lifecycle features on the board", () => {
  test("the Features section renders first with summaries and the assessment detail", async () => {
    const frame = await frameOf(viewWithFeatures([lifecycleRow()]))
    const lines = frame.split("\n")
    const features = lines.findIndex((line) => line.includes("FEATURES"))
    expect(features).toBeGreaterThanOrEqual(0)
    // The Features section leads the board — before Worktrees/Canonical
    // headers (absent here) and before any Active Changes rows.
    expect(frame.indexOf("FEATURES")).toBeLessThan(frame.indexOf("add-widget"))
    expect(frame).toContain("Ready to close")
    expect(frame).toContain("feat/add-widget")
  })

  test("a blocked feature's detail exposes its blockers with reasons (task 6.4)", async () => {
    const view = viewWithFeatures([
      lifecycleRow({
        summary: "In implementation",
        blockers: ["1 live run(s) attached"],
        actions: [{ id: "close", label: "Close review", enabled: false, blockers: ["1 live run(s) attached"] }],
      }),
    ])
    const frame = await frameOf(view)
    expect(frame).toContain("In implementation")
    expect(frame).toContain("Close review")
    expect(frame).toContain("blocked")
    expect(frame).toContain("1 live run(s) attached")
  })

  test("x on a feature row confirms before the close handoff through its verified context (task 6.4)", async () => {
    const session = await openBoard(viewWithFeatures([lifecycleRow()]))
    session.press("x")
    await session.renderOnce()
    expect(session.captureCharFrame()).toContain("Close this feature?")
    session.press("y")
    await expect(session.instance.result).resolves.toEqual({
      type: "close-change",
      changeID: "add-widget",
      worktreeDir: "/wt/add-widget",
      branch: "feat/add-widget",
    })
  })

  test("Enter on a completed feature opens its History view with receipts (task 6.3)", async () => {
    const completed = lifecycleRow({
      summary: "Completed",
      integration: "verified" as const,
      contracts: [{ changeId: "add-widget", state: "verified-archived" }],
      receipts: [{ attemptId: "dddddddd-0000-4000-8000-00000000abc3", landingSha: "e".repeat(40), landingReachable: true }],
      history: [{ at: 1_700_000_000_000, kind: "recovered", summary: "adopted legacy landing" }],
    })
    const session = await openBoard(viewWithFeatures([completed]))
    session.press("return")
    await session.renderOnce()
    const frame = session.captureCharFrame()
    expect(frame).toContain("add-widget — history")
    expect(frame).toContain("Landing receipts")
    expect(frame).toContain("reachable from the base (verified)")
    expect(frame).toContain("Association history")
    // Leaving the history detail restores the feature row (identity preserved).
    session.press("escape")
    await session.renderOnce()
    expect(session.captureCharFrame()).toContain("FEATURES")
    session.press("c", { ctrl: true })
    await session.instance.result.catch(() => {})
  })

  test("refresh reloads external changes from the real repo (task 6.5)", async () => {
    const { execFile: nodeExecFile } = await import("node:child_process")
    const { mkdir, mkdtemp, writeFile } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { promisify } = await import("node:util")
    const exec = promisify(nodeExecFile)
    const root = await mkdtemp(join(tmpdir(), "convoy-board-refresh-"))
    const main = join(root, "main")
    const wt = join(root, "wt")
    await mkdir(main, { recursive: true })
    await exec("git", ["init", "-b", "main"], { cwd: main })
    await writeFile(join(main, "README.md"), "# repo\n")
    await exec("git", ["add", "."], { cwd: main })
    await exec("git", ["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-m", "init"], { cwd: main })
    await exec("git", ["worktree", "add", "-b", "feat/add-widget", wt], { cwd: main })
    const changeDir = join(wt, "openspec", "changes", "add-widget")
    await mkdir(changeDir, { recursive: true })
    await writeFile(join(changeDir, "proposal.md"), "# Add widget\n")
    await writeFile(join(changeDir, "tasks.md"), "- [x] one\n- [x] two\n")

    const { featureAdopt } = await import("../src/feature-lifecycle/commands")
    await featureAdopt({ cwd: main, branch: "feat/add-widget", changeIds: ["add-widget"], base: "main" })

    // Stub the real openspec CLI so task counting is deterministic: the
    // checkbox fallback parses tasks.md directly.
    const { chmod } = await import("node:fs/promises")
    const stubDir = join(root, "bin")
    await mkdir(stubDir, { recursive: true })
    await writeFile(join(stubDir, "openspec"), "#!/bin/sh\nexit 1\n")
    await chmod(join(stubDir, "openspec"), 0o755)
    const savedPath = process.env.PATH
    process.env.PATH = `${stubDir}:${savedPath}`
    const restorePath = () => {
      if (savedPath !== undefined) process.env.PATH = savedPath
    }

    const { loadSpecsView } = await import("../src/specs")
    const session = await openBoard(await loadSpecsView(main))
    expect(session.captureCharFrame()).toContain("Ready to close")

    // An external edit marks a task incomplete; refresh must show it.
    await writeFile(join(changeDir, "tasks.md"), "- [x] one\n- [ ] two\n")
    session.press("r")
    await new Promise((resolve) => setTimeout(resolve, 300))
    const frame = session.captureCharFrame()
    restorePath()
    expect(frame).toContain("In implementation")
    session.press("c", { ctrl: true })
    await session.instance.result.catch(() => {})
  })
})
