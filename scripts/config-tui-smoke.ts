/**
 * Headless smoke test for the config TUI: renders real frames with opentui's
 * test renderer, drives the editor with synthetic key events, and asserts on
 * the frames plus the YAML it saves. Run with:
 *
 *   bun run scripts/config-tui-smoke.ts
 *
 * Everything is isolated under a temp ARCHER_HOME; no network is required
 * (model pickers are exercised through typed free-form entries).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const scratch = await mkdtemp(join(tmpdir(), "archer-config-tui-smoke-"))
process.env.ARCHER_HOME = scratch

const { createTestRenderer } = await import("@opentui/core/testing")
const { loadGlobalArcherConfig } = await import("../src/config")
const { ConfigEditor } = await import("../src/config-tui")

const globalArcherDir = join(scratch, ".archer")
await mkdir(globalArcherDir, { recursive: true })
await writeFile(join(globalArcherDir, "config.yaml"), "version: 1\ndefaults:\n  model: openai/gpt-5.6-terra#xhigh\n")
const projectDir = await mkdtemp(join(tmpdir(), "archer-config-tui-smoke-project-"))

const setup = await createTestRenderer({ width: 120, height: 40 })
const { renderer, mockInput, flush, captureCharFrame } = setup

const globalConfig = await loadGlobalArcherConfig()
const editor = new ConfigEditor(renderer, projectDir, globalConfig, undefined)

let failures = 0
function check(label: string, ok: boolean, context?: string) {
  if (ok) {
    console.log(`ok  ${label}`)
    return
  }
  failures++
  console.error(`FAIL ${label}`)
  if (context) console.error(context)
}

async function pressUntil(key: string, predicate: (frame: string) => boolean, label: string, max = 120) {
  for (let i = 0; i < max; i++) {
    if (predicate(captureCharFrame())) return
    mockInput.pressKey(key)
    await flush()
  }
  check(label, false, captureCharFrame())
  throw new Error(`gave up waiting for: ${label}`)
}

/** Waits for an async UI effect (like save's write) to land in a frame before continuing. */
async function waitFrame(predicate: (frame: string) => boolean, label: string, max = 200) {
  for (let i = 0; i < max; i++) {
    if (predicate(captureCharFrame())) return
    await flush()
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  check(label, false, captureCharFrame())
  throw new Error(`gave up waiting for: ${label}`)
}

async function type(text: string) {
  await mockInput.typeText(text)
  await flush()
}

try {
  await flush()
  check("editor renders the Defaults section", captureCharFrame().includes("Defaults"))

  // Materialize the built-in `review` pipeline into the global config.
  await pressUntil("ARROW_DOWN", (frame) => frame.includes("built-in pipeline: review"), "cursor reaches the review built-in row")
  check("built-in pipelines are listed", captureCharFrame().includes("Built-in pipelines"))
  mockInput.pressKey("RETURN")
  await flush()
  check("customize confirm modal opens", captureCharFrame().includes("Customize"))
  mockInput.pressKey("y")
  await flush()
  const materialized = captureCharFrame()
  check("review expands with a parallel group header", materialized.includes("parallel (3 members · read-only)"))
  check("members render with dotted numbering", materialized.includes("2.1") && materialized.includes("clean-code"))
  check("the review built-in row is now shadowed", !materialized.includes("built-in pipeline: review"))

  // Multi-model picker on member 2.1: replace the fan-out with two typed models.
  await pressUntil("ARROW_DOWN", (frame) => frame.includes("step 2.1 of review"), "cursor reaches member 2.1")
  mockInput.pressKey("m", { shift: true })
  await flush()
  check("multi-model picker opens", captureCharFrame().includes("space toggle"))
  await type("smoke/model-a")
  mockInput.pressKey(" ")
  await flush()
  check("typed model toggles on", captureCharFrame().includes("◆"))
  for (let i = 0; i < "smoke/model-a".length; i++) mockInput.pressKey("BACKSPACE")
  await flush()
  await type("smoke/model-b")
  mockInput.pressKey(" ")
  await flush()
  mockInput.pressKey("RETURN")
  await flush()
  check("member shows the new fan-out", captureCharFrame().includes("2 models"))

  // Cycle diff on the same member (the row summary truncates, so the saved
  // YAML assertion below is what proves the toggle landed) and save.
  mockInput.pressKey("x")
  await flush()
  mockInput.pressKey("s")
  await waitFrame((frame) => frame.includes("Saved") || frame.includes("Save failed") || frame.includes("save anyway?"), "save settles")
  check("save reports success", captureCharFrame().includes("Saved"), captureCharFrame())
  mockInput.pressKey("RETURN")
  await flush()

  const saved = await readFile(join(globalArcherDir, "config.yaml"), "utf8")
  check("saved YAML contains the review override", saved.includes("review:"))
  check("saved YAML contains the parallel block", saved.includes("parallel:"))
  check("saved YAML contains the typed fan-out", saved.includes("smoke/model-a") && saved.includes("smoke/model-b"))
  check("saved YAML contains the diff toggle", saved.includes("diff: true"))

  // Quit cleanly (config was just saved, so no confirm).
  mockInput.pressKey("q")
  await editor.result
} finally {
  if (!renderer.isDestroyed) renderer.destroy()
  await rm(scratch, { recursive: true, force: true })
  await rm(projectDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) failed`)
  process.exit(1)
}
console.log("\nconfig TUI smoke: all checks passed")
