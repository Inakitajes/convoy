/**
 * OpenCode v2 history reconstruction (change `runner-parity-opencode-v2`,
 * task 4.4).
 *
 * Late attachment to a run needs the same neutral events a live turn produced.
 * A session's recorded messages are the durable source: assistant text,
 * reasoning, and tool markers are replayed in order, so a dashboard that attaches
 * after a step completed can still show what it said and did.
 */

import type { RunnerEvent } from "../contracts"

/** Reconstructs the neutral transcript from a session's projected messages. */
export function reconstructFromMessages(messages: readonly unknown[], attempt: number): RunnerEvent[] {
  const events: RunnerEvent[] = []
  for (const entry of messages) {
    if (typeof entry !== "object" || entry === null) continue
    const record = entry as { type?: unknown; content?: unknown }
    if (record.type !== "assistant" || !Array.isArray(record.content)) continue
    for (const part of record.content as { type?: unknown; text?: unknown; name?: unknown }[]) {
      if (part.type === "text" && typeof part.text === "string") {
        events.push({ type: "text", runner: "opencode", attempt, text: part.text })
      } else if (part.type === "reasoning" && typeof part.text === "string") {
        events.push({ type: "reasoning", runner: "opencode", attempt, text: part.text })
      } else if (part.type === "tool" && typeof part.name === "string") {
        events.push({ type: "tool", runner: "opencode", attempt, name: part.name })
      }
    }
  }
  return events
}
