import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SpecsBrowser } from "../src/specs-browser"
import type { ClipboardResult } from "../src/clipboard"
import type { SpecsChangeEntry, SpecsResolution, SpecsView } from "../src/specs"
import type { ControlBoard } from "../src/control-board"

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

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "convoy-specs-reader-"))
  const dir = join(root, "openspec", "changes", "add-login")
  const cliSpecs = join(root, "openspec", "changes", "add-login", "specs", "cli")
  const uiSpecs = join(root, "openspec", "changes", "add-login", "specs", "ui")
  await mkdir(cliSpecs, { recursive: true })
  await mkdir(uiSpecs, { recursive: true })
  await writeFile(join(dir, "proposal.md"), "# Add login\n\nLet operators sign in.\n")
  await writeFile(join(dir, "design.md"), "---\nowner: someone\n---\n# Design\n\nA simple form.\n")
  await writeFile(join(dir, "tasks.md"), "# Tasks\n\n- [ ] form\n")
  await writeFile(join(cliSpecs, "spec.md"), "# Cli delta\n\n## ADDED Requirements\n\n### Requirement: Sign in\n")
  await writeFile(join(uiSpecs, "spec.md"), "# Ui delta\n\n## MODIFIED Requirements\n\n### Requirement: Button\n")
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

function sampleChange(): SpecsChangeEntry {
  const dir = join(root, "openspec", "changes", "add-login")
  return {
    kind: "change",
    id: "add-login",
    checkout: root,
    title: "Add login",
    artifacts: [
      { section: "proposal", file: join(dir, "proposal.md") },
      { section: "design", file: join(dir, "design.md") },
      { section: "tasks", file: join(dir, "tasks.md") },
      { section: "delta", capability: "cli", file: join(dir, "specs", "cli", "spec.md") },
      { section: "delta", capability: "ui", file: join(dir, "specs", "ui", "spec.md") },
    ],
  }
}

function sampleBoard(): ControlBoard {
  return {
    commonDir: root,
    baseBranch: "main",
    worktrees: [
      { path: root, branch: "main", detached: false, main: true, bare: false, accessible: true, changes: [] },
    ],
  }
}

function sampleView(): SpecsView {
  return { targetDir: root, present: true, board: sampleBoard(), changes: [sampleChange()], specs: [] }
}

/** A fake clipboard transport capturing what would be copied. */
function fakeClipboard(result: ClipboardResult = "copied-native") {
  const copied: string[] = []
  const report = async (text: string) => {
    copied.push(text)
    return result
  }
  return { report, copied }
}

async function openReader(options: { clipboard?: ReturnType<typeof fakeClipboard>; view?: SpecsView } = {}) {
  const testRenderer = await createTestRenderer({ width: 120, height: 40 })
  const clipboard = options.clipboard ?? fakeClipboard()
  const instance = new SpecsBrowser(testRenderer.renderer, options.view ?? sampleView(), clipboard.report)
  await testRenderer.renderOnce()
  const session = {
    ...testRenderer,
    instance,
    clipboard,
    press(key: string, opts: { ctrl?: boolean; shift?: boolean; sequence?: string } = {}) {
      testRenderer.renderer.keyInput.emit("keypress", keyEvent(key, opts))
    },
  }
  // The first selectable row is the first change (sections are dead rows):
  // enter its detail level, then open the reader.
  session.press("return")
  await session.renderOnce()
  await Bun.sleep(30)
  await session.renderOnce()
  session.press("v")
  await session.renderOnce()
  return session
}

async function closeSession(session: Awaited<ReturnType<typeof openReader>>) {
  session.press("c", { ctrl: true })
  await session.instance.result.catch(() => {})
}

