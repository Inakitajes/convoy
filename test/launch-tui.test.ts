import { describe, expect, test, afterAll } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { LaunchPicker, branchActionForKey, branchProposalNote, compactLaunchMaxWidth, cursorPosition, defaultDirtyStatus, dirtReading, emptyPromptField, goalLines, hookLines, launcherStepModelLabel, markPromptEdited, nextPermissionMode, nextPromptSuggestion, pipelineChoices, pipelineRow, prefillPromptField, promptAfterPipelineSwitch, promptEnterAction, reviewActionForKey, sanitizePaste, stepTree, trimPromptField, typedText, wrapPromptLines } from "../src/launch-tui"
import type { GoalPreview, LaunchRunSelection, LaunchRunTuiOptions } from "../src/launch-tui"
import { ensureRepoReady, statusPorcelain } from "../src/git"
import type { OpenSpecChangeSummary } from "../src/openspec"

import { parseArgs, resolveRunOptions } from "../src/cli"
import { runReviewLines } from "../src/review-tui"
import { buildRunPlan } from "../src/run-plan"
import { builtInAgents, builtInPipelines, hasWritableStep, resolvePipeline } from "../src/pipeline"
import { parseConvoyConfig } from "../src/config"
import { consensusStep } from "../src/quality-score"
import { displayWidth } from "../src/tui-theme"
import type { LimitsSnapshot } from "../src/limits"
import type { KeyEvent } from "@opentui/core"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

function key(partial: Partial<KeyEvent>): KeyEvent {
  return partial as KeyEvent
}

/** A complete keypress event for direct keyInput emission (mock stdin never
 * parses a lone ESC byte into an event). */
