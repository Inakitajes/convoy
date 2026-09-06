import { closeSync, openSync } from "node:fs"
import { mkdir, open, readFile, readdir, rm, stat, writeFile, type FileHandle } from "node:fs/promises"
import { join, resolve, sep } from "node:path"

import { startControlServer } from "./control-server"
import { ControlProgress, type ControlProgressOptions } from "./control-progress"
import { hasWritableStep } from "./pipeline"
import { pidAlive } from "./runs"
import { hostedTeardownFromError, isUserAbortError, run } from "./runner"
import { isOfficialStandaloneExecutable } from "./update"
import { convoyHome } from "./workspace"
import type { RunOptions, RunPlan } from "./types"

/**
 * The coordinator split: a production CLI run writes a launch file and spawns
 * a detached `--coordinate` process; that process serves the control server and
 * runs `run()` with a ControlProgress adapter instead of a
 * TUI. The ready file is the parent's handshake that the control plane is up.
 */

export type LaunchFile = {
  schemaVersion: 1
  /** The full reviewed run options minus functions (progress is stripped). */
  options: RunOptions
  plan?: RunPlan
}

export type PendingLaunch = {
  dir: string
  launchPath: string
  readyPath: string
  logPath: string
}

export type CoordinateReady = {
  runID: string
  controlUrl: string
}

/**
 * Spawn argv for the coordinator: the same binary, tail-fixed with the
 * internal `--coordinate` flag. A standalone release executable runs
 * `execPath --coordinate <launch>`; a source checkout re-invokes this script
 * with its node args preserved (`bun run src/main.ts --coordinate <launch>`).
 */
export function convoyCoordinateArgv(launchPath: string): string[] {
  if (isOfficialStandaloneExecutable()) return [process.execPath, "--coordinate", launchPath]
  return [process.execPath, ...process.execArgv, process.argv[1], "--coordinate", launchPath]
}

export function pendingRoot(): string {
  return join(convoyHome(), "pending")
}

/** Strips functions so the launch payload survives JSON round-tripping. */
export function launchPayload(options: RunOptions, plan: RunPlan | undefined): LaunchFile {
  const { progress: _progress, ...rest } = options
  return {
    schemaVersion: 1,
    options: rest,
    ...(plan ? { plan } : {}),
  }
}

export async function writePendingLaunch(payload: LaunchFile, root = pendingRoot()): Promise<PendingLaunch> {
  const id = crypto.randomUUID()
  const dir = join(root, id)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const launchPath = join(dir, "launch.json")
  await writeFile(launchPath, JSON.stringify(payload, null, 2), { mode: 0o600 })
  // Orphaned pending dirs (launch payload + coordinator log) are bounded by a
  // sweep on every new launch; it is fire-and-forget so spawn latency doesn't
  // pay for the cleanup.
  void sweepPendingLaunches(root).catch(() => {})
  return { dir, launchPath, readyPath: join(dir, "ready"), logPath: join(dir, "coordinator.log") }
}

/** How long a pid-less pending dir survives the sweep: the parent writes the pid right after spawn, so anything older was orphaned before that. */
const noPidFileGraceMs = 60 * 60 * 1000

/**
 * Deletes pending launch dirs whose coordinator is gone. A dir with a live
 * pid keeps its log (that pid's stdout is still being written to it); a dir
 * with a dead pid is an orphan — its launch payload (full RunOptions,
 * including hook commands) and log have no reason to linger. A dir without a
 * pid file is either mid-spawn (the parent writes the pid right after spawn)
 * or ancient; only the ancient ones go.
 */
export async function sweepPendingLaunches(root = pendingRoot()): Promise<void> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return
  }
  for (const name of names) {
    // Only the uuid-shaped dirs we create; never touch anything else there.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)) continue
    const dir = join(root, name)
    try {
      // A missing pid file (ENOENT) is not an error: it is either a dir whose
      // parent is still between launch and spawn, or an ancient orphan.
      let pid: number | undefined
      try {
        pid = parseInt(await readFile(join(dir, "pid"), "utf8"), 10)
      } catch {
        pid = undefined
      }
      if (pid !== undefined && Number.isInteger(pid) && pid > 0) {
        if (pidAlive(pid)) continue
      } else {
        const info = await stat(dir)
        if (Date.now() - info.mtimeMs < noPidFileGraceMs) continue
      }
      await rm(dir, { recursive: true, force: true })
    } catch {
      // Unreadable entries are left alone; the next sweep retries.
    }
  }
}

export async function readLaunchFile(path: string): Promise<LaunchFile> {
  const body = await readFile(path, "utf8")
  const parsed = JSON.parse(body) as Partial<LaunchFile>
  if (!parsed || parsed.schemaVersion !== 1 || !parsed.options) {
    throw new Error(`invalid convoy launch file at ${path}`)
  }
  return parsed as LaunchFile
}

