import { join } from "node:path"
import { stdout } from "node:process"

import { LiveAttach, goalLoopViewFrom, overallStatus, reconcileAdvisorJournal, replayHistory, waitForServerUrl } from "./attach-runtime"
import { createControlClient, readControlFile, type ControlClient } from "./control-client"
import type { ControlReset, ControlRole, PendingSnapshot } from "./control-server"
import { goalProgressPhases } from "./goal-phases"
import { compactRunRow, compactRunRowName, withGoalPhases } from "./runner"
import { readRunMetadata, type RunMetadata } from "./metadata"
import { connectOpencode } from "./opencode"
import type { AutoAccept, PermissionPromptInfo, ProgressPhase, ProgressUI, RunFinalizationView } from "./progress"
import { isControlLive, isServerLive } from "./runs"
import { progressPhases } from "./runner"
import { stepRunnerFor } from "./step-runners"
import { createTuiProgress } from "./tui"
import { runsRoot } from "./workspace"
import type { TuiRoute } from "./tui-session"

/**
 * Claims the controller slot for an attach session. A 409 (slot taken) is
 * mapped to observer by the client. A transient transport failure is retried
 * once so a momentary coordinator hiccup doesn't permanently demote the
 * attach (the menu promise is "pressing enter attaches with control").
 */
export async function claimAttachRole(client: ControlClient): Promise<ControlRole> {
  try {
    return await client.claimController()
  } catch {
    try {
      return await client.claimController()
    } catch {
      return "observer"
    }
  }
}

export type AttachOptions = {
  /**
   * Ctrl+C behavior on a *controller* dashboard. The first auto-attach keeps
   * today's muscle memory (`abort`); a `convoy runs` menu attach detaches back
   * to the menu (`detach`), where the palette's "Abort the run" confirm modal
   * is the only abort path.
   */
  ctrlC?: "abort" | "detach"
}

/** The run the dashboard is currently showing; follows goal-loop resets. */
type AttachView = {
  runID: string
  targetDir: string
  runDir: string
  metaPath: string
  phases: readonly ProgressPhase[]
}

/**
 * The durable finalization outcome as a finish-screen view (capability
 * run-finalization, design D8): reconstructed from metadata, so a late attach
 * or a stopped run shows the same compaction result the live run reported.
 */
function finalizationViewFrom(metadata: RunMetadata): RunFinalizationView | undefined {
  const record = metadata.finalization
  if (!record) return undefined
  return {
    state: record.state,
    ...(record.reason ? { reason: record.reason } : {}),
    ...(record.producedSha ? { producedSha: record.producedSha } : {}),
  }
}

/**
 * The phase list a dashboard opens with: the run's persisted canonical plan
 * when it has one — pipeline steps, hook rows, and the lifecycle row, with the
 * goal cycle's invocations reconstructed structurally from the frozen plan and
 * inserted ahead of `Compact run` (so post-hook rows stay terminal). Legacy
 * records without a plan fall back to deriving the prefix and placing recorded
 * hook extras in canonical positions. Either way, anything recorded that could
 * not be placed keeps a bare row rather than disappearing. (Exported pure so
 * reconstruction can be tested without a terminal.)
 */
export function reconstructedPhases(metadata: RunMetadata, live: boolean): ProgressPhase[] {
  const pipeline = metadata.pipeline
  if (!pipeline) return []
  const recorded = Object.keys(metadata.phases)
  const goalRows = goalProgressPhases(pipeline, new Set(recorded), { live, goal: metadata.goal })
  const planned = metadata.plannedPhases
  if (planned && planned.length > 0) {
    const rows = withGoalPhases(planned, goalRows)
    const placed = new Set(rows.map((row) => row.name))
    return [...rows, ...recorded.filter((name) => !placed.has(name)).map(barePhaseRow)]
  }
  return legacyReconstructedPhases(pipeline, recorded, goalRows)
}

