import { describe, expect, test } from "bun:test"

import { cursorPosition, promptEnterAction, sanitizePaste, typedText, wrapPromptLines } from "../src/launch-tui"

import type { KeyEvent } from "@opentui/core"

function key(partial: Partial<KeyEvent>): KeyEvent {
  return partial as KeyEvent
}

describe("launch TUI prompt input", () => {
  test("sanitizes pasted prompt text while preserving unlimited multi-line content", () => {
    const longLine = "x".repeat(5_000)
    const pasted = `first\r\nsecond\rthird\t${longLine}\u0000\u001b[31mred\u001b[0m`

    expect(sanitizePaste(pasted)).toBe(`first\nsecond\nthird ${longLine}[31mred[0m`)
  })

  test("wraps long and multi-line prompts for the visible text field", () => {
    expect(wrapPromptLines("abcdef\n\nxyz", 3)).toEqual(["abc", "def", "", "xyz"])
    expect(wrapPromptLines("", 10)).toEqual([""])
    expect(wrapPromptLines("anything", 0)).toEqual([""])
  })

  test("maps cursor position across wrapped and pasted new-line content", () => {
    const text = "abcd\nefghij"

    expect(cursorPosition(text, 0, 4)).toEqual({ row: 0, col: 0 })
    expect(cursorPosition(text, 4, 4)).toEqual({ row: 0, col: 4 })
    expect(cursorPosition(text, 5, 4)).toEqual({ row: 1, col: 0 })
    expect(cursorPosition(text, text.length, 4)).toEqual({ row: 2, col: 2 })
  })

  test("accepts normal text and plain raw paste, but ignores controls and named keys", () => {
    expect(typedText(key({ name: "a", raw: "a" }))).toBe("a")
    expect(typedText(key({ name: "space", raw: " " }))).toBe(" ")
    expect(typedText(key({ name: "", raw: "pasted text" }))).toBe("pasted text")
    expect(typedText(key({ name: "left", raw: "\u001b[D" }))).toBeUndefined()
    expect(typedText(key({ name: "v", raw: "v", ctrl: true }))).toBeUndefined()
  })

  test("uses Shift+Enter for prompt new-lines and Enter for continuing", () => {
    expect(promptEnterAction(key({ name: "return" }))).toBe("submit")
    expect(promptEnterAction(key({ name: "linefeed" }))).toBe("submit")
    expect(promptEnterAction(key({ name: "return", shift: true }))).toBe("newline")
    expect(promptEnterAction(key({ name: "a" }))).toBeUndefined()
  })
})
