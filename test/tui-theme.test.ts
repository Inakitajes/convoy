import { describe, expect, test } from "bun:test"

import type { CliRenderer } from "@opentui/core"
import { displayWidth, formatAgo, formatCount, formatElapsed, formatMoney, formatTime, fmtCountdown, hintsRow, moreHintsMarker, padBetween, paletteForMode, paletteForTerminal, raw, shortID, shortPath, shortUrl, spinnerFrame, terminalBackgroundHex, truncate, wrapLines, type Hint, type OverflowHint } from "../src/tui-theme"

// terminalBackgroundHex reaches into opentui internals; the adapter must read a
// real reply but degrade to undefined (→ static palettes) on any shape change.
const fakeRenderer = (themeModeState: unknown) => ({ themeModeState }) as unknown as CliRenderer

/** WCAG relative luminance of a #rrggbb color. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
  const linear = channels.map((channel) => (channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)))
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
}

/** WCAG contrast ratio between two #rrggbb colors. */
function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

/**
 * Largest per-channel distance between two colors, in 0..1 — the separation a
 * solid chip keeps from the fill it rides even when both hues are saturated
 * and share a luminance.
 */
function maxChannelDelta(a: string, b: string): number {
  const channels = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
  const [left, right] = [channels(a), channels(b)]
  return Math.max(...left.map((value, index) => Math.abs(value - right[index]!))) / 255
}

describe("palette derivation from the terminal background", () => {
  test("measures wide and combined graphemes in terminal cells", () => {
    expect(displayWidth("ascii")).toBe(5)
    expect(displayWidth("界🙂é")).toBe(5)
    expect(displayWidth("👨‍👩‍👧‍👦")).toBe(2)
    expect(truncate("界界界", 5)).toBe("界界…")
    expect(wrapLines(["界界a"], 3)).toEqual(["界", "界a"])
    expect(wrapLines(["éé"], 1)).toEqual(["é", "é"])
  })

  test("dark background: transparent canvas, static borders, overlay repaints the terminal", () => {
    const palette = paletteForTerminal("dark", "#1a1b26")

    expect(palette.bg).toBe("transparent")
    expect(palette.overlay).toBe("#1a1b26")
    expect(palette.chipText).toBe("#1a1b26")
    // Borders come from the static dark palette, never from the background.
    expect(palette.borderDim).toBe("#1B2438")
    expect(palette.border).toBe("#26324B")
    // Accents come from the static dark palette.
    expect(palette.accent).toBe(paletteForMode("dark").accent)
  })

  test("light background: transparent canvas, static borders, overlay repaints the terminal", () => {
    const palette = paletteForTerminal("light", "#fafafa")

    expect(palette.bg).toBe("transparent")
    expect(palette.overlay).toBe("#fafafa")
    expect(palette.borderDim).toBe("#C1C6DD")
    expect(palette.border).toBe("#A8AECB")
    expect(palette.accent).toBe(paletteForMode("light").accent)
  })

  // The mode needs both OSC replies inside opentui's 250ms window, but a lone
  // background reply is enough to derive the palette ourselves.
  test("brightness of the background wins over an unresolved mode", () => {
    expect(paletteForTerminal(null, "#000000").accent).toBe(paletteForMode("dark").accent)
    expect(paletteForTerminal(null, "#ffffff").accent).toBe(paletteForMode("light").accent)
  })

  test("falls back to the static palettes without a usable background", () => {
    expect(paletteForTerminal("dark", undefined)).toBe(paletteForMode("dark"))
    expect(paletteForTerminal(null, "not-a-color")).toBe(paletteForMode(null))
  })

  test("reads a real OSC background reply but fails safe on a changed internal shape", () => {
    // A usable reply is read straight through.
    expect(terminalBackgroundHex(fakeRenderer({ themeOscBackground: "#1a1b26" }))).toBe("#1a1b26")

    // Anything that isn't a parseable hex string degrades to undefined.
    expect(terminalBackgroundHex(fakeRenderer({ themeOscBackground: "not-a-color" }))).toBeUndefined()
    expect(terminalBackgroundHex(fakeRenderer({ themeOscBackground: 0x1a1b26 }))).toBeUndefined()

    // A dependency upgrade that drops or renames the internal state must not throw.
    expect(terminalBackgroundHex(fakeRenderer(undefined))).toBeUndefined()
    expect(terminalBackgroundHex(fakeRenderer({}))).toBeUndefined()
    expect(terminalBackgroundHex({} as unknown as CliRenderer)).toBeUndefined()
  })

  test("quota reset countdowns collapse to the two most significant units", () => {
    const now = Date.now()
    const minutes = (n: number) => now + n * 60_000
    expect(fmtCountdown(minutes(2 * 1440 + 3 * 60 + 59), now)).toBe("2d 3h")
    expect(fmtCountdown(minutes(2 * 60 + 10), now)).toBe("2h 10m")
    expect(fmtCountdown(minutes(12), now)).toBe("12m")
    expect(fmtCountdown(now + 30_000, now)).toBe("0m")
    expect(fmtCountdown(now - 60_000, now)).toBe("0m")
  })

  test("no palette ever paints a panel background", () => {
    for (const palette of [
      paletteForMode("dark"),
      paletteForMode("light"),
      paletteForMode(null),
      paletteForTerminal("dark", "#1a1b26"),
      paletteForTerminal("light", "#fafafa"),
    ]) {
      expect(palette.bg).toBe("transparent")
    }
  })

  // The warning chip carries its own ink on a filled surface, so the ink must
  // clear AA against the chip fill in every palette, and the fill must stay
  // separable from the accent it rides.
  test("the warning chip's ink stays legible across every palette", () => {
    for (const palette of [paletteForMode("dark"), paletteForMode("light"), paletteForMode(null)]) {
      expect(contrastRatio(palette.warningInk, palette.warning)).toBeGreaterThanOrEqual(4.5)
      expect(maxChannelDelta(palette.warning, palette.accent)).toBeGreaterThanOrEqual(0.25)
    }
  })
})

