import type {
  HumanReviewAction,
  HumanReviewPromptInfo,
  PermissionPromptInfo,
  PermissionReply,
  ProgressPhase,
  ProgressUI,
  RunActivity,
  RunControlState,
  RunIdentity,
  RunOutcome,
  RunStatus,
} from "./progress"

/**
 * Every user-visible string for the terminal title and notifications, in one
 * block so the whole surface can be translated by editing this object alone.
 * English to match the rest of Convoy's UI ("run completed", "waiting for
 * manual action").
 */
const text = {
  step: "step",
  started: "started",
  completed: "completed",
  failed: "failed",
  skipped: "skipped",
  runCompleted: "run completed",
  runFailed: "run failed",
  paused: "paused",
  resumed: "resumed",
  waitingPermission: "waiting for your permission",
  waitingReview: "waiting for manual review",
  waitingTakeover: "waiting for interactive takeover",
  waitingFailure: "step failed — waiting for your decision",
  waitingBudget: "step budget reached — waiting for your decision",
} as const

const activityIcon: Record<RunActivity, string> = {
  working: "⚙",
  waiting: "⏳",
  paused: "⏸",
  stopped: "■",
}

/** Tab titles are truncated hard by most terminals; this only bounds our own text. */
const maxTitleLength = 72
/** Notification bodies wrap, but macOS silently drops very long ones. */
const maxBodyLength = 120

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Last segment of a directory path, as a human-facing project label. */
export function projectName(dir: string) {
  if (!dir) return "…"
  const parts = dir.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? dir
}

/** One unit of run progress, as a human counts steps. */
export type StatusStep = {
  /** Pre-fan-out logical name, so a `models:` fan-out reads as one step. */
  label: string
  /** Every phase name that belongs to this unit. */
  members: string[]
}

/**
 * Groups the dashboard's flat phase list into the units a human calls "steps":
 * consecutive phases sharing a groupId (a `parallel:` block, or one step fanned
 * out across `models:`) collapse into one. This mirrors planBatches in
 * runner.ts, but runs over ProgressPhase[] so it also covers the hook rows
 * progressPhases injects around the pipeline.
 */
export function statusSteps(phases: readonly ProgressPhase[]): StatusStep[] {
  const steps: StatusStep[] = []
  const labels = new Map<string, string>()
  for (let index = 0; index < phases.length; index++) {
    const phase = phases[index]!
    labels.set(phase.name, phase.stepName ?? phase.name)
    const previous = index > 0 ? phases[index - 1] : undefined
    const last = steps[steps.length - 1]
    // Group members are guaranteed contiguous by pipeline validation, so
    // comparing against the immediate predecessor is enough.
    const grouped = phase.groupId !== undefined && previous?.groupId === phase.groupId
    if (grouped && last) last.members.push(phase.name)
    else steps.push({ label: phase.stepName ?? phase.name, members: [phase.name] })
  }
  for (const step of steps) {
    const memberLabels = [...new Set(step.members.map((member) => labels.get(member)!))]
    if (memberLabels.length > 1) step.label = `parallel: ${memberLabels.join(", ")}`
  }
  return steps
}

function statusIcon(status: RunStatus): string {
  if (status.activity !== "stopped") return activityIcon[status.activity]
  if (status.outcome === "completed") return "✓"
  if (status.outcome === "failed") return "✗"
  return activityIcon.stopped
}

