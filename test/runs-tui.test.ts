import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { RunsBrowser } from "../src/runs-browser"
import { shortVersion } from "../src/version"

import type { RunEntry } from "../src/runs"

function keyEvent(name: string, options: { ctrl?: boolean; shift?: boolean; raw?: string } = {}) {
  return {
    name,
    ctrl: options.ctrl ?? false,
    meta: false,
    shift: options.shift ?? false,
    option: false,
    sequence: name,
    number: false,
    raw: options.raw ?? name,
    eventType: "keypress" as const,
    source: "raw" as const,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as any
}

function sampleRuns(): RunEntry[] {
  return [
    {
      runID: "20250809-100000",
      dir: "/tmp/runs/20250809-100000",
      targetDir: "/repo/first",
      title: "feat: add login",
      pipeline: "convoy",
      status: "completed",
      statusKind: "completed",
      live: false,
      phases: [
        { name: "design", status: "completed", durationMs: 8_000, cost: 0.02 },
        { name: "implement", status: "completed", durationMs: 45_000, cost: 0.15 },
      ],
      cost: 0.17,
    },
    {
      runID: "20250809-110000",
      dir: "/tmp/runs/20250809-110000",
      targetDir: "/repo/second",
      title: "fix: resolve timeout",
      pipeline: "convoy",
      status: "failed",
      statusKind: "failed",
      live: false,
      phases: [{ name: "implement", status: "failed", durationMs: 20_000, cost: 0.08 }],
      cost: 0.08,
    },
    {
      runID: "20250809-120000",
      dir: "/tmp/runs/20250809-120000",
      targetDir: "/repo/live",
      title: "feat: onboarding wizard",
      pipeline: "convoy",
      status: "running",
      statusKind: "incomplete",
      live: true,
      serverUrl: "http://127.0.0.1:34567",
      phases: [{ name: "design", status: "completed" }],
      cost: 0.03,
    },
  ]
}

async function browser(initialIndex = 0) {
  const { renderer } = await createTestRenderer({ width: 120, height: 40 })
  const runs = sampleRuns()
  const instance = new RunsBrowser(renderer, runs, initialIndex)
  return { renderer, runs, result: instance.result }
}

test("keyboard navigation opens the selected run", async () => {
  const { renderer, runs, result } = await browser()

  renderer.keyInput.emit("keypress", keyEvent("j"))
  renderer.keyInput.emit("keypress", keyEvent("return", { raw: "\r" }))

  await expect(result).resolves.toEqual({
    type: "open",
    runID: runs[1]!.runID,
    targetDir: runs[1]!.targetDir,
  })
})

test("o opens the current run", async () => {
  const { renderer, runs, result } = await browser(0)

  renderer.keyInput.emit("keypress", keyEvent("o"))

  await expect(result).resolves.toEqual({
    type: "open",
    runID: runs[0]!.runID,
    targetDir: runs[0]!.targetDir,
  })
})

test("r opens a retry confirmation and y confirms a retry", async () => {
  const { renderer, runs, result } = await browser(2)

  renderer.keyInput.emit("keypress", keyEvent("r"))
  // Arrow keys are ignored while the confirmation modal is up.
  renderer.keyInput.emit("keypress", keyEvent("j"))
  renderer.keyInput.emit("keypress", keyEvent("y"))

  await expect(result).resolves.toEqual({
    type: "retry",
    runID: runs[2]!.runID,
    targetDir: runs[2]!.targetDir,
  })
})

test("return confirms the retry modal", async () => {
  const { renderer, runs, result } = await browser(0)

  renderer.keyInput.emit("keypress", keyEvent("r"))
  renderer.keyInput.emit("keypress", keyEvent("return", { raw: "\r" }))

  await expect(result).resolves.toEqual({
    type: "retry",
    runID: runs[0]!.runID,
    targetDir: runs[0]!.targetDir,
  })
})

test("n cancels the retry confirmation and returns to the list", async () => {
  const { renderer, result } = await browser(1)

  renderer.keyInput.emit("keypress", keyEvent("r"))
  renderer.keyInput.emit("keypress", keyEvent("n"))
  renderer.keyInput.emit("keypress", keyEvent("q"))

  await expect(result).resolves.toEqual({ type: "exit" })
})

test("escape cancels the retry confirmation", async () => {
  const { renderer, result } = await browser(1)

  renderer.keyInput.emit("keypress", keyEvent("r"))
  renderer.keyInput.emit("keypress", keyEvent("escape"))
  renderer.keyInput.emit("keypress", keyEvent("q"))

  await expect(result).resolves.toEqual({ type: "exit" })
})

test("R (shift+r) resumes the current run", async () => {
  const { renderer, runs, result } = await browser(2)

  renderer.keyInput.emit("keypress", keyEvent("r", { shift: true }))

  await expect(result).resolves.toEqual({
    type: "resume",
    runID: runs[2]!.runID,
    targetDir: runs[2]!.targetDir,
  })
})

test("summary mode returns to the run list before quitting", async () => {
  const { renderer, result } = await browser()

  renderer.keyInput.emit("keypress", keyEvent("s"))
  renderer.keyInput.emit("keypress", keyEvent("escape"))
  renderer.keyInput.emit("keypress", keyEvent("q"))

  await expect(result).resolves.toEqual({ type: "exit" })
})

test("Ctrl-C exits immediately", async () => {
  const { renderer, result } = await browser()

  renderer.keyInput.emit("keypress", keyEvent("c", { ctrl: true, raw: "\u0003" }))

  await expect(result).resolves.toEqual({ type: "exit" })
})

test("wide screens keep the run list and details side by side", async () => {
  const testRenderer = await createTestRenderer({ width: 120, height: 40 })
  const instance = new RunsBrowser(testRenderer.renderer, sampleRuns(), 0)
  try {
    await Bun.sleep(260)
    const lines = testRenderer.captureCharFrame().split("\n")
    // The history stats ride inside the runs container's header rule — no
    // bare header row, no version tag, no runs-root path.
    const joined = lines.join("\n")
    expect(joined).toContain("runs · 3 runs")
    // The headline is semantic: pipeline - worktree, not the prompt's first line.
    expect(joined).toContain("convoy - first")
    expect(joined).toContain("✓ 1")
    expect(joined).toContain("✗ 1")
    expect(joined).toContain("$0.28")
    expect(joined).not.toContain("run history")
    expect(joined).not.toContain(shortVersion())
    expect(joined).not.toContain("OpenRouter")
    expect(joined).not.toContain("OpenAI")
    // Side by side: both container headers share the same horizontal band.
    const runsTitle = lines.findIndex((line) => line.trimStart().startsWith("╭─ runs"))
    expect(runsTitle).toBeGreaterThanOrEqual(0)
    // The runs container's header starts the line; the details container follows on the same row.
    expect(lines[runsTitle]).toContain("╭─ deta")
  } finally {
    testRenderer.mockInput.pressKey("c", { ctrl: true })
  }
})

test("compact screens stack the run list above the details panel", async () => {
  const testRenderer = await createTestRenderer({ width: 84, height: 30 })
  const instance = new RunsBrowser(testRenderer.renderer, sampleRuns(), 0)
  try {
    await Bun.sleep(260)
    const lines = testRenderer.captureCharFrame().split("\n")
    const runsTitle = lines.findIndex((line) => line.trimStart().startsWith("╭─ runs"))
    const detailsTitle = lines.findIndex((line) => line.trimStart().startsWith("╭─ deta"))
    // Stacked: the details container's header sits below the runs container's.
    expect(runsTitle).toBeGreaterThanOrEqual(0)
    expect(detailsTitle).toBeGreaterThan(runsTitle)
  } finally {
    testRenderer.mockInput.pressKey("c", { ctrl: true })
  }
})

test("compact stacking keeps the containers flush and fully drawn", async () => {
  const testRenderer = await createTestRenderer({ width: 84, height: 40 })
  const instance = new RunsBrowser(testRenderer.renderer, sampleRuns(), 0)
  try {
    await Bun.sleep(260)
    const frame = testRenderer.captureCharFrame()
    // The stats ride the runs container's header.
    expect(frame).toContain("runs · 3 runs")
    const lines = frame.split("\n")
    const tops = lines.flatMap((line, index) => (line.trimStart().startsWith("╭") ? [index] : []))
    const bottoms = lines.flatMap((line, index) => (line.trimStart().startsWith("╰") ? [index] : []))
    // Runs and details: both text containers fully drawn, the details
    // container's closing rule directly above the bare footer row — no
    // bordered chrome of its own anywhere.
    expect(tops).toHaveLength(2)
    expect(bottoms).toHaveLength(2)
    for (let index = 1; index < tops.length; index++) expect(tops[index]).toBe(bottoms[index - 1]! + 1)
  } finally {
    testRenderer.mockInput.pressKey("c", { ctrl: true })
  }
})
