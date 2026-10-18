import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { ControlReset, ControlServer } from "./control-server"
import { log } from "./log"
import type {
  AutoAccept,
  GoalLoopView,
  HumanReviewAction,
  HumanReviewPromptInfo,
  KeepAwakeState,
  PermissionPromptInfo,
  PermissionReply,
  ProgressAttempt,
  ProgressHostControls,
  ProgressPhase,
  ProgressMessage,
  ProgressUI,
  RunControlState,
  RunOutcome,
  RunStatus,
} from "./progress"
import type { ActivityKind } from "./progress"
import type { RunnerId } from "./runners/contracts"
import { coordinatorJournalPath, CoordinatorEvents, runnerEventFromProgressMessage } from "./runners/coordinator-events"
import type { Pipeline } from "./types"

/**
 * The ProgressUI the executor (coordinator) serves instead of a terminal
 * dashboard. It renders nothing: every host decision travels over the control
 * channel to an attached client.
 *
 * - permission / human gates wait on the matching control `pending` slot; with
 *   no controller attached the promises simply hold (never auto-reject).
 * - `runFinished` holds only while a controller is connected; without one
 *   (`--no-tui`) it resolves immediately so the run exits like today.
 * - `resetPipeline` pushes a `reset` event so an attached dashboard rebuilds
 *   for the run the executor is serving (a goal cycle is one logical run, so
 *   this fires once at run start rather than once per iteration).
 * - pause/abort/keep-awake are wired when the runner calls `setHostControls` /
 *   `setAbortHandler`.
 * - The live view is *not* rendered here: an attached dashboard follows either
 *   the OpenCode server through `LiveAttach` (native live attach) or, for
 *   Claude and any runner without native attach, the neutral journal below.
 * - Runner-neutral transcript delivery (design D6): phase messages and
 *   activity are appended to the run's durable journal
 *   (`<runDir>/events/coordinator-events.ndjson`, one per run, rebound on a
 *   goal-loop reset) for any runner instead of being dropped, each attributed
 *   to its phase's runner. The append is buffered behind a bounded queue, so a
 *   slow journal write or dashboard never blocks native intake or the
 *   permission gate. A dashboard in another process follows the file.
 */

export type ControlProgressOptions = {
  /** The run control server already listening on loopback. */
  server: ControlServer
  /** Ready-file path (`CONVOY_COORDINATE_READY`); written on the first start. */
  readyPath?: string
  /** Token recorded in `control.json`; defaults to the server's. */
  token?: string
  /**
   * A fixed read model to publish into (tests, a shared instance). Without
   * one the progress opens each run's own journal in its run dir.
   */
  events?: CoordinatorEvents
  /** The runner of a phase the plan does not name; defaults to `opencode`. */
  runner?: RunnerId
}

export class ControlProgress implements ProgressUI {
  /** The shared AutoAccept the server cycles and the permission gate reads. */
  readonly autoAccept: AutoAccept = { mode: "off" }

  private readonly server: ControlServer
  private readonly readyPath?: string
  private readonly controlToken: string
  private events?: CoordinatorEvents
  /** The run dir the per-run journal is bound to; unset with a fixed read model. */
  private journalDir?: string
  private readonly fixedEvents: boolean
  private readonly runner: RunnerId
  /** Each planned phase's runner, so a mixed plan's fragments are attributed right. */
  private readonly phaseRunners = new Map<string, RunnerId>()
  /** Structured attempt counter per phase, so published fragments are qualified. */
  private readonly attempts = new Map<string, number>()
  private abortHandler?: () => void
  private pauseToggle?: () => void
  private keepAwakeToggle?: () => void
  private readyWritten = false
  private runID = ""
  private controlState: RunControlState = "running"
  private keepAwakeStatus?: "on" | "off" | "unavailable"
  private goalLoopView?: GoalLoopView
  /** Set when the attached dashboard opens a session that still needs the run dir. */
  private keepRunDir = false

  constructor(options: ControlProgressOptions) {
    this.server = options.server
    this.readyPath = options.readyPath
    this.controlToken = options.token ?? options.server.token
    this.events = options.events
    this.fixedEvents = options.events !== undefined
    this.runner = options.runner ?? "opencode"
    // The server command routes resolve against the runner objects as they are
    // handed over via setHostControls/setAbortHandler; /status reads adapter
    // state that is only known after run() creates the RunControl.
    this.server.setHandlers(this.handlers())
  }

