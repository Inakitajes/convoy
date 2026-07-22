import { describe, expect, test } from "bun:test"

import type { CliRenderer } from "@opentui/core"
import { displayWidth, fmtCountdown, markdownLines, padBetween, paletteForMode, paletteForTerminal, raw, terminalBackgroundHex, truncate, wrapLines } from "../src/tui-theme"

// terminalBackgroundHex reaches into opentui internals; the adapter must read a
// real reply but degrade to undefined (→ static palettes) on any shape change.
const fakeRenderer = (themeModeState: unknown) => ({ themeModeState }) as unknown as CliRenderer

describe("palette derivation from the terminal background", () => {
  test("measures wide and combined graphemes in terminal cells", () => {
    expect(displayWidth("ascii")).toBe(5)
    expect(displayWidth("界🙂é")).toBe(5)
    expect(displayWidth("👨‍👩‍👧‍👦")).toBe(2)
    expect(truncate("界界界", 5)).toBe("界界…")
    expect(wrapLines(["界界a"], 3)).toEqual(["界", "界a"])
    expect(wrapLines(["éé"], 1)).toEqual(["é", "é"])
  })

  test("dark background: transparent canvas, borders lifted toward white, overlay repaints the terminal", () => {
    const palette = paletteForTerminal("dark", "#1a1b26")

    expect(palette.bg).toBe("transparent")
    expect(palette.overlay).toBe("#1a1b26")
    expect(palette.chipText).toBe("#1a1b26")
    // 16% / 26% toward white from #1a1b26.
    expect(palette.borderDim).toBe("#3f3f49")
    expect(palette.border).toBe("#56565e")
    // Accents come from the static dark palette.
    expect(palette.accent).toBe(paletteForMode("dark").accent)
  })

  test("light background: borders sink toward black with light accents", () => {
    const palette = paletteForTerminal("light", "#fafafa")

    expect(palette.bg).toBe("transparent")
    expect(palette.overlay).toBe("#fafafa")
    expect(palette.borderDim).toBe("#d2d2d2")
    expect(palette.border).toBe("#b9b9b9")
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

describe("markdown rendering", () => {
  const text = (line: { chunks: { text: string }[] }) => line.chunks.map((chunk) => chunk.text).join("")

  test("conceals common markdown markers while preserving document structure", () => {
    const lines = markdownLines("# Heading\n\n- **bold** and `code`\n> quoted\n[docs](https://example.com)", 80).map(text)

    expect(lines).toEqual(["Heading", "", "• bold and code", "▎ quoted", "docs"])
  })

  test("wraps styled content to terminal cell width", () => {
    const lines = markdownLines("**界界界**", 4).map(text)

    expect(lines).toEqual(["界界", "界"])
    expect(lines.every((line) => displayWidth(line) <= 4)).toBeTrue()
  })

  test("renders inline typography plus ordered, task, rule, and fenced-code blocks", () => {
    const inline = markdownLines("**strong** _emphasis_ ~~deleted~~ `code` [site](https://example.com)", 80)[0]!.chunks
    const blocks = markdownLines("1. first\n2) second\n- [ ] queued\n* [x] done\n---\n```ts\nconst value = 1\n```", 20).map(text)

    expect(inline.find((chunk) => chunk.text === "strong")?.attributes).toBe(1)
    expect(inline.find((chunk) => chunk.text === "emphasis")?.attributes).toBe(4)
    expect(inline.find((chunk) => chunk.text === "deleted")?.attributes).toBe(128)
    expect(inline.find((chunk) => chunk.text === "site")?.link).toEqual({ url: "https://example.com/" })
    expect(blocks.slice(0, 4)).toEqual(["1. first", "2) second", "☐ queued", "☑ done"])
    expect(blocks[4]).toBe("─".repeat(20))
    expect(blocks[5]).toBe("┄ ts " + "┄".repeat(15))
    expect(blocks[6]).toBe("│ const value = 1")
    expect(blocks[7]).toBe("┄".repeat(20))
    expect(blocks.every((line) => displayWidth(line) <= 20)).toBeTrue()
  })

  test("sanitizes terminal controls and only creates web hyperlinks", () => {
    const lines = markdownLines("safe\u001b]52;c;dGVzdA\u0007text\n[local](file:///etc/passwd)\n[web](https://example.com)", 80)
    const chunks = lines.flatMap((line) => line.chunks)

    expect(chunks.map((chunk) => chunk.text).join("")).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/)
    expect(chunks.find((chunk) => chunk.text === "local")?.link).toBeUndefined()
    expect(chunks.find((chunk) => chunk.text === "web")?.link).toEqual({ url: "https://example.com/" })
  })

  test("keeps intra-word underscores literal instead of italicizing identifiers", () => {
    const lines = markdownLines("use foo_bar_baz or report_fullscreen_flag, but _real emphasis_ stays", 80).map(text)

    expect(lines).toEqual(["use foo_bar_baz or report_fullscreen_flag, but real emphasis stays"])
    expect(lines[0]).toContain("foo_bar_baz")
  })

  test("bounds fence rows to width even with long info strings", () => {
    const lines = markdownLines("```python { .annotate }\nx = 1\n```", 20).map(text)

    expect(lines[0]!.startsWith("┄ python")).toBeTrue()
    expect(lines.every((line) => displayWidth(line) <= 20)).toBeTrue()
  })

  test("never loops on a glyph wider than the column", () => {
    expect(markdownLines("界面", 1).map(text)).toEqual(["界", "面"])
  })
})
