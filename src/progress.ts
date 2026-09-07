import { log } from "./log"
import type { Pipeline, StepRunner } from "./types"
import type { AdvisorEvent, AdvisorPhaseAggregate } from "./advisor-events"

export type ProgressPhase = {
  name: string
  description: string
  /** Shared by every member of a concurrent group (a `parallel:` block, or a step fanned out across `models:`); absent on human gates. */
  groupId?: string
  /** Pre-fan-out logical name; equals `name` unless this step was produced by a `models:` fan-out. Absent on human gates. */
  stepName?: string
  /** The model this step is configured to run, so a fanned-out member can be labelled by its model before it starts. */
  plannedModel?: string
  /** The variant paired with `plannedModel`, when the model shorthand carried one. */
  plannedVariant?: string
  /** Execution engine for the step; absent means OpenCode. The TUI's session window ([o]) branches on this. */
  runner?: StepRunner
  /** Whether Convoy restricts this phase to audit-only behavior. */
  readOnly?: boolean
  /**
   * The report this phase writes, relative to the run dir — canonical
   * (`reports/<step>.md`) for prefix steps, iteration-qualified
   * (`reports/goal/iteration-N/<stage>/<step>.md`) for goal fragments. The row
   * carries the data so report panels resolve it without re-deriving the
   * scheduler's qualification rule in display code; absent rows fall back to
   * the canonical `reports/<name>.md` path.
   */
  reportPath?: string
  plannedAdvisor?: string
  advisorMaxCalls?: number
}

export type ProgressTokens = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export type ProgressUsage = {
  sessionID?: string
  cost?: number
  tokens?: ProgressTokens
  model?: string
}

export type ProgressStepUsage = ProgressUsage & {
  stepID?: string
}

export type ProgressAttempt = {
  attempt: number
  model?: string
}

export type ActivityKind =
  | "tool"
  | "bash"
  | "think"
  | "write"
  | "step"
  | "retry"
  | "permission"
  | "todo"
  | "diff"
  | "error"
  | "info"
  | "system"

export type ProgressTodo = {
  content: string
  status: string
}

/** One raw slice of a phase's live session transcript (see ProgressUI.phaseMessage). */
export type ProgressMessageChannel = "reasoning" | "response" | "tool" | "bash"

/**
 * A verbatim chunk of the model's output for the session transcript. For
 * "reasoning"/"response" the `text` is an incremental delta appended to the
 * open block of that channel; for "tool"/"bash" it is one complete action
 * marker (a tool call or shell command) forming its own line.
 *
 * `partID` identifies the provider-side block the delta belongs to. A change of
 * partID closes the open transcript block, so the separate reasoning summaries a
 * model emits stay separate thoughts instead of concatenating into one paragraph.
 */
export type ProgressMessage = { channel: ProgressMessageChannel; text: string; partID?: string }

export type ProgressDiffSummary = {
  files: number
  additions: number
  deletions: number
}

export type PermissionReply = "once" | "always" | "reject"

/**
 * Shared mutable switch between the permission gate and the TUI, cycled live
 * with shift+tab in the dashboard:
 *   - "off":   every ask-level permission prompts the user.
 *   - "all":   every ask-level permission is allowed blindly ("once").
 *   - "smart": each request is handed to an external AI judge; safe ones are
 *              allowed, risky (or unjudgeable) ones fall back to prompting.
 * The opencode-level denylist is unaffected — denied commands never reach the
 * gate at all. Seeded by --yolo ("all") / --smart ("smart").
 */
export type AutoAcceptMode = "off" | "all" | "smart"
export type AutoAccept = { mode: AutoAcceptMode }

/**
 * The goal loop's live state, as the dashboard header shows it. One loop is one
 * piece of work spread over several runs, so this is owned by the loop (via
 * `ProgressUI.setGoalLoop`) and copied into `RunOutcome.goalLoop` when the loop
 * holds its finish screen.
 */
export type GoalLoopView = {
  target: number
  /** 1-based iteration the header should advertise right now. */
  iteration: number
  /** 1 + maxIterations: every run the loop may perform (initial + fixes). */
  maxRuns: number
  plateau: number
  /** Completed scores, oldest first. */
  scores: number[]
  outcome?: {
    reason: "goal" | "plateau" | "max-iterations" | "no-score"
    reached: boolean
    restored: boolean
  }
}