/** Strips control characters that would corrupt an escape sequence or an AppleScript literal. */
export function cleanText(value: string): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function truncateText(value: string, max: number): string {
  if (max <= 1) return ""
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/**
 * Identity in decreasing glanceability, so the terminal's own truncation drops
 * the least useful part first: the pipeline name goes before the branch does.
 */
function identityText(identity: RunIdentity): string {
  const parts = [identity.project]
  if (identity.branch && identity.branch !== identity.project) parts.push(identity.branch)
  if (identity.pipeline) parts.push(identity.pipeline)
  return cleanText(parts.filter(Boolean).join(" · "))
}

/**
 * `⚙ 3/7 convoy · feat/notify · implement`
 *
 * State and progress lead so they survive a narrow tab: a truncated title still
 * answers "does this need me?" even when the identity is cut off entirely.
 */
export function formatTerminalTitle(status: RunStatus, max = maxTitleLength): string {
  const counter = status.totalSteps > 0 ? `${Math.max(1, status.step)}/${status.totalSteps}` : ""
  const prefix = [statusIcon(status), counter].filter(Boolean).join(" ")
  const identity = identityText(status.identity)
  if (!identity) return prefix
  const budget = max - prefix.length - 1
  const tail = truncateText(identity, budget)
  return tail ? `${prefix} ${tail}` : prefix
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
}

export type NotificationCategory = "steps" | "waiting" | "failures" | "finish"

/**
 * One thing worth interrupting the user for, already formatted. The tracker
 * owns every user-visible string; the notifier is pure transport.
 */
export type NotificationEvent = {
  /** Throttle scope: repeats of the same key inside the notifier's window collapse. */
  key: string
  /** Which config switch gates it. */
  category: NotificationCategory
  title: string
  body: string
}

export function formatNotificationTitle(identity: RunIdentity, icon?: string): string {
  const parts = [identity.project]
  if (identity.branch && identity.branch !== identity.project) parts.push(identity.branch)
  const label = cleanText(parts.join(" · "))
  return icon ? `${label} ${icon}` : label
}

function describePermission(): string {
  return text.waitingPermission
}

function describeHumanReview(info: HumanReviewPromptInfo): string {
  if (info.kind === "failure") return text.waitingFailure
  if (info.kind === "budget-gate") return text.waitingBudget
  return info.kind === "interactive" ? text.waitingTakeover : text.waitingReview
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

export type RunStatusSinks = {
  /** Receives the whole status on every change that alters the rendered title. */
  title?(status: RunStatus): void
  notify?(event: NotificationEvent): void
  /**
   * Receives the live status on every publish. Unlike `title`, it is not gated
   * on the rendered title changing: Herdr wants the current step label even
   * when `N/M` is stable (a parallel member starting mid-step). Deduplication
   * of truly identical statuses is the sink's job (the HerdrReporter already
   * does it), not the tracker's.
   */
  herdr?(status: RunStatus): void
}

export type RunStatusTrackerOptions = {
  phases: readonly ProgressPhase[]
  identity: RunIdentity
  sinks?: RunStatusSinks
  now?: () => number
}

type StepOutcome = "completed" | "skipped" | "failed"

/**
 * Derives the four run states from the ProgressUI event stream and publishes
 * them to the terminal title and the notifier.
 *
 * Emission is edge-triggered, never level-triggered: a step announces itself
 * once when its first member starts and once when its last member ends, so a
 * `models:` fan-out of six produces two notifications rather than twelve.
 */
export class RunStatusTracker {
  private readonly steps: StatusStep[]
  private readonly stepOfPhase = new Map<string, number>()
  private readonly phaseLabel = new Map<string, string>()
  private readonly ended = new Map<string, StepOutcome>()
  private readonly startedAt = new Map<number, number>()
  private readonly announcedStart = new Set<number>()
  private readonly announcedFailure = new Set<number>()
  /** Active waits, keyed so concurrent phases can each hold one. Insertion order picks the label. */
  private readonly waits = new Map<string, string>()
  private readonly sinks: RunStatusSinks
  private readonly now: () => number
  private readonly identity: RunIdentity
  private control: RunControlState = "running"
  private outcome?: "completed" | "failed"
  /** A failed batch remains current through the failed finish state. */
  private failedIndex?: number
  private halted = false
  private lastTitle?: string

  constructor(options: RunStatusTrackerOptions) {
    this.steps = statusSteps(options.phases)
    this.identity = options.identity
    this.sinks = options.sinks ?? {}
    this.now = options.now ?? (() => Date.now())
    this.steps.forEach((step, index) => {
      for (const member of step.members) this.stepOfPhase.set(member, index)
    })
    for (const phase of options.phases) this.phaseLabel.set(phase.name, phase.stepName ?? phase.name)
  }

  /**
   * Prefers the UI's own title channel when it has one (the TUI routes it
   * through OpenTUI's native renderer, which serialises with the paint); the
   * caller's fallback sink covers --no-tui runs.
   */
  bind(progress: ProgressUI) {
    const publish = progress.runStatus?.bind(progress)
    if (publish) this.sinks.title = publish
    this.publish()
  }

  snapshot(): RunStatus {
    const activity = this.activity()
    const index = this.currentIndex()
    const step = this.steps[index]
    return {
      activity,
      step: index + 1,
      totalSteps: this.steps.length,
      identity: this.identity,
      ...(step ? { stepLabel: step.label } : {}),
      // The first active wait names the gate the run is stuck on. Only surfaced
      // while actually waiting: a pause outranks a pending prompt, and the
      // paused label must not leak a stale permission reason.
      ...(activity === "waiting" ? { waitReason: this.waits.values().next().value } : {}),
      ...(this.outcome ? { outcome: this.outcome } : {}),
    }
  }

  phaseStarted(name: string) {
    const index = this.stepOfPhase.get(name)
    if (index === undefined) return this.publish()
    if (!this.startedAt.has(index)) this.startedAt.set(index, this.now())
    if (!this.announcedStart.has(index)) {
      this.announcedStart.add(index)
      const step = this.steps[index]!
      this.emit({
        key: `step-start:${index}`,
        category: "steps",
        body: `${text.step} ${index + 1}/${this.steps.length} · ${step.label} — ${text.started}`,
      })
    }
    this.publish()
  }

  phaseEnded(name: string, outcome: StepOutcome) {
    const index = this.stepOfPhase.get(name)
    if (index === undefined) return this.publish()
    this.ended.set(name, outcome)
    const step = this.steps[index]!
    if (outcome === "failed") this.failedIndex = index
    const stepLabel = outcome === "failed" ? (this.phaseLabel.get(name) ?? step.label) : step.label
    const label = `${text.step} ${index + 1}/${this.steps.length} · ${stepLabel}`

    // Never announce the end of something whose start was never announced.
    // A step can finish without running in this process at all: --resume
    // restores phases completed by an earlier run, and --only/--skip mark the
    // filtered ones skipped. Both arrive as a burst the moment the run opens,
    // and each one carries a distinct throttle key, so without this gate
    // resuming a half-finished run fires a banner per already-completed step
    // announcing yesterday's work. The progress counter below still advances,
    // because that work does count towards the run.
    const ran = this.announcedStart.has(index)

    // A failure is urgent and a wide group runs every member to completion
    // before the run gives up, so announce it immediately rather than waiting
    // for the siblings. The completion branch below then stays quiet.
    if (ran && outcome === "failed" && !this.announcedFailure.has(index)) {
      this.announcedFailure.add(index)
      this.emit({ key: `step-fail:${index}`, category: "failures", icon: "✗", body: `${label} — ${text.failed}` })
    }

    if (ran && !this.announcedFailure.has(index) && step.members.every((member) => this.ended.has(member))) {
      const skipped = step.members.every((member) => this.ended.get(member) === "skipped")
      const elapsed = this.startedAt.get(index)
      const suffix = elapsed !== undefined && !skipped ? ` (${formatDuration(this.now() - elapsed)})` : ""
      this.emit({
        key: `step-end:${index}`,
        category: "steps",
        body: `${label} — ${skipped ? text.skipped : text.completed}${suffix}`,
      })
    }
    this.publish()
  }

  waitBegan(key: string, reason: string) {
    if (this.waits.has(key)) return
    this.waits.set(key, reason)
    this.emit({ key: `wait:${key}`, category: "waiting", icon: activityIcon.waiting, body: reason })
    this.publish()
  }

  waitEnded(key: string) {
    if (!this.waits.delete(key)) return
    this.publish()
  }

  controlState(state: RunControlState) {
    if (this.control === state) return
    const previous = this.control
    this.control = state
    if (state === "paused") this.emit({ key: "control:paused", category: "waiting", icon: activityIcon.paused, body: text.paused })
    else if (state === "running" && previous !== "running") {
      this.emit({ key: "control:running", category: "waiting", icon: activityIcon.working, body: text.resumed })
    }
    this.publish()
  }

  finished(outcome: RunOutcome) {
    if (this.outcome) return
    this.outcome = outcome.status
    const done = this.steps.length
    const body =
      outcome.status === "completed"
        ? `${text.runCompleted} · ${done}/${done}`
        : `${text.runFailed}${outcome.error ? `: ${truncateText(cleanText(outcome.error), 80)}` : ""}`
    this.emit({
      key: "run:finished",
      category: "finish",
      icon: outcome.status === "completed" ? "✓" : "✗",
      body,
    })
    this.publish()
  }

  /** The run is over, with or without a finish screen (a signal tears it down without one). */
  stopped() {
    if (this.halted) return
    this.halted = true
    this.waits.clear()
    this.publish()
  }

  private activity(): RunActivity {
    if (this.halted || this.outcome) return "stopped"
    if (this.control !== "running") return "paused"
    if (this.waits.size > 0) return "waiting"
    return "working"
  }

  /** First step that has not fully ended; once everything has, the last one. */
  private currentIndex(): number {
    if (this.failedIndex !== undefined) return this.failedIndex
    const index = this.steps.findIndex((step) => !step.members.every((member) => this.ended.has(member)))
    if (index >= 0) return index
    return Math.max(0, this.steps.length - 1)
  }

  private emit(event: { key: string; category: NotificationCategory; icon?: string; body: string }) {
    this.sinks.notify?.({
      key: event.key,
      category: event.category,
      title: formatNotificationTitle(this.identity, event.icon),
      body: truncateText(cleanText(event.body), maxBodyLength),
    })
  }

  /**
   * Writes the title only when it would actually read differently. The herdr
   * sink is intentionally NOT gated on that equality: Herdr's step token needs
   * the label even when the title's `N/M` is stable across parallel members,
   * and the HerdrReporter drops genuinely identical statuses itself.
   */
  private publish() {
    const status = this.snapshot()
    this.sinks.herdr?.(status)
    const title = formatTerminalTitle(status)
    if (title === this.lastTitle) return
    this.lastTitle = title
    this.sinks.title?.(status)
  }
}

// ---------------------------------------------------------------------------
// Decorator
// ---------------------------------------------------------------------------

/**
 * Forwards every ProgressUI call unchanged while feeding the tracker, exactly
 * as recordProgress does for run metadata. Wrapping the seam keeps the runner's
 * batch loop, the permission gate and the human gate untouched.
 */
export function trackRunStatus(progress: ProgressUI, tracker: RunStatusTracker): ProgressUI {
  // The dashboard wrapper below tracks in-TUI gates directly. The readline
  // fallback has no askHumanReview method to wrap, so phaseRunning marks its
  // gate open and lifecycle transitions close it again.
  const humanWaits = new Map<string, string>()
  const humanWaitKey = (name: string, kind: HumanReviewPromptInfo["kind"]) => `human:${name}:${kind ?? "review"}`
  const beginHumanWait = (name: string, kind: HumanReviewPromptInfo["kind"], reason: string) => {
    const key = humanWaitKey(name, kind)
    const previous = humanWaits.get(name)
    if (previous && previous !== key) tracker.waitEnded(previous)
    humanWaits.set(name, key)
    tracker.waitBegan(key, reason)
    return key
  }
  const endHumanWait = (name: string, key?: string) => {
    const active = humanWaits.get(name)
    if (!active || (key && active !== key)) return
    tracker.waitEnded(active)
    humanWaits.delete(name)
  }
  const phaseGateKind = (detail: string | undefined): HumanReviewPromptInfo["kind"] | undefined =>
    detail === text.waitingFailure ? "failure" : detail === text.waitingBudget ? "budget-gate" : detail === "interactive session — waiting for your decision" ? "interactive" : undefined

  const tracked: ProgressUI = {
    start: (runID, targetDir, runDir) => progress.start(runID, targetDir, runDir),
    serverReady: (url) => progress.serverReady(url),
    phaseStarted(name, detail) {
      tracker.phaseStarted(name)
      progress.phaseStarted(name, detail)
    },
    phaseRunning(name, detail) {
      const kind = phaseGateKind(detail)
      if (kind) beginHumanWait(name, kind, kind === "failure" ? text.waitingFailure : kind === "budget-gate" ? text.waitingBudget : text.waitingTakeover)
      progress.phaseRunning(name, detail)
    },
    phaseAttempt(name, info) {
      endHumanWait(name)
      progress.phaseAttempt(name, info)
    },
    phaseSession: (name, sessionID) => progress.phaseSession(name, sessionID),
    phaseActivity: (name, detail, kind, pulse) => progress.phaseActivity(name, detail, kind, pulse),
    phaseMessage: (name, message) => progress.phaseMessage(name, message),
    phaseStepUsage: (name, usage) => progress.phaseStepUsage(name, usage),
    phaseUsageTotal: (name, usage) => progress.phaseUsageTotal(name, usage),
    phaseAdvisorEvent: (name, event) => progress.phaseAdvisorEvent(name, event),
    phaseTodos: (name, todos) => progress.phaseTodos(name, todos),
    phaseDiff: (name, summary) => progress.phaseDiff(name, summary),
    phaseCompleted(name, detail) {
      endHumanWait(name)
      tracker.phaseEnded(name, "completed")
      progress.phaseCompleted(name, detail)
    },
    phaseSkipped(name) {
      endHumanWait(name)
      tracker.phaseEnded(name, "skipped")
      progress.phaseSkipped(name)
    },
    phaseFailed(name, detail, failure) {
      endHumanWait(name)
      tracker.phaseEnded(name, "failed")
      progress.phaseFailed(name, detail, failure)
    },
    phaseRestored(name, snapshot) {
      tracker.phaseEnded(name, snapshot.status)
      progress.phaseRestored(name, snapshot)
    },
    message: (message) => progress.message(message),
    suspend: () => progress.suspend(),
    resume: () => progress.resume(),
    stop() {
      // Before the wrapped UI tears its renderer down, so the final title still
      // has somewhere to land.
      tracker.stopped()
      progress.stop()
    },
  }

  // Same probing contract as recordProgress: the permission gate and the human
  // gate choose between an in-dashboard prompt and the readline fallback by
  // testing for these, so presence must mirror the wrapped UI exactly.
  const askPermission = progress.askPermission?.bind(progress)
  if (askPermission) {
    tracked.askPermission = async (info: PermissionPromptInfo): Promise<PermissionReply> => {
      const key = `permission:${info.id}`
      tracker.waitBegan(key, describePermission())
      try {
        return await askPermission(info)
      } finally {
        tracker.waitEnded(key)
      }
    }
  }

  const askHumanReview = progress.askHumanReview?.bind(progress)
  if (askHumanReview) {
    tracked.askHumanReview = async (info: HumanReviewPromptInfo): Promise<HumanReviewAction> => {
      const key = beginHumanWait(info.stepName, info.kind, describeHumanReview(info))
      try {
        return await askHumanReview(info)
      } finally {
        endHumanWait(info.stepName, key)
      }
    }
  }

  const runControlState = progress.runControlState?.bind(progress)
  if (runControlState) {
    tracked.runControlState = (state, activePhases) => {
      tracker.controlState(state)
      runControlState(state, activePhases)
    }
  }

  const runFinished = progress.runFinished?.bind(progress)
  if (runFinished) {
    tracked.runFinished = async (outcome: RunOutcome) => {
      tracker.finished(outcome)
      await runFinished(outcome)
    }
  }

  if (progress.isInteractiveTakeover) tracked.isInteractiveTakeover = progress.isInteractiveTakeover.bind(progress)
  if (progress.keepRunDirRequested) tracked.keepRunDirRequested = progress.keepRunDirRequested.bind(progress)
  if (progress.keepAwakeState) tracked.keepAwakeState = progress.keepAwakeState.bind(progress)
  // Forwarded so tracker.bind() finds the UI's title channel through the
  // composed object, the same way control and caffeinate bind to it.
  if (progress.runStatus) tracked.runStatus = progress.runStatus.bind(progress)
  // Goal-loop hosting methods: purely forwarded, never tracked.
  if (progress.setGoalLoop) tracked.setGoalLoop = progress.setGoalLoop.bind(progress)
  if (progress.resetPipeline) tracked.resetPipeline = progress.resetPipeline.bind(progress)
  if (progress.setAbortHandler) tracked.setAbortHandler = progress.setAbortHandler.bind(progress)
  if (progress.setHostControls) tracked.setHostControls = progress.setHostControls.bind(progress)
  // The shared auto-accept reference is a property, not a method, so it is
  // forwarded here rather than through a wrapper. The permission gate and the
  // dashboard read it through the composed progress, so a tracked dashboard
  // must expose the same reference the raw UI holds.
  if (progress.autoAccept) tracked.autoAccept = progress.autoAccept
  return tracked
}