  start(runID: string, targetDir: string, runDir?: string): void {
    this.runID = runID
    const dir = runDir ?? targetDir
    // Only an explicit run dir hosts a journal, never the checkout itself.
    if (runDir) this.bindJournal(runDir)
    void this.persistControlAndReady(runID, dir)
  }

  /** Points publication at the run dir's own journal; the previous run's tail drains first. */
  private bindJournal(runDir: string): void {
    if (this.fixedEvents || this.journalDir === runDir) return
    const previous = this.events
    if (previous) void previous.whenIdle().then(() => previous.close())
    this.journalDir = runDir
    this.events = new CoordinatorEvents({ path: coordinatorJournalPath(runDir) })
  }

  /** Resolves once every queued fragment reached the journal (the run is about to exit). */
  async flushEvents(): Promise<void> {
    await this.events?.whenIdle()
  }

  private publish(name: string, event: (runner: RunnerId, attempt: number) => Parameters<CoordinatorEvents["enqueue"]>[0]["event"]): void {
    if (!this.events || !this.runID) return
    const runner = this.phaseRunners.get(name) ?? this.runner
    this.events.enqueue({ runId: this.runID, phase: name, event: event(runner, this.attempts.get(name) ?? 1) })
  }

  serverReady(_url: string): void {}

  phaseStarted(): void {}
  phaseRunning(): void {}
  phaseAttempt(name: string, info: ProgressAttempt): void {
    this.attempts.set(name, info.attempt)
  }
  phaseSession(): void {}
  /** Summarized activity lines join the journal too; spinner pulses carry nothing to replay. */
  phaseActivity(name: string, detail: string, kind?: ActivityKind, pulse?: boolean): void {
    if (pulse) return
    this.publish(name, (runner, attempt) => ({ type: "activity", runner, attempt, message: detail, ...(kind ? { kind } : {}) }))
  }
  /**
   * Runner-neutral transcript intake (design D6): buffer the chunk onto the
   * durable journal's bounded queue and return immediately. Claude and OpenCode
   * both deliver through here, so a dashboard following the journal never needs
   * an OpenCode server URL. Dropped fragments under back pressure are reported
   * through `CoordinatorEvents.status()` rather than silently lost.
   */
  phaseMessage(name: string, message: ProgressMessage): void {
    this.publish(name, (runner, attempt) => runnerEventFromProgressMessage(runner, attempt, message))
  }
  phaseStepUsage(): void {}
  phaseUsageTotal(): void {}
  phaseAdvisorEvent(): void {}
  phaseTodos(): void {}
  phaseDiff(): void {}
  phaseCompleted(): void {}
  phaseSkipped(): void {}
  phaseFailed(): void {}
  phaseRestored(): void {}

  askPermission(info: PermissionPromptInfo): Promise<PermissionReply> {
    if (!this.server.hasController()) {
      const what = info.command ?? info.target ?? info.patterns.join(", ")
      this.warnUnattended(`[permission] waiting for an answer: ${info.permission}${what ? `: ${what}` : ""}`)
    }
    return this.server.pending.holdPermission(info)
  }

  askHumanReview(info: HumanReviewPromptInfo): Promise<HumanReviewAction> {
    if (!this.server.hasController()) this.warnUnattended(`[human] ${info.stepName} is waiting for a decision${info.error ? ` after: ${info.error}` : ""}`)
    return this.server.pending.holdHuman(info)
  }

  /**
   * A hold without a controller waits by design (a dashboard may attach later),
   * but its log reader, often an agent following a --no-tui launch, would
   * otherwise see only silence. Say what is held and how to release it.
   */
  private warnUnattended(what: string): void {
    log.warn(`${what} — no controller is attached; answer it from \`convoy runs ${this.runID}\`, or launch unattended runs with --smart or --yolo`)
  }

  isInteractiveTakeover(name: string): boolean {
    return this.server.isInteractiveArmed(name)
  }

  async runFinished(outcome: RunOutcome): Promise<void> {
    if (!this.server.hasController()) return
    const dismissed = this.server.pending.holdFinish({
      status: outcome.status,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      ...(outcome.goalLoop ? { goalLoop: outcome.goalLoop } : {}),
      ...(outcome.finalization ? { finalization: outcome.finalization } : {}),
    })
    await this.waitForDismissalOrLeaseLoss(dismissed)
  }

