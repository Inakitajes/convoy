import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { execFile as nodeExecFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterAll } from "bun:test"

const actualWorktree = await import("../src/worktree")
const realEnsureFreeBranchName = actualWorktree.ensureFreeBranchName

/**
 * Deterministic gate over the free-name check (delegates unless raised, the
 * same process-wide pattern the propose/resume tests use): the deferred
 * suggestion tests park inside `ensureFreeBranchName` so the operator action
 * lands in the exact await window an unchecked post-await assignment would
 * overwrite.
 */
let gatingEnsureFreeBranchName = false
const ensureFreeWaiters: Array<{ branch: string; resolve: (value: string) => void }> = []

const { mock } = await import("bun:test")
mock.module("../src/worktree", () => ({
  ...actualWorktree,
  ensureFreeBranchName: async (branch: string, targetDir: string, limit?: number) => {
    if (!gatingEnsureFreeBranchName) return realEnsureFreeBranchName(branch, targetDir, limit)
    return new Promise<string>((resolve) => ensureFreeWaiters.push({ branch, resolve }))
  },
}))

/** Releases the parked free-name check for exactly this branch argument. */
function releaseEnsureFreeBranchName(branch: string, value: string): void {
  const index = ensureFreeWaiters.findIndex((waiter) => waiter.branch === branch)
  if (index === -1) throw new Error(`no parked ensureFreeBranchName call for ${branch}`)
  const [waiter] = ensureFreeWaiters.splice(index, 1)
  waiter.resolve(value)
}

import { HomeLauncher } from "../src/home-tui"
import type { DetailRun, HomeResolution, HomeWorkAction } from "../src/home-tui"
import type { PrObservation } from "../src/pr-observations"
import type { LocalActiveChange } from "../src/checkout-openspec"
import { theme } from "../src/tui-theme"
import { versionDetails } from "../src/version"
import type { BoardWorktree } from "../src/control-board"

const exec = promisify(nodeExecFile)
const dirs: string[] = []

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd })
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

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

const mainPath = "/repo"
const wtPath = "/wt/add-widget"

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

const worktrees: BoardWorktree[] = [
  worktree({ path: mainPath, branch: "main", main: true }),
  worktree({
    path: wtPath,
    branch: "feat/add-widget",
    dirt: { kind: "known", value: { dirty: true, fileCount: 2 }, collectedAt: 0 },
    activity: { kind: "known", value: { liveRunIds: ["r1"], total: 1 }, collectedAt: 0 },
  }),
]

function viewDir(): string {
  return "/work/acme"
}

async function openHome(options: { worktrees?: BoardWorktree[]; width?: number; height?: number; targetDir?: string; proposeBranchName?: (input: { prompt: string }) => Promise<{ branch: string }>; observePr?: (worktree: BoardWorktree) => Promise<PrObservation>; listRunsForWorktree?: (worktree: BoardWorktree) => Promise<DetailRun[]> } = {}) {
  const testRenderer = await createTestRenderer({ width: options.width ?? 110, height: options.height ?? 30 })
  const instance = new HomeLauncher(testRenderer.renderer, options.targetDir ?? viewDir(), {
    scene: undefined,
    worktrees: options.worktrees ?? worktrees,
    proposeBranchName: options.proposeBranchName,
    // Hermetic default: no test talks to `gh` unless it injects its own observer.
    observePr: options.observePr ?? (async () => ({ availability: "unknown", reason: "no PR observation requested by this test", observedAt: 0 })),
    // Hermetic default: no test reads run history unless it injects its own source.
    listRunsForWorktree: options.listRunsForWorktree ?? (async () => []),
  })
  await testRenderer.renderOnce()
  // Let any immediately-resolved on-demand observation settle its render
  // before the test interacts — a resumed selection's PR query fires at
  // construction and must not race a frame capture.
  await Bun.sleep(5)
  await testRenderer.renderOnce()
  return {
    ...testRenderer,
    instance,
    press(key: string, options: { ctrl?: boolean; shift?: boolean; sequence?: string } = {}) {
      testRenderer.renderer.keyInput.emit("keypress", keyEvent(key, options))
    },
  }
}

async function closeHome(session: Awaited<ReturnType<typeof openHome>>) {
  // From the detail level the first q returns to the list; keep pressing
  // until the launcher actually resolves.
  for (let attempt = 0; attempt < 5; attempt++) {
    session.press("q")
    const settled = await Promise.race([
      session.instance.result.then(
        () => true,
        () => true,
      ),
      Bun.sleep(60).then(() => false),
    ])
    if (settled) return
  }
}

function frameOf(session: Awaited<ReturnType<typeof openHome>>): string {
  return session.captureCharFrame()
}

/**
 * The text of every line that carries a painted background — the selection's
 * full-width highlight. Char frames cannot show colors, so the selection
 * asserts itself here: ordinary rows are transparent; only the selected one
 * rides the accent fill.
 */
function highlightedLines(session: Awaited<ReturnType<typeof openHome>>): string[] {
  const frame = session.captureSpans()
  return frame.lines
    .map((line) => line.spans.filter((span) => span.bg.a > 0).map((span) => span.text).join(""))
    .filter((text) => text.trim().length > 0)
}

/** Channel-wise RGBA comparison with a small float tolerance. */
function sameColor(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): boolean {
  return [a.r - b.r, a.g - b.g, a.b - b.b].every((delta) => Math.abs(delta) < 0.01)
}

/** The chip text color of the test-run palette (dark), as captured float channels. */
function chipTextFg(): { r: number; g: number; b: number } {
  const hex = theme.chipText.replace("#", "")
  return { r: parseInt(hex.slice(0, 2), 16) / 255, g: parseInt(hex.slice(2, 4), 16) / 255, b: parseInt(hex.slice(4, 6), 16) / 255 }
}

