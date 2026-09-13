import { describe, expect, test } from "bun:test"

import { filterRunHistory, parseSince, runCreatedAt, usageReport } from "../src/run-history-report"
import type { RunHistoryRecord } from "../src/runs"

const tokens = { input: 2, output: 3, reasoning: 0, cacheRead: 5, cacheWrite: 0, total: 10 }
const run = (overrides: Partial<RunHistoryRecord> = {}): RunHistoryRecord => ({
  runID: "20260910-120000-abcd", title: "run", pipeline: "implement", status: "completed", statusKind: "completed", phases: [
    { name: "implementer", status: "completed", model: "gpt", tokens, cost: 0, advisorCost: 0.25, durationMs: 2_000 },
  ], ...overrides,
})

describe("run history filters", () => {
  test("parses relative and local-date boundaries", () => {
    expect(parseSince("7d", 1_000_000)).toBe(1_000_000 - 604_800_000)
    expect(parseSince("36h", 1_000_000)).toBe(1_000_000 - 129_600_000)
    expect(parseSince("2026-09-10", 0)).toBe(new Date(2026, 8, 10).getTime())
    expect(() => parseSince("soon", 0)).toThrow("invalid --since")
    expect(() => parseSince(`${Number.MAX_SAFE_INTEGER}d`, 0)).toThrow("invalid --since")
  })

  test("filters exact pipeline names and falls back to the local run-id stamp", () => {
    const entries = [run({ createdAt: new Date(2026, 8, 10, 12).getTime() }), run({ pipeline: "review", createdAt: new Date(2026, 8, 1).getTime() })]
    expect(filterRunHistory(entries, { pipeline: "implement" })).toHaveLength(1)
    expect(filterRunHistory(entries, { since: new Date(2026, 8, 5).getTime() })).toHaveLength(1)
    expect(filterRunHistory([run({ createdAt: undefined })], { since: new Date(2026, 8, 10).getTime() })).toHaveLength(1)
  })

  test("keeps unknown dates only when no since filter is requested and includes the boundary", () => {
    const boundary = new Date(2026, 8, 10, 12).getTime()
    const atBoundary = run({ createdAt: boundary })
    const unknown = run({ runID: "legacy-run", createdAt: undefined })

    expect(runCreatedAt(unknown)).toBeUndefined()
    expect(runCreatedAt(run({ runID: "20261340-256199-bad", createdAt: undefined }))).toBeUndefined()
    expect(filterRunHistory([atBoundary, unknown], {})).toEqual([atBoundary, unknown])
    expect(filterRunHistory([atBoundary, unknown], { since: boundary })).toEqual([atBoundary])
  })
})

describe("usage reports", () => {
  test("aggregates phase usage and uses run outcomes for pipeline rows", () => {
    const report = usageReport([run(), run({ runID: "20260911-120000-efgh", statusKind: "failed", phases: [{ name: "implementer", status: "failed", model: "gpt", tokens, cost: Number.NaN, durationMs: 3_000 }] })], "pipeline")
    expect(report).toMatchObject({ dimension: "pipeline", runs: 2 })
    expect(report.rows).toEqual([expect.objectContaining({ key: "implement", runs: 2, phases: 2, completed: 1, failed: 1, cost: 0.25, advisorCost: 0.25, durationMs: 5_000, tokens: { ...tokens, input: 4, output: 6, cacheRead: 10, total: 20 } })])
  })

  test("uses phase outcomes and distinct runs for step rows", () => {
    const report = usageReport([run(), run({ phases: [{ name: "implementer", status: "failed" }, { name: "tests", status: "skipped" }] })], "step")
    expect(report.rows[0]).toMatchObject({ key: "implementer", runs: 1, phases: 2, completed: 1, failed: 1 })
    expect(report.rows[1]).toMatchObject({ key: "tests", runs: 1, phases: 1, completed: 0, failed: 0 })
    // The report's run count is distinct across rows, not the sum of each row's `runs`.
    expect(report.runs).toBe(1)
  })

  test("creates missing-fact and date groups", () => {
    expect(usageReport([run({ pipeline: undefined, phases: [{ name: "x", status: "completed" }] })], "pipeline").rows[0]).toMatchObject({ key: "(none)", runs: 1 })
    expect(usageReport([run({ createdAt: new Date(2026, 8, 10).getTime() })], "day").rows[0]?.key).toBe("2026-09-10")
  })

  test("sums cache usage by model, keeps workspace-less runs, and orders days chronologically", () => {
    const records = [
      run({ runID: "20260911-120000-next", createdAt: new Date(2026, 8, 11).getTime(), phases: [{ name: "measure", status: "completed", model: "gpt", tokens: { ...tokens, cacheRead: 600_000 } }] }),
      run({ runID: "20260910-120000-prev", createdAt: new Date(2026, 8, 10).getTime(), phases: [{ name: "measure", status: "skipped", model: "gpt", tokens: { ...tokens, cacheRead: 400_000 } }] }),
      run({ runID: "20260912-120000-clean", pipeline: undefined, statusKind: "failed", phases: [] }),
    ]

    const byModel = usageReport(records, "model")
    expect(byModel.rows).toEqual([expect.objectContaining({ key: "gpt", runs: 2, phases: 2, completed: 1, failed: 0, tokens: expect.objectContaining({ cacheRead: 1_000_000 }) })])
    // The workspace-less run has no phase, so it contributes to no phase-grained row.
    expect(byModel.runs).toBe(2)
    const byPipeline = usageReport(records, "pipeline")
    expect(byPipeline.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "(none)", runs: 1, phases: 0, completed: 0, failed: 1 }),
    ]))
    expect(byPipeline.runs).toBe(3)
    expect(usageReport(records, "day").rows.map((row) => row.key)).toEqual(["2026-09-10", "2026-09-11", "2026-09-12"])
  })
})
