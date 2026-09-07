import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"

import { TuiProgress, autoFollowGroup, comparisonColumnCount, initialContentTab, iteratePrompt, phaseCapabilityBadges, phaseCapabilityLabel, pickBadge, pipelineSelectionTargets } from "../src/tui"
import { displayWidth, formatMoney, limitsRow } from "../src/tui-theme"
import { shortVersion } from "../src/version"
import { reconstructedPhases } from "../src/attach"
import { qualifyInvocation } from "../src/goal-scheduler"
import { builtInAgents, builtInPipelines, resolvePipeline } from "../src/pipeline"
import { compactRunRowName } from "../src/runner"

import type { ClipboardResult } from "../src/clipboard"
import type { LimitsSnapshot } from "../src/limits"
import type { PublishSeam, ProgressPhase } from "../src/progress"
import type { AdvisorEvent } from "../src/advisor-events"
import type { RunMetadata } from "../src/metadata"

async function createDashboard(
  width = 120,
  height = 40,
  phases: ProgressPhase[] = [{ name: "implement", description: "" }],
  options: {
    observer?: boolean
    onAbort?: () => void
    onPauseToggle?: () => void
    onKeepAwakeToggle?: () => void
    onBackground?: () => void | Promise<void>
    onCycleAutoAccept?: (mode: "off" | "all" | "smart") => void
    ctrlC?: "abort" | "detach"
    autoAccept?: { mode: "off" | "all" | "smart" }
    copyResult?: ClipboardResult
    publishSeam?: PublishSeam
  } = {},
) {
  const testRenderer = await createTestRenderer({ width, height })
  const copied: string[] = []
  const dashboard = new TuiProgress(testRenderer.renderer, phases, options.onAbort, options.autoAccept, false, options.observer ?? false, "session", async (text) => {
    copied.push(text)
    return options.copyResult ?? "copied-native"
  }, options.onPauseToggle, options.onKeepAwakeToggle, options.onBackground, options.onCycleAutoAccept, options.ctrlC, options.publishSeam)
  testRenderer.renderer.copyToClipboardOSC52 = (text) => {
    copied.push(text)
    return true
  }
  return { ...testRenderer, dashboard, copied }
}

function textCoordinates(frame: string, text: string) {
  const lines = frame.split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  expect(y).toBeGreaterThanOrEqual(0)
  const x = lines[y]!.indexOf(text)
  expect(x).toBeGreaterThanOrEqual(0)
  return { x, y }
}

function lineContaining(frame: string, text: string) {
  const line = frame.split("\n").find((row) => row.includes(text))
  expect(line).toBeDefined()
  return line!
}

async function selectText(
  mockMouse: Awaited<ReturnType<typeof createTestRenderer>>["mockMouse"],
  captureCharFrame: () => string,
  text: string,
) {
  const { x, y } = textCoordinates(captureCharFrame(), text)
  await mockMouse.drag(x, y, x + text.length, y)
}

async function createReportRunDir(body: string) {
  const runDir = await mkdtemp(join(tmpdir(), "convoy-tui-"))
  await mkdir(join(runDir, "reports"))
  await writeFile(join(runDir, "reports", "implement.md"), body)
  return runDir
}

async function openShortcuts(
  mockInput: Awaited<ReturnType<typeof createTestRenderer>>["mockInput"],
  waitForFrame: Awaited<ReturnType<typeof createTestRenderer>>["waitForFrame"],
) {
  mockInput.pressKey("p", { ctrl: true })
  await mockInput.typeText("Keyboard shortcuts")
  mockInput.pressEnter()
  return waitForFrame((frame) => frame.includes("keyboard shortcuts"))
}

async function waitForRenderedFrame(
  renderOnce: () => Promise<void>,
  captureCharFrame: () => string,
  predicate: (frame: string) => boolean,
) {
  let frame = captureCharFrame()
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate(frame)) return frame
    await Bun.sleep(2)
    await renderOnce()
    frame = captureCharFrame()
  }
  throw new Error(`timed out waiting for rendered frame:\n${frame}`)
}