export type ProgressPhaseSnapshot = {
  status: "completed" | "skipped" | "failed"
  sessionID?: string
  durationMs?: number
  cost?: number
  tokens?: ProgressTokens
  model?: string
  advisor?: AdvisorPhaseAggregate
  advisorEvents?: AdvisorEvent[]
}

export type PermissionPromptInfo = {
  id: string
  permission: string
  patterns: string[]
  command?: string
  target?: string
  description?: string
  sessionID?: string
  /** Present when smart auto-accept's judge escalated this request; explains why. */
  judgeReason?: string
  /**
   * Asks the judge for a prose explanation of this request ([e] in the dashboard).
   * Provided by the gate, which holds the opencode client and the judge model;
   * absent when there is no judge to ask.
   */
  explain?(signal?: AbortSignal): Promise<string>
}

export type HumanReviewAction = "continue" | "iterate" | "abort" | "retry" | "reset"

export type HumanReviewPromptInfo = {
  stepName: string
  iterations: number
  /** Gate mode. "interactive" is the mid-step takeover gate (armed with [i]); "failure" is a failed step waiting for a decision; "budget-gate" resets or aborts a phase that exhausted its step budget; absent for pipeline human steps. */
  kind?: "interactive" | "failure" | "budget-gate"
  /** The SDK error a failed step surfaced, shown in the dashboard instead of a generic label. */
  error?: string
  /** Whether [r] (retry clean) is offered: true only for a failure gate with a baseline snapshot. */
  canRetry?: boolean
}

/**
 * The automatic run-compaction outcome as the finish surfaces show it
 * (capability run-finalization, design D8): deliberately separate from the
 * pipeline status, so a blocked or failed compaction never reads as an
 * unqualified clean finish. Serialized over the control channel, too.
 */
export type RunFinalizationView = {
  state: "pending" | "running" | "completed" | "skipped" | "blocked" | "failed"
  reason?: string
  /** The single operator-authored commit compaction produced, when any. */
  producedSha?: string
}

export type RunOutcome = {
  status: "completed" | "failed"
  error?: string
  /** Run workspace dir; still alive while the finish screen is up (cleanup happens after). */
  runDir: string
  /** This run's consensus quality score, when the pipeline scored itself. */
  qualityScore?: number
  /** The goal loop's score trajectory including this run, oldest first; absent when not in goal mode. */
  goalTrajectory?: number[]
  /**
   * The goal loop's live view, copied onto the hold so the finish screen keeps
   * the verdict and trajectory the header painted. Absent outside goal mode.
   */
  goalLoop?: GoalLoopView
  /** The run-finalization outcome, when finalization has reported one. */
  finalization?: RunFinalizationView
}

export type RunControlState = "running" | "pausing" | "paused"

/**
 * The deliberate publication seam behind the finish screen's `Create pull request`
 * action (capability run-finalization, design D5): the host (runner.ts
 * for a live run, attach.ts for a reopened one) supplies the Git + `gh` halves,
 * exactly as the launcher receives its branch-naming callbacks. There is no
 * manual squash anymore — automatic compaction owns the branch rewrite — so
 * this seam only ever publishes: a normal push, then PR location/creation.
 */
export type PublishPlan = {
  branch: string
  /** The resolved destination remote. */
  remote: string
  /** The PR base branch, resolved from the destination's default. */
  base: string
}

export type PublishOutcome = {
  /** Whether the push landed (a retry after a PR failure has nothing to re-push). */
  pushed: boolean
  /** The pull request URL, when one was located or created. */
  url?: string
}

export type PublishSeam = {
  /** Resolves and discloses the publication context, or explains why it is unavailable. */
  prepare(): Promise<{ ok: true; plan: PublishPlan } | { ok: false; message: string }>
  /** Normal push to the disclosed destination, then locate/create the PR. Called with the TUI suspended. */
  apply(plan: PublishPlan): Promise<{ ok: true; outcome: PublishOutcome } | { ok: false; message: string }>
}

/** Host-local screen/idle sleep assertion, intentionally never persisted with a run. */
export type KeepAwakeState = {
  status: "off" | "on" | "unavailable"
  detail?: string
}

/**
 * Host callbacks a live UI can be pointed at per run. The runner refreshes them
 * on every hosted run (each iteration gets its own workspace/run-control pair),
 * so the dashboard's pause / keep-awake keys and the Create pull request action
 * always act on the run currently on screen.
 */
