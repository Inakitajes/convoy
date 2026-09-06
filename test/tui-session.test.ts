import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { ConfigEditor } from "../src/config-tui"
import { HomeLauncher } from "../src/home-tui"
import { browseSpecsTui } from "../src/specs-browser"
import { createTuiProgress } from "../src/tui"
import { homeRendererConfig, TuiSession, type TuiRoute } from "../src/tui-session"

import type { KeyEvent } from "@opentui/core"
import type { SpecsView } from "../src/specs"

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

const view: SpecsView = {
  targetDir: "/work/acme",
  present: true,
  changes: [{ kind: "change", id: "add-login", title: "Add login", artifacts: [] }],
  specs: [],
}

test("home renderers serialize frames with Kitty image writes", () => {
  expect(homeRendererConfig(true)).toMatchObject({
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    useThread: false,
  })
  expect(homeRendererConfig(false).useThread).toBeUndefined()
})

test("Home and a destination swap scenes without destroying the shared renderer", async () => {
  const testRenderer = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false })
  const session = new TuiSession(testRenderer.renderer)
  const route: TuiRoute = { session }

  try {
    const firstScene = session.openScene("convoy-home-scene")
    const home = new HomeLauncher(testRenderer.renderer, view.targetDir, { scene: firstScene, workRows: [] })
    testRenderer.renderer.keyInput.emit("keypress", keyEvent("s"))
    await expect(home.result).resolves.toEqual({ type: "destination", destination: "specs" })

    expect(testRenderer.renderer.isDestroyed).toBeFalse()
    expect(testRenderer.renderer.root.getChildrenCount()).toBe(1)

    const specsResult = browseSpecsTui(view, route)
    await testRenderer.renderOnce()
    expect(firstScene.isClosed).toBeTrue()
    expect(testRenderer.renderer.root.getChildrenCount()).toBe(1)
    expect(testRenderer.captureCharFrame()).toContain("project  /work/acme")

    testRenderer.renderer.keyInput.emit("keypress", keyEvent("q"))
    await expect(specsResult).resolves.toEqual({ type: "exit" })
    expect(testRenderer.renderer.isDestroyed).toBeFalse()

    const secondScene = session.openScene("convoy-home-scene")
    const returnedHome = new HomeLauncher(testRenderer.renderer, view.targetDir, { scene: secondScene, workRows: [] })
    await testRenderer.renderOnce()
    expect(testRenderer.captureCharFrame()).toContain("AUXILIARY")

    testRenderer.renderer.keyInput.emit("keypress", keyEvent("q"))
    await expect(returnedHome.result).resolves.toBeUndefined()
    expect(testRenderer.renderer.isDestroyed).toBeFalse()
  } finally {
    session.destroy()
  }

  expect(testRenderer.renderer.isDestroyed).toBeTrue()
})

test("Ctrl-C from a shared destination requests a global exit without owning renderer teardown", async () => {
  const testRenderer = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false })
  const session = new TuiSession(testRenderer.renderer)
  let interrupted = false
  const route: TuiRoute = {
    session,
    onInterrupt: () => {
      interrupted = true
    },
  }

  try {
    const result = browseSpecsTui(view, route)
    testRenderer.renderer.keyInput.emit("keypress", keyEvent("c", { ctrl: true, raw: "\u0003" }))
    await expect(result).resolves.toEqual({ type: "exit" })
    expect(interrupted).toBeTrue()
    expect(testRenderer.renderer.isDestroyed).toBeFalse()
  } finally {
    session.destroy()
  }
})

test("a borrowed dashboard stop cleans its resources but leaves the session renderer alive", async () => {
  const testRenderer = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false })
  const session = new TuiSession(testRenderer.renderer)

  try {
    const dashboard = await createTuiProgress([{ name: "implement", description: "" }], undefined, undefined, {
      route: { session },
    })
    dashboard.stop()

    expect(testRenderer.renderer.isDestroyed).toBeFalse()
    session.openScene("convoy-next-scene")
    expect(testRenderer.renderer.root.getChildrenCount()).toBe(1)
  } finally {
    session.destroy()
  }
})

test("a borrowed config editor treats q as back and leaves renderer ownership with the session", async () => {
  const testRenderer = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false })
  const session = new TuiSession(testRenderer.renderer)

  try {
    const scene = session.openScene("convoy-config-scene")
    const editor = new ConfigEditor(testRenderer.renderer, "/work/acme", undefined, undefined, scene)
    await testRenderer.renderOnce()
    expect(testRenderer.captureCharFrame()).toContain("q back")

    testRenderer.renderer.keyInput.emit("keypress", keyEvent("q"))
    await editor.result
    expect(testRenderer.renderer.isDestroyed).toBeFalse()
  } finally {
    session.destroy()
  }
})
