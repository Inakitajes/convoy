import { connect } from "node:net"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { stdin, stdout } from "node:process"

import { readControlFile } from "./control-client"
import type { PendingSnapshot } from "./control-server"
import { readRunMetadata, type GoalRunState, type PhaseMetadataStatus, type RunMetadata } from "./metadata"
import { isValidRunID, convoyHome, runsRoot } from "./workspace"
import { readAdvisorSplit } from "./advisor-report"
import type { TuiRoute } from "./tui-session"

export type RunStatusKind = "completed" | "failed" | "incomplete" | "empty" | "unknown"

export type RunPhaseInfo = {
  name: string
  status: PhaseMetadataStatus
  durationMs?: number
  cost?: number
  advisorCost?: number
  model?: string
}

export type RunEntry = {
  runID: string
  dir: string
  title: string
  targetDir?: string
  status: string
  statusKind: RunStatusKind
  /** The run's opencode server is still up (its process is alive and the port answers): attach shows it live. */
  live: boolean
  /** The live server URL, present only when `live`. */
  serverUrl?: string
  /** A live coordinated run is parked on a gate nobody answered yet. */
  waiting?: "permission" | "review"
  cost?: number
  executorCost?: number
  advisorCost?: number
  createdAt?: number
  phases: RunPhaseInfo[]
  /** The durable goal-cycle record exposed to run history (schema-v4 goal runs only). */
  goal?: RunEntryGoal
  /**
   * The automatic run-compaction outcome (capability run-finalization), merged
   * from the run's metadata and its cleanup-surviving run-record index entry.
   * Carries the recovery-evidence pointers the historical views quote as exact
   * Git inspection commands.
   */
  finalization?: RunEntryFinalization
  /**
   * The durable feature link (capability feature-lifecycle, task 5.1/SC-6):
   * the run's stable feature identity, surfaced from the cleanup-surviving
   * run-record index so board, attach, and history join by identity rather
   * than reinterpreting the stored worktree path as today's branch. Absent
   * for legacy or no-spec runs.
   */
  feature?: RunEntryFeatureLink
}

/** The feature identity a run is linked to, as preserved in run history. */
export type RunEntryFeatureLink = {
  featureId: string
  associationRevision: number
  branch: string
  baseRef: string
  contracts: readonly string[]
}

/** The finalization facts run history presents, from durable records only. */
export type RunEntryFinalization = {
  state: string
  reason?: string
  /** The single operator-authored commit compaction produced, when any. */
  producedSha?: string
  /** The protected ref holding the pre-compaction tip. */
  recoveryRef?: string
  /** The recovery manifest in the repository's Git common dir. */
  manifestPath?: string
  /** HEAD at run start and immediately before compaction: the endpoint pair. */
  startHead?: string
  preCompactionHead?: string
  disposition?: string
}

/**
 * The cleanup-surviving run-record index (design D3, task 1.5):
 * `<convoy-home>/run-records/<run-id>.json`. Written by finalization, read here
 * so deleting a disposable run workspace cannot delete the run's discoverable
 * history or its recovery evidence.
 */
export type RunIndexRecord = {
  runID: string
  title?: string
  summary?: string
  worktreeDir?: string
  branch?: string
  manifestPath?: string
  startHead?: string
  preCompactionHead?: string
  producedSha?: string
  disposition?: string
  state?: string
  reason?: string
  /** The protected ref holding the pre-compaction tip. */
  recoveryRef?: string
  /**
   * The reviewed feature link, preserved through workspace cleanup (task
   * 5.1): history joins by stable identity, never by reinterpreting the
   * stored worktree path as today's branch.
   */
  feature?: { featureId: string; associationRevision: number; branch: string; baseRef: string; contracts: readonly string[] }
}

/** Reads one run-record index entry; undefined when absent or malformed. */
export async function readRunIndexEntry(runID: string): Promise<RunIndexRecord | undefined> {
  let raw: string
  try {
    raw = await readFile(join(convoyHome(), "run-records", `${runID}.json`), "utf8")
  } catch {
    return undefined
  }
  return parseRunIndexRecord(raw, runID)
}

