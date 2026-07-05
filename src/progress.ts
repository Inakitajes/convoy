import { log } from "./log"

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
  maxAttempts: number
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

export type ProgressPhaseSnapshot = {
  status: "completed" | "skipped" | "failed"
  sessionID?: string
  durationMs?: number
  cost?: number
  tokens?: ProgressTokens
  model?: string
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
}

export type RunOutcome = {
  status: "completed" | "failed"
  error?: string
  /** Run workspace dir; still alive while the finish screen is up (cleanup happens after). */
  runDir: string
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
  phaseStepUsage(name: string, usage: ProgressStepUsage): void
  phaseUsageTotal(name: string, usage: ProgressUsage): void
  phaseTodos(name: string, todos: ProgressTodo[]): void
  phaseDiff(name: string, summary: ProgressDiffSummary): void
  phaseCompleted(name: string, detail?: string): void
  phaseSkipped(name: string): void
  phaseFailed(name: string, detail?: string): void
  /** Replays a phase finished in a previous run (--resume) with its real duration, cost, and session. */
  phaseRestored(name: string, snapshot: ProgressPhaseSnapshot): void
  /** When present, the UI resolves permission prompts itself (no terminal fallback). */
  askPermission?(info: PermissionPromptInfo): Promise<PermissionReply>
  /** Holds the dashboard open on a finish screen (phase browser) and resolves when the user dismisses it. */
  runFinished?(outcome: RunOutcome): Promise<void>
  message(message: string): void
  suspend(): void
  resume(): void
  stop(): void
}

export const noopProgress: ProgressUI = {
  start() {},
  serverReady() {},
  phaseStarted() {},
  phaseRunning() {},
  phaseAttempt() {},
  phaseSession() {},
  phaseActivity() {},
  phaseStepUsage() {},
  phaseUsageTotal() {},
  phaseTodos() {},
  phaseDiff() {},
  phaseCompleted() {},
  phaseSkipped() {},
  phaseFailed() {},
  phaseRestored() {},
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
): Promise<ProgressUI> {
  if (!enabled || !process.stdout.isTTY) return noopProgress

  try {
    const { createTuiProgress } = await import("./tui")
    const progress = await createTuiProgress(phases, onAbort, autoAccept)
    log.mute(true)
    return progress
  } catch (error) {
    log.mute(false)
    log.warn(`OpenTUI unavailable; falling back to plain logs: ${error instanceof Error ? error.message : String(error)}`)
    return noopProgress
  }
}
