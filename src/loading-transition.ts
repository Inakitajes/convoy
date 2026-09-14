import { BoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core"

import { joinLines, paletteForTerminal, raw, setTheme, terminalBackgroundHex, theme } from "./tui-theme"
import { sceneForRoute, type TuiRoute, type TuiScene } from "./tui-session"

import type { CliRenderer, KeyEvent, TextChunk } from "@opentui/core"

/**
 * The shared loading transition of the home session: while a destination load
 * outlasts a short threshold, a scene of a directional current of characters
 * with convoys riding it, behind a centered, frameless name wordmark, replaces
 * the frozen home frame, and the destination's own scene mount paints over it
 * atomically (the same contract every home-session screen already uses — scenes
 * close only when the next one mounts). Rejected or interrupted loads never
 * leave a dead screen, and loads that finish quickly never flash it.
 *
 * The field is a "convoy current": a deterministic bed of streamlines flowing
 * along one heading (thin glassy bands, never reaching the accent tone) with
 * a handful of bright formations gliding down it, each a lead pulsing into a
 * fading wake. It is densest toward the terminal's edges and calmest behind
 * the name, so it reads as a group moving with purpose — not an isotropic
 * swirl, not random noise.
 * The center names what is loading (CONVOY, SPECS, RUNS) in a block
 * alphabet; a name with unknown letters or one too wide falls back to plain
 * uppercase text.
 *
 * OpenTUI is imported eagerly by this module, so it is only ever loaded on
 * interactive paths (specs.ts dynamic-imports it under `route`).
 */

/** Quiet period before a slow load earns the transition (no flash on fast loads). */
export const loadingThresholdMs = 150

/** Animation cadence cap (~30 fps): bounds CPU and ANSI output over SSH. */
const frameIntervalMs = 1000 / 30

/** A rejected or slow motion-preference source degrades to "animate". */
const motionResolveBoundMs = 400
const motionProbeKillMs = 250

/**
 * Thrown when the operator presses Ctrl+C while the transition is visible.
 * Callers map it to a quiet exit — the route's interrupt flag already told
 * the home session to quit — rather than opening the destination.
 */
export class LoadingInterruptedError extends Error {
  constructor(message = "interrupted while loading") {
    super(message)
    this.name = "LoadingInterruptedError"
  }
}

export function isLoadingInterrupted(error: unknown): error is LoadingInterruptedError {
  return error instanceof LoadingInterruptedError || (error instanceof Error && error.name === "LoadingInterruptedError")
}

export type LoadingTransitionOptions = {
  /** Overrides the no-flash threshold; tests shrink it to keep the suite fast. */
  thresholdMs?: number
  /** Directory the default reduced-motion resolver reads project config from. */
  targetDir?: string
  /** Overrides the motion preference: a boolean, or a resolver consulted after the threshold wins (tests inject fakes). */
  reducedMotion?: boolean | (() => boolean | Promise<boolean>)
  /**
   * The destination's name, used by the status line and the failure messages.
   * Defaults to `name`. The status drops it when the wordmark already shows the
   * same word (Home keeps it: the wordmark reads CONVOY while Home loads).
   */
  label?: string
}

/**
 * Runs `load`, showing the convoy-current transition named `name` on the route's
 * session only when the load genuinely outlasts the threshold. Without a route
 * (non-interactive and piped invocations) the load runs unchanged. Every
 * settlement path leaves the session healthy: the transition stops animating as
 * soon as the load settles, and the destination's own scene mount replaces it in
 * place.
 */
export async function withLoadingTransition<T>(
  route: TuiRoute | undefined,
  name: string | undefined,
  load: () => Promise<T>,
  options: LoadingTransitionOptions = {},
): Promise<T> {
  if (!route) return load()

  // The destination's name for status/errors; the wordmark may differ (Home's
  // wordmark is CONVOY while its destination stays "home").
  const destination = options.label ?? name
  const threshold = options.thresholdMs ?? loadingThresholdMs
  let loadSettled = false
  const loadPromise = load().then(
    (value) => {
      loadSettled = true
      return value
    },
    (error) => {
      loadSettled = true
      throw error
    },
  )

  // Fast loads win the race before the threshold fires: no scene, no flash.
  const winner = await Promise.race([loadPromise.then(() => "load" as const), delay(threshold).then(() => "threshold" as const)])
  if (winner === "load") return loadPromise

  // The load is genuinely slow. Resolve the motion preference without ever
  // holding the destination back — whichever settles first wins, so a load
  // finishing during resolution skips the transition entirely.
  const resolved = await Promise.race([
    loadPromise.then((): { kind: "load" } => ({ kind: "load" })),
    resolveReducedMotion(options).then((reducedMotion): { kind: "pref"; reducedMotion: boolean } => ({ kind: "pref", reducedMotion })),
  ])
  if (loadSettled || resolved.kind === "load") return loadPromise

  const scene = sceneForRoute(route, "convoy-loading-scene")!
  let rejectInterrupt!: (error: LoadingInterruptedError) => void
  const interrupted = new Promise<never>((_, reject) => {
    rejectInterrupt = reject
  })
  const transition = new LoadingTransition(route.session.renderer, scene, {
    ...(name === undefined ? {} : { name }),
    ...(options.label === undefined ? {} : { label: options.label }),
    reducedMotion: resolved.reducedMotion,
    onInterrupt: () =>
      rejectInterrupt(
        new LoadingInterruptedError(destination === undefined ? "interrupted while loading" : `interrupted while loading ${destination}`),
      ),
  })
  try {
    return await Promise.race([loadPromise, interrupted])
  } catch (error) {
    transition.stop()
    if (!isLoadingInterrupted(error)) {
      // The transition yields to a readable status message naming the failure;
      // the original error still propagates to the caller.
      const reason = error instanceof Error ? error.message : String(error)
      const { showNoticeTui } = await import("./notice-tui")
      try {
        await showNoticeTui(route, {
          title: destination ?? "loading",
          message: `couldn't load${destination ? ` ${destination}` : ""}: ${reason}`,
        })
      } catch {
        // The session is going away; the original failure still reports.
      }
    }
    throw error
  } finally {
    transition.stop()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Motion preference for the transition, in precedence order: the
 * CONVOY_REDUCED_MOTION environment variable, the config flag
 * `ui.reducedMotion`, then the OS accessibility probe. "auto" and unset
 * values fall through; an unknown value is never treated as a preference.
 */
export async function defaultReducedMotion(targetDir?: string): Promise<boolean> {
  const env = envReducedMotion()
  if (env !== undefined) return env
  try {
    const { loadGlobalConvoyConfig, loadMergedConvoyConfig } = await import("./config")
    const config = targetDir ? await loadMergedConvoyConfig(targetDir) : await loadGlobalConvoyConfig()
    const mode = config?.ui?.reducedMotion
    if (mode === "on") return true
    if (mode === "off") return false
  } catch {
    // A broken config degrades to the probe rather than blocking the transition.
  }
  return probeReducedMotion()
}

/** Session-level override; undefined means "no opinion". */
export function envReducedMotion(): boolean | undefined {
  const value = process.env.CONVOY_REDUCED_MOTION
  if (value === "1" || value === "true" || value === "on") return true
  if (value === "0" || value === "false" || value === "off") return false
  return undefined
}

/** Bounded wrapper: a slow or failing preference source degrades to "animate". */
async function resolveReducedMotion(options: LoadingTransitionOptions): Promise<boolean> {
  const preference = options.reducedMotion
  const resolved = (async () => {
    try {
      if (preference === undefined) return defaultReducedMotion(options.targetDir)
      if (typeof preference === "function") return await preference()
      return preference
    } catch {
      return false
    }
  })()
  return Promise.race([resolved, delay(motionResolveBoundMs).then(() => false)])
}

let probePromise: Promise<boolean> | undefined

/**
 * The OS reduce-motion accessibility setting, probed once per process and
 * killed after a short bound so it can never stall the transition. Platforms
 * without a probe answer "no preference".
 */
export function probeReducedMotion(): Promise<boolean> {
  probePromise ??= (async () => {
    if (process.platform !== "darwin") return false
    try {
      const proc = Bun.spawn(["defaults", "read", "com.apple.universalaccess", "reduceMotion"], { stdout: "pipe", stderr: "ignore" })
      const killer = setTimeout(() => proc.kill(), motionProbeKillMs)
      const text = await new Response(proc.stdout).text()
      await proc.exited
      clearTimeout(killer)
      return text.trim() === "1"
    } catch {
      return false
    }
  })()
  return probePromise
}

// ── the convoy current (pure model, unit-testable without a renderer) ──────

/**
 * The current's heading: a gentle tilt off horizontal, its unit components.
 * Everything flows along this vector, so the bed reads as a current with a
 * direction rather than an isotropic swirl. {@linkcode fieldSlope} is the
 * heading's rows-per-column, used to keep the convoys riding it.
 */
export const fieldCos = 0.978
export const fieldSin = 0.208
export const fieldSlope = fieldSin / fieldCos

/** Apparent along-flow speed of the current, in grid cells per second. */
export const fieldFlowSpeed = 3.4

/** Cross-flow spatial frequencies: the thin streamlines. */
export const fieldStreamK1 = 1.15
export const fieldStreamK2 = 0.55
/** Along-flow warp frequencies: the long, slow bends of the streams. */
export const fieldWarpK1 = 0.2
export const fieldWarpK2 = 0.13

/** The bed's gain and shaping: it stays a texture beneath the convoys. */
export const fieldBedGain = 0.62
export const fieldBedShape = 1.3
/** The bed never reaches the accent band; accent is reserved for the convoys. */
export const fieldBedCap = 0.78

/**
 * The radial vignette's radii over normalized center distance (0 at the
 * center, 1 at a corner): inside {@linkcode fieldCenterRadius} the field is
 * fully calm, beyond {@linkcode fieldEdgeRadius} it runs at full strength,
 * with a smoothstep in between. The calm pocket sits behind the name; the
 * terminal's edges carry the texture.
 */
export const fieldCenterRadius = 0.3
export const fieldEdgeRadius = 0.92

/**
 * The current at one sample: two crossing streamlines whose phases warp each
 * other and drift along the heading, remapped to [0,1]. Pure, deterministic,
 * branch-free and stateless — a function of position and time alone. Adjacent
 * samples correlate (the warps are continuous), so it reads as flowing water
 * rather than random flicker.
 */
export function fieldValue(x: number, y: number, t: number): number {
  const along = x * fieldCos + y * fieldSin - fieldFlowSpeed * t
  const cross = -x * fieldSin + y * fieldCos
  const v1 = Math.sin(cross * fieldStreamK1 + 1.6 * Math.sin(along * fieldWarpK1 + t * 0.5) + t * 0.6)
  const v2 = Math.sin(cross * fieldStreamK2 - 1.1 * Math.sin(along * fieldWarpK2 - t * 0.4) - t * 0.3)
  return 0.5 + 0.25 * (v1 + v2)
}

export type Convoy = {
  /** Lane as a fraction of the field height (0 = top, 1 = bottom). */
  lane: number
  /** Along-flow speed, in grid cells per second. */
  speed: number
  /** Phase offset, in grid cells. */
  offset: number
  /** The formation's length in cells, from lead to tail. */
  length: number
}

/**
 * The current's convoys: deterministic formations that ride the flow, each a
 * bright lead pulsing down a fading wake. Fixed lanes, speeds and phases — no
 * state — so a resize never strands a formation and a static frame is exact.
 */
export const fieldConvoys: readonly Convoy[] = [
  { lane: 0.06, speed: 6.0, offset: 22, length: 14 },
  { lane: 0.16, speed: 7.6, offset: 0, length: 18 },
  { lane: 0.3, speed: 5.2, offset: 37, length: 15 },
  { lane: 0.7, speed: 6.6, offset: 71, length: 16 },
  { lane: 0.84, speed: 8.4, offset: 12, length: 13 },
  { lane: 0.94, speed: 5.9, offset: 54, length: 12 },
]

/**
 * The lead's x at `now` (ms), in grid cells: the formation enters from the
 * left edge and wraps past the right, so it is always somewhere on the field.
 * Pure.
 */
export function convoyHeadX(convoy: Convoy, cols: number, now: number): number {
  const travel = cols + convoy.length
  const phase = convoy.offset + (now / 1_000) * convoy.speed
  return positiveModulo(phase, travel) - convoy.length
}

/**
 * The formation's brightness at `i` cells behind the lead: a bright head that
 * pulses into a fading wake, so it reads as a line of vehicles rather than a
 * single comet. Pure.
 */
export function convoyWeight(i: number, length: number): number {
  const taper = Math.max(0, 1 - i / length)
  const pulse = 0.45 + 0.55 * (0.5 + 0.5 * Math.cos(i * 2.2))
  return taper * pulse
}

/**
 * Normalized distance from the field's center in [0,1] (0 at the center, 1 at
 * a corner). The sampling grid is roughly physically square (one cell per two
 * columns and one row), so Euclidean distance over grid coordinates is a fair
 * on-screen radius. Degenerate single-cell axes measure from the center.
 */
export function radialDistance(x: number, y: number, cols: number, rows: number): number {
  const nx = cols <= 1 ? 0 : (x / (cols - 1)) * 2 - 1
  const ny = rows <= 1 ? 0 : (y / (rows - 1)) * 2 - 1
  return Math.hypot(nx, ny) / Math.SQRT2
}

/** The radial envelope at one sample in [0,1]: the vignette smoothstep. */
export function vignetteAt(x: number, y: number, cols: number, rows: number): number {
  return smoothstep(fieldCenterRadius, fieldEdgeRadius, radialDistance(x, y, cols, rows))
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus
}

/**
 * The current's bed alone: the shaped streamlines scaled by the radial
 * vignette and capped below the accent band. Pure and deterministic —
 * a function of position and time alone, so a resize never strands state.
 */
export function fieldBedIntensities(cols: number, rows: number, now: number): Float64Array {
  const field = new Float64Array(cols * rows)
  const t = now / 1_000
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const bed = Math.pow(fieldValue(x, y, t), fieldBedShape) * vignetteAt(x, y, cols, rows) * fieldBedGain
      field[y * cols + x] = Math.min(fieldBedCap, bed)
    }
  }
  return field
}

/**
 * Per-cell intensity in [0,1]: the capped current bed plus the convoys riding
 * it. Each formation glides at sub-cell resolution (its lead is split between
 * the two cells it straddles), so motion is smooth rather than stepping column
 * by column, and convoys fade only inside the calm pocket so the centered name
 * stays legible while one passes behind it. Pure and deterministic.
 */
export function fieldIntensities(cols: number, rows: number, now: number): Float64Array {
  const field = fieldBedIntensities(cols, rows, now)
  for (const convoy of fieldConvoys) {
    const lane = Math.round(convoy.lane * (rows - 1))
    const head = convoyHeadX(convoy, cols, now)
    for (let i = 0; i < convoy.length; i++) {
      const position = head - i
      const base = Math.floor(position)
      const fraction = position - base
      // The lead is boosted so it stays the brightest accent even when its
      // position is split across two cells; the wake stays below it.
      const weight = i === 0 ? 1.8 : Math.min(1, convoyWeight(i, convoy.length) * 1.15)
      depositConvoy(field, cols, rows, base, 1 - fraction, lane, head, weight)
      depositConvoy(field, cols, rows, base + 1, fraction, lane, head, weight)
    }
  }
  return field
}

function depositConvoy(
  field: Float64Array,
  cols: number,
  rows: number,
  x: number,
  share: number,
  lane: number,
  head: number,
  weight: number,
): void {
  if (share <= 0 || x < 0 || x >= cols) return
  const y = Math.max(0, Math.min(rows - 1, lane + Math.round(fieldSlope * (x - head))))
  const falloff = smoothstep(fieldCenterRadius, 0.45, radialDistance(x, y, cols, rows))
  if (falloff <= 0) return
  const index = y * cols + x
  field[index] = Math.min(1, field[index]! + weight * share * falloff)
}

export type RampTone = "faint" | "dim" | "accent"

/**
 * The field's quantizer: an ordered density ramp of faint dots, dim marks and
 * accent stars. The current's bed is capped below the accent band, so an accent
 * star is always a convoy — the movement stays the subject. `text` is never
 * used; it stays reserved for foreground UI. Pure.
 */
export function fieldCell(intensity: number): { glyph: string; color: RampTone } | undefined {
  if (intensity >= 0.88) return { glyph: "*", color: "accent" }
  if (intensity >= 0.72) return { glyph: "×", color: "dim" }
  if (intensity >= 0.52) return { glyph: ":", color: "dim" }
  if (intensity >= 0.34) return { glyph: "·", color: "faint" }
  if (intensity >= 0.1) return { glyph: ".", color: "faint" }
  return undefined
}

/**
 * The transition's sampling grid: one sample per two terminal columns and one
 * row (a cell is roughly square on screen), clamped so very large terminals
 * are never sampled per-cell. The painted output covers the full body anyway:
 * {@linkcode paintSpan} stretches each sample's run at paint time, so a clamped
 * grid means lower resolution, never a dead band at the screen's edge.
 */
export function transitionGrid(width: number, height: number): { cols: number; rows: number } {
  return {
    cols: Math.max(1, Math.min(110, Math.ceil(width / 2))),
    rows: Math.max(1, Math.min(60, height)),
  }
}

/**
 * Terminal slots (columns, or rows) that sampled index `i` of `count` paints
 * into `size`: proportional spans that sum to exactly `size`, so the field
 * fills the terminal edge to edge while the evaluated grid stays clamped.
 * `size >= count` keeps every sample painting at least one slot.
 */
export function paintSpan(i: number, count: number, size: number): number {
  return Math.floor(((i + 1) * size) / count) - Math.floor((i * size) / count)
}

// ── the loading name wordmark (pure, renderer-free) ───────────────────────

/**
 * The loading screen's 5-row block alphabet, covering the names it renders
 * (CONVOY, HOME, SPECS, RUNS). A dedicated font, deliberately taller than the
 * masthead's 3-row CONVOY so S/E/R stay legible at terminal cell size, and
 * deliberately separate so the masthead is untouched. Glyph widths vary.
 */
const LOADING_GLYPHS: Readonly<Record<string, readonly string[]>> = {
  C: ["████", "██  ", "██  ", "██  ", "████"],
  O: ["████", "█  █", "█  █", "█  █", "████"],
  N: ["█  █", "██ █", "█ ██", "█  █", "█  █"],
  V: ["█  █", "█  █", "█  █", " ██ ", " ██ "],
  Y: ["█  █", "█  █", "████", " ██ ", " ██ "],
  H: ["█  █", "█  █", "████", "█  █", "█  █"],
  E: ["████", "██  ", "████", "██  ", "████"],
  S: ["████", "██  ", "████", "  ██", "████"],
  U: ["█  █", "█  █", "█  █", "█  █", "████"],
  M: ["█   █", "██ ██", "█ █ █", "█   █", "█   █"],
  P: ["████", "█  █", "████", "█   ", "█   "],
  R: ["████", "█  █", "████", "█ █ ", "█  █"],
}

/** The blank columns between block letters on the loading screen. */
const LOADING_WORDMARK_GAP = "  "

/**
 * The loading name as block-glyph rows, uppercased, or undefined when any
 * letter is absent from {@linkcode LOADING_GLYPHS} — the caller then falls back
 * to plain text rather than drawing a gap. Pure.
 */
export function blockWordmark(name: string): string[] | undefined {
  const glyphs = [...name.toUpperCase()].map((letter) => LOADING_GLYPHS[letter])
  if (glyphs.length === 0 || glyphs.some((glyph) => glyph === undefined)) return undefined
  const rows = glyphs[0]!.map(() => "")
  glyphs.forEach((glyph, index) => {
    for (let row = 0; row < rows.length; row++) {
      rows[row] += (index > 0 ? LOADING_WORDMARK_GAP : "") + glyph![row]!
    }
  })
  return rows
}

/** The painted width of a block wordmark: its widest row. */
export function wordmarkWidth(lines: readonly string[]): number {
  return lines.reduce((width, line) => Math.max(width, line.length), 0)
}

// ── the scene (OpenTUI renderables over the shared session) ────────────────

type LoadingSceneOptions = {
  name?: string
  label?: string
  reducedMotion: boolean
  onInterrupt: () => void
}

/**
 * The mounted transition: a full-screen convoy current with the loading
 * name floating centered over it (both axes) as a block wordmark above the
 * status line. There is no card, border or backdrop — the field's calm center
 * keeps the name legible and lets the field show through. Follows the repo's
 * screen lifecycle — the scene stays painted until the next scene mounts;
 * {@linkcode stop} only detaches listeners and timers.
 */
class LoadingTransition {
  private finished = false
  private readonly t0 = performance.now()
  private readonly ticker: ReturnType<typeof setInterval> | undefined
  private readonly fieldText: TextRenderable
  private readonly wordmarkText: TextRenderable
  private readonly statusText: TextRenderable
  private readonly blockLines: string[] | undefined

  constructor(
    private readonly renderer: CliRenderer,
    private readonly scene: TuiScene,
    private readonly options: LoadingSceneOptions,
  ) {
    const shell = new BoxRenderable(renderer, {
      id: "convoy-loading-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
    })
    const fieldBox = new BoxRenderable(renderer, { id: "convoy-loading-field", width: "100%", height: "100%" })
    this.fieldText = new TextRenderable(renderer, { content: "", width: "100%", height: "100%" })
    fieldBox.add(this.fieldText)

    // The name wordmark, decided once per mount: undefined when the block
    // alphabet lacks a letter or the name is wider than the terminal, in which
    // case the plain uppercase fallback carries it. There is no card, border or
    // backdrop — the field's calm center keeps the text legible and visible.
    const block = blockWordmark(this.name)
    this.blockLines = block && wordmarkWidth(block) <= renderer.width - 4 ? block : undefined
    const overlay = new BoxRenderable(renderer, {
      id: "convoy-loading-overlay",
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: 10,
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "column",
    })
    overlay.gap = 1
    this.wordmarkText = new TextRenderable(renderer, { content: "" })
    this.statusText = new TextRenderable(renderer, { content: "" })
    overlay.add(this.wordmarkText)
    overlay.add(this.statusText)
    shell.add(fieldBox)
    shell.add(overlay)
    scene.root.add(shell)
    this.applyChrome()

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("theme_mode", this.handleThemeMode)
    // Reduced motion renders one developed static frame — informative, no motion.
    if (!options.reducedMotion) this.ticker = setInterval(this.tick, frameIntervalMs)
    this.render(this.t0)
  }

  /** The loading name, defaulting to a generic "destination" when unspecified. */
  private get name(): string {
    return this.options.name ?? "destination"
  }

  /** The name wordmark and status follow the live theme. */
  private applyChrome(): void {
    this.wordmarkText.content = this.wordmarkContent()
    // The status names the destination only when the wordmark does not already:
    // "loading specs…" under a SPECS wordmark is redundant, but Home's wordmark
    // is CONVOY, so "loading home…" still adds information.
    const destination = this.options.label ?? this.name
    const status =
      destination.toUpperCase() === this.name.toUpperCase() ? "loading…" : `loading ${destination.toLowerCase()}…`
    this.statusText.content = new StyledText([fg(theme.dim)(status)])
  }

  /** The loading name in block glyphs, or plain uppercase when the block form isn't available. */
  private wordmarkContent(): StyledText {
    if (!this.blockLines) return new StyledText([bold(fg(theme.accent)(this.name.toUpperCase()))])
    return joinLines(this.blockLines.map((line) => new StyledText([bold(fg(theme.accent)(line))])))
  }

  private readonly handleKeyPress = (key: KeyEvent) => {
    const ctrlC = (key.ctrl && key.name === "c") || key.raw === "\u0003"
    if (!ctrlC) return
    key.preventDefault()
    key.stopPropagation()
    this.stop()
    // Flags the home session's interrupt (the route's handler), then tells the
    // helper to abandon the pending load.
    this.scene.requestInterrupt()
    this.options.onInterrupt()
  }

  private readonly handleThemeMode = (mode: unknown) => {
    if (mode !== "dark" && mode !== "light") return
    setTheme(paletteForTerminal(mode, terminalBackgroundHex(this.renderer)))
    this.applyChrome()
    this.render(performance.now())
  }

  private readonly tick = () => {
    const now = performance.now()
    if (this.finished || this.scene.isClosed || this.renderer.isDestroyed) {
      this.stop()
      return
    }
    this.render(now)
  }

  /** Detaches from the renderer; idempotent, safe to call from every exit path. */
  stop(): void {
    if (this.finished) return
    this.finished = true
    if (this.ticker) clearInterval(this.ticker)
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.off("theme_mode", this.handleThemeMode)
  }

  private render(now: number): void {
    if (this.finished || this.scene.isClosed || this.renderer.isDestroyed) return
    const width = this.renderer.width
    // The name floats as an overlay, so the field fills the whole terminal.
    const bodyHeight = Math.max(1, this.renderer.height)
    const { cols, rows } = transitionGrid(width, bodyHeight)
    this.fieldText.content = joinLines(this.fieldRows(cols, rows, fieldIntensities(cols, rows, now), width, bodyHeight))
    this.renderer.requestRender()
  }

  /**
   * One terminal row per body row: each sampled grid row paints every body row
   * its {@linkcode paintSpan} owns and each cell stretches across its column
   * span, so the clamped grid still covers the screen edge to edge. The field
   * is quantized with the transition's own density ramp.
   */
  private fieldRows(cols: number, rows: number, intensities: Float64Array, width: number, bodyHeight: number): StyledText[] {
    const lines: StyledText[] = []
    for (let y = 0; y < rows; y++) {
      const line = fieldRow(cols, intensities, y * cols, width, fieldCell)
      const span = paintSpan(y, rows, bodyHeight)
      for (let r = 0; r < span; r++) lines.push(line)
    }
    return lines
  }
}

/**
 * One painted field row: the row's cells quantized by `cell` (the field's own
 * density ramp by default), each cell's glyph repeated across its proportional
 * column span so the runs fill exactly `width` columns. Pure and renderer-free,
 * like the field model.
 */
export function fieldRow(
  cols: number,
  intensities: Float64Array,
  offset: number,
  width: number,
  cell: (intensity: number) => { glyph: string; color: RampTone } | undefined = fieldCell,
): StyledText {
  const chunks: TextChunk[] = []
  let run = ""
  let runColor: RampTone | undefined
  const flush = () => {
    if (!run) return
    chunks.push(runColor ? fg(theme[runColor])(run) : raw(run))
    run = ""
  }
  for (let x = 0; x < cols; x++) {
    const painted = cell(intensities[offset + x]!)
    const color = painted?.color
    const text = (painted?.glyph ?? " ").repeat(paintSpan(x, cols, width))
    if (color === runColor) {
      run += text
      continue
    }
    flush()
    runColor = color
    run = text
  }
  flush()
  return new StyledText(chunks.length > 0 ? chunks : [raw("")])
}