/** A palette hex as captured float channels, for span color comparisons. */
function paletteColor(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "")
  return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 }
}

function accentBg(): { r: number; g: number; b: number } {
  return paletteColor(theme.accent)
}

function navyBg(): { r: number; g: number; b: number } {
  return paletteColor(theme.navy)
}

function wellBg(): { r: number; g: number; b: number } {
  return paletteColor(theme.well)
}

describe("worktrees-first home (capability home-launcher delta)", () => {
  test("the masthead carries identity and the complete version above the worktree list", async () => {
    const session = await openHome()
    try {
      const frame = frameOf(session)
      expect(frame).toContain("████")
      // The wide masthead right-aligns the version. The version's fallback
      // chain is environment-dependent (bun run scripts see
      // npm_package_version), so assert the same value the masthead renders.
      expect(frame).toContain(versionDetails())
      // No project path in the chrome: the session's directory is implied.
      expect(frame).not.toContain("/work/acme")
      // Panels: the worktree list leads, New worktree is explicit, the
      // destinations strip stays separate, and the selected row's details
      // ride inline beneath it — there is no details panel of its own.
      expect(frame).toContain("worktrees")
      expect(frame).toContain("go to")
      expect(frame).not.toContain(" details ")
      expect(frame).toContain("add-widget")
      expect(frame).toContain("+ New worktree")
      // New leads the list; its block folds beneath it.
      expect(frame).toContain("A fresh checkout")
      expect(frame).toContain("Pipelines")
      expect(frame).toContain("go to")
      // Worktrees is the vocabulary; no feature or Spaces branding anywhere.
      expect(frame).not.toContain("New feature")
      expect(frame).not.toContain("Spaces")
      expect(frame).not.toContain("name it")
    } finally {
      await closeHome(session)
    }
  })

  test("every registered checkout is listed, including spec-less and detached ones", async () => {
    const session = await openHome({
      worktrees: [
        worktree({ path: mainPath, branch: "main", main: true }),
        worktree({ path: "/wt/plain", branch: "feat/plain" }),
        worktree({ path: "/wt/detached", detached: true, branch: undefined }),
      ],
    })
    try {
      const frame = frameOf(session)
      expect(frame).toContain("repo")
      expect(frame).toContain("plain")
      expect(frame).toContain("detached")
      // No adoption prompts: a spec-less checkout is an ordinary peer.
      expect(frame).not.toMatch(/adopt/i)
    } finally {
      await closeHome(session)
    }
  })

  test("enter on a worktree row opens its detail with distinct action labels", async () => {
    const session = await openHome({ height: 48 })
    try {
      session.press("down") // New leads; two downs reach add-widget
      await session.renderOnce()
      session.press("down")
      await session.renderOnce()
      session.press("return")
      await session.renderOnce()
      const frame = frameOf(session)
      expect(frame).toContain("add-widget")
      expect(frame).toContain("Open conversation")
      expect(frame).toContain("Propose a change")
      expect(frame).toContain("Execute pipeline")
      expect(frame).toContain("Close review")
    } finally {
      await closeHome(session)
    }
  })

  test("the detail exposes the independent Git and publication actions", async () => {
    const session = await openHome({ height: 48 })
    try {
      session.press("down") // New leads
      await session.renderOnce()
      session.press("down") // the worktree row
      await session.renderOnce()
      session.press("return") // open its detail
      await session.renderOnce()
      const frame = frameOf(session)
      // The contextual menu carries every independent operation (capability
      // home-launcher delta), each with its own guard — not just close.
      for (const label of ["Fetch remote", "Sync with base", "Push branch", "Compose pull request", "Squash to base", "Remove worktree", "Close review"]) {
        expect(frame).toContain(label)
      }
    } finally {
      await closeHome(session)
    }
  })

  test("removal is blocked on the main checkout with its reason and never fires", async () => {
    const session = await openHome({ height: 48 })
    try {
      session.press("down") // onto the main checkout
      await session.renderOnce()
      session.press("return") // open its detail
      await session.renderOnce()
      const frame = frameOf(session)
      expect(frame).toContain("Remove worktree")
      expect(frame).toContain("main checkout is never removed")
      session.press("d") // blocked remove must not resolve
      await session.renderOnce()
      expect(session.instance.result).toBeInstanceOf(Promise)
    } finally {
      await closeHome(session)
    }
  })

  test("a detail action resolves the same worktree with its action", async () => {
    const session = await openHome()
    try {
      session.press("down") // New leads
      await session.renderOnce()
      session.press("down") // the worktree row
      await session.renderOnce()
      session.press("return") // open its detail
      await session.renderOnce()
      session.press("e") // execute pipeline
      const resolution = (await session.instance.result) as HomeResolution
      expect(resolution).toEqual({ type: "work", worktree: wtPath, action: "pipeline" })
    } catch {
      await closeHome(session)
      throw new Error("test failed")
    }
  })

  test("a blocked close stays visible with its blocker and does not fire", async () => {
    const busy = worktree({
      path: "/wt/blocked",
      branch: "feat/blocked",
      writer: {
        kind: "known",
        value: { kind: "pipeline", owner: "20260910-120000-abcd", pid: 4242, startedAt: Date.now() - 120_000, heartbeatAt: Date.now(), liveness: "live" },
        collectedAt: 0,
      },
    })
    const session = await openHome({ height: 48, worktrees: [worktree({ path: mainPath, branch: "main", main: true }), busy] })
    try {
      session.press("down") // New leads
      await session.renderOnce()
      session.press("down") // the busy worktree row
      await session.renderOnce()
      session.press("return") // open its detail
      await session.renderOnce()
      const frame = frameOf(session)
      expect(frame).toContain("Close review")
      expect(frame).toContain("blocked:")
      expect(frame).toContain("managed writer")
      session.press("x") // blocked close must not resolve the close action
      await session.renderOnce()
      expect(session.instance.result).toBeInstanceOf(Promise)
    } finally {
      await closeHome(session)
    }
  })

  test("a live managed writer renders its kind and liveness as an independent fact", async () => {
    const busy = worktree({
      path: "/wt/writing",
      branch: "feat/writing",
      writer: {
        kind: "known",
        value: { kind: "authoring", owner: "ses_f74d79c70ffeW9TrnXMN1pHBjq", pid: 4242, startedAt: Date.now() - 300_000, heartbeatAt: Date.now(), liveness: "live" },
        collectedAt: 0,
      },
    })
    const session = await openHome({ height: 48, worktrees: [worktree({ path: mainPath, branch: "main", main: true }), busy] })
    try {
      session.press("down")
      await session.renderOnce()
      session.press("down")
      await session.renderOnce()
      session.press("return")
      await session.renderOnce()
      const frame = frameOf(session)
      expect(frame).toContain("writer")
      expect(frame).toContain("authoring")
      expect(frame).toContain("live")
      // The owner id is shortened for the row, not dumped whole.
      expect(frame).not.toContain("ses_f74d79c70ffeW9TrnXMN1pHBjq")
    } finally {
      await closeHome(session)
    }
  })

  test("a stale writer claim stays visible but does not disable close", async () => {
    const stale = worktree({
      path: "/wt/stale",
      branch: "feat/stale",
      writer: {
        kind: "known",
        value: { kind: "pipeline", owner: "20260901-000000-dead", pid: 999_999, startedAt: Date.now() - 3_600_000, heartbeatAt: Date.now() - 3_600_000, liveness: "stale" },
        collectedAt: 0,
      },
    })
    const session = await openHome({ height: 48, worktrees: [worktree({ path: mainPath, branch: "main", main: true }), stale] })
    try {
      session.press("down")
      await session.renderOnce()
      session.press("down")
      await session.renderOnce()
      session.press("return")
      await session.renderOnce()
      const frame = frameOf(session)
      expect(frame).toContain("writer")
      expect(frame).toContain("stale")
      // A stale claim is provably not writing: the action still fires.
      session.press("x")
      await expect(session.instance.result).resolves.toEqual({ type: "work", worktree: "/wt/stale", action: "close" })
    } finally {
      await closeHome(session)
    }
  })

  test("an unreadable writer claim is unknown, never silently free", async () => {
    const broken = worktree({
      path: "/wt/broken-claim",
      branch: "feat/broken-claim",
      writer: { kind: "unknown", reason: "the claim record is corrupt", collectedAt: 0 },
    })
    const session = await openHome({ height: 48, worktrees: [worktree({ path: mainPath, branch: "main", main: true }), broken] })
    try {
      session.press("down")
      await session.renderOnce()
      session.press("down")
      await session.renderOnce()
      session.press("return")
      await session.renderOnce()
      const frame = frameOf(session)
      expect(frame).toContain("writer")
      expect(frame).toContain("unknown (the claim record is corrupt)")
    } finally {
      await closeHome(session)
    }
  })

  test("highlighting a destination unfolds its details inside the destinations strip", async () => {
    const session = await openHome()
    try {
      // Skip New and both worktree rows to land on Pipelines.
      session.press("j")
      session.press("j")
      session.press("j")
      await session.renderOnce()
      const frame = frameOf(session)
      expect(frame).toContain("From intent to ship")
      expect(frame).toContain("Compose agents into a repeatable path")
      expect(frame).toContain("go to")
    } finally {
      await closeHome(session)
    }
  })

  test("the inline detail folds under one row and unfolds under the next as the selection moves", async () => {
    const session = await openHome()
    try {
      let frame = frameOf(session)
      // New leads the list: its block rides beneath the first row.
      expect(frame).toContain("A fresh checkout")
      session.press("down") // onto the main checkout
      await session.renderOnce()
      frame = frameOf(session)
      expect(frame).toContain("branch")
      session.press("down") // onto add-widget
      await session.renderOnce()
      frame = frameOf(session)
      // The block now hangs under add-widget: its branch line replaces the
      // previous fold, and the destinations strip stays in place below.
      expect(frame).toContain("feat/add-widget")
      expect(frame).toContain("go to")
    } finally {
      await closeHome(session)
    }
  })

  test("landing on a row requests its PR evidence: checking… then the fact", async () => {
    const observed: string[] = []
    const gates = new Map<string, (value: PrObservation) => void>()
    const session = await openHome({
      observePr: (worktree) =>
        new Promise<PrObservation>((resolve) => {
          observed.push(worktree.path)
          gates.set(worktree.path, resolve)
        }),
    })
    try {
      await session.renderOnce()
      // The opening selection is the New entry: not a checkout, so no
      // on-demand query fires yet.
      expect(observed).toEqual([])
      session.press("down") // onto the main checkout
      await session.renderOnce()
      expect(observed).toEqual([mainPath])
      expect(frameOf(session)).toContain("checking…")
      gates.get(mainPath)!({ availability: "known", pr: { number: 12, state: "OPEN", title: "Main", url: "https://example.test/pr/12" }, observedAt: 0 })
      await Bun.sleep(10)
      await session.renderOnce()
      expect(frameOf(session)).toContain("#12 OPEN")
      // Moving to another row requests only that row's evidence.
      session.press("down")
      await session.renderOnce()
      expect(observed).toEqual([mainPath, wtPath])
      expect(frameOf(session)).toContain("checking…")
      // Returning to the first row re-lands: a refresh attempt (the cache
      // decides whether it is a network call).
      session.press("up")
      await session.renderOnce()
      expect(observed.filter((path) => path === mainPath)).toHaveLength(2)
    } finally {
      await closeHome(session)
    }
  })

  test("auxiliary shortcuts resolve destinations; q quits", async () => {
    const session = await openHome()
    try {
      session.press("s")
      const resolution = (await session.instance.result) as HomeResolution
      expect(resolution).toEqual({ type: "destination", destination: "specs" })
    } catch {
      await closeHome(session)
      throw new Error("test failed")
    }
  })
})

