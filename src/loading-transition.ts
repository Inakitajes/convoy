import { BoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core"

import { joinLines, paletteForTerminal, raw, setTheme, terminalBackgroundHex, theme } from "./tui-theme"
import { CONVOY_LETTERS, CONVOY_WORDMARK, CONVOY_WORDMARK_WIDTH, WORDMARK_GAP } from "./home-tui"
import { sceneForRoute, type TuiRoute, type TuiScene } from "./tui-session"

import type { CliRenderer, KeyEvent, TextChunk } from "@opentui/core"

/**
 * The shared loading transition of the home session: while a destination load
 * outlasts a short threshold, a scene of a dimmed breathing sea of characters
 * behind a centered CONVOY card replaces the frozen home frame, and the
 * destination's own scene mount paints over it atomically (the same contract
 * every home-session screen already uses — scenes close only when the next one
 * mounts). Rejected or interrupted loads never leave a dead screen, and loads
 * that finish quickly never flash it.
 *
 * OpenTUI is imported eagerly by this module, so it is only ever loaded on
 * interactive paths (specs.ts dynamic-imports it under `route`).
 */

/** Quiet period before a slow load earns the transition (no flash on fast loads). */
export const loadingThresholdMs = 150

/**
 * The transition's paint pull: the model field is dimmed by this factor
 * before quantization, so every painted tone sits one notch under the shared
 * ramp's brightness. Paired with {@linkcode seaCell}'s compressed thresholds
 * it keeps the sea's full structure — blank troughs, dot bodies, colon crests
 * — while nothing ever reaches the shared ramp's bright text tone.
 */
export const seaDimFactor = 0.85

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
}

/**
 * Runs `load`, showing the breathing-sea transition on the route's session only when
 * the load genuinely outlasts the threshold. Without a route (non-interactive
 * and piped invocations) the load runs unchanged. Every settlement path leaves
 * the session healthy: the transition stops animating as soon as the load
 * settles, and the destination's own scene mount replaces it in place.
 */
export async function withLoadingTransition<T>(
  route: TuiRoute | undefined,
  label: string | undefined,
  load: () => Promise<T>,
  options: LoadingTransitionOptions = {},
): Promise<T> {
  if (!route) return load()

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
    ...(label === undefined ? {} : { label }),
    reducedMotion: resolved.reducedMotion,
    onInterrupt: () =>
      rejectInterrupt(new LoadingInterruptedError(label === undefined ? "interrupted while loading" : `interrupted while loading ${label}`)),
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
          title: label ?? "loading",
          message: `couldn't load${label ? ` ${label}` : ""}: ${reason}`,
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

// ── the breathing sea (pure model, unit-testable without a renderer) ───────

/**
 * One traveling swell of the sea: a plane wave with spatial frequencies
 * `kx`/`ky` (radians per grid cell) that carries its crests at `speed` grid
 * cells per second along its own wave vector, weighted within the combined sea.
 */
export type Swell = {
  kx: number
  ky: number
  speed: number
  weight: number
}

/** Slow global pulse: the whole sea brightens and dims in place (breathing). */
export const breathPeriodMs = 4_000
/** Brightness floor of the breath, so the field never goes fully dark. */
export const breathFloor = 0.5

/**
 * The sea's swells: two crossed plane waves whose interference reads as an
 * undulating surface, deliberately incommensurable wavelengths so the pattern
 * never visibly repeats. Waves travel; nothing expands outward from a point —
 * the motion is swell and breath, not rings.
 */
export const seaSwells: readonly Swell[] = [
  { kx: (2 * Math.PI) / 16, ky: (2 * Math.PI) / 34, speed: 3.5, weight: 0.62 },
  { kx: (2 * Math.PI) / 29, ky: -(2 * Math.PI) / 21, speed: 2.5, weight: 0.38 },
]

/** The breath envelope in [breathFloor, 1]: a full sine over one period. */
export function breathAmplitude(now: number): number {
  return breathFloor + ((1 - breathFloor) / 2) * (1 + Math.sin((2 * Math.PI * now) / breathPeriodMs))
}

/**
 * Per-cell brightness in [0,1]: the combined swell of the sea, scaled by the
 * breathing envelope. Pure and deterministic — a function of position and time
 * alone, so tests can pin the field and a resize never strands state.
 */
export function seaIntensities(cols: number, rows: number, now: number): Float64Array {
  const field = new Float64Array(cols * rows)
  const breath = breathAmplitude(now)
  const tSec = now / 1_000
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let wave = 0
      for (const swell of seaSwells) {
        // ω = |k|·speed keeps the crest speed honest along the wave vector.
        const k = Math.hypot(swell.kx, swell.ky)
        wave += swell.weight * Math.sin(swell.kx * x + swell.ky * y - k * swell.speed * tSec)
      }
      const index = y * cols + x
      field[index] = Math.min(1, Math.max(0, (0.5 + 0.5 * wave) * breath))
    }
  }
  return field
}