describe("run dashboard defaults", () => {
  test("starts live runs on session and historical runs on reports, never logs", () => {
    const live = initialContentTab("live")
    const historical = initialContentTab("historical")

    expect(live).toBe("session")
    expect(historical).toBe("reports")
    expect([live, historical]).not.toContain("logs")
  })

  test("brands the footer's border with the running version and shrinks to the wordmark when narrow", async () => {
    const fullTitle = `◆ convoy ${shortVersion()}`
    const wide = await createDashboard(120, 40)
    // Just under the width the full border title needs, so the footer falls
    // back to the bare wordmark regardless of the build's version string.
    const narrow = await createDashboard(displayWidth(fullTitle) + 4, 40)
    try {
      await wide.renderOnce()
      const wideLine = lineContaining(wide.captureCharFrame(), fullTitle).trim()
      // The title rides the footer panel's top border (rounded corners), not
      // a content row.
      expect(wideLine.startsWith("╭")).toBe(true)
      expect(wideLine).toContain("─")

      await narrow.renderOnce()
      const narrowFrame = narrow.captureCharFrame()
      expect(narrowFrame).toContain("◆ convoy")
      expect(narrowFrame).not.toContain(shortVersion())
    } finally {
      wide.dashboard.stop()
      narrow.dashboard.stop()
    }
  })

  test("labels audit-only phases without tagging writable work", () => {
    expect(phaseCapabilityLabel({ readOnly: true })).toBe("audit · read-only")
    expect(phaseCapabilityLabel({})).toBeUndefined()
    expect(phaseCapabilityBadges({ readOnly: true })).toEqual(["audit · read-only", "read-only", "ro"])
    expect(phaseCapabilityBadges({})).toEqual([])
    expect(phaseCapabilityLabel({ plannedAdvisor: "anthropic/opus" })).toBe("advisor")
    expect(phaseCapabilityBadges({ plannedAdvisor: "anthropic/opus" })).toEqual(["advisor", "adv"])
  })

  test("renders the advisor timeline with lifecycle details after selecting its tab", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(120, 40, [{
      name: "implement",
      description: "",
      plannedAdvisor: "anthropic/opus",
      advisorMaxCalls: 2,
    }])
    try {
      const base = {
        timestamp: new Date(0).toISOString(),
        callId: "call-1",
        phase: "implement",
        attempt: 1,
        trigger: "on-demand" as const,
        budget: { used: 1, max: 2 },
      }
      const events: AdvisorEvent[] = [
        { ...base, id: "1", type: "advisor.requested", model: "anthropic/opus" },
        {
          ...base,
          id: "2",
          type: "advisor.completed",
          model: "anthropic/opus",
          latencyMs: 15,
          adviceChars: 4,
          usage: { model: "anthropic/opus", cost: 0.02, tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
        },
        { ...base, id: "3", type: "advisor.delivered", delivery: "tool" },
        { ...base, id: "4", type: "advisor.feedback", outcome: "adopted" },
        { ...base, id: "5", callId: "call-2", type: "advisor.failed", model: "anthropic/opus", latencyMs: 8, error: { code: "unavailable" } },
      ]
      for (const event of events) dashboard.phaseAdvisorEvent("implement", event)

      mockInput.pressKey("4")
      await renderOnce()

      const frame = captureCharFrame()
      expect(frame).toContain("4 advisor")
      expect(frame).toContain("requested")
      expect(frame).toContain("on-demand")
      expect(frame).toContain("completed")
      expect(frame).toContain("$0.02")
      expect(frame).toContain("tool")
      expect(frame).toContain("adopted")
      expect(frame).toContain("unavailable")
    } finally {
      dashboard.stop()
    }
  })

  test("stacks narrow dashboards and keeps an overlong top pipeline scrollable", async () => {
    const phases = Array.from({ length: 10 }, (_, index) => ({ name: `step-${index + 1}`, description: "" }))
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(80, 24, phases)
    try {
      await renderOnce()
      const first = captureCharFrame()
      expect(first.indexOf("step-1")).toBeLessThan(first.indexOf("scheduled"))

      for (let index = 0; index < 8; index++) mockInput.pressArrow("down")
      await renderOnce()
      const scrolled = captureCharFrame()
      expect(scrolled).toMatch(/▸ .*step-9/)
      expect(scrolled).not.toContain("step-1")
    } finally {
      dashboard.stop()
    }
  })

  test("the tree badge degrades to shorter forms and then disappears, never costing the name a column", () => {
    const badges = phaseCapabilityBadges({ readOnly: true })

    expect(pickBadge(badges, 20, false)).toBe("audit · read-only")
    expect(pickBadge(badges, 12, false)).toBe("read-only")
    expect(pickBadge(badges, 4, false)).toBe("ro")
    expect(pickBadge(badges, 1, false)).toBeUndefined()

    // With meta following, each form also pays for its ` · ` separator.
    expect(pickBadge(badges, 12, true)).toBe("read-only")
    expect(pickBadge(badges, 11, true)).toBe("ro")
    expect(pickBadge(badges, 4, true)).toBeUndefined()

    // A writable phase never grows a badge, however much room there is.
    expect(pickBadge(phaseCapabilityBadges({}), 40, false)).toBeUndefined()
  })

  test("p delegates pause control and renders pausing and paused states", async () => {
    let toggles = 0
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(120, 40, [{ name: "implement", description: "" }], { onPauseToggle: () => toggles++ })
    try {
      mockInput.pressKey("p")
      expect(toggles).toBe(1)

      dashboard.runControlState("pausing", 2)
      await renderOnce()
      expect(captureCharFrame()).toContain("pausing · 2 active")

      dashboard.runControlState("paused", 0)
      await renderOnce()
      const paused = captureCharFrame()
      expect(paused).toContain("paused · p resume")
      expect(paused).toContain("ctrl+p")
    } finally {
      dashboard.stop()
    }
  })

  test("p explains why pause is unavailable on an attached observer dashboard", async () => {
    let toggles = 0
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(120, 40, [{ name: "implement", description: "" }], { observer: true, onPauseToggle: () => toggles++ })
    try {
      mockInput.pressKey("p")
      mockInput.pressKey("3")
      await renderOnce()

      expect(toggles).toBe(0)
      expect(captureCharFrame()).toContain("pause isn't available while attached read-only")
    } finally {
      dashboard.stop()
    }
  })

  test("ctrl+p opens commands without triggering pause, while p still pauses", async () => {
    let pauses = 0
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(120, 40, [{ name: "implement", description: "" }], { onPauseToggle: () => pauses++ })
    try {
      await renderOnce()
      expect(captureCharFrame()).toContain("ctrl+p")

      mockInput.pressKey("p", { ctrl: true })
      await renderOnce()
      expect(captureCharFrame()).toContain("commands")
      expect(pauses).toBe(0)

      mockInput.pressEscape()
      // An isolated Escape needs a beat to settle before the next printable key;
      // otherwise terminal parsers legitimately read the pair as Meta+P.
      await Bun.sleep(20)
      mockInput.pressKey("p")
      expect(pauses).toBe(1)
    } finally {
      dashboard.stop()
    }
  })

  test("the command palette toggles keep-awake through its callback", async () => {
    let toggles = 0
    const { dashboard, mockInput } = await createDashboard(120, 40, [{ name: "implement", description: "" }], { onKeepAwakeToggle: () => toggles++ })
    try {
      mockInput.pressKey("p", { ctrl: true })
      // Keep Mac awake is the first live-run command.
      mockInput.pressEnter()

      expect(toggles).toBe(1)
    } finally {
      dashboard.stop()
    }
  })

  test("palette Enter on Send to background calls onBackground", async () => {
    let backgrounds = 0
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(120, 40, [{ name: "implement", description: "" }], { onBackground: () => { backgrounds++ } })
    try {
      mockInput.pressKey("p", { ctrl: true })
      // "background" contains both j and k, which the palette treats as arrow
      // keys — "send" keeps the filter free of navigation letters.
      await mockInput.typeText("send")
      mockInput.pressEnter()
      await renderOnce()

      expect(backgrounds).toBe(1)
      // The palette closed after dispatching.
      expect(captureCharFrame()).not.toContain("⌘ commands")
    } finally {
      dashboard.stop()
    }
  })

  test("Ctrl+C aborts on a first-attach (abort-mode) controller dashboard", async () => {
    let aborts = 0
    const { dashboard, mockInput } = await createDashboard(120, 40, [{ name: "implement", description: "" }], {
      onAbort: () => aborts++,
      ctrlC: "abort",
    })
    try {
      await mockInput.pressKey("c", { ctrl: true })
      expect(aborts).toBe(1)
    } finally {
      dashboard.stop()
    }
  })

  test("Ctrl+C detaches on a menu-opened (detach-mode) controller dashboard instead of aborting", async () => {
    let aborts = 0
    let backgrounds = 0
    const { dashboard, mockInput } = await createDashboard(120, 40, [{ name: "implement", description: "" }], {
      onAbort: () => { aborts++ },
      onBackground: () => { backgrounds++ },
      ctrlC: "detach",
    })
    try {
      await mockInput.pressKey("c", { ctrl: true })
      expect(aborts).toBe(0)
      expect(backgrounds).toBe(1)
    } finally {
      dashboard.stop()
    }
  })

  test("Abort the run is palette-only on a detach mode and opens a confirm modal", async () => {
    let aborts = 0
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(120, 40, [{ name: "implement", description: "" }], {
      onAbort: () => { aborts++ },
      ctrlC: "detach",
    })
    try {
      const openAbort = async () => {
        mockInput.pressKey("p", { ctrl: true })
        // No j/k in "Abort the run": every letter lands in the filter.
        await mockInput.typeText("Abort the run")
        mockInput.pressEnter()
        await renderOnce()
      }

      await openAbort()
      // The list item opens the modal; it must not have killed anything yet.
      expect(aborts).toBe(0)
      expect(captureCharFrame()).toContain("abort run")

      // Default No: escape cancels without aborting.
      mockInput.pressEscape()
      await renderOnce()
      expect(aborts).toBe(0)

      // An isolated Escape needs a beat to settle before the next printable
      // key; otherwise the terminal parser can read the pair as Meta+P.
      await Bun.sleep(20)

      // A deliberate y confirms.
      await openAbort()
      mockInput.pressKey("y")
      await renderOnce()
      expect(aborts).toBe(1)
    } finally {
      dashboard.stop()
    }
  })

  test("shift+tab on a controller routes the cycled mode through onCycleAutoAccept", async () => {
    const modes: Array<"off" | "all" | "smart"> = []
    const { dashboard, mockInput } = await createDashboard(120, 40, [{ name: "implement", description: "" }], { autoAccept: { mode: "off" }, onCycleAutoAccept: (mode) => void modes.push(mode) })
    try {
      mockInput.pressTab({ shift: true })
      await mockInput.pressTab({ shift: true })
      expect(modes).toEqual(["all", "smart"])
    } finally {
      dashboard.stop()
    }
  })
})

