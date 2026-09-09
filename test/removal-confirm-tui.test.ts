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
  const { testRenderer, result, press } = await openDialog({ title: "remove worktree", message: "Remove /x?", mode: "confirm" })
  try {
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
