import { addTokens, emptyTokens } from "./usage"
import type { UsageReport, UsageReportRow } from "./run-history-report"

/**
 * JSON.stringify escapes C0 controls only: C1 controls (CSI, OSC, ST), bidi
 * formats and line separators survive literally, so a persisted title could
 * drive or reorder the terminal that shows the output. Escape them as \uXXXX;
 * parsed values are unchanged.
 */
const terminalActiveCharacters = /[\u0080-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

export function renderJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2).replace(terminalActiveCharacters, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
  return `${json}\n`
}

export function renderUsageReportTable({ dimension, runs, rows }: UsageReport): string {
  const emptyTotal: UsageReportRow = {
    key: "total",
    runs,
    phases: 0,
    completed: 0,
    failed: 0,
    tokens: emptyTokens(),
    cost: 0,
    advisorCost: 0,
    durationMs: 0,
  }
  const total = rows.reduce<UsageReportRow>((sum, row) => ({
    key: "total",
    runs,
    phases: sum.phases + row.phases,
    completed: sum.completed + row.completed,
    failed: sum.failed + row.failed,
    tokens: addTokens(sum.tokens, row.tokens),
    cost: sum.cost + row.cost,
    advisorCost: sum.advisorCost + row.advisorCost,
    durationMs: sum.durationMs + row.durationMs,
  }), emptyTotal)
  const header = [dimension, "runs", "phases", "ok", "failed", "tokens", "cache read", "cost", "advisor", "duration"]
  const data = [...rows, total].map((row) => [terminalSafeCell(row.key), String(row.runs), String(row.phases), String(row.completed), String(row.failed), compact(row.tokens.total), compact(row.tokens.cacheRead), `$${row.cost.toFixed(4)}`, `$${row.advisorCost.toFixed(4)}`, duration(row.durationMs)])
  const widths = header.map((label, index) => Math.max(label.length, ...data.map((row) => row[index]!.length)))
  const format = (row: string[], isHeader = false) => row.map((cell, index) => index === 0 || isHeader ? cell.padEnd(widths[index]!) : cell.padStart(widths[index]!)).join(" | ")
  return `${format(header, true)}\n${widths.map((width) => "-".repeat(width)).join("-|-")}\n${data.map((row) => format(row)).join("\n")}\n`
}

/** Persisted pipeline, model, and step names must never emit terminal commands. */
function terminalSafeCell(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/gu, " ")
    .trim()
}

function compact(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
}

function duration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000)
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)}h${Math.floor((seconds % 3_600) / 60)}m`
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m${seconds % 60}s`
  return `${seconds}s`
}
