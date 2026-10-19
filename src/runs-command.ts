import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"

import { createControlClient, readControlFile } from "./control-client"
import type { PendingSnapshot } from "./control-server"
import { isControlLive, listRuns, loadRun, probeRunPending, runStatusText, type RunEntry, type RunEntryFinalization, type RunEntryGoal, type RunPhaseInfo } from "./runs"
import { convoyHome, isValidRunID, runsRoot } from "./workspace"

/**
 * The machine-facing side of `convoy runs` (scripts and agent sessions): a
 * stable JSON snapshot of one run or the history, a bounded wait for a run to
 * finish or stop at a gate, and the few answers an agent may give a detached
 * run (approve or deny a permission, abort). The interactive browser in
 * `runs.ts` stays the human surface; this module never opens a terminal UI.
 */

/** Where a run stands, collapsed to what a caller has to act on. */
export type RunState = "running" | "waiting" | "completed" | "failed" | "incomplete" | "unknown"

export type RunWaitingView =
  | {
      kind: "permission"
      requestId: string
      permission: string
      patterns: string[]
      command?: string
      target?: string
      description?: string
      judgeReason?: string
    }
  | { kind: "review"; requestId: string; step: string; error?: string }

export type RunSnapshot = {
  runID: string
  state: RunState
  /** The same status text `convoy runs` prints. */
  status: string
  live: boolean
  title: string
  pipeline?: string
  targetDir?: string
  dir: string
  createdAt?: number
  cost?: number
  phases: RunPhaseInfo[]
  waiting?: RunWaitingView
  goal?: RunEntryGoal
  finalization?: RunEntryFinalization
  /** SUMMARY.md, once the run wrote one. */
  summaryPath?: string
  /** Every phase report on disk, in name order. */
  reports: string[]
  /** The detached coordinator's log, while the pending launch still holds it. */
  logPath?: string
}

export function runStateOf(run: Pick<RunEntry, "live" | "waiting" | "statusKind">): RunState {
  if (run.live) return run.waiting ? "waiting" : "running"
  switch (run.statusKind) {
    case "completed":
      return "completed"
    case "failed":
      return "failed"
    case "incomplete":
      return "incomplete"
    // A run that is gone without recording a single phase never got going.
    case "empty":
      return "failed"
    default:
      return "unknown"
  }
}

export function waitingView(pending: PendingSnapshot | undefined): RunWaitingView | undefined {
  const permission = pending?.permission
  if (permission) {
    return {
      kind: "permission",
      requestId: permission.requestId,
      permission: permission.permission,
      patterns: permission.patterns,
      ...(permission.command ? { command: permission.command } : {}),
      ...(permission.target ? { target: permission.target } : {}),
      ...(permission.description ? { description: permission.description } : {}),
      ...(permission.judgeReason ? { judgeReason: permission.judgeReason } : {}),
    }
  }
  const human = pending?.human
  if (human) return { kind: "review", requestId: human.requestId, step: human.stepName, ...(human.error ? { error: human.error } : {}) }
  return undefined
}

/** The browser's coarse waiting kind for a gate view. */
function waitingKind(view: RunWaitingView | undefined): RunEntry["waiting"] {
  if (!view) return undefined
  return view.kind === "permission" ? "permission" : "review"
}

/** One run as JSON-ready data; `pending` is the live gate snapshot when the caller already has one. */
export async function runSnapshot(run: RunEntry, pending?: PendingSnapshot): Promise<RunSnapshot> {
  const waiting = run.live ? waitingView(pending ?? (await probeRunPending(run.runID))) : undefined
  const summaryPath = join(run.dir, "SUMMARY.md")
  const logPath = run.live ? await findCoordinatorLog(run.runID) : undefined
  return {
    runID: run.runID,
    state: runStateOf({ ...run, waiting: waitingKind(waiting) }),
    status: runStatusText(run),
    live: run.live,
    title: run.title,
    ...(run.pipeline ? { pipeline: run.pipeline } : {}),
    ...(run.targetDir ? { targetDir: run.targetDir } : {}),
    dir: run.dir,
    ...(run.createdAt !== undefined ? { createdAt: run.createdAt } : {}),
    ...(run.cost !== undefined ? { cost: run.cost } : {}),
    phases: run.phases,
    ...(waiting ? { waiting } : {}),
    ...(run.goal ? { goal: run.goal } : {}),
    ...(run.finalization ? { finalization: run.finalization } : {}),
    ...((await isFile(summaryPath)) ? { summaryPath } : {}),
    reports: await listReports(run.dir),
    ...(logPath ? { logPath } : {}),
  }
}

