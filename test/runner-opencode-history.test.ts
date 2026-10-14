import { describe, expect, test } from "bun:test"

import { reconstructFromMessages } from "../src/runners/opencode/history"

describe("opencode v2 history reconstruction", () => {
  test("replays assistant text, reasoning, and tool markers in order", () => {
    const events = reconstructFromMessages(
      [
        { type: "user", text: "hi" },
        {
          type: "assistant",
          content: [
            { type: "reasoning", text: "thinking" },
            { type: "text", text: "hello " },
            { type: "tool", name: "read" },
            { type: "text", text: "world" },
          ],
        },
      ],
      2,
    )
    expect(events).toEqual([
      { type: "reasoning", runner: "opencode", attempt: 2, text: "thinking" },
      { type: "text", runner: "opencode", attempt: 2, text: "hello " },
      { type: "tool", runner: "opencode", attempt: 2, name: "read" },
      { type: "text", runner: "opencode", attempt: 2, text: "world" },
    ])
  })

  test("ignores non-assistant and malformed entries", () => {
    expect(reconstructFromMessages([{ type: "idle" }, { type: "assistant" }, null], 1)).toEqual([])
  })
})
