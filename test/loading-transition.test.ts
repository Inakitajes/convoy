import { afterEach, describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { browseSpecs } from "../src/specs"
import { loadHomeWithTransition, type HomeContext } from "../src/cli"
import {
  blockWordmark,
  convoyHeadX,
  convoyWeight,
  defaultReducedMotion,
  envReducedMotion,
  fieldBedIntensities,
  fieldCell,
  fieldConvoys,
  fieldIntensities,
  fieldRow,
  fieldValue,
  isLoadingInterrupted,
  LoadingInterruptedError,
  paintSpan,
  transitionGrid,
  vignetteAt,
  withLoadingTransition,
  wordmarkWidth,
} from "../src/loading-transition"
import { TuiSession, type TuiRoute } from "../src/tui-session"
import { paletteForMode, setTheme } from "../src/tui-theme"

import type { CliRenderer, KeyEvent } from "@opentui/core"
import type { TuiScene } from "../src/tui-session"

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

/** A TuiSession whose scene opens are recorded, so tests can assert mounts and closures. */
async function recordedSession(width = 100, height = 30) {
  const testRenderer = await createTestRenderer({ width, height, exitOnCtrlC: false })
  const session = new TuiSession(testRenderer.renderer)
  const opened: string[] = []
  const scenes: TuiScene[] = []
  const original = session.openScene.bind(session)
  session.openScene = (id: string, onInterrupt?: () => void) => {
    opened.push(id)
    const scene = original(id, onInterrupt)
    scenes.push(scene)
    return scene
  }
  return { testRenderer, session, opened, scenes, renderer: testRenderer.renderer as CliRenderer }
}

const envSaved = process.env.CONVOY_REDUCED_MOTION
afterEach(() => {
  if (envSaved === undefined) delete process.env.CONVOY_REDUCED_MOTION
  else process.env.CONVOY_REDUCED_MOTION = envSaved
})

describe("withLoadingTransition", () => {
  test("a load settling under the threshold mounts no scene (no flash)", async () => {
    const { session, opened } = await recordedSession()
    const route: TuiRoute = { session }

    const result = await withLoadingTransition(route, "specs", async () => 42, { thresholdMs: 5_000 })

    expect(result).toBe(42)
    expect(opened).toEqual([])
    session.destroy()
  })

  test("without a route the load runs unchanged and no TUI scene mounts", async () => {
    const { session, opened } = await recordedSession()

    const result = await withLoadingTransition(undefined, "specs", async () => "plain", { thresholdMs: 5 })

    expect(result).toBe("plain")
    expect(opened).toEqual([])
    session.destroy()
  })

  test("a slow load mounts the transition, hands off when it settles, and stops animating", async () => {
    const { testRenderer, session, opened, scenes } = await recordedSession()
    const route: TuiRoute = { session }
    let resolveLoad!: (value: string) => void
    const pending = withLoadingTransition(route, "specs", () => new Promise<string>((resolve) => (resolveLoad = resolve)), {
      thresholdMs: 5,
      reducedMotion: () => false,
    })

    await Bun.sleep(50)
    await testRenderer.renderOnce()
    expect(opened).toEqual(["convoy-loading-scene"])
    const frame = testRenderer.captureCharFrame()
    expect(frame).toContain("loading…")

    resolveLoad("view")
    await expect(pending).resolves.toBe("view")
    // The scene stays painted until the destination mounts (atomic handoff).
    expect(scenes[0]!.isClosed).toBeFalse()
    const settled = testRenderer.captureCharFrame()
    await Bun.sleep(100)
    // The animation stopped with the load; no churn keeps running underneath.
    expect(testRenderer.captureCharFrame()).toBe(settled)

    // The destination's own mount closes the transition scene in place.
    session.openScene("convoy-specs-scene")
    expect(scenes[0]!.isClosed).toBeTrue()
    expect(testRenderer.renderer.isDestroyed).toBeFalse()
    session.destroy()
  })

  test("Ctrl+C during the transition flags the route and abandons the load", async () => {
    const { testRenderer, session, opened } = await recordedSession()
    let interrupted = false
    const route: TuiRoute = {
      session,
      onInterrupt: () => {
        interrupted = true
      },
    }
    let rejectLoad!: (error: Error) => void
    const pending = withLoadingTransition(route, "specs", () => new Promise<string>((_, reject) => (rejectLoad = reject)), {
      thresholdMs: 5,
      reducedMotion: () => false,
    })

    await Bun.sleep(50)
    expect(opened).toEqual(["convoy-loading-scene"])
    testRenderer.renderer.keyInput.emit("keypress", keyEvent("c", { ctrl: true, raw: "\u0003" }))

    await expect(pending).rejects.toBeInstanceOf(LoadingInterruptedError)
    expect(interrupted).toBeTrue()
    expect(testRenderer.renderer.isDestroyed).toBeFalse()
    // The abandoned load fails late; its rejection must stay consumed.
    rejectLoad(new Error("late failure"))
    await Bun.sleep(10)
    session.destroy()
  })

  test("a pending motion preference never delays the handoff", async () => {
    const { session, opened } = await recordedSession()
    const route: TuiRoute = { session }

    const result = await withLoadingTransition(route, "specs", () => Bun.sleep(40).then(() => "view"), {
      thresholdMs: 5,
      // Never resolves — the load must still win and the helper must return.
      reducedMotion: () => new Promise<boolean>(() => {}),
    })

    expect(result).toBe("view")
    expect(opened).toEqual([])
    session.destroy()
  })

  test("a load that fails while the transition is visible yields to a readable notice", async () => {
    const { testRenderer, session, opened } = await recordedSession()
    const route: TuiRoute = { session }
    let rejectLoad!: (error: Error) => void
    const pending = withLoadingTransition(
      route,
      "specs",
      () => new Promise<string>((_, reject) => (rejectLoad = reject)),
      { thresholdMs: 5, reducedMotion: () => false },
    )

    await Bun.sleep(50)
    expect(opened).toEqual(["convoy-loading-scene"])
    rejectLoad(new Error("openspec tree unreadable"))

    // The notice mounts and waits for acknowledgment before the error propagates.
    await Bun.sleep(80)
    await testRenderer.renderOnce()
    expect(opened).toContain("convoy-notice-scene")
    expect(testRenderer.captureCharFrame()).toContain("couldn't load specs: openspec tree unreadable")
    testRenderer.renderer.keyInput.emit("keypress", keyEvent("q"))
    await expect(pending).rejects.toThrow("openspec tree unreadable")
    session.destroy()
  })

  test("a load failing before the threshold propagates without any scene", async () => {
    const { session, opened } = await recordedSession()
    const route: TuiRoute = { session }

    await expect(withLoadingTransition(route, "specs", async () => {
      throw new Error("boom")
    }, { thresholdMs: 5_000 })).rejects.toThrow("boom")
    expect(opened).toEqual([])
    session.destroy()
  })

  test("the status line floats centered over the field on both axes", async () => {
    const { testRenderer, session, opened } = await recordedSession(100, 30)
    const route: TuiRoute = { session }
    let resolveLoad!: (value: string) => void
    const pending = withLoadingTransition(route, "specs", () => new Promise<string>((resolve) => (resolveLoad = resolve)), {
      thresholdMs: 5,
      reducedMotion: () => true,
    })

    await Bun.sleep(50)
    await testRenderer.renderOnce()
    expect(opened).toEqual(["convoy-loading-scene"])
    const lines = testRenderer.captureCharFrame().split("\n")
    const labelIndex = lines.findIndex((line) => line.includes("loading…"))
    expect(labelIndex).toBeGreaterThanOrEqual(0)
    // Vertically centered: the label lives in the middle band of the frame,
    // not hugging the top edge or the old bottom status row.
    expect(labelIndex).toBeGreaterThanOrEqual(Math.floor(lines.length / 3))
    expect(labelIndex).toBeLessThanOrEqual(Math.ceil((2 * lines.length) / 3))
    // Horizontally centered: the text starts well inside the row (a 100-col
    // terminal leaves ~42 leading columns for the 15-char status), not flush
    // left. The columns around it belong to the field, so measure the offset.
    const start = lines[labelIndex]!.indexOf("loading…")
    expect(start).toBeGreaterThanOrEqual(20)
    expect(start).toBeLessThanOrEqual(50)

    resolveLoad("view")
    await expect(pending).resolves.toBe("view")
    session.destroy()
  })

  test("a reduced-motion preference renders one static frame", async () => {
    const { testRenderer, session, opened, scenes } = await recordedSession()
    const route: TuiRoute = { session }
    let resolveLoad!: (value: string) => void
    const pending = withLoadingTransition(route, "specs", () => new Promise<string>((resolve) => (resolveLoad = resolve)), {
      thresholdMs: 5,
      reducedMotion: () => true,
    })

    await Bun.sleep(50)
    await testRenderer.renderOnce()
    expect(opened).toEqual(["convoy-loading-scene"])
    const staticFrame = testRenderer.captureCharFrame()
    expect(staticFrame).toContain("loading…")
    // The static field is informative (some cells carry ramp glyphs)…
    expect(staticFrame).toMatch(/[*·:×.]/)
    // …and unmoving.
    await Bun.sleep(120)
    expect(testRenderer.captureCharFrame()).toBe(staticFrame)

    resolveLoad("view")
    await expect(pending).resolves.toBe("view")
    session.openScene("convoy-specs-scene")
    expect(scenes[0]!.isClosed).toBeTrue()
    session.destroy()
  })
})

describe("the specs browser routes through the transition", () => {
  test("non-interactive stdio skips the transition entirely (plain output path)", async () => {
    const { session, opened } = await recordedSession()
    const route: TuiRoute = { session }
    // bun test runs without TTYs, which is exactly the spec's non-interactive
    // case: no animated transition may render, and the plain path is kept.
    const root = await mkdtempSpecsRepo()

    await expect(browseSpecs(root, route)).resolves.toEqual({ type: "exit" })

    expect(opened).toEqual([])
    session.destroy()
  })
})

describe("the home context load routes through the transition", () => {
  test("a slow home load mounts the transition with the home label and hands off", async () => {
    const { testRenderer, session, opened, scenes } = await recordedSession()
    const route: TuiRoute = { session }
    let resolveLoad!: (value: HomeContext) => void
    const pending = loadHomeWithTransition(
      route,
      ".",
      () => new Promise<HomeContext>((resolve) => (resolveLoad = resolve)),
      { thresholdMs: 5, reducedMotion: () => false },
    )

    await Bun.sleep(50)
    await testRenderer.renderOnce()
    expect(opened).toEqual(["convoy-loading-scene"])
    const frame = testRenderer.captureCharFrame()
    // The centered card: the home masthead's block-letter wordmark over the
    // loading status, inside its own rounded rectangle.
    expect(frame).toContain("████")
    expect(frame).toContain("loading home…")
    // Frameless: the name floats directly over the field, with no card border.
    expect(frame).not.toContain("╭")

    // Settling yields the context; the scene stays painted until Home's own
    // mount closes it (atomic handoff, same contract as the destinations).
    resolveLoad({ worktrees: [] })
    await expect(pending).resolves.toEqual({ worktrees: [] })
    expect(scenes[0]!.isClosed).toBeFalse()
    session.openScene("convoy-home-scene")
    expect(scenes[0]!.isClosed).toBeTrue()
    session.destroy()
  })

  test("Ctrl+C during the home transition resolves undefined and flags the route", async () => {
    const { testRenderer, session, opened } = await recordedSession()
    let interrupted = false
    const route: TuiRoute = {
      session,
      onInterrupt: () => {
        interrupted = true
      },
    }
    const pending = loadHomeWithTransition(
      route,
      ".",
      () => new Promise<HomeContext>(() => {}),
      { thresholdMs: 5, reducedMotion: () => false },
    )

    await Bun.sleep(50)
    expect(opened).toEqual(["convoy-loading-scene"])
    testRenderer.renderer.keyInput.emit("keypress", keyEvent("c", { ctrl: true, raw: "\u0003" }))

    // The quiet undefined answer is what lets the navigation loop exit
    // instead of opening Home.
    await expect(pending).resolves.toBeUndefined()
    expect(interrupted).toBeTrue()
    expect(testRenderer.renderer.isDestroyed).toBeFalse()
    session.destroy()
  })

})

describe("the loading name wordmark", () => {
  test("known names render as five-row block glyphs", () => {
    for (const name of ["CONVOY", "HOME", "SPECS", "RUNS"]) {
      const lines = blockWordmark(name)!
      expect(lines.length).toBe(5)
      expect(wordmarkWidth(lines)).toBeGreaterThan(0)
      expect(lines.join("")).toContain("█")
    }
    // Lowercase is uppercased before lookup.
    expect(blockWordmark("home")).toEqual(blockWordmark("HOME"))
  })

  test("a name with an unknown letter has no block form", () => {
    expect(blockWordmark("CONFIG")).toBeUndefined()
    expect(blockWordmark("xyz")).toBeUndefined()
    expect(blockWordmark("")).toBeUndefined()
  })

  test("the transition names what it is loading and de-duplicates the status", async () => {
    const cases = [
      // Home's wordmark is the brand, so the status still names the destination.
      { name: "CONVOY", label: "home", status: "loading home…" },
      // The wordmark already names these destinations, so the status stays bare.
      { name: "specs", label: undefined, status: "loading…" },
      { name: "runs", label: undefined, status: "loading…" },
    ] as const
    for (const { name, label, status } of cases) {
      const { testRenderer, session, opened } = await recordedSession()
      const route: TuiRoute = { session }
      void withLoadingTransition(route, name, () => new Promise<string>(() => {}), {
        thresholdMs: 5,
        reducedMotion: () => true,
        ...(label === undefined ? {} : { label }),
      })
      await Bun.sleep(30)
      await testRenderer.renderOnce()
      expect(opened).toEqual(["convoy-loading-scene"])
      const frame = testRenderer.captureCharFrame()
      expect(frame).toContain(status)
      expect(frame).toContain("████")
      // The status never repeats a wordmark that already names the destination.
      if (label === undefined) expect(frame).not.toContain(`loading ${name}…`)
      // No card border/backdrop: the name floats directly over the field.
      expect(frame).not.toContain("╭")
      session.destroy()
    }
  })

  test("a name without a block form falls back to plain uppercase text", async () => {
    const { testRenderer, session, opened } = await recordedSession()
    const route: TuiRoute = { session }
    void withLoadingTransition(route, "config", () => new Promise<string>(() => {}), { thresholdMs: 5, reducedMotion: () => true })
    await Bun.sleep(30)
    await testRenderer.renderOnce()
    expect(opened).toEqual(["convoy-loading-scene"])
    const frame = testRenderer.captureCharFrame()
    expect(frame).toContain("CONFIG")
    expect(frame).toContain("loading…")
    expect(frame).not.toContain("╭")
    session.destroy()
  })
})

describe("the convoy current model", () => {
  test("fieldValue stays in range, is deterministic, and varies with position and time", () => {
    for (const [x, y, t] of [
      [0, 0, 0],
      [13, 7, 1.5],
      [40, 20, 4.2],
      [110, 60, 12],
    ] as const) {
      const value = fieldValue(x, y, t)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
      expect(fieldValue(x, y, t)).toBe(value)
    }
    // Position and time both shape the current.
    expect(fieldValue(3, 5, 1)).not.toBe(fieldValue(9, 5, 1))
    expect(fieldValue(3, 5, 1)).not.toBe(fieldValue(3, 5, 2))
  })

  test("the vignette is calm at the center and full at the corners", () => {
    const cols = 11
    const rows = 11
    // Center cell: radius 0 → fully calm.
    expect(vignetteAt(5, 5, cols, rows)).toBe(0)
    // Corner: radius 1 → fully strong.
    expect(vignetteAt(0, 0, cols, rows)).toBeCloseTo(1, 10)
    // A mid-edge sample sits between the two.
    const edge = vignetteAt(0, 5, cols, rows)
    expect(edge).toBeGreaterThan(0)
    expect(edge).toBeLessThan(1)
    // Range holds everywhere, including degenerate single-cell axes.
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const value = vignetteAt(x, y, cols, rows)
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(1)
      }
    }
    expect(vignetteAt(0, 0, 1, 1)).toBe(0)
  })

  test("the current bed is pure, edge-weighted, smooth, and below the accent band", () => {
    const cols = 41
    const rows = 21
    const bed = fieldBedIntensities(cols, rows, 1_000)
    expect(bed.length).toBe(cols * rows)
    for (const value of bed) {
      expect(value).toBeGreaterThanOrEqual(0)
      // The bed never reaches the accent band; accent is the convoys' job.
      expect(value).toBeLessThan(0.88)
    }
    // Deterministic: same position and time, same bed.
    expect(fieldBedIntensities(cols, rows, 1_000)).toEqual(bed)

    // The center pocket is calm; the outer band carries the current (framing).
    let centerSum = 0
    let centerCount = 0
    let edgeSum = 0
    let edgeCount = 0
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const envelope = vignetteAt(x, y, cols, rows)
        const value = bed[y * cols + x]!
        if (envelope === 0) {
          centerSum += value
          centerCount += 1
        } else if (envelope === 1) {
          edgeSum += value
          edgeCount += 1
        }
      }
    }
    expect(centerCount).toBeGreaterThan(0)
    expect(edgeCount).toBeGreaterThan(0)
    expect(centerSum / centerCount).toBe(0)
    expect(edgeSum / edgeCount).toBeGreaterThan(0.1)

    // Smooth in time and space: the bed is a slow current, not flicker.
    for (let now = 0; now <= 2_000; now += 250) {
      const frame = fieldBedIntensities(cols, rows, now)
      const later = fieldBedIntensities(cols, rows, now + 66)
      for (let index = 0; index < frame.length; index += 1) {
        expect(Math.abs(frame[index]! - later[index]!)).toBeLessThan(0.05)
      }
      for (let y = 0; y < rows; y++) {
        for (let x = 1; x < cols; x++) {
          expect(Math.abs(frame[y * cols + x]! - frame[y * cols + x - 1]!)).toBeLessThan(0.4)
        }
      }
    }
  })

  test("the convoys ride the current and carry the accent", () => {
    // A formation advances along the flow at its own speed.
    const convoy = fieldConvoys[1]!
    const elapsed = 0.2
    expect(convoyHeadX(convoy, 50, elapsed * 1_000) - convoyHeadX(convoy, 50, 0)).toBeCloseTo(convoy.speed * elapsed, 5)

    // The wake tapers from the lead and stays non-negative.
    expect(convoyWeight(0, 10)).toBeGreaterThan(convoyWeight(9, 10))
    expect(convoyWeight(9, 10)).toBeGreaterThanOrEqual(0)

    // The convoys — never the bed — carry the accent across time.
    let frames = 0
    let accented = 0
    for (let now = 0; now <= 4_000; now += 250) {
      frames += 1
      if (Math.max(...fieldIntensities(50, 30, now)) >= 0.88) accented += 1
      for (const value of fieldBedIntensities(50, 30, now)) expect(value).toBeLessThan(0.88)
    }
    expect(accented).toBeGreaterThanOrEqual(Math.ceil(frames / 2))
  })

  test("fieldIntensities is deterministic, time-varying, and frames the center", () => {
    const cols = 41
    const rows = 21
    const field = fieldIntensities(cols, rows, 1_000)
    expect(field.length).toBe(cols * rows)
    for (const value of field) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
    expect(fieldIntensities(cols, rows, 1_000)).toEqual(field)
    // The center pocket stays fully calm behind the name.
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (vignetteAt(x, y, cols, rows) === 0) expect(field[y * cols + x]).toBe(0)
      }
    }
    // The current moves with time.
    expect(fieldIntensities(cols, rows, 1_066)).not.toEqual(field)
  })

  test("the density ramp reaches every tone and never the bright text tone", () => {
    expect(fieldCell(0)).toBeUndefined()
    expect(fieldCell(0.09)).toBeUndefined()
    expect(fieldCell(0.1)).toEqual({ glyph: ".", color: "faint" })
    expect(fieldCell(0.33)).toEqual({ glyph: ".", color: "faint" })
    expect(fieldCell(0.34)).toEqual({ glyph: "·", color: "faint" })
    expect(fieldCell(0.51)).toEqual({ glyph: "·", color: "faint" })
    expect(fieldCell(0.52)).toEqual({ glyph: ":", color: "dim" })
    expect(fieldCell(0.71)).toEqual({ glyph: ":", color: "dim" })
    expect(fieldCell(0.72)).toEqual({ glyph: "×", color: "dim" })
    expect(fieldCell(0.87)).toEqual({ glyph: "×", color: "dim" })
    expect(fieldCell(0.88)).toEqual({ glyph: "*", color: "accent" })
    expect(fieldCell(1)).toEqual({ glyph: "*", color: "accent" })

    const tones = new Set<string>()
    for (let now = 0; now <= 8_000; now += 250) {
      for (const value of fieldIntensities(50, 30, now)) tones.add(fieldCell(value)?.color ?? "blank")
    }
    expect(tones).toContain("blank")
    expect(tones).toContain("faint")
    expect(tones).toContain("dim")
    expect(tones).toContain("accent")
    expect(tones.has("text")).toBeFalse()
  })

  test("the sampling grid stays coarse and clamped on huge terminals", () => {
    expect(transitionGrid(80, 23)).toEqual({ cols: 40, rows: 23 })
    expect(transitionGrid(400, 200)).toEqual({ cols: 110, rows: 60 })
    expect(transitionGrid(1, 1)).toEqual({ cols: 1, rows: 1 })
  })

  test("paint spans fill the terminal exactly and keep every sample", () => {
    // Odd widths, just-over-cap sizes, and the clamped maximums: spans must
    // sum to the terminal size exactly (no dead band) with no sample dropped.
    for (const [count, size] of [
      [40, 80],
      [41, 81],
      [110, 220],
      [110, 300],
      [110, 400],
      [60, 60],
      [60, 61],
      [60, 99],
      [29, 29],
      [1, 1],
    ] as const) {
      let total = 0
      const spans = Array.from({ length: count }, (_, i) => {
        const span = paintSpan(i, count, size)
        expect(span).toBeGreaterThanOrEqual(1)
        total += span
        return span
      })
      expect(total).toBe(size)
      // The last sample is never sacrificed to the fill.
      expect(spans[count - 1]!).toBeGreaterThanOrEqual(1)
    }
  })

  test("a painted row fills its width on typical, odd, and over-cap terminals", () => {
    const bright = (cols: number) => new Float64Array(cols).fill(0.9)
    const textOf = (row: ReturnType<typeof fieldRow>) => row.chunks.map((chunk) => chunk.text).join("")
    // Typical terminal: two columns per sampled cell, as before.
    expect(textOf(fieldRow(40, bright(40), 0, 80))).toHaveLength(80)
    // Odd width: spans absorb the remainder without overflowing.
    expect(textOf(fieldRow(41, bright(41), 0, 81))).toHaveLength(81)
    // Over-cap terminal: three-column spans cover what the clamped grid can't sample.
    expect(textOf(fieldRow(110, bright(110), 0, 300))).toHaveLength(300)
  })

  test("a painted row carries the active theme palette on each tone", () => {
    const palette = paletteForMode("light")
    setTheme(palette)
    // accent → dim → faint → blank: each adjacent pair is a distinct tone, so
    // the runs don't merge and each sampled cell keeps its own chunk.
    const intensities = new Float64Array([0.95, 0.6, 0.4, 0.0])
    const chunks = fieldRow(4, intensities, 0, 4).chunks
    // Every cell paints exactly one column at width 4.
    expect(chunks.map((chunk) => chunk.text).join("")).toHaveLength(4)
    // The foreground is the theme color, decoded from the palette hex, so the
    // field stays legible on the light background rather than a fixed color.
    const rgb = (hex: string) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
    const fgOf = (chunk: (typeof chunks)[number]) => (chunk.fg ? [...chunk.fg.buffer.slice(0, 3)] : undefined)
    expect(fgOf(chunks[0]!)).toEqual(rgb(palette.accent))
    expect(fgOf(chunks[1]!)).toEqual(rgb(palette.dim))
    expect(fgOf(chunks[2]!)).toEqual(rgb(palette.faint))
    expect(chunks[3]!.fg).toBeUndefined()
    // accent, dim, and faint are three distinct palette tones, not one color.
    expect(new Set(chunks.slice(0, 3).map((chunk) => chunk.fg?.buffer[0])).size).toBe(3)
    setTheme(paletteForMode("dark"))
  })
})