async function listReports(runDir: string): Promise<string[]> {
  try {
    const names = await readdir(join(runDir, "reports"))
    // .raw.md files are forensic copies of rejected deliverables, never reports.
    return names
      .filter((name) => name.endsWith(".md") && !name.endsWith(".raw.md"))
      .sort()
      .map((name) => join(runDir, "reports", name))
  } catch {
    return []
  }
}

/**
 * The log a detached coordinator writes lives in its pending launch dir, which
 * is keyed by launch, not by run: the ready file the coordinator wrote names
 * the run. The dir is swept once the coordinator is gone, so this only finds
 * logs of runs that are still going (or ended since the last launch). The
 * root is coordinate.ts's `pendingRoot()`, spelled out so a status poll never
 * loads the runner.
 */
export async function findCoordinatorLog(runID: string, root = join(convoyHome(), "pending")): Promise<string | undefined> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return undefined
  }
  for (const name of names) {
    try {
      const ready = JSON.parse(await readFile(join(root, name, "ready"), "utf8")) as { runID?: unknown }
      if (ready.runID !== runID) continue
      const logPath = join(root, name, "coordinator.log")
      if (await isFile(logPath)) return logPath
    } catch {
      // Not ready yet, or not a launch dir.
    }
  }
  return undefined
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** `convoy runs --json` / `convoy runs <id> --json`. */
export async function printRunsJson(runID: string | undefined, write: (text: string) => void = (text) => process.stdout.write(text)): Promise<void> {
  if (runID) {
    write(`${JSON.stringify(await runSnapshot(await requireRun(runID)), null, 2)}\n`)
    return
  }
  // The history view stays cheap: no gate probes or report listings per run.
  const runs = await listRuns()
  const rows = runs.map((run) => ({
    runID: run.runID,
    state: runStateOf(run),
    status: runStatusText(run),
    live: run.live,
    title: run.title,
    ...(run.pipeline ? { pipeline: run.pipeline } : {}),
    ...(run.targetDir ? { targetDir: run.targetDir } : {}),
    ...(run.createdAt !== undefined ? { createdAt: run.createdAt } : {}),
    ...(run.cost !== undefined ? { cost: run.cost } : {}),
    ...(run.goal ? { goal: run.goal } : {}),
  }))
  write(`${JSON.stringify(rows, null, 2)}\n`)
}

async function requireRun(runID: string): Promise<RunEntry> {
  const run = await loadRun(runID)
  if (!run) throw new Error(`run ${runID} doesn't exist in ${runsRoot()}`)
  return run
}

/**
 * `--wait`'s exit codes: callers branch on these without parsing output.
 * 0 the run completed, 1 it ended any other way, 2 the wait timed out while
 * the run is still going, 3 the run is stopped at a gate that needs an answer.
 */
export const waitExitCodes = { completed: 0, ended: 1, timeout: 2, waiting: 3 } as const

export function waitExitCode(state: RunState): number {
  if (state === "completed") return waitExitCodes.completed
  if (state === "running") return waitExitCodes.timeout
  if (state === "waiting") return waitExitCodes.waiting
  return waitExitCodes.ended
}

export type WaitDeps = {
  load: (runID: string) => Promise<RunEntry | undefined>
  pending: (runID: string) => Promise<PendingSnapshot | undefined>
  now: () => number
  sleep: (ms: number) => Promise<void>
  write: (text: string) => void
}

const defaultWaitDeps: WaitDeps = {
  load: (runID) => loadRun(runID),
  pending: (runID) => probeRunPending(runID),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  write: (text) => process.stdout.write(text),
}

export type WaitOptions = {
  timeoutMs: number
  json: boolean
  pollMs?: number
}

/**
 * Blocks until the run leaves `running`: it finished, failed, or stopped at a
 * gate that needs an answer, or the timeout passed. Text mode narrates phase
 * changes as they happen, so a caller reading the output sees progress, and
 * ends with the same detail `convoy runs <id>` prints; JSON mode prints one
 * snapshot at the end. Returns the exit code (see `waitExitCodes`).
 */