/** Pre-plan reconstruction: derive the prefix and slot recorded hook extras around it. */
function legacyReconstructedPhases(
  pipeline: NonNullable<RunMetadata["pipeline"]>,
  recorded: readonly string[],
  goalRows: readonly ProgressPhase[],
): ProgressPhase[] {
  const base = progressPhases(pipeline)
  const compact = base.find((row) => row.name === compactRunRowName) ?? compactRunRow()
  const steps = base.filter((row) => row.name !== compactRunRowName)
  const goalNames = new Set(goalRows.map((row) => row.name))
  const known = new Set([...steps.map((row) => row.name), compactRunRowName, ...goalNames])
  const extras = recorded.filter((name) => !known.has(name))
  const pre = extras.filter((name) => name.startsWith("pre-hook"))
  const post = extras.filter((name) => name.startsWith("post-hook"))
  const other = extras.filter((name) => !name.startsWith("pre-hook") && !name.startsWith("post-hook"))
  // Recorded rows with no planned counterpart sit like steps above the
  // lifecycle row; only post-hook rows follow it.
  return [...pre.map(barePhaseRow), ...steps, ...goalRows, ...other.map(barePhaseRow), compact, ...post.map(barePhaseRow)]
}

/** A recorded row with no planned counterpart: rendered, but with no plan metadata. */
function barePhaseRow(name: string): ProgressPhase {
  return { name, description: "", kind: name.startsWith("pre-hook") || name.startsWith("post-hook") ? "hook" : "step" }
}

/**
 * Re-enters a run's convoy dashboard from `convoy runs`, without resuming it:
 *
 * - a **coordinated live run** (its control server is up) attaches as the
 *   **controller** when nobody else holds the slot — full control (pause,
 *   auto-accept, keep-awake, interactive, gates, finish dismiss, background) —
 *   or as an **observer** while a controller is attached (today's read-only
 *   attach). Either way the view follows the coordinator across goal-loop
 *   iterations: `serverGone` from the current OpenCode server is not the end
 *   of the session while the coordinator itself answers, because a `reset`
 *   will rebind the dashboard to the next iteration's run.
 * - a **live legacy run** (its OpenCode server is up but there is no
 *   control.json) is a read-only observer, exactly as before.
 * - a **stopped run** is reconstructed from metadata + on-disk reports and
 *   shown as the browsable finish screen.
 */