describe("padBetween", () => {
  const text = (chunks: { text: string }[], width: number) =>
    padBetween(
      chunks.slice(0, 1).map((c) => raw(c.text)),
      chunks.slice(1).map((c) => raw(c.text)),
      width,
    )
      .chunks.map((chunk) => chunk.text)
      .join("")

  test("pads left and right apart to the exact width", () => {
    const row = text([{ text: "name" }, { text: "0:42" }], 20)
    expect(row).toBe("name            0:42")
    expect(displayWidth(row)).toBe(20)
  })

  test("clips the right side inside the width instead of overflowing past the border", () => {
    const row = text([{ text: "name" }, { text: "audit · read-only" }, { text: " · 0:42" }], 20)
    expect(displayWidth(row)).toBeLessThanOrEqual(20)
    expect(row.endsWith("…")).toBe(true)
    expect(row.startsWith("name ")).toBe(true)
  })

  test("drops the right side entirely when the left leaves it no room", () => {
    const row = text([{ text: "a-very-long-left-side-label" }, { text: "0:42" }], 24)
    expect(row).toBe("a-very-long-left-side-label")
  })
})

describe("hintsRow", () => {
  const hints: Hint[] = [
    { keys: "↑↓", label: "step", priority: 3 },
    { keys: "enter", label: "read", priority: 4 },
    { keys: "←→", label: "tab", priority: 5 },
    { keys: "v", label: "full session", priority: 6 },
  ]
  const overflow: OverflowHint = { keys: "ctrl+p", label: "commands", moreLabel: "all shortcuts", priority: 0 }
  const status = [[raw("run abc123 · ⚡ :4096 · now")], [raw("run abc123 · ⚡ :4096")], [raw("run abc123")]]
  const render = (width: number, options = {}) =>
    hintsRow(hints, status, width, { overflow, ...options })
      .chunks.map((chunk) => chunk.text)
      .join("")

  test("keeps every hint and the longest status when the terminal is wide", () => {
    const row = render(120)
    expect(row).toContain("[↑↓] step")
    expect(row).toContain("[v] full session")
    expect(row).toContain("[ctrl+p] commands")
    expect(row).toContain("⚡ :4096 · now")
    expect(displayWidth(row)).toBe(120)
  })

  test("sheds status detail before it touches the keys", () => {
    // 100 and 90 sit either side of the status ladder's two rungs: the quiet
    // timer goes first, then the server URL, and every key survives both.
    const trimmed = render(100)
    expect(trimmed).toContain("[v] full session")
    expect(trimmed).toContain("⚡ :4096")
    expect(trimmed).not.toContain("now")

    const bare = render(90)
    expect(bare).toContain("[v] full session")
    expect(bare).toContain("run abc123")
    expect(bare).not.toContain("⚡")
    // The run id is kept whole rather than ellipsised mid-value.
    expect(bare).not.toContain("…")
    expect(bare).toContain("[ctrl+p] commands")
  })

  test("drops the lowest-priority hint first and says where it went", () => {
    const row = render(58)
    expect(row).not.toContain("full session")
    expect(row).toContain("[↑↓] step")
    expect(row).toContain("[ctrl+p] all shortcuts")
  })

  test("drops hints in priority order, highest number first", () => {
    const dropOrder = ["full session", "tab", "read", "step"]
    const survivors = dropOrder.map((_, index) => dropOrder.slice(index + 1))
    let previous = 200
    survivors.forEach((expected, index) => {
      // Walk down until the hint at `index` is gone, then check what remains.
      let width = previous
      while (width > 20 && render(width).includes(`] ${dropOrder[index]}`)) width -= 1
      for (const label of expected) expect(render(width)).toContain(`] ${label}`)
      previous = width
    })
  })

  test("the pinned hint survives even when nothing else can", () => {
    const row = render(24)
    expect(row).toContain("ctrl+p")
    expect(displayWidth(row)).toBeLessThanOrEqual(24)
  })

  test("never overflows the width it was given", () => {
    for (let width = 20; width <= 160; width += 1) {
      expect(displayWidth(render(width)), `width ${width}`).toBeLessThanOrEqual(width)
    }
  })

  test("keeps the short wording when everything fits, so nothing is dropped for free", () => {
    // The row is measured against "all shortcuts" only once a drop is needed;
    // at a width where "commands" fits exactly, every hint must survive.
    const exact = displayWidth(render(200))
    const row = hintsRow(hints, [], exact, { overflow })
      .chunks.map((chunk) => chunk.text)
      .join("")
    expect(row).toContain("[ctrl+p] commands")
    expect(row).toContain("[v] full session")
  })

  test("renders the three footer shapes the TUIs already use", () => {
    const shapes: Hint[] = [
      { keys: "esc", label: "back", priority: 1, style: "bracket" },
      { keys: "enter", label: "confirm", priority: 1, style: "spaced" },
      { keys: "q", label: "uit", priority: 1, style: "glued" },
    ]
    const row = hintsRow(shapes, [], 80)
      .chunks.map((chunk) => chunk.text)
      .join("")
    expect(row).toBe("[esc] back · enter confirm · quit")
  })

  test("a prefix rides along and counts toward the width", () => {
    const row = hintsRow(hints, [], 40, { prefix: [raw("read · ")] })
      .chunks.map((chunk) => chunk.text)
      .join("")
    expect(row.startsWith("read · ")).toBe(true)
    expect(displayWidth(row)).toBeLessThanOrEqual(40)
  })

  test("without an overflow hint a narrow row simply sheds", () => {
    const row = hintsRow(hints, [], 30)
      .chunks.map((chunk) => chunk.text)
      .join("")
    expect(displayWidth(row)).toBeLessThanOrEqual(30)
    expect(row).toContain("[↑↓] step")
  })

  // The footers with no command palette behind them (launcher, runs browser,
  // config editor) share this marker: silent until something is actually
  // hidden, then an honest count.
  describe("the palette-less overflow marker", () => {
    const shed: Hint[] = [
      { keys: "↑/↓", label: "select", priority: 3, tone: "dim" },
      { keys: "enter", label: "open", priority: 2 },
      { keys: "r", label: "esume", priority: 4, style: "glued" },
      { keys: "s", label: "ummary", priority: 5, style: "glued" },
      { keys: "q", label: "uit", priority: 1, style: "glued" },
    ]
    const marked = (width: number) =>
      hintsRow(shed, [[raw("3/12")]], width, { style: "spaced", overflow: moreHintsMarker })
        .chunks.map((chunk) => chunk.text)
        .join("")

    test("stays invisible while every hint fits", () => {
      const row = marked(100)
      expect(row.trimEnd().replace(/\s+3\/12$/, "")).toBe("↑/↓ select · enter open · resume · summary · quit")
      expect(row).not.toContain("+")
    })

    test("counts what it hid, and keeps counting as the row narrows", () => {
      const one = marked(50)
      expect(one).toContain("· +1")
      expect(one).not.toContain("summary")

      const more = marked(42)
      expect(more).toContain("· +2")
      expect(more).not.toContain("resume")
      // Whatever gets you out is priority 1, so it is the last hint standing.
      expect(more).toContain("quit")
    })

    test("still never overflows", () => {
      for (let width = 20; width <= 110; width += 1) {
        expect(displayWidth(marked(width)), `width ${width}`).toBeLessThanOrEqual(width)
      }
    })
  })
})