/** Removes a pending launch dir once its coordinator is done and its log has been drained. */
export async function rmPendingLaunch(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

export class CoordinatorBootTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`coordinator did not become ready within ${timeoutMs / 1000}s; it may have failed to boot`)
    this.name = "CoordinatorBootTimeoutError"
  }
}

export async function waitForCoordinatorReady(readyPath: string, timeoutMs = 10_000): Promise<CoordinateReady> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const parsed = JSON.parse(await readFile(readyPath, "utf8")) as CoordinateReady
      if (parsed && typeof parsed.runID === "string" && typeof parsed.controlUrl === "string") return parsed
    } catch {
      // Not ready yet (missing file or partial write).
    }
    if (Date.now() + 100 >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new CoordinatorBootTimeoutError(timeoutMs)
}

export type SpawnResult = {
  pid: number
  exited: Promise<number>
}

export type SpawnDeps = {
  spawn: typeof Bun.spawn
  isStandalone: () => boolean
}

const defaultSpawnDeps: SpawnDeps = {
  spawn: Bun.spawn,
  isStandalone: () => isOfficialStandaloneExecutable(),
}

/**
 * Spawns the detached coordinator. `detached: true` + `unref()` means closing
 * the parent terminal (SIGHUP) never takes the coordinator down; it survives
 * under the same daemon semantics as any backgrounded process.
 */
export async function spawnCoordinator(pending: PendingLaunch, deps: SpawnDeps = defaultSpawnDeps): Promise<SpawnResult> {
  const argv = convoyCoordinateArgv(pending.launchPath)
  const logFd = openSync(pending.logPath, "a")
  const proc = deps.spawn(argv, {
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
    detached: true,
    env: { ...process.env, CONVOY_COORDINATE_READY: pending.readyPath },
    cwd: process.cwd(),
  })
  proc.unref?.()
  // The child owns its duplicated descriptors now; the parent's copy would
  // otherwise leak one fd per run for the lifetime of the CLI process.
  closeSync(logFd)
  // The recorded pid is what lets a later sweep tell a live coordinator's dir
  // (its log is still being written) from an orphan worth deleting.
  await writeFile(join(pending.dir, "pid"), String(proc.pid), { mode: 0o600 }).catch(() => {})
  return { pid: proc.pid, exited: proc.exited }
}

export type LogForwarder = {
  /** Drains whatever landed since the last pump, then stops following. */
  stop(): Promise<void>
}

/**
 * Streams the coordinator's log file to a callback as it grows — the
 * `--no-tui` parent's window into the detached child it is waiting on. The
 * final drain happens in `stop()`, after the child has exited, so nothing
 * written in teardown is lost.
 */
export async function forwardCoordinatorLogs(
  logPath: string,
  write: (chunk: string) => void,
  pollMs = 250,
): Promise<LogForwarder> {
  let handle: FileHandle | undefined
  let offset = 0
  let stopped = false
  let pumping: Promise<void> | null = null
  const buffer = Buffer.alloc(64 * 1024)
  const pump = async () => {
    // The interval and stop() can both call pump() while an earlier await on
    // handle.read() is still pending. Without a re-entrancy guard they would
    // interleave at the shared `offset`, each emitting the same chunk and
    // duplicating it downstream. Serialize pump() into a single in-flight
    // promise so offset only ever advances once.
    if (stopped && handle === undefined) return
    if (pumping !== null) return pumping
    pumping = (async () => {
      if (handle === undefined) {
        try {
          handle = await open(logPath, "r")
        } catch {
          return
        }
      }
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
        if (bytesRead === 0) break
        offset += bytesRead
        write(buffer.toString("utf8", 0, bytesRead))
      }
    })().finally(() => {
      pumping = null
    })
    await pumping
  }
  const timer = setInterval(() => void pump().catch(() => {}), pollMs)
  timer.unref?.()
  return {
    stop: async () => {
      stopped = true
      clearInterval(timer)
      // Wait for any in-flight pump to finish before the final drain so the
      // handle is only read by one pump at a time.
      if (pumping) await pumping.catch(() => {})
      await pump().catch(() => {})
      if (handle) await handle.close().catch(() => {})
    },
  }
}

/**
 * `--coordinate` is internal: it is only ever spawned by this CLI against a
 * launch file the parent just wrote under `~/.convoy/pending`. A launch file
 * carries full RunOptions (hooks, target dir, permission policy), so a
 * hand-fed path would be arbitrary execution dressed as a flag — refuse
 * anything outside that root.
 */
export function assertInternalLaunchPath(launchPath: string, root = pendingRoot()): void {
  const allowed = resolve(root)
  const resolved = resolve(launchPath)
  if (resolved !== allowed && !resolved.startsWith(allowed + sep)) {
    throw new Error(`--coordinate launch file must live under ${allowed} (internal use)`)
  }
}

/**
 * Injected dependencies for `runCoordinateBoot`. Tests replace `run` so the
 * boot contract (release, finish hold, error teardown) can be asserted without
 * spawning a real pipeline.
 */