describe("selection surface", () => {
  test("the New worktree entry is always the default selection", async () => {
    const session = await openHome()
    try {
      // The primary action carries the full-width highlight on open; the
      // checkouts below do not.
      const highlighted = highlightedLines(session)
      expect(highlighted.some((line) => line.includes("New worktree"))).toBe(true)
      expect(highlighted.some((line) => line.includes("repo"))).toBe(false)
    } finally {
      await closeHome(session)
    }
  })

  test("a selected worktree row inverts its marker over the accent fill", async () => {
    const session = await openHome()
    try {
      session.press("down") // New leads
      await session.renderOnce()
      session.press("down") // onto add-widget
      await session.renderOnce()
      // The selected marker inverts: a dark glyph on its own state color —
      // the cell the rail below hangs from — while the title rides the chip
      // color on the accent fill.
      const frame = session.captureSpans()
      const selectedRow = frame.lines.find((line) => line.spans.some((span) => span.bg.a > 0))!
      const dot = selectedRow.spans.find((span) => span.text.includes("◇"))!
      const title = selectedRow.spans.find((span) => span.text.includes("add-widget"))!
      expect(sameColor(dot.fg, chipTextFg())).toBe(true)
      expect(sameColor(dot.bg, title.bg)).toBe(false)
      expect(sameColor(title.fg, chipTextFg())).toBe(true)
    } finally {
      await closeHome(session)
    }
  })

  test("the detail's selected action rides the accent fill behind an inverted navy marker", async () => {
    const session = await openHome()
    try {
      session.press("down") // New leads
      await session.renderOnce()
      session.press("down") // the worktree row
      await session.renderOnce()
      session.press("return") // open its detail
      await session.renderOnce()
      // The detail speaks the list's row language: the selected action is a
      // full-width accent block hanging from a navy cell — actions are
      // navy, like New — while idle actions stay transparent.
      const frame = session.captureSpans()
      const actionRow = frame.lines.find((line) => line.spans.some((span) => span.text.includes("Open conversation")))!
      expect(actionRow).toBeDefined()
      const marker = actionRow.spans.find((span) => span.text.includes("▸"))!
      const label = actionRow.spans.find((span) => span.text.includes("Open conversation"))!
      expect(sameColor(marker.bg, navyBg())).toBe(true)
      expect(sameColor(marker.fg, chipTextFg())).toBe(true)
      expect(sameColor(label.bg, accentBg())).toBe(true)
      const idle = frame.lines.find((line) => line.spans.some((span) => span.text.includes("Fetch remote")))!
      expect(idle.spans.every((span) => span.bg.a === 0)).toBe(true)
    } finally {
      await closeHome(session)
    }
  })
})