function keyEvent(name: string): KeyEvent {
  return {
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: name,
    number: false,
    raw: name,
    eventType: "keypress",
    source: "raw",
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as KeyEvent
}

function plainLines(lines: ReturnType<typeof stepTree>): string[] {
  return lines.map((line) => line.chunks.map((chunk) => chunk.text).join(""))
}

function launcherChoices(count = 1) {
  return Array.from({ length: count }, (_, index) => ({
    name: `pipeline-${index + 1}`,
    description: "A test pipeline.",
    source: "built-in" as const,
    isDefault: index === 0,
    steps: [],
    hooks: [],
    valid: true,
    advisedSteps: 0,
  }))
}

async function createLauncher(
  width: number,
  height = 30,
  choiceCount = 1,
  specs: readonly OpenSpecChangeSummary[] = [],
  autoSpecIds: readonly string[] = [],
  presetChange?: string,
  callbacks: Partial<Pick<LaunchRunTuiOptions, "readDirtyStatus" | "prepareRun">> = {},
) {
  const testRenderer = await createTestRenderer({ width, height })
  const picker = new LaunchPicker(
    testRenderer.renderer,
    process.cwd(),
    launcherChoices(choiceCount),
    "configured",
    { isolate: false, reason: "test" },
    {
      // Default the dirt reader to a clean tree: this worktree is often dirty
      // while a change is in flight, and real porcelain would shift frames.
      readDirtyStatus: async () => "",
      ...callbacks,
    } as never,
    { enabled: true, entries: [] },
    specs,
    autoSpecIds,
    presetChange,
  )
  return { ...testRenderer, picker }
}

async function closeLauncher(launcher: Awaited<ReturnType<typeof createLauncher>>) {
  launcher.mockInput.pressKey("c", { ctrl: true })
  await expect(launcher.picker.result).resolves.toBeUndefined()
}

type LaunchPickerView = {
  mode: string
  prompt: string
  optionIndex: number
  gateway: string
  modal: { kind: string; index: number } | undefined
  permissionMode: string
  toggleState: { worktree: boolean; includeDirty: boolean; [key: string]: unknown }
  promptChoosing: boolean
  specIndex: number
  selectedChangeId?: string
  prepared?: {
    selection: { includeDirty: boolean; yolo: boolean; smart: boolean }
    dirt: { files: number; matters: boolean; blocked: boolean; preview: string }
  }
  modalWidth(): number
  footerContent(width: number): { chunks: Array<{ text: string }> }
  promptDetail(width: number): { chunks: Array<{ text: string }> }
  optionsDetail(width: number): { chunks: Array<{ text: string }> }
  pipelineDetail(width: number): { chunks: Array<{ text: string }> }
  reviewDetail(width: number): { chunks: Array<{ text: string }> }
  prepareReview(pipelineName: string): Promise<void>
  refreshDirt(): Promise<void>
  runSelection(pipelineName: string, initializeGit?: boolean): LaunchRunSelection
}

function launchView(picker: LaunchPicker): LaunchPickerView {
  return picker as unknown as LaunchPickerView
}

function panelRow(frame: string, title: string) {
  const row = frame.split("\n").findIndex((line) => line.includes(title))
  expect(row, `missing ${title} panel`).toBeGreaterThanOrEqual(0)
  return row
}

describe("launch TUI compact layout", () => {
  test("switches panels at the 84-column breakpoint", async () => {
    const compact = await createLauncher(compactLaunchMaxWidth)
    const wide = await createLauncher(compactLaunchMaxWidth + 1)
    try {
      await compact.renderOnce()
      await wide.renderOnce()
      const compactFrame = compact.captureCharFrame()
      const wideFrame = wide.captureCharFrame()
      const compactPipelines = panelRow(compactFrame, "pipelines")
      const compactDetail = panelRow(compactFrame, "run setup")
      const widePipelines = panelRow(wideFrame, "pipelines")
      const wideDetail = panelRow(wideFrame, "run setup")

      expect(compactPipelines).toBeLessThan(compactDetail)
      expect(compactDetail - compactPipelines - 1).toBeGreaterThanOrEqual(5)
      expect(compactDetail - compactPipelines - 1).toBeLessThanOrEqual(9)
      expect(displayWidth(compactFrame.split("\n")[compactPipelines]!)).toBe(compactLaunchMaxWidth)
      expect(displayWidth(compactFrame.split("\n")[compactDetail]!)).toBe(compactLaunchMaxWidth)

      expect(widePipelines).toBe(wideDetail)
      expect(wideFrame.split("\n")[wideDetail]!.indexOf("run setup")).toBeGreaterThan(wideFrame.split("\n")[widePipelines]!.indexOf("pipelines"))
    } finally {
      await closeLauncher(compact)
      await closeLauncher(wide)
    }
  })

  test("stacked compact panels sit flush and keep the setup panel's bottom border", async () => {
    const launcher = await createLauncher(80, 30)
    try {
      await launcher.renderOnce()
      const rows = launcher.captureCharFrame().split("\n")
      const pipelines = panelRow(rows.join("\n"), "pipelines")
      const setup = panelRow(rows.join("\n"), "run setup")
      const footer = rows.findIndex((line) => line.includes("↑/↓ select"))

      // Flush stacking: the pipelines bottom border sits directly above the
      // setup panel — no blank separator row spent on the row layout's gap.
      expect(rows[setup - 1]).toContain("╰")
      // The setup panel closes on the body's last row, right above the footer.
      expect(rows[footer - 2]).toContain("╰")

      // Options content is taller than the panel's compact share; the box
      // must clip it inside its budget instead of auto-sizing past the body
      // and losing the bottom border under the footer.
      launcher.mockInput.pressEnter()
      await launcher.mockInput.typeText("ship it")
      launcher.mockInput.pressEnter()
      await launcher.renderOnce()
      const optionsRows = launcher.captureCharFrame().split("\n")
      const optionsFooter = optionsRows.findIndex((line) => line.includes("space toggle"))
      expect(optionsFooter).toBeGreaterThanOrEqual(0)
      expect(optionsRows[optionsFooter - 2]).toContain("╰")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("updates the layout and preserves scrolling after a resize", async () => {
    const launcher = await createLauncher(90, 24, 10)
    try {
      await launcher.renderOnce()
      expect(panelRow(launcher.captureCharFrame(), "pipelines")).toBe(panelRow(launcher.captureCharFrame(), "run setup"))

      launcher.resize(80, 24)
      launcher.mockInput.pressKey("j")
      await launcher.renderOnce()
      expect(panelRow(launcher.captureCharFrame(), "pipelines")).toBeLessThan(panelRow(launcher.captureCharFrame(), "run setup"))

      for (let index = 0; index < 7; index++) launcher.mockInput.pressKey("j")
      await launcher.renderOnce()
      const frame = launcher.captureCharFrame()
      expect(frame).toContain("pipeline-9")
      expect(frame).not.toContain("pipeline-1")

      launcher.resize(90, 24)
      launcher.mockInput.pressKey("k")
      await launcher.renderOnce()
      expect(panelRow(launcher.captureCharFrame(), "pipelines")).toBe(panelRow(launcher.captureCharFrame(), "run setup"))

      launcher.resize(80, 24)
      launcher.mockInput.pressEnter()
      await launcher.renderOnce()
      const promptField = launcher.captureCharFrame().split("\n").find((line) => line.includes("┌"))!
      expect(displayWidth(promptField)).toBe(80)
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("keeps detail content and narrow affordances within their row budgets", async () => {
    const launcher = await createLauncher(80)
    try {
      const view = launchView(launcher.picker)
      const choice = launcherChoices()[0]!

      expect(pipelineRow(choice, true, 32).chunks.map((chunk) => chunk.text).join("")).toContain("default")
      expect(pipelineRow(choice, true, 28).chunks.map((chunk) => chunk.text).join("")).not.toContain("default")

      view.mode = "prompt"
      view.prompt = "first\nsecond"
      const promptHint = view.promptDetail(40).chunks.map((chunk) => chunk.text).join("").split("\n").find((line) => line.includes("shift+enter"))!
      expect(displayWidth(promptHint)).toBeLessThanOrEqual(40)

      view.mode = "options"
      // The options list is taller than the compact panel, so the flags
      // summary only scrolls into view once the selection reaches the end.
      view.optionIndex = 6
      const flags = view.optionsDetail(40).chunks.map((chunk) => chunk.text).join("").split("\n").find((line) => line.includes("will run with"))!
      expect(displayWidth(flags)).toBeLessThanOrEqual(40)
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("keeps the selected control inside the options window when the list overflows", async () => {
    const launcher = await createLauncher(80, 24)
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"

      view.optionIndex = 1
      const top = view.optionsDetail(60).chunks.map((chunk) => chunk.text).join("")
      expect(top).toContain("▸ permissions  Auto-accept")
      expect(top).not.toContain("will run with")

      view.optionIndex = 6
      const bottom = view.optionsDetail(60).chunks.map((chunk) => chunk.text).join("")
      expect(bottom).toContain("▸ ●━━ off Isolate in a worktree")
      expect(bottom).toContain("will run with")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("degrades the stage trail and clamps modal widths on narrow renderers", async () => {
    const narrow = await createLauncher(55)
    const wide = await createLauncher(80)
    const modal = await createLauncher(100)
    try {
      await narrow.renderOnce()
      await wide.renderOnce()
      expect(narrow.captureCharFrame()).not.toContain("→")
      expect(wide.captureCharFrame()).toContain("→")

      const view = launchView(modal.picker)
      expect(view.modalWidth()).toBe(80)
      modal.resize(50, 30)
      expect(view.modalWidth()).toBe(42)
      modal.resize(40, 30)
      expect(view.modalWidth()).toBe(34)
    } finally {
      await closeLauncher(narrow)
      await closeLauncher(wide)
      await closeLauncher(modal)
    }
  })

  test("pageup and pagedown page by the compact pipeline window, not the wide list height", async () => {
    // At 80×24 the compact pipeline panel shows 4 rows (compactPipelineHeight 6
    // minus its 2-row chrome), so paging moves the selection by 4 — not the 18
    // rows the wide layout would move. Pressing the escape sequences directly
    // because the mock-keys helper has no PageUp/PageDown entry in its KeyCodes.
    const launcher = await createLauncher(80, 24, 10)
    try {
      await launcher.renderOnce()
      expect(launcher.captureCharFrame()).toContain("● pipeline-1")

      launcher.mockInput.pressKey("\x1B[6~")
      await launcher.renderOnce()
      expect(launcher.captureCharFrame()).toContain("● pipeline-5")
      expect(launcher.captureCharFrame()).not.toContain("● pipeline-1")

      launcher.mockInput.pressKey("\x1B[5~")
      await launcher.renderOnce()
      expect(launcher.captureCharFrame()).toContain("● pipeline-1")
      expect(launcher.captureCharFrame()).not.toContain("● pipeline-5")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("mouse selection tracks the pipeline panel after it moves to the top", async () => {
    // selectFromList maps event.y through pipelineText.y, which compact mode
    // relocates from the body row to the top of the screen. Clicking a row that
    // only exists at its new stacked position verifies the y-adjustment survived
    // the layout switch.
    const launcher = await createLauncher(80, 24, 3)
    try {
      await launcher.renderOnce()
      const before = launcher.captureCharFrame()
      expect(before).toContain("● pipeline-1")
      expect(before).not.toContain("● pipeline-2")

      const lines = before.split("\n")
      const targetY = lines.findIndex((line) => line.includes("pipeline-2"))
      expect(targetY, "pipeline-2 row visible in compact stack").toBeGreaterThanOrEqual(0)
      const targetX = lines[targetY]!.indexOf("pipeline-2")
      await launcher.mockMouse.click(targetX, targetY)
      await launcher.renderOnce()

      const after = launcher.captureCharFrame()
      expect(after).toContain("● pipeline-2")
      expect(after).not.toContain("● pipeline-1")
    } finally {
      await closeLauncher(launcher)
    }
  })
})

describe("launch TUI narrow-width row budgets", () => {
  // The launcher's supported minimum terminal width is 46 columns, so the sweep
  // covers the full range the feature must look right in. Every row helper must
  // keep its display width inside the panel it's rendered against — anything
  // wider is silently chopped by the panel border, the bug this feature fixes.
  const widths = [160, 120, 100, 90, 80, 70, 60, 50, 46]

  test("pipelineRow never exceeds its panel width, with or without a badge", () => {
    const defaultChoice = { ...launcherChoices()[0]!, isDefault: true }
    const customChoice = { ...launcherChoices()[0]!, source: "configured" as const }
    const bareChoice = { ...launcherChoices()[0]!, isDefault: false, source: "built-in" as const }
    for (const width of widths) {
      for (const choice of [defaultChoice, customChoice, bareChoice]) {
        for (const selected of [true, false]) {
          const row = pipelineRow(choice, selected, width)
          const rowText = row.chunks.map((chunk) => chunk.text).join("")
          expect(displayWidth(rowText), `pipelineRow width ${width}`).toBeLessThanOrEqual(width)
        }
      }
    }
  })

  test("stepTree never exceeds its panel width across the supported range", () => {
    const steps = [
      { stepName: "implement", groupId: "g1", kind: "agent" as const, modelLabel: "gpt-5.6 xhigh", advisorLabel: "" },
      { stepName: "design", groupId: "g2", kind: "agent" as const, modelLabel: "claude-opus-4-8", advisorLabel: "" },
      { stepName: "implement", groupId: "g3", kind: "agent" as const, modelLabel: "gpt-5", advisorLabel: "claude-opus-5 advisor ×3" },
      { stepName: "implement", groupId: "g3", kind: "agent" as const, modelLabel: "claude-4", advisorLabel: "" },
      { stepName: "implement", groupId: "g3", kind: "agent" as const, modelLabel: "gemini-3", advisorLabel: "" },
      { stepName: "audit-a", groupId: "g4", kind: "agent" as const, modelLabel: "gpt-5", advisorLabel: "" },
      { stepName: "audit-b", groupId: "g4", kind: "agent" as const, modelLabel: "claude-4", advisorLabel: "" },
      { stepName: "approve", groupId: "", kind: "human" as const, modelLabel: "", advisorLabel: "" },
    ] satisfies Parameters<typeof stepTree>[0]
    for (const width of widths) {
      for (const line of stepTree(steps, width)) {
        const lineText = line.chunks.map((chunk) => chunk.text).join("")
        expect(displayWidth(lineText), `stepTree width ${width} line=${JSON.stringify(lineText)}`).toBeLessThanOrEqual(width)
      }
    }
  })

  test("hookLines never exceeds its panel width across the supported range", () => {
    const hooks = [
      { stage: "pre" as const, label: "lint" },
      { stage: "post" as const, label: "notify-slack", when: "failure" as const },
      { stage: "post" as const, label: "bun run build" },
      { stage: "post" as const, label: "a-really-long-hook-name-that-should-be-truncated", when: "always" as const },
    ] satisfies Parameters<typeof hookLines>[0]
    for (const width of widths) {
      for (const line of hookLines(hooks, width)) {
        const lineText = line.chunks.map((chunk) => chunk.text).join("")
        expect(displayWidth(lineText), `hookLines width ${width} line=${JSON.stringify(lineText)}`).toBeLessThanOrEqual(width)
      }
    }
  })

  test("goalLines never exceeds its panel width across the supported range", () => {
    const goal = {
      target: 85,
      maxIterations: 3,
      plateau: 3,
      briefRecipient: "fix",
      scoreProducer: "score-report-with-a-long-name",
      measure: [
        { stepName: "score", groupId: "g1", kind: "agent" as const, modelLabel: "x-ai-grok-5", advisorLabel: "" },
        { stepName: "score", groupId: "g1", kind: "agent" as const, modelLabel: "glm-5.3-high", advisorLabel: "" },
        { stepName: "score-report", groupId: "g2", kind: "agent" as const, modelLabel: "x-ai-grok-5", advisorLabel: "" },
      ],
      improve: [
        { stepName: "fix", groupId: "g3", kind: "agent" as const, modelLabel: "deepseek-v4-flash", advisorLabel: "x-ai-grok-5 advisor ×3" },
      ],
    } satisfies GoalPreview
    for (const width of widths) {
      for (const line of goalLines(goal, width)) {
        const lineText = line.chunks.map((chunk) => chunk.text).join("")
        expect(displayWidth(lineText), `goalLines width ${width} line=${JSON.stringify(lineText)}`).toBeLessThanOrEqual(width)
      }
    }
  })
})

describe("launch TUI prompt input", () => {
  test("sanitizes pasted prompt text while preserving unlimited multi-line content", () => {
    const longLine = "x".repeat(5_000)
    const pasted = `first\r\nsecond\rthird\t${longLine}\u0000\u001b[31mred\u001b[0m`

    expect(sanitizePaste(pasted)).toBe(`first\nsecond\nthird ${longLine}[31mred[0m`)
  })

  test("sanitizePaste handles empty string", () => {
    expect(sanitizePaste("")).toBe("")
  })

  test("sanitizePaste handles string with only control characters", () => {
    expect(sanitizePaste("\x00\x01\x02\x7f")).toBe("")
  })

  test("sanitizePaste handles string without special characters", () => {
    expect(sanitizePaste("normal text")).toBe("normal text")
  })

  test("wraps long and multi-line prompts for the visible text field", () => {
    expect(wrapPromptLines("abcdef\n\nxyz", 3)).toEqual(["abc", "def", "", "xyz"])
    expect(wrapPromptLines("", 10)).toEqual([""])
    expect(wrapPromptLines("anything", 0)).toEqual([""])
  })

  test("wrapPromptLines handles single character width", () => {
    expect(wrapPromptLines("abc", 1)).toEqual(["a", "b", "c"])
  })

  test("wrapPromptLines handles text shorter than width", () => {
    expect(wrapPromptLines("hi", 10)).toEqual(["hi"])
  })

  test("wrapPromptLines handles multiple newlines", () => {
    expect(wrapPromptLines("\n\n\n", 5)).toEqual(["", "", "", ""])
  })

  test("maps cursor position across wrapped and pasted new-line content", () => {
    const text = "abcd\nefghij"

    expect(cursorPosition(text, 0, 4)).toEqual({ row: 0, col: 0 })
    expect(cursorPosition(text, 4, 4)).toEqual({ row: 0, col: 4 })
    expect(cursorPosition(text, 5, 4)).toEqual({ row: 1, col: 0 })
    expect(cursorPosition(text, text.length, 4)).toEqual({ row: 2, col: 2 })
  })

  test("cursorPosition for empty text", () => {
    expect(cursorPosition("", 0, 10)).toEqual({ row: 0, col: 0 })
  })

  test("cursorPosition at the start", () => {
    expect(cursorPosition("hello", 0, 5)).toEqual({ row: 0, col: 0 })
  })

  test("cursorPosition wraps at width boundary", () => {
    expect(cursorPosition("abcdef", 3, 3)).toEqual({ row: 0, col: 3 })
    expect(cursorPosition("abcdef", 4, 3)).toEqual({ row: 1, col: 1 })
  })

  test("cursorPosition with cursor beyond text length", () => {
    expect(cursorPosition("abc", 10, 2)).toEqual({ row: 1, col: 1 })
  })

  test("accepts normal text and plain raw paste, but ignores controls and named keys", () => {
    expect(typedText(key({ name: "a", raw: "a" }))).toBe("a")
    expect(typedText(key({ name: "space", raw: " " }))).toBe(" ")
    expect(typedText(key({ name: "", raw: "pasted text" }))).toBe("pasted text")
    expect(typedText(key({ name: "left", raw: "\u001b[D" }))).toBeUndefined()
    expect(typedText(key({ name: "v", raw: "v", ctrl: true }))).toBeUndefined()
  })

  test("typedText filters control bytes from raw paste", () => {
    expect(typedText(key({ name: "", raw: "\x00a\x01b\x7fc" }))).toBe("abc")
  })

  test("typedText returns undefined for empty raw after filtering", () => {
    expect(typedText(key({ name: "", raw: "\x00\x01\x02" }))).toBeUndefined()
  })

  test("typedText returns undefined for empty raw", () => {
    expect(typedText(key({ name: "", raw: "" }))).toBeUndefined()
  })

  test("uses Shift+Enter for prompt new-lines and Enter for continuing", () => {
    expect(promptEnterAction(key({ name: "return" }))).toBe("submit")
    expect(promptEnterAction(key({ name: "linefeed" }))).toBe("submit")
    expect(promptEnterAction(key({ name: "return", shift: true }))).toBe("newline")
    expect(promptEnterAction(key({ name: "a" }))).toBeUndefined()
  })

  test("promptEnterAction handles linefeed with shift", () => {
    expect(promptEnterAction(key({ name: "linefeed", shift: true }))).toBe("newline")
  })
})

describe("launch TUI review", () => {
  test("maps review controls to start, back, cancellation, and scrolling actions", () => {
    expect(reviewActionForKey(key({ name: "return" }))).toBe("start")
    expect(reviewActionForKey(key({ name: "s" }))).toBe("start")
    expect(reviewActionForKey(key({ name: "escape" }))).toBe("back")
    expect(reviewActionForKey(key({ name: "q" }))).toBe("cancel")
    expect(reviewActionForKey(key({ name: "p" }))).toBe("toggle-prompt")
    expect(reviewActionForKey(key({ name: "up" }))).toBe("scroll-back")
    expect(reviewActionForKey(key({ name: "pagedown" }))).toBe("page-forward")
    expect(reviewActionForKey(key({ name: "home" }))).toBe("top")
    expect(reviewActionForKey(key({ name: "end" }))).toBe("bottom")
  })

  test("review scroll controls include k and j vim keys", () => {
    expect(reviewActionForKey(key({ name: "k" }))).toBe("scroll-back")
    expect(reviewActionForKey(key({ name: "j" }))).toBe("scroll-forward")
  })

  test("review handles space as page-forward", () => {
    expect(reviewActionForKey(key({ name: "space" }))).toBe("page-forward")
  })

  test("review returns undefined for unrecognized key", () => {
    expect(reviewActionForKey(key({ name: "x" }))).toBeUndefined()
  })
})

describe("launch TUI branch step", () => {
  test("maps branch controls to editing, regeneration, and navigation", () => {
    expect(branchActionForKey(key({ name: "return" }))).toBe("submit")
    expect(branchActionForKey(key({ name: "tab" }))).toBe("next-field")
    expect(branchActionForKey(key({ name: "tab", shift: true }))).toBe("previous-field")
    expect(branchActionForKey(key({ name: "backtab" }))).toBe("previous-field")
    expect(branchActionForKey(key({ name: "r", ctrl: true }))).toBe("regenerate")
    expect(branchActionForKey(key({ name: "u", ctrl: true }))).toBe("clear")
    expect(branchActionForKey(key({ name: "backspace" }))).toBe("delete-back")
    expect(branchActionForKey(key({ name: "left" }))).toBe("cursor-left")
    expect(branchActionForKey(key({ name: "escape" }))).toBe("back")
  })

  test("branch recognizes home, end, ctrl+a, ctrl+e, ctrl+h", () => {
    expect(branchActionForKey(key({ name: "home" }))).toBe("line-start")
    expect(branchActionForKey(key({ name: "end" }))).toBe("line-end")
    expect(branchActionForKey(key({ name: "a", ctrl: true }))).toBe("line-start")
    expect(branchActionForKey(key({ name: "e", ctrl: true }))).toBe("line-end")
    expect(branchActionForKey(key({ name: "h", ctrl: true }))).toBe("delete-back")
  })

  test("leaves printable keys unbound so both fields stay typable", () => {
    for (const name of ["s", "q", "p", "r", "j", "k", "space"]) {
      expect(branchActionForKey(key({ name }))).toBeUndefined()
    }
  })

  test("branch returns undefined for unrecognized ctrl key", () => {
    expect(branchActionForKey(key({ name: "x", ctrl: true }))).toBeUndefined()
  })

  test("attributes the proposal and says when the name had to move", () => {
    expect(branchProposalNote({ branch: "feat/x", source: "declared" }, { branch: "feat/x", dir: "/w/feat-x" })).toBe(
      "taken from the document",
    )
    expect(branchProposalNote({ branch: "feat/x", source: "model", model: "anthropic/claude-haiku-4-5" }, { branch: "feat/x", dir: "/w/feat-x" })).toBe(
      "proposed by anthropic/claude-haiku-4-5",
    )
    expect(branchProposalNote({ branch: "feat/x", source: "prompt" }, { branch: "feat/x-2", dir: "/w/feat-x-2", suffixed: true })).toBe(
      "derived from your prompt (the naming model didn't answer) · renamed, the original was taken",
    )
    expect(branchProposalNote({ branch: "convoy-20260726-a4f2", source: "fallback" }, { branch: "convoy-20260726-a4f2", dir: "/w/c" })).toBe(
      "generic name (nothing to derive it from)",
    )
  })

  test("branchProposalNote uses fallback when model is missing for source=model", () => {
    expect(branchProposalNote({ branch: "feat/x", source: "model" }, { branch: "feat/x", dir: "/w/feat-x" })).toBe(
      "proposed by the naming model",
    )
  })
})

describe("launch TUI pipeline preview", () => {
  test("shows the resolved model for single-model pipeline steps", () => {
    const lines = plainLines(
      stepTree(
        [
          { stepName: "implementer", groupId: "g1", kind: "agent", modelLabel: "gpt-5.5 xhigh" },
          { stepName: "design", groupId: "g2", kind: "agent", modelLabel: "claude-opus-4-8" },
        ] satisfies Parameters<typeof stepTree>[0],
        80,
      ),
    )

    expect(lines).toEqual(["○ implementer  · gpt-5.5 xhigh", "○ design  · claude-opus-4-8"])
  })

  test("labels Claude Code aliases and its CLI default", () => {
    expect(launcherStepModelLabel({ runner: "claude-code", model: "opus" })).toBe("claude-code/opus")
    expect(launcherStepModelLabel({ runner: "claude-code", model: "" })).toBe("claude-code/default")
    expect(launcherStepModelLabel({ model: "openai/gpt-5.6", variant: "xhigh" })).toBe("gpt-5.6 xhigh")
  })

  test("launcherStepModelLabel truncates provider prefix from OpenCode models", () => {
    expect(launcherStepModelLabel({ model: "anthropic/claude-sonnet-4" })).toBe("claude-sonnet-4")
    expect(launcherStepModelLabel({ model: "openai/gpt-5.6" })).toBe("gpt-5.6")
  })

  test("launcherStepModelLabel handles model with variant", () => {
    expect(launcherStepModelLabel({ model: "openai/gpt-5.6", variant: "xhigh" })).toBe("gpt-5.6 xhigh")
  })

  test("shows executor to advisor relationships and call caps", () => {
    const lines = plainLines(stepTree([
      { stepName: "implementer", groupId: "g1", kind: "agent", modelLabel: "glm-5.2", advisorLabel: "claude-opus-5 advisor ×3" },
    ], 100))
    expect(lines).toEqual(["○ implementer  · glm-5.2 → claude-opus-5 advisor ×3"])
  })

  test("stepTree handles human gates", () => {
    const lines = plainLines(stepTree([
      { stepName: "approve", groupId: "", kind: "human", modelLabel: "", advisorLabel: "" },
    ], 100))
    expect(lines.some((line) => line.includes("manual gate"))).toBe(true)
    expect(lines.some((line) => line.includes("approve"))).toBe(true)
  })

  test("stepTree handles model fan-out (one agent, many models)", () => {
    const lines = plainLines(stepTree([
      { stepName: "implementer", groupId: "g1", kind: "agent", modelLabel: "gpt-5", advisorLabel: "" },
      { stepName: "implementer", groupId: "g1", kind: "agent", modelLabel: "claude-4", advisorLabel: "" },
      { stepName: "implementer", groupId: "g1", kind: "agent", modelLabel: "gemini-3", advisorLabel: "" },
    ], 80))
    expect(lines.some((line) => line.includes("3 models"))).toBe(true)
  })

  test("stepTree handles parallel agents (same groupId, different stepName)", () => {
    const lines = plainLines(stepTree([
      { stepName: "audit-a", groupId: "g1", kind: "agent", modelLabel: "gpt-5", advisorLabel: "" },
      { stepName: "audit-b", groupId: "g1", kind: "agent", modelLabel: "claude-4", advisorLabel: "" },
      { stepName: "audit-c", groupId: "g1", kind: "agent", modelLabel: "gemini-3", advisorLabel: "" },
    ], 80))
    expect(lines.some((line) => line.includes("parallel") || line.includes("agents"))).toBe(true)
  })

  test("shows an explicit placeholder when a pipeline has no hooks", () => {
    expect(plainLines(hookLines([], 80))).toEqual(["hooks  · none"])
  })

  test("lists pre and post hooks with non-default post-hook conditions", () => {
    const lines = plainLines(
      hookLines(
        [
          { stage: "pre", label: "lint" },
          { stage: "post", label: "notify-slack", when: "failure" },
          { stage: "post", label: "bun run build" },
        ] satisfies Parameters<typeof hookLines>[0],
        80,
      ),
    )

    expect(lines).toEqual(["hooks", "○ pre   · lint", "○ post  · notify-slack  · on failure", "○ post  · bun run build"])
  })

  test("hookLines handles always condition", () => {
    const lines = plainLines(hookLines([
      { stage: "post", label: "cleanup", when: "always" },
    ], 80))
    expect(lines.some((line) => line.includes("always"))).toBe(true)
  })

  test("hookLines handles hook label with multiple spaces", () => {
    const lines = plainLines(hookLines([
      { stage: "pre", label: "run   linter" },
    ], 80))
    // The hookNodes function replaces consecutive whitespace with single space
    expect(lines.some((line) => line.includes("run   linter") || line.includes("run linter"))).toBe(true)
  })

  test("hookLines handles narrow width", () => {
    const lines = plainLines(hookLines([
      { stage: "pre", label: "very-long-hook-name-that-should-be-truncated" },
    ], 15))
    expect(lines.length).toBeGreaterThan(0)
  })

  const scoredGoal = {
    target: 85,
    maxIterations: 3,
    plateau: 3,
    briefRecipient: "fix",
    scoreProducer: "score-report",
    measure: [
      { stepName: "score", groupId: "g1", kind: "agent", modelLabel: "x-ai-grok-5", advisorLabel: "" },
      { stepName: "score", groupId: "g1", kind: "agent", modelLabel: "glm-5.3-high", advisorLabel: "" },
      { stepName: "score-report", groupId: "g2", kind: "agent", modelLabel: "x-ai-grok-5", advisorLabel: "" },
    ],
    improve: [
      { stepName: "fix", groupId: "g3", kind: "agent", modelLabel: "deepseek-v4-flash", advisorLabel: "x-ai-grok-5 advisor ×3" },
    ],
  } satisfies GoalPreview

  test("goalLines previews the policy and both fragments with their models", () => {
    const lines = plainLines(goalLines(scoredGoal, 100))

    // A distinct section, then the three policy facts as separate chips —
    // target, improve-round cap (not a derived measurement count), plateau.
    expect(lines[0]).toBe("goal")
    expect(lines[1]).toContain("85/100")
    expect(lines[1]).toContain("↺ ≤3 rounds")
    expect(lines[1]).toContain("plateau 3")
    expect(lines[1]).not.toContain("target 85/100")
    expect(lines.join("\n")).not.toContain("4 measurements")
    // Measurement zero runs first; improve names the loop-back.
    expect(lines).toContain("  measure  · score ← score-report")
    expect(lines).toContain("  improve  · brief → fix  · then re-measure")
    // Fragment steps render as subsections: one indent deeper than their
    // fragment header, including the fan-out and the fixer's advisor
    // relationship, with their resolved models.
    expect(lines).toContain("    ○ score  · 2 models")
    expect(lines).toContain("    ○ score-report  · x-ai-grok-5")
    expect(lines).toContain("    ○ fix  · deepseek-v4-flash → x-ai-grok-5 advisor ×3")
  })

  test("goalLines collapses policy chips and fragment roles when the panel is narrow", () => {
    const lines = plainLines(goalLines(scoredGoal, 24))
    const joined = lines.join("\n")
    expect(joined).toContain("85/100")
    expect(joined).toContain("↺3")
    expect(joined).toContain("p3")
    expect(joined).toContain("measure")
    expect(joined).toContain("improve")
    expect(lines.some((line) => line.includes("then re-measure"))).toBe(false)
    expect(lines.every((line) => displayWidth(line) <= 24)).toBe(true)
  })
})

describe("launch TUI pipeline choices", () => {
  test("carries defaultPrompt and suggestedPrompts through from the resolved pipeline", () => {
    const choices = pipelineChoices(undefined, builtInAgents)
    const review = choices.find((choice) => choice.name === "review")
    expect(review?.defaultPrompt).toBe(
      "Review the current branch against its base and report prioritized findings with a verified quality score.",
    )
    expect(review?.suggestedPrompts).toEqual(["Review the open PR for this branch", "Review only the last commit's diff"])
    expect(review?.attachesPrdHistory).toBe(true)
  })

  test("leaves defaultPrompt and suggestedPrompts unset for pipelines without them", () => {
    const choices = pipelineChoices(undefined, builtInAgents)
    const implement = choices.find((choice) => choice.name === "implement")
    expect(implement?.defaultPrompt).toBeUndefined()
    expect(implement?.suggestedPrompts).toBeUndefined()
    expect(implement?.attachesPrdHistory).toBe(false)
  })

  test("carries the goal cycle for scored pipelines so the preview can show it", () => {
    const choices = pipelineChoices(undefined, builtInAgents)
    const ship = choices.find((choice) => choice.name === "ship")
    expect(ship?.goal).toMatchObject({ target: 85, maxIterations: 3, plateau: 3, briefRecipient: "fix", scoreProducer: "score-report" })
    expect(ship?.goal?.improve.map((step) => step.stepName)).toEqual(["fix"])
    expect(ship?.goal?.measure.map((step) => step.stepName)).toEqual(["score", "score", "score-report"])
  })

  test("carries no goal preview for pipelines without a terminal goal step", () => {
    const choices = pipelineChoices(undefined, builtInAgents)
    expect(choices.find((choice) => choice.name === "implement")?.goal).toBeUndefined()
    expect(choices.find((choice) => choice.name === "review")?.goal).toBeUndefined()
  })

  test("configured pipelines carry their defaultPrompt and suggestedPrompts", () => {
    const config = parseConvoyConfig(
      [
        "pipelines:",
        "  triage:",
        "    description: Triage incoming reports",
        "    defaultPrompt: Triage the incoming reports.",
        "    suggestedPrompts:",
        "      - Triage today's reports",
        "    steps:",
        "      - implementer",
      ].join("\n"),
      ".convoy/config.yaml",
      "/tmp/non-existent-convoy-target",
    )
    const choices = pipelineChoices(config, builtInAgents)
    const triage = choices.find((choice) => choice.name === "triage")
    expect(triage?.source).toBe("configured")
    expect(triage?.defaultPrompt).toBe("Triage the incoming reports.")
    expect(triage?.suggestedPrompts).toEqual(["Triage today's reports"])
  })
})

describe("launch TUI historical PRD notice", () => {
  const historyEntry = {
    runID: "20260817-103045-x7q2",
    pipeline: "implement",
    branch: "feat/history",
    timestamp: Date.UTC(2026, 7, 17),
    file: "20260817-103045-x7q2.prd.md",
  }

  function reviewChoice() {
    return {
      name: "review",
      description: "Review the branch.",
      source: "built-in" as const,
      isDefault: true,
      steps: [],
      hooks: [],
      valid: true,
      advisedSteps: 0,
      attachesPrdHistory: true,
    }
  }

  async function createHistoryLauncher(isolate: boolean) {
    const testRenderer = await createTestRenderer({ width: 100, height: 40 })
    const picker = new LaunchPicker(
      testRenderer.renderer,
      process.cwd(),
      [reviewChoice()],
      "configured",
      { isolate, reason: "test" },
      {} as never,
      { enabled: true, branch: "feat/history", entries: [historyEntry] },
    )
    return { ...testRenderer, picker }
  }

  function panelText(content: { chunks: Array<{ text: string }> }) {
    return content.chunks.map((chunk) => chunk.text).join("")
  }

  test("shows that this checkout's historical PRD will be attached when running in place", async () => {
    const launcher = await createHistoryLauncher(false)
    try {
      const view = launchView(launcher.picker)
      const detail = panelText(view.pipelineDetail(80))
      const options = panelText(view.optionsDetail(80))
      expect(detail).toContain("will attach implement PRD · 2026-08-17")
      expect(detail).toContain("original intent for feat/history")
      expect(options).toContain("will attach implement PRD · 2026-08-17")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("warns that a new worktree will not see this checkout's historical PRD", async () => {
    const launcher = await createHistoryLauncher(true)
    try {
      const view = launchView(launcher.picker)
      expect(panelText(view.pipelineDetail(80))).toContain("a new worktree will not see it")
      expect(panelText(view.optionsDetail(80))).toContain("this checkout has implement PRD · 2026-08-17")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("updates the options notice when isolate is toggled", async () => {
    const launcher = await createHistoryLauncher(false)
    try {
      const view = launchView(launcher.picker)
      expect(panelText(view.optionsDetail(80))).toContain("will attach implement PRD")
      view.toggleState.worktree = true
      expect(panelText(view.optionsDetail(80))).toContain("a new worktree will not see it")
    } finally {
      await closeLauncher(launcher)
    }
  })
})

describe("launch TUI prompt prefill and clean/dirty tracking", () => {
  test("openPrompt prefills an empty field with the pipeline's defaultPrompt", () => {
    const prefilled = prefillPromptField(emptyPromptField(), "Review the branch.")
    expect(prefilled).toMatchObject({ prompt: "Review the branch.", fromDefault: true, lastDefault: "Review the branch." })
  })

  test("openPrompt keeps an already-typed prompt instead of overwriting it", () => {
    const typed = { ...emptyPromptField(), prompt: "my prompt", fromDefault: false }
    expect(prefillPromptField(typed, "Review the branch.")).toBe(typed)
  })

  test("openPrompt leaves a clean empty field alone when the pipeline has no default", () => {
    expect(prefillPromptField(emptyPromptField(), undefined)).toEqual(emptyPromptField())
  })

  test("openPrompt preserves a whitespace-only user edit instead of prefilling over it", () => {
    const blank = { ...emptyPromptField(), prompt: "   " }
    expect(prefillPromptField(blank, "Review the branch.")).toBe(blank)
  })

  test("moveSelection swaps a clean default for the new pipeline's default", () => {
    const clean = { ...emptyPromptField(), prompt: "old default", fromDefault: true, lastDefault: "old default" }
    const swapped = promptAfterPipelineSwitch(clean, "new default")
    expect(swapped).toMatchObject({ prompt: "new default", fromDefault: true, lastDefault: "new default" })
  })

  test("moveSelection clears a clean default when the new pipeline has none", () => {
    const clean = { ...emptyPromptField(), prompt: "old default", fromDefault: true, lastDefault: "old default" }
    const swapped = promptAfterPipelineSwitch(clean, undefined)
    expect(swapped).toMatchObject({ prompt: "", fromDefault: false })
  })

  test("moveSelection preserves user-typed text across pipeline switches", () => {
    const dirty = { ...emptyPromptField(), prompt: "my typed prompt", fromDefault: false }
    const swapped = promptAfterPipelineSwitch(dirty, "new default")
    expect(swapped.prompt).toBe("my typed prompt")
    expect(swapped.fromDefault).toBe(false)
  })

  test("moveSelection preserves a whitespace-only user edit across pipeline switches", () => {
    const dirty = { ...emptyPromptField(), prompt: "   ", fromDefault: false }
    expect(promptAfterPipelineSwitch(dirty, "new default")).toBe(dirty)
  })

  test("moveSelection treats a default that was edited afterwards as user text", () => {
    // fromDefault is still true but the text no longer matches the applied
    // default: the field was edited after prefill, so the text must survive.
    const edited = { prompt: "default plus my note", fromDefault: true, lastDefault: "default", suggestionIndex: 0, hasCycledSuggestions: false }
    const swapped = promptAfterPipelineSwitch(edited, "new default")
    expect(swapped).toMatchObject({ prompt: "default plus my note", fromDefault: false, lastDefault: undefined })
  })

  test("typing marks the field dirty so it is no longer swapped or cycleable", () => {
    const clean = { prompt: "default", fromDefault: true, lastDefault: "default", suggestionIndex: 0, hasCycledSuggestions: true }
    const dirty = markPromptEdited(clean)
    expect(dirty).toMatchObject({ prompt: "default", fromDefault: false, lastDefault: undefined, suggestionIndex: 0, hasCycledSuggestions: false })
  })

  test("submitting a padded default keeps its clean provenance after trimming", () => {
    const clean = { prompt: "  default  ", fromDefault: true, lastDefault: "  default  ", suggestionIndex: 0, hasCycledSuggestions: false }
    const trimmed = trimPromptField(clean)
    expect(trimmed).toMatchObject({ prompt: "default", fromDefault: true, lastDefault: "default" })
    expect(promptAfterPipelineSwitch(trimmed, "new default").prompt).toBe("new default")
  })
})

describe("launch TUI Tab suggestions", () => {
  const suggestions = ["suggestion one", "suggestion two"]

  test("Tab inserts the first suggestion when the prompt is clean", () => {
    const clean = emptyPromptField()
    const next = nextPromptSuggestion(clean, suggestions)
    expect(next?.prompt).toBe("suggestion one")
    expect(next).toMatchObject({ fromDefault: true, lastDefault: "suggestion one", suggestionIndex: 0, hasCycledSuggestions: true })
  })

  test("Tab cycles through suggestions on repeated press", () => {
    let state = emptyPromptField()
    state = nextPromptSuggestion(state, suggestions)!
    expect(state.prompt).toBe("suggestion one")
    state = nextPromptSuggestion(state, suggestions)!
    expect(state.prompt).toBe("suggestion two")
    state = nextPromptSuggestion(state, suggestions)!
    expect(state.prompt).toBe("suggestion one")
  })

  test("Tab does nothing when the pipeline has no suggestions", () => {
    expect(nextPromptSuggestion(emptyPromptField(), undefined)).toBeUndefined()
    expect(nextPromptSuggestion(emptyPromptField(), [])).toBeUndefined()
  })

  test("Tab does nothing when the prompt is dirty (user-typed)", () => {
    const dirty = { ...emptyPromptField(), prompt: "typed", fromDefault: false }
    expect(nextPromptSuggestion(dirty, suggestions)).toBeUndefined()
  })

  test("Tab does not overwrite a whitespace-only user edit", () => {
    const dirty = { ...emptyPromptField(), prompt: "   ", fromDefault: false }
    expect(nextPromptSuggestion(dirty, suggestions)).toBeUndefined()
  })

  test("Tab replaces a held default with the first suggestion", () => {
    const holdingDefault = { prompt: "the default", fromDefault: true, lastDefault: "the default", suggestionIndex: 0, hasCycledSuggestions: false }
    const next = nextPromptSuggestion(holdingDefault, suggestions)!
    expect(next.prompt).toBe("suggestion one")
    expect(next).toMatchObject({ suggestionIndex: 0, hasCycledSuggestions: true })
  })

  test("an inserted suggestion stays swappable on the next pipeline switch", () => {
    const inserted = nextPromptSuggestion(emptyPromptField(), suggestions)!
    expect(inserted.fromDefault).toBe(true)
    const swapped = promptAfterPipelineSwitch(inserted, "new default")
    expect(swapped.prompt).toBe("new default")
  })
})

describe("launch TUI gateway selector", () => {
  function optionsLines(view: LaunchPickerView, width = 80) {
    return view.optionsDetail(width).chunks.map((chunk) => chunk.text).join("").split("\n")
  }

  test("leads the options list with its own row, description, and breathing room", async () => {
    const launcher = await createLauncher(100)
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      view.optionIndex = 0
      const lines = optionsLines(view)
      const instruction = lines.findIndex((line) => line.includes("Choose a gateway"))
      const gatewayRow = lines.findIndex((line) => line.includes("gateway  As configured ▾"))
      expect(instruction).toBeGreaterThanOrEqual(0)
      expect(gatewayRow).toBeGreaterThan(instruction)
      expect(lines[gatewayRow]).toContain("▸ gateway")
      expect(lines[gatewayRow]).toContain("--gateway")
      // The selector is separated from the instruction above and the toggles
      // below, instead of being glued to either.
      expect(lines[instruction + 1]).toBe("")
      expect(lines[gatewayRow + 1]).toContain("Route every model through one provider")
      expect(lines[gatewayRow + 2]).toBe("")
      expect(lines[gatewayRow + 3]).toContain("permissions  Auto-accept")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("an unselected gateway row keeps its value and flag but loses the marker", async () => {
    const launcher = await createLauncher(100)
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      view.optionIndex = 1
      const lines = optionsLines(view)
      const gatewayRow = lines.findIndex((line) => line.includes("gateway  As configured ▾"))
      expect(gatewayRow).toBeGreaterThanOrEqual(0)
      expect(lines[gatewayRow]).not.toContain("▸ gateway")
      expect(lines[gatewayRow]).toContain("--gateway")
      // The row after the gateway is the permission selector; moving down one
      // row selects it without turning it into a switch row.
      expect(lines.find((line) => line.includes("permissions"))).toContain("▸ permissions")
      expect(lines.find((line) => line.includes("permissions"))).not.toContain("━━●")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("g opens the dropdown listing every gateway with hints and the current one marked", async () => {
    const launcher = await createLauncher(100)
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      await launcher.renderOnce()
      launcher.mockInput.pressKey("g")
      await launcher.renderOnce()
      expect(view.modal?.kind).toBe("gateway")
      const frame = launcher.captureCharFrame()
      expect(frame).toContain("model gateway")
      expect(frame).toContain("▸ ◆ As configured")
      expect(frame).toContain("◇ Direct")
      expect(frame).toContain("◇ OpenRouter")
      expect(frame).toContain("◇ OpenRouter Nitro")
      expect(frame).toContain("◇ Vercel AI Gateway")
      expect(frame).toContain("preserve pipeline model IDs literally")
      expect(frame).toContain("↑/↓ select · enter apply · esc cancel")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("enter applies the highlighted gateway to the run setup row", async () => {
    const launcher = await createLauncher(100)
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      await launcher.renderOnce()
      launcher.mockInput.pressKey("g")
      launcher.mockInput.pressArrow("down")
      launcher.mockInput.pressArrow("down")
      await launcher.renderOnce()
      expect(launcher.captureCharFrame()).toContain("▸ ◇ OpenRouter")
      launcher.mockInput.pressEnter()
      await launcher.renderOnce()
      expect(view.modal).toBeUndefined()
      expect(view.gateway).toBe("openrouter")
      expect(launcher.captureCharFrame()).toContain("gateway  OpenRouter ▾")
      expect(launcher.captureCharFrame()).not.toContain("model gateway")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("escape cancels the dropdown without touching the gateway", async () => {
    const launcher = await createLauncher(100)
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      await launcher.renderOnce()
      launcher.mockInput.pressKey("g")
      launcher.mockInput.pressArrow("down")
      // A lone ESC byte never becomes a keypress event in the mock stdin, so
      // emit the event the way runs-tui tests do.
      launcher.renderer.keyInput.emit("keypress", keyEvent("escape"))
      await launcher.renderOnce()
      expect(view.modal).toBeUndefined()
      expect(view.gateway).toBe("configured")
      expect(launcher.captureCharFrame()).not.toContain("model gateway")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("left/right cycle the gateway from its own row only", async () => {
    const launcher = await createLauncher(100)
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      view.optionIndex = 1
      await launcher.renderOnce()
      launcher.mockInput.pressArrow("right")
      await launcher.renderOnce()
      // Arrows on a toggle row adjust nothing gateway-related.
      expect(view.gateway).toBe("configured")

      view.optionIndex = 0
      await launcher.renderOnce()
      launcher.mockInput.pressArrow("right")
      await launcher.renderOnce()
      expect(view.gateway).toBe("direct")
      launcher.mockInput.pressArrow("left")
      await launcher.renderOnce()
      expect(view.gateway).toBe("configured")
      // Clamped at the ends rather than wrapping.
      launcher.mockInput.pressArrow("left")
      await launcher.renderOnce()
      expect(view.gateway).toBe("configured")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("space on the gateway row opens the dropdown instead of toggling", async () => {
    const launcher = await createLauncher(100)
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      view.optionIndex = 0
      await launcher.renderOnce()
      launcher.mockInput.pressKey(" ")
      await launcher.renderOnce()
      expect(view.modal?.kind).toBe("gateway")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("clicking the gateway row opens the dropdown", async () => {
    const launcher = await createLauncher(100)
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      // Assigning mode directly doesn't request a render; a clamped "k" moves
      // nothing but repaints, so the options panel lands in the frame.
      launcher.mockInput.pressKey("k")
      await launcher.renderOnce()
      const lines = launcher.captureCharFrame().split("\n")
      const gatewayRow = lines.findIndex((line) => line.includes("gateway  As configured ▾"))
      expect(gatewayRow, "gateway row visible in options panel").toBeGreaterThanOrEqual(0)
      await launcher.mockMouse.click(lines[gatewayRow]!.indexOf("gateway"), gatewayRow)
      await launcher.renderOnce()
      expect(view.modal?.kind).toBe("gateway")
    } finally {
      await closeLauncher(launcher)
    }
  })
})

describe("launch TUI permission selector", () => {
  function optionsLines(view: LaunchPickerView, width = 80) {
    return view.optionsDetail(width).chunks.map((chunk) => chunk.text).join("").split("\n")
  }

  function permissionsRow(lines: string[]) {
    const row = lines.find((line) => line.includes("permissions  "))
    expect(row, "permission selector row visible").toBeDefined()
    return row!
  }

  test("nextPermissionMode walks the fixed cycle and wraps", () => {
    expect(nextPermissionMode("interactive")).toBe("yolo")
    expect(nextPermissionMode("yolo")).toBe("smart")
    expect(nextPermissionMode("smart")).toBe("interactive")
    // Three activations always return to the starting state.
    expect(nextPermissionMode(nextPermissionMode(nextPermissionMode("yolo")))).toBe("yolo")
  })

  test("a fresh launcher starts on Auto-accept and shows its flag", async () => {
    const launcher = await createLauncher(100)
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      view.optionIndex = 1
      await launcher.renderOnce()
      expect(view.permissionMode).toBe("yolo")
      const row = permissionsRow(optionsLines(view))
      expect(row).toContain("Auto-accept")
      expect(row).toContain("--yolo")
      expect(view.runSelection("review")).toMatchObject({ yolo: true, smart: false })
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("activation cycles all three states and wraps back, by keyboard and mouse", async () => {
    const launcher = await createLauncher(100)
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      view.optionIndex = 1
      await launcher.renderOnce()

      launcher.mockInput.pressKey(" ")
      await launcher.renderOnce()
      expect(view.permissionMode).toBe("smart")
      expect(permissionsRow(optionsLines(view))).toContain("Smart auto-accept")

      launcher.mockInput.pressKey(" ")
      await launcher.renderOnce()
      expect(view.permissionMode).toBe("interactive")
      const interactiveRow = permissionsRow(optionsLines(view))
      expect(interactiveRow).toContain("Interactive")
      expect(interactiveRow).toContain("no auto-accept flag")
      expect(interactiveRow).not.toContain("--yolo")
      expect(interactiveRow).not.toContain("--smart")

      launcher.mockInput.pressKey(" ")
      await launcher.renderOnce()
      expect(view.permissionMode).toBe("yolo")

      // Mouse activation advances the same cycle.
      await launcher.renderOnce()
      const lines = launcher.captureCharFrame().split("\n")
      const row = lines.findIndex((line) => line.includes("permissions  "))
      expect(row, "permission selector row visible in frame").toBeGreaterThanOrEqual(0)
      await launcher.mockMouse.click(lines[row]!.indexOf("permissions"), row)
      await launcher.renderOnce()
      expect(view.permissionMode).toBe("smart")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("each mode maps to the run's permission flags, never both", async () => {
    const launcher = await createLauncher(100)
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      const flagsLine = () =>
        optionsLines(view).find((line) => line.includes("will run with")) ?? ""

      view.permissionMode = "yolo"
      expect(view.runSelection("review")).toMatchObject({ yolo: true, smart: false })
      expect(flagsLine()).toContain("--yolo")
      expect(flagsLine()).not.toContain("--smart")

      view.permissionMode = "smart"
      expect(view.runSelection("review")).toMatchObject({ yolo: false, smart: true })
      expect(flagsLine()).toContain("--smart")
      expect(flagsLine()).not.toContain("--yolo")

      view.permissionMode = "interactive"
      expect(view.runSelection("review")).toMatchObject({ yolo: false, smart: false })
      expect(flagsLine()).not.toContain("--yolo")
      expect(flagsLine()).not.toContain("--smart")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("the two old permission toggles no longer exist", async () => {
    const launcher = await createLauncher(100)
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      const text = optionsLines(view).join("\n")
      // The old yolo toggle's label is gone, and the permission control is a
      // value row rather than an on/off switch.
      expect(text).not.toContain("Auto-accept permissions")
      expect(permissionsRow(optionsLines(view))).not.toContain("━━●")
      expect("smart" in view.toggleState).toBe(false)
      expect("yolo" in view.toggleState).toBe(false)
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("other toggles keep their rows, labels, and couplings", async () => {
    const launcher = await createLauncher(100)
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      view.optionIndex = 2
      const text = optionsLines(view).join("\n")
      expect(text).toContain("Human gates")
      expect(text).toContain("Include dirty tree")
      expect(text).toContain("Keep run directory")
      expect(text).toContain("Progress dashboard")
      expect(text).toContain("Isolate in a worktree")
      // The include-dirty/worktree coupling survives the row shift.
      view.toggleState.worktree = true
      expect(view.toggleState.includeDirty).toBe(false)
      expect(view.runSelection("review").yolo).toBe(true)
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("activating a boolean toggle row flips it and leaves the permission mode alone", async () => {
    const launcher = await createLauncher(100)
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      // Human gates is the first toggle row (index 2): activating it must flip
      // that boolean, not cycle the permission selector, proving the toggle
      // rows still resolve through the shifted `toggles[index - 2]` dispatch.
      view.optionIndex = 2
      await launcher.renderOnce()
      const before = view.toggleState.humanReview
      launcher.mockInput.pressKey(" ")
      await launcher.renderOnce()
      expect(view.toggleState.humanReview).toBe(!before)
      expect(view.permissionMode).toBe("yolo")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("activating the worktree toggle through the row path enforces the include-dirty coupling", async () => {
    const launcher = await createLauncher(100)
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      // Worktree is the last toggle row (index 6): the row activation must
      // resolve to the worktree toggle and enforce the coupling through the
      // real dispatch path, not through direct state assignment.
      view.optionIndex = 6
      await launcher.renderOnce()
      launcher.mockInput.pressKey(" ")
      await launcher.renderOnce()
      expect(view.toggleState.worktree).toBe(true)
      expect(view.toggleState.includeDirty).toBe(false)
      expect(view.permissionMode).toBe("yolo")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("the footer names the selected row's activation: cycle on permissions, toggle elsewhere", async () => {
    const launcher = await createLauncher(100)
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      const footer = () => view.footerContent(100).chunks.map((chunk) => chunk.text).join("")

      view.optionIndex = 1
      expect(footer()).toContain("cycle")
      view.optionIndex = 2
      expect(footer()).toContain("toggle")
      expect(footer()).not.toContain("cycle")
    } finally {
      await closeLauncher(launcher)
    }
  })
})

describe("launch TUI default launch resolution", () => {
  // The default launcher state (no operator interaction) must resolve through
  // the production option/plan path to a `--yolo` run: the selector's default
  // is Auto-accept, and the review must show it before the run starts.
  test("an untouched selection resolves plan permissions 'yolo' and shows --yolo", async () => {
    const launcher = await createLauncher(100)
    try {
      const view = launchView(launcher.picker)
      expect(view.permissionMode).toBe("yolo")
      const selection = view.runSelection("review")
      expect(selection).toMatchObject({ yolo: true, smart: false })

      // Mirror prepareInteractiveRun's mapping of the launcher selection onto
      // parsed args, then resolve through the production path.
      const parsed = parseArgs([])
      parsed.targetDir = selection.targetDir
      parsed.baseDetectionDir = process.cwd()
      parsed.prompt = selection.prompt
      parsed.pipeline = selection.pipeline
      parsed.humanReview = selection.humanReview
      parsed.tui = selection.tui
      parsed.includeDirty = selection.includeDirty
      parsed.keepRunDir = selection.keepRunDir
      parsed.yolo = selection.yolo
      parsed.smart = selection.smart
      parsed.gateway = selection.gateway
      parsed.worktree = Boolean(selection.isolateWorktree)
      const options = await resolveRunOptions(parsed)
      expect(options).toMatchObject({ yolo: true, smart: false })
      const plan = buildRunPlan({ ...options, prompt: selection.prompt })
      expect(plan.permissions).toBe("yolo")

      // The review renders the resolved permission state with its flag form,
      // and the options step's flag line names --yolo without --smart.
      const reviewLines = runReviewLines(plan, 120).map((line) => line.chunks.map((chunk) => chunk.text).join(""))
      expect(reviewLines.some((line) => line.includes("yolo permissions (--yolo)"))).toBe(true)
      expect(reviewLines.some((line) => line.includes("--smart"))).toBe(false)
      view.mode = "options"
      const flags = view.optionsDetail(120).chunks.map((chunk) => chunk.text).join("")
      expect(flags).toContain("will run with")
      expect(flags).toContain("--yolo")
      expect(flags).not.toContain("--smart")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("the review shows the selector's Smart auto-accept as --smart, never --yolo", async () => {
    const launcher = await createLauncher(100)
    try {
      const view = launchView(launcher.picker)
      view.permissionMode = "smart"
      const selection = view.runSelection("review")
      expect(selection).toMatchObject({ yolo: false, smart: true })
      const parsed = parseArgs([])
      parsed.targetDir = selection.targetDir
      parsed.baseDetectionDir = process.cwd()
      parsed.pipeline = selection.pipeline
      parsed.humanReview = selection.humanReview
      parsed.tui = selection.tui
      parsed.includeDirty = selection.includeDirty
      parsed.keepRunDir = selection.keepRunDir
      parsed.yolo = selection.yolo
      parsed.smart = selection.smart
      parsed.gateway = selection.gateway
      parsed.worktree = Boolean(selection.isolateWorktree)
      const options = await resolveRunOptions(parsed)
      const plan = buildRunPlan({ ...options, prompt: selection.prompt })
      expect(plan.permissions).toBe("smart")
      const reviewLines = runReviewLines(plan, 120).map((line) => line.chunks.map((chunk) => chunk.text).join(""))
      expect(reviewLines.some((line) => line.includes("smart permissions (--smart)"))).toBe(true)
      expect(reviewLines.some((line) => line.includes("--yolo"))).toBe(false)
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("an explicitly Interactive selection resolves neither auto-accept flag", async () => {
    const launcher = await createLauncher(100)
    try {
      const view = launchView(launcher.picker)
      view.permissionMode = "interactive"
      const selection = view.runSelection("review")
      expect(selection).toMatchObject({ yolo: false, smart: false })
      const parsed = parseArgs([])
      parsed.targetDir = selection.targetDir
      parsed.baseDetectionDir = process.cwd()
      parsed.pipeline = selection.pipeline
      parsed.humanReview = selection.humanReview
      parsed.tui = selection.tui
      parsed.includeDirty = selection.includeDirty
      parsed.keepRunDir = selection.keepRunDir
      parsed.yolo = selection.yolo
      parsed.smart = selection.smart
      parsed.gateway = selection.gateway
      parsed.worktree = Boolean(selection.isolateWorktree)
      const options = await resolveRunOptions(parsed)
      const plan = buildRunPlan({ ...options, prompt: selection.prompt })
      expect(plan.permissions).toBe("interactive")
      // Interactive names no auto-accept flag in the review at all.
      const reviewLines = runReviewLines(plan, 120).map((line) => line.chunks.map((chunk) => chunk.text).join(""))
      expect(reviewLines.some((line) => line.includes("interactive permissions"))).toBe(true)
      expect(reviewLines.some((line) => line.includes("--yolo") || line.includes("--smart"))).toBe(false)
    } finally {
      await closeLauncher(launcher)
    }
  })
})

describe("launch TUI goal classification", () => {
  // The launcher classifies pipelines directly by the presence of a valid
  // terminal goal step — the only way a pipeline enters goal execution. There
  // is no goal-mode toggle and no scored+writable eligibility heuristic.
  test("only pipelines with a terminal goal step are classified as goal pipelines", () => {
    const hasGoal = (name: string) => {
      const pipeline = resolvePipeline({ name, spec: builtInPipelines[name]!, agents: builtInAgents })
      return Boolean(pipeline.goalPlan)
    }

    expect(hasGoal("ship")).toBe(true)
    expect(hasGoal("review")).toBe(false)
    expect(hasGoal("review-lite")).toBe(false)
    expect(hasGoal("implement")).toBe(false)
  })

  // Spec: goal-subflows — a pipeline without a goal step previews as an
  // ordinary pipeline: prefix steps only, no goal-cycle section.
  test("the pipeline detail preview shows no goal section for ordinary pipelines", async () => {
    const testRenderer = await createTestRenderer({ width: 100, height: 40 })
    const picker = new LaunchPicker(
      testRenderer.renderer,
      process.cwd(),
      [{
        name: "implement",
        description: "Implement the change.",
        source: "built-in" as const,
        isDefault: true,
        steps: [{ stepName: "implementer", groupId: "g1", kind: "agent", modelLabel: "gpt-5.6", advisorLabel: "" }],
        hooks: [],
        valid: true,
        advisedSteps: 0,
      }],
      "configured",
      { isolate: false, reason: "test" },
      { readDirtyStatus: async () => "" } as never,
      { enabled: true, entries: [] },
    )
    const launcher = { ...testRenderer, picker }
    try {
      const detail = launchView(picker).pipelineDetail(80).chunks.map((chunk) => chunk.text).join("")
      expect(detail).toContain("○ implementer  · gpt-5.6")
      expect(detail).not.toContain("goal")
      expect(detail).not.toContain("↺")
      expect(detail).not.toContain("measure  ·")
      expect(detail).not.toContain("improve  ·")
    } finally {
      await closeLauncher(launcher)
    }
  })

  // The pipeline preview continues where the prefix steps end: a scored
  // pipeline's remaining shape is the goal loop, shown in the list itself
  // rather than first appearing at Review.
  test("the pipeline detail preview shows the goal cycle's fragments", async () => {
    const testRenderer = await createTestRenderer({ width: 100, height: 40 })
    const picker = new LaunchPicker(
      testRenderer.renderer,
      process.cwd(),
      [{
        name: "ship",
        description: "Sync the branch with its base and iterate until it clears the bar.",
        source: "built-in" as const,
        isDefault: true,
        steps: [{ stepName: "sync", groupId: "g1", kind: "agent", modelLabel: "glm-5.3-high", advisorLabel: "" }],
        hooks: [],
        valid: true,
        advisedSteps: 0,
        goal: {
          target: 85,
          maxIterations: 3,
          plateau: 3,
          briefRecipient: "fix",
          scoreProducer: "score-report",
          measure: [
            { stepName: "score", groupId: "g1", kind: "agent", modelLabel: "x-ai-grok-5", advisorLabel: "" },
            { stepName: "score", groupId: "g1", kind: "agent", modelLabel: "glm-5.3-high", advisorLabel: "" },
            { stepName: "score-report", groupId: "g2", kind: "agent", modelLabel: "x-ai-grok-5", advisorLabel: "" },
          ],
          improve: [{ stepName: "fix", groupId: "g3", kind: "agent", modelLabel: "deepseek-v4-flash", advisorLabel: "" }],
        },
      }],
      "configured",
      { isolate: false, reason: "test" },
      { readDirtyStatus: async () => "" } as never,
      { enabled: true, entries: [] },
    )
    const launcher = { ...testRenderer, picker }
    try {
      const detail = launchView(picker).pipelineDetail(80).chunks.map((chunk) => chunk.text).join("")
      expect(detail).toContain("goal")
      expect(detail).toContain("85/100")
      expect(detail).toContain("↺ ≤3 rounds")
      expect(detail).toContain("plateau 3")
      expect(detail).not.toContain("4 measurements")
      expect(detail).toContain("measure  · score ← score-report")
      expect(detail).toContain("improve  · brief → fix  · then re-measure")
      expect(detail).toContain("○ fix  · deepseek-v4-flash")
    } finally {
      await closeLauncher(launcher)
    }
  })
})

describe("launch TUI sidebar usage meters", () => {
  type Launcher = Awaited<ReturnType<typeof createLauncher>>
  const injectLimits = (picker: Launcher["picker"], limits: LimitsSnapshot) => {
    ;(picker as unknown as { limits: LimitsSnapshot }).limits = limits
  }

  // The launcher repaints on its 250ms ticker, and the background limits poll
  // (stubbed empty in test/env.ts) can race with its own empty snapshot, so
  // re-apply the field and wait a tick before judging each frame.
  async function renderWithLimits(launcher: Launcher, limits: LimitsSnapshot, predicate: (frame: string) => boolean) {
    for (let attempt = 0; attempt < 60; attempt++) {
      injectLimits(launcher.picker, limits)
      await Bun.sleep(280)
      const frame = launcher.captureCharFrame()
      if (predicate(frame)) return frame
    }
    throw new Error(`timed out waiting for usage render:\n${launcher.captureCharFrame()}`)
  }

  test("a tall wide screen pins the meters under the pipeline list", async () => {
    const launcher = await createLauncher(120, 30)
    try {
      const frame = await renderWithLimits(
        launcher,
        { gpt: { sessionPct: 42, sessionResetsAt: Date.now() + 130 * 60_000, weeklyPct: 18 }, openrouter: { kind: "remaining", amount: 12.34 }, fetchedAt: Date.now() },
        (f) => f.includes("OpenRouter $12.34 left"),
      )
      const pipelines = frame.indexOf(" pipelines ")
      const usage = frame.indexOf(" usage ", pipelines)
      expect(usage).toBeGreaterThanOrEqual(pipelines)
      // OpenRouter is the wallet row, so it sits above the OpenAI bar.
      expect(frame.indexOf("OpenRouter ")).toBeLessThan(frame.indexOf("OpenAI "))
      expect(frame).toContain("OpenAI")
      expect(frame).toContain("42%")
      // The panel is pegged to the footer: its top border, two meter rows, and
      // bottom border, then the footer's top border immediately after.
      const lines = frame.split("\n")
      const usageLine = lines.findIndex((line) => line.includes(" usage "))
      // The footer's top border is the first rounded corner after the panel.
      const footerLine = lines.findIndex((line, index) => index > usageLine && line.trimStart().startsWith("╭"))
      // usage top, two meter rows, bottom border, then the footer immediately.
      expect(footerLine - usageLine).toBe(4)
    } finally {
      closeLauncher(launcher)
    }
  })

  test("a low balance warns the amber the way the dashboard does", async () => {
    const launcher = await createLauncher(120, 30)
    try {
      const frame = await renderWithLimits(
        launcher,
        { openrouter: { kind: "remaining", amount: 7.4 }, fetchedAt: Date.now() },
        (f) => f.includes("OpenRouter $7.40 left"),
      )
      expect(frame).toContain("OpenRouter $7.40 left")
    } finally {
      closeLauncher(launcher)
    }
  })

  test("compact panels keep the meters off the sidebar to save vertical space", async () => {
    const launcher = await createLauncher(compactLaunchMaxWidth, 30)
    try {
      await launcher.renderOnce()
      expect(launcher.captureCharFrame()).not.toContain(" usage ")
    } finally {
      closeLauncher(launcher)
    }
  })
})

describe("launch TUI OpenSpec contract picker", () => {
  const specs: OpenSpecChangeSummary[] = [
    { id: "add-login", title: "Add Login" },
    { id: "add-logout", title: "Add Logout" },
  ]

  test("opens the contract list instead of the editor when specs are present", async () => {
    const launcher = await createLauncher(100, 30, 1, specs)
    try {
      launcher.mockInput.pressEnter()
      await launcher.renderOnce()
      const view = launchView(launcher.picker)
      expect(view.mode).toBe("prompt")
      expect(view.promptChoosing).toBe(true)
      const frame = launcher.captureCharFrame()
      expect(frame).toContain("Manual prompt")
      expect(frame).toContain("add-login — Add Login")
      expect(frame).toContain("add-logout — Add Logout")
      expect(frame).not.toContain("Add onboarding, fix bug")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("enter on a spec pins change and injects the canned prompt without opening the editor", async () => {
    const launcher = await createLauncher(100, 30, 1, specs)
    try {
      launcher.mockInput.pressEnter()
      launcher.mockInput.pressKey("j")
      launcher.mockInput.pressEnter()
      await launcher.renderOnce()
      const view = launchView(launcher.picker)
      expect(view.mode).toBe("options")
      expect(view.selectedChangeId).toBe("add-login")
      expect(view.prompt).toBe("Implement the attached OpenSpec change.")
      const selection = view.runSelection("pipeline-1")
      expect(selection.change).toBe("add-login")
      expect(selection.prompt).toBe("Implement the attached OpenSpec change.")
      const frame = launcher.captureCharFrame()
      expect(frame).toContain("openspec")
      expect(frame).toContain("add-login")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("enter on Manual prompt opens the editor and does not pin a change", async () => {
    const launcher = await createLauncher(100, 30, 1, specs)
    try {
      launcher.mockInput.pressEnter()
      launcher.mockInput.pressEnter()
      await launcher.renderOnce()
      const view = launchView(launcher.picker)
      expect(view.mode).toBe("prompt")
      expect(view.promptChoosing).toBe(false)
      expect(view.selectedChangeId).toBeUndefined()
      expect(launcher.captureCharFrame()).toContain("Add onboarding, fix bug")
    } finally {
      await closeLauncher(launcher)
    }
  })
})

describe("launch TUI OpenSpec notice", () => {
  const specs: OpenSpecChangeSummary[] = [
    { id: "add-login", title: "Add Login" },
    { id: "add-logout", title: "Add Logout" },
  ]

  test("picker shows the auto-resolved change that will attach without a pick", async () => {
    const launcher = await createLauncher(100, 40, 1, specs, ["add-login"])
    try {
      await launcher.renderOnce()
      const frame = launcher.captureCharFrame()
      expect(frame).toContain("add-login · bundle attaches to every step")
      expect(frame).toContain("Add Login")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("options shows the auto-resolved change when nothing was picked", async () => {
    const launcher = await createLauncher(100, 40, 1, specs, ["add-login"])
    try {
      launcher.mockInput.pressEnter() // open the contract list
      launcher.mockInput.pressEnter() // Manual prompt -> editor
      for (const ch of "ship it") launcher.mockInput.pressKey(ch)
      launcher.mockInput.pressEnter() // submit -> options
      await launcher.renderOnce()
      const view = launchView(launcher.picker)
      expect(view.mode).toBe("options")
      const frame = launcher.captureCharFrame()
      expect(frame).toContain("add-login · bundle attaches to every step")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("no auto-selection says so and points at the picker", async () => {
    const launcher = await createLauncher(110, 40, 1, specs, [])
    try {
      await launcher.renderOnce()
      const frame = launcher.captureCharFrame()
      expect(frame).toContain("2 active changes · pick one when writing the prompt")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("a manual pick owns the notice instead of the auto-resolved id", async () => {
    const launcher = await createLauncher(100, 40, 1, specs, ["add-login"])
    try {
      launcher.mockInput.pressEnter() // contract list
      launcher.mockInput.pressKey("j") // index 1 (add-login)
      launcher.mockInput.pressKey("j") // index 2 (add-logout)
      launcher.mockInput.pressEnter() // pin add-logout -> options
      await launcher.renderOnce()
      const view = launchView(launcher.picker)
      expect(view.mode).toBe("options")
      expect(view.selectedChangeId).toBe("add-logout")
      const frame = launcher.captureCharFrame()
      expect(frame).toContain("add-logout · Add Logout")
      expect(frame).not.toContain("bundle attaches to every step")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("stays quiet with no active changes at all", async () => {
    const launcher = await createLauncher(100, 40, 1, [], [])
    try {
      await launcher.renderOnce()
      const frame = launcher.captureCharFrame()
      expect(frame).not.toContain("bundle attaches to every step")
      expect(frame).not.toContain("active changes · pick one")
    } finally {
      await closeLauncher(launcher)
    }
  })
})


describe("launch TUI preset change (specs viewer handoff)", () => {
  const specs: OpenSpecChangeSummary[] = [
    { id: "add-login", title: "Add Login" },
    { id: "add-logout", title: "Add Logout" },
  ]

  test("pins the preset change before the first render and skips auto-detect notice", async () => {
    const launcher = await createLauncher(180, 40, 1, specs, ["add-login"], "add-login")
    try {
      await launcher.renderOnce()
      const view = launchView(launcher.picker)
      expect(view.selectedChangeId).toBe("add-login")
      // The silent auto-detect notice stays quiet when a contract is pinned.
      expect(launcher.captureCharFrame()).not.toContain("bundle attaches to every step")
      // The flags preview already names the pinned contract.
      const flags = view.optionsDetail(180).chunks.map((chunk) => chunk.text).join("")
      expect(flags).toContain("--change add-login")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("the prompt step opens with the preset row highlighted and enter confirms it", async () => {
    const launcher = await createLauncher(100, 30, 1, specs, [], "add-logout")
    try {
      launcher.mockInput.pressEnter() // pipelines -> prompt (contract list)
      await launcher.renderOnce()
      const view = launchView(launcher.picker)
      expect(view.promptChoosing).toBe(true)
      // specIndex 1..n maps to specs[index - 1]; add-logout is the second row.
      expect(view.specIndex).toBe(2)

      launcher.mockInput.pressEnter() // pin add-logout -> options
      await launcher.renderOnce()
      const accepted = launchView(launcher.picker)
      expect(accepted.mode).toBe("options")
      expect(accepted.selectedChangeId).toBe("add-logout")
      expect(accepted.runSelection("pipeline-1").change).toBe("add-logout")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("an unknown preset id is ignored and normal auto-detection still applies", async () => {
    const launcher = await createLauncher(100, 40, 1, specs, ["add-login"], "not-a-change")
    try {
      await launcher.renderOnce()
      const view = launchView(launcher.picker)
      expect(view.selectedChangeId).toBeUndefined()
      expect(launcher.captureCharFrame()).toContain("add-login · bundle attaches to every step")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("zero-argument launch behavior is unchanged (no pin)", async () => {
    const launcher = await createLauncher(130, 40, 1, specs, [])
    try {
      await launcher.renderOnce()
      const view = launchView(launcher.picker)
      expect(view.selectedChangeId).toBeUndefined()
      expect(launcher.captureCharFrame()).toContain("2 active changes · pick one when writing the prompt")
    } finally {
      await closeLauncher(launcher)
    }
  })
})

/** Seven dirty porcelain entries, as `git status --porcelain` reports them. */
const dirtySeven = [" M src/a.ts", " M src/b.ts", "?? src/c.ts", " M src/d.ts", " M src/e.ts", " M src/f.ts", " M src/g.ts"].join("\n")

function optionsText(view: LaunchPickerView, width = 80) {
  return view.optionsDetail(width).chunks.map((chunk) => chunk.text).join("")
}

/** A minimal frozen plan for the injected prepareRun, as runReviewLines renders it. */
function fakePlan() {
  return buildRunPlan({
    prompt: "do the thing",
    targetDir: process.cwd(),
    baseRef: "main",
    worktree: false,
    dirty: false,
    pipeline: { name: "pipeline-1", steps: [] } as never,
    hooks: { pre: [], post: [], pipelines: {} },
    files: [],
    permissions: "yolo",
  } as never)
}

/** Polls for an asynchronous picker transition (prepare/refresh are fire-and-forget in the handlers). */
async function until(predicate: () => boolean, what: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe("dirtReading predicate matrix", () => {
  const cases = [
    [undefined, "plain"],
    [{ worktreeDir: "/wt/feat-add-foo" }, "preset feature"],
  ] as const
  const porcelains: Array<[string, string]> = [
    ["clean", ""],
    ["dirty", dirtySeven],
  ]

  for (const [preset, presetLabel] of cases) {
    for (const worktree of [false, true]) {
      for (const [porcelainName, porcelain] of porcelains) {
        for (const includeDirty of [false, true]) {
          test(`${presetLabel} · worktree ${worktree ? "on" : "off"} · ${porcelainName} · includeDirty ${includeDirty}`, () => {
            const dirt = dirtReading(porcelain, { presetFeature: preset, worktree, includeDirty })
            expect(dirt.files).toBe(porcelain === "" ? 0 : 7)
            expect(dirt.matters).toBe(preset ? true : !worktree)
            expect(dirt.blocked).toBe(dirt.matters && dirt.files > 0 && !includeDirty)
          })
        }
      }
    }
  }
})

describe("dirtReading parity with the execution-time gate", () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function makeRepo(dirty: boolean): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "convoy-dirt-parity-"))
    dirs.push(dir)
    const git = async (...args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" })
      if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
    }
    await git("init", "-q")
    await git("config", "user.email", "o@e.com")
    await git("config", "user.name", "O")
    await Bun.write(join(dir, "README.md"), "# repo\n")
    await git("add", ".")
    await git("commit", "-q", "-m", "init")
    if (dirty) await Bun.write(join(dir, "dirty.txt"), "uncommitted\n")
    return dir
  }

  // The predicate must refuse exactly what ensureRepoReady(executionDir,
  // { allowDirty: options.worktree }) would refuse, so the launcher's warning
  // and the post-review gate can never disagree about what counts (task 4.2).
  for (const dirty of [false, true]) {
    for (const worktree of [false, true]) {
      for (const includeDirty of [false, true]) {
        test(`gate parity: ${dirty ? "dirty" : "clean"} · worktree ${worktree ? "on" : "off"} · includeDirty ${includeDirty}`, async () => {
          const dir = await makeRepo(dirty)
          const porcelain = await statusPorcelain(dir)
          const gate = await ensureRepoReady(dir, { allowDirty: worktree, includeDirty }).then(
            () => false,
            () => true,
          )
          expect(dirtReading(porcelain, { worktree, includeDirty }).blocked).toBe(gate)

          // A continue handoff always executes with isolation off, so the gate
          // sees allowDirty=false even with the worktree toggle on — the
          // predicate mirrors that through `matters`.
          const gatePreset = await ensureRepoReady(dir, { allowDirty: false, includeDirty }).then(
            () => false,
            () => true,
          )
          expect(dirtReading(porcelain, { presetFeature: { worktreeDir: dir }, worktree: true, includeDirty }).blocked).toBe(gatePreset)
        })
      }
    }
  }

  test("the default reader surfaces the gate's own porcelain and resolves clean when git can't answer", async () => {
    const dir = await makeRepo(true)
    expect(await defaultDirtyStatus(dir)).toContain("dirty.txt")
    expect(await defaultDirtyStatus(join(tmpdir(), "convoy-no-such-dir"))).toBe("")
  })
})

describe("launch TUI dirty-tree preflight (options step)", () => {
  test("a dirty plain run shows the notice and the counted toggle label", async () => {
    const launcher = await createLauncher(100, 40, 1, [], [], undefined, { readDirtyStatus: async () => dirtySeven })
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      await view.refreshDirt()
      await launcher.renderOnce()
      const text = optionsText(view)
      expect(text).toContain("7 files uncommitted")
      expect(text).toContain("Include dirty tree")
      expect(text).toContain("(7 uncommitted)")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("a clean tree stays quiet and the toggle keeps its standard label", async () => {
    const launcher = await createLauncher(100, 40, 1, [], [], undefined, { readDirtyStatus: async () => "" })
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      await view.refreshDirt()
      await launcher.renderOnce()
      const text = optionsText(view)
      expect(text).not.toContain("uncommitted")
      expect(text).toContain("Include dirty tree")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("worktree isolation makes source dirt irrelevant", async () => {
    const launcher = await createLauncher(100, 40, 1, [], [], undefined, { readDirtyStatus: async () => dirtySeven })
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      view.toggleState.worktree = true
      await view.refreshDirt()
      await launcher.renderOnce()
      const text = optionsText(view)
      expect(text).not.toContain("uncommitted")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("the notice and count disappear once the toggle covers the dirt", async () => {
    const launcher = await createLauncher(100, 40, 1, [], [], undefined, { readDirtyStatus: async () => dirtySeven })
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      await view.refreshDirt()
      expect(optionsText(view)).toContain("7 files uncommitted")
      view.toggleState.includeDirty = true
      const text = optionsText(view)
      expect(text).not.toContain("uncommitted")
      expect(text).toContain("Include dirty tree")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("the options step and the review each read the tree fresh, never reusing the earlier status", async () => {
    const reads = ["", dirtySeven]
    const dirs: string[] = []
    let calls = 0
    const launcher = await createLauncher(100, 40, 1, [], [], undefined, {
      readDirtyStatus: async (dir) => {
        calls += 1
        dirs.push(dir)
        return reads[calls - 1] ?? ""
      },
      prepareRun: async () => ({ options: {} as never, plan: fakePlan() }),
    })
    try {
      await launcher.renderOnce()
      launcher.mockInput.pressEnter() // pipelines -> prompt editor (no specs)
      for (const ch of "ship it") launcher.mockInput.pressKey(ch)
      launcher.mockInput.pressEnter() // submit -> options
      const view = launchView(launcher.picker)
      await until(() => view.mode === "options", "options step")
      await until(() => calls === 1, "the options-step dirt read")
      expect(dirs[0]).toBe(process.cwd())
      expect(view.prepared).toBeUndefined()

      await view.prepareReview("pipeline-1")
      await until(() => view.mode === "review", "review step")
      await until(() => calls === 2, "the review-time dirt read")
      expect(view.prepared?.dirt).toMatchObject({ files: 7, matters: true, blocked: true })
      await launcher.renderOnce()
      expect(launcher.captureCharFrame()).toContain("uncommitted")
    } finally {
      await closeLauncher(launcher)
    }
  })
})

describe("launch TUI dirty-tree review warning and accept-time choice", () => {
  function reviewLauncher(reader: () => Promise<string>) {
    return createLauncher(100, 40, 1, [], [], undefined, {
      readDirtyStatus: reader,
      prepareRun: async () => ({ options: {} as never, plan: fakePlan() }),
    })
  }

  test("a dirty tree with the toggle off shows the warning; with it on or clean, none", async () => {
    const launcher = await reviewLauncher(async () => dirtySeven)
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      await view.prepareReview("pipeline-1")
      await until(() => view.mode === "review", "review step")
      expect(view.reviewDetail(80).chunks.map((chunk) => chunk.text).join("")).toContain("would refuse")

      view.toggleState.includeDirty = true
      await view.prepareReview("pipeline-1")
      await until(() => view.mode === "review" && view.prepared?.dirt.blocked === false, "re-prepared review")
      expect(view.reviewDetail(80).chunks.map((chunk) => chunk.text).join("")).not.toContain("would refuse")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("a clean tree shows no warning", async () => {
    const launcher = await reviewLauncher(async () => "")
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      await view.prepareReview("pipeline-1")
      await until(() => view.mode === "review", "review step")
      expect(view.reviewDetail(80).chunks.map((chunk) => chunk.text).join("")).not.toContain("would refuse")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("accepting with unhandled dirt offers the choice; include re-prepares and the second accept starts the run", async () => {
    const launcher = await reviewLauncher(async () => dirtySeven)
    // No closeLauncher: the second accept finishes the picker and resolves its
    // result below, so closeLauncher's "resolves undefined" would fail.
    const view = launchView(launcher.picker)
    view.mode = "options"
    await view.prepareReview("pipeline-1")
    await until(() => view.mode === "review", "review step")

    launcher.renderer.keyInput.emit("keypress", keyEvent("return"))
    await launcher.renderOnce()
    expect(view.modal?.kind).toBe("dirty")
    const frame = launcher.captureCharFrame()
    expect(frame).toContain("uncommitted changes")
    expect(frame).toContain("i include · o options · esc stay")
    expect(frame).toContain("M src/a.ts")

    launcher.mockInput.pressKey("i")
    await until(() => view.mode === "review" && view.modal === undefined && view.prepared?.selection.includeDirty === true, "the include re-prepare")
    expect(view.prepared?.dirt.blocked).toBe(false)
    await launcher.renderOnce()
    expect(launcher.captureCharFrame()).not.toContain("would refuse")

    launcher.renderer.keyInput.emit("keypress", keyEvent("return"))
    await expect(launcher.picker.result).resolves.toMatchObject({ action: "run", selection: { includeDirty: true } })
  })

  test("choosing options returns with prompt, toggles, and selection intact", async () => {
    const launcher = await reviewLauncher(async () => dirtySeven)
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      view.prompt = "my prompt"
      view.optionIndex = 2
      await view.prepareReview("pipeline-1")
      await until(() => view.mode === "review", "review step")

      launcher.renderer.keyInput.emit("keypress", keyEvent("return"))
      await until(() => view.modal?.kind === "dirty", "the dirty choice")
      launcher.mockInput.pressKey("o")
      await launcher.renderOnce()
      expect(view.mode).toBe("options")
      expect(view.prompt).toBe("my prompt")
      expect(view.optionIndex).toBe(2)
      expect(view.toggleState.includeDirty).toBe(false)
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("dismissing keeps the session in review, and a repeated accept re-offers the choice", async () => {
    const launcher = await reviewLauncher(async () => dirtySeven)
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"
      await view.prepareReview("pipeline-1")
      await until(() => view.mode === "review", "review step")

      launcher.renderer.keyInput.emit("keypress", keyEvent("return"))
      await until(() => view.modal?.kind === "dirty", "the dirty choice")
      launcher.renderer.keyInput.emit("keypress", keyEvent("escape"))
      await launcher.renderOnce()
      expect(view.modal).toBeUndefined()
      expect(view.mode).toBe("review")

      launcher.renderer.keyInput.emit("keypress", keyEvent("return"))
      await until(() => view.modal?.kind === "dirty", "the re-offered choice")
    } finally {
      await closeLauncher(launcher)
    }
  })
})