/**
 * The painted sea's brightness: the model field scaled by
 * {@linkcode seaDimFactor} and clamped — a mild, order-preserving pull that
 * drops every tone one notch toward transparency without collapsing any of
 * them away. Pure — a function of the field alone.
 */
export function dimmedSea(intensities: Float64Array, factor: number = seaDimFactor): Float64Array {
  const dimmed = new Float64Array(intensities.length)
  for (let index = 0; index < intensities.length; index += 1) {
    dimmed[index] = Math.min(1, Math.max(0, intensities[index]! * factor))
  }
  return dimmed
}

export type RampTone = "faint" | "dim" | "text"

/**
 * Brightness quantized onto the theme's faint → dim → text ramp; undefined
 * cells stay blank. Swell crests read bright, troughs fade to faint.
 */
export function intensityCell(intensity: number): { glyph: string; color: RampTone } | undefined {
  if (intensity >= 0.82) return { glyph: "·", color: "text" }
  if (intensity >= 0.55) return { glyph: ":", color: "dim" }
  if (intensity >= 0.28) return { glyph: "·", color: "dim" }
  if (intensity >= 0.08) return { glyph: "·", color: "faint" }
  return undefined
}

/**
 * The transition's own quantizer: the sea's full range stays spread across
 * the quiet tones — blank troughs, faint dots, dim dots, and colon crests —
 * so the traveling swells keep their contrast *pattern* (that is what reads
 * as waves) while the tones themselves sit closer together and none ever
 * reaches the shared ramp's bright text tone. Thresholds tuned so the painted
 * distribution mirrors the shared ramp's, one notch more transparent.
 */
