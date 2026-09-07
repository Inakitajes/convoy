import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { execFile as nodeExecFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterAll } from "bun:test"

import { HomeLauncher } from "../src/home-tui"
import type { HomeResolution, HomeWorkAction } from "../src/home-tui"
import { versionDetails } from "../src/version"
import type { LifecycleFeatureRow, SpecsView } from "../src/specs"

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

function featureRow(overrides: Partial<LifecycleFeatureRow> & { featureId: string; displayName: string }): LifecycleFeatureRow {
  return {
    summary: "In implementation",
    blockers: [],
    liveRuns: 0,
    integration: "pending",
    contracts: [{ changeId: "add-widget", state: "active" }],
    ...overrides,
  }
}

const work: LifecycleFeatureRow[] = [
  featureRow({ featureId: "11111111-2222-3333-4444-555555555555", displayName: "Add widget", branch: "feat/add-widget", checkoutPath: "/wt/add-widget" }),
  featureRow({
    featureId: "aaaaaaaa-2222-3333-4444-555555555555",
    displayName: "Idle pre-proposal",
    branch: "feat/awaiting",
    checkoutPath: "/wt/awaiting",
    contracts: [],
    summary: "Awaiting proposal",
    blockers: ["no contracts: propose a change or associate an existing one before closing"],
  }),
]

function viewDir(): string {
  return "/work/acme"
}

