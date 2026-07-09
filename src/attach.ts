import { join } from "node:path"
import { stdout } from "node:process"

import { readRunMetadata, type PhaseMetadata, type RunMetadata } from "./metadata"
import { connectOpencode } from "./opencode"
import { isServerLive } from "./runs"
import { progressPhases, watchSession, type SessionWatcher } from "./runner"
import { createTuiProgress } from "./tui"
import { runsRoot } from "./workspace"

import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import type { ProgressPhaseSnapshot, ProgressUI } from "./progress"

const pollMs = 1_000

/**
 * Re-enters a run's archer dashboard from `archer runs`, without resuming it:
 * - a **live** run (its server is still up) is *attached* — history is replayed
 *   from metadata and the running phase's opencode events are mirrored into the
 *   dashboard in real time, read-only. Ctrl+C detaches without touching the run.
 * - a **stopped** run (completed, failed, or interrupted) is *reconstructed*
 *   from metadata + on-disk reports and shown as the browsable finish screen.
 *   `[o]` opens a phase's stored session standalone from disk.
 */
export async function openRunDashboard(runID: string): Promise<void> {
  const dir = join(runsRoot(), runID)
  const metaPath = join(dir, "metadata.json")
  const metadata = await readRunMetadata(metaPath)
  if (!metadata?.pipeline) {
    stdout.write(`run ${runID}: no replayable metadata, nothing to open\n`)
    return
  }
  const targetDir = metadata.targetDir || process.cwd()
  const phases = progressPhases(metadata.pipeline)
  // Hook phases aren't part of the frozen pipeline but were recorded as they
  // ran; re-add them as rows so replayHistory has somewhere to restore them.
  const known = new Set(phases.map((phase) => phase.name))
  const extras = Object.keys(metadata.phases).filter((name) => !known.has(name))
  phases.unshift(...extras.filter((name) => name.startsWith("pre-hook")).map((name) => ({ name, description: "" })))
  phases.push(...extras.filter((name) => !name.startsWith("pre-hook")).map((name) => ({ name, description: "" })))
  // Re-checked here: the browser's liveness snapshot may be a couple of seconds
  // stale, and the run may have ended (or started) since it was listed.
  const server = (await isServerLive(metadata.server)) ? metadata.server : undefined

  // Ctrl+C detaches (onAbort). It must never abort the underlying run — this is
  // a read-only observer of someone else's process.
  let userDetached = false
  let resolveDetached!: () => void
  const detached = new Promise<void>((resolve) => {
    resolveDetached = resolve
  })
  const tui = await createTuiProgress(
    phases,
    () => {
      userDetached = true
      resolveDetached()
    },
    undefined,
    { offlineSessions: !server, observer: true },
  )
  tui.start(runID, targetDir, dir)

  if (!server) {
    // Stopped run: paint history, then hand over to the finish screen.
    replayHistory(tui, metadata)
    await Promise.race([tui.runFinished?.({ status: overallStatus(metadata), runDir: dir }) ?? Promise.resolve(), detached])
    tui.stop()
    return
  }

  // Live attach.
  tui.serverReady(server.url)
  const attach = new LiveAttach(connectOpencode(server.url), tui, targetDir, metaPath)
  await attach.start()

  await Promise.race([detached, attach.serverGone])
  await attach.stop()

  // If the run ended while we watched (not a user detach), let the user keep
  // browsing on the finish screen until they close it.
  if (!userDetached) {
    const latest = (await readRunMetadata(metaPath)) ?? metadata
    replayHistory(tui, latest)
    await Promise.race([tui.runFinished?.({ status: overallStatus(latest), runDir: dir }) ?? Promise.resolve(), detached])
  }
  tui.stop()
}

// Mirrors a live run's opencode activity into the dashboard: history from
// metadata, plus a watchSession per running phase whose events stream in. All
// read-only — it never drives the run, only observes it.
class LiveAttach {
  readonly serverGone: Promise<void>
  private resolveServerGone!: () => void
  private readonly watchers = new Map<string, SessionWatcher>()
  private readonly started = new Set<string>()
  private readonly sessions = new Set<string>()
  private readonly finalized = new Set<string>()
  private poll?: ReturnType<typeof setInterval>
  private stopped = false