describe("footer hints and the command palette", () => {
  test("the footer stays inside the panel at every terminal width", async () => {
    // The footer is one unwrapped line in a fixed-height box: anything wider
    // than the panel is silently chopped off against the border.
    for (const width of [160, 120, 100, 90, 80, 70, 60, 50, 46]) {
      const { dashboard, renderOnce, captureCharFrame } = await createDashboard(width, 40)
      try {
        dashboard.start("abc1234", process.cwd())
        dashboard.serverReady("http://127.0.0.1:41234")
        dashboard.phaseRunning("implement")
        await renderOnce()
        const row = lineContaining(captureCharFrame(), "ctrl+p")
        expect(displayWidth(row), `width ${width}`).toBeLessThanOrEqual(width)
        expect(row.match(/│/g)?.length).toBe(2)
      } finally {
        dashboard.stop()
      }
    }
  })

  test("a narrow footer keeps the way to the rest of the shortcuts", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(60, 40)
    try {
      dashboard.start("abc1234", process.cwd())
      dashboard.phaseRunning("implement")
      await renderOnce()
      // Hints were dropped, so the pinned hint says where they went.
      const frame = captureCharFrame()
      expect(frame).toContain("ctrl+p")
      expect(frame).toContain("all shortcuts")
    } finally {
      dashboard.stop()
    }
  })

  test("a wide footer keeps its hints and says ctrl+p opens commands", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(160, 40)
    try {
      dashboard.start("abc1234", process.cwd())
      dashboard.phaseRunning("implement")
      await renderOnce()
      const row = lineContaining(captureCharFrame(), "ctrl+p")
      expect(row).not.toContain("[↑↓] step")
      expect(row).not.toContain("[enter] read")
      expect(row).not.toContain("[←→] tab")
      expect(row).toContain("[o] session")
      expect(row).toContain("[ctrl+p] commands")
      expect(row).not.toContain("all shortcuts")
    } finally {
      dashboard.stop()
    }
  })

  test("[MF-1] a permission footer suppresses review actions that route to the permission", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(200, 40)
    try {
      const permission = dashboard.askPermission({ id: "permission-1", permission: "bash", command: "ls", patterns: [] })
      const review = dashboard.askHumanReview({ stepName: "implement", iterations: 0 })
      await renderOnce()

      // Permission routing runs first, so [a] means "always" here rather than
      // the review gate's advertised "abort" action.
      const row = lineContaining(captureCharFrame(), "always")
      expect(row).toContain("always")

      mockInput.pressKey("a")
      expect(await permission).toBe("always")

      // The review remains queued until the next [a], proving the first one
      // answered the permission prompt rather than aborting the review gate.
      let reviewReply: string | undefined
      void review.then((reply) => {
        reviewReply = reply
      })
      await Promise.resolve()
      expect(reviewReply).toBeUndefined()
      mockInput.pressKey("a")
      expect(await review).toBe("abort")

      expect(row).not.toContain("open OpenCode")
      expect(row).not.toContain("abort")
    } finally {
      dashboard.stop()
    }
  })

  test("[SF-1] a narrow permission footer marks choices hidden from the row", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(46, 40)
    try {
      void dashboard.askPermission({ id: "permission-1", permission: "bash", command: "ls", patterns: [] })
      await renderOnce()

      expect(captureCharFrame()).toMatch(/\+\d/)
    } finally {
      dashboard.stop()
    }
  })

  test("[SF-1] a narrow review footer marks choices hidden from the row", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(46, 40)
    try {
      void dashboard.askHumanReview({ stepName: "implement", iterations: 0 })
      await renderOnce()

      expect(captureCharFrame()).toMatch(/\+\d/)
    } finally {
      dashboard.stop()
    }
  })

  test("a budget gate exposes reset and abort, and r resets without opening a session", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(200, 40)
    try {
      const action = dashboard.askHumanReview({ stepName: "implement", iterations: 0, kind: "budget-gate", canRetry: false })
      await renderOnce()

      const frame = captureCharFrame()
      expect(frame).toContain("step budget reached")
      expect(frame).toContain("reset and continue")
      expect(frame).not.toContain("open OpenCode")

      mockInput.pressKey("r")
      expect(await action).toBe("reset")
    } finally {
      dashboard.stop()
    }
  })

  // Regression: the palette gated every action behind `!finished`, so the
  // finish screen offered a single entry while five actions sat on the keyboard.
  test("the finish screen's palette lists its own actions", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(120, 40)
    try {
      dashboard.start("abc1234", process.cwd())
      void dashboard.runFinished({ status: "completed", runDir: "" })
      await renderOnce()

      mockInput.pressKey("p", { ctrl: true })
      await renderOnce()
      const text = captureCharFrame()
      expect(text).toContain("Iterate in a new session")
      expect(text).toContain("Open lazygit")
      expect(text).toContain("Close the dashboard")
      expect(text).toContain("Keyboard shortcuts")
    } finally {
      dashboard.stop()
    }
  })

  test("the finish screen's footer points at the palette too", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(120, 40)
    try {
      dashboard.start("abc1234", process.cwd())
      void dashboard.runFinished({ status: "completed", runDir: "" })
      await renderOnce()
      const frame = captureCharFrame()
      expect(frame).toContain("ctrl+p")
      expect(frame).toContain("[q] close")
    } finally {
      dashboard.stop()
    }
  })

  test("setHostControls without a publish field keeps the existing publication seam", async () => {
    // Live attach wires pause/background after construction and must not
    // replace the whole hostControls object, dropping the publish seam so a
    // coordinated finish screen never offers Create pull request.
    const seam: PublishSeam = {
      async prepare() {
        return { ok: false, message: "no remote configured" }
      },
      async apply() {
        throw new Error("apply should not run")
      },
    }
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(120, 40, [{ name: "implement", description: "" }], {
      publishSeam: seam,
      onPauseToggle: () => {},
      onBackground: () => {},
    })
    try {
      dashboard.start("abc1234", process.cwd())
      void dashboard.runFinished({ status: "completed", runDir: "" })
      dashboard.setHostControls({
        onPauseToggle: () => {},
        onBackground: () => {},
      })
      mockInput.pressKey("p", { ctrl: true })
      await renderOnce()
      expect(captureCharFrame()).toContain("Create pull request")
    } finally {
      dashboard.stop()
    }
  })

  test("the shortcuts view documents every content tab, not just three", async () => {
    const { dashboard, mockInput, captureCharFrame, waitForFrame } = await createDashboard(120, 40)
    try {
      dashboard.start("abc1234", process.cwd())
      await openShortcuts(mockInput, waitForFrame)

      const rows = [captureCharFrame()]
      for (let index = 0; index < 20; index++) {
        mockInput.pressKey("j")
        rows.push(await waitForFrame((frame) => frame.includes("keyboard shortcuts")))
      }
      const help = rows.join("\n")
      expect(help).toContain("show the session tab")
      expect(help).toContain("show the reports tab")
      expect(help).toContain("show the logs tab")
      expect(help).toContain("show the advisor tab")
      expect(help).toContain("open the fullscreen reader")
      expect(help).toContain("abort the run")
    } finally {
      dashboard.stop()
    }
  })

  test("the shortcuts view fits the terminal and scrolls instead of overflowing it", async () => {
    const { dashboard, mockInput, waitForFrame } = await createDashboard(120, 24)
    try {
      dashboard.start("abc1234", process.cwd())
      const first = await openShortcuts(mockInput, waitForFrame)
      expect(first.split("\n")).toHaveLength(25)
      mockInput.pressKey("j")
      const second = await waitForFrame((frame) => frame !== first && frame.includes("keyboard shortcuts"))
      expect(second.split("\n")).toHaveLength(25)
    } finally {
      dashboard.stop()
    }
  })

  test("[MF-2] the focused reader's palette still offers the selected session", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(120, 40)
    try {
      mockInput.pressEnter()
      mockInput.pressKey("p", { ctrl: true })
      await renderOnce()
      const palette = captureCharFrame()

      expect(palette).toContain("Open session")
      expect(palette).toContain("commands")
    } finally {
      dashboard.stop()
    }
  })
})

