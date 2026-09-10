import { afterEach, describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { browseSpecs } from "../src/specs"
import { loadHomeWithTransition, type HomeContext } from "../src/cli"
import {
  breathAmplitude,
  breathPeriodMs,
  defaultReducedMotion,
  dimmedSea,
  envReducedMotion,
  intensityCell,
  isLoadingInterrupted,
  LoadingInterruptedError,
  paintSpan,
  seaCell,
  seaDimFactor,
  seaIntensities,
  seaRow,
  transitionGrid,
  withLoadingTransition,
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
    expect(frame).toContain("loading specs…")

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

  test("the status line floats centered over the sea on both axes", async () => {
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
    const labelIndex = lines.findIndex((line) => line.includes("loading specs…"))
    expect(labelIndex).toBeGreaterThanOrEqual(0)
    // Vertically centered: the label lives in the middle band of the frame,
    // not hugging the top edge or the old bottom status row.
    expect(labelIndex).toBeGreaterThanOrEqual(Math.floor(lines.length / 3))
    expect(labelIndex).toBeLessThanOrEqual(Math.ceil((2 * lines.length) / 3))
    // Horizontally centered: the text starts well inside the row (a 100-col
    // terminal leaves ~42 leading columns for the 15-char status), not flush
    // left. The columns around it belong to the sea, so measure the offset.
    const start = lines[labelIndex]!.indexOf("loading specs…")
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
    expect(staticFrame).toContain("loading specs…")
    // The static field is informative (some cells carry ramp glyphs)…
    expect(staticFrame).toMatch(/[·:]/)
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
    expect(frame).toContain("╭")

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

describe("the breathing sea model", () => {
  test("the painted sea keeps every tone one notch under the shared ramp", () => {
    // The dimming is a mild, order-preserving pull: the shape survives, and
    // the field still populates blank troughs, faint dots, dim dots, and
    // colon crests — but nothing reaches the shared ramp's bright text tone.
    const field = seaIntensities(41, 21, 1_000)
    const dimmed = dimmedSea(field)
    expect(dimmed.length).toBe(field.length)
    for (let index = 0; index < field.length; index += 1) {
      expect(dimmed[index]).toBeCloseTo(field[index]! * seaDimFactor, 10)
    }
    const tones = new Set(Array.from(dimmed, (value) => seaCell(value)?.color ?? "blank"))
    expect(tones.has("text")).toBeFalse()
    expect(tones).toContain("blank")
    expect(tones).toContain("faint")
    expect(tones).toContain("dim")
    expect(dimmedSea(field, 1)).toEqual(field)
  })

  test("the transition's compressed ramp keeps the wave's tonal contrast", () => {
    // The thresholds preserve the shared ramp's proportions (blank → faint →
    // dim · → dim :) so swells still read through colon crests against dot
    // bodies; the brightness ranking is the shared ramp's, minus its bright
    // text tone.
    expect(seaCell(0)).toBeUndefined()
    expect(seaCell(0.04)).toBeUndefined()
    expect(seaCell(0.05)).toEqual({ glyph: "·", color: "faint" })
    expect(seaCell(0.24)).toEqual({ glyph: "·", color: "faint" })
    expect(seaCell(0.25)).toEqual({ glyph: "·", color: "dim" })
    expect(seaCell(0.49)).toEqual({ glyph: "·", color: "dim" })
    expect(seaCell(0.5)).toEqual({ glyph: ":", color: "dim" })
    expect(seaCell(1)).toEqual({ glyph: ":", color: "dim" })
  })

  test("the breath envelope pulses between its floor and 1 over one period", () => {
    // The envelope is a full sine over the period: rest at the phase origin,
    // crest a quarter period later, back to rest at the trough.
    expect(breathAmplitude(0)).toBeCloseTo(0.5 + (1 - 0.5) / 2, 10)
    expect(breathAmplitude(breathPeriodMs / 4)).toBeCloseTo(1, 10)
    expect(breathAmplitude((3 * breathPeriodMs) / 4)).toBeCloseTo(0.5, 10)
    expect(breathAmplitude(breathPeriodMs)).toBeCloseTo(breathAmplitude(0), 10)
    for (let ms = 0; ms <= breathPeriodMs; ms += 250) {
      const value = breathAmplitude(ms)
      expect(value).toBeGreaterThanOrEqual(0.5)
      expect(value).toBeLessThanOrEqual(1)
    }
  })

  test("intensities describe a coherent breathing sea, not expanding rings", () => {
    const field = seaIntensities(41, 21, 1_000)
    expect(field.length).toBe(41 * 21)
    for (const value of field) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
    // Deterministic: same position and time, same brightness — the field is a
    // pure function, so a resize never strands hidden state.
    expect(seaIntensities(41, 21, 1_000)).toEqual(field)
    // The sea undulates: no frame is empty (the breath floor keeps swells
    // visible) and crests reach the bright tones of the ramp.
    expect(field.some((value) => value > 0.9)).toBeTrue()
    // The sea breathes in place: at the trough of the envelope the whole
    // surface dims together (no cell can exceed half brightness), and at the
    // crest bright swells return — a global pulse, not rings going dark.
    const crest = seaIntensities(41, 21, breathPeriodMs / 4)
    const trough = seaIntensities(41, 21, (3 * breathPeriodMs) / 4)
    for (const value of trough) expect(value).toBeLessThanOrEqual(0.5)
    expect(crest.some((value) => value > 0.9)).toBeTrue()
    // The swells travel: the field drifts as crests move across the surface.
    const later = seaIntensities(41, 21, 1_500)
    const drift = field.reduce((total, value, index) => total + Math.abs(value - later[index]!), 0)
    expect(drift).toBeGreaterThan(0)
  })

  test("the brightness ramp quantizes onto the theme tones", () => {
    expect(intensityCell(0)).toBeUndefined()
    expect(intensityCell(0.1)).toEqual({ glyph: "·", color: "faint" })
    expect(intensityCell(0.4)).toEqual({ glyph: "·", color: "dim" })
    expect(intensityCell(0.6)).toEqual({ glyph: ":", color: "dim" })
    expect(intensityCell(0.9)).toEqual({ glyph: "·", color: "text" })
    for (const step of [0, 0.05, 0.2, 0.4, 0.6, 0.8, 1]) {
      const color = intensityCell(step)?.color
      expect(color === undefined || ["faint", "dim", "text"].includes(color)).toBeTrue()
    }
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
    const textOf = (row: ReturnType<typeof seaRow>) => row.chunks.map((chunk) => chunk.text).join("")
    // Typical terminal: two columns per sampled cell, as before.
    expect(textOf(seaRow(40, bright(40), 0, 80))).toHaveLength(80)
    // Odd width: spans absorb the remainder without overflowing.
    expect(textOf(seaRow(41, bright(41), 0, 81))).toHaveLength(81)
    // Over-cap terminal: three-column spans cover what the clamped grid can't sample.
    expect(textOf(seaRow(110, bright(110), 0, 300))).toHaveLength(300)
  })

  test("a painted row carries the active theme palette on each tone", () => {
    const palette = paletteForMode("light")
    setTheme(palette)
    // Bright → text, mid → dim (":"), low → faint, blank stays unstyled. Each
    // tone is distinct so no adjacent run merges, keeping one chunk per tone.
    const intensities = new Float64Array([0.9, 0.6, 0.1, 0.0])
    const row = seaRow(4, intensities, 0, 4)
    const chunks = row.chunks
    // Every cell paints exactly one column at width 4.
    expect(chunks.map((chunk) => chunk.text).join("")).toHaveLength(4)
    // The foreground is the theme color, decoded from the palette hex, so the
    // wave stays legible on the light background rather than a fixed color.
    const rgb = (hex: string) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
    const fgOf = (chunk: (typeof chunks)[number]) => (chunk.fg ? [...chunk.fg.buffer.slice(0, 3)] : undefined)
    expect(fgOf(chunks[0]!)).toEqual(rgb(palette.text))
    expect(fgOf(chunks[1]!)).toEqual(rgb(palette.dim))
    expect(fgOf(chunks[2]!)).toEqual(rgb(palette.faint))
    expect(chunks[3]!.fg).toBeUndefined()
    // text, dim, and faint are three distinct palette tones, not one color.
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
