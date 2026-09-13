import { addTokens, emptyTokens, safeCost } from "./usage"
import type { ProgressTokens } from "./progress"
import type { RunEntry, RunHistoryRecord } from "./runs"

export type RunHistoryFilter = { since?: number; pipeline?: string }
export type UsageReportDimension = "pipeline" | "model" | "step" | "day"

export type UsageReportRow = {
  key: string
  runs: number
  phases: number
  completed: number
  failed: number
  tokens: ProgressTokens
  cost: number
  advisorCost: number
  durationMs: number
}

/** The rows of one dimension plus the distinct runs behind them, which the table's `total` row reports. */
export type UsageReport = { dimension: UsageReportDimension; runs: number; rows: UsageReportRow[] }

export function parseSince(value: string, now: number): number {
  const relative = /^(\d+)([dh])$/.exec(value)
  if (relative) {
    const amount = Number(relative[1])
    const milliseconds = amount * (relative[2] === "d" ? 86_400_000 : 3_600_000)
    const boundary = now - milliseconds
    if (Number.isSafeInteger(amount) && Number.isSafeInteger(milliseconds) && Number.isSafeInteger(boundary)) return boundary
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (date) {
    const parsed = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]))
    if (parsed.getFullYear() === Number(date[1]) && parsed.getMonth() === Number(date[2]) - 1 && parsed.getDate() === Number(date[3])) return parsed.getTime()
  }
  throw new Error(`invalid --since value "${value}"; use <n>d, <n>h, or YYYY-MM-DD`)
}

export function runCreatedAt(entry: Pick<RunEntry, "runID" | "createdAt">): number | undefined {
  if (typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt)) return entry.createdAt
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(entry.runID)
  if (!match) return undefined
  const parts = match.slice(1).map(Number)
  const value = new Date(parts[0]!, parts[1]! - 1, parts[2]!, parts[3]!, parts[4]!, parts[5]!)
  const valid = value.getFullYear() === parts[0]
    && value.getMonth() === parts[1]! - 1
    && value.getDate() === parts[2]
    && value.getHours() === parts[3]
    && value.getMinutes() === parts[4]
    && value.getSeconds() === parts[5]
  return valid ? value.getTime() : undefined
}

export function filterRunHistory<T extends Pick<RunEntry, "runID" | "createdAt" | "pipeline">>(entries: T[], filter: RunHistoryFilter): T[] {
  return entries.filter((entry) => {
    if (filter.pipeline !== undefined && entry.pipeline !== filter.pipeline) return false
    if (filter.since === undefined) return true
    const createdAt = runCreatedAt(entry)
    return createdAt !== undefined && createdAt >= filter.since
  })
}

type Accumulator = UsageReportRow & { runIDs: Set<string> }

export function usageReport(records: RunHistoryRecord[], dimension: UsageReportDimension): UsageReport {
  const groups = new Map<string, Accumulator>()
  const runIDs = new Set<string>()
  for (const record of records) {
    const runKey = dimension === "pipeline" ? record.pipeline ?? "(none)" : dimension === "day" ? dayFor(record) : undefined
    if (runKey !== undefined) {
      const row = getRow(groups, runKey)
      row.runIDs.add(record.runID)
      runIDs.add(record.runID)
      if (record.statusKind === "completed") row.completed += 1
      if (record.statusKind === "failed") row.failed += 1
    }
    for (const phase of record.phases) {
      const key = dimension === "pipeline" ? runKey! : dimension === "model" ? phase.model ?? "(none)" : dimension === "step" ? phase.name : dayFor(record)
      const row = getRow(groups, key)
      row.runIDs.add(record.runID)
      runIDs.add(record.runID)
      row.phases += 1
      if (dimension === "model" || dimension === "step") {
        if (phase.status === "completed") row.completed += 1
        if (phase.status === "failed") row.failed += 1
      }
      row.tokens = addTokens(row.tokens, phase.tokens ?? emptyTokens())
      row.cost += safeCost(phase.cost) + safeCost(phase.advisorCost)
      row.advisorCost += safeCost(phase.advisorCost)
      row.durationMs += safeCost(phase.durationMs)
    }
  }
  const rows = [...groups.values()]
    .map(({ runIDs: rowRunIDs, ...row }) => ({ ...row, runs: rowRunIDs.size }))
    .sort((left, right) => dimension === "day" ? left.key.localeCompare(right.key) : right.tokens.total - left.tokens.total || left.key.localeCompare(right.key))
  return { dimension, runs: runIDs.size, rows }
}

function getRow(groups: Map<string, Accumulator>, key: string): Accumulator {
  let row = groups.get(key)
  if (!row) {
    row = { key, runs: 0, phases: 0, completed: 0, failed: 0, tokens: emptyTokens(), cost: 0, advisorCost: 0, durationMs: 0, runIDs: new Set() }
    groups.set(key, row)
  }
  return row
}

function dayFor(record: Pick<RunEntry, "runID" | "createdAt">): string {
  const created = runCreatedAt(record)
  if (created === undefined) return "(none)"
  const date = new Date(created)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}