describe("dashboard content selection", () => {
  test("copies selected session text and clears the successful selection", async () => {
    const { dashboard, mockMouse, renderer, renderOnce, captureCharFrame, copied } = await createDashboard()
    try {
      const text = "session selection payload"
      dashboard.phaseStarted("implement")
      dashboard.phaseMessage("implement", { channel: "response", text })
      dashboard.phaseActivity("implement", "session ready")
      await renderOnce()

      await selectText(mockMouse, captureCharFrame, text)

      expect(copied).toEqual([text])
      expect(renderer.hasSelection).toBeFalse()
    } finally {
      dashboard.stop()
    }
  })

  test("copies selected report text", async () => {
    const text = "report selection payload"
    const runDir = await createReportRunDir(text)
    const { dashboard, mockInput, mockMouse, renderOnce, captureCharFrame, copied } = await createDashboard()
    try {
      dashboard.start("run", process.cwd(), runDir)
      mockInput.pressKey("2")
      await waitForRenderedFrame(renderOnce, captureCharFrame, (frame) => frame.includes(text))

      await selectText(mockMouse, captureCharFrame, text)

      expect(copied).toEqual([text])
    } finally {
      dashboard.stop()
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test("renders markdown in the session and report views", async () => {
    const runDir = await createReportRunDir("## Report\n\n- `result`")
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard()
    try {
      dashboard.phaseStarted("implement")
      // Blank lines between the blocks on purpose: without one, the quote is a
      // lazy continuation *inside* the list item and the test would be pinning
      // that nesting rather than the markdown structure it means to check.
      dashboard.phaseMessage("implement", { channel: "response", text: "# Answer\n\n- **first**\n\n> quoted" })
      dashboard.phaseActivity("implement", "response received")
      await renderOnce()

      const session = captureCharFrame()
      expect(session).toContain("Answer")
      expect(session).toContain("• first")
      expect(session).toContain("▎ quoted")
      expect(session).not.toContain("# Answer")
      expect(session).not.toContain("**first**")

      dashboard.start("run", process.cwd(), runDir)
      mockInput.pressKey("2")
      const report = await waitForRenderedFrame(renderOnce, captureCharFrame, (frame) => frame.includes("Report") && frame.includes("• result"))

      expect(report).not.toContain("## Report")
      expect(report).not.toContain("`result`")
    } finally {
      dashboard.stop()
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test("wraps a long log message under the message column instead of cutting it", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(90, 40)
    try {
      dashboard.phaseStarted("implement")
      mockInput.pressKey("3")
      dashboard.phaseActivity("implement", "wrapped ".repeat(20).trim())
      dashboard.phaseActivity("implement", "ready")
      await renderOnce()

      const rendered = captureCharFrame().split("\n").filter((line) => line.includes("wrapped"))
      expect(rendered.length).toBeGreaterThan(1)
      // Continuation rows hang under the message column rather than restarting
      // at column 0, so the timestamp gutter stays a column.
      const gutter = rendered[0]!.indexOf("wrapped")
      expect(gutter).toBeGreaterThan(0)
      expect(rendered[1]!.indexOf("wrapped")).toBe(gutter)
    } finally {
      dashboard.stop()
    }
  })

  test("renders log messages as prose, applying typography but not block markdown", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(90, 40)
    try {
      dashboard.phaseStarted("implement")
      mockInput.pressKey("3")
      dashboard.phaseActivity("implement", "- ran `bun test` twice")
      dashboard.phaseActivity("implement", "ready")
      await renderOnce()

      // A message starting with "- " is a message, not a bullet.
      const frame = captureCharFrame()
      const row = lineContaining(frame, "- ran bun test twice")
      expect(row).not.toContain("`bun test`")
      expect(row).not.toContain("• ran")
    } finally {
      dashboard.stop()
    }
  })

  test("elides a log message that would outgrow its row budget", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(60, 40)
    try {
      dashboard.phaseStarted("implement")
      mockInput.pressKey("3")
      dashboard.phaseActivity("implement", "verbose ".repeat(40).trim())
      dashboard.phaseActivity("implement", "ready")
      await renderOnce()

      const rendered = captureCharFrame().split("\n").filter((line) => line.includes("verbose"))
      expect(rendered.length).toBe(3)
      expect(rendered[2]).toContain("…")
    } finally {
      dashboard.stop()
    }
  })

  test("separate reasoning summaries stay separate bullets under one label", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard()
    try {
      dashboard.phaseStarted("implement")
      // Each summary is its own provider part; merging them would read as
      // "…diff scope inspectionInspecting rules…".
      dashboard.phaseMessage("implement", { channel: "reasoning", text: "Planning diff scope inspection", partID: "reasoning:1" })
      dashboard.phaseMessage("implement", { channel: "reasoning", text: "Inspecting rules", partID: "reasoning:2" })
      dashboard.phaseMessage("implement", { channel: "reasoning", text: " and loading skills", partID: "reasoning:2" })
      dashboard.phaseMessage("implement", { channel: "response", text: "done", partID: "text:1" })
      dashboard.phaseActivity("implement", "streamed")
      await renderOnce()

      const text = captureCharFrame()
      expect(text).toContain("· Planning diff scope inspection")
      // Deltas of the same part still concatenate into one bullet.
      expect(text).toContain("· Inspecting rules and loading skills")
      expect(text).not.toContain("inspectionInspecting")
      // One label for the whole reasoning stretch, then the response block.
      expect(text.match(/reasoning/g)).toHaveLength(1)
      expect(text).toContain("response")
    } finally {
      dashboard.stop()
    }
  })

  test("re-wraps transcript lines when the panel width changes", async () => {
    const { dashboard, renderOnce, resize, captureCharFrame } = await createDashboard(200, 40)
    try {
      dashboard.phaseStarted("implement")
      dashboard.phaseMessage("implement", { channel: "reasoning", text: "wrap ".repeat(30).trim(), partID: "reasoning:1" })
      dashboard.phaseActivity("implement", "streamed")
      await renderOnce()
      const wide = captureCharFrame().split("\n").filter((line) => line.includes("wrap")).length

      resize(90, 40)
      dashboard.phaseActivity("implement", "still streaming")
      await renderOnce()
      const narrow = captureCharFrame().split("\n").filter((line) => line.includes("wrap")).length

      expect(narrow).toBeGreaterThan(wide)
    } finally {
      dashboard.stop()
    }
  })

  test("opens reports, session history, and logs with v; the reader scrolls with j and k", async () => {
    const report = "# Result\n\n- first\n- second"
    const runDir = await createReportRunDir(report)
    const { dashboard, copied, mockInput, renderOnce, captureCharFrame, waitForFrame } = await createDashboard()
    try {
      dashboard.start("run", process.cwd(), runDir)
      dashboard.phaseStarted("implement")
      dashboard.phaseMessage("implement", { channel: "response", text: "# Session\n\nmessage history" })
      mockInput.pressKey("2")
      await waitForRenderedFrame(renderOnce, captureCharFrame, (frame) => frame.includes("Result") && frame.includes("• first"))

      mockInput.pressKey("v")
      await renderOnce()
      expect(captureCharFrame()).toContain("report · implement")

      mockInput.pressKey("c")
      await waitForFrame((frame) => frame.includes("copied"))
      expect(copied).toEqual([report])

      mockInput.pressKey("v")
      await renderOnce()
      expect(captureCharFrame()).toContain("2 reports")

      mockInput.pressKey("1")
      mockInput.pressKey("v")
      await renderOnce()
      expect(captureCharFrame()).toContain("session · implement")
      expect(captureCharFrame()).toContain("message history")
      mockInput.pressEscape()
      await Bun.sleep(20)
      await renderOnce()
      expect(captureCharFrame()).toContain("1 session")

      for (let index = 0; index < 50; index++) dashboard.phaseActivity("implement", `log item ${index}`)
      mockInput.pressKey("3")
      mockInput.pressKey("v")
      await renderOnce()
      const top = captureCharFrame()
      expect(top).toContain("logs · implement")
      expect(top).toContain("log item 49")
      expect(top).toContain("top")

      mockInput.pressKey("j")
      const scrolled = await waitForFrame((frame) => frame.includes("logs · implement") && frame !== top)
      expect(scrolled).not.toContain("log item 49")
      mockInput.pressKey("k")
      await waitForFrame((frame) => frame.includes("log item 49"))

      mockInput.pressEscape()
      await Bun.sleep(20)
      await renderOnce()
      expect(captureCharFrame()).toContain("3 logs")
    } finally {
      dashboard.stop()
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test("paints a modal over the open reader without losing it", async () => {
    const runDir = await createReportRunDir("# Result\n\n- only line")
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(200, 50)
    try {
      dashboard.start("run", process.cwd(), runDir)
      mockInput.pressKey("2")
      await waitForRenderedFrame(renderOnce, captureCharFrame, (frame) => frame.includes("Result"))

      // Open the reader — the opaque overlay takes over the screen.
      mockInput.pressKey("v")
      await renderOnce()
      expect(captureCharFrame()).toContain("report · implement")

      // A permission prompt arriving while the reader is open must still paint
      // over it rather than being swallowed by fullscreen input handling.
      const permission = dashboard.askPermission({ id: "1", permission: "bash", command: "ls", patterns: [] })
      await renderOnce()

      const prompted = captureCharFrame()
      expect(prompted).toContain("permission required")
      expect(prompted).toContain("bash")

      mockInput.pressKey("r")
      expect(await permission).toBe("reject")
      await renderOnce()
      expect(captureCharFrame()).toContain("report · implement")

      mockInput.pressEscape()
      await Bun.sleep(20)
      await renderOnce()
      expect(captureCharFrame()).toContain("2 reports")
    } finally {
      dashboard.stop()
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test("shows the specific report copy failure in the fullscreen reader", async () => {
    for (const [result, label] of [
      ["unsupported", "terminal clipboard (OSC52) unavailable"],
      ["transport-failed", "couldn't copy report; report is too large for this terminal transport"],
    ] as const) {
      const runDir = await createReportRunDir("# Result")
      const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(240, 40, [{ name: "implement", description: "" }], { copyResult: result })
      try {
        dashboard.start("run", process.cwd(), runDir)
        mockInput.pressKey("2")
        await waitForRenderedFrame(renderOnce, captureCharFrame, (frame) => frame.includes("Result"))

        mockInput.pressKey("v")
        await renderOnce()
        mockInput.pressKey("c")
        expect(await waitForRenderedFrame(renderOnce, captureCharFrame, (frame) => frame.includes(label))).toContain(label)
      } finally {
        dashboard.stop()
        await rm(runDir, { recursive: true, force: true })
      }
    }
  })

  test("copies selected log text", async () => {
    const { dashboard, mockInput, mockMouse, renderOnce, captureCharFrame, copied } = await createDashboard()
    try {
      const text = "Next command: /mr-comment 20260717-122207-c4cn 90"
      mockInput.pressKey("3")
      dashboard.phaseActivity("implement", text)
      await renderOnce()

      await selectText(mockMouse, captureCharFrame, text)

      expect(copied).toEqual([text])
    } finally {
      dashboard.stop()
    }
  })

  test("does not copy tab-strip or cross-panel selections", async () => {
    const { dashboard, mockMouse, renderOnce, captureCharFrame, copied } = await createDashboard()
    try {
      const sessionText = "session selection payload"
      dashboard.phaseStarted("implement")
      dashboard.phaseMessage("implement", { channel: "response", text: sessionText })
      dashboard.phaseActivity("implement", "session ready")
      await renderOnce()

      const frame = captureCharFrame()
      const tab = textCoordinates(frame, "1 session")
      await mockMouse.drag(tab.x, tab.y, tab.x + "1 session".length, tab.y)

      const session = textCoordinates(frame, sessionText)
      const pipeline = textCoordinates(frame, "implement")
      await mockMouse.drag(session.x, session.y, pipeline.x, pipeline.y)

      expect(copied).toEqual([])
    } finally {
      dashboard.stop()
    }
  })

  test("retains the selection when OSC52 copying is unavailable", async () => {
    const { dashboard, mockMouse, renderer, renderOnce, captureCharFrame } = await createDashboard()
    try {
      const text = "uncopied session selection"
      const failedCopies: string[] = []
      renderer.copyToClipboardOSC52 = (selectedText) => {
        failedCopies.push(selectedText)
        return false
      }
      dashboard.phaseStarted("implement")
      dashboard.phaseMessage("implement", { channel: "response", text })
      dashboard.phaseActivity("implement", "session ready")
      await renderOnce()

      await selectText(mockMouse, captureCharFrame, text)

      expect(failedCopies).toEqual([text])
      expect(renderer.hasSelection).toBeTrue()
    } finally {
      dashboard.stop()
    }
  })

  test("removes its selection listener when stopped", async () => {
    const { dashboard, renderer } = await createDashboard()
    try {
      expect(renderer.listenerCount("selection")).toBe(1)

      dashboard.stop()

      expect(renderer.listenerCount("selection")).toBe(0)
    } finally {
      if (!renderer.isDestroyed) dashboard.stop()
    }
  })
})

describe("publish modal", () => {
  type SeamOptions = { pushFails?: boolean; prFails?: boolean; prUrl?: string; existingUrl?: string }

  function fakeSeam(options: SeamOptions = {}) {
    const calls = { apply: 0, pushed: 0 }
    const seam: PublishSeam = {
      async prepare() {
        return { ok: true as const, plan: { branch: "convoy/run", remote: "origin", base: "main" } }
      },
      async apply(plan) {
        calls.apply++
        if (options.pushFails) {
          return { ok: false as const, message: "push to origin/convoy/run was rejected; nothing was published: no write access" }
        }
        calls.pushed++
        if (options.prFails) {
          return { ok: false as const, message: `the branch was pushed to ${plan.remote}/${plan.branch}, but creating the pull request failed: gh pr create didn't complete; retry to locate or create it without pushing again unnecessarily` }
        }
        return { ok: true as const, outcome: { pushed: true, ...(options.existingUrl || options.prUrl ? { url: options.existingUrl ?? options.prUrl! } : {}) } }
      },
    }
    return { seam, calls }
  }

  /** Drives [f] through prepare, landing on the confirm screen. */
  async function confirm(options: SeamOptions & { width?: number } = {}) {
    const { seam, calls } = fakeSeam(options)
    const harness = await createDashboard(options.width ?? 120, 40, [{ name: "implement", description: "" }], { publishSeam: seam })
    harness.dashboard.start("run", process.cwd())
    void harness.dashboard.runFinished({ status: "completed", runDir: "" })
    harness.mockInput.pressKey("f")
    await harness.waitForFrame((frame) => frame.includes("create pull request"))
    return { ...harness, calls, seam }
  }

  test("the confirm modal discloses the destination before anything is published", async () => {
    const { dashboard, captureCharFrame, calls } = await confirm()
    try {
      const text = captureCharFrame()
      expect(text).toContain("convoy/run")
      expect(text).toContain("origin")
      expect(text).toContain("never forced")
      expect(calls).toEqual({ apply: 0, pushed: 0 })
    } finally {
      dashboard.stop()
    }
  })

  test("any key other than enter cancels without pushing", async () => {
    const { dashboard, mockInput, waitForFrame, calls } = await confirm()
    try {
      mockInput.pressKey("x")
      await waitForFrame((frame) => !frame.includes("create pull request"))
      expect(calls).toEqual({ apply: 0, pushed: 0 })
    } finally {
      dashboard.stop()
    }
  })

  test("acceptance pushes and opens the pull request, showing its URL", async () => {
    const { dashboard, mockInput, waitForFrame, captureCharFrame, calls } = await confirm({ prUrl: "https://github.com/acme/repo/pull/7" })
    try {
      mockInput.pressEnter()
      const text = await waitForFrame((frame) => frame.includes("github.com/acme/repo/pull/7"))
      expect(calls).toEqual({ apply: 1, pushed: 1 })
      expect(text).toContain("pushed to origin")
    } finally {
      dashboard.stop()
    }
  })

  test("a rejected push stops before the pull request and offers no force", async () => {
    const { dashboard, mockInput, waitForFrame, calls } = await confirm({ pushFails: true })
    try {
      mockInput.pressEnter()
      const text = await waitForFrame((frame) => frame.includes("push to origin/convoy/run was rejected"))
      expect(calls).toEqual({ apply: 1, pushed: 0 })
      expect(text).toContain("nothing was published")
      expect(text.toLowerCase()).not.toContain("force")
    } finally {
      dashboard.stop()
    }
  })

  test("a PR failure after the push preserves the outcome and can be retried", async () => {
    const { dashboard, mockInput, waitForFrame, captureCharFrame, calls, seam } = await confirm({ prFails: true })
    try {
      mockInput.pressEnter()
      await waitForFrame((frame) => frame.includes("press any key to dismiss"))
      const failed = captureCharFrame().replace(/\s+/g, " ")
      expect(failed).toContain("pushed to origin/convoy/run")
      expect(failed).toContain("gh pr create didn't complete")
      expect(calls).toEqual({ apply: 1, pushed: 1 })

      // The retry locates the existing PR instead of pushing/creating again.
      seam.apply = async () => ({ ok: true as const, outcome: { pushed: false, url: "https://github.com/acme/repo/pull/9" } })
      mockInput.pressKey("x")
      mockInput.pressKey("f")
      await waitForFrame((frame) => frame.includes("never forced"))
      mockInput.pressEnter()
      const text = await waitForFrame((frame) => frame.includes("acme/repo/pull/9"))
      expect(text).toContain("pushed to origin")
    } finally {
      dashboard.stop()
    }
  })
})

describe("dashboard header status row", () => {
  test("a plain pipeline spreads two rows: ◆ running + totals, clock below", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(120, 40)
    try {
      dashboard.phaseStarted("implement")
      await renderOnce()
      const frame = captureCharFrame()
      const beforePipeline = frame.slice(0, frame.indexOf("╭─ pipeline")).trim().split("\n")
      // dir line + header top border + status row + clock row + bottom border.
      expect(beforePipeline).toHaveLength(5)
      const statusRow = beforePipeline[2]!
      expect(statusRow).toContain("◆ running")
      expect(statusRow).toContain("tokens")
      // The clock moved under the status word; the totals keep cost + tokens.
      const clockRow = beforePipeline[3]!
      expect(clockRow).toMatch(/│ \d+:\d{2}/)
      expect(clockRow).not.toContain("tokens")
      // No goal segments, no stray meter placeholders on either row.
      expect(beforePipeline.join("\n")).not.toContain("goal ")
      expect(statusRow).not.toContain("…")
    } finally {
      dashboard.stop()
    }
  })

  test("a slowing pipeline names the pausing state without a stray separator", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(120, 40)
    try {
      dashboard.runControlState("pausing", 1)
      dashboard.phaseStarted("implement")
      await renderOnce()
      const row = lineContaining(captureCharFrame(), "pausing · 1 active")
      expect(row.trimStart().startsWith("│ pausing")).toBe(true)
    } finally {
      dashboard.stop()
    }
  })
})

describe("header limit chips", () => {
  type Dashboard = Awaited<ReturnType<typeof createDashboard>>["dashboard"]
  const setLimits = (dashboard: Dashboard, snapshot: LimitsSnapshot) => {
    ;(dashboard as unknown as { limits: LimitsSnapshot }).limits = snapshot
  }
  const now = Date.now()
  // The dashboard coalesces repaints per frame, so ask for frames until the
  // injected snapshot — or the absence of any chip — is what's on screen.
  const renderWithLimits = (
    dashboard: Dashboard,
    renderOnce: () => Promise<void>,
    captureCharFrame: () => string,
    snapshot: LimitsSnapshot,
    expectChip: boolean,
  ) => {
    dashboard.phaseStarted("implement")
    setLimits(dashboard, snapshot)
    return waitForRenderedFrame(renderOnce, captureCharFrame, (frame) => frame.includes("⚠") === expectChip)
  }

  test("no second row while every meter is healthy", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(120, 40)
    try {
      const frame = await renderWithLimits(dashboard, renderOnce, captureCharFrame, { gpt: { sessionPct: 42, weeklyPct: 18 }, openrouter: { kind: "remaining", amount: 26.78 }, fetchedAt: now }, false)
      expect(frame).not.toContain("⚠")
    } finally {
      dashboard.stop()
    }
  })

  test("a hot GPT session earns a chip with its reset countdown", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(120, 40)
    try {
      const frame = await renderWithLimits(dashboard, renderOnce, captureCharFrame, { gpt: { sessionPct: 92, sessionResetsAt: now + 2 * 1440 * 60_000 + 14 * 60 * 60_000 }, fetchedAt: now }, true)
      expect(frame).toContain("⚠ OpenAI 92%")
      // The countdown is hour-precision within the coarse fmtCountdown window.
      expect(frame).toMatch(/resets 2d 1[34]h/)
    } finally {
      dashboard.stop()
    }
  })

  test("the weekly window warns on its own", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(120, 40)
    try {
      dashboard.phaseStarted("implement")
      setLimits(dashboard, { gpt: { sessionPct: 42, weeklyPct: 91 }, fetchedAt: now })
      const frame = await waitForRenderedFrame(renderOnce, captureCharFrame, (f) => f.includes("wk 91%"))
      expect(frame).toContain("⚠ OpenAI wk 91%")
    } finally {
      dashboard.stop()
    }
  })

  test("an auth problem surfaces instead of a silent meter", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(120, 40)
    try {
      dashboard.phaseStarted("implement")
      setLimits(dashboard, { gptHint: "codex login", fetchedAt: now })
      const frame = await waitForRenderedFrame(renderOnce, captureCharFrame, (f) => f.includes("codex login"))
      expect(frame).toContain("⚠ OpenAI — codex login")
    } finally {
      dashboard.stop()
    }
  })

  test("an OpenRouter balance below the threshold earns a chip", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(120, 40)
    try {
      dashboard.phaseStarted("implement")
      setLimits(dashboard, { openrouter: { kind: "remaining", amount: 7.4 }, fetchedAt: now })
      const frame = await waitForRenderedFrame(renderOnce, captureCharFrame, (f) => f.includes("left"))
      expect(frame).toContain("⚠ OpenRouter $7.40 left")
    } finally {
      dashboard.stop()
    }
  })
})

describe("usage modal", () => {
  test("[u] opens the meters, any key closes it", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(120, 40)
    try {
      await renderOnce()
      mockInput.pressKey("u")
      await renderOnce()
      const frame = captureCharFrame()
      expect(frame).toContain("usage")
      expect(frame).toContain("not configured")
      expect(frame).toContain("updated")

      mockInput.pressKey("escape")
      await renderOnce()
      expect(captureCharFrame()).not.toContain("esc close")
    } finally {
      dashboard.stop()
    }
  })

  test("configured meters render their detail", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(160, 40)
    const now = Date.now()
      ;(dashboard as unknown as { limits: LimitsSnapshot }).limits = {
      gpt: { sessionPct: 42, sessionResetsAt: now + 130 * 60_000, weeklyPct: 18 },
      openrouter: { kind: "remaining", amount: 12.34 },
      fetchedAt: now,
    }
    try {
      mockInput.pressKey("u")
      await renderOnce()
      const frame = captureCharFrame()
      expect(frame).toContain("42%")
      expect(frame).toContain("wk 18%")
      expect(frame).toContain("OpenRouter $12.34 left")
      expect(frame).toContain("updated")
    } finally {
      dashboard.stop()
    }
  })
})

