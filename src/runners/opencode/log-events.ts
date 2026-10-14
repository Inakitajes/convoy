/**
 * OpenCode v2 session-log event decoding (change `runner-parity-opencode-v2`,
 * task 4.4).
 *
 * Maps the durable session-log items a v2 server exposes into the neutral
 * `RunnerEvent` vocabulary, so history backfill and late attachment produce the
 * same events as a live turn. Only content-bearing items are mapped; unrelated
 * lifecycle items are ignored rather than invented.
 *
 * A tool item carries no tool name in the durable log, so tools are not emitted
 * from here — the adapter derives tool markers from the assistant message.
 */

import type { RunnerEvent } from "../contracts"

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function dataOf(item: Record<string, unknown>): Record<string, unknown> | undefined {
  return asRecord(item.data)
}

function errorMessage(value: unknown): string {
  const error = asRecord(value)
  if (error && typeof error.message === "string" && error.message.length > 0) return error.message
  return "the run reported an error"
}

/** Maps one session-log item; `undefined` for items that carry no neutral event. */
export function mapSessionLogItem(item: unknown, attempt: number): RunnerEvent | undefined {
  const record = asRecord(item)
  if (!record) return undefined
  const type = record.type
  const data = dataOf(record)
  if (!data) return undefined

  switch (type) {
    case "session.text.ended":
      return typeof data.text === "string" ? { type: "text", runner: "opencode", attempt, text: data.text } : undefined
    case "session.reasoning.ended":
      return typeof data.text === "string" ? { type: "reasoning", runner: "opencode", attempt, text: data.text } : undefined
    case "session.execution.failed":
      return {
        type: "terminal",
        runner: "opencode",
        attempt,
        outcome: { status: "failed", ...(typeof data.sessionID === "string" ? { session: { runner: "opencode", sessionId: data.sessionID } } : {}), error: errorMessage(data.error) },
      }
    case "session.execution.interrupted":
      return {
        type: "terminal",
        runner: "opencode",
        attempt,
        outcome: { status: "interrupted", ...(typeof data.sessionID === "string" ? { session: { runner: "opencode", sessionId: data.sessionID } } : {}) },
      }
    case "session.execution.succeeded":
      return {
        type: "terminal",
        runner: "opencode",
        attempt,
        outcome: { status: "completed", ...(typeof data.sessionID === "string" ? { session: { runner: "opencode", sessionId: data.sessionID } } : {}) },
      }
    default:
      return undefined
  }
}

/** Maps a batch of session-log items, dropping unknown ones. */
export function mapSessionLog(items: readonly unknown[], attempt: number): RunnerEvent[] {
  const events: RunnerEvent[] = []
  for (const item of items) {
    const mapped = mapSessionLogItem(item, attempt)
    if (mapped) events.push(mapped)
  }
  return events
}

function tokenUsage(value: unknown): { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number } {
  const tokens = asRecord(value)
  if (!tokens) return {}
  const cache = asRecord(tokens.cache)
  return {
    ...(typeof tokens.input === "number" ? { input: tokens.input } : {}),
    ...(typeof tokens.output === "number" ? { output: tokens.output } : {}),
    ...(typeof tokens.reasoning === "number" ? { reasoning: tokens.reasoning } : {}),
    ...(cache && typeof cache.read === "number" ? { cacheRead: cache.read } : {}),
    ...(cache && typeof cache.write === "number" ? { cacheWrite: cache.write } : {}),
  }
}

/**
 * Maps a live v2 event (or a durable item) into the neutral vocabulary, filtered
 * to one session when `sessionID` is given. Deltas stream text/reasoning;
 * `session.text.ended` reconstructs a whole block for history backfill.
 */
export function mapOpencodeEvent(item: unknown, attempt: number, sessionID?: string): RunnerEvent | undefined {
  const record = asRecord(item)
  if (!record) return undefined
  const type = record.type
  const data = dataOf(record)
  if (!data) return undefined
  if (sessionID !== undefined && typeof data.sessionID === "string" && data.sessionID !== sessionID) return undefined

  switch (type) {
    case "session.text.delta":
    case "session.text.ended":
      return typeof data.delta === "string"
        ? { type: "text", runner: "opencode", attempt, text: data.delta }
        : typeof data.text === "string"
          ? { type: "text", runner: "opencode", attempt, text: data.text }
          : undefined
    case "session.reasoning.delta":
    case "session.reasoning.ended":
      return typeof data.delta === "string"
        ? { type: "reasoning", runner: "opencode", attempt, text: data.delta }
        : typeof data.text === "string"
          ? { type: "reasoning", runner: "opencode", attempt, text: data.text }
          : undefined
    case "session.usage.updated":
    case "session.usage.recorded": {
      const tokens = tokenUsage(data.tokens)
      const usage = { ...tokens, ...(typeof data.cost === "number" ? { costEstimate: data.cost } : {}) }
      return Object.keys(usage).length > 0 ? { type: "usage", runner: "opencode", attempt, usage } : undefined
    }
    default:
      return mapSessionLogItem(item, attempt)
  }
}