/** Reads every run-record index entry, skipping malformed files. */
export async function listRunIndexRecords(): Promise<RunIndexRecord[]> {
  let names: string[]
  try {
    names = await readdir(join(convoyHome(), "run-records"))
  } catch {
    return []
  }
  const records = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map((name) => readRunIndexEntry(name.slice(0, -".json".length))),
  )
  return records.filter((record): record is RunIndexRecord => record !== undefined)
}

function parseRunIndexRecord(raw: string, runID: string): RunIndexRecord | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (typeof value !== "object" || value === null) return undefined
    const finalization = isRecordOf(value.finalization) ? value.finalization : undefined
    const record: RunIndexRecord = {
      runID: typeof value.runID === "string" && value.runID ? value.runID : runID,
      ...(typeof value.title === "string" && value.title ? { title: value.title } : {}),
      ...(typeof value.summary === "string" && value.summary ? { summary: value.summary } : {}),
      ...(typeof value.worktreeDir === "string" && value.worktreeDir ? { worktreeDir: value.worktreeDir } : {}),
      ...(typeof value.branch === "string" && value.branch ? { branch: value.branch } : {}),
      ...(typeof value.manifestPath === "string" && value.manifestPath ? { manifestPath: value.manifestPath } : {}),
      ...(typeof value.startHead === "string" && value.startHead ? { startHead: value.startHead } : {}),
      ...(typeof value.preCompactionHead === "string" && value.preCompactionHead ? { preCompactionHead: value.preCompactionHead } : {}),
      ...(typeof value.producedSha === "string" && value.producedSha ? { producedSha: value.producedSha } : {}),
      ...(typeof value.disposition === "string" && value.disposition ? { disposition: value.disposition } : {}),
      ...(typeof value.recoveryRef === "string" && value.recoveryRef ? { recoveryRef: value.recoveryRef } : {}),
    }
    if (finalization) {
      if (typeof finalization.state === "string") record.state = finalization.state
      if (typeof finalization.reason === "string") record.reason = finalization.reason
    } else if (typeof value.state === "string") {
      record.state = value.state
    }
    // The feature link survives cleanup as a plain object; a malformed one is
    // dropped rather than interpreted (readers never invent identity).
    if (typeof value.feature === "object" && value.feature !== null && typeof (value.feature as Record<string, unknown>).featureId === "string") {
      const raw = value.feature as Record<string, unknown>
      record.feature = {
        featureId: raw.featureId as string,
        ...(typeof raw.associationRevision === "number" ? { associationRevision: raw.associationRevision } : { associationRevision: 0 }),
        ...(typeof raw.branch === "string" ? { branch: raw.branch } : { branch: "" }),
        ...(typeof raw.baseRef === "string" ? { baseRef: raw.baseRef } : { baseRef: "" }),
        contracts: Array.isArray(raw.contracts) ? raw.contracts.filter((entry): entry is string => typeof entry === "string") : [],
      }
    }
    return record
  } catch {
    return undefined
  }
}