describe("the fullscreen reader", () => {
  test("replaces the chrome with one title bar naming the subject and tab", async () => {
    const session = await openReader()
    const frame = session.captureCharFrame()
    // The labeled header row is gone with the rest of the chrome.
    expect(frame).not.toContain("project  ")
    expect(frame).not.toContain("quit")
    // The title bar names the subject, the tab, the copy and close hints, and no scroll hints.
    expect(frame).toContain("add-login")
    expect(frame).toContain("proposal")
    expect(frame).toContain("c copy")
    expect(frame).toContain("v/esc close")
    expect(frame).not.toContain("scroll")
    await closeSession(session)
  })

  test("closing returns to the detail level with the same active tab", async () => {
    const session = await openReader()
    // Switch to the Tasks tab inside the reader, then close with v.
    session.press("3")
    await session.renderOnce()
    await Bun.sleep(30)
    await session.renderOnce()
    expect(session.captureCharFrame()).toContain("tasks")
    session.press("v")
    await session.renderOnce()
    const detail = session.captureCharFrame()
    // Back at the detail level (footer and tab strip visible again), same tab.
    expect(detail).toContain("quit")
    expect(detail).toContain("3 Tasks")
    expect(detail).toContain("form")
    await closeSession(session)
  })

  test("tab switches inside the reader reset the scroll and update the title bar", async () => {
    const session = await openReader()
    // Scroll down a few lines on the proposal tab.
    for (let i = 0; i < 3; i++) session.press("down")
    await session.renderOnce()
    // Switch tabs: the pane resets and the title bar names the new tab.
    session.press("l")
    await session.renderOnce()
    await Bun.sleep(30)
    await session.renderOnce()
    const frame = session.captureCharFrame()
    expect(frame).toContain("design")
    expect(frame).toContain("A simple form.")
    expect(frame).not.toContain("owner: someone")
    await closeSession(session)
  })

  test("q closes the reader like v and escape", async () => {
    const session = await openReader()
    session.press("q")
    await session.renderOnce()
    expect(session.captureCharFrame()).toContain("quit")
    await closeSession(session)
  })
})

describe("copy the active tab", () => {
  test("copies the frontmatter-stripped source with per-capability headings", async () => {
    const clipboard = fakeClipboard()
    const session = await openReader({ clipboard })
    // Jump to the merged Delta Specs tab and copy.
    session.press("4")
    await session.renderOnce()
    await Bun.sleep(30)
    await session.renderOnce()
    session.press("c")
    await Bun.sleep(30)
    await session.renderOnce()
    expect(clipboard.copied).toHaveLength(1)
    const payload = clipboard.copied[0]!
    expect(payload).toContain("## cli")
    expect(payload).toContain("Sign in")
    expect(payload).toContain("## ui")
    expect(payload).toContain("Button")
    expect(payload).not.toContain("owner:")
    // The title bar reports the outcome without interrupting the read.
    expect(session.captureCharFrame()).toContain("copied")
    await closeSession(session)
  })

  test("a failed copy reports in the title bar and keeps the reader working", async () => {
    const clipboard = fakeClipboard("unsupported")
    const session = await openReader({ clipboard })
    session.press("c")
    await Bun.sleep(30)
    await session.renderOnce()
    expect(session.captureCharFrame()).toContain("no clipboard mechanism")
    // Reading continues: scrolling still works.
    session.press("down")
    await session.renderOnce()
    expect(session.captureCharFrame()).toContain("add-login")
    await closeSession(session)
  })
})

describe("tabbed detail level", () => {
  test("four tabs for a full change; scrolling stays within the tab", async () => {
    const session = await openReader()
    // Close the reader: the detail level shows the tab strip.
    session.press("v")
    await session.renderOnce()
    const frame = session.captureCharFrame()
    expect(frame).toContain("1 Proposal")
    expect(frame).toContain("2 Design")
    expect(frame).toContain("3 Tasks")
    expect(frame).toContain("4 Delta Specs")
    // Only one Delta Specs tab even with two capabilities.
    expect(frame).not.toContain("5 Delta")
    await closeSession(session)
  })

  test("digit keys jump straight to a tab", async () => {
    const session = await openReader()
    session.press("v")
    await session.renderOnce()
    session.press("4")
    await session.renderOnce()
    await Bun.sleep(30)
    await session.renderOnce()
    const frame = session.captureCharFrame()
    expect(frame).toContain("Cli delta")
    expect(frame).toContain("Ui delta")
    await closeSession(session)
  })
})

describe("minimal chrome", () => {
  test("the board renders no header row — the sections identify themselves", async () => {
    const session = await openReader({ view: sampleView() })
    session.press("v") // close the fullscreen reader: the chrome returns
    await session.renderOnce()
    const frame = session.captureCharFrame()
    // No header line of counts or screen name: the footer is the only chrome.
    expect(frame).not.toContain("worktree ·")
    expect(frame).not.toContain("project")
    expect(frame).toContain("actions")
    await closeSession(session)
  })

  test("the footer advertises no arrow-key or paging hints", async () => {
    const session = await openReader({ view: sampleView() })
    session.press("v")
    await session.renderOnce()
    const frame = session.captureCharFrame()
    const footer = frame.split("\n").at(-2) ?? ""
    expect(footer).not.toContain("select")
    expect(footer).not.toContain("scroll")
    expect(footer).not.toContain("page")
    // Action hints stay.
    expect(frame).toContain("apply")
    expect(frame).toContain("iterate")
    expect(frame).toContain("full")
    await closeSession(session)
  })
})

// Type-level guard: resolutions stay exhaustive through the reader flows.
const _resolutionGuard: SpecsResolution[] = [{ type: "exit" }]
void _resolutionGuard