describe("permission modal [e] explain and [i] inspect", () => {
  test("[e] without explain callback reports that no safety judge is configured", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(200, 40)
    try {
      const permission = dashboard.askPermission({ id: "p1", permission: "bash", command: "ls", patterns: [] })
      await renderOnce()

      mockInput.pressKey("e")
      await renderOnce()
      const frame = captureCharFrame()
      expect(frame).toContain("permission required")
      expect(frame).toContain("no safety judge configured to explain this")

      mockInput.pressKey("o")
      expect(await permission).toBe("once")
    } finally {
      dashboard.stop()
    }
  })

  test("[e] with explain renders thinking then the wrapped text", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(200, 40)
    try {
      let resolveExplain: (text: string) => void = () => {}
      const explain = (_signal?: AbortSignal) => new Promise<string>((resolve) => { resolveExplain = resolve })
      void dashboard.askPermission({ id: "p1", permission: "bash", command: "ls", patterns: [], explain })
      await renderOnce()

      // Press [e] → thinking state
      mockInput.pressKey("e")
      await renderOnce()
      expect(captureCharFrame()).toContain("thinking")

      // Resolve the explain promise
      resolveExplain("This command lists files. It is safe because it is read-only.")
      // Wait for promise microtask
      await new Promise((resolve) => setTimeout(resolve, 0))
      await renderOnce()

      const frame = captureCharFrame()
      expect(frame).toContain("lists files")
      expect(frame).toContain("read-only")
    } finally {
      dashboard.stop()
    }
  })

  test("[o] resolves during an explain in flight and aborts it", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(200, 40)
    try {
      const explain = (_signal?: AbortSignal) => new Promise<string>(() => {})
      const promise = dashboard.askPermission({ id: "p1", permission: "bash", command: "ls", patterns: [], explain })
      await renderOnce()

      // Press [e] → thinking
      mockInput.pressKey("e")
      await renderOnce()
      expect(captureCharFrame()).toContain("thinking")

      // Press [o] to resolve the permission
      mockInput.pressKey("o")
      const reply = await promise
      expect(reply).toBe("once")
      // The explain promise is still pending — the resolve function won't be called
      // because the queue was shifted. This is fine; the cancelled promise is gc'd.
    } finally {
      dashboard.stop()
    }
  })

  test("[i] without serverUrl reports the error inside the modal", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(200, 40)
    try {
      void dashboard.askPermission({ id: "p1", permission: "bash", command: "ls", patterns: [], sessionID: "sess-1" })
      await renderOnce()

      // serverUrl defaults to "" (empty), so [i] should report no live server
      mockInput.pressKey("i")
      await renderOnce()

      expect(captureCharFrame()).toContain("no live opencode server")
    } finally {
      dashboard.stop()
    }
  })

  test("[i] without sessionID reports the error inside the modal", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(200, 40)
    try {
      void dashboard.askPermission({ id: "p1", permission: "bash", command: "ls", patterns: [] })
      await renderOnce()

      // No sessionID on the info
      mockInput.pressKey("i")
      await renderOnce()

      expect(captureCharFrame()).toContain("no session to inspect")
    } finally {
      dashboard.stop()
    }
  })

  test("a wide footer contains [e] and [i] hints", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(200, 40)
    try {
      void dashboard.askPermission({ id: "p1", permission: "bash", command: "ls", patterns: [] })
      await renderOnce()

      const row = lineContaining(captureCharFrame(), "inspect")
      // Glued style: keys and hint are concatenated (e.g. "inspect" = "i" + "nspect")
      expect(row).toContain("inspect")
      expect(row).toContain("explain")
    } finally {
      dashboard.stop()
    }
  })
})