  /**
   * A completed run's terminal hold follows controller lifetime (design D4):
   * an explicit departure or a silent heartbeat expiry resolves it, while a
   * replacement that has already claimed the slot is never dismissed by the
   * old lease's timer or a delayed `/bye`. The subscription is registered
   * before the immediate recheck so a departure in the gap is not missed.
   */
  private waitForDismissalOrLeaseLoss(dismissed: Promise<void>): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        unsubscribe()
        // Clear the hold so a later viewer does not inherit a dismissed
        // finish screen; a no-op when the hold already resolved.
        this.server.pending.resolveFinish()
        resolve()
      }
      const unsubscribe = this.server.onControllerLease((event) => {
        if (event === "claimed") return
        if (!this.server.hasController()) finish()
      })
      if (!this.server.hasController()) {
        finish()
        return
      }
      void dismissed.then(finish)
    })
  }

  keepRunDirRequested(): boolean {
    return this.keepRunDir
  }

  runControlState(state: RunControlState): void {
    this.controlState = state
  }

  keepAwakeState(state: KeepAwakeState): void {
    this.keepAwakeStatus = state.status
  }

  runStatus(_status: RunStatus): void {}

  message(): void {}
  suspend(): void {}
  resume(): void {}
  stop(): void {}

  setGoalLoop(view: GoalLoopView): void {
    this.goalLoopView = view
  }

  resetPipeline(
    phases: readonly ProgressPhase[],
    next: { runID: string; targetDir: string; runDir: string; pipeline: Pipeline; retainMessage?: string },
  ): void {
    this.runID = next.runID
    // A goal cycle reuses phase names across iterations; drop the previous
    // iteration's attempt counters so a fragment is never misattributed.
    this.attempts.clear()
    this.phaseRunners.clear()
    for (const phase of phases) if (phase.runner) this.phaseRunners.set(phase.name, phase.runner)
    this.bindJournal(next.runDir)
    const reset: ControlReset = {
      runID: next.runID,
      targetDir: next.targetDir,
      runDir: next.runDir,
      pipelineName: next.pipeline.name,
      phases: [...phases],
      pipeline: next.pipeline,
      ...(next.retainMessage !== undefined ? { retainMessage: next.retainMessage } : {}),
      // The loop updates its view before each iteration starts, so the reset
      // always carries the freshest trajectory; absent outside goal mode.
      ...(this.goalLoopView ? { goalLoop: this.goalLoopView } : {}),
    }
    this.server.pending.pushReset(reset)
  }

  setAbortHandler(handler: (() => void) | undefined): void {
    this.abortHandler = handler
    // The runner defers the server shutdown to RunResult.release; aborting
    // remotely must use the same shutdown the local Ctrl+C used.
    this.server.setHandlers(this.handlers())
  }

  setHostControls(controls: ProgressHostControls): void {
    this.pauseToggle = controls.onPauseToggle
    this.keepAwakeToggle = controls.onKeepAwakeToggle
    this.server.setHandlers(this.handlers())
  }

  private handlers() {
    return {
      autoAccept: this.autoAccept,
      statusProvider: () => ({
        ...(this.runID ? { runID: this.runID } : {}),
        ...(this.controlState ? { controlState: this.controlState } : {}),
        ...(this.keepAwakeStatus ? { keepAwake: this.keepAwakeStatus } : {}),
        autoAccept: this.autoAccept.mode,
      }),
      onPause: () => this.pauseToggle?.(),
      onResume: () => this.pauseToggle?.(),
      onAbort: () => {
        this.abortHandler?.()
        // The runner's finally clears its abort handler before the coordinator
        // holds the finish screen (the run's shutdown object is disposed by
        // then), so a remote abort during that hold would find no handler and
        // leave the coordinator waiting forever on a finish-dismiss that may
        // never come (detached client, dead terminal). Unwind the hold the
        // same way a dismiss would: the coordinator proceeds to release and
        // exits instead of hanging. With no hold parked this is a no-op.
        this.server.pending.resolveFinish()
      },
      onKeepAwakeToggle: () => this.keepAwakeToggle?.(),
      onKeepRunDirRequested: () => {
        this.keepRunDir = true
      },
    }
  }

  private async persistControlAndReady(runID: string, runDir: string): Promise<void> {
    // The run workspace often does not exist yet at the microtask this fires
    // in; mkdir is idempotent and the runner creates the same dir afterwards.
    await mkdir(runDir, { recursive: true, mode: 0o700 }).catch(() => {})
    await writeFile(join(runDir, "control.json"), JSON.stringify({ url: this.server.url, token: this.controlToken, pid: process.pid }, null, 2), {
      mode: 0o600,
    }).catch(() => {})
    if (this.readyPath && !this.readyWritten) {
      this.readyWritten = true
      await writeFile(this.readyPath, JSON.stringify({ runID, controlUrl: this.server.url }, null, 2), { mode: 0o600 }).catch(() => {})
    }
  }
}
