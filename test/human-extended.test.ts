import { describe, expect, test } from "bun:test"
import { humanActionMenu } from "../src/human"

describe("humanActionMenu", () => {
  test("returns formatted choices for allowed actions", () => {
    const menu = humanActionMenu(["continue", "abort"])
    expect(menu).toContain("[c]ontinue pipeline")
    expect(menu).toContain("[a]bort")
  })

  test("returns all actions formatted correctly", () => {
    const menu = humanActionMenu(["continue", "iterate", "abort", "retry"])
    expect(menu).toBe("[c]ontinue pipeline, [o]pen session, [a]bort, [r]etry clean")
  })

  test("returns empty string for empty allowed list", () => {
    expect(humanActionMenu([])).toBe("")
  })

  test("includes retry label correctly", () => {
    const menu = humanActionMenu(["retry"])
    expect(menu).toBe("[r]etry clean")
  })

  test("includes iterate label correctly", () => {
    const menu = humanActionMenu(["iterate"])
    expect(menu).toBe("[o]pen session")
  })
})