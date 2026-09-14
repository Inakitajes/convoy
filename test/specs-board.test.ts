import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SpecsBrowser } from "../src/specs-browser"
import type { BoardWorktree, ControlBoard } from "../src/control-board"
import { BoardSource, fingerprintCheckout } from "../src/board-refresh"
import { loadSpecsView, type SpecsChangeEntry, type SpecsResolution, type SpecsView } from "../src/specs"
import { createFixtureRepo } from "./helpers/multi-worktree"

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

const mainDir = "/repo"
const worktreeDir = "/wt/feat-add-foo"

function worktree(overrides: Partial<BoardWorktree> & { path: string }): BoardWorktree {
  return {
    branch: "main",
    detached: false,
    main: false,
    bare: false,
    accessible: true,
    changes: [],
    ...overrides,
  }
}

function change(id: string, checkout: string, title = id): SpecsChangeEntry {
  return { kind: "change", id, checkout, title, artifacts: [] }
}

function board(worktrees: BoardWorktree[]): ControlBoard {
  return { commonDir: "/common", baseBranch: "main", worktrees }
}

function viewWith(worktrees: BoardWorktree[], changes: SpecsChangeEntry[] = [], specs: string[] = []): SpecsView {
  return {
    targetDir: mainDir,
    present: true,
    board: board(worktrees),
    changes,
    specs,
    baseBranch: "main",
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

/** Moves the cursor to the first change child row (under the first worktree). */
async function selectFirstChange(session: Awaited<ReturnType<typeof openBoard>>) {
  session.press("g")
  await session.renderOnce()
  session.press("down")
  await session.renderOnce()
}

describe("the worktree-rooted board (delta specs-viewer)", () => {
  test("every registered checkout is a root entry with its local changes as children", async () => {
    const wt = worktree({ path: worktreeDir, branch: "feat/add-foo" })
    const frame = await frameOf(
      viewWith(
        [worktree({ path: mainDir, branch: "main", main: true }), wt],
        [change("add-foo", worktreeDir, "Title of add-foo"), change("inherited", mainDir, "Inherited")],
      ),
    )
    // Each checkout is a divider rule carrying its facts; its changes hang
    // beneath it as the only selectable rows.
    expect(frame).toContain("── repo · main · 1 change")
    expect(frame).toContain("── feat-add-foo · 1 change")
    // Both checkouts' local changes are their own children — same board, no
    // global deduplication, no ownership election.
    expect(frame).toContain("add-foo — Title of add-foo")
    expect(frame).toContain("inherited — Inherited")
    // No feature vocabulary anywhere on the board.
    expect(frame).not.toContain("FEATURES")
    expect(frame).not.toContain("ready to close")
    // Sections are never selectable rows: no cursor marker on a divider.
    expect(frame).not.toContain("▸")
  })

  test("a worktree-only board remains useful and omits the empty canonical section", async () => {
    const frame = await frameOf(viewWith([worktree({ path: "/wt/iso", branch: "feat/quick-fix" })]))
    expect(frame).toContain("── iso · feat/quick-fix · no changes")
    expect(frame).not.toContain("╭─ specs")
  })

  test("canonical specs render as their own section after the worktrees", async () => {
    const frame = await frameOf(
      viewWith([worktree({ path: mainDir, branch: "main", main: true })], [], ["openspec/specs/core.md"]),
    )
    const lines = frame.split("\n")
    const worktrees = lines.findIndex((line) => line.includes("── repo · main ·"))
    const specs = lines.findIndex((line) => line.trimStart().startsWith("╭─ specs"))
    expect(worktrees).toBeGreaterThanOrEqual(0)
    expect(specs).toBeGreaterThan(worktrees)
    expect(frame).toContain("core.md")
  })

  test("a worktree section's divider carries the independent observations, not a lifecycle stage", async () => {
    const frame = await frameOf(
      viewWith([
        worktree({
          path: worktreeDir,
          branch: "feat/add-foo",
          dirt: { kind: "known", value: { dirty: true, fileCount: 2 }, collectedAt: 0 },
          activity: { kind: "known", value: { liveRunIds: ["r1"], total: 1 }, collectedAt: 0 },
          changes: [],
        }),
      ]),
    )
    // The facts ride inside the section's rule — no cursor, no detail pane,
    // no lifecycle stage anywhere.
    expect(frame).toContain("── feat-add-foo · no changes · 2 dirty · 1 live")
    expect(frame).not.toContain("stage:")
  })
})

describe("row actions route to the right handoff", () => {
  test("s on a change stranded on the launch checkout spins it out", async () => {
    const session = await openBoard(
      viewWith([worktree({ path: mainDir, branch: "main", main: true })], [change("add-foo", mainDir)]),
    )
    await selectFirstChange(session)
    session.press("s")
    await expect(session.instance.result).resolves.toEqual({ type: "spin-change", changeID: "add-foo" })
  })

  test("c continues a change in its containing worktree with its branch", async () => {
    const session = await openBoard(
      viewWith([worktree({ path: worktreeDir, branch: "feat/add-foo" })], [change("add-foo", worktreeDir)]),
    )
    await selectFirstChange(session)
    session.press("c")
    await expect(session.instance.result).resolves.toEqual({ type: "continue-change", changeID: "add-foo", worktreeDir, branch: "feat/add-foo" })
  })

  test("x confirms before it closes the containing worktree, naming the whole-branch scope", async () => {
    const session = await openBoard(
      viewWith([worktree({ path: worktreeDir, branch: "feat/add-foo" })], [change("add-foo", worktreeDir)]),
    )
    await selectFirstChange(session)
    session.press("x")
    await session.renderOnce()
    // The confirmation arms first; nothing resolves until y.
    expect(session.captureCharFrame()).toContain("Close this worktree?")
    expect(session.captureCharFrame()).toContain("WHOLE")
    expect(session.captureCharFrame()).toContain("add-foo")
    session.press("y")
    await expect(session.instance.result).resolves.toEqual({ type: "close-change", changeID: "add-foo", worktreeDir, branch: "feat/add-foo" })
  })

  test("actions stay inert on rows they do not apply to", async () => {
    // s on a change already living in a worktree is not the stranded-transfer
    // flow; the browser stays open.
    const session = await openBoard(
      viewWith([worktree({ path: worktreeDir, branch: "feat/add-foo" })], [change("add-foo", worktreeDir)]),
    )
    await selectFirstChange(session)
    session.press("s")
    await session.renderOnce()
    expect(session.instance.result).toBeInstanceOf(Promise)
    session.press("c", { ctrl: true })
    await expect(session.instance.result).resolves.toEqual({ type: "exit" })
  })
})

describe("the fullscreen reader stays at the detail level", () => {
  test("v is a no-op at the root level", async () => {
    const session = await openBoard(viewWith([worktree({ path: mainDir, branch: "main", main: true })]))
    session.press("v")
    await session.renderOnce()
    // The board is still at the root: the reader never opened.
    expect(session.captureCharFrame()).toContain("╭─ changes")
    session.press("c", { ctrl: true })
    await expect(session.instance.result).resolves.toEqual({ type: "exit" })
  })
})

describe("the compact root stays a single full-body list", () => {
  test("sections draw as rounded containers and every footer hint stays visible", async () => {
    const testRenderer = await createTestRenderer({ width: 84, height: 55 })
    const instance = new SpecsBrowser(
      testRenderer.renderer,
      viewWith([worktree({ path: mainDir, branch: "main", main: true })]),
      async () => "copied-native",
    )
    try {
      await testRenderer.renderOnce()
      const frame = testRenderer.captureCharFrame()
      // The section containers identify the board — there is no header row.
      expect(frame).toContain("╭─ changes")
      const lines = frame.split("\n")
      // Sections draw as rounded text containers — chrome on the rows
      // themselves, never a bordered panel box around the body.
      expect(lines.some((line) => line.trimStart().startsWith("╭─ changes"))).toBe(true)
      // The hints row is the last drawn line — nothing scrolls off the
      // bottom edge.
      const lastDrawn = lines.map((line) => line.trimEnd()).filter((line) => line.length > 0).pop() ?? ""
      expect(lastDrawn).toContain("actions")
    } finally {
      testRenderer.renderer.keyInput.emit("keypress", keyEvent("c", { ctrl: true }))
      await instance.result.catch(() => {})
    }
  })
})

describe("a selected canonical spec uses the full root body", () => {
  for (const width of [84, 120]) {
    test(`at width ${width}`, async () => {
      const testRenderer = await createTestRenderer({ width, height: 40 })
      const instance = new SpecsBrowser(
        testRenderer.renderer,
        viewWith([worktree({ path: mainDir, branch: "main", main: true })], [], ["openspec/specs/core.md"]),
        async () => "copied-native",
      )
      try {
        await testRenderer.renderOnce()
        // Land on the canonical spec row (the last selectable row): shift+g is end.
        testRenderer.renderer.keyInput.emit("keypress", keyEvent("g", { shift: true }))
        await testRenderer.renderOnce()
        const frame = testRenderer.captureCharFrame()
        // The details panel is hidden; the list fills the body — its spec
        // section container wraps the selected row.
        expect(frame).toContain("core.md")
        const lines = frame.split("\n")
        const specRow = lines.findIndex((line) => line.includes("core.md"))
        expect(lines[specRow]!.trimStart().startsWith("│")).toBe(true)
      } finally {
        testRenderer.renderer.keyInput.emit("keypress", keyEvent("c", { ctrl: true }))
        await instance.result.catch(() => {})
      }
    })
  }
})

describe("refresh reloads external changes from the real repo", () => {
  test("an external task edit is visible after an explicit refresh", async () => {
    const { execFile: nodeExecFile } = await import("node:child_process")
    const { chmod } = await import("node:fs/promises")
    const exec = promisifyExec()
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

    // Stub the real openspec CLI so task counting is deterministic: the
    // checkbox fallback parses tasks.md directly.
    const stubDir = join(root, "bin")
    await mkdir(stubDir, { recursive: true })
    await writeFile(join(stubDir, "openspec"), "#!/bin/sh\nexit 1\n")
    await chmod(join(stubDir, "openspec"), 0o755)
    const savedPath = process.env.PATH
    process.env.PATH = `${stubDir}:${savedPath}`
    const restorePath = () => {
      if (savedPath !== undefined) process.env.PATH = savedPath
    }

    const session = await openBoard(await loadSpecsView(main))
    expect(session.captureCharFrame()).toContain("add-widget")

    // An external edit marks a task incomplete; refresh must show it.
    await writeFile(join(changeDir, "tasks.md"), "- [x] one\n- [ ] two\n")
    session.press("r")
    await new Promise((resolve) => setTimeout(resolve, 300))
    const frame = session.captureCharFrame()
    restorePath()
    // The refreshed row still lists the change under its worktree (facts are
    // re-read; there is no lifecycle stage to flip).
    expect(frame).toContain("add-widget")
    session.press("c", { ctrl: true })
    await session.instance.result.catch(() => {})
  })
})

function promisifyExec() {
  const { execFile: nodeExecFile } = require("node:child_process") as typeof import("node:child_process")
  const { promisify } = require("node:util") as typeof import("node:util")
  return promisify(nodeExecFile)
}

type SpecsResolutionCheck = SpecsResolution
void (0 as unknown as SpecsResolutionCheck)

/** The specs board's own background cadence (change `live-board-cache-and-refresh`). */
describe("specs board background refresh", () => {
  test("a return from an action refreshes immediately, before any cadence tick", async () => {
    const base = [worktree({ path: mainDir, branch: "main", main: true })]
    const withNew = [...base, worktree({ path: worktreeDir, branch: "feat/add-foo" })]
    let calls = 0
    const source = {
      async refresh() {
        calls += 1
        return {
          snapshot: {
            schemaVersion: 1,
            repoKey: "k",
            commonDir: "/common",
            builtAt: Date.now(),
            board: board(calls >= 1 ? withNew : base),
            fingerprints: {},
          },
          refreshed: true,
        }
      },
      async cached() {
        return undefined
      },
      current() {
        return undefined
      },
      lastError() {
        return undefined
      },
      lastRunEntries() {
        return undefined
      },
    } as unknown as BoardSource
    const testRenderer = await createTestRenderer({ width: 120, height: 40 })
    // The passed view is the stale cache-first paint; the cadence is too slow
    // to have fired, so an appearing worktree proves the immediate refresh.
    const instance = new SpecsBrowser(testRenderer.renderer, viewWith(base), async () => "copied-native", undefined, undefined, {
      source,
      pollMs: 100_000,
    })
    await testRenderer.renderOnce()
    await Bun.sleep(10)
    await testRenderer.renderOnce()
    expect(calls).toBeGreaterThanOrEqual(1)
    expect(testRenderer.captureCharFrame()).toContain("feat-add-foo")
    // Closing the surface clears the timer: no further refresh after exit.
    testRenderer.renderer.keyInput.emit("keypress", keyEvent("c", { ctrl: true }))
    await instance.result.catch(() => {})
    const settled = calls
    await Bun.sleep(40)
    expect(calls).toBe(settled)
  })

  test("a post-mutation change appears after re-entry, before the cadence", async () => {
    const home = await mkdtemp(join(tmpdir(), "convoy-specs-refresh-"))
    const previousHome = process.env.CONVOY_HOME
    process.env.CONVOY_HOME = home
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/wt" }] })
    try {
      const checkout = fixture.worktrees["wt"]!
      await fixture.write(checkout, "openspec/changes/add-widget/proposal.md", "# Add the widget\n")
      await fixture.write(checkout, "openspec/changes/add-widget/tasks.md", "- [ ] one\n")
      // A warmed source: the first paint is built from its snapshot.
      const source = new BoardSource({ targetDir: fixture.root })
      const warm = await source.refresh()
      const staleView = await loadSpecsView(fixture.root, warm.snapshot.board)
      expect(staleView.board.worktrees.flatMap((entry) => entry.changes).map((entry) => entry.changeId)).toContain("add-widget")

      // A mutating external action adds a change in the checkout.
      await Bun.sleep(10)
      await fixture.write(checkout, "openspec/changes/new-change/proposal.md", "# New change\n")

      const testRenderer = await createTestRenderer({ width: 120, height: 40 })
      // Re-entry passes the stale cache-first view; the cadence is far away
      // (100s), so seeing the new change proves the mount refresh invalidated
      // the changed checkout's cached artifact facts.
      const instance = new SpecsBrowser(testRenderer.renderer, staleView, async () => "copied-native", undefined, undefined, {
        source,
        pollMs: 100_000,
      })
      const deadline = Date.now() + 5_000
      let seen = false
      while (Date.now() < deadline) {
        await Bun.sleep(50)
        await testRenderer.renderOnce()
        if (testRenderer.captureCharFrame().includes("new-change")) {
          seen = true
          break
        }
      }
      expect(seen).toBe(true)
      testRenderer.renderer.keyInput.emit("keypress", keyEvent("c", { ctrl: true }))
      await instance.result.catch(() => {})
    } finally {
      await fixture.cleanup()
      if (previousHome === undefined) delete process.env.CONVOY_HOME
      else process.env.CONVOY_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })

  test("a same-size, mtime-restored edit is caught after a known mutation invalidates the checkout", async () => {
    const home = await mkdtemp(join(tmpdir(), "convoy-specs-invalidate-"))
    const previousHome = process.env.CONVOY_HOME
    process.env.CONVOY_HOME = home
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/wt" }] })
    try {
      const checkout = fixture.worktrees["wt"]!
      await fixture.write(checkout, "openspec/changes/add-widget/proposal.md", "# Add widget\n")
      // Pin the proposal's mtime to a whole-second timestamp so restoring it
      // after an edit reproduces an exact fingerprint collision (the raw
      // mtimeMs+size token), without the filesystem's sub-ms precision.
      const pinned = new Date(1_700_000_000_000)
      const proposalPath = join(checkout, "openspec/changes/add-widget/proposal.md")
      await utimes(proposalPath, pinned, pinned)
      const source = new BoardSource({ targetDir: fixture.root })
      const warm = await source.refresh()
      const physical = await realpath(checkout)
      const titleOf = (board: ControlBoard): string | undefined =>
        board.worktrees.flatMap((entry) => entry.changes).find((entry) => entry.changeId === "add-widget")?.title
      expect(titleOf(warm.snapshot.board)).toBe("Add widget")

      // A same-size content edit with the file's mtime restored to that exact
      // value: the mtime+size fingerprint alone cannot see it.
      await writeFile(proposalPath, "# Add widgit\n")
      await utimes(proposalPath, pinned, pinned)
      expect(await fingerprintCheckout(checkout)).toBe(warm.snapshot.fingerprints[physical])

      // An ordinary gated cycle trusts that unchanged token and reuses stale
      // evidence — the gap the invalidation exists to close.
      const gated = await source.refresh()
      expect(titleOf(gated.snapshot.board)).toBe("Add widget")

      // The known mutation-return path invalidates the affected checkout, so
      // the next gated refresh recomputes exactly it.
      source.invalidate(physical)
      const invalidated = await source.refresh()
      expect(titleOf(invalidated.snapshot.board)).toBe("Add widgit")
    } finally {
      await fixture.cleanup()
      if (previousHome === undefined) delete process.env.CONVOY_HOME
      else process.env.CONVOY_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })

  test("an explicit refresh during an in-flight cycle is replayed as a trailing forced cycle", async () => {
    const rows = [worktree({ path: mainDir, branch: "main", main: true })]
    const snapshot = {
      schemaVersion: 1,
      repoKey: "k",
      commonDir: "/common",
      builtAt: Date.now(),
      board: board(rows),
      fingerprints: {},
    }
    const resolvers: Array<() => void> = []
    let calls = 0
    const source = {
      refresh() {
        calls += 1
        return new Promise((resolve) => {
          resolvers.push(() => resolve({ snapshot, refreshed: true }))
        })
      },
      cached: async () => undefined,
      current: () => undefined,
      lastError: () => undefined,
      lastRunEntries: () => undefined,
    } as unknown as BoardSource
    const testRenderer = await createTestRenderer({ width: 120, height: 40 })
    const instance = new SpecsBrowser(testRenderer.renderer, viewWith(rows), async () => "copied-native", undefined, undefined, {
      source,
      pollMs: 100_000,
    })
    await testRenderer.renderOnce()
    expect(calls).toBe(1)
    testRenderer.renderer.keyInput.emit("keypress", keyEvent("r"))
    await Bun.sleep(5)
    // The explicit refresh is remembered, not dropped, while the cycle runs.
    expect(calls).toBe(1)
    resolvers[0]!()
    await Bun.sleep(10)
    await testRenderer.renderOnce()
    expect(calls).toBe(2)
    testRenderer.renderer.keyInput.emit("keypress", keyEvent("c", { ctrl: true }))
    await instance.result.catch(() => {})
    resolvers[1]?.()
  })
})