export function seaCell(intensity: number): { glyph: string; color: RampTone } | undefined {
  if (intensity >= 0.5) return { glyph: ":", color: "dim" }
  if (intensity >= 0.25) return { glyph: "·", color: "dim" }
  if (intensity >= 0.05) return { glyph: "·", color: "faint" }
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

// ── the scene (OpenTUI renderables over the shared session) ────────────────

type LoadingSceneOptions = {
  label?: string
  reducedMotion: boolean
  onInterrupt: () => void
}

/**
 * The mounted transition: a full-screen dimmed breathing sea with a solid,
 * rounded card floating centered over it (both axes, like the repo's other
 * overlays). The card carries the home masthead's CONVOY wordmark over the
 * loading status — an empty, quiet rectangle with generous padding, so the
 * waves stay texture and the text stays legible. Follows the repo's screen
 * lifecycle — the scene stays painted until the next scene mounts;
 * {@linkcode stop} only detaches listeners and timers.
 */
class LoadingTransition {
  private finished = false
  private readonly t0 = performance.now()
  private readonly ticker: ReturnType<typeof setInterval> | undefined
  private readonly fieldText: TextRenderable
  private readonly wordmarkText: TextRenderable
  private readonly statusText: TextRenderable
  private readonly card: BoxRenderable
  private readonly wide: boolean

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
    // The centered card: a quiet, solid rectangle over the dimmed sea. The
    // same centered-overlay pattern the config modal and notice screens use.
    this.wide = renderer.width >= CONVOY_WORDMARK_WIDTH + 8
    // Padding shrinks before the content does; the card stays roomy on normal
    // terminals and merely snug on small ones.
    const paddingX = Math.max(2, Math.min(8, Math.floor((renderer.width - (this.wide ? CONVOY_WORDMARK_WIDTH : 8)) / 4)))
    const paddingY = Math.max(1, Math.min(3, Math.floor((renderer.height - 9) / 4)))
    const cardOverlay = new BoxRenderable(renderer, {
      id: "convoy-loading-card-overlay",
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: 10,
      alignItems: "center",
      justifyContent: "center",
    })
    this.card = new BoxRenderable(renderer, {
      id: "convoy-loading-card",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      backgroundColor: theme.overlay,
      paddingX,
      paddingY,
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "column",
    })
    this.card.gap = 2
    this.wordmarkText = new TextRenderable(renderer, { content: "" })
    this.statusText = new TextRenderable(renderer, { content: "" })
    this.card.add(this.wordmarkText)
    this.card.add(this.statusText)
    cardOverlay.add(this.card)
    shell.add(fieldBox)
    shell.add(cardOverlay)
    scene.root.add(shell)
    this.applyChrome()

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("theme_mode", this.handleThemeMode)
    // Reduced motion renders one developed static frame — informative, no motion.
    if (!options.reducedMotion) this.ticker = setInterval(this.tick, frameIntervalMs)
    this.render(this.t0)
  }

  /** The card's chrome (border, backdrop, wordmark, status) follows the live theme. */
  private applyChrome(): void {
    this.card.borderColor = theme.border
    this.card.backgroundColor = theme.overlay
    this.wordmarkText.content = this.wordmarkContent()
    this.statusText.content = new StyledText([fg(theme.dim)(`loading ${this.options.label ?? "destination"}…`)])
  }

  /** The home masthead's CONVOY wordmark, centered; the text form on narrow terminals. */
  private wordmarkContent(): StyledText {
    if (!this.wide) return new StyledText([bold(fg(theme.accent)("CONVOY"))])
    const lines = [0, 1, 2].map((glyphRow) => {
      const chunks: TextChunk[] = []
      CONVOY_LETTERS.forEach((letter, index) => {
        if (index > 0) chunks.push(raw(WORDMARK_GAP))
        chunks.push(bold(fg(theme.accent)(CONVOY_WORDMARK[letter]![glyphRow]!)))
      })
      return new StyledText(chunks)
    })
    return joinLines(lines)
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
    // The card floats as an overlay, so the dimmed sea fills the whole terminal.
    const bodyHeight = Math.max(1, this.renderer.height)
    const { cols, rows } = transitionGrid(width, bodyHeight)
    this.fieldText.content = joinLines(
      this.fieldRows(cols, rows, dimmedSea(seaIntensities(cols, rows, now)), width, bodyHeight),
    )
    this.renderer.requestRender()
  }

  /**
   * One terminal row per body row: each sampled grid row paints every body row
   * its {@linkcode paintSpan} owns and each cell stretches across its column
   * span, so the clamped grid still covers the screen edge to edge. The sea is
   * dimmed and quantized with the transition's own compressed ramp — the
   * wave's structure intact, every tone one notch more transparent.
   */
  private fieldRows(cols: number, rows: number, intensities: Float64Array, width: number, bodyHeight: number): StyledText[] {
    const lines: StyledText[] = []
    for (let y = 0; y < rows; y++) {
      const line = seaRow(cols, intensities, y * cols, width, seaCell)
      const span = paintSpan(y, rows, bodyHeight)
      for (let r = 0; r < span; r++) lines.push(line)
    }
    return lines
  }
}

/**
 * One painted field row: the row's cells quantized by `cell` (the shared ramp
 * by default; the transition paints with {@linkcode seaCell}), each cell's
 * glyph repeated across its proportional column span so the runs fill exactly
 * `width` columns. Pure and renderer-free, like the sea model.
 */
export function seaRow(
  cols: number,
  intensities: Float64Array,
  offset: number,
  width: number,
  cell: (intensity: number) => { glyph: string; color: RampTone } | undefined = intensityCell,
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