describe("reduced-motion preference", () => {
  test("the environment variable overrides everything", async () => {
    process.env.CONVOY_REDUCED_MOTION = "1"
    expect(await defaultReducedMotion()).toBeTrue()
    process.env.CONVOY_REDUCED_MOTION = "true"
    expect(await defaultReducedMotion()).toBeTrue()
    process.env.CONVOY_REDUCED_MOTION = "0"
    expect(await defaultReducedMotion()).toBeFalse()
    process.env.CONVOY_REDUCED_MOTION = "off"
    expect(await defaultReducedMotion()).toBeFalse()
    process.env.CONVOY_REDUCED_MOTION = "garbage"
    // An unknown value is no preference: fall through to config + probe.
    expect(typeof (await defaultReducedMotion())).toBe("boolean")
  })

  test("envReducedMotion only answers for explicit values", () => {
    delete process.env.CONVOY_REDUCED_MOTION
    expect(envReducedMotion()).toBeUndefined()
    process.env.CONVOY_REDUCED_MOTION = "on"
    expect(envReducedMotion()).toBeTrue()
    process.env.CONVOY_REDUCED_MOTION = "false"
    expect(envReducedMotion()).toBeFalse()
  })
})

// Builds a repo whose board load is fast (one change, no git shelling surprises).
let specsRepoCount = 0
async function mkdtempSpecsRepo(): Promise<string> {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = await mkdtemp(join(tmpdir(), `convoy-loading-${++specsRepoCount}-`))
  await mkdir(join(dir, "openspec", "changes", "add-login"), { recursive: true })
  await writeFile(join(dir, "openspec", "changes", "add-login", "proposal.md"), "# Add login\n")
  await mkdir(join(dir, "openspec", "specs"), { recursive: true })
  return dir
}