  constructor(
    private readonly client: OpencodeClient,
    private readonly tui: ProgressUI,
    private readonly targetDir: string,
    private readonly metaPath: string,
  ) {
    this.serverGone = new Promise((resolve) => {
      this.resolveServerGone = resolve
    })
  }

  async start() {
    await this.tick() // paint history before the caller starts waiting
    this.poll = setInterval(() => void this.tick(), pollMs)
    this.poll.unref?.()
  }

  private async tick() {
    if (this.stopped) return
    const metadata = await readRunMetadata(this.metaPath)
    if (!metadata) return

    for (const [name, phase] of Object.entries(metadata.phases)) {
      if (phase.sessionID && !this.sessions.has(name)) {
        this.tui.phaseSession(name, phase.sessionID)
        this.sessions.add(name)
      }
      if (phase.status === "running") {
        if (!this.started.has(name)) {
          this.started.add(name)
          this.tui.phaseStarted(name)
          if (phase.model) this.tui.phaseAttempt(name, { attempt: 1, maxAttempts: 1, model: phase.model })
        }
        this.watch(name, phase.sessionID)
      } else if (phase.status !== "pending" && !this.finalized.has(name)) {
        // Reached a terminal state: stamp its real duration/cost and stop
        // mirroring its (now finished) session.
        this.finalized.add(name)
        this.tui.phaseRestored(name, snapshotOf(phase, phase.status))
        this.drop(name)
      }
    }

    // The run cleared its server entry on shutdown: it's over.
    if (!metadata.server && !this.stopped) this.resolveServerGone()
  }

  private watch(name: string, sessionID: string | undefined) {
    if (!sessionID || this.watchers.has(name)) return
    const watcher = watchSession(this.client, {
      directory: this.targetDir,
      phaseName: name,
      sessionID,
      progress: this.tui,
      signal: new AbortController().signal, // stopped explicitly via watcher.stop()
    })
    this.watchers.set(name, watcher)
    // When the session settles (the phase finished), stop mirroring it; the
    // metadata poll finalizes its display.
    watcher.result.then(
      () => this.drop(name),
      () => this.drop(name),
    )
  }

  private drop(name: string) {
    const watcher = this.watchers.get(name)
    if (!watcher) return
    this.watchers.delete(name)
    void watcher.stop().catch(() => {})
  }

  async stop() {
    if (this.stopped) return
    this.stopped = true
    if (this.poll) clearInterval(this.poll)
    await Promise.all([...this.watchers.values()].map((watcher) => watcher.stop().catch(() => {})))
    this.watchers.clear()
  }
}

// Replays every non-pending phase from metadata as a restored phase. A stale
// "running" (a run interrupted mid-phase) reads as failed — it didn't finish.
function replayHistory(tui: ProgressUI, metadata: RunMetadata) {
  for (const [name, phase] of Object.entries(metadata.phases)) {
    if (phase.sessionID) tui.phaseSession(name, phase.sessionID)
    if (phase.status === "pending") continue
    const status = phase.status === "running" ? "failed" : phase.status
    tui.phaseRestored(name, snapshotOf(phase, status))
  }
}

function snapshotOf(phase: PhaseMetadata, status: ProgressPhaseSnapshot["status"]): ProgressPhaseSnapshot {
  return {
    status,
    sessionID: phase.sessionID,
    durationMs: phase.durationMs,
    cost: phase.cost,
    tokens: phase.tokens,
    model: phase.model,
  }
}

// A clean run (every phase completed or skipped) reads as completed; anything
// else — a failure or an interruption — reads as failed on the finish screen.
function overallStatus(metadata: RunMetadata): "completed" | "failed" {
  const statuses = Object.values(metadata.phases).map((phase) => phase.status)
  const allDone = statuses.length > 0 && statuses.every((status) => status === "completed" || status === "skipped")
  return allDone ? "completed" : "failed"
}