export async function openRunDashboard(runID: string, options: AttachOptions = {}, route?: TuiRoute): Promise<void> {
  const dir = join(runsRoot(), runID)
  const metaPath = join(dir, "metadata.json")
  const metadata = await readRunMetadata(metaPath)
  if (!metadata?.pipeline) {
    stdout.write(`run ${runID}: no replayable metadata, nothing to open\n`)
    return
  }
  // The append-only journal is authoritative and can be newer than the last
  // debounced metadata write after a crash. Merge it before reconstruction.
  await reconcileAdvisorJournal(metadata, dir)
  const targetDir = metadata.targetDir || process.cwd()

  const server = (await isServerLive(metadata.server)) ? metadata.server : undefined
  const controlFile = await readControlFile(runID)
  // A coordinated run is live through its control server even when its
  // OpenCode server is momentarily down (a fresh coordinator booting, a server
  // that died mid-flight): the coordinator answers throughout, so the
  // dashboard can attach and watch rather than failing on the first lap.
  const controlLive = controlFile ? await isControlLive(controlFile) : false
  const controlServer = controlFile && controlLive ? controlFile : undefined
  const live = Boolean(server || controlServer)

  const phases = reconstructedPhases(metadata, live)

  let userDetached = false
  let wentBackground = false
  // Set when this controller already dismissed the coordinator's finish gate:
  // the fallback finish screen below is for everyone else (observers, crash
  // recoveries), not a second dismissal for someone who already closed it.
  let finishDismissed = false
  let resolveDetached!: () => void
  const detached = new Promise<void>((resolve) => {
    resolveDetached = resolve
  })

  const { createPublishSeam } = await import("./publish")
  // Claim the controller slot BEFORE the dashboard exists: the role decides how
  // the dashboard is built (observer flag, Ctrl+C, host controls). A client
  // that loses the claim (409 — another controller is attached — or the
  // coordinator briefly unreachable) must be a read-only observer whose Ctrl+C
  // detaches; wiring it a control client would let an observer abort the run.
  let controller: ControlClient | undefined
  let controlClient: ControlClient | undefined
  if (controlServer) {
    const candidate = createControlClient({ url: controlServer.url, token: controlServer.token })
    const role = await claimAttachRole(candidate)
    controlClient = candidate
    if (role === "controller") controller = candidate
  }
  // The controller dashboard's own auto-accept view. The coordinator's shared
  // object is authoritative; /status mirrors it and shift+tab POSTs back.
  const controllerAutoAccept: AutoAccept = { mode: "off" }
  const tui = await createTuiProgress(
    phases,
    () => {
      if (controller) {
        // Controller attach: the palette's abort confirm (and Ctrl+C on a
        // first-attach abort-mode dashboard) POST /abort to the coordinator.
        void controller.abort().catch(() => {})
      } else {
        // Legacy read-only observer — or a client that lost the controller
        // claim: Ctrl+C just detaches, never aborts.
        userDetached = true
        resolveDetached()
      }
    },
    controllerAutoAccept,
    {
      offlineSessions: !server,
      observer: !controller,
      mode: live ? "live" : "historical",
      ctrlC: options.ctrlC ?? "detach",
      route,
      // [f] is gated on `finished`, so wiring the publication seam on a live
      // attach is inert until the finish hold lands.
      publish: createPublishSeam({ cwd: targetDir, runDir: dir }),
    },
  )
  tui.start(runID, targetDir, dir)

  if (!live) {
    replayHistory(tui, metadata)
    const goalLoop = goalLoopViewFrom(metadata.goal)
    await Promise.race([
      tui.runFinished?.({ status: overallStatus(metadata), runDir: dir, ...(goalLoop ? { goalLoop } : {}), ...(finalizationViewFrom(metadata) ? { finalization: finalizationViewFrom(metadata)! } : {}) }) ?? Promise.resolve(),
      detached,
    ])
    tui.stop()
    return
  }

  // ---- View following ------------------------------------------------------
  // The session ends when the user leaves (detached / background) or — for a
  // coordinated run — when the coordinator stops answering. The OpenCode
  // server's `serverGone` is deliberately *not* an end for coordinated runs:
  // between goal-loop iterations it fires on every boundary, and a `reset`
  // from the control channel rebinds the view to the next iteration's run
  // (fresh metadata, fresh server, dashboard keeps its clock and cost).
  let view: AttachView = { runID, targetDir, runDir: dir, metaPath, phases }
  let attach: LiveAttach | undefined
  let sessionOver = false
  let viewGeneration = 0
  let resolveCoordinatorGone!: () => void
  const coordinatorGone = new Promise<void>((resolve) => {
    resolveCoordinatorGone = resolve
  })
  const leaving = Promise.race([detached, coordinatorGone])
  detached.then(() => {
    sessionOver = true
  })
  const markCoordinatorGone = () => {
    if (sessionOver) return
    sessionOver = true
    resolveCoordinatorGone()
  }

  const liveAttachPhases = (phases: readonly ProgressPhase[]) =>
    new Set(phases.filter((phase) => !stepRunnerFor(phase.runner).capabilities.liveAttach).map((phase) => phase.name))

  /**
   * Points the view at a run (the initial one, or the next goal-loop
   * iteration). Stops the previous LiveAttach, waits for the run's OpenCode
   * server to record itself in metadata (iteration N+1's server boots seconds
   * after the reset arrives), then follows it with a fresh LiveAttach.
   */
  const startView = async (next: AttachView, serverUrl?: string) => {
    const generation = ++viewGeneration
    await attach?.stop()
    attach = undefined
    view = next
    const url = serverUrl ?? (await waitForServerUrl(next.metaPath, leaving))
    if (sessionOver || generation !== viewGeneration || !url) return
    tui.serverReady(url)
    const fresh = new LiveAttach(connectOpencode(url), tui, next.targetDir, next.metaPath, liveAttachPhases(next.phases))
    attach = fresh
    // Completed phases' session tabs reconstruct their transcripts through the
    // attach that owns the run's live server; each view rebinds the seam (the
    // previous attach's closure no-ops on its stopped flag). Merging keeps any
    // pause/background controls that were wired before.
    tui.setHostControls?.({ requestSessionBackfill: (name) => fresh.requestSessionBackfill(name) })
    await fresh.start()
  }
  await startView(view, server?.url)

  // A reset stays in the server's snapshot until the next iteration replaces
  // it; applying one repeatedly would flatten the rebuilt dashboard
  // (transcripts, reports, feed) every poll. One application per runID — and
  // the run the dashboard opened with is already rendered, so a stale echo of
  // its own iteration's start is skipped too.
  let lastResetRunID = runID
  const applyReset = (reset: ControlReset) => {
    if (reset.runID === lastResetRunID) return
    lastResetRunID = reset.runID
    tui.resetPipeline?.(reset.phases, {
      runID: reset.runID,
      targetDir: reset.targetDir,
      runDir: reset.runDir,
      pipeline: reset.pipeline,
      ...(reset.retainMessage ? { retainMessage: reset.retainMessage } : {}),
    })
    // Point [f] at this iteration's workspace so the squash reads the latest
    // SUMMARY.md / prd.md after a goal-loop reset.
    tui.setHostControls?.({ publish: createPublishSeam({ cwd: reset.targetDir, runDir: reset.runDir }) })
    if (reset.goalLoop) tui.setGoalLoop?.(reset.goalLoop)
    void startView({
      runID: reset.runID,
      targetDir: reset.targetDir,
      runDir: reset.runDir,
      metaPath: join(reset.runDir, "metadata.json"),
      phases: reset.phases,
    })
  }

  // Controller wiring: the claim already happened before the dashboard was
  // built, so a client that lost the slot has no client and no controls here.
  const pollers: Array<{ stop(): void }> = []
  if (controlServer) {
    const session: AttachSession = {
      tui,
      view: () => view,
      applyReset,
      coordinatorGone: markCoordinatorGone,
      onFinishDismissed: () => {
        finishDismissed = true
      },
    }
    if (controller) {
      pollers.push(startPendingPoller(controller, session))
      pollers.push(pollStatus(controller, tui, controllerAutoAccept))
      tui.setHostControls?.({
        onPauseToggle: () => void controller!.pause().catch(() => {}),
        onKeepAwakeToggle: () => void controller!.keepAwake().catch(() => {}),
        onCycleAutoAccept: (mode) => void controller!.autoAccept(mode).catch(() => {}),
        onKeepRunDirRequested: () => void controller!.keepRunDir().catch(() => {}),
        onBackground: () => {
          // Send to background / menu-detach: release the slot and resolve so
          // executeRun can land on the runs browser with this run selected.
          wentBackground = true
          void controller!.bye().catch(() => {})
          tui.stop()
          resolveDetached()
        },
      })
    } else {
      // Observers follow iterations too (view-only): resets rebind their
      // dashboard, and the coordinator's death ends the session. Gates stay
      // the controller's business — an observer never answers anything.
      pollers.push(startResetFollower(controlClient!, session))
    }
  }

  // For a coordinated run the coordinator outlives every per-iteration
  // OpenCode server, so its death — not the server's — ends the session. A
  // legacy run still ends when its (only) server goes.
  await Promise.race([detached, controlServer ? coordinatorGone : attach!.serverGone])
  await attach?.stop()
  for (const poller of pollers) poller.stop()
  // Only the controller releases the slot: an observer never held it (the
  // server rejects a /bye without the claimant's id anyway — belt and braces).
  if (controller) await controller.bye().catch(() => {})

  if (!userDetached && !wentBackground && !finishDismissed) {
    const latest = (await readRunMetadata(view.metaPath)) ?? metadata
    await reconcileAdvisorJournal(latest, view.runDir)
    replayHistory(tui, latest)
    const goalLoop = goalLoopViewFrom(latest.goal)
    await Promise.race([
      tui.runFinished?.({ status: overallStatus(latest), runDir: view.runDir, ...(goalLoop ? { goalLoop } : {}), ...(finalizationViewFrom(latest) ? { finalization: finalizationViewFrom(latest)! } : {}) }) ?? Promise.resolve(),
      detached,
    ])
  }
  tui.stop()
}