function isRecordOf(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Merges the run's durable feature link from the cleanup-surviving index record. */
function featureLinkOf(index: RunIndexRecord | undefined): RunEntryFeatureLink | undefined {
  const feature = index?.feature
  if (!feature) return undefined
  return {
    featureId: feature.featureId,
    associationRevision: feature.associationRevision,
    branch: feature.branch,
    baseRef: feature.baseRef,
    contracts: feature.contracts,
  }
}

/** Merges the run's durable finalization outcome into the entry's presentation shape. */
function finalizationInfo(metadata: RunMetadata | undefined, index: RunIndexRecord | undefined): RunEntryFinalization | undefined {
  const record = metadata?.finalization
  const state = record?.state ?? index?.state
  if (!state) return undefined
  const reason = record?.reason ?? index?.reason
  const producedSha = record?.producedSha ?? index?.producedSha
  const manifestPath = record?.manifestPath ?? index?.manifestPath
  const recoveryRef = record?.recoveryRef ?? index?.recoveryRef
  return {
    state,
    ...(reason ? { reason } : {}),
    ...(producedSha ? { producedSha } : {}),
    ...(recoveryRef ? { recoveryRef } : {}),
    ...(manifestPath ? { manifestPath } : {}),
    ...(index?.startHead ? { startHead: index.startHead } : {}),
    ...(index?.preCompactionHead ? { preCompactionHead: index.preCompactionHead } : {}),
    ...(index?.disposition ? { disposition: index.disposition } : {}),
  }
}

/** The goal-cycle facts run history presents, derived from the durable metadata record. */
export type RunEntryGoal = {
  target: number
  /** The measurement round the run is in (0 for the opening measurement). */
  iteration: number
  stage: string
  /** The most recent authoritative score. */
  score?: number
  /** Numeric trajectory of every completed measurement, oldest first. */
  trajectory?: number[]
  outcome?: string
  restored?: boolean
}

export type RunsResolution =
  | { type: "exit" }
  | { type: "resume"; runID: string; targetDir?: string }
  // Re-enter a run's dashboard: attach to it live if its server is up, else
  // reconstruct the finish screen from metadata + reports.
  | { type: "open"; runID: string; targetDir?: string }
  // Retry: start a brand-new run from step 0 using the selected run's original
  // prompt and pipeline config — a fresh copy, not a resume of the old run.
  | { type: "retry"; runID: string; targetDir?: string }

export async function listRuns(root = runsRoot()): Promise<RunEntry[]> {
  const [workspaceRuns, indexRecords] = await Promise.all([listWorkspaceRuns(root), listRunIndexRecords()])
  return mergeRunRecords(workspaceRuns, indexRecords, root)
}

/** The runs that still have workspace metadata on disk. */
async function listWorkspaceRuns(root: string): Promise<RunEntry[]> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  // Run IDs start with the wall-clock timestamp, so lexicographic order is chronological.
  const ids = names.filter(isValidRunID).sort().reverse()
  return Promise.all(ids.map((runID) => loadRunEntry(root, runID)))
}

/**
 * Merges workspace runs with the cleanup-surviving run-record index (task 1.5):
 * a run whose disposable workspace was deleted stays discoverable through its
 * index record, with its finalization evidence and inspection commands intact.
 */
function mergeRunRecords(workspaceRuns: RunEntry[], indexRecords: RunIndexRecord[], root: string): RunEntry[] {
  const known = new Set(workspaceRuns.map((run) => run.runID))
  const indexedOnly = indexRecords
    .filter((record) => isValidRunID(record.runID) && !known.has(record.runID))
    .map((record) => runEntryFromIndexRecord(record, root))
  return [...workspaceRuns, ...indexedOnly].sort((a, b) => b.runID.localeCompare(a.runID))
}

/** A run known only through its run-record index entry: metadata is gone, evidence is not. */
function runEntryFromIndexRecord(record: RunIndexRecord, root: string): RunEntry {
  const failed = record.state === "failed"
  return {
    runID: record.runID,
    dir: join(root, record.runID),
    // The persisted title is exact in the record; the list truncates for display.
    title: truncate(record.title ?? record.summary ?? "(run workspace cleaned; evidence retained)", 60),
    targetDir: record.worktreeDir,
    status: failed ? "compaction failed" : "completed",
    statusKind: failed ? "failed" : "completed",
    live: false,
    phases: [],
    finalization: finalizationInfo(undefined, record),
    ...(featureLinkOf(record) ? { feature: featureLinkOf(record) } : {}),
  }
}

/** Interactive run-history browser: pick a run, then resume it, read its reports, or open a subshell in its dir. */
export async function browseRuns(initialRunID?: string, route?: TuiRoute): Promise<RunsResolution> {
  const runs = await listRuns()
  if (runs.length === 0) {
    if (route) {
      const { showNoticeTui } = await import("./notice-tui")
      await showNoticeTui(route, { title: "runs", message: `No runs found in ${runsRoot()}` })
      return { type: "exit" }
    }
    stdout.write(`no runs found in ${runsRoot()}\n`)
    return { type: "exit" }
  }

  let initialIndex = 0
  if (initialRunID) {
    initialIndex = runs.findIndex((run) => run.runID === initialRunID)
    if (initialIndex === -1) throw new Error(`run ${initialRunID} doesn't exist in ${runsRoot()}`)
  }

  // Pipes and CI get the plain listing; the browser needs a real terminal.
  if (!stdin.isTTY || !stdout.isTTY) {
    printRunList(runs)
    return { type: "exit" }
  }

  // Dynamic import keeps opentui out of non-interactive invocations (same
  // reason progress.ts lazy-loads the run TUI).
  const { browseRunsTui } = await import("./runs-tui")
  return browseRunsTui(runs, initialIndex, route)
}