describe("goal invocation tree", () => {
  // The shape reconstruction produces: one group per invocation, a fanned-out
  // measurement, and a single-step improvement round.
  const goalPhases: ProgressPhase[] = [
    { name: "sync", description: "" },
    { name: "goal-improve-1-fix", description: "", groupId: "goal-improve-1", stepName: "fix" },
    { name: "goal-measure-0-score__provider-grok", description: "", groupId: "goal-measure-0", stepName: "score", plannedModel: "x-ai/grok-4-6", readOnly: true },
    { name: "goal-measure-0-score__provider-glm", description: "", groupId: "goal-measure-0", stepName: "score", plannedModel: "z-ai/glm", readOnly: true },
    { name: "goal-measure-0-score-report", description: "", groupId: "goal-measure-0", stepName: "score-report", readOnly: true },
  ]

  test("labels goal groups by stage and round and leaves by logical step names", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(120, 40, goalPhases)
    try {
      await renderOnce()
      const frame = captureCharFrame()
      expect(frame).toContain("improve #1")
      expect(frame).toContain("measure #0")
      expect(frame).toContain("score ×2")
      expect(frame).toContain("grok-4-6")
      expect(frame).toContain("score-report")
      expect(frame).toContain("fix")
      // No raw qualified physical id leaks into the tree as a label.
      expect(frame).not.toContain("goal-measure-0-score__")
      expect(frame).not.toContain("goal-improve-1-fix")
    } finally {
      dashboard.stop()
    }
  })

  test("selection targets match the rendered tree, including single-step invocation headers", () => {
    expect(pipelineSelectionTargets(goalPhases)).toEqual([
      { kind: "phase", name: "sync" },
      { kind: "group", groupId: "goal-improve-1" },
      { kind: "phase", name: "goal-improve-1-fix" },
      { kind: "group", groupId: "goal-measure-0" },
      { kind: "group", groupId: "goal-measure-0", stepName: "score" },
      { kind: "phase", name: "goal-measure-0-score__provider-grok" },
      { kind: "phase", name: "goal-measure-0-score__provider-glm" },
      { kind: "phase", name: "goal-measure-0-score-report" },
    ])
  })

  test("auto-follow rests on the invocation header for multi-step rounds", () => {
    // The single-step improvement round follows its leaf; every member of the
    // multi-step measurement round follows the invocation header itself.
    expect(autoFollowGroup(goalPhases, goalPhases[1]!)).toBeUndefined()
    expect(autoFollowGroup(goalPhases, goalPhases[2]!)).toEqual({ kind: "group", groupId: "goal-measure-0" })
    expect(autoFollowGroup(goalPhases, goalPhases[4]!)).toEqual({ kind: "group", groupId: "goal-measure-0" })
  })

  test("reconstruction chains into the dashboard: the counter denominator is the real phase total", async () => {
    // The 6/7 → 6/8 undercounting bug: the in-flight invocation's phases are
    // seeded as pending rows, so the progress counter's denominator is the real
    // phase total instead of only the phases that have already started.
    const ship = resolvePipeline({ name: "ship", spec: builtInPipelines.ship!, agents: builtInAgents })
    const goalPlan = ship.goalPlan!
    const qualified = (stage: "improve" | "measure", iteration: number) =>
      qualifyInvocation(stage, iteration, goalPlan[stage].steps).map((step) => step.name)
    const measure0 = qualified("measure", 0)
    const meta: RunMetadata = {
      schemaVersion: 4,
      runID: "run-goal",
      targetDir: "/repo",
      createdAt: 1,
      updatedAt: 1,
      control: { state: "running" },
      pipeline: ship,
      phases: Object.fromEntries(measure0.map((name) => [name, { status: "completed" as const }])),
      goal: { target: 85, maxIterations: 3, plateau: 3, iteration: 1, stage: "improve", scores: [] },
    }

    // Reconstruction produces the rows; the dashboard initializes them pending
    // until live phase events (replayHistory) mark them. The seeded improvement
    // round is a real row, so the counter's denominator is the reconstructed
    // phase total instead of only the phases that have already started.
    const phases = reconstructedPhases(meta, true)
    expect(phases.some((phase) => phase.groupId === "goal-improve-1")).toBe(true)
    // The live seed adds the in-flight improvement round, so the reconstructed
    // phase list is strictly larger than the settled view of the same run.
    expect(phases.length).toBeGreaterThan(reconstructedPhases(meta, false).length)

    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(120, 40, phases)
    try {
      await renderOnce()
      const frame = captureCharFrame()
      // The counter denominator is the real phase total — seeded in-flight rows
      // included (here 0/5, before the seed it would be 0/4) — and no qualified
      // physical id leaks into the tree as a label. The fan-out members render
      // with their model *and* variant (`grok-4.6#high`), not an anonymous id.
      expect(frame).toContain(`0/${phases.length}`)
      expect(frame).toContain("grok-4.6#high")
      expect(frame).toContain("glm-5.3#high")
      expect(frame).not.toContain("goal-measure-0-score__")
      expect(frame).not.toContain("goal-improve-1-")
    } finally {
      dashboard.stop()
    }
  })
})