/** State shared with the control pollers; see openRunDashboard for the pieces. (Exported for tests.) */
export type AttachSession = {
  tui: ProgressUI
  /** The run the dashboard currently shows (follows goal-loop resets). */
  view(): { runDir: string; metaPath: string }
  /** Applies a goal-loop reset: rebuild the dashboard and rebind the view. */
  applyReset(reset: ControlReset): void
  /** The coordinator stopped answering; end the attach session. */
  coordinatorGone(): void
  /** This controller dismissed the coordinator's finish gate. */
  onFinishDismissed(): void
}

/**
 * Polls GET /pending and resolves each gate through the dashboard's own prompt
 * methods, so the controller UI is a real in-dashboard modal, not a terminal
 * readline. `busy` prevents re-entering a gate while one is still being
 * answered (the goal-loop reset and finish dismiss are one-shot anyway).
 * Consecutive request failures mean the coordinator is gone and end the
 * session — a single miss is treated as a hiccup. (Exported with an
 * injectable interval so tests drive it without a real coordinator.)
 */
export function startPendingPoller(controller: ControlClient, session: AttachSession, pollMs = 200) {
  let busy = false
  let misses = 0
  const poll = async () => {
    if (busy) return
    busy = true
    try {
      let snapshot: PendingSnapshot
      try {
        snapshot = await controller.pending()
        misses = 0
      } catch {
        // The coordinator stopped answering; the main race handles teardown.
        if (++misses >= 5) session.coordinatorGone()
        return
      }
      const { tui, view } = session
      if (snapshot.permission) {
        const info: PermissionPromptInfo = {
          id: snapshot.permission.requestId,
          permission: snapshot.permission.permission,
          patterns: snapshot.permission.patterns,
          ...(snapshot.permission.command ? { command: snapshot.permission.command } : {}),
          ...(snapshot.permission.target ? { target: snapshot.permission.target } : {}),
          ...(snapshot.permission.description ? { description: snapshot.permission.description } : {}),
          ...(snapshot.permission.sessionID ? { sessionID: snapshot.permission.sessionID } : {}),
          ...(snapshot.permission.judgeReason ? { judgeReason: snapshot.permission.judgeReason } : {}),
        }
        const reply = (await tui.askPermission?.(info)) ?? "reject"
        await controller.permission(snapshot.permission.requestId, reply).catch(() => {})
      } else if (snapshot.human) {
        const action =
          (await tui.askHumanReview?.({
            stepName: snapshot.human.stepName,
            iterations: snapshot.human.iterations,
            ...(snapshot.human.kind ? { kind: snapshot.human.kind } : {}),
            ...(snapshot.human.error ? { error: snapshot.human.error } : {}),
            ...(snapshot.human.canRetry !== undefined ? { canRetry: snapshot.human.canRetry } : {}),
          })) ?? "abort"
        await controller.human(snapshot.human.requestId, action).catch(() => {})
      } else {
        // Reset is a sticky one-shot: hosted `run()` publishes it at boot and
        // never clears it. A later finish hold shares the snapshot with that
        // leftover reset. Treating them as exclusive left the dashboard in
        // live/running (clock ticking, Abort instead of Finalize) while the
        // coordinator waited forever on finish-dismiss.
        if (snapshot.reset) session.applyReset(snapshot.reset)
        if (snapshot.finish) {
          const finish = snapshot.finish
          const latest = await readRunMetadata(view().metaPath)
          if (latest) {
            await reconcileAdvisorJournal(latest, view().runDir)
            replayHistory(tui, latest)
          }
          // The finish hold carries the coordinator's real outcome (status,
          // error, goal-loop verdict, run-finalization result) so the screen
          // matches what an in-process owner would see.
          await tui.runFinished?.({
            status: finish.status,
            runDir: view().runDir,
            ...(finish.error ? { error: finish.error } : {}),
            ...(finish.goalLoop ? { goalLoop: finish.goalLoop } : {}),
            ...(finish.finalization ? { finalization: finish.finalization } : {}),
          })
          await controller.finishDismiss().catch(() => {})
          session.onFinishDismissed()
        }
      }
    } finally {
      busy = false
    }
  }
  const timer = setInterval(async () => void poll(), pollMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}

/**
 * The observer's read-only slice of /pending: it follows goal-loop resets (so
 * a second terminal keeps seeing the current iteration) and detects the
 * coordinator's death. It never answers a gate — that is the controller's
 * exclusive right. (Injectable interval for tests, like the pending poller.)
 */
export function startResetFollower(client: ControlClient, session: AttachSession, pollMs = 500) {
  let misses = 0
  const poll = async () => {
    let snapshot: PendingSnapshot
    try {
      snapshot = await client.pending()
      misses = 0
    } catch {
      if (++misses >= 3) session.coordinatorGone()
      return
    }
    if (snapshot.reset) session.applyReset(snapshot.reset)
  }
  const timer = setInterval(async () => void poll(), pollMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}

/** Keeps the run-control + keep-awake + auto-accept state visible on a controller dashboard. */
function pollStatus(controller: ControlClient, tui: ProgressUI, autoAccept: AutoAccept) {
  const timer = setInterval(async () => {
    try {
      const status = await controller.status()
      if (status.controlState) tui.runControlState?.(status.controlState, 0)
      if (status.keepAwake) tui.keepAwakeState?.({ status: status.keepAwake, detail: undefined })
      // The dashboard holds this very object, so a mutation is enough: the
      // next paint (any live event) renders the coordinator's mode. No
      // fabricated repaint is pushed through runStatus here — that would only
      // rewrite the terminal title with a fake identity.
      if (status.autoAccept) autoAccept.mode = status.autoAccept
    } catch {
      // Coordinator gone; the main race handles teardown.
    }
  }, 500)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}