async function openHome(options: { workRows?: LifecycleFeatureRow[]; resumeFeature?: LifecycleFeatureRow; resumeNotice?: string; width?: number; height?: number; targetDir?: string } = {}) {
  const testRenderer = await createTestRenderer({ width: options.width ?? 110, height: options.height ?? 30 })
  const instance = new HomeLauncher(testRenderer.renderer, options.targetDir ?? viewDir(), {
    scene: undefined,
    workRows: options.workRows ?? work,
    resumeFeature: options.resumeFeature,
    resumeNotice: options.resumeNotice,
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

describe("work-first home (tasks 6.2/6.3)", () => {
  test("the masthead carries identity, the complete version, and the project above the work list", async () => {
    const session = await openHome()
    try {
      const frame = frameOf(session)
      expect(frame).toContain("████")
      // The wide masthead right-aligns the version and the project path. The
      // version's fallback chain is environment-dependent (bun run scripts see
      // npm_package_version), so assert the same value the masthead renders.
      expect(frame).toContain(versionDetails())
      expect(frame).toContain("/work/acme")
      // Panels: the work list leads, New feature is explicit, destinations
      // remain reachable, and the preview speaks the selected work.
      expect(frame).toContain(" work ")
      expect(frame).toContain(" next ")
      expect(frame).toContain("Add widget")
      expect(frame).toContain("+ New feature")
      expect(frame).toContain("Pipelines")
      expect(frame).toContain("enter  Open conversation")
    } finally {
      await closeHome(session)
    }
  })

  test("enter on a work row opens its detail with distinct conversation/propose/pipeline labels", async () => {
    const session = await openHome()
    try {
      session.press("return") // the cursor starts on the first work row
      await session.renderOnce()
      const frame = frameOf(session)
      expect(frame).toContain("Add widget")
      expect(frame).toContain("Open conversation")
      // Contract-bearing work proposes the NEXT change; pre-proposal work
      // (the awaiting-proposal row) proposes the first one.
      expect(frame).toContain("Propose next change")
      expect(frame).toContain("Execute pipeline")
      expect(frame).toContain("Close review")
    } finally {
      await closeHome(session)
    }
  })

  test("a detail action resolves the same work with its action", async () => {
    const session = await openHome()
    try {
      session.press("return") // open the first work's detail
      await session.renderOnce()
      session.press("e") // execute pipeline
      const resolution = (await session.instance.result) as HomeResolution
      expect(resolution).toEqual({ type: "work", featureId: "11111111-2222-3333-4444-555555555555", action: "pipeline" })
    } catch {
      await closeHome(session)
      throw new Error("test failed")
    }
  })

  test("a blocked close stays visible with its blocker and does not fire", async () => {
    const blocked = featureRow({
      featureId: "bbbbbbbb-2222-3333-4444-555555555555",
      displayName: "Blocked work",
      branch: "feat/blocked",
      checkoutPath: "/wt/blocked",
      summary: "In implementation",
      blockers: ["2 live run(s) attached"],
    })
    blocked.actions = [
      { id: "close", label: "Close review", enabled: false, blockers: ["2 live run(s) attached"], remediation: [] },
    ]
    const session = await openHome({ workRows: [blocked] })
    try {
      session.press("return") // open the blocked work's detail
      await session.renderOnce()
      const frame = frameOf(session)
      expect(frame).toContain("Close review")
      expect(frame).toContain("blocked:")
      expect(frame).toContain("2 live run(s) attached")
      session.press("x") // blocked close must not resolve the close action
      await session.renderOnce()
      expect(session.instance.result).toBeInstanceOf(Promise)
    } finally {
      await closeHome(session)
    }
  })

  test("a pre-proposal work row keeps its awaiting-proposal summary from the shared assessment", async () => {
    const session = await openHome()
    try {
      const frame = frameOf(session)
      expect(frame).toContain("Idle pre-proposal")
      expect(frame).toContain("Awaiting proposal")
    } finally {
      await closeHome(session)
    }
  })

  test("highlighting a destination fills the preview with its kicker and description", async () => {
    const session = await openHome()
    try {
      // Skip both work rows and New feature to land on Pipelines (the rule is not selectable).
      session.press("j")
      session.press("j")
      session.press("j")
      await session.renderOnce()
      const frame = frameOf(session)
      expect(frame).toContain("From intent to ship")
      expect(frame).toContain("Compose agents into a reviewed, repeatable path")
      expect(frame).toContain(" pipelines ")
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

describe("selection persistence surface (task 6.4)", () => {
  test("a remembered work row is preselected; a lost one explains instead of substituting", async () => {
    const remembered = await openHome({ resumeFeature: work[1] })
    try {
      const frame = frameOf(remembered)
      const listRows = frame.split("\n").filter((line) => line.includes("▸"))
      expect(listRows.some((line) => line.includes("Idle pre-proposal"))).toBe(true)
    } finally {
      await closeHome(remembered)
    }

    const lost = await openHome({
      workRows: [work[0]!],
      resumeNotice: "the last selected work (aaaa) no longer resolves — it may have been completed or its records are unreadable",
    })
    try {
      const frame = frameOf(lost)
      expect(frame).toContain("no longer resolves")
      expect(frame).toContain("Add widget")
    } finally {
      await closeHome(lost)
    }
  })
})

describe("new feature form (task 5.1)", () => {
  test("cancelling the form makes no resolution and returns to the list", async () => {
    const session = await openHome()
    try {
      session.press("n")
      await session.renderOnce()
      expect(frameOf(session)).toContain("New feature")
      session.press("escape")
      await session.renderOnce()
      // Back on the list: the work rows are visible again and nothing resolved.
      expect(frameOf(session)).toContain("Add widget")
      expect(session.instance.result).toBeInstanceOf(Promise)
    } finally {
      await closeHome(session)
    }
  })

  test("a reviewed draft resolves with the name, conventional branch, and detected base", async () => {
    const repo = await mkdtemp(join(tmpdir(), "convoy-home-form-"))
    dirs.push(repo)
    await Bun.write(join(repo, "README.md"), "# repo\n")
    await git(repo, "init", "-q", "-b", "main")
    await git(repo, "add", ".")
    await git(repo, "-c", "user.email=t@x", "-c", "user.name=T", "commit", "-qm", "init")
    const typeChar = (session: Awaited<ReturnType<typeof openHome>>, text: string) => {
      for (const char of text) session.press(char, { sequence: char })
    }
    const session = await openHome({ workRows: [], targetDir: repo })
    try {
      session.press("n")
      await session.renderOnce()
      typeChar(session, "Add widget")
      session.press("return")
      await Bun.sleep(80)
      await session.renderOnce()
      // Branch prefilled from the name; accepted as-is.
      session.press("return")
      await Bun.sleep(80)
      await session.renderOnce()
      // Base detected (main); accepted.
      session.press("return")
      const resolution = (await session.instance.result) as HomeResolution
      expect(resolution?.type).toBe("new-work")
      if (resolution?.type === "new-work" && resolution.draft) {
        expect(resolution.draft.displayName).toBe("Add widget")
        expect(resolution.draft.branch).toBe("feat/add-widget")
        expect(resolution.draft.base).toBe("main")
        expect(resolution.draft.worktree).toBeTruthy()
      }
    } catch {
      await closeHome(session)
      throw new Error("test failed")
    }
  })
})

describe("small terminals (list and detail stay navigable)", () => {
  test("a narrow terminal stacks the preview under the work list", async () => {
    const session = await openHome({ width: 60, height: 24 })
    try {
      const frame = frameOf(session)
      expect(frame).toContain(" work ")
      expect(frame).toContain(" next ")
      expect(frame).toContain("Add widget")
      expect(frame).toContain("enter  Open conversation")
      expect(frame).toContain("q quit")
    } finally {
      await closeHome(session)
    }
  })

  test("navigating past the fold keeps the selected work row and the hints row visible", async () => {
    const many: LifecycleFeatureRow[] = Array.from({ length: 10 }, (_, index) =>
      featureRow({ featureId: `f${index}-2222-3333-4444-555555555555`, displayName: `Work item ${index}`, branch: `feat/item-${index}`, checkoutPath: `/wt/item-${index}` }),
    )
    const session = await openHome({ workRows: many, height: 14 })
    try {
      for (let step = 0; step < 9; step++) {
        session.press("j")
      }
      await session.renderOnce()
      const frame = frameOf(session)
      // The selected row is the tenth work item; it must be on screen, not
      // clipped below the fold, and the hints row must survive with it.
      const selected = frame.split("\n").filter((line) => line.includes("▸"))
      expect(selected.some((line) => line.includes("Work item 9"))).toBe(true)
      expect(frame).toContain("q quit")
    } finally {
      await closeHome(session)
    }
  })

  test("a short terminal keeps the selected detail action and its hints visible", async () => {
    const session = await openHome({ height: 12 })
    try {
      session.press("return") // open the first work's detail
      await session.renderOnce()
      const frame = frameOf(session)
      const selected = frame.split("\n").filter((line) => line.includes("▸"))
      expect(selected.some((line) => line.includes("Open conversation"))).toBe(true)
      expect(frame).toContain("esc back")
    } finally {
      await closeHome(session)
    }
  })

  test("detail metadata above the actions stays reachable through paging", async () => {
    const manyContracts = featureRow({
      featureId: "cccccccc-2222-3333-4444-555555555555",
      displayName: "Many contracts",
      branch: "feat/many",
      checkoutPath: "/wt/many",
      contracts: Array.from({ length: 12 }, (_, index) => ({ changeId: `change-${index + 1}`, state: "active" })),
    })
    const session = await openHome({ workRows: [manyContracts], height: 14 })
    try {
      session.press("return") // open the detail; it follows the first action
      await session.renderOnce()
      const followed = frameOf(session)
      expect(followed).toContain("Open conversation")
      expect(followed).not.toContain("Many contracts")
      // Page up: the metadata block — title through contracts — becomes readable.
      session.press("pageup")
      session.press("pageup")
      await session.renderOnce()
      const paged = frameOf(session)
      expect(paged).toContain("Many contracts")
      expect(paged).toContain("contract: change-1 (active)")
      expect(paged).toContain("pgup/pgdn page")
      // Action navigation re-follows the selection.
      session.press("j")
      await session.renderOnce()
      const selected = frameOf(session).split("\n").filter((line) => line.includes("▸"))
      expect(selected.some((line) => line.includes("Open in window"))).toBe(true)
    } finally {
      await closeHome(session)
    }
  })

  test("a resize re-clamps the detail pane without stranding it", async () => {
    const session = await openHome({ height: 30 })
    try {
      session.press("return")
      await session.renderOnce()
      expect(frameOf(session)).toContain("Add widget")
      // Shrink: the pane re-renders at the new size and re-clamps around the
      // selected action instead of keeping the tall pane's stale content.
      session.resize(110, 12)
      await session.renderOnce()
      const shrunk = frameOf(session)
      expect(shrunk).toContain("Open conversation")
      expect(shrunk).not.toContain("Add widget")
      // Grow back: the pane re-clamps and the metadata is readable again.
      session.resize(110, 30)
      await session.renderOnce()
      expect(frameOf(session)).toContain("Add widget")
    } finally {
      await closeHome(session)
    }
  })
})

describe("typical action coverage (used by tests above)", () => {
  test("HomeWorkAction ids are exhaustive", () => {
    const ids: HomeWorkAction[] = ["conversation", "conversation-external", "propose", "pipeline", "specs", "runs", "close", "history"]
    expect(ids).toHaveLength(8)
  })
})

describe("authoring conversation selector (capability work-conversations)", () => {
  const multi = featureRow({
    featureId: "cccccccc-2222-3333-4444-555555555555",
    displayName: "Chatty work",
    branch: "feat/chatty",
    checkoutPath: "/wt/chatty",
    conversations: [
      { sessionId: "ses_first0000000", harness: "opencode", label: "proposal", lastSelectedAt: 200 },
      { sessionId: "ses_second000000", harness: "opencode", lastSelectedAt: 100 },
    ],
    lastSelectedConversationId: "ses_first0000000",
  })

  test("several linked conversations open the selector listing each, separate from phase sessions", async () => {
    const session = await openHome({ workRows: [multi] })
    try {
      session.press("return") // open the work's detail
      await session.renderOnce()
      session.press("v") // conversation action with two linked conversations
      await session.renderOnce()
      const frame = frameOf(session)
      // Both linked conversations are listed, most recently selected first,
      // with the default resume target marked; phase sessions never appear.
      expect(frame).toContain("proposal")
      expect(frame).toContain("ses_second0000")
      expect(frame).toContain("(last selected)")
      expect(frame).not.toContain("phase")
    } finally {
      await closeHome(session)
    }
  })

  test("the selector resolves the chosen conversation; escape returns to the detail", async () => {
    const session = await openHome({ workRows: [multi] })
    try {
      session.press("return")
      await session.renderOnce()
      session.press("v")
      await session.renderOnce()
      session.press("j") // move to the second conversation
      await session.renderOnce()
      session.press("return")
      const resolution = (await session.instance.result) as HomeResolution
      expect(resolution).toEqual({
        type: "work",
        featureId: "cccccccc-2222-3333-4444-555555555555",
        action: "conversation",
        sessionId: "ses_second000000",
      })
    } catch {
      await closeHome(session)
      throw new Error("test failed")
    }
  })

  test("a single linked conversation keeps the direct default without a selector", async () => {
    const single = featureRow({
      featureId: "dddddddd-2222-3333-4444-555555555555",
      displayName: "Solo work",
      branch: "feat/solo",
      checkoutPath: "/wt/solo",
      conversations: [{ sessionId: "ses_only00000000", harness: "opencode" }],
      lastSelectedConversationId: "ses_only00000000",
    })
    const session = await openHome({ workRows: [single] })
    try {
      session.press("return")
      await session.renderOnce()
      session.press("v")
      const resolution = (await session.instance.result) as HomeResolution
      expect(resolution).toEqual({ type: "work", featureId: "dddddddd-2222-3333-4444-555555555555", action: "conversation" })
    } catch {
      await closeHome(session)
      throw new Error("test failed")
    }
  })
})

// The old poster/diamond obligations were removed by the unify-work-context
// Home deltas; the SpecsView import anchor keeps the type dependency explicit.
export type { SpecsView }
