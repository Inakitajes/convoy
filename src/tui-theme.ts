import { StyledText, bold, fg, stringToStyledText, t } from "@opentui/core"

import type { CliRenderer, TextChunk } from "@opentui/core"
import type { LimitsSnapshot } from "./limits"

// Backgrounds are never painted: the whole canvas is the terminal's own
// background, and panels are delineated by borders alone. The single
// exception is `overlay`, the opaque backdrop floating modals need to mask
// the content underneath them.
export type Palette = {
  bg: string
  overlay: string
  border: string
  borderDim: string
  accent: string
  teal: string
  green: string
  red: string
  yellow: string
  orange: string
  magenta: string
  cyan: string
  text: string
  dim: string
  faint: string
  /** Text drawn on top of colored chips (selected permission buttons). */
  chipText: string
}

export type PaletteColor = Exclude<keyof Palette, "chipText">

const darkPalette: Palette = {
  bg: "transparent",
  overlay: "#0A0E1A",
  border: "#26324B",
  borderDim: "#1B2438",
  accent: "#7AA2F7",
  teal: "#73DACA",
  green: "#9ECE6A",
  red: "#F7768E",
  yellow: "#E0AF68",
  orange: "#FF9E64",
  magenta: "#BB9AF7",
  cyan: "#7DCFFF",
  text: "#C0CAF5",
  dim: "#565F89",
  faint: "#3B4261",
  chipText: "#0A0E1A",
}

const lightPalette: Palette = {
  bg: "transparent",
  overlay: "#E1E2E7",
  border: "#A8AECB",
  borderDim: "#C1C6DD",
  accent: "#2E7DE9",
  teal: "#118C74",
  green: "#587539",
  red: "#F52A65",
  yellow: "#8C6C3E",
  orange: "#B15C00",
  magenta: "#7847BD",
  cyan: "#007197",
  text: "#343B58",
  dim: "#6172B0",
  faint: "#9DA3C2",
  chipText: "#E1E2E7",
}

// When the terminal never answers the background query there is nothing safe
// to paint, so even modals stay transparent and mid-brightness colors keep
// the text readable on dark and light.
const neutralPalette: Palette = {
  bg: "transparent",
  overlay: "transparent",
  border: "#808080",
  borderDim: "#6E6E6E",
  accent: "#4F9CF9",
  teal: "#27AE9D",
  green: "#6FAE4F",
  red: "#E0606C",
  yellow: "#B59B3A",
  orange: "#CE8633",
  magenta: "#A985D6",
  cyan: "#3FA7C4",
  text: "#9E9E9E",
  dim: "#7A7A7A",
  faint: "#616161",
  chipText: "#000000",
}

// Module-level on purpose: one TUI exists per archer process, and a mutable
// palette spares threading it through every render helper.
export let theme: Palette = darkPalette

export function setTheme(palette: Palette) {
  theme = palette
}

export function paletteForMode(mode: "dark" | "light" | null | undefined): Palette {
  if (mode === "light") return lightPalette
  if (mode === "dark") return darkPalette
  return neutralPalette
}

/**
 * Palette tuned to the terminal's own background: borders are subtle
 * elevations of it and modals repaint it exactly, so nothing reads as a
 * foreign skin. Accents still come from the static palettes (picked by the
 * background's brightness, which is the same inference opentui uses for the
 * mode). Without a reported background this falls back to paletteForMode.
 */
export function paletteForTerminal(mode: "dark" | "light" | null | undefined, backgroundHex?: string): Palette {
  const rgb = backgroundHex ? parseHex(backgroundHex) : undefined
  if (!rgb) return paletteForMode(mode)
  const isDark = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 <= 128
  const pole: Rgb = isDark ? [255, 255, 255] : [0, 0, 0]
  return {
    ...(isDark ? darkPalette : lightPalette),
    // The reported color, not transparent: a modal must mask what's beneath
    // it, and repainting the terminal's own background makes that invisible.
    overlay: backgroundHex!,
    borderDim: mixToward(rgb, pole, 0.16),
    border: mixToward(rgb, pole, 0.26),
    chipText: backgroundHex!,
  }
}

/**
 * The background the terminal reported via OSC 11, if any. Reaches into
 * opentui internals (RendererThemeMode keeps the raw color private to its
 * dark/light inference); the dependency is pinned, and any shape change just
 * degrades to the static palettes.
 */
export function terminalBackgroundHex(renderer: CliRenderer): string | undefined {
  const state = (renderer as unknown as { themeModeState?: { themeOscBackground?: unknown } }).themeModeState
  const hex = state?.themeOscBackground
  return typeof hex === "string" && parseHex(hex) ? hex : undefined
}