// ---------------------------------------------------------------------------
// paletteForMode
// ---------------------------------------------------------------------------

describe("paletteForMode", () => {
  test("returns dark palette for dark mode", () => {
    const p = paletteForMode("dark")
    expect(p.accent).toBe("#7AA2F7")
  })

  test("returns light palette for light mode", () => {
    const p = paletteForMode("light")
    expect(p.accent).toBe("#2E7DE9")
  })

  test("returns neutral palette for null/undefined", () => {
    expect(paletteForMode(null).accent).toBe("#4F9CF9")
    expect(paletteForMode(undefined).accent).toBe("#4F9CF9")
  })
})

// ---------------------------------------------------------------------------
// spinnerFrame
// ---------------------------------------------------------------------------

describe("spinnerFrame", () => {
  test("rotates through frames based on time", () => {
    expect(spinnerFrame(0)).toBe("⠋")
    expect(spinnerFrame(150)).toBe("⠙")
  })

  test("wraps around after 10 frames", () => {
    expect(spinnerFrame(0)).toBe(spinnerFrame(1000))
  })
})

// ---------------------------------------------------------------------------
// formatMoney, formatCount, formatElapsed, formatAgo, fmtCountdown, formatTime
// ---------------------------------------------------------------------------

describe("formatMoney", () => {
  test("formats cost to 2 decimal places", () => {
    expect(formatMoney(0)).toBe("$0.00")
    expect(formatMoney(0.05)).toBe("$0.05")
    expect(formatMoney(1.5)).toBe("$1.50")
    expect(formatMoney(123.456)).toBe("$123.46")
  })
})

