import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { ControlReset, ControlServer } from "./control-server"
import type {
  AutoAccept,
  GoalLoopView,
  HumanReviewAction,
  HumanReviewPromptInfo,
  KeepAwakeState,
  PermissionPromptInfo,
  PermissionReply,
  ProgressHostControls,
  ProgressPhase,
  ProgressUI,
  RunControlState,
  RunOutcome,
  RunStatus,
} from "./progress"
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
 * - The live view is *not* duplicated here: the attach client follows the
 *   OpenCode server through `LiveAttach` exactly like an observer does.
 */

export type ControlProgressOptions = {
  /** The run control server already listening on loopback. */
  server: ControlServer
  /** Ready-file path (`CONVOY_COORDINATE_READY`); written on the first start. */
  readyPath?: string
  /** Token recorded in `control.json`; defaults to the server's. */
  token?: string
}

export class ControlProgress implements ProgressUI {
  /** The shared AutoAccept the server cycles and the permission gate reads. */
  readonly autoAccept: AutoAccept = { mode: "off" }

  private readonly server: ControlServer
  private readonly readyPath?: string
  private readonly controlToken: string
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
    // The server command routes resolve against the runner objects as they are
    // handed over via setHostControls/setAbortHandler; /status reads adapter
    // state that is only known after run() creates the RunControl.
    this.server.setHandlers(this.handlers())
  }

  start(runID: string, targetDir: string, runDir?: string): void {
    this.runID = runID
    const dir = runDir ?? targetDir
    void this.persistControlAndReady(runID, dir)
  }

  serverReady(_url: string): void {}

  phaseStarted(): void {}
  phaseRunning(): void {}
  phaseAttempt(): void {}
  phaseSession(): void {}
  phaseActivity(): void {}
  phaseMessage(): void {}
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
    return this.server.pending.holdPermission(info)
  }

  askHumanReview(info: HumanReviewPromptInfo): Promise<HumanReviewAction> {
    return this.server.pending.holdHuman(info)
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
