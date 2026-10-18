import { dirname } from "node:path"

import { aggregateAdvisorEvents, readAdvisorEvents } from "./advisor-events"
import { goalProgressPhases } from "./goal-phases"
import { readRunMetadata, type PhaseMetadata, type RunMetadata } from "./metadata"
import { progressPhases, watchSession, backfillSessionTranscript, withGoalPhases, type SessionWatcher } from "./runner"
import { coordinatorJournalPath, progressMessageFromRunnerEvent, type CoordinatorEventItem, type CoordinatorEventSource } from "./runners/coordinator-events"
import { readRunTranscript } from "./runners/transcript"

import type { OpencodeClient } from "./opencode-client"
import type { RunnerEvent } from "./runners/contracts"
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
  private neutralUnsub?: () => void
  private stopped = false

  constructor(
    /**
     * The run's OpenCode server, for the phases that stream natively. Absent
     * for a Claude-only run, or until `connect` reaches a server that boots
     * after the dashboard (a goal-loop iteration's), which `tick` retries.
     */
    private client: OpencodeClient | undefined,
    private readonly tui: ProgressUI,
    private readonly targetDir: string,
    private readonly metaPath: string,
    private readonly phasesWithoutLiveAttach: ReadonlySet<string> = new Set(),
    private readonly tickMs = pollMs,
    /**
     * The coordinator's durable runner-neutral journal (design D6). It carries
     * the transcript of every phase without native live attach (Claude), from
     * replay through the live tail, with no OpenCode server URL. Phases that
     * stream natively keep their own subscription, so nothing renders twice.
     */
    private readonly events?: CoordinatorEventSource,
    private readonly connect?: (url: string) => Promise<OpencodeClient | undefined>,
  ) {
    this.serverGone = new Promise((resolve) => {
      this.resolveServerGone = resolve
    })
  }

  async start() {
    this.startNeutral()
    await this.tick()
    this.poll = setInterval(() => void this.tick(), this.tickMs)
    this.poll.unref?.()
  }

  /**
   * Replays the durable journal from the beginning and follows it live, so a
   * dashboard attaching after a phase completed still reconstructs that phase's
   * transcript, and the live tail merges with the replay without duplicates
   * (the read model's high-water mark owns the overlap).
   */
  private startNeutral() {
    if (!this.events || this.neutralUnsub) return
    this.neutralUnsub = this.events.subscribe(0, (item) => this.applyNeutral(item))
  }

  private applyNeutral(item: CoordinatorEventItem) {
    if (this.stopped) return
    if (item.kind === "gap") {
      this.tui.message(transcriptGapMessage(item))
      return
    }
    if (!this.phasesWithoutLiveAttach.has(item.record.attempt.phase)) return
    applyJournalRecord(this.tui, item.record)
  }

  private async tick() {
    if (this.stopped) return
    const metadata = await readRunMetadata(this.metaPath)
    if (!metadata) return
    if (!this.client && this.connect && metadata.server?.url) {
      const url = metadata.server.url
      this.client = await this.connect(url).catch(() => undefined)
      if (this.stopped) return
      if (this.client) this.tui.serverReady(url)
    }

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
        // A phase without native live attach streams from the journal; the
        // rest follow the run's OpenCode server once it is reachable.
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
   * Grows the dashboard's panel to the rows durable state expects: the run's
   * persisted canonical plan (pipeline, hook, and lifecycle rows) when it has
   * one, or the derived prefix otherwise, plus the goal cycle's reconstructed
   * invocations inserted ahead of the `Compact run` row. Additive and
   * idempotent — the TUI merges by phase name, so rows that already rendered
   * keep their state and a non-goal pipeline's sync is a no-op.
   */
  private syncPhases(metadata: RunMetadata) {
    const pipeline = metadata.pipeline
    if (!pipeline) return
    const recorded = new Set(Object.keys(metadata.phases))
    const goalRows = goalProgressPhases(pipeline, recorded, { live: true, goal: metadata.goal })
    const base = metadata.plannedPhases && metadata.plannedPhases.length > 0 ? metadata.plannedPhases : progressPhases(pipeline)
    this.tui.syncPhases?.(withGoalPhases(base, goalRows))
  }

  /** Derives the header's goal segments from the durable record each poll. */
  private syncGoalView(metadata: RunMetadata) {
    const view = liveGoalLoopView(metadata.goal)
    if (!view || sameGoalView(view, this.lastGoalView)) return
    this.lastGoalView = view
    this.tui.setGoalLoop?.(view)
  }

  private watch(name: string, sessionID: string | undefined) {
    if (!this.client || !sessionID || this.watchers.has(name)) return
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
    // A journal-backed phase was already reconstructed by the replay; without a
    // server there is no history to ask.
    if (!this.client || this.stopped || this.backfilled.has(name) || this.watchers.has(name) || this.phasesWithoutLiveAttach.has(name)) return
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
    this.neutralUnsub?.()
    this.neutralUnsub = undefined
    await Promise.all([...this.watchers.values()].map((watcher) => watcher.stop().catch(() => {})))
    this.watchers.clear()
  }
}

/** Renders one journal record onto a dashboard. */
function applyJournalRecord(tui: ProgressUI, record: { attempt: { phase: string }; event: RunnerEvent }) {
  const name = record.attempt.phase
  const event = record.event
  const message = progressMessageFromRunnerEvent(event)
  if (message) tui.phaseMessage(name, message)
  else if (event.type === "activity") tui.phaseActivity(name, event.message, event.kind)
  else if (event.type === "session") tui.phaseSession(name, event.session.sessionId)
  else if (event.type === "permission-request") tui.phaseActivity(name, `permission: ${event.action}`, "permission")
  else if (event.type === "permission-settled") tui.phaseActivity(name, `permission ${event.decision}`, "permission")
}

/**
 * Replays a stopped run's captured transcripts for the phases without native
 * history (Claude) from the run dir alone: no harness, credentials, or server.
 * A missing journal (a run from before it existed) replays nothing, leaving
 * the dashboard's honest placeholder.
 */
export async function replayJournal(tui: ProgressUI, runDir: string, phases: ReadonlySet<string>): Promise<void> {
  const transcript = await readRunTranscript(coordinatorJournalPath(runDir))
  for (const record of transcript.records) if (phases.has(record.attempt.phase)) applyJournalRecord(tui, record)
  // Captured history with holes is shown as such, never as complete.
  for (const gap of transcript.gaps) tui.message(transcriptGapMessage(gap))
}

/** The dashboard line for an unrecoverable interval of the run's transcript. */
export function transcriptGapMessage(gap: { from: number; to: number }): string {
  return `transcript incomplete: event${gap.from === gap.to ? ` ${gap.from} was` : `s ${gap.from}–${gap.to} were`} not captured`
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
    // A hook's captured output is durable: replay it so a reopened run shows
    // what the hook printed after the live feed is gone.
    if (phase.outputTail) for (const line of phase.outputTail) tui.phaseActivity(name, line.text, line.kind)
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