export async function waitForRun(runID: string, options: WaitOptions, deps: WaitDeps = defaultWaitDeps): Promise<number> {
  const pollMs = options.pollMs ?? 2000
  const deadline = deps.now() + options.timeoutMs
  const seen = new Map<string, string>()
  let first = true
  for (;;) {
    const run = await deps.load(runID)
    if (!run) throw new Error(`run ${runID} doesn't exist in ${runsRoot()}`)
    const pending = run.live ? await deps.pending(runID) : undefined
    const waiting = waitingView(pending)
    const state = runStateOf({ ...run, waiting: waitingKind(waiting) })
    if (!options.json) {
      for (const phase of run.phases) {
        if (seen.get(phase.name) === phase.status) continue
        seen.set(phase.name, phase.status)
        // The first pass reports where the run already is, not every phase it ever passed.
        if (first && phase.status !== "running") continue
        deps.write(`[${phase.name}] ${phase.status}${phase.cost !== undefined ? ` · $${phase.cost.toFixed(4)}` : ""}\n`)
      }
    }
    first = false
    if (state !== "running" || deps.now() >= deadline) {
      if (options.json) deps.write(`${JSON.stringify(await runSnapshot(run, pending), null, 2)}\n`)
      else deps.write(waitResultText(run, state, waiting))
      return waitExitCode(state)
    }
    await deps.sleep(Math.min(pollMs, Math.max(0, deadline - deps.now())))
  }
}

function waitResultText(run: RunEntry, state: RunState, waiting: RunWaitingView | undefined): string {
  const lines = [`run ${run.runID}: ${state === "running" ? "still running (wait timed out)" : runStatusText({ ...run, waiting: waitingKind(waiting) })}`]
  if (run.cost !== undefined) lines.push(`cost: $${run.cost.toFixed(4)}`)
  if (waiting?.kind === "permission") {
    // Patterns usually restate the command; show them only when they add something.
    const patterns = waiting.patterns.filter((pattern) => pattern !== waiting.command)
    lines.push(`permission request ${waiting.requestId}: ${waiting.permission}${waiting.command ? ` · ${waiting.command}` : ""}${patterns.length ? ` · ${patterns.join(", ")}` : ""}`)
    if (waiting.description) lines.push(`  ${waiting.description}`)
    lines.push(`answer: convoy runs ${run.runID} approve ${waiting.requestId} [--always] | convoy runs ${run.runID} deny ${waiting.requestId}`)
  } else if (waiting?.kind === "review") {
    lines.push(`human gate at ${waiting.step}${waiting.error ? `: ${waiting.error}` : ""}; open \`convoy runs ${run.runID}\` in a terminal to answer it, or abort with \`convoy runs ${run.runID} abort\``)
  } else if (state === "running") {
    lines.push(`wait again: convoy runs ${run.runID} --wait`)
  } else {
    lines.push(`details: convoy runs ${run.runID}`)
  }
  return `${lines.join("\n")}\n`
}

/** Parses `90`, `90s`, `10m`, or `1h` into milliseconds. */
export function parseDuration(value: string, flag: string): number {
  const match = /^([0-9]+)(s|m|h)?$/.exec(value.trim())
  if (!match) throw new Error(`${flag} must be a duration like 90s, 10m, or 1h`)
  const amount = parseInt(match[1]!, 10)
  const unit = match[2] ?? "s"
  const ms = amount * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1000)
  if (ms <= 0) throw new Error(`${flag} must be longer than zero`)
  return ms
}

export type RunAction = { kind: "approve"; requestId: string; always: boolean } | { kind: "deny"; requestId: string } | { kind: "abort" }

/**
 * Answers a detached run the way the dashboard would: claim the controller
 * slot, act, release it. A dashboard already holding the slot wins, since two
 * controllers answering the same gate is exactly what the slot prevents.
 * Approve and deny name the request they answer, so a caller never approves a
 * request it hasn't seen.
 */
export async function runAction(runID: string, action: RunAction, write: (text: string) => void = (text) => process.stdout.write(text)): Promise<void> {
  const control = await readControlFile(runID)
  if (!control || !(await isControlLive(control))) throw new Error(`run ${runID} is not running; nothing to answer`)
  const client = createControlClient(control)
  if ((await client.claimController()) !== "controller") {
    throw new Error(`a dashboard is attached to run ${runID}; answer it there or close it first`)
  }
  try {
    if (action.kind === "abort") {
      await client.abort()
      write(`run ${runID}: abort requested\n`)
      return
    }
    const permission = (await client.pending()).permission
    if (permission?.requestId !== action.requestId) {
      throw new Error(
        permission
          ? `run ${runID} is waiting on permission request ${permission.requestId}, not ${action.requestId}`
          : `run ${runID} has no pending permission request ${action.requestId}`,
      )
    }
    const reply = action.kind === "deny" ? "reject" : action.always ? "always" : "once"
    await client.permission(action.requestId, reply)
    write(`run ${runID}: ${action.kind === "deny" ? "denied" : action.always ? "approved (always)" : "approved"} ${permission.permission} request ${action.requestId}\n`)
  } finally {
    await client.bye().catch(() => {})
  }
}