/** SUMMARY.md when the run finished; otherwise whatever phase reports landed before it died. */
export async function loadRunSummary(run: RunEntry): Promise<string> {
  const summary = await readIfExists(join(run.dir, "SUMMARY.md"))
  let body: string
  if (summary !== undefined) {
    body = summary
  } else {
    let reports: string[] = []
    try {
      // Forensic copies of rejected deliverables (persistInvalidPhaseReport) end
      // in .raw.md; they must never render as phase reports in the summary.
      reports = (await readdir(join(run.dir, "reports"))).filter((name) => name.endsWith(".md") && !name.endsWith(".raw.md")).sort()
    } catch {
      // no reports dir
    }
    if (reports.length === 0) {
      body = run.finalization ? "" : "no summary or reports for this run"
    } else {
      const sections: string[] = []
      for (const name of reports) {
        const evidence = await readIfExists(join(run.dir, "reports", name))
        if (evidence !== undefined) sections.push(`## reports/${name}\n\n${evidence.trim()}`)
      }
      body = sections.join("\n\n")
    }
  }
  return [body.trim(), recoveryEvidenceSection(run)].filter(Boolean).join("\n\n")
}

/**
 * The run's durable recovery evidence, quoted as exact local Git commands
 * (capability run-finalization, design D3, task 1.5). The commands inspect the
 * retained endpoints; recovery is a new branch from the protected tip — never
 * an unconditional hard reset of a branch that may have advanced.
 */
function recoveryEvidenceSection(run: RunEntry): string {
  const f = run.finalization
  if (!f) return ""
  const lines = ["## Recovery evidence", "", `- Run compaction: ${f.state}${f.disposition ? ` (${f.disposition})` : ""}`]
  if (f.reason) lines.push(`- Reason: ${f.reason}`)
  if (f.producedSha) lines.push(`- Resulting commit: ${f.producedSha}`)
  if (f.startHead && f.preCompactionHead) {
    lines.push(`- Replaced interval endpoints: ${f.startHead.slice(0, 12)} → ${f.preCompactionHead.slice(0, 12)}`)
    lines.push("- Inspect the run's original intermediate history:", "", "  ```", `  git diff ${f.startHead} ${f.preCompactionHead}`, "  ```")
  }
  if (f.producedSha) {
    lines.push("- Inspect the resulting compacted commit:", "", "  ```", `  git show ${f.producedSha}`, "  ```")
  }
  if (f.recoveryRef) {
    lines.push(
      "- Recover the original commits on a new branch (nothing is reset):",
      "",
      "  ```",
      `  git branch recover/${run.runID} ${f.recoveryRef}`,
      "  ```",
    )
  }
  if (f.manifestPath) lines.push(`- Recovery manifest: ${f.manifestPath}`)
  return lines.join("\n")
}