export type CoordinateBootDeps = {
  run: typeof run
  startControlServer: typeof startControlServer
  createProgress: (options: ControlProgressOptions) => ControlProgress
  hostedTeardownFromError: typeof hostedTeardownFromError
  /** Override for `assertInternalLaunchPath`; tests point this at a scratch dir. */
  launchRoot?: string
}

const defaultCoordinateBootDeps: CoordinateBootDeps = {
  run,
  startControlServer,
  createProgress: (options) => new ControlProgress(options),
  hostedTeardownFromError,
}

/**
 * The child side of `--coordinate <launch.json>`. The control server starts
 * here, before run() boot, so a client can attach during OpenCode boot. The
 * runID is only known after the workspace exists, so the ready file is written
 * by ControlProgress when run() calls progress.start().
 */
export async function runCoordinateBoot(
  launchPath: string,
  readyPath?: string,
  overrides: Partial<CoordinateBootDeps> = {},
): Promise<number> {
  const deps = { ...defaultCoordinateBootDeps, ...overrides }
  assertInternalLaunchPath(launchPath, deps.launchRoot ?? pendingRoot())
  const launch = await readLaunchFile(launchPath)
  const plan = launch.plan
  if (!plan) throw new Error(`launch file ${launchPath} carries no reviewed plan`)

  const server = await deps.startControlServer()
  // Managed writer ownership (capability work-conversations, design D5): the
  // coordinator is the run's writer, so its claim lives exactly as long as
  // the run does — acquired here (the coordinator's own PID is the liveness
  // anchor) and released in `finally`. The launch path refuses a new writer
  // in the same checkout before this child ever spawns; an acquisition
  // conflict or persistence failure stops the run (fail closed).
  let writerClaim: { branch: string } | undefined
  if (hasWritableStep(plan.pipeline)) {
    const { lifecycleCommonDir } = await import("./feature-lifecycle/store")
    const { acquireWriterClaim, writerConflictGuidance } = await import("./feature-lifecycle/writer-claims")
    const commonDir = await lifecycleCommonDir(plan.target.directory)
    if (commonDir) {
      const { currentBranch } = await import("./git")
      const branch = plan.target.branch ?? (await currentBranch(plan.target.directory).catch(() => undefined))
      if (branch) {
        const acquired = await acquireWriterClaim({
          commonDir,
          branch,
          checkoutPath: plan.target.directory,
          kind: "pipeline",
        })
        if ("claim" in acquired) {
          writerClaim = { branch }
        } else {
          const detail = acquired.claim ? writerConflictGuidance(acquired.claim).join(" ") : "a writer claim for this checkout is in an uncertain state — reconcile it before starting another writer"
          throw new Error(`another managed writer owns ${plan.target.directory}: ${detail}`)
        }
      }
    }
  }
  try {
    const progress = deps.createProgress({ server, readyPath })
    // The gate/control cycle shares exactly the adapter's AutoAccept object.
    // Seed it from the launch flags: run() uses options.autoAccept when
    // present and only falls back to yolo/smart when it is absent. Handing
    // over the default `{ mode: "off" }` would advertise --yolo in the log
    // and then prompt (or hang, on --no-tui) on the first ask-level permission.
    progress.autoAccept.mode = launch.options.yolo ? "all" : launch.options.smart ? "smart" : "off"
    // `plan` is the reviewed pipeline (resolvedAdvisor, routed models). The
    // launch options carry the unresolved config; run() only swaps in the
    // reviewed steps when options.plan is set. Dropping it here silently
    // turns every advised pipeline into an unadvised one.
    const options: RunOptions = { ...launch.options, plan, progress, autoAccept: progress.autoAccept, tui: false }
    // metadata.server gains the control URL (no token) for liveness/debug.
    process.env.CONVOY_CONTROL_URL = server.url

    // run() owns the whole cycle: when the reviewed pipeline declares a
    // terminal goal step, it executes the prefix, measurement zero, and the
    // bounded improve/measure rounds inside this one run — one workspace, one
    // metadata store, one server, one hook lifecycle, one finish hold.
    try {
      const result = await deps.run(options)
      await progress.runFinished({ status: "completed", runDir: result.dir })
      await result.release?.()
      return 0
    } catch (error) {
      const teardown = deps.hostedTeardownFromError(error)
      if (!isUserAbortError(error)) {
        await progress.runFinished({
          status: "failed",
          runDir: teardown?.runDir ?? "",
          ...(error instanceof Error ? { error: error.message } : { error: String(error) }),
        })
      }
      await teardown?.release?.()
      throw error
    }
  } finally {
    if (writerClaim) {
      const { lifecycleCommonDir } = await import("./feature-lifecycle/store")
      const { releaseWriterClaim } = await import("./feature-lifecycle/writer-claims")
      const commonDir = await lifecycleCommonDir(plan.target.directory).catch(() => undefined)
      if (commonDir) await releaseWriterClaim({ commonDir, branch: writerClaim.branch, ownerPid: process.pid })
    }
    server.close()
  }
}