describe("syncPhases", () => {
  // Frame assertions on the pipeline panel: all ordering checks compare line
  // indexes, never character indexes (left/right panels share terminal rows).
  const lineIndexOf = (frame: string, text: string) => {
    const index = frame.split("\n").findIndex((line) => line.includes(text))
    expect(index).toBeGreaterThanOrEqual(0)
    return index
  }
  // The selected pipeline row is the one carrying the ▸ marker, so a selected
  // row is identified by name + marker (the detail panel shows the name too).
  const selectedRowIndex = (frame: string, name: string) => {
    const index = frame.split("\n").findIndex((line) => line.includes(name) && line.includes("▸"))
    expect(index).toBeGreaterThanOrEqual(0)
    return index
  }

  test("appends missing rows in the given order without touching existing ones", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(140, 40, [{ name: "plan", description: "" }])
    try {
      dashboard.phaseStarted("plan")
      dashboard.phaseCompleted("plan")
      await renderOnce()
      expect(captureCharFrame()).toContain("1/1")

      dashboard.syncPhases([
        { name: "plan", description: "" },
        { name: "goal-improve-1-fixer", description: "improve" },
        { name: "goal-measure-1-scorer", description: "measure" },
      ])
      await renderOnce()
      const frame = captureCharFrame()
      // The counter counts the appended rows and the completed prefix row kept
      // its state through the growth.
      expect(frame).toContain("1/3")
      expect(frame).toContain("plan")
      expect(frame).toContain("goal-improve-1-fixer")
      expect(frame).toContain("goal-measure-1-scorer")
      // Order is the poller's: the improvement row renders before the next
      // measurement row.
      expect(frame.indexOf("goal-improve-1-fixer")).toBeLessThan(frame.indexOf("goal-measure-1-scorer"))
    } finally {
      dashboard.stop()
    }
  })

  test("re-syncing the same rows is idempotent", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(140, 40, [{ name: "plan", description: "" }])
    try {
      const rows = [{ name: "goal-improve-1-fixer", description: "improve" }]
      dashboard.syncPhases(rows)
      await renderOnce()
      expect(captureCharFrame()).toContain("0/2")

      dashboard.syncPhases(rows)
      dashboard.syncPhases([...rows])
      await renderOnce()
      expect(captureCharFrame()).toContain("0/2")
    } finally {
      dashboard.stop()
    }
  })

  test("earlier rows keep status, cost, and transcripts when a later invocation appends", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(140, 40, [{ name: "plan", description: "" }])
    try {
      dashboard.phaseStarted("plan")
      dashboard.phaseUsageTotal("plan", { cost: 0.42, tokens: { input: 12000, output: 4000, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 16000 } })
      dashboard.phaseCompleted("plan")
      dashboard.phaseMessage("plan", { channel: "response", text: "prefix transcript kept" })
      dashboard.syncPhases([{ name: "goal-improve-1-fixer", description: "improve" }])
      await renderOnce()
      const frame = captureCharFrame()
      expect(frame).toContain("1/2")
      expect(frame).toContain("$0.42")
      expect(frame).toContain("prefix transcript kept")
    } finally {
      dashboard.stop()
    }
  })

  test("the Compact run row stays terminal as goal rows arrive, keeping its state and selection", async () => {
    const compactRow = { name: compactRunRowName, description: "compacts this run's commits into one operator-authored conventional commit" }
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(140, 40, [{ name: "plan", description: "" }, compactRow])
    try {
      // Terminal state before any goal row exists — compaction already ran and
      // produced a commit — and the operator's selection pinned on the
      // lifecycle row (manual focus, so no auto-follow repaints selection).
      dashboard.phaseStarted(compactRunRowName)
      dashboard.phaseCompleted(compactRunRowName, "compacted into abc1234")
      mockInput.pressKey("j")
      await renderOnce()
      expect(captureCharFrame().split("\n").filter((line) => line.includes(compactRunRowName))).toHaveLength(2)

      // The live payload order (prefix, the lifecycle row, then goal rows)
      // grows the list additively; the merge must keep the lifecycle row last.
      const rows = [
        { name: "plan", description: "" },
        compactRow,
        { name: "goal-improve-1-fixer", description: "improve" },
        { name: "goal-measure-1-scorer", description: "measure" },
      ]
      dashboard.syncPhases(rows)
      await renderOnce()
      let frame = captureCharFrame()
      expect(lineIndexOf(frame, "goal-improve-1-fixer")).toBeLessThan(selectedRowIndex(frame, compactRunRowName))
      expect(lineIndexOf(frame, "goal-measure-1-scorer")).toBeLessThan(selectedRowIndex(frame, compactRunRowName))
      // The row moved, it was not rebuilt: its completed state survives the
      // move (pipeline row and detail header both still show ✓) and the
      // operator's selection stays on the row at its new terminal index.
      const compactLines = frame.split("\n").filter((line) => line.includes(compactRunRowName))
      expect(compactLines).toHaveLength(2)
      expect(compactLines.every((line) => line.includes("✓"))).toBe(true)

      // Re-syncing the same payload is a no-op: nothing re-appends and the
      // lifecycle row stays terminal.
      dashboard.syncPhases(rows)
      await renderOnce()
      frame = captureCharFrame()
      expect(frame.split("\n").filter((line) => line.includes("goal-improve-1-fixer"))).toHaveLength(1)
      expect(frame.split("\n").filter((line) => line.includes("goal-measure-1-scorer"))).toHaveLength(1)
      expect(lineIndexOf(frame, "goal-improve-1-fixer")).toBeLessThan(selectedRowIndex(frame, compactRunRowName))
    } finally {
      dashboard.stop()
    }
  })

  test("a pending Compact run row renders below goal invocation rows while following a live goal run", async () => {
    const compactRow = { name: compactRunRowName, description: "compacts this run's commits into one operator-authored conventional commit" }
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(140, 40, [{ name: "plan", description: "" }, compactRow])
    try {
      // Nothing has happened yet: the lifecycle row is pending, exactly what a
      // dashboard following a live goal run shows while invocation rows grow.
      dashboard.syncPhases([
        { name: "plan", description: "" },
        compactRow,
        { name: "goal-measure-0-scorer", description: "measure" },
      ])
      await renderOnce()
      const frame = captureCharFrame()
      expect(frame.split("\n").filter((line) => line.includes(compactRunRowName))).toHaveLength(1)
      expect(lineIndexOf(frame, "goal-measure-0-scorer")).toBeLessThan(lineIndexOf(frame, compactRunRowName))
    } finally {
      dashboard.stop()
    }
  })
})