async function loadRunEntry(root: string, runID: string): Promise<RunEntry> {
  const dir = join(root, runID)
  const metadata = await readRunMetadata(join(dir, "metadata.json"))
  const indexRecord = await readRunIndexEntry(runID)
  const summary = statusSummary(metadata)
  const serverLive = await isServerLive(metadata?.server)
  const control = await readControlFile(runID, root)
  const coordinatorLive = control ? await isControlLive(control) : false
  const live = serverLive || coordinatorLive
  const split = await readAdvisorSplit(dir)
  const executorCost = totalCost(metadata, split.executorPhases) ?? (split.executor.cost > 0 ? split.executor.cost : undefined)
  const advisorCost = split.advisor.cost
  const goal = metadata?.goal
  const finalization = finalizationInfo(metadata, indexRecord)
  // Capability run-titles: the persisted title wins over the prompt-derived
  // fallback, and the runs list keeps its 60-column display truncation either
  // way. The stored value itself stays untruncated in the record.
  const storedTitle = metadata?.title?.trim()
  return {
    runID,
    dir,
    title: truncate(storedTitle || (await runTitle(dir)), 60),
    targetDir: metadata?.targetDir,
    status: summary.label,
    statusKind: summary.kind,
    live,
    serverUrl: serverLive ? metadata?.server?.url : undefined,
    // Coordinated runs stay live through the control server even when the
    // per-iteration OpenCode server is down between goal-loop iterations;
    // only then is the waiting probe worth paying for.
    waiting: live ? await probeRunWaiting(runID, root) : undefined,
    cost: executorCost === undefined && advisorCost === 0 ? undefined : (executorCost ?? 0) + advisorCost,
    executorCost,
    advisorCost,
    createdAt: metadata?.createdAt,
    phases: phaseInfos(metadata),
    ...(goal ? { goal: goalInfo(goal) } : {}),
    ...(finalization ? { finalization } : {}),
    ...(featureLinkOf(indexRecord) ? { feature: featureLinkOf(indexRecord) } : {}),
  }
}

/** A goal run's history facts, all derived from the durable record. */
function goalInfo(goal: GoalRunState): RunEntryGoal {
  return {
    target: goal.target,
    iteration: goal.iteration,
    stage: goal.stage,
    ...(goal.scores.length > 0
      ? {
          score: goal.scores[goal.scores.length - 1]!.score,
          trajectory: goal.scores.map((entry) => entry.score),
        }
      : {}),
    ...(goal.outcome ? { outcome: goal.outcome } : {}),
    ...(goal.restored !== undefined ? { restored: goal.restored } : {}),
  }
}

/** What a live run is parked on, for the runs browser's "waiting" details line. */
export async function probeRunWaiting(runID: string, root = runsRoot()): Promise<"permission" | "review" | undefined> {
  const control = await readControlFile(runID, root)
  if (!control) return undefined
  try {
    const response = await fetch(`${control.url}/pending`, {
      headers: { authorization: `Bearer ${control.token}` },
      // A wedged-but-listening coordinator must not stall the run list.
      signal: AbortSignal.timeout(500),
    })
    if (!response.ok) return undefined
    const snapshot = (await response.json()) as PendingSnapshot
    if (snapshot.permission) return "permission"
    if (snapshot.human) return "review"
    return undefined
  } catch {
    return undefined
  }
}

/** Re-probes a live run's pending gate so an open browser can show waiting state as it changes. */
export async function refreshRunWaiting(run: RunEntry, root = runsRoot()): Promise<void> {
  if (!run.live) {
    run.waiting = undefined
    return
  }
  run.waiting = await probeRunWaiting(run.runID, root)
}

// A run is live if its recorded server process is still alive and its port
// answers. The pid check is instant and rules out crashed runs (whose stale
// server entry outlived them); the TCP probe confirms the port is really up
// and guards against the rare pid reuse. Only runs that recorded a server —
// and cleared it on clean shutdown — ever reach the probe.
export async function isServerLive(server: RunMetadata["server"]): Promise<boolean> {
  if (!server || !pidAlive(server.pid)) return false
  return tcpReachable(server.url, 250)
}

/**
 * Whether a coordinated run is live through its control server. The
 * coordinator outlives every per-iteration OpenCode server, so this (not
 * `isServerLive`) is what "the run is still going" means mid-goal-loop.
 */
export async function isControlLive(control: { url: string; pid: number }, timeoutMs = 250): Promise<boolean> {
  return pidAlive(control.pid) && (await tcpReachable(control.url, timeoutMs))
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to another user — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function tcpReachable(url: string, timeoutMs: number): Promise<boolean> {
  let host: string
  let port: number
  try {
    const parsed = new URL(url)
    host = parsed.hostname
    port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80)
  } catch {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const settle = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => settle(true))
    socket.once("timeout", () => settle(false))
    socket.once("error", () => settle(false))
  })
}

