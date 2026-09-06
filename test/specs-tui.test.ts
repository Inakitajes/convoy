import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { SpecsBrowser } from "../src/specs-browser"
import type { SpecsChangeEntry, SpecsView } from "../src/specs"

function keyEvent(name: string, options: { ctrl?: boolean; shift?: boolean } = {}) {
  return {
    name,
    ctrl: options.ctrl ?? false,
    meta: false,
    shift: options.shift ?? false,
    option: false,
    sequence: name,
    number: false,
    raw: name,
    eventType: "keypress" as const,
    source: "raw" as const,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as any
}

let root: string
let change: SpecsChangeEntry

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "convoy-specs-tui-"))
  const dir = join(root, "openspec", "changes", "add-login")
  const specsDir = join(root, "openspec", "specs", "cli")
  await mkdir(dir, { recursive: true })
  await mkdir(specsDir, { recursive: true })
  await writeFile(join(dir, "proposal.md"), "# Add login\n\nLet operators sign in.\n")
  // Frontmatter must be stripped before rendering.
  await writeFile(join(dir, "design.md"), "---\nowner: someone\n---\n# Design\n\nA simple form.\n")
  await writeFile(join(dir, "tasks.md"), "# Tasks\n\n- [ ] form\n")
  await writeFile(join(specsDir, "spec.md"), "# Cli spec\n\n## ADDED Requirements\n")

  change = {
    kind: "change",
    id: "add-login",
    title: "Add login",
    artifacts: [
      { section: "proposal", file: join(dir, "proposal.md") },
      { section: "design", file: join(dir, "design.md") },
      { section: "tasks", file: join(dir, "tasks.md") },
      { section: "delta", capability: "cli", file: join(specsDir, "spec.md") },
    ],
  }
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Fresh copies per call so a test mutating a change's artifacts (e.g. the
 * unreadable-file case) cannot leak into later tests — same rule as runs-tui's
 * per-test fixture builder. */
function sampleView(): SpecsView {
  const cloneChange = (entry: SpecsChangeEntry): SpecsChangeEntry => ({ ...entry, artifacts: [...entry.artifacts] })
  return {
    targetDir: root,
    present: true,
    changes: [
      cloneChange(change),
      { kind: "change", id: "bare-change", title: "bare-change", artifacts: [] },
    ],
    specs: [join(root, "openspec", "specs", "cli", "spec.md")],
  }
}

async function openBrowser(view = sampleView(), width = 120, height = 40) {
  const testRenderer = await createTestRenderer({ width, height })
  const instance = new SpecsBrowser(testRenderer.renderer, view)
  await testRenderer.renderOnce()
  return {
    ...testRenderer,
    instance,
    press(key: string, options: { ctrl?: boolean; shift?: boolean } = {}) {
      testRenderer.renderer.keyInput.emit("keypress", keyEvent(key, options))
    },
  }
}

async function close(session: Awaited<ReturnType<typeof openBrowser>>) {
  session.press("c", { ctrl: true })
  await session.instance.result.catch(() => {})
}

/** File bodies load lazily; give the pending read a beat before capturing. */
async function settle(ms = 30) {
  await Bun.sleep(ms)
}

async function frameOf(view?: SpecsView, width = 120, height = 40) {
  const session = await openBrowser(view ?? sampleView(), width, height)
  try {
    return session.captureCharFrame()
  } finally {
    await close(session)
  }
}

test("renders Active Changes above Canonical Specs with distinct headers", async () => {
  const frame = await frameOf()
  const active = frame.split("\n").findIndex((line) => line.includes("ACTIVE CHANGES"))
  const canonical = frame.split("\n").findIndex((line) => line.includes("CANONICAL SPECS"))
  expect(active).toBeGreaterThanOrEqual(0)
  expect(canonical).toBeGreaterThan(active)
  expect(frame).toContain("add-login — Add login")
  expect(frame).not.toContain("WORKTREES WITHOUT SPEC")
})

test("a change without artifacts still lists by its id", async () => {
  const frame = await frameOf()
  expect(frame).toContain("bare-change")
})