describe("phase report path resolution", () => {
  test("a goal row reads its iteration-qualified report; a prefix row keeps reports/<name>.md", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "convoy-tui-reportpath-"))
    try {
      const goalRel = "reports/goal/iteration-0/measure/score-report.md"
      await mkdir(join(runDir, dirname(goalRel)), { recursive: true })
      await writeFile(join(runDir, goalRel), "# Round zero consensus\n\n- score 84")
      await mkdir(join(runDir, "reports"), { recursive: true })
      await writeFile(join(runDir, "reports", "plan.md"), "# Prefix report")

      const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(140, 40, [
        { name: "plan", description: "" },
        { name: "goal-measure-0-score-report", description: "consensus", stepName: "score-report", reportPath: goalRel },
      ])
      try {
        dashboard.start("run", process.cwd(), runDir)
        dashboard.phaseCompleted("plan")
        dashboard.phaseCompleted("goal-measure-0-score-report")

        mockInput.pressKey("2")
        await waitForRenderedFrame(renderOnce, captureCharFrame, (frame) => frame.includes("Round zero consensus"))

        // The fullscreen reader shares the same row-carried resolution.
        mockInput.pressKey("v")
        await renderOnce()
        const fullscreen = captureCharFrame()
        expect(fullscreen).toContain("report · goal-measure-0-score-report")
        expect(fullscreen).toContain("Round zero consensus")
        mockInput.pressEscape()
        await Bun.sleep(20)
        await renderOnce()

        // Select the prefix row: its report still resolves canonically.
        dashboard.phaseStarted("plan")
        await waitForRenderedFrame(renderOnce, captureCharFrame, (frame) => frame.includes("Prefix report"))
      } finally {
        dashboard.stop()
      }
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test("two completed rounds stay separately browsable in the panel", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "convoy-tui-rounds-"))
    try {
      const round0 = "reports/goal/iteration-0/measure/scorer.md"
      const round1 = "reports/goal/iteration-1/measure/scorer.md"
      await mkdir(join(runDir, "reports", "goal", "iteration-0", "measure"), { recursive: true })
      await mkdir(join(runDir, "reports", "goal", "iteration-1", "measure"), { recursive: true })
      await writeFile(join(runDir, round0), "# Round zero consensus\n\n- score 71")
      await writeFile(join(runDir, round1), "# Round one consensus\n\n- score 92")

      const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(140, 40, [
        { name: "plan", description: "" },
        { name: "goal-measure-0-scorer", description: "score", stepName: "scorer", reportPath: round0 },
        { name: "goal-measure-1-scorer", description: "score", stepName: "scorer", reportPath: round1 },
      ])
      try {
        dashboard.start("run", process.cwd(), runDir)
        dashboard.phaseCompleted("plan")
        dashboard.phaseCompleted("goal-measure-0-scorer")
        dashboard.phaseCompleted("goal-measure-1-scorer")

        // The reports tab opens on the last completed row: round one's report.
        mockInput.pressKey("2")
        await waitForRenderedFrame(renderOnce, captureCharFrame, (frame) => frame.includes("Round one consensus"))
        expect(captureCharFrame()).not.toContain("Round zero consensus")

        // Move up to the round-zero row: it resolves round zero's report, never
        // the round-one one shown a moment ago.
        mockInput.pressKey("k")
        await waitForRenderedFrame(renderOnce, captureCharFrame, (frame) => frame.includes("Round zero consensus"))
        expect(captureCharFrame()).not.toContain("Round one consensus")
      } finally {
        dashboard.stop()
      }
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })
})

describe("session tab backfill request", () => {
  test("a completed phase's empty session tab asks the attach runtime once", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(120, 40, [
      { name: "implement", description: "" },
      { name: "other", description: "" },
    ])
    try {
      const requested: string[] = []
      dashboard.setHostControls({ requestSessionBackfill: (name) => void requested.push(name) })

      dashboard.phaseRestored("implement", { status: "completed", sessionID: "ses_1" })
      dashboard.phaseRestored("other", { status: "failed", sessionID: "ses_2" })
      await renderOnce()
      expect(captureCharFrame()).toContain("no streamed messages captured for this step")
      expect(requested).toEqual(["implement"])

      // Re-renders stay one-shot per phase; moving to the other completed row
      // asks for that phase in turn.
      await renderOnce()
      await renderOnce()
      expect(requested).toEqual(["implement"])

      mockInput.pressKey("j")
      await renderOnce()
      expect(requested).toEqual(["implement", "other"])
    } finally {
      dashboard.stop()
    }
  })

  test("resetPipeline lets a reused phase name ask for a backfill again", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(120, 40, [{ name: "implement", description: "" }])
    try {
      const requested: string[] = []
      dashboard.setHostControls({ requestSessionBackfill: (name) => void requested.push(name) })

      // Iteration one: the operator views the completed step's empty session
      // tab, spending its one backfill attempt.
      dashboard.phaseRestored("implement", { status: "completed", sessionID: "ses_1" })
      await renderOnce()
      expect(captureCharFrame()).toContain("no streamed messages captured for this step")
      expect(requested).toEqual(["implement"])

      // The hosted loop resets into the next iteration, which reuses the phase
      // name; its own completed step gets a fresh attempt, like the report
      // cache does.
      dashboard.resetPipeline([{ name: "implement", description: "" }], { runID: "run-2", targetDir: process.cwd(), runDir: "", pipeline: { name: "fixer", steps: [] } })
      dashboard.phaseRestored("implement", { status: "completed", sessionID: "ses_2" })
      await renderOnce()
      expect(captureCharFrame()).toContain("no streamed messages captured for this step")
      expect(requested).toEqual(["implement", "implement"])
    } finally {
      dashboard.stop()
    }
  })

  test("a phase with streamed content never asks, and without the seam nothing is requested", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(120, 40)
    try {
      const requested: string[] = []
      dashboard.setHostControls({ requestSessionBackfill: (name) => void requested.push(name) })

      dashboard.phaseStarted("implement")
      dashboard.phaseMessage("implement", { channel: "response", text: "streamed before completing" })
      dashboard.phaseCompleted("implement")
      await renderOnce()
      expect(captureCharFrame()).toContain("streamed before completing")
      expect(requested).toEqual([])

      const unhooked = await createDashboard(120, 40)
      try {
        unhooked.dashboard.phaseRestored("implement", { status: "completed", sessionID: "ses_1" })
        await unhooked.renderOnce()
        // Historical dashboards keep the placeholder; nothing crashes.
        expect(unhooked.captureCharFrame()).toContain("no streamed messages captured for this step")
      } finally {
        unhooked.dashboard.stop()
      }
    } finally {
      dashboard.stop()
    }
  })
})

describe("transcript cap under backfill", () => {
  test("a backfilled oversized history trims from the top and keeps tailing the newest", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(120, 40)
    try {
      dashboard.phaseStarted("implement")
      // One block well past the 24k transcript cap, with distinct head/tail
      // markers — what a goal scorer's long reasoning history looks like when
      // a late attach reconstructs it in one shot.
      const filler = "x".repeat(23_000)
      dashboard.phaseMessage("implement", { channel: "reasoning", text: `HEAD-MARKER ${filler}` })
      dashboard.phaseMessage("implement", { channel: "response", text: "TAIL-MARKER final answer" })
      await renderOnce()
      const frame = captureCharFrame()
      expect(frame).toContain("TAIL-MARKER final answer")
      expect(frame).not.toContain("HEAD-MARKER")
    } finally {
      dashboard.stop()
    }
  })
})