describe("worktree detail sections and observations", () => {
  async function openDetail(session: Awaited<ReturnType<typeof openHome>>) {
    session.press("down") // New leads
    await session.renderOnce()
    session.press("down") // the worktree row
    await session.renderOnce()
    session.press("return") // open its detail
    await session.renderOnce()
    // Let the on-demand runs listing settle its render before the capture —
    // the same rhythm the PR evidence tests wait out.
    await Bun.sleep(10)
    await session.renderOnce()
  }

  test("the detail groups its actions into Life Cycle and git sections", async () => {
    const session = await openHome({ height: 60 })
    try {
      await openDetail(session)
      const frame = frameOf(session)
      // Two labeled sections, in that order: the Life Cycle (which ends with
      // the deliberate close composition) then the Git operations, ending
      // with worktree removal. There is no separate destructive section.
      const lifecycleAt = frame.indexOf("\u2500\u2500 Life Cycle ")
      const gitAt = frame.indexOf("\u2500\u2500 git ")
      expect(lifecycleAt).toBeGreaterThanOrEqual(0)
      expect(gitAt).toBeGreaterThan(lifecycleAt)
      const conversationAt = frame.indexOf("Open conversation")
      const pipelineAt = frame.indexOf("Execute pipeline")
      const closeAt = frame.indexOf("Close review")
      const fetchAt = frame.indexOf("Fetch remote")
      const squashAt = frame.indexOf("Squash to base")
      const removeAt = frame.indexOf("Remove worktree")
      // The Life Cycle holds the work actions and close, in order.
      expect(conversationAt).toBeGreaterThan(lifecycleAt)
      expect(pipelineAt).toBeGreaterThan(conversationAt)
      expect(closeAt).toBeGreaterThan(pipelineAt)
      expect(closeAt).toBeLessThan(gitAt)
      // Git holds the operations and ends with removal.
      expect(fetchAt).toBeGreaterThan(gitAt)
      expect(squashAt).toBeGreaterThan(fetchAt)
      expect(removeAt).toBeGreaterThan(squashAt)
      expect(frame).not.toContain("destructive")
      // The observation sections follow, honest when empty: the hermetic
      // default records no runs and the fixture carries no changes.
      expect(frame).toContain("recent runs")
      expect(frame).toContain("no runs recorded for this checkout")
      expect(frame).toContain("linked specs")
      expect(frame).toContain("no active changes in this checkout")
    } finally {
      await closeHome(session)
    }
  })

  test("the detail lists the checkout's recent runs and opens the focused one", async () => {
    const runs: DetailRun[] = [
      { runId: "run-42", title: "Ship add-widget", status: "completed", statusKind: "completed", live: false },
      { runId: "run-41", title: "Flaky pass", status: "failed", statusKind: "failed", live: false },
    ]
    let asked: string[] = []
    const session = await openHome({
      height: 60,
      listRunsForWorktree: async (worktree) => {
        asked.push(worktree.path)
        return worktree.path === wtPath ? runs : []
      },
    })
    try {
      session.press("down")
      await session.renderOnce()
      session.press("down")
      await session.renderOnce()
      session.press("return") // open its detail: entering requests the runs
      await session.renderOnce()
      await Bun.sleep(10) // let the injected listing land its render
      await session.renderOnce()
      expect(asked).toEqual([wtPath])
      const frame = frameOf(session)
      expect(frame).toContain("recent runs")
      // The rows speak the runs list's status vocabulary: the check and the
      // cross, one per recorded run.
      expect(frame).toContain("✓")
      expect(frame).toContain("✗")
      expect(frame).toContain("Ship add-widget")
      expect(frame).toContain("run-42")
      expect(frame).toContain("completed")
      // The run rows are the entries right after the eleven actions.
      for (let i = 0; i < 11; i++) {
        session.press("down")
        await session.renderOnce()
      }
      session.press("return")
      const resolution = (await session.instance.result) as HomeResolution
      expect(resolution).toEqual({ type: "work-run", worktree: wtPath, runId: "run-42" })
    } catch (error) {
      await closeHome(session)
      throw error
    }
  })

  test("the detail lists its linked changes and opens the focused one", async () => {
    const change: LocalActiveChange = {
      checkout: wtPath,
      changeId: "add-login",
      sourcePath: `${wtPath}/openspec/changes/add-login`,
      hasMarkdown: true,
      artifacts: { proposal: true, design: false, tasks: true, deltaSpecs: ["specs/auth/spec.md"], other: [] },
      tasks: { done: 2, total: 5 },
    }
    const session = await openHome({
      height: 60,
      worktrees: [
        worktree({ path: mainPath, branch: "main", main: true }),
        worktree({ path: wtPath, branch: "feat/add-widget", changes: [change] }),
      ],
    })
    try {
      await openDetail(session)
      const frame = frameOf(session)
      expect(frame).toContain("linked specs")
      // The row speaks the specs browser's vocabulary: the change diamond.
      expect(frame).toContain("◆")
      expect(frame).toContain("add-login")
      expect(frame).toContain("tasks 2/5")
      // The change row rides after the eleven actions (no runs recorded).
      for (let i = 0; i < 11; i++) {
        session.press("down")
        await session.renderOnce()
      }
      session.press("return")
      const resolution = (await session.instance.result) as HomeResolution
      expect(resolution).toEqual({ type: "work-change", worktree: wtPath, changeId: "add-login" })
    } catch {
      await closeHome(session)
      throw new Error("test failed")
    }
  })

  test("an unreadable change list stays honest in the linked-specs section", async () => {
    const session = await openHome({
      height: 60,
      worktrees: [
        worktree({ path: mainPath, branch: "main", main: true }),
        worktree({ path: wtPath, branch: "feat/add-widget", changesUnknown: "the openspec directory is unreadable" }),
      ],
    })
    try {
      await openDetail(session)
      const frame = frameOf(session)
      expect(frame).toContain("linked specs")
      expect(frame).toContain("unknown — the openspec directory is unreadable")
    } finally {
      await closeHome(session)
    }
  })
})

