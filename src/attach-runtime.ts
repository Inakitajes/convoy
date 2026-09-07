import { dirname } from "node:path"

import { aggregateAdvisorEvents, readAdvisorEvents } from "./advisor-events"
import { goalProgressPhases } from "./goal-phases"
import { readRunMetadata, type PhaseMetadata, type RunMetadata } from "./metadata"
import { compactRunRowName, progressPhases, watchSession, backfillSessionTranscript, type SessionWatcher } from "./runner"

import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import type { GoalLoopView, ProgressPhaseSnapshot, ProgressUI } from "./progress"

const pollMs = 1_000

/** Mirrors a live run's activity into the dashboard without driving the run. */
export class LiveAttach {
  readonly serverGone: Promise<void>
  private resolveServerGone!: () => void
  private readonly watchers = new Map<string, SessionWatcher>()
  private readonly started = new Set<string>()
  /** Session id per phase name, as durable state last reported it. */
  private readonly sessionIDs = new Map<string, string>()
  private readonly finalized = new Set<string>()
  /** Completed phases already asked to reconstruct their session transcript. */
  private readonly backfilled = new Set<string>()
  private lastGoalView?: GoalLoopView
  private poll?: ReturnType<typeof setInterval>
  private stopped = false

  constructor(
    private readonly client: OpencodeClient,
    private readonly tui: ProgressUI,
    private readonly targetDir: string,
    private readonly metaPath: string,
    private readonly phasesWithoutLiveAttach: ReadonlySet<string> = new Set(),
    private readonly tickMs = pollMs,
  ) {
    this.serverGone = new Promise((resolve) => {
      this.resolveServerGone = resolve
    })
  }

  async start() {
    await this.tick()
    this.poll = setInterval(() => void this.tick(), this.tickMs)
    this.poll.unref?.()
  }

  private async tick() {
    if (this.stopped) return
    const metadata = await readRunMetadata(this.metaPath)
    if (!metadata) return

    await reconcileAdvisorJournal(metadata, dirname(this.metaPath))

    this.syncPhases(metadata)
    this.syncGoalView(metadata)

    for (const [name, phase] of Object.entries(metadata.phases)) {
      if (phase.sessionID && !this.sessionIDs.has(name)) {
        this.sessionIDs.set(name, phase.sessionID)
        this.tui.phaseSession(name, phase.sessionID)
      }
      if (phase.status === "running") {
        if (!this.started.has(name)) {
          this.started.add(name)
          this.tui.phaseStarted(name)
          if (phase.model) this.tui.phaseAttempt(name, { attempt: 1, model: phase.model })
        }
        for (const event of phase.advisorEvents ?? []) this.tui.phaseAdvisorEvent(name, event)
        if (!this.phasesWithoutLiveAttach.has(name)) this.watch(name, phase.sessionID)
      } else if (phase.status !== "pending" && !this.finalized.has(name)) {
        this.finalized.add(name)
        this.tui.phaseRestored(name, snapshotOf(phase, phase.status))
        this.drop(name)
      }
    }

    if (!metadata.server && !this.stopped) this.resolveServerGone()
  }

  /**
   * Grows the dashboard's panel to the rows durable state expects: the
   * pipeline prefix plus the goal cycle's reconstructed invocations (recorded
   * ones and, while the run is live, the in-flight one). Additive and
   * idempotent — the TUI appends only what it is missing, so rows that already
   * rendered keep their state and a non-goal pipeline's sync is a no-op.
   */
  private syncPhases(metadata: RunMetadata) {
    const pipeline = metadata.pipeline
    if (!pipeline) return
    const recorded = new Set(Object.keys(metadata.phases))
    const rows = [...progressPhases(pipeline), ...goalProgressPhases(pipeline, recorded, { live: true, goal: metadata.goal })]
    // Canonical display order (SC-2): the terminal `Compact run` lifecycle row
    // closes the payload — after the prefix and every goal invocation row —
    // mirroring `reconstructedPhases`, so the contract the dashboard merges
    // against describes one canonical order.
    const compact = rows.filter((row) => row.name === compactRunRowName)
    this.tui.syncPhases?.([...rows.filter((row) => row.name !== compactRunRowName), ...compact])
  }

  /** Derives the header's goal segments from the durable record each poll. */
  private syncGoalView(metadata: RunMetadata) {
    const view = liveGoalLoopView(metadata.goal)
    if (!view || sameGoalView(view, this.lastGoalView)) return
    this.lastGoalView = view
    this.tui.setGoalLoop?.(view)
  }

  private watch(name: string, sessionID: string | undefined) {
    if (!sessionID || this.watchers.has(name)) return
    const watcher = watchSession(this.client, {
      directory: this.targetDir,
      phaseName: name,
      sessionID,
      progress: this.tui,
      signal: new AbortController().signal,
      // The dashboard did not watch this session from birth (it attaches
      // whenever it attaches): buffer the live stream, fetch the session
      // history, and merge the two without duplication so a re-attach shows
      // the step's earlier output.
      backfill: true,
      // This attach being stopped is a view change (a reset replaced the
      // dashboard): a fetch still in flight must not deliver the previous
      // run's history into a phase name the next run reuses. A same-run
      // watcher stop — the phase finalized mid-fetch — keeps delivering.
      isCancelled: () => this.stopped,
    })
    this.watchers.set(name, watcher)
    watcher.result.then(
      () => this.drop(name),
      () => this.drop(name),
    )
  }