test("enter opens the change's tabbed reading pane and escape returns", async () => {
  const session = await openBrowser()

  session.press("return")
  await session.renderOnce()
  await settle()
  await session.renderOnce()
  const detail = session.captureCharFrame()
  // All artifact types present: the tab strip lists the full labeled set and
  // the title row names the subject.
  expect(detail).toContain("1 Proposal")
  expect(detail).toContain("2 Design")
  expect(detail).toContain("3 Tasks")
  expect(detail).toContain("4 Delta Specs")
  expect(detail).toContain("Add login")

  session.press("escape")
  await session.renderOnce()
  expect(session.captureCharFrame()).toContain("CANONICAL SPECS")

  session.press("q")
  await expect(session.instance.result).resolves.toEqual({ type: "exit" })
})

test("rendered markdown strips frontmatter noise in the detail pane", async () => {
  const session = await openBrowser()

  session.press("return")
  await session.renderOnce()
  await settle()
  await session.renderOnce()
  const proposalFrame = session.captureCharFrame()
  expect(proposalFrame).toContain("Let operators sign in.")
  expect(proposalFrame).not.toContain("---\n")

  // Design carries the frontmatter; switch one tab right and check it's gone.
  session.press("l")
  await session.renderOnce()
  await settle()
  await session.renderOnce()
  const designFrame = session.captureCharFrame()
  expect(designFrame).not.toContain("owner: someone")
  expect(designFrame).toContain("A simple form.")

  await close(session)
})

test("an unreadable artifact degrades to a placeholder", async () => {
  const ghost = sampleView()
  ghost.changes[0]!.artifacts.push({ section: "other", file: join(root, "missing.md") })
  const session = await openBrowser(ghost)

  session.press("return")
  await session.renderOnce()
  await settle()
  await session.renderOnce()
  // Jump straight to the last (Other) tab with its digit.
  session.press("5")
  await session.renderOnce()
  await settle()
  await session.renderOnce()
  expect(session.captureCharFrame()).toContain("(couldn't read")

  await close(session)
})

test("a applies the selected change from the root list", async () => {
  const session = await openBrowser()

  session.press("a")

  await expect(session.instance.result).resolves.toEqual({ type: "apply-change", changeID: "add-login" })
})

test("i iterates on the selected change from the root list", async () => {
  const session = await openBrowser()

  session.press("i")

  await expect(session.instance.result).resolves.toEqual({ type: "iterate-change", changeID: "add-login", presentation: "foreground" })
})

test("a feature's history view never dispatches apply or iterate, even when its display name names an active change", async () => {
  const view = sampleView()
  view.features = [
    {
      featureId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      displayName: "add-login", // deliberately equals the active change id above
      summary: "In implementation",
      blockers: [],
      liveRuns: 0,
      integration: "pending",
      contracts: [{ changeId: "add-login", state: "active" }],
    },
  ]
  const session = await openBrowser(view)

  // The cursor opens on the feature row; enter shows its read-only history.
  session.press("return")
  await session.renderOnce()
  await settle()
  await session.renderOnce()
  const history = session.captureCharFrame()
  // The title leads with the display name; the feature uuid never headlines it.
  expect(history).toContain("add-login — history")
  expect(history).not.toContain("— add-login — history")

  // Apply/iterate are change-level actions: on the history view they neither
  // launch the same-named change nor end the browser.
  session.press("a")
  await session.renderOnce().catch(() => {})
  session.press("i")
  await session.renderOnce().catch(() => {})
  session.press("escape")
  await session.renderOnce()
  expect(session.captureCharFrame()).toContain("FEATURES")

  // Quit still resolves exit — proving neither shortcut finished the browser.
  session.press("q")
  await expect(session.instance.result).resolves.toEqual({ type: "exit" })
})

test("a selected feature row's details panel shares the change rows' label anatomy", async () => {
  const view = sampleView()
  view.features = [
    {
      featureId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      displayName: "add-login",
      branch: "feat/add-login",
      checkoutPath: "/tmp/wt-add-login",
      summary: "Association needed",
      blockers: [],
      liveRuns: 0,
      integration: "pending",
      contracts: [{ changeId: "add-login", state: "active" }],
    },
  ]
  const frame = await frameOf(view)
  expect(frame).toContain("status: Association needed")
  expect(frame).toContain("branch: feat/add-login")
  expect(frame).toContain("worktree: /tmp/wt-add-login")
  expect(frame).toContain("contract: add-login (active)")
})

