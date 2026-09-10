import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRenderer } from "@opentui/core/testing"

import { SpecsBrowser } from "../src/specs-browser"
import type { BoardWorktree, ControlBoard } from "../src/control-board"
import type { SpecsChangeEntry, SpecsView } from "../src/specs"

/**
 * The dispatchable Actions menu (delta specs-viewer): close review is
 * reachable from root and ordinary detail, blocked actions stay inspectable
 * with their reasons, and footer truncation keeps the discoverable
 * `! actions` entry. The close confirmation names the source worktree, base,
 * explicit archive set, and the whole-branch squash scope.
 */

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

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "convoy-specs-actions-"))
  const dir = join(root, "openspec", "changes", "add-widget")
  const specsDir = join(root, "openspec", "specs", "cli")
  await mkdir(dir, { recursive: true })
  await mkdir(specsDir, { recursive: true })
  await writeFile(join(dir, "proposal.md"), "# Add widget\n")
  await writeFile(join(dir, "tasks.md"), "- [x] one\n")
  await writeFile(join(specsDir, "spec.md"), "# Cli spec\n")
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

function changeEntry(): SpecsChangeEntry {
  return {
    kind: "change",
    id: "add-widget",
    checkout: root,
    title: "Add widget",
    artifacts: [{ section: "proposal", file: join(root, "openspec", "changes", "add-widget", "proposal.md") }],
  }
}

function worktree(overrides: Partial<BoardWorktree> = {}): BoardWorktree {
  return {
    path: root,
    branch: "feat/add-widget",
    detached: false,
    main: true,
    bare: false,
    accessible: true,
    changes: [],
    ...overrides,
  }
}

function viewWith(target: BoardWorktree, width = 120): SpecsView {
  const board: ControlBoard = { commonDir: root, baseBranch: "main", worktrees: [target] }
  return { targetDir: root, present: true, board, changes: [changeEntry()], specs: [], baseBranch: "main" }
}