  /**
   * Reconstructs a completed phase's session transcript from the run's live
   * server, one attempt per phase. Called by the dashboard the first time the
   * operator views the phase's still-empty session tab; a server that cannot
   * answer leaves the honest placeholder. Phases still being watched (or
   * without live-attach capability) are skipped: the former already carry
   * their transcript from the live watcher's eager backfill, the latter have
   * no server-held history to read.
   */
  requestSessionBackfill(name: string) {
    if (this.stopped || this.backfilled.has(name) || this.watchers.has(name) || this.phasesWithoutLiveAttach.has(name)) return
    const sessionID = this.sessionIDs.get(name)
    if (!sessionID) return
    this.backfilled.add(name)
    void backfillSessionTranscript(this.client, {
      directory: this.targetDir,
      phaseName: name,
      sessionID,
      progress: this.tui,
      // The entry check above ran before the fetch; if this attach is torn
      // down while the fetch is in flight, the stale history is discarded.
      isCancelled: () => this.stopped,
    })
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

/** Merge the authoritative append-only journal over metadata's convenience projection. */
export async function reconcileAdvisorJournal(metadata: RunMetadata, runDir: string) {
  const advisorEvents = await readAdvisorEvents(runDir)
  for (const name of new Set(advisorEvents.map((event) => event.phase))) {
    const events = advisorEvents.filter((event) => event.phase === name)
    const phase = (metadata.phases[name] ??= { status: "pending" })
    phase.advisorEvents = events
    phase.advisor = aggregateAdvisorEvents(events)
  }
}

/** Restore persisted phase state into a progress UI. */
export function replayHistory(tui: ProgressUI, metadata: RunMetadata) {
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
    advisor: phase.advisor,
    advisorEvents: phase.advisorEvents,
  }
}

/** Completed only when every recorded phase completed or was skipped. */
export function overallStatus(metadata: RunMetadata): "completed" | "failed" {
  const statuses = Object.values(metadata.phases).map((phase) => phase.status)
  const allDone = statuses.length > 0 && statuses.every((status) => status === "completed" || status === "skipped")
  return allDone ? "completed" : "failed"
}

/**
 * Reconstructs the dashboard's goal-loop view from a durable goal record, so a
 * stopped run's finish screen shows the same target, trajectory, verdict, and
 * restore result it showed live — no ephemeral process state required.
 */
export function goalLoopViewFrom(goal: RunMetadata["goal"]): GoalLoopView | undefined {
  if (!goal) return undefined
  const outcome: GoalLoopView["outcome"] | undefined =
    goal.outcome && goal.outcome !== "failed"
      ? {
          reason: goal.outcome === "goal" ? "goal" : goal.outcome === "plateau" ? "plateau" : goal.outcome === "no-score" ? "no-score" : "max-iterations",
          reached: goal.outcome === "goal",
          restored: goal.restored ?? false,
        }
      : undefined
  return {
    target: goal.target,
    iteration: Math.max(1, goal.scores.length),
    maxRuns: 1 + goal.maxIterations,
    plateau: goal.plateau,
    scores: goal.scores.map((entry) => entry.score),
    ...(outcome ? { outcome } : {}),
  }
}

/**
 * The live goal view an attached dashboard derives from the durable record,
 * matching what the scheduler publishes at the same stage boundary. While the
 * cycle is unsettled, `iteration` names the measurement about to run (1-based):
 * the record's `iteration` counts completed stages of the current position, so
 * the next measurement is `record.iteration + 1` — equal to the scheduler's
 * `scores.length + 1` at every checkpoint the cycle persists (a checkpoint
 * with k scores is always written right after the k-th measurement was
 * published as measurement k+1). A settled record — the stage reads complete —
 * keeps today's historical reconstruction, which names the last measured
 * round and attaches the verdict.
 */
export function liveGoalLoopView(goal: RunMetadata["goal"]): GoalLoopView | undefined {
  if (!goal) return undefined
  if (goal.stage === "complete") return goalLoopViewFrom(goal)
  return {
    target: goal.target,
    iteration: Math.max(1, goal.iteration + 1),
    maxRuns: 1 + goal.maxIterations,
    plateau: goal.plateau,
    scores: goal.scores.map((entry) => entry.score),
  }
}

/** Structural compare so an unchanged record never triggers a repaint. */
function sameGoalView(a: GoalLoopView, b: GoalLoopView | undefined): boolean {
  if (!b) return false
  return (
    a.target === b.target &&
    a.iteration === b.iteration &&
    a.maxRuns === b.maxRuns &&
    a.plateau === b.plateau &&
    a.scores.length === b.scores.length &&
    a.scores.every((score, index) => score === b.scores[index]) &&
    a.outcome?.reason === b.outcome?.reason &&
    a.outcome?.reached === b.outcome?.reached &&
    a.outcome?.restored === b.outcome?.restored
  )
}

/**
 * Waits until the run recorded at `metaPath` has a live OpenCode server entry,
 * then returns its URL. The coordinator writes `metadata.server` when the
 * server is ready — before that (a fresh iteration booting, a run just
 * spawned) the entry is absent. `abort` races the wait: when it resolves the
 * caller is leaving (detach) or the coordinator died, and undefined comes
 * back so nobody starts an attach against a server that will never exist.
 */
export async function waitForServerUrl(metaPath: string, abort: Promise<unknown>, pollMs = 250): Promise<string | undefined> {
  for (;;) {
    const metadata = await readRunMetadata(metaPath).catch(() => undefined)
    if (metadata?.server?.url) return metadata.server.url
    const winner = await Promise.race([
      Bun.sleep(pollMs).then(() => "poll" as const),
      Promise.resolve(abort).then(() => "abort" as const),
    ])
    if (winner === "abort") return undefined
  }
}