type Rgb = [number, number, number]

function parseHex(hex: string): Rgb | undefined {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!match) return undefined
  const value = Number.parseInt(match[1]!, 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

function mixToward(rgb: Rgb, pole: Rgb, amount: number): string {
  const hex = (index: number) =>
    Math.round(rgb[index]! + (pole[index]! - rgb[index]!) * amount)
      .toString(16)
      .padStart(2, "0")
  return `#${hex(0)}${hex(1)}${hex(2)}`
}

export type PhaseStatus = "pending" | "running" | "completed" | "skipped" | "failed"

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export function spinnerFrame(now: number) {
  return spinnerFrames[Math.floor(now / 100) % spinnerFrames.length]!
}

export function statusIcon(status: PhaseStatus, now: number): TextChunk {
  switch (status) {
    case "completed":
      return fg(theme.green)("✓")
    case "running":
      return fg(theme.accent)(spinnerFrame(now))
    case "failed":
      return fg(theme.red)("✗")
    case "skipped":
      return fg(theme.faint)("⊘")
    default:
      return fg(theme.faint)("○")
  }
}

export function joinLines(lines: StyledText[]): StyledText {
  const chunks: TextChunk[] = []
  lines.forEach((line, index) => {
    if (index > 0) chunks.push(raw("\n"))
    chunks.push(...line.chunks)
  })
  return new StyledText(chunks)
}

export function plain(text: string): StyledText {
  return stringToStyledText(text)
}

export function raw(text: string): TextChunk {
  return stringToStyledText(text).chunks[0] ?? fg(theme.text)(text)
}

export function padBetween(left: TextChunk[], right: TextChunk[], width: number): StyledText {
  const gap = Math.max(1, width - chunksLength(left) - chunksLength(right))
  if (right.length === 0) return new StyledText(left)
  return new StyledText([...left, raw(" ".repeat(gap)), ...right])
}

function chunksLength(chunks: TextChunk[]) {
  return chunks.reduce((sum, chunk) => sum + displayWidth(chunk.text), 0)
}

// East-Asian wide chars and emoji take two terminal cells; counting UTF-16
// units would push the right-aligned columns out of the panel.
export function displayWidth(text: string) {
  return Bun.stringWidth(text)
}

// Block elements render single-width in every terminal font, and the
// full-cell blocks read as one solid strip instead of a thin stroke.
export function progressBar(fraction: number, width: number, color: string): TextChunk[] {
  const cells = Math.max(0, Math.min(1, fraction)) * width
  const filled = Math.floor(cells)
  const head = filled < width && cells - filled >= 0.5
  const track = width - filled - (head ? 1 : 0)
  const chunks: TextChunk[] = []
  if (filled > 0) chunks.push(fg(color)("█".repeat(filled)))
  if (head) chunks.push(fg(color)("▌"))
  if (track > 0) chunks.push(fg(theme.faint)("░".repeat(track)))
  return chunks
}

export function formatMoney(cost: number) {
  return `$${cost.toFixed(cost >= 1 ? 2 : 4)}`
}

export function formatCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

export function formatElapsed(ms: number) {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

export function formatAgo(ms: number) {
  const seconds = Math.floor(ms / 1000)
  if (seconds <= 1) return "now"
  if (seconds < 60) return `${seconds}s ago`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`
}

/** "2d 3h" / "2h 10m" / "12m" — countdown until a quota window resets. */
export function fmtCountdown(resetsAt: number, now: number) {
  const totalMinutes = Math.max(0, Math.floor((resetsAt - now) / 60_000))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function formatTime(time: number) {
  return new Date(time).toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

/**
 * Header row shared by every archer TUI: the GPT subscription meter (5h
 * session as a bar, weekly as text) on the left, the OpenRouter credit
 * balance on the right. Account-level data, so it reads the same everywhere.
 */
export function limitsRow(limits: LimitsSnapshot | undefined, now: number, width: number): StyledText {
  const right: TextChunk[] = []
  const openrouter = limits?.openrouter
  if (openrouter) {
    right.push(
      fg(theme.dim)("OpenRouter "),
      fg(theme.text)(openrouter.kind === "remaining" ? `${formatMoney(openrouter.amount)} left` : `${formatMoney(openrouter.amount)}/mo`),
    )
  }

  const gpt = limits?.gpt
  if (!gpt) {
    // Never an empty line: a placeholder keeps the row's cell real while the
    // first poll is in flight (and an all-empty trailing line would let the
    // text layout collapse to a single row).
    const left: TextChunk[] = limits?.gptHint ? [fg(theme.faint)(`GPT — ${limits.gptHint}`)] : [fg(theme.faint)("…")]
    return padBetween(left, right, width)
  }

  const pct = Math.round(gpt.sessionPct)
  const barColor = pct >= 85 ? theme.red : pct >= 60 ? theme.yellow : theme.accent
  const pctChunk = fg(pct >= 60 ? barColor : theme.text)(`${pct}%`)
  const sep = fg(theme.faint)(" · ")
  const bar = (cells: number): TextChunk[] => [fg(theme.dim)("GPT "), ...progressBar(pct / 100, cells, barColor), raw(" "), pctChunk]
  const resets = gpt.sessionResetsAt === undefined ? [] : [sep, fg(theme.dim)(`resets ${fmtCountdown(gpt.sessionResetsAt, now)}`)]
  const weekly =
    gpt.weeklyPct === undefined
      ? []
      : (() => {
          const wk = Math.round(gpt.weeklyPct)
          return [sep, fg(wk >= 85 ? theme.red : wk >= 60 ? theme.yellow : theme.dim)(`wk ${wk}%`)]
        })()

  // Drop detail before precision when narrow: first the weekly text, then the
  // reset countdown, then the bar shrinks and finally disappears.
  const candidates: TextChunk[][] = [
    [...bar(10), ...resets, ...weekly],
    [...bar(10), ...resets],
    bar(10),
    bar(6),
    [fg(theme.dim)("GPT "), pctChunk],
  ]
  const rightLen = chunksLength(right)
  const fits = (chunks: TextChunk[]) => chunksLength(chunks) + (rightLen > 0 ? rightLen + 1 : 0) <= width
  return padBetween(candidates.find(fits) ?? candidates[candidates.length - 1]!, right, width)
}

export function shortID(value: string) {
  if (value.length <= 12) return value
  return `${value.slice(0, 7)}…${value.slice(-4)}`
}

export function shortUrl(value: string) {
  return value.replace(/^https?:\/\//, "")
}

export function projectName(dir: string) {
  if (!dir) return "…"
  const parts = dir.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? dir
}

/** Full path with the home prefix as ~, truncated from the left so the deepest segments stay readable. */
export function shortPath(dir: string, max: number) {
  if (!dir) return "…"
  const home = process.env.HOME
  const path = home && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir
  if (path.length <= max) return path
  return `…${path.slice(-Math.max(1, max - 1))}`
}

export function truncate(value: string, max: number) {
  const singleLine = value.replace(/\s+/g, " ").trim()
  if (displayWidth(singleLine) <= max) return singleLine
  if (max <= 0) return ""
  if (max === 1) return "…"
  return `${takeDisplayCells(singleLine, max - 1).head}…`
}

// Markdown stays unrendered on purpose; headings get the accent so long
// summaries are scannable without pulling in a parser.
export function styleSummaryLine(line: string): StyledText {
  if (/^#{1,6}\s/.test(line)) return t`${bold(fg(theme.accent)(line))}`
  if (/^(```|---+$)/.test(line.trim())) return t`${fg(theme.faint)(line)}`
  if (/^\s*([-*+]|\d+\.)\s/.test(line)) return new StyledText([fg(theme.teal)(line.match(/^\s*/)![0] + "• "), raw(line.replace(/^\s*([-*+]|\d+\.)\s/, ""))])
  return plain(line)
}

export function wrapLines(lines: string[], width: number): string[] {
  const wrapped: string[] = []
  for (const line of lines) {
    if (width <= 0) {
      wrapped.push("")
      continue
    }
    if (displayWidth(line) <= width) {
      wrapped.push(line)
      continue
    }
    let rest = line
    while (rest && displayWidth(rest) > width) {
      const part = takeDisplayCells(rest, width)
      // Widths used by the TUI are always >= 2. This fallback prevents an
      // infinite loop if a caller asks a one-cell column to hold a wide glyph.
      if (!part.head) {
        const first = [...graphemes.segment(rest)][0]?.segment ?? ""
        wrapped.push(first)
        rest = rest.slice(first.length)
      } else {
        wrapped.push(part.head)
        rest = part.tail
      }
    }
    if (rest) wrapped.push(rest)
  }
  return wrapped
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function takeDisplayCells(text: string, max: number): { head: string; tail: string } {
  let head = ""
  let cells = 0
  let consumed = 0
  for (const part of graphemes.segment(text)) {
    const width = displayWidth(part.segment)
    if (cells + width > max) break
    head += part.segment
    cells += width
    consumed = part.index + part.segment.length
  }
  return { head, tail: text.slice(consumed) }
}
