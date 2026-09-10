import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { showRemovalConfirmTui } from "../src/removal-confirm-tui"
import { TuiSession, type TuiRoute } from "../src/tui-session"

import type { KeyEvent } from "@opentui/core"

function keyEvent(name: string, options: { ctrl?: boolean; raw?: string } = {}): KeyEvent {
  return {
    name,
    ctrl: options.ctrl ?? false,
    meta: false,
    shift: false,
    option: false,
    sequence: name,
    number: false,
    raw: options.raw ?? name,
    eventType: "keypress",
    source: "raw",
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as KeyEvent
}

async function openDialog(options: Parameters<typeof showRemovalConfirmTui>[1]) {
  const testRenderer = await createTestRenderer({ width: 100, height: 24, exitOnCtrlC: false })
  const session = new TuiSession(testRenderer.renderer)
  const route: TuiRoute = { session }
  const result = showRemovalConfirmTui(route, options)
  await testRenderer.renderOnce()
  return { testRenderer, result, press: (k: string, o?: { ctrl?: boolean }) => testRenderer.renderer.keyInput.emit("keypress", keyEvent(k, o)) }
}

test("a safe removal confirms with y and cancels with n", async () => {
  // A wide message keeps the hint row from being truncated out of the footer.
  const { testRenderer, result, press } = await openDialog({ title: "remove worktree", message: "Remove /worktrees/some-feat-branch-x?", mode: "confirm" })
  try {
    await testRenderer.renderOnce()
    // The removal dialog keeps its own verb: y really removes.
    expect(testRenderer.captureCharFrame()).toContain("[y] remove")
    press("n")
    await expect(result).resolves.toBe("cancel")
    const againTest = await openDialog({ title: "remove worktree", message: "Remove /x?", mode: "confirm" })
    try {
      againTest.press("y")
      await expect(againTest.result).resolves.toBe("confirm")
    } finally {
      await againTest.testRenderer.mockInput.pressKey("c", { ctrl: true })
    }
  } finally {
    await testRenderer.mockInput.pressKey("c", { ctrl: true })
  }
})

test("a non-removal borrower can label the confirm hint without the removal verb", async () => {
  // Close review borrows this dialog; it deletes nothing, so its hint says confirm.
  const { testRenderer, result, press } = await openDialog({
    title: "close worktree",
    message: "Close feat-x (/x)?\n\nbranch   feat/feat-x\nbase     main\narchive  feat-x (4/4 tasks)",
    mode: "confirm",
    confirmLabel: "confirm",
  })
  try {
    await testRenderer.renderOnce()
    const frame = testRenderer.captureCharFrame()
    expect(frame).toContain("convoy close worktree")
    expect(frame).toContain("[y] confirm")
    expect(frame).not.toContain("[y] remove")
    press("y")
    await expect(result).resolves.toBe("confirm")
  } finally {
    await testRenderer.mockInput.pressKey("c", { ctrl: true })
  }
})

test("a blocked removal offers force only when content blockers are present", async () => {
  const blocked = await openDialog({
    title: "remove worktree",
    message: "can't remove /x:\n- the checkout has 2 uncommitted change(s)",
    mode: "blocked",
    forceAvailable: true,
  })
  try {
    blocked.press("f")
    await expect(blocked.result).resolves.toBe("force")
  } finally {
    await blocked.testRenderer.mockInput.pressKey("c", { ctrl: true })
  }

  const hard = await openDialog({
    title: "remove worktree",
    message: "can't remove /x:\n- the checkout is locked",
    mode: "blocked",
    forceAvailable: false,
  })
  try {
    hard.press("n")
    await expect(hard.result).resolves.toBe("cancel")
  } finally {
    await hard.testRenderer.mockInput.pressKey("c", { ctrl: true })
  }
})

test("the deliberate force confirmation requires an explicit confirm and refuses by default (task 7.11)", async () => {
  const del = await openDialog({
    title: "force remove worktree",
    message: "Force removal of /x deletes:\n- ignored .env\n\nContinue?",
    mode: "force",
  })
  try {
    // A reflexive key refuses (default-refusal) — no accidental deletion.
    del.press("w")
    await del.testRenderer.renderOnce()
    // Still up: nothing resolved yet.
    del.press("n")
    await expect(del.result).resolves.toBe("cancel")
  } finally {
    await del.testRenderer.mockInput.pressKey("c", { ctrl: true })
  }

  const yes = await openDialog({
    title: "force remove worktree",
    message: "Force removal of /x deletes:\n- ignored .env\n\nContinue?",
    mode: "force",
  })
  try {
    yes.press("f")
    await expect(yes.result).resolves.toBe("confirm")
  } finally {
    await yes.testRenderer.mockInput.pressKey("c", { ctrl: true })
  }
})
