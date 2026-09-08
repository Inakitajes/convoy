import { StyledText, bold, fg, stringToStyledText } from "@opentui/core"

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
  /** A true navy blue — action markers and their rails, distinct from the state colors. */
  navy: string
  /** The input well: a quiet near-black gray surface behind writable text, never a state color. */
  well: string
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
  navy: "#3D59A1",
  well: "#16161E",
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
  navy: "#2B4C9B",
  well: "#DFE1EB",
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
  navy: "#3A5FBF",
  well: "#3D3D3D",
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

// Module-level on purpose: one TUI exists per convoy process, and a mutable
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
 * Palette tuned to the terminal's own background: only the modal overlay and
 * chip text follow the reported background, so modals mask what's beneath
 * them and never read as a foreign skin. Borders stay on the static palette:
 * deriving them from the reported background turned the designed border colors
 * into neutral grays under multiplexers that answer the background query with
 * their own host theme instead of the real terminal. Accents still come from
 * the static palettes (picked by the background's brightness, which is the
 * same inference opentui uses for the mode). Without a reported background
 * this falls back to paletteForMode.
 */
export function paletteForTerminal(mode: "dark" | "light" | null | undefined, backgroundHex?: string): Palette {
  const rgb = backgroundHex ? parseHex(backgroundHex) : undefined
  if (!rgb) return paletteForMode(mode)
  const isDark = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 <= 128
  return {
    ...(isDark ? darkPalette : lightPalette),
    // The reported color, not transparent: a modal must mask what's beneath
    // it, and repainting the terminal's own background makes that invisible.
    overlay: backgroundHex!,
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

// The run-shape sections — steps, goal, openspec, hooks — are the rows an
// operator scans a setup or preview panel for, so their labels render
// accent-bold instead of the faint metadata labels beside them. A chunk (not a
// StyledText) so free rows and padded label columns can both embed it.
export function sectionLabel(label: string): TextChunk {
  return bold(fg(theme.accent)(label))
}

export function padBetween(left: TextChunk[], right: TextChunk[], width: number): StyledText {
  if (right.length === 0) return new StyledText(left)
  // The right side clips (with an ellipsis) when both sides can't share the
  // width; otherwise the line would exceed `width` and the panel border would
  // chop the right side mid-value.
  const fitted = clipChunks(right, width - chunksLength(left) - 1)
  if (fitted.length === 0) return new StyledText(left)
  const gap = Math.max(1, width - chunksLength(left) - chunksLength(fitted))
  return new StyledText([...left, raw(" ".repeat(gap)), ...fitted])
}

// Keeps chunks from the start until `max` columns are filled; the chunk at the
// cut keeps its own style and ends in the ellipsis.
export function clipChunks(chunks: TextChunk[], max: number): TextChunk[] {
  if (chunksLength(chunks) <= max) return chunks
  if (max <= 0) return []
  const out: TextChunk[] = []
  let budget = max
  for (const chunk of chunks) {
    const width = displayWidth(chunk.text)
    if (width < budget) {
      out.push(chunk)
      budget -= width
      continue
    }
    out.push({ ...chunk, text: `${takeDisplayCells(chunk.text, budget - 1).head}…` })
    break
  }
  return out
}

export function chunksLength(chunks: readonly TextChunk[]) {
  return chunks.reduce((sum, chunk) => sum + displayWidth(chunk.text), 0)
}

// East-Asian wide chars and emoji take two terminal cells; counting UTF-16
// units would push the right-aligned columns out of the panel.
export function displayWidth(text: string) {
  return Bun.stringWidth(text)
}

/** `[esc] back` · `esc back` · `q`+`uit` — the three shapes footers already use. */
export type HintStyle = "bracket" | "spaced" | "glued"

export type HintTone = "accent" | "yellow" | "dim"

/**
 * One keyboard hint in a footer row. `priority` decides the order of sacrifice
 * when the row is too narrow for all of them: 0 is pinned and never leaves,
 * larger numbers leave first.
 */
export type Hint = {
  keys: string
  label: string
  priority: number
  tone?: HintTone
  style?: HintStyle
  /** Replaces the dim label when it carries its own colors (a live status). */
  labelChunks?: TextChunk[]
}

/**
 * The trailing hint that survives every drop, so a shortened row always says
 * where the rest went instead of just ending mid-sentence against the border.
 * A footer backed by a command palette keeps it visible at all times and only
 * changes its wording; one without a palette omits `label` so a bare count
 * appears when — and only when — something has actually been dropped.
 */
export type OverflowHint = Omit<Hint, "label"> & {
  label?: string
  moreLabel: string | ((dropped: number) => string)
}

/**
 * The overflow marker for footers with no command palette behind them: a dim
 * count that shows up only once hints have actually been dropped, so the row
 * admits there is more without pointing at a screen that doesn't exist.
 */
export const moreHintsMarker: OverflowHint = {
  keys: "+",
  moreLabel: (dropped) => String(dropped),
  priority: 0,
  tone: "dim",
  style: "glued",
}

/**
 * A footer row that degrades instead of being chopped off by the panel border.
 * Footers are one unwrapped line in a fixed-height box, so the only honest
 * response to a narrow terminal is to drop hints — lowest priority first — and
 * say so. `rightCandidates` is the same ladder `limitsRow` uses: ordered
 * longest to shortest, first one that fits wins, so the right side loses detail
 * before the keys on the left do.
 */
export function hintsRow(
  hints: Hint[],
  rightCandidates: TextChunk[][],
  width: number,
  options: { style?: HintStyle; overflow?: OverflowHint; prefix?: TextChunk[] } = {},
): StyledText {
  const style = options.style ?? "bracket"
  const prefix = options.prefix ?? []
  const overflow = options.overflow

  const tailFor = (dropped: number): Hint[] => {
    if (!overflow) return []
    if (dropped > 0) {
      return [{ ...overflow, label: typeof overflow.moreLabel === "function" ? overflow.moreLabel(dropped) : overflow.moreLabel }]
    }
    return overflow.label === undefined ? [] : [{ ...overflow, label: overflow.label }]
  }
  const compose = (list: Hint[], dropped: number): TextChunk[] => [...prefix, ...renderHints([...list, ...tailFor(dropped)], style)]
  const fits = (left: TextChunk[], right: TextChunk[]) => {
    const rightLen = chunksLength(right)
    return chunksLength(left) + (rightLen > 0 ? rightLen + 1 : 0) <= width
  }

  // A row with no status column still has to shed, so it competes against a
  // single empty candidate rather than skipping the whole calculation.
  const candidates = rightCandidates.length > 0 ? rightCandidates : [[]]

  // The common case is that everything fits. It is checked against the short
  // wording first, because reserving room for the longer "there is more"
  // wording up front would drop a hint that never needed to go.
  const whole = compose(hints, 0)
  const roomy = candidates.find((candidate) => fits(whole, candidate))
  if (roomy) return padBetween(whole, roomy, width)

  // Past here something has to give, so every measurement assumes the worst
  // case — every droppable hint gone. The trailing hint appears (or grows) the
  // moment the first drop happens, and it must not push the row back over the
  // edge; over-reserving only ever makes the finished row shorter.
  const worst = hints.length
  const kept = [...hints]
  let dropped = 0
  let right = candidates.find((candidate) => fits(compose(kept, worst), candidate)) ?? candidates[candidates.length - 1]!
  while (!fits(compose(kept, worst), right)) {
    const victim = dropIndex(kept)
    if (victim < 0) break
    kept.splice(victim, 1)
    dropped += 1
  }
  // Last resort: the keys outrank the run metadata sitting beside them.
  if (!fits(compose(kept, worst), right)) right = []
  const left = compose(kept, dropped)
  if (chunksLength(left) <= width) return padBetween(left, right, width)

  // Narrower than the pinned hint's own wording. Strip it back to the bare key,
  // and clip if even that doesn't fit — a visible ellipsis beats a silent chop
  // at the border, which is the whole point of this function.
  const bare = overflow ? [...prefix, ...renderHints([...kept, { ...overflow, label: "" }], style)] : left
  return new StyledText(clipChunks(bare, width))
}

// Highest priority number leaves first; ties break toward the end of the row,
// so the hints nearest the left edge are the ones that survive.
function dropIndex(hints: Hint[]): number {
  let victim = -1
  hints.forEach((hint, index) => {
    if (hint.priority <= 0) return
    if (victim < 0 || hint.priority >= hints[victim]!.priority) victim = index
  })
  return victim
}

function renderHints(hints: Hint[], rowStyle: HintStyle): TextChunk[] {
  const chunks: TextChunk[] = []
  hints.forEach((hint, index) => {
    if (index > 0) chunks.push(fg(theme.dim)(" · "))
    chunks.push(...hintChunks(hint, rowStyle))
  })
  return chunks
}

function hintChunks(hint: Hint, rowStyle: HintStyle): TextChunk[] {
  const keys = fg(hint.tone === "yellow" ? theme.yellow : hint.tone === "dim" ? theme.dim : theme.accent)(hint.keys)
  const style = hint.style ?? rowStyle
  if (style === "bracket") {
    const open = fg(theme.dim)("[")
    if (hint.labelChunks) return [open, keys, fg(theme.dim)("]"), ...hint.labelChunks]
    return [open, keys, fg(theme.dim)(hint.label ? `] ${hint.label}` : "]")]
  }
  if (hint.labelChunks) return [keys, ...hint.labelChunks]
  if (!hint.label) return [keys]
  return [keys, fg(theme.dim)(style === "glued" ? hint.label : ` ${hint.label}`)]
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
  return `$${cost.toFixed(2)}`
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
 * Header row shared by every convoy TUI: the GPT subscription meter (5h
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
    const left: TextChunk[] = limits?.gptHint ? [fg(theme.faint)(`OpenAI — ${limits.gptHint}`)] : [fg(theme.faint)("…")]
    return padBetween(left, right, width)
  }

  const pct = Math.round(gpt.sessionPct)
  const barColor = pct >= 85 ? theme.red : pct >= 60 ? theme.yellow : theme.accent
  const pctChunk = fg(pct >= 60 ? barColor : theme.text)(`${pct}%`)
  const sep = fg(theme.faint)(" · ")
  const bar = (cells: number): TextChunk[] => [fg(theme.dim)("OpenAI "), ...progressBar(pct / 100, cells, barColor), raw(" "), pctChunk]
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
    [fg(theme.dim)("OpenAI "), pctChunk],
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

export function wrapStyled(styled: StyledText, width: number): StyledText[] {
  if (width <= 0) return [plain("")]
  const lines: StyledText[] = []
  let row: TextChunk[] = []
  let cells = 0
  let rowHasWord = false
  // Keep separating whitespace out of the current row until the following
  // word fits. That prevents a wrapping row from ending in a space, and lets
  // the word move as a whole to the next line rather than splitting mid-word.
  let pendingWhitespace: TextChunk[] = []
  const flush = () => {
    lines.push(new StyledText(row.length > 0 ? row : [raw("")]))
    row = []
    cells = 0
    rowHasWord = false
    pendingWhitespace = []
  }

  const appendWhitespace = (chunk: TextChunk, text: string) => {
    if (row.length === 0) {
      // Leading indentation is meaningful for nested Markdown lists and code.
      row.push({ ...chunk, text })
      cells += displayWidth(text)
    } else {
      pendingWhitespace.push({ ...chunk, text })
    }
  }

  const appendWord = (chunk: TextChunk, text: string) => {
    let rest = text
    while (rest) {
      const wordCells = displayWidth(rest)
      const whitespaceCells = rowHasWord ? chunksLength(pendingWhitespace) : 0
      if (cells + whitespaceCells + wordCells <= width) {
        if (rowHasWord) {
          row.push(...pendingWhitespace)
          cells += whitespaceCells
          pendingWhitespace = []
        }
        row.push({ ...chunk, text: rest })
        cells += wordCells
        rowHasWord = true
        return
      }

      if (rowHasWord) {
        // The complete word fits on a fresh row, so leave any separator behind
        // and start it there instead of cutting the word in two.
        flush()
        continue
      }

      // An over-wide leading indentation would otherwise create an empty row.
      // Drop it in this exceptional case; the word itself remains readable.
      if (cells > 0) {
        row = []
        cells = 0
      }

      // A single unbroken token (a URL, path, or an unusually long word) still
      // needs a hard split to stay inside the panel. This also preserves the
      // wide-glyph fallback that prevents an infinite loop in one-cell widths.
      const part = takeDisplayCells(rest, width)
      if (!part.head) {
        const first = [...graphemes.segment(rest)][0]?.segment ?? ""
        if (!first) return
        row.push({ ...chunk, text: first })
        cells = displayWidth(first)
        rowHasWord = true
        rest = rest.slice(first.length)
      } else {
        row.push({ ...chunk, text: part.head })
        cells = displayWidth(part.head)
        rowHasWord = true
        rest = part.tail
      }
      if (rest) flush()
    }
  }

  for (const chunk of styled.chunks) {
    // Newlines retain their original hard-break behavior. Every other run of
    // whitespace becomes a deferred separator so normal prose wraps by words.
    for (const part of chunk.text.split(/(\n|[^\S\n]+)/)) {
      if (!part) continue
      if (part === "\n") flush()
      else if (/^[^\S\n]+$/.test(part)) appendWhitespace(chunk, part)
      else appendWord(chunk, part)
    }
  }
  if (row.length > 0 || lines.length === 0) flush()
  return lines
}

/**
 * Wraps `styled` inside a gutter: `first` heads the opening row and `rest` (by
 * default blanks of the same width) heads every continuation. Blockquote bars,
 * code gutters, list markers and the log feed's timestamp column are all this
 * one shape, and because the prefix is applied *after* wrapping, nesting them
 * composes without any level knowing about the others.
 */
export function indentStyled(styled: StyledText, width: number, first: TextChunk[], rest?: TextChunk[]): StyledText[] {
  const gutter = chunksLength(first)
  // Nothing readable survives a gutter as wide as the column it sits in, and an
  // empty row is worse than a missing marker, so the content wins the tie.
  if (width - gutter < 1) return wrapStyled(styled, Math.max(1, width))
  return indentRows(wrapStyled(styled, width - gutter), first, rest)
}

/** The same gutter, for rows a caller already wrapped at the inner width. */
export function indentRows(rows: StyledText[], first: TextChunk[], rest?: TextChunk[]): StyledText[] {
  // Measured from `first` rather than assumed: the markers in use are not all
  // ASCII, and a hardcoded pad would drift from the prefix that set the wrap
  // budget, pushing continuation rows out of the panel by a cell or two.
  const gutter = chunksLength(first)
  const continuation = fitGutter(rest ?? [raw(" ".repeat(gutter))], gutter)
  // A blank row keeps a *visible* gutter — an empty line inside a code block or
  // a blockquote still belongs to it — but a blank list continuation must not
  // emit trailing spaces, which would land in the terminal's selection buffer.
  const visibleGutter = continuation.some((chunk) => chunk.text.trim() !== "")
  const blankGutter = visibleGutter ? trimTrailing(continuation) : []
  return rows.map((row, index) => {
    if (index === 0) return new StyledText([...first, ...row.chunks])
    if (row.chunks.every((chunk) => chunk.text.trim() === "")) {
      return blankGutter.length > 0 ? new StyledText(blankGutter) : row
    }
    return new StyledText([...continuation, ...row.chunks])
  })
}

/** Pads or clips a gutter to exactly `width` cells, without an ellipsis. */
function fitGutter(chunks: TextChunk[], width: number): TextChunk[] {
  const length = chunksLength(chunks)
  if (length === width) return chunks
  if (length < width) return [...chunks, raw(" ".repeat(width - length))]
  const clipped: TextChunk[] = []
  let budget = width
  for (const chunk of chunks) {
    if (budget <= 0) break
    const part = takeDisplayCells(chunk.text, budget)
    if (part.head) {
      clipped.push({ ...chunk, text: part.head })
      budget -= displayWidth(part.head)
    }
    if (part.tail) break
  }
  // A wide glyph straddling the budget leaves a cell unfilled; pad it so the
  // caller's alignment maths still holds.
  return budget > 0 ? [...clipped, raw(" ".repeat(budget))] : clipped
}

function trimTrailing(chunks: TextChunk[]): TextChunk[] {
  const out = chunks.slice()
  while (out.length > 0) {
    const last = out[out.length - 1]!
    const trimmed = last.text.replace(/\s+$/, "")
    if (trimmed === last.text) break
    out.pop()
    if (trimmed) {
      out.push({ ...last, text: trimmed })
      break
    }
  }
  return out
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

export function takeDisplayCells(text: string, max: number): { head: string; tail: string } {
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