describe("formatCount", () => {
  test("returns raw number below 1000", () => {
    expect(formatCount(0)).toBe("0")
    expect(formatCount(500)).toBe("500")
  })

  test("formats thousands with k", () => {
    expect(formatCount(1500)).toBe("1.5k")
    expect(formatCount(999_999)).toBe("1000.0k")
  })

  test("formats millions with m", () => {
    expect(formatCount(1_000_000)).toBe("1.0m")
    expect(formatCount(2_500_000)).toBe("2.5m")
  })
})

describe("formatElapsed", () => {
  test("formats milliseconds as m:ss", () => {
    expect(formatElapsed(0)).toBe("0:00")
    expect(formatElapsed(5000)).toBe("0:05")
    expect(formatElapsed(65_000)).toBe("1:05")
  })
})

describe("formatAgo", () => {
  test("returns 'now' for <= 1 second", () => {
    expect(formatAgo(0)).toBe("now")
    expect(formatAgo(1000)).toBe("now")
  })

  test("returns seconds for < 60s", () => {
    expect(formatAgo(30_000)).toBe("30s ago")
  })

  test("returns minutes and seconds for >= 60s", () => {
    expect(formatAgo(60_000)).toBe("1m 0s ago")
    expect(formatAgo(90_000)).toBe("1m 30s ago")
  })
})

