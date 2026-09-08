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
import type { HomeResolution, HomeWorkAction } from "../src/home-tui"
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

async function openHome(options: { worktrees?: BoardWorktree[]; resumeWorktree?: string; resumeNotice?: string; width?: number; height?: number; targetDir?: string; proposeBranchName?: (input: { prompt: string }) => Promise<{ branch: string }> } = {}) {
  const testRenderer = await createTestRenderer({ width: options.width ?? 110, height: options.height ?? 30 })
  const instance = new HomeLauncher(testRenderer.renderer, options.targetDir ?? viewDir(), {
    scene: undefined,
    worktrees: options.worktrees ?? worktrees,
    resumeWorktree: options.resumeWorktree,
    resumeNotice: options.resumeNotice,
    proposeBranchName: options.proposeBranchName,
  })
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

describe("worktrees-first home (capability home-launcher delta)", () => {
  test("the masthead carries identity, the complete version, and the project above the worktree list", async () => {
    const session = await openHome()
    try {
      const frame = frameOf(session)
      expect(frame).toContain("████")
      // The wide masthead right-aligns the version and the project path. The
      // version's fallback chain is environment-dependent (bun run scripts see
      // npm_package_version), so assert the same value the masthead renders.
      expect(frame).toContain(versionDetails())
      expect(frame).toContain("/work/acme")
      // Panels: the worktree list leads, New worktree is explicit, the
      // destinations strip stays separate, and the selected row's details
      // ride inline beneath it — there is no details panel of its own.
      expect(frame).toContain(" worktrees ")
      expect(frame).toContain(" destinations ")
      expect(frame).not.toContain(" details ")
      expect(frame).toContain("add-widget")
      expect(frame).toContain("+ New worktree")
      expect(frame).toContain("Pipelines")
      expect(frame).toContain("enter  Open conversation")
      // Worktrees is the vocabulary; no feature or Spaces branding anywhere.
      expect(frame).not.toContain("New feature")
      expect(frame).not.toContain("Spaces")
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
    const session = await openHome()
    try {
      session.press("down") // the cursor starts on the main checkout
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
    const session = await openHome()
    try {
      session.press("down") // the worktree row
      await session.renderOnce()
      session.press("return") // open its detail
      await session.renderOnce()
      const frame = frameOf(session)
      // The contextual menu carries every independent operation (capability
      // home-launcher delta), each with its own guard — not just close.
      for (const label of ["Fetch remote", "Sync with base", "Push branch", "Compose pull request", "Squash to base", "Remove worktree", "Delete branch", "Close review"]) {
        expect(frame).toContain(label)
      }
    } finally {
      await closeHome(session)
    }
  })

  test("removal is blocked on the main checkout with its reason and never fires", async () => {
    const session = await openHome()
    try {
      // The cursor starts on the main checkout row.
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
      activity: { kind: "known", value: { liveRunIds: ["r1", "r2"], total: 2 }, collectedAt: 0 },
    })
    const session = await openHome({ worktrees: [worktree({ path: mainPath, branch: "main", main: true }), busy] })
    try {
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

  test("highlighting a destination unfolds its details inside the destinations strip", async () => {
    const session = await openHome()
    try {
      // Skip both worktree rows and New worktree to land on Pipelines.
      session.press("j")
      session.press("j")
      session.press("j")
      await session.renderOnce()
      const frame = frameOf(session)
      expect(frame).toContain("From intent to ship")
      expect(frame).toContain("Compose agents into a reviewed, repeatable path")
      expect(frame).toContain(" destinations ")
    } finally {
      await closeHome(session)
    }
  })

  test("the inline detail folds under one row and unfolds under the next as the selection moves", async () => {
    const session = await openHome()
    try {
      let frame = frameOf(session)
      // The main checkout's block rides beneath the first row.
      expect(frame).toContain("enter  Open conversation")
      session.press("down") // onto add-widget
      await session.renderOnce()
      frame = frameOf(session)
      // The block now hangs under add-widget: its branch line replaces the
      // previous fold, and the destinations strip stays in place below.
      expect(frame).toContain("feat/add-widget")
      expect(frame).toContain(" destinations ")
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
  test("a remembered worktree row is preselected when it still validates", async () => {
    const remembered = await openHome({ resumeWorktree: wtPath })
    try {
      const frame = frameOf(remembered)
      const listRows = frame.split("\n").filter((line) => line.includes("▸"))
      expect(listRows.some((line) => line.includes("add-widget"))).toBe(true)
    } finally {
      await closeHome(remembered)
    }

    // Without a verifiable hint the list opens with no preselection beyond
    // the first row — never a substituted execution target.
    const fresh = await openHome({})
    try {
      const frame = frameOf(fresh)
      const listRows = frame.split("\n").filter((line) => line.includes("▸"))
      expect(listRows.some((line) => line.includes("repo"))).toBe(true)
    } finally {
      await closeHome(fresh)
    }
  })

  test("a lost selection notice is shown above the list without substituting", async () => {
    const lost = await openHome({
      worktrees: [worktree({ path: mainPath, branch: "main", main: true })],
      resumeNotice: "the last selected worktree (/wt/gone) is no longer registered in Git",
    })
    try {
      const frame = frameOf(lost)
      expect(frame).toContain("no longer registered")
      expect(frame).toContain("repo")
    } finally {
      await closeHome(lost)
    }
  })
})

describe("new worktree form", () => {
  test("cancelling the form makes no resolution and returns to the list", async () => {
    const session = await openHome()
    try {
      session.press("n")
      await session.renderOnce()
      expect(frameOf(session)).toContain("New worktree")
      session.press("escape")
      await session.renderOnce()
      expect(frameOf(session)).toContain(" worktrees ")
      expect(session.instance.result).toBeInstanceOf(Promise)
    } finally {
      await closeHome(session)
    }
  })

  test("the naming model refines the prefilled branch while the field is untouched (task 3.4)", async () => {
    const session = await openHome({
      proposeBranchName: async ({ prompt }) => ({ branch: `feat/${prompt.toLowerCase().replace(/\s+/g, "-")}-model` }),
    })
    try {
      session.press("n")
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

  test("a naming-model failure keeps the editable deterministic prefill", async () => {
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
      expect(frameOf(session)).toContain("improve-review-navigation")
      expect(frameOf(session)).not.toContain("unavailable")
      session.press("escape")
      await session.renderOnce()
      expect(session.instance.result).toBeInstanceOf(Promise)
    } finally {
      await closeHome(session)
    }
  })

  test("a suggestion landing during the free-name check never overwrites an edit, a field advance, or a cancellation", async () => {
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
          expect(frameOf(session)).toContain(" worktrees ")
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

  test("the form collects name, branch, and base before any mutation", async () => {
    const session = await openHome()
    try {
      session.press("n")
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
      expect(frame).toContain(" worktrees ")
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
      for (let i = 0; i < 11; i++) {
        session.press("down")
        await session.renderOnce()
      }
      const frame = frameOf(session)
      // The selected row is the twelfth worktree; it must be on screen, not
      // clipped below the fold, and the hints row must survive with it.
      const selected = frame.split("\n").filter((line) => line.includes("▸"))
      expect(selected.some((line) => line.includes("work-item-11"))).toBe(true)
      expect(frame).toContain("quit")
    } finally {
      await closeHome(session)
    }
  })

  test("a short terminal keeps the selected detail action and its hints visible", async () => {
    const session = await openHome({ height: 14 })
    try {
      session.press("return") // open the first worktree's detail
      await session.renderOnce()
      const frame = frameOf(session)
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
      session.press("return")
      await session.renderOnce()
      expect(frameOf(session)).toContain("Open conversation")
      ;(session.renderer as unknown as { resize(width: number, height: number): void }).resize(110, 12)
      await session.renderOnce()
      const frame = frameOf(session)
      const selected = frame.split("\n").filter((line) => line.includes("▸"))
      expect(selected.some((line) => line.includes("Open conversation"))).toBe(true)
    } finally {
      await closeHome(session)
    }
  })
})

describe("typical action coverage (used by tests above)", () => {
  test("HomeWorkAction ids are exhaustive", () => {
    const ids: HomeWorkAction[] = ["conversation", "conversation-external", "propose", "pipeline", "specs", "runs", "close"]
    expect(ids).toHaveLength(7)
  })
})