export type ProgressHostControls = {
  onPauseToggle?: () => void
  onKeepAwakeToggle?: () => void
  /**
   * Send the run to the background: the client releases its controller role and
   * stops its dashboard; the coordinator keeps running. The owner dashboard
   * calls this from the palette ("Send to background").
   */
  onBackground?: () => void | Promise<void>
  /** Called after the dashboard cycled its local auto-accept mode; the controller POSTs it over the wire. */
  onCycleAutoAccept?: (mode: AutoAcceptMode) => void
  /**
   * Called when the dashboard opens a session that still needs the run dir
   * ([i] iterate, or [o] on a runner without live-attach). The controller
   * POSTs it so the coordinator does not delete the workspace out from under
   * that session after the finish hold.
   */
  onKeepRunDirRequested?: () => void
  /**
   * Asks the attach runtime to reconstruct a completed phase's session
   * transcript from the run's live server. Called by the dashboard the first
   * time the operator views a completed phase's still-empty session tab (one
   * attempt per phase), mirroring `loadReport`'s laziness. Absent on
   * historical dashboards, whose server is gone and which keep the honest
   * placeholder.
   */
  requestSessionBackfill?: (name: string) => void
  publish?: PublishSeam
}

/**
 * What the run is doing right now, for surfaces outside the dashboard (the
 * terminal title, desktop notifications). Deliberately distinct from
 * RunStatusKind in runs.ts, which classifies a *finished* run in the history
 * browser; this one is about a live run's moment-to-moment activity.
 *
 * Derived with a fixed precedence: stopped > paused > waiting > working.
 */
export type RunActivity = "working" | "waiting" | "paused" | "stopped"

/** What this run is *about*, for a glanceable tab title. Every field is best effort. */
export type RunIdentity = {
  /** Last segment of the target directory. */
  project: string
  pipeline: string
  branch?: string
}

/** Host-local run state, intentionally never persisted with a run. */
export type RunStatus = {
  activity: RunActivity
  /** 1-based index of the concurrent batch in flight. */
  step: number
  /** Batch count, not flat step count: a `parallel:` block or a `models:` fan-out is one. */
  totalSteps: number
  identity: RunIdentity
  /** Set once the run reaches its finish screen. */
  outcome?: "completed" | "failed"
  /** Logical step label (a `parallel:` / `models:` group is one label). */
  stepLabel?: string
  /** First active wait reason, when `activity === "waiting"`. */
  waitReason?: string
}