/** The legacy prompt-document first-line fallback for records without a persisted title (capability run-titles). */
async function runTitle(dir: string) {
  const prd = await readIfExists(join(dir, "prd.md"))
  if (prd === undefined) return "(no prd)"
  const line = prd
    .split("\n")
    .map((raw) => raw.replace(/^#+\s*/, "").trim())
    .find(Boolean)
  return truncate(line ?? "(empty prd)", 60)
}

// Only phases that started get an entry, so the totals describe what the run
// recorded, not the full pipeline. Pre-metadata runs show "-".
function statusSummary(metadata: RunMetadata | undefined): { label: string; kind: RunStatusKind } {
  if (!metadata) return { label: "-", kind: "unknown" }
  const statuses = Object.values(metadata.phases).map((phase) => phase.status)
  if (statuses.length === 0) return { label: "empty", kind: "empty" }
  const done = statuses.filter((status) => status === "completed" || status === "skipped").length
  if (statuses.some((status) => status === "failed")) return { label: `failed (${done}/${statuses.length} ok)`, kind: "failed" }
  if (done === statuses.length) return { label: "completed", kind: "completed" }
  return { label: `incomplete (${done}/${statuses.length})`, kind: "incomplete" }
}

function totalCost(metadata: RunMetadata | undefined, loggedPhaseCosts: Record<string, number> | undefined) {
  if (!metadata && !loggedPhaseCosts) return undefined
  let cost = 0
  let seen = false
  for (const [name, phase] of Object.entries(metadata?.phases ?? {})) {
    if (typeof phase.cost === "number") {
      cost += phase.cost
      seen = true
    }
  }
  for (const [name, costFromLogs] of Object.entries(loggedPhaseCosts ?? {})) {
    // Metadata holds the authoritative total for phases it has recorded. Its
    // attempt logs would otherwise count that phase twice.
    if (typeof metadata?.phases[name]?.cost === "number") continue
    cost += costFromLogs
    seen = true
  }
  return seen ? cost : undefined
}

function phaseInfos(metadata: RunMetadata | undefined): RunPhaseInfo[] {
  if (!metadata) return []
  return Object.entries(metadata.phases).map(([name, phase]) => ({
    name,
    status: phase.status,
    durationMs: phase.durationMs,
    cost: phase.cost,
    advisorCost: phase.advisor?.cost,
    model: phase.model,
  }))
}

function printRunList(runs: RunEntry[]) {
  const statusText = (run: RunEntry) => {
    const base = run.live ? (run.waiting ? `running · waiting for a ${run.waiting === "permission" ? "permission" : "review"}` : "running") : run.status
    // Surface the compaction outcome next to the pipeline status: a blocked or
    // failed compaction must never read as an unqualified clean finish.
    if (run.finalization && run.finalization.state !== "completed") {
      return `${base} · compaction ${run.finalization.state}`
    }
    return base
  }
  const goalText = (run: RunEntry) => {
    if (!run.goal) return ""
    const trajectory = run.goal.trajectory ? ` · ${run.goal.trajectory.join(" → ")}` : ""
    return ` · goal ${run.goal.target}${run.goal.outcome ? ` ${run.goal.outcome}` : ` ${run.goal.stage}`}${trajectory}`
  }
  const numberWidth = String(runs.length).length
  const statusWidth = Math.max(...runs.map((run) => statusText(run).length))
  stdout.write(`\nruns in ${runsRoot()}:\n`)
  for (const [index, run] of runs.entries()) {
    const number = String(index + 1).padStart(numberWidth)
    const cost = (run.cost !== undefined ? `$${run.cost.toFixed(2)}${run.advisorCost ? ` (${run.executorCost?.toFixed(2) ?? "0.00"}+${run.advisorCost.toFixed(2)} adv)` : ""}` : "").padStart(8)
    const marker = run.live ? "●" : " "
    stdout.write(`  ${number}. ${marker} ${run.runID}  ${statusText(run).padEnd(statusWidth)}${goalText(run)}  ${cost}  ${run.title}\n`)
  }
}

async function readIfExists(path: string) {
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

function truncate(value: string, max: number) {
  const singleLine = value.replace(/\s+/g, " ").trim()
  if (singleLine.length <= max) return singleLine
  return `${singleLine.slice(0, Math.max(0, max - 3))}...`
}
