import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { showPublishReviewTui } from "../src/publish-review-tui"
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

const plan = { branch: "feat/widget", remote: "origin", base: "main" }
const options = { plan, title: "feat: widget", text: "## Why\n\nBecause publishing must be reviewed before it pushes." }

async function openDialog() {
  const testRenderer = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false })
  const session = new TuiSession(testRenderer.renderer)
  const route: TuiRoute = { session }
  const result = showPublishReviewTui(route, options)
  await testRenderer.renderOnce()
  return { testRenderer, result, press: (k: string, o?: { ctrl?: boolean }) => testRenderer.renderer.keyInput.emit("keypress", keyEvent(k, o)) }
}

test("the review dialog shows the destination, title, body, and create hint", async () => {
  const { testRenderer, result, press } = await openDialog()
  try {
    await testRenderer.renderOnce()
    const frame = testRenderer.captureCharFrame()
    expect(frame).toContain("create pull request")
    expect(frame).toContain("push feat/widget to origin/feat/widget")
    expect(frame).toContain("feat: widget")
    expect(frame).toContain("Because publishing must be reviewed before it pushes.")
    expect(frame).toContain("[y] create pull request")
    press("y")
    await expect(result).resolves.toEqual({ kind: "publish", title: "feat: widget", text: options.text })
  } finally {
    await testRenderer.mockInput.pressKey("c", { ctrl: true })
  }
})

test("the title is editable before publishing", async () => {
  const { testRenderer, result, press } = await openDialog()
  try {
    press("e")
    await testRenderer.renderOnce()
    press("x")
    press("return")
    await testRenderer.renderOnce()
    press("y")
    await expect(result).resolves.toEqual({ kind: "publish", title: "feat: widgetx", text: options.text })
  } finally {
    await testRenderer.mockInput.pressKey("c", { ctrl: true })
  }
})

test("every non-accept key cancels without publishing", async () => {
  const { testRenderer, result, press } = await openDialog()
  try {
    press("n")
    await expect(result).resolves.toEqual({ kind: "cancel" })
  } finally {
    await testRenderer.mockInput.pressKey("c", { ctrl: true })
  }
})