describe("fmtCountdown", () => {
  test("returns 0m when resetsAt is in the past", () => {
    expect(fmtCountdown(0, Date.now())).toBe("0m")
  })
})

describe("formatTime", () => {
  test("formats a timestamp as HH:MM:SS", () => {
    const date = new Date(2025, 0, 15, 14, 30, 0)
    expect(formatTime(date.getTime())).toBe("14:30:00")
  })
})

// ---------------------------------------------------------------------------
// shortID, shortUrl, projectName, shortPath, truncate
// ---------------------------------------------------------------------------

describe("shortID", () => {
  test("returns short IDs unchanged", () => {
    expect(shortID("abc123")).toBe("abc123")
    expect(shortID("123456789012")).toBe("123456789012")
  })

  test("truncates long IDs with ellipsis", () => {
    const result = shortID("abcdef1234567890abcd")
    expect(result).toBe("abcdef1…abcd")
    expect(result.length).toBe(12)
  })
})

describe("shortUrl", () => {
  test("strips protocol prefix", () => {
    expect(shortUrl("https://example.com/path")).toBe("example.com/path")
  })
})

describe("shortPath", () => {
  test("returns ellipsis for empty string", () => {
    expect(shortPath("", 50)).toBe("…")
  })

  test("replaces home with ~", () => {
    const home = process.env.HOME
    if (home) {
      expect(shortPath(`${home}/project`, 100)).toBe("~/project")
    }
  })

  test("truncates from the left when too long", () => {
    const result = shortPath("/a/very/long/path/that/exceeds/max", 20)
    expect(result.length).toBe(20)
    expect(result.startsWith("…")).toBe(true)
  })
})

describe("truncate", () => {
  test("returns short strings unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello")
  })

  test("collapses whitespace", () => {
    expect(truncate("  hello   world  ", 50)).toBe("hello world")
  })

  test("adds ellipsis for long strings", () => {
    const result = truncate("hello world this is a test", 10)
    expect(result).toBe("hello wor…")
  })

  test("returns empty for max <= 0", () => {
    expect(truncate("hello", 0)).toBe("")
    expect(truncate("hello", -1)).toBe("")
  })

  test("returns ellipsis for max === 1", () => {
    expect(truncate("hello", 1)).toBe("…")
  })
})

// ---------------------------------------------------------------------------
// wrapLines
// ---------------------------------------------------------------------------

describe("wrapLines", () => {
  test("wraps a long line at the specified width", () => {
    const result = wrapLines(["hello world foo bar"], 10)
    expect(result.length).toBeGreaterThanOrEqual(2)
    expect(result.every((line) => displayWidth(line) <= 10)).toBe(true)
  })

  test("handles short lines without wrapping", () => {
    expect(wrapLines(["hello"], 10)).toEqual(["hello"])
  })

  test("handles empty array", () => {
    expect(wrapLines([], 10)).toEqual([])
  })

  test("wraps each line independently", () => {
    const result = wrapLines(["short", "a much longer line that needs wrapping"], 15)
    expect(result[0]).toBe("short")
    expect(result.length).toBeGreaterThanOrEqual(2)
  })
})