export function runsHelp(): string {
  return `convoy runs [run-id] [--json] [--wait [--timeout <duration>]]
convoy runs <run-id> approve <request-id> [--always]
convoy runs <run-id> deny <request-id>
convoy runs <run-id> abort

Browse run history (interactive), or print it for scripts and agents.

Options:
  --json                   Print the history, or one run, as JSON: state (running, waiting,
                           completed, failed, incomplete, unknown), phases, cost, the pending
                           permission request, SUMMARY.md and report paths, and the log path
  --wait                   Block until the run completes, fails, stops at a gate, or the
                           timeout passes; text mode prints phase changes as they happen
  --timeout <duration>     How long --wait blocks (default 5m): 90s, 10m, 1h

--wait exit codes:
  0  the run completed
  1  the run ended any other way (failed, aborted, interrupted)
  2  the timeout passed while the run is still going: wait again
  3  the run is waiting for an answer (a permission request or a human gate)

Answers:
  approve <request-id>     Allow the pending permission request once (--always: for the run)
  deny <request-id>        Reject the pending permission request
  abort                    Stop the run; resume it later with convoy --resume <run-id>

Answers act as the run's controller for one request, so they refuse while a
dashboard is attached. Request ids come from --json (waiting.requestId) or --wait.
`
}

export type RunsCommand =
  | { kind: "browse"; runID?: string }
  | { kind: "json"; runID?: string }
  | { kind: "wait"; runID: string; timeoutMs: number; json: boolean }
  | { kind: "action"; runID: string; action: RunAction }

/** Parses everything after `convoy runs`. */
export function parseRunsArgs(argv: string[]): RunsCommand {
  const positional: string[] = []
  let json = false
  let wait = false
  let always = false
  let timeoutMs: number | undefined
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!
    const eq = raw.indexOf("=")
    const flag = raw.startsWith("--") && eq !== -1 ? raw.slice(0, eq) : raw
    const inline = raw.startsWith("--") && eq !== -1 ? raw.slice(eq + 1) : undefined
    switch (flag) {
      case "--json":
        json = true
        break
      case "--wait":
        wait = true
        break
      case "--always":
        always = true
        break
      case "--timeout": {
        const value = inline ?? argv[++i]
        if (value === undefined) throw new Error("--timeout requires a value")
        timeoutMs = parseDuration(value, "--timeout")
        break
      }
      default:
        if (raw.startsWith("-")) throw new Error(`unknown flag: ${flag}\n\n${runsHelp()}`)
        positional.push(raw)
    }
  }

  const [runID, verb, requestId, ...extra] = positional
  if (runID !== undefined && !isValidRunID(runID)) throw new Error(`invalid run id: ${runID}`)
  if (verb !== undefined) {
    if (json || wait || timeoutMs !== undefined) throw new Error(`convoy runs <id> ${verb} takes no --json, --wait, or --timeout`)
    if (verb === "abort") {
      if (requestId !== undefined || always) throw new Error("usage: convoy runs <run-id> abort")
      return { kind: "action", runID: runID!, action: { kind: "abort" } }
    }
    if (verb !== "approve" && verb !== "deny") throw new Error(`usage: convoy runs <run-id> approve|deny <request-id> | abort (unknown action "${verb}")`)
    if (requestId === undefined || extra.length > 0) throw new Error(`usage: convoy runs <run-id> ${verb} <request-id>${verb === "approve" ? " [--always]" : ""}`)
    if (verb === "deny") {
      if (always) throw new Error("--always only applies to approve")
      return { kind: "action", runID: runID!, action: { kind: "deny", requestId } }
    }
    return { kind: "action", runID: runID!, action: { kind: "approve", requestId, always } }
  }
  if (always) throw new Error("--always only applies to approve")
  if (wait) {
    if (runID === undefined) throw new Error("--wait needs a run id: convoy runs <run-id> --wait")
    return { kind: "wait", runID, timeoutMs: timeoutMs ?? 5 * 60_000, json }
  }
  if (timeoutMs !== undefined) throw new Error("--timeout only applies to --wait")
  if (json) return { kind: "json", ...(runID ? { runID } : {}) }
  return { kind: "browse", ...(runID ? { runID } : {}) }
}