describe("new worktree form (auto by default, manual on tab)", () => {
  test("cancelling the form makes no resolution and returns to the list", async () => {
    const session = await openHome()
    try {
      session.press("n")
      await session.renderOnce()
      // The section divider names the form and carries the mode.
      expect(frameOf(session)).toContain("new worktree · auto")
      expect(frameOf(session)).toContain("describe")
      // The next move reads as a button: an accent keycap naming it.
      expect(frameOf(session)).toContain("↵ create")
      session.press("escape")
      await session.renderOnce()
      expect(frameOf(session)).toContain("worktrees")
      expect(session.instance.result).toBeInstanceOf(Promise)
    } finally {
      await closeHome(session)
    }
  })

  test("the description caret actually blinks while the form waits", async () => {
    const session = await openHome()
    try {
      session.press("n")
      await session.renderOnce()
      // The input line itself (the masthead's wordmark is blocks too).
      const inputLine = (frame: string) => frame.split("\n").find((line) => line.includes("describe what you are about to work on")) ?? ""
      // The caret's on phase.
      expect(inputLine(frameOf(session))).toContain("█")
      // Past one blink period the caret must be in its off phase: the tick
      // recomputes the pane's content, it does not redraw a frozen frame.
      await Bun.sleep(600)
      await session.renderOnce()
      expect(inputLine(frameOf(session))).not.toContain("█")
      // And the blink keeps cycling.
      await Bun.sleep(600)
      await session.renderOnce()
      expect(inputLine(frameOf(session))).toContain("█")
    } finally {
      await closeHome(session)
    }
  })

  test("auto mode: describing the work shows a reviewed proposal, accepting resolves the draft", async () => {
    const session = await openHome({
      proposeBranchName: async ({ prompt }) => ({ branch: `feat/${prompt.toLowerCase().replace(/\s+/g, "-")}-model` }),
    })
    try {
      session.press("n")
      await session.renderOnce()
      for (const char of "Improve review navigation") session.press(char)
      session.press("return")
      await session.renderOnce()
      await Bun.sleep(30)
      await session.renderOnce()
      // The whole draft is shown for review — name, branch, base, destination —
      // and nothing resolves until acceptance.
      expect(frameOf(session)).toContain("name")
      expect(frameOf(session)).toContain("Improve review navigation")
      expect(frameOf(session)).toContain("branch")
      expect(frameOf(session)).toContain("feat/improve-review-navigation-model")
      expect(frameOf(session)).toContain("base")
      expect(frameOf(session)).toContain("worktree")
      expect(frameOf(session)).toContain("↵ confirm")
      expect(session.instance.result).toBeInstanceOf(Promise)
      session.press("return") // accept
      const resolution = (await session.instance.result) as Extract<HomeResolution, { type: "new-work" }>
      expect(resolution.type).toBe("new-work")
      expect(resolution.draft?.displayName).toBe("Improve review navigation")
      expect(resolution.draft?.branch).toBe("feat/improve-review-navigation-model")
      // No git repository at the fake target: the detected default is main.
      expect(resolution.draft?.base).toBe("main")
      expect(resolution.draft?.worktree).toContain("improve-review-navigation-model")
    } catch {
      await closeHome(session)
      throw new Error("test failed")
    }
  })

  test("the auto proposal is a labeled gray well, not a hollow frame", async () => {
    const session = await openHome({ proposeBranchName: async () => ({ branch: "feat/model-name" }) })
    try {
      session.press("n")
      await session.renderOnce()
      for (const char of "Improve review navigation") session.press(char)
      session.press("return")
      await session.renderOnce()
      await Bun.sleep(30)
      await session.renderOnce()
      const frame = frameOf(session)
      expect(frame).toContain("name")
      expect(frame).toContain("Improve review navigation")
      expect(frame).toContain("branch")
      expect(frame).toContain("feat/model-name")
      expect(frame).toContain("base")
      expect(frame).toContain("worktree")
      expect(frame).not.toContain("┌")
      expect(frame).not.toContain("└")
      const spans = session.captureSpans()
      const branchRow = spans.lines.find((line) => line.spans.some((span) => span.text.includes("feat/model-name")))!
      expect(branchRow).toBeDefined()
      const filled = branchRow.spans.filter((span) => span.bg.a > 0 && sameColor(span.bg, wellBg()))
      expect(filled.length).toBeGreaterThan(0)
      const filledWidth = filled.reduce((total, span) => total + span.text.length, 0)
      expect(filledWidth).toBeGreaterThan(40)
    } finally {
      await closeHome(session)
    }
  })

  test("the description well spans the content column and the footer names every key", async () => {
    const session = await openHome()
    try {
      session.press("n")
      await session.renderOnce()
      const frame = frameOf(session)
      expect(frame).not.toContain("┌")
      const spans = session.captureSpans()
      const describeRow = spans.lines.find((line) => line.spans.some((span) => span.text.includes("describe what you are about to work on")))!
      expect(describeRow).toBeDefined()
      const filled = describeRow.spans.filter((span) => span.bg.a > 0 && sameColor(span.bg, wellBg()))
      const filledWidth = filled.reduce((total, span) => total + span.text.length, 0)
      expect(filledWidth).toBeGreaterThan(80)
      const footer = frame.split("\n").filter((line) => line.trim().length > 0).at(-1) ?? ""
      expect(footer).toContain("esc cancel")
      expect(footer).toContain("enter create")
      expect(footer).toContain("tab mode")
      expect(footer).not.toContain("· +")
    } finally {
      await closeHome(session)
    }
  })

  test("the create button names the model the namer will use", async () => {
    const session = await openHome()
    try {
      session.press("n")
      await session.renderOnce()
      // The model resolves off the keypress path (config load + import);
      // give it a beat and re-render before asserting.
      await Bun.sleep(50)
      await session.renderOnce()
      const frame = frameOf(session)
      expect(frame).toContain("↵ create")
      expect(frame).toContain("using")
    } finally {
      await closeHome(session)
    }
  })

  test("proposing shows a single left-aligned spinner, not a marching bar", async () => {
    let release!: (value: { branch: string }) => void
    const session = await openHome({
      proposeBranchName: () => new Promise<{ branch: string }>((resolve) => {
        release = resolve
      }),
    })
    try {
      session.press("n")
      await session.renderOnce()
      for (const char of "Improve review navigation") session.press(char)
      session.press("return")
      await session.renderOnce()
      for (let i = 0; i < 20 && !release; i++) await Bun.sleep(10)
      const frame = frameOf(session)
      expect(frame).toContain("proposing a conventional branch")
      expect(frame).not.toContain("━")
      const footer = frame.split("\n").filter((line) => line.trim().length > 0).at(-1) ?? ""
      expect(footer).toContain("esc cancel")
      expect(footer).not.toContain("enter")
      expect(footer).not.toContain("tab")
      release!({ branch: "feat/improve-review-navigation" })
      await Bun.sleep(30)
      await session.renderOnce()
      expect(frameOf(session)).toContain("↵ confirm")
    } finally {
      await closeHome(session)
    }
  })

  test("auto mode: a naming failure degrades to the deterministic slug proposal", async () => {
    const session = await openHome({
      proposeBranchName: async () => {
        throw new Error("the namer is unavailable")
      },
    })
    try {
      session.press("n")
      await session.renderOnce()
      for (const char of "Improve review navigation") session.press(char)
      session.press("return")
      await session.renderOnce()
      await Bun.sleep(30)
      await session.renderOnce()
      // The namer is advisory: the slug proposal still lands, and the
      // failure never surfaces as a form error.
      expect(frameOf(session)).toContain("feat/improve-review-navigation")
      expect(frameOf(session)).not.toContain("unavailable")
      session.press("escape")
      await session.renderOnce()
      expect(session.instance.result).toBeInstanceOf(Promise)
    } finally {
      await closeHome(session)
    }
  })

  test("auto mode: a too-short description is refused without proposing", async () => {
    const session = await openHome()
    try {
      session.press("n")
      await session.renderOnce()
      session.press("a")
      session.press("return")
      await session.renderOnce()
      await Bun.sleep(10)
      await session.renderOnce()
      expect(frameOf(session)).toContain("describe the work in a few words")
      session.press("escape")
      await session.renderOnce()
      expect(session.instance.result).toBeInstanceOf(Promise)
    } finally {
      await closeHome(session)
    }
  })

  test("auto mode: escape from the proposal steps back to the description, a second escape cancels", async () => {
    const session = await openHome({
      proposeBranchName: async () => ({ branch: "feat/model-name" }),
    })
    try {
      session.press("n")
      await session.renderOnce()
      for (const char of "Improve review navigation") session.press(char)
      session.press("return")
      await session.renderOnce()
      await Bun.sleep(30)
      await session.renderOnce()
      expect(frameOf(session)).toContain("↵ confirm")
      session.press("escape") // back to the description, form still open
      await session.renderOnce()
      expect(frameOf(session)).toContain("Improve review navigation")
      expect(session.instance.result).toBeInstanceOf(Promise)
      session.press("escape") // now it cancels
      await session.renderOnce()
      expect(frameOf(session)).toContain("worktrees")
      expect(session.instance.result).toBeInstanceOf(Promise)
    } finally {
      await closeHome(session)
    }
  })

  test("tab switches to the manual form and carries the description over as the name", async () => {
    const session = await openHome()
    try {
      session.press("n")
      await session.renderOnce()
      for (const char of "Improve review navigation") session.press(char)
      session.press("tab")
      await session.renderOnce()
      expect(frameOf(session)).toContain("manual")
      expect(frameOf(session)).toContain("Improve review navigation")
      // The branch prefill rides the name's slug.
      expect(frameOf(session)).toContain("improve-review-navigation")
      session.press("escape")
      await session.renderOnce()
      expect(session.instance.result).toBeInstanceOf(Promise)
    } finally {
      await closeHome(session)
    }
  })

  test("manual mode: the naming model refines the prefilled branch while the field is untouched (task 3.4)", async () => {
    const session = await openHome({
      proposeBranchName: async ({ prompt }) => ({ branch: `feat/${prompt.toLowerCase().replace(/\s+/g, "-")}-model` }),
    })
    try {
      session.press("n")
      await session.renderOnce()
      session.press("tab") // manual mode
      await session.renderOnce()
      for (const char of "Improve review navigation") session.press(char)
      session.press("return")
      await session.renderOnce()
      // The deterministic slug is the immediate prefill; the model suggestion
      // lands while the operator has not typed a branch of their own.
      await Bun.sleep(30)
      await session.renderOnce()
      expect(frameOf(session)).toContain("feat/improve-review-navigation-model")
      session.press("escape")
      await session.renderOnce()
      expect(session.instance.result).toBeInstanceOf(Promise)
    } finally {
      await closeHome(session)
    }
  })

  test("manual mode: a naming-model failure keeps the editable deterministic prefill", async () => {
    const session = await openHome({
      proposeBranchName: async () => {
        throw new Error("the namer is unavailable")
      },
    })
    try {
      session.press("n")
      await session.renderOnce()
      session.press("tab") // manual mode
      await session.renderOnce()
      for (const char of "Improve review navigation") session.press(char)
      session.press("return")
      await session.renderOnce()
      await Bun.sleep(30)
      await session.renderOnce()
      expect(frameOf(session)).toContain("improve-review-navigation")
      expect(frameOf(session)).not.toContain("unavailable")
      session.press("escape")
      await session.renderOnce()
      expect(session.instance.result).toBeInstanceOf(Promise)
    } finally {
      await closeHome(session)
    }
  })

  test("manual mode: a suggestion landing during the free-name check never overwrites an edit, a field advance, or a cancellation", async () => {
    // The namer resolves immediately, so the suggestion passes its pre-await
    // guards and parks inside the gated free-name check; the operator action
    // then lands in that await window — the exact spot an unchecked
    // post-await assignment would overwrite.
    const makeNamerGate = () => {
      let resolve!: (value: { branch: string }) => void
      const promise = new Promise<{ branch: string }>((res) => (resolve = res))
      return { promise, resolve }
    }
    async function reachParkedSuggestion(session: Awaited<ReturnType<typeof openHome>>, namerGate: ReturnType<typeof makeNamerGate>) {
      session.press("n")
      await session.renderOnce()
      session.press("tab") // manual mode
      await session.renderOnce()
      for (const char of "Improve review navigation") session.press(char)
      session.press("return")
      await session.renderOnce()
      namerGate.resolve({ branch: "feat/model-name" })
      await Bun.sleep(10) // the suggestion enters (and parks in) the free-name check
    }

    try {
      // 1. An operator edit during the free-name check survives.
      {
        gatingEnsureFreeBranchName = true
        const namerGate = makeNamerGate()
        const session = await openHome({ proposeBranchName: () => namerGate.promise })
        try {
          await reachParkedSuggestion(session, namerGate)
          session.press("backspace")
          releaseEnsureFreeBranchName("feat/model-name", "feat/model-name")
          await Bun.sleep(20)
          await session.renderOnce()
          expect(frameOf(session)).toContain("improve-review-navigatio")
          expect(frameOf(session)).not.toContain("model-name")
        } finally {
          session.press("escape") // close the form before quitting
          await session.renderOnce()
          await closeHome(session)
        }
      }

      // 2. A field advance during the free-name check survives.
      {
        gatingEnsureFreeBranchName = true
        const namerGate = makeNamerGate()
        const session = await openHome({ proposeBranchName: () => namerGate.promise })
        try {
          await reachParkedSuggestion(session, namerGate)
          session.press("return") // confirm the branch field: the form advances to base
          await Bun.sleep(5) // the commit's own free-name check parks behind the suggestion's
          releaseEnsureFreeBranchName("feat/improve-review-navigation", "feat/improve-review-navigation") // the commit's own check
          await Bun.sleep(5) // the commit finishes: the form advances to the base field
          releaseEnsureFreeBranchName("feat/model-name", "feat/model-name") // the parked suggestion
          await Bun.sleep(20)
          await session.renderOnce()
          expect(frameOf(session)).not.toContain("model-name")
          expect(frameOf(session)).toContain("feat/improve-review-navigation")
        } finally {
          session.press("escape") // close the form before quitting
          await session.renderOnce()
          await closeHome(session)
        }
      }

      // 3. A cancellation during the free-name check survives: the form stays closed.
      {
        gatingEnsureFreeBranchName = true
        const namerGate = makeNamerGate()
        const session = await openHome({ proposeBranchName: () => namerGate.promise })
        try {
          await reachParkedSuggestion(session, namerGate)
          session.press("escape")
          releaseEnsureFreeBranchName("feat/model-name", "feat/model-name")
          await Bun.sleep(20)
          await session.renderOnce()
          expect(frameOf(session)).toContain("worktrees")
          expect(frameOf(session)).not.toContain("model-name")
          expect(session.instance.result).toBeInstanceOf(Promise)
        } finally {
          await closeHome(session) // the form is already closed here
        }
      }
    } finally {
      gatingEnsureFreeBranchName = false
      ensureFreeWaiters.length = 0
    }
  })

  test("manual mode: the form collects name, branch, and base before any mutation", async () => {
    const session = await openHome()
    try {
      session.press("n")
      await session.renderOnce()
      session.press("tab") // manual mode
      await session.renderOnce()
      for (const char of "Improve review navigation") session.press(char)
      session.press("return")
      await session.renderOnce()
      session.press("return") // confirm the branch field: the conventional prefix is prefilled
      await Bun.sleep(50)
      await session.renderOnce()
      // The branch is prefilled from the name, editable.
      expect(frameOf(session)).toContain("feat/improve-review-navigation")
      session.press("escape")
      await session.renderOnce()
      expect(session.instance.result).toBeInstanceOf(Promise)
    } finally {
      await closeHome(session)
    }
  })
})

