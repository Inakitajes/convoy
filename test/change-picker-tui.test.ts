import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { showChangePickerTui } from "../src/change-picker-tui"
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

const changes = [
  { changeId: "add-widget", title: "Add widget" },
  { changeId: "fix-login", title: "Fix login" },
]

async function openPicker() {
  const testRenderer = await createTestRenderer({ width: 100, height: 24, exitOnCtrlC: false })
  const session = new TuiSession(testRenderer.renderer)
  const route: TuiRoute = { session }
  const result = showChangePickerTui(route, { title: "archive change", changes })
  await testRenderer.renderOnce()
  return { testRenderer, result, press: (k: string, o?: { ctrl?: boolean }) => testRenderer.renderer.keyInput.emit("keypress", keyEvent(k, o)) }
}

test("the picker lists the changes and Enter selects the highlighted one", async () => {
  const { testRenderer, result, press } = await openPicker()
  try {
    await testRenderer.renderOnce()
    const frame = testRenderer.captureCharFrame()
    expect(frame).toContain("add-widget")
    expect(frame).toContain("Add widget")
    expect(frame).toContain("fix-login")
    expect(frame).toContain("[enter] archive")
    press("down")
    await testRenderer.renderOnce()
    press("return")
    await expect(result).resolves.toEqual({ kind: "select", changeId: "fix-login" })
  } finally {
    await testRenderer.mockInput.pressKey("c", { ctrl: true })
  }
})

test("every non-select key cancels without archiving", async () => {
  const { testRenderer, result, press } = await openPicker()
  try {
    press("n")
    await expect(result).resolves.toEqual({ kind: "cancel" })
  } finally {
    await testRenderer.mockInput.pressKey("c", { ctrl: true })
  }
})
