import { describe, expect, test } from "bun:test"

import { renderJson, renderUsageReportTable } from "../src/run-history-render"
import type { UsageReport, UsageReportRow } from "../src/run-history-report"

const row: UsageReportRow = { key: "implement", runs: 1, phases: 1, completed: 1, failed: 0, tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 1_000, cacheWrite: 0, total: 1_000 }, cost: 0.1234567, advisorCost: 0, durationMs: 263_135 }

function report(dimension: UsageReport["dimension"], rows: UsageReportRow[], runs = rows.length): UsageReport {
  return { dimension, runs, rows }
}

describe("usage report rendering", () => {
  test("renders compact table values and a total row", () => {
    const table = renderUsageReportTable(report("pipeline", [row]))
    expect(table).toContain("1k")
    expect(table).toContain("$0.1235")
    expect(table).toContain("phases")
    expect(table).toMatch(/implement\s+\|\s+1\s+\|\s+1\s+\|/)
    expect(table).toContain("4m23s")
    expect(table).toContain("total")
  })

  test("reports the distinct run count on the total row, not the sum of the rows", () => {
    const table = renderUsageReportTable(report("step", [row, { ...row, key: "tests" }], 1))
    expect(table).toMatch(/^total\s+\|\s+1\s+\|\s+2\s+\|/m)
  })

  test("renders a zeroed table and indented JSON", () => {
    const empty = renderUsageReportTable(report("step", []))
    expect(empty).toMatch(/^step\s+\| runs/)
    expect(empty).toMatch(/^total\s+\|\s+0\s+\|\s+0\s+\|\s+0\s+\|\s+0\s+\|\s+0\s+\|\s+0\s+\|\s+\$0\.0000\s+\|\s+\$0\.0000\s+\|\s+0s$/m)
    expect(renderJson([{ value: 1 }])).toBe('[\n  {\n    "value": 1\n  }\n]\n')
  })

  test("formats token and duration boundaries without changing JSON values", () => {
    const table = renderUsageReportTable(report("step", [
      { ...row, key: "under", tokens: { ...row.tokens, total: 999, cacheRead: 999 }, durationMs: 59_999 },
      { ...row, key: "thousand", tokens: { ...row.tokens, total: 1_000, cacheRead: 1_000 }, durationMs: 60_000 },
      { ...row, key: "million", tokens: { ...row.tokens, total: 1_000_000, cacheRead: 1_000_000 }, durationMs: 3_600_000 },
    ]))

    expect(table).toContain("999")
    expect(table).toContain("1k")
    expect(table).toContain("1M")
    expect(table).toContain("59s")
    expect(table).toContain("1m0s")
    expect(table).toContain("1h0m")
    expect(JSON.parse(renderJson([{ tokens: 1_000_000, durationMs: 3_600_000 }]))).toEqual([{ tokens: 1_000_000, durationMs: 3_600_000 }])
  })

  test("escapes terminal-active characters in JSON without changing parsed values", () => {
    // C1 CSI/OSC/ST, bidi formats and line separators — everything JSON.stringify leaves literal.
    const title = "build\u009b31m\u009d52;c;ZmFrZQ==\u009c\u202e\u200f\u2028spoof\u2066"
    const json = renderJson([{ title }])
    expect(json).not.toMatch(/[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/)
    expect(json).toContain("\\u009b")
    expect(json).toContain("\\u202e")
    expect(JSON.parse(json)).toEqual([{ title }])
  })

  test("neutralizes terminal control sequences in table group names", () => {
    const unsafe = { ...row, key: "build\u202e\nspoof\u001b]52;c;ZmFrZQ==\u0007\u009b31m" }
    const table = renderUsageReportTable(report("step", [unsafe]))

    expect(table).toContain("build spoof ]52;c;ZmFrZQ== 31m")
    expect(table).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
    expect(table).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/)
  })
})