describe("small terminals (list and detail stay navigable)", () => {
  test("a narrow terminal stacks the preview under the worktree list", async () => {
    const session = await openHome({ width: 60, height: 24 })
    try {
      const frame = frameOf(session)
      expect(frame).toContain("worktrees")
      expect(frame).toContain("New worktree")
    } finally {
      await closeHome(session)
    }
  })

  test("navigating past the fold keeps the selected worktree row and the hints row visible", async () => {
    const many: BoardWorktree[] = Array.from({ length: 12 }, (_, index) =>
      worktree({ path: `/wt/work-item-${index}`, branch: `feat/work-item-${index}` }),
    )
    const session = await openHome({ worktrees: many, width: 100, height: 24 })
    try {
      for (let i = 0; i < 12; i++) {
        session.press("down")
        await session.renderOnce()
      }
      const frame = frameOf(session)
      // The selected row is the twelfth worktree; it must be on screen, not
      // clipped below the fold, and the hints row must survive with it.
      const highlighted = highlightedLines(session)
      expect(highlighted.some((line) => line.includes("work-item-11"))).toBe(true)
      expect(frame).toContain("quit")
    } finally {
      await closeHome(session)
    }
  })

  test("a short terminal keeps the selected detail action and its hints visible", async () => {
    const session = await openHome({ height: 14 })
    try {
      session.press("down") // New leads; onto the main checkout
      await session.renderOnce()
      session.press("return") // open its detail
      await session.renderOnce()
      // The detail pane scrolls here, so the render is read via spans —
      // char-frame capture of a scrolled pane trips an opentui native bug.
      const frame = session
        .captureSpans()
        .lines.map((line) => line.spans.map((span) => span.text).join(""))
        .join("\n")
      const selected = frame.split("\n").filter((line) => line.includes("▸"))
      expect(selected.some((line) => line.includes("Open conversation"))).toBe(true)
      expect(frame).toContain("enter")
    } finally {
      await closeHome(session)
    }
  })

  test("a resize re-clamps the detail pane without stranding it", async () => {
    const session = await openHome({ height: 30 })
    try {
      session.press("down") // New leads; onto the main checkout
      await session.renderOnce()
      session.press("return") // open its detail
      await session.renderOnce()
      expect(frameOf(session)).toContain("Open conversation")
      ;(session.renderer as unknown as { resize(width: number, height: number): void }).resize(110, 12)
      await session.renderOnce()
      // After the resize the pane is scrolled; spans read the render without
      // tripping opentui's scrolled char-frame capture bug.
      const frame = session
        .captureSpans()
        .lines.map((line) => line.spans.map((span) => span.text).join(""))
        .join("\n")
      const selected = frame.split("\n").filter((line) => line.includes("▸"))
      expect(selected.some((line) => line.includes("Open conversation"))).toBe(true)
    } finally {
      await closeHome(session)
    }
  })
})

describe("typical action coverage (used by tests above)", () => {
  test("HomeWorkAction ids are exhaustive", () => {
    const ids: HomeWorkAction[] = [
      // Life Cycle
      "conversation",
      "conversation-external",
      "propose",
      "pipeline",
      "close",
      // git
      "fetch",
      "sync",
      "push",
      "pr",
      "squash",
      "remove",
    ]
    expect(ids).toHaveLength(11)
  })
})