test("selection crosses sections: enter on a canonical spec reads it", async () => {
  const view = sampleView()
  view.changes = [{ kind: "change", id: "only-change", title: "Only change", artifacts: [] }]
  const session = await openBrowser(view)

  // One down skips the Canonical Specs header and lands on its first row.
  session.press("down")
  await session.renderOnce()
  session.press("return")
  await session.renderOnce()
  await settle()
  await session.renderOnce()
  expect(session.captureCharFrame()).toContain("Cli spec")

  session.press("b")
  await session.renderOnce()
  const rootFrame = session.captureCharFrame()
  expect(rootFrame).toContain("ACTIVE CHANGES")
  expect(rootFrame).not.toContain("details")

  await close(session)
})

test("Ctrl-C exits immediately", async () => {
  const session = await openBrowser()

  session.press("c", { ctrl: true })

  await expect(session.instance.result).resolves.toEqual({ type: "exit" })
})

test("an empty active-changes section is omitted and the first canonical spec is selected", async () => {
  const view = sampleView()
  view.changes = []
  const session = await openBrowser(view)

  // No changes: the title disappears entirely and the cursor lands on the
  // first spec row rather than its dead section header.
  const frame = session.captureCharFrame()
  expect(frame).not.toContain("ACTIVE CHANGES")
  expect(frame).not.toContain("WORKTREES WITHOUT SPEC")
  expect(frame).toContain("CANONICAL SPECS")
  expect(frame).toContain("▸")
  session.press("return")
  await session.renderOnce()
  await settle()
  await session.renderOnce()
  expect(session.captureCharFrame()).toContain("Cli spec")

  await close(session)
})

test("up from the first change row stays on it instead of recursing onto the header", async () => {
  const session = await openBrowser()

  // The Active Changes header sits at index 0; moving up from the first change
  // must clamp back to that change, not recurse onto the dead header row.
  session.press("up")
  await session.renderOnce()
  expect(session.captureCharFrame()).toContain("▸ ◆ add-login — Add login")
  // Enter still works — the cursor is on a live row.
  session.press("return")
  await session.renderOnce()
  await settle()
  await session.renderOnce()
  expect(session.captureCharFrame()).toContain("Proposal")

  await close(session)
})

test("home and g land on the first selectable row, not the leading header", async () => {
  const session = await openBrowser()

  session.press("down")
  await session.renderOnce()
  session.press("home")
  await session.renderOnce()
  expect(session.captureCharFrame()).toContain("▸ ◆ add-login — Add login")
  session.press("g")
  await session.renderOnce()
  // g (unshifted) jumps to the top: the first change row, which Enter can read.
  session.press("return")
  await session.renderOnce()
  await settle()
  await session.renderOnce()
  expect(session.captureCharFrame()).toContain("Proposal")

  await close(session)
})

test("compact screens stack the list above the details panel", async () => {
  const frame = await frameOf(undefined, 84, 30)
  const lines = frame.split("\n")
  const listRow = lines.findIndex((line) => line.includes("browse"))
  const detailsRow = lines.findIndex((line) => line.includes("details"))
  expect(listRow).toBeGreaterThanOrEqual(0)
  expect(detailsRow).toBeGreaterThan(listRow)
})

test.each([120, 84])("a selected canonical spec uses the full root body at width %d", async (width) => {
  const view = sampleView()
  view.changes = []
  const session = await openBrowser(view, width, 30)
  try {
    const frame = session.captureCharFrame()
    expect(frame).toContain("CANONICAL SPECS")
    expect(frame).toContain("cli/spec.md")
    expect(frame).not.toContain("details")

    const boxes = session.instance as unknown as {
      listBox: { width: unknown; height: unknown }
      detailsBox: { visible: boolean }
    }
    expect(boxes.listBox.width).toBe(width - 2)
    // Full root body: header (1) + footer (3) of the shell, minus the list
    // panel's own borders (2).
    expect(boxes.listBox.height).toBe(26)
    expect(boxes.detailsBox.visible).toBe(false)
  } finally {
    await close(session)
  }
})