async function openBrowser(view: SpecsView, width = 120, height = 40) {
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

/** Moves the cursor to the change child row under the first worktree. */
async function selectChangeRow(session: Awaited<ReturnType<typeof openBrowser>>) {
  session.press("down")
  await session.renderOnce()
}

test("! opens the Actions menu on the selected change and Enter opens the close confirmation", async () => {
  const session = await openBrowser(viewWith(worktree()))

  session.press("!")
  await session.renderOnce()
  const frame = session.captureCharFrame()
  expect(frame).toContain("Actions")
  expect(frame).toContain("Close (archive & merge)")

  // Enter arms the close confirmation instead of emitting the resolution.
  session.press("return")
  await session.renderOnce()
  const modal = session.captureCharFrame()
  expect(modal).toContain("Close this worktree?")
  expect(modal).toContain("feat/add-widget")
  expect(modal).toContain("main")
  expect(modal).toContain("WHOLE")

  // Only the explicit confirm emits the reviewed resolution.
  session.press("y")
  await expect(session.instance.result).resolves.toEqual({ type: "close-change", changeID: "add-widget", worktreeDir: root, branch: "feat/add-widget" })
})

test("the Actions menu archives the selected change", async () => {
  const session = await openBrowser(viewWith(worktree()))

  session.press("!")
  await session.renderOnce()
  expect(session.captureCharFrame()).toContain("Archive change")

  // Close is the menu's default selection; move onto Archive change and run it.
  session.press("down")
  await session.renderOnce()
  session.press("return")
  await expect(session.instance.result).resolves.toEqual({ type: "archive-change", changeID: "add-widget", worktreeDir: root })
})

test("x on a change row opens the close confirmation with that archive selection", async () => {
  const session = await openBrowser(viewWith(worktree()))
  await selectChangeRow(session)

  session.press("x")
  await session.renderOnce()
  expect(session.captureCharFrame()).toContain("Close this worktree?")
  session.press("y")
  await expect(session.instance.result).resolves.toEqual({ type: "close-change", changeID: "add-widget", worktreeDir: root, branch: "feat/add-widget" })
})

test("the ordinary detail view's menu offers the same close action as the root", async () => {
  const session = await openBrowser(viewWith(worktree()))
  await selectChangeRow(session)

  // Enter opens the change's reading pane (the detail level).
  session.press("return")
  await session.renderOnce()
  session.press("!")
  await session.renderOnce()
  expect(session.captureCharFrame()).toContain("Close (archive & merge)")

  session.press("return")
  await session.renderOnce()
  expect(session.captureCharFrame()).toContain("Close this worktree?")
  session.press("y")
  await expect(session.instance.result).resolves.toEqual({ type: "close-change", changeID: "add-widget", worktreeDir: root, branch: "feat/add-widget" })
})

test("a blocked close review stays inspectable with its blockers and never dispatches", async () => {
  // A detached HEAD cannot name a close source: the menu entry is disabled
  // with its reason, never hidden.
  const session = await openBrowser(viewWith(worktree({ branch: undefined, detached: true })))

  session.press("!")
  await session.renderOnce()
  const frame = session.captureCharFrame()
  expect(frame).toContain("Close (archive & merge) — blocked")
  expect(frame).toContain("detached HEAD")

  // Archive has no branch requirement, so it is the menu's default selection
  // here; move onto the blocked close entry and confirm Enter dispatches
  // nothing while the menu stays open.
  session.press("up")
  await session.renderOnce()
  session.press("return")
  await session.renderOnce()
  expect(session.captureCharFrame()).toContain("Actions")

  // Escape closes the menu; q/q leave the subject and quit.
  session.press("escape")
  await session.renderOnce()
  session.press("q")
  await session.renderOnce()
  session.press("q")
  await expect(session.instance.result).resolves.toEqual({ type: "exit" })
})

test("the pinned ! actions hint survives footer truncation in a narrow terminal", async () => {
  const session = await openBrowser(viewWith(worktree()), 62, 40)

  const frame = session.captureCharFrame()
  // Many hints compete for the narrow footer, but the menu entry is pinned.
  expect(frame).toContain("actions")
  expect(frame).toContain("!")

  // And the menu itself still opens and confirms through the modal.
  session.press("!")
  await session.renderOnce()
  session.press("return")
  await session.renderOnce()
  expect(session.captureCharFrame()).toContain("Close this worktree?")
  session.press("y")
  await expect(session.instance.result).resolves.toEqual({ type: "close-change", changeID: "add-widget", worktreeDir: root, branch: "feat/add-widget" })
})

test("the fullscreen reader keeps its copy keys and never opens the menu", async () => {
  const session = await openBrowser(viewWith(worktree()))
  await selectChangeRow(session)

  session.press("return")
  await session.renderOnce()
  session.press("v")
  await session.renderOnce()
  session.press("!")
  await session.renderOnce()
  const frame = session.captureCharFrame()
  expect(frame).toContain("c copy")
  expect(frame).not.toContain("Actions")

  session.press("escape")
  await session.renderOnce()
  session.press("q")
  await session.renderOnce()
  session.press("q")
  await expect(session.instance.result).resolves.toEqual({ type: "exit" })
})

describe("the close confirmation modal", () => {
  /** Resolves true only if the browser's result promise settles within a beat. */
  async function alreadyResolved(session: Awaited<ReturnType<typeof openBrowser>>): Promise<boolean> {
    let settled = false
    session.instance.result.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await Bun.sleep(20)
    return settled
  }

  test("x arms the confirmation: nothing is emitted and the modal names the facts", async () => {
    const session = await openBrowser(viewWith(worktree()))
    await selectChangeRow(session)

    session.press("x")
    await session.renderOnce()
    const modal = session.captureCharFrame()
    expect(modal).toContain("Close this worktree?")
    expect(modal).toContain("WHOLE")
    expect(modal).toContain("add-widget")
    expect(modal).toContain("feat/add-widget")
    expect(modal).toContain("main")
    // While the modal is up the footer only offers the two answers (the
    // narrow capture clips the labels; the modal body names them).
    expect(modal).toContain("y confirm")
    expect(modal).toContain("n/esc cancel")
    expect(await alreadyResolved(session)).toBe(false)

    session.press("y")
    await expect(session.instance.result).resolves.toEqual({ type: "close-change", changeID: "add-widget", worktreeDir: root, branch: "feat/add-widget" })
  })

  test("cancel keeps the browser on the same row with nothing emitted", async () => {
    const session = await openBrowser(viewWith(worktree()))
    await selectChangeRow(session)

    session.press("x")
    await session.renderOnce()
    session.press("n")
    await session.renderOnce()
    const frame = session.captureCharFrame()
    expect(frame).not.toContain("Close this worktree?")
    // The browser is alive and still on the change row.
    expect(frame).toContain("add-widget")
    expect(await alreadyResolved(session)).toBe(false)

    // A second, deliberate attempt still confirms to the same resolution.
    session.press("x")
    await session.renderOnce()
    session.press("y")
    await expect(session.instance.result).resolves.toEqual({ type: "close-change", changeID: "add-widget", worktreeDir: root, branch: "feat/add-widget" })
  })

  test("escape cancels and any other key is ignored while the modal is open", async () => {
    const session = await openBrowser(viewWith(worktree()))
    await selectChangeRow(session)

    session.press("x")
    await session.renderOnce()
    // Navigation keys and even a second x cannot dismiss or re-arm anything.
    session.press("j")
    session.press("x")
    await session.renderOnce()
    expect(session.captureCharFrame()).toContain("Close this worktree?")
    expect(await alreadyResolved(session)).toBe(false)

    session.press("escape")
    await session.renderOnce()
    expect(session.captureCharFrame()).not.toContain("Close this worktree?")
    expect(await alreadyResolved(session)).toBe(false)

    session.press("c", { ctrl: true })
    await expect(session.instance.result).resolves.toEqual({ type: "exit" })
  })

  test("the footer advertises the confirm step beside the x shortcut", async () => {
    const session = await openBrowser(viewWith(worktree()))
    await selectChangeRow(session)

    session.press("x")
    await session.renderOnce()
    const frame = session.captureCharFrame()
    expect(frame).toContain("y confirm")
    expect(frame).toContain("n/esc cancel")

    session.press("y")
    await expect(session.instance.result).resolves.toEqual({ type: "close-change", changeID: "add-widget", worktreeDir: root, branch: "feat/add-widget" })
  })
})
