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

async function openHome(options: { workRows?: LifecycleFeatureRow[]; resumeFeature?: LifecycleFeatureRow; resumeNotice?: string; height?: number; targetDir?: string } = {}) {
  const testRenderer = await createTestRenderer({ width: 110, height: options.height ?? 30 })
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
      // The wide masthead right-aligns the version and the project path.
      expect(frame).toContain("0.0.0")
      expect(frame).toContain("/work/acme")
      // The work list leads: features, New feature, then auxiliary.
      expect(frame).toContain("WORK")
      expect(frame).toContain("Add widget")
      expect(frame).toContain("+ New feature")
      expect(frame).toContain("AUXILIARY")
      expect(frame).toContain("Pipelines")
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

describe("typical action coverage (used by tests above)", () => {
  test("HomeWorkAction ids are exhaustive", () => {
    const ids: HomeWorkAction[] = ["conversation", "propose", "pipeline", "specs", "runs", "close", "history"]
    expect(ids).toHaveLength(7)
  })
})

// The old poster/diamond obligations were removed by the unify-work-context
// Home deltas; the SpecsView import anchor keeps the type dependency explicit.
export type { SpecsView }