export type ProgressUI = {
  /** `runDir` is the run workspace (where phase reports land); passed early so the reports tab works during a live run, not just on the finish screen. */
  start(runID: string, targetDir: string, runDir?: string): void
  serverReady(url: string): void
  phaseStarted(name: string, detail?: string): void
  phaseRunning(name: string, detail?: string): void
  /** Structured attempt counter and model for the phase, so UIs can place them without parsing detail strings. */
  phaseAttempt(name: string, info: ProgressAttempt): void
  phaseSession(name: string, sessionID: string): void
  /** `pulse` marks heartbeat noise (provider busy, streaming…) that updates the live status line but stays out of the activity feed. */
  phaseActivity(name: string, detail: string, kind?: ActivityKind, pulse?: boolean): void
  /** Streams the model's real output into the phase's live session transcript: verbatim reasoning/response deltas plus one-line tool/bash action markers. Unlike phaseActivity, this is the raw stream, not a summarized log line. */
  phaseMessage(name: string, message: ProgressMessage): void
  phaseStepUsage(name: string, usage: ProgressStepUsage): void
  phaseUsageTotal(name: string, usage: ProgressUsage): void
  /** One durable advisor lifecycle event, already linked to its real phase. */
  phaseAdvisorEvent(name: string, event: AdvisorEvent): void
  phaseTodos(name: string, todos: ProgressTodo[]): void
  phaseDiff(name: string, summary: ProgressDiffSummary): void
  phaseCompleted(name: string, detail?: string): void
  phaseSkipped(name: string): void
  phaseFailed(name: string, detail?: string): void
  /** Replays a phase finished in a previous run (--resume) with its real duration, cost, and session. */
  phaseRestored(name: string, snapshot: ProgressPhaseSnapshot): void
  /** When present, the UI resolves permission prompts itself (no terminal fallback). */
  askPermission?(info: PermissionPromptInfo): Promise<PermissionReply>
  /** When present, the UI keeps manual review gates inside the dashboard. */
  askHumanReview?(info: HumanReviewPromptInfo): Promise<HumanReviewAction>
  /** True while the user has armed interactive takeover ([i]) for this phase: the runner holds a successful finish on the gate. */
  isInteractiveTakeover?(name: string): boolean
  /** Holds the dashboard open on a finish screen (phase browser) and resolves when the user dismisses it. */
  runFinished?(outcome: RunOutcome): Promise<void>
  /** True when the finish screen handed the run dir to an iterate session ([i]), so cleanup must skip it. */
  keepRunDirRequested?(): boolean
  /** Persistent cooperative pause state; pausing waits for the current atomic batch. */
  runControlState?(state: RunControlState, activePhases: number): void
  /** Host-local keep-awake state, driven by the optional macOS Caffeinate process. */
  keepAwakeState?(state: KeepAwakeState): void
  /**
   * Live run state for surfaces outside the dashboard. The TUI implements this
   * by setting the terminal title only — the dashboard itself never changes
   * appearance because of it.
   */
  runStatus?(status: RunStatus): void
  message(message: string): void
  suspend(): void
  resume(): void
  stop(): void
  /**
   * The goal loop owns the dashboard across iterations; this replaces the
   * header's goal segment live. The view the loop holds at the end (with an
   * `outcome`) is also copied into `RunOutcome.goalLoop` so the finish screen
   * keeps the verdict. SetGoalLoop only stores the view and schedules a
   * repaint — it never resets any other state.
   */
  setGoalLoop?(view: GoalLoopView): void
  /**
   * Aligns the dashboard's phase list with the expected rows, additively: rows
   * already present are left untouched (their state continues to be driven by
   * phase events), missing rows are appended in the given order as pending,
   * and nothing is cleared. Rows arrive in canonical display order with the
   * terminal `Compact run` lifecycle row last — after the pipeline prefix and
   * every goal invocation row — and the dashboard upholds that invariant on
   * its own list regardless: an already-known lifecycle row moves to the
   * terminal position when later rows would sit below it. Idempotent and
   * one-way (client state never feeds back), so a poller can call it every
   * tick: an attached dashboard grows its panel when a goal scheduler starts
   * the next invocation, without the destructive rebuild `resetPipeline`
   * performs.
   */
  syncPhases?(rows: readonly ProgressPhase[]): void
  /**
   * One goal-loop iteration is over and the next run is about to start: swap in
   * its pending phases, ids and pipeline name, and clear everything that belongs
   * to the previous iteration's run (feed, transcripts, reports, queues,
   * finish). `startedAt` and the accumulated usage survive, so the header's
   * clock and cost keep running across iterations.
   */
  resetPipeline?(
    phases: readonly ProgressPhase[],
    next: { runID: string; targetDir: string; runDir: string; pipeline: Pipeline; retainMessage?: string },
  ): void
  /**
   * Points Ctrl+C (and the dashboard's abort key) at a new handler. `undefined`
   * restores the UI's own constructor handler. The goal loop swaps this per
   * run — each iteration's shutdown while it runs, the loop's own between runs
   * and during its finish hold.
   */
  setAbortHandler?(handler?: () => void): void
  /**
   * Repoints the host callbacks (pause, keep-awake, finish seam) at a new run's
   * objects, since each goal-loop iteration creates its own.
   */
  setHostControls?(controls: ProgressHostControls): void
  /** The shared auto-accept reference the gate uses; the dashboard cycles it with shift+tab. */
  autoAccept?: AutoAccept
}

export const noopProgress: ProgressUI = {
  start() {},
  serverReady() {},
  phaseStarted() {},
  phaseRunning() {},
  phaseAttempt() {},
  phaseSession() {},
  phaseActivity() {},
  phaseMessage() {},
  phaseStepUsage() {},
  phaseUsageTotal() {},
  phaseAdvisorEvent() {},
  phaseTodos() {},
  phaseDiff() {},
  phaseCompleted() {},
  phaseSkipped() {},
  phaseFailed() {},
  phaseRestored() {},
  syncPhases() {},
  message() {},
  suspend() {},
  resume() {},
  stop() {},
}

export async function createProgressUI(
  phases: readonly ProgressPhase[],
  enabled: boolean,
  onAbort?: () => void,
  autoAccept?: AutoAccept,
  controls?: ProgressHostControls,
): Promise<ProgressUI> {
  if (!enabled || !process.stdout.isTTY) return noopProgress

  try {
    const { createTuiProgress } = await import("./tui")
    const progress = await createTuiProgress(phases, onAbort, autoAccept, controls)
    log.mute(true)
    return progress
  } catch (error) {
    log.mute(false)
    log.warn(`OpenTUI unavailable; falling back to plain logs: ${error instanceof Error ? error.message : String(error)}`)
    return noopProgress
  }
}
