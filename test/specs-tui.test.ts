import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { SpecsBrowser } from "../src/specs-browser"
import type { BoardWorktree, ControlBoard } from "../src/control-board"
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
    checkout: root,
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
function sampleBoard(): ControlBoard {
  const worktree: BoardWorktree = {
    path: root,
    branch: "main",
    detached: false,
    main: true,
    bare: false,
    accessible: true,
    changes: [],
  }
  return { commonDir: root, baseBranch: "main", worktrees: [worktree] }
}

function sampleView(): SpecsView {
  const cloneChange = (entry: SpecsChangeEntry): SpecsChangeEntry => ({ ...entry, artifacts: [...entry.artifacts] })
  return {
    targetDir: root,
    present: true,
    board: sampleBoard(),
    changes: [
      cloneChange(change),
      { kind: "change", id: "bare-change", checkout: root, title: "bare-change", artifacts: [] },
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

test("renders the worktree sections with change children above the specs divider", async () => {
  const frame = await frameOf()
  const lines = frame.split("\n")
  // The checkout is a divider rule carrying its facts; the specs section is
  // its own divider below every worktree's children.
  const worktree = lines.findIndex((line) => line.includes("── ") && line.includes("· main · 2 changes"))
  const specs = lines.findIndex((line) => line.trimStart().startsWith("── specs"))
  expect(worktree).toBeGreaterThanOrEqual(0)
  expect(specs).toBeGreaterThan(worktree)
  expect(frame).toContain("add-login — Add login")
  expect(frame).not.toContain("FEATURES")
})

test("a change without artifacts still lists by its id", async () => {
  const frame = await frameOf()
  expect(frame).toContain("bare-change")
})

test("enter opens the change's tabbed reading pane and escape returns", async () => {
  const session = await openBrowser()

  session.press("return") // the first selectable row is the first change
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
  expect(session.captureCharFrame()).toContain("── specs")

  session.press("q")
  await expect(session.instance.result).resolves.toEqual({ type: "exit" })
})

test("rendered markdown strips frontmatter noise in the detail pane", async () => {
  const session = await openBrowser()

  session.press("return") // the first selectable row is the first change
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

  session.press("return") // the first selectable row is the first change
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

  session.press("a") // the first selectable row is the change itself

  await expect(session.instance.result).resolves.toEqual({ type: "apply-change", changeID: "add-login", checkout: root })
})

test("i iterates on the selected change from the root list", async () => {
  const session = await openBrowser()

  session.press("i") // the first selectable row is the change itself

  await expect(session.instance.result).resolves.toEqual({ type: "iterate-change", changeID: "add-login", checkout: root, presentation: "foreground" })
})

test("selection crosses sections: enter on a canonical spec reads it", async () => {
  const view = sampleView()
  view.changes = [{ kind: "change", id: "only-change", checkout: root, title: "Only change", artifacts: [] }]
  const session = await openBrowser(view)

  // From the first change, down walks straight to the spec (sections are
  // dead rows the cursor never parks on).
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
  expect(rootFrame).toContain("── specs")
  expect(rootFrame).not.toContain("╭─")

  await close(session)
})

test("Ctrl-C exits immediately", async () => {
  const session = await openBrowser()

  session.press("c", { ctrl: true })

  await expect(session.instance.result).resolves.toEqual({ type: "exit" })
})

test("an empty active-changes section is omitted and the first canonical spec is reachable", async () => {
  const view = sampleView()
  view.changes = []
  const session = await openBrowser(view)

  // No changes: the cursor opens directly on the first spec row — the
  // worktree section and the specs rule are dead rows.
  const frame = session.captureCharFrame()
  expect(frame).not.toContain("ACTIVE CHANGES")
  expect(frame).toContain("── specs")
  expect(frame).toContain("◆")
  session.press("down")
  await session.renderOnce()
  session.press("return")
  await session.renderOnce()
  await settle()
  await session.renderOnce()
  expect(session.captureCharFrame()).toContain("Cli spec")

  await close(session)
})

test("up from the first change row stays on it instead of recursing onto the header", async () => {
  const session = await openBrowser()

  // Sections are dead rows: moving up from the second change lands back on
  // the first — never on the divider above either of them.
  session.press("down")
  await session.renderOnce()
  session.press("up")
  await session.renderOnce()
  const selected = session
    .captureSpans()
    .lines.filter((line) => line.spans.some((span) => span.bg.a > 0))
    .map((line) => line.spans.map((span) => span.text).join(""))
  expect(selected.some((line) => line.includes("add-login"))).toBe(true)
  const frame = session.captureCharFrame()
  expect(frame).not.toContain("▸")
  // Enter still works — back on the change child, the reading pane opens.
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
  session.press("down")
  await session.renderOnce()
  session.press("home")
  await session.renderOnce()
  // The first selectable row is the first change — never a dead section row.
  const selectedLine = session
    .captureSpans()
    .lines.filter((line) => line.spans.some((span) => span.bg.a > 0))
    .map((line) => line.spans.map((span) => span.text).join(""))
    .find((line) => line.trim().length > 0)!
  expect(selectedLine).toContain("add-login")
  session.press("g")
  await session.renderOnce()
  const gLine = session
    .captureSpans()
    .lines.filter((line) => line.spans.some((span) => span.bg.a > 0))
    .map((line) => line.spans.map((span) => span.text).join(""))
    .find((line) => line.trim().length > 0)!
  expect(gLine).toContain("add-login")

  await close(session)
})

test("compact screens stack the list above the details panel", async () => {
  const frame = await frameOf(undefined, 84, 30)
  const lines = frame.split("\n")
  const listRow = lines.findIndex((line) => line.includes("add-login — Add login"))
  const detailsRow = lines.findIndex((line) => line.includes("checkout"))
  expect(listRow).toBeGreaterThanOrEqual(0)
  expect(detailsRow).toBeGreaterThan(listRow)
})

test.each([120, 84])("a selected canonical spec uses the full root body at width %d", async (width) => {
  const view = sampleView()
  view.changes = []
  const session = await openBrowser(view, width, 30)
  try {
    // The canonical spec is the last selectable row: shift+g lands on it.
    session.press("g", { shift: true })
    await session.renderOnce()
    const frame = session.captureCharFrame()
    expect(frame).toContain("── specs")
    expect(frame).toContain("cli/spec.md")

    const boxes = session.instance as unknown as {
      listBox: { width: unknown; height: unknown }
      detailsBox: { visible: boolean }
    }
    expect(boxes.listBox.width).toBe(width - 2)
    // Full root body: header (1) + footer (1) of the shell, borderless.
    expect(boxes.listBox.height).toBe(28)
    expect(boxes.detailsBox.visible).toBe(false)
  } finally {
    await close(session)
  }
})
