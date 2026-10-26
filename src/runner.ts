import { existsSync } from "node:fs"
import { appendFile, link, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline/promises"

import type { AssistantMessage, FilePartInput, OpencodeClient, Part } from "./opencode-client"

import { advisorNeedsOf, completionQuestion, type AdvisorUsage, type ModelSelection } from "./advisor"
import { installAdvisorTool, startAdvisorBridge, type AdvisorBridge } from "./advisor-bridge"
import { readAdvisorSplit, renderAdvisorSplit } from "./advisor-report"
import { createAdvisorRuntime, totalAdvisorUsage, type AdvisorPhaseHandle, type AdvisorRuntime } from "./advisor-runtime"
import { aggregateAdvisorEvents, createAdvisorEventJournal, readAdvisorEvents, type AdvisorEvent, type AdvisorEventJournal } from "./advisor-events"
import { opencodeConfig, loadAgentPrompt } from "./agents"
import { fileParts } from "./attachments"
import { Caffeinate } from "./caffeinate"
import { advisorAuthFor } from "./config"
import { claudeReadableDirectories, openClaudeSessionWindow, writeClaudeSessionDirectories } from "./claude-code"
import { ensureRunnersAvailable } from "./runner-installation"
import { baseAgentName } from "./runners/agent-source"
import { attemptCompositionFor, releaseAttemptCompositions } from "./runners/attempt-composition"
import { resolveAttempt, type AttemptContext } from "./runners/attempt"
import { phasePolicy } from "./runners/phase-policy"
import { beginSessionHandles, releaseSessionHandles } from "./runners/session-handles"
import { progressSink, toProgressUsage } from "./runners/attempt-sink"
import type { AttemptResult } from "./runners/attempt"
import { createClaudeRunner } from "./runners/claude/adapter"
import { promptPhase } from "./runners/opencode/phase"

export { promptPhase }

// Neutral leaves and the OpenCode session runtime moved out of the engine
// (change `unify-runner-system`, task 2.1). The engine imports them back and
// re-exports for its existing consumers; no adapter imports this module.
import { UserAbortError, isUserAbortError } from "./runners/abort"
import { formatSdkError, isContextOverflowError } from "./runners/errors"
import { validateDeliverableContract } from "./runners/quality-contract"
import { combinedAssistantUsage, extractAssistantText, formatUsageForLog, type SessionRef } from "./runners/opencode/session"

export { UserAbortError, isUserAbortError } from "./runners/abort"
export { formatSdkError } from "./runners/errors"
export { validateDeliverableContract as validateDeliverable } from "./runners/quality-contract"
export * from "./runners/opencode/session"
import type { EnforcementPlan } from "./runners/claude/enforcement"
import type { AttachmentDescriptor, AuthenticationSelection, ExecutionMode, ExecutionRequest, RunnerEvent } from "./runners/contracts"
import { addAllAndCommit, createCleanRepoSnapshot, currentBranch, currentHead, describeRepoSnapshotDifference, dirtyFilesPreview, dirtyTreeError, ensureRepoReady, restoreRepoSnapshot, type RepoSnapshot, statusPorcelain, writeDiff } from "./git"
import { gitCommonDir, protectAttemptTip, runRefPrefix } from "./finalization/refs"
import { recordLedgeredCommit } from "./finalization/ledger"
import type { FinalizationRetryOptions } from "./finalization/compact"
import type { RunBoundary } from "./finalization/types"
import { hookPhaseNames, hooksForPipeline, runHooks, type HookStage } from "./hooks"
import { getSessionEventHub, payloadProperties } from "./event-hub"
import { askHumanAction, phaseGatePrompt, runHumanReviewGate } from "./human"
import { log } from "./log"
import { LoopGuard, LoopGuardError, observationFromSessionEvent, resolveLoopGuard, type LoopGuardConfig, type LoopGuardObservation } from "./loop-guard"
import { openRunMetadata, recordProgress, type RunMetadataStore } from "./metadata"
import { openOpencodeSessionWindow, startOpencode } from "./opencode"
import { specTools, type SpecBundle } from "./spec-tools"
import { clearServerAuth, writeServerAuth } from "./server-auth"
import { defaultStopPolicy, type StopOutcome, type StopPolicy } from "./process-stop"
import { HerdrReporter } from "./herdr"
import { defaultNotificationSettings, Notifier } from "./notifications"
import { createOperatorApprovalService, startPermissionGate, type PermissionGate } from "./permissions"
import { agentsForPipeline, deliverableContractForPhase, splitModelVariant, validateStepFilters } from "./pipeline"
import { pickPrdHistory, prdHistoryFile, readPrdHistoryIndex, writePrdHistory } from "./prd-history"
import { installWriteReportTool, startReportBridge, type ReportBridge } from "./report-bridge"
import { createReportRuntime, type ReportPhaseHandle, type ReportRuntime } from "./report-runtime"
import { stepCommitMessageFactory } from "./step-commit"
import { pipelineRunners, throughputRoutedModels } from "./run-plan"
import { runnerExecutionRecord } from "./runners/provenance"
import { isCliJudge } from "./safety-judge"
import { isCliAdvisor } from "./advisor"
import { openCodexSessionWindow } from "./codex-cli"
import { qualifiedRunnerOf, runnerDescriptor } from "./runners/descriptors"
import { promoteScoreReport, runGoalCycle, type GoalCycleOutcome } from "./goal-scheduler"
import { formatTerminalTitle, projectName, RunStatusTracker, trackRunStatus } from "./run-status"
import { popTerminalTitle, pushTerminalTitle, writeTerminalTitle } from "./terminal-title"
import {
  noopProgress,
  type ActivityKind,
  type AutoAccept,
  type GoalLoopView,
  type HumanReviewAction,
  type ProgressDiffSummary,
  type ProgressMessage,
  type ProgressPhase,
  type ProgressHostControls,
  type ProgressStepUsage,
  type ProgressTodo,
  type ProgressTokens,
  type ProgressUI,
  type ProgressUsage,
  type RunControlState,
  type RunOutcome,
} from "./progress"
import { discoverProjectContextFiles } from "./project-context"
import { runnerOfModelReference, stepRunnerFor, stepRunnerModel, type StepRunnerId } from "./step-runners"
import { createTerminalInput, type TerminalInput } from "./terminal-input"
import type { AgentSpec, AgentStep, DeliverableContract, HookSet, HookSpec, PermissionAdditions, Pipeline, ResolvedGoalPlan, RunOptions, Step } from "./types"
import { bashPolicy, noAdditions } from "./bash-policy"
import { consensusStep, loadQualityRubricWeights, parseQualityScoreReport, qualityDimensionWeights, type QualityDimension, type QualityScore } from "./quality-score"
import { addTokens, emptyTokens, tokensFromValue } from "./usage"
import { agentDeniedDirs, cleanupWorkspace, createWorkspace, resumeWorkspace, runPrivateDir, type Workspace, writeSummary } from "./workspace"

export type ActiveSession = {
  client: OpencodeClient
  sessionID: string
  directory: string
  phaseName: string
}


/**
 * Whether an unhandled rejection is the known-benign abort that the opencode SDK
 * leaks when its SSE reader is cancelled (the reader rejects without being
 * awaited). Only these are safe to swallow at the process level; anything else is
 * a real fault and must stay visible. See main.ts's unhandledRejection handler.
 */
export function isIgnorableRejection(reason: unknown): boolean {
  if (isUserAbortError(reason)) return true
  if (reason instanceof Error) {
    if (reason.name === "AbortError") return true
    return /\baborted?\b/i.test(reason.message)
  }
  return false
}

/**
 * Injected seams for the shutdown state machine. `exit` lets tests assert the
 * force path without killing the runner; `graceMs` and `forceObservationMs`
 * let a test exercise the deadline/observation timers without waiting the
 * production 15s + 1s budgets (design D2: tests inject timers and seams).
 */
export type RunShutdownDeps = {
  exit?: (code: number) => void
  /** Overall cleanup deadline before the forced owned-server edge; default 15s. */
  graceMs?: number
  /** Observation window after the forced edge before exiting; default 1s. */
  forceObservationMs?: number
  /** Injectable clock so the shared stop budget is deterministically testable. */
  now?: () => number
}

export class RunShutdown {
  private readonly controller = new AbortController()
  private readonly activeSessions = new Map<string, ActiveSession>()
  private abortingSessions: Promise<void> | undefined
  private requests = 0
  private forceTimer: ReturnType<typeof setTimeout> | undefined
  private exitTimer: ReturnType<typeof setTimeout> | undefined
  private forceHandler?: () => void
  private forcing = false
  private readonly exit: (code: number) => void
  private readonly graceMs: number
  private readonly forceObservationMs: number
  private readonly now: () => number
  private requestedAt: number | undefined
  /**
   * Set by {@link dispose} so a signal routed to a shutdown whose loop already
   * exited (a borrowed dashboard's abort handler still pointing at it) is a
   * no-op instead of a {@link process.exit}. The loop clears that handler on
   * exit, but a signal landing in the gap between handler clear and dispose
   * must still be inert.
   */
  private disposed = false

  constructor(deps: RunShutdownDeps = {}) {
    this.exit = deps.exit ?? ((code) => process.exit(code))
    this.graceMs = deps.graceMs ?? 15_000
    this.forceObservationMs = deps.forceObservationMs ?? 1_000
    this.now = deps.now ?? Date.now
  }

  get signal() {
    return this.controller.signal
  }

  get aborted() {
    return this.controller.signal.aborted
  }

  /**
   * Registers the owned-server force edge. It runs synchronously when a
   * repeated abort or the shutdown deadline arrives, immediately before the
   * bounded last-resort exit, so a wedged cleanup cannot abandon the child
   * (design D3).
   */
  setForceHandler(handler: (() => void) | undefined) {
    this.forceHandler = handler
  }

  request(source: string) {
    if (this.disposed) return
    this.requests++
    if (this.requests > 1) {
      log.warn(`${source} received again; forcing owned-server cleanup before exit`)
      this.forceShutdown()
      return
    }

    log.warn(`${source} received; aborting active OpenCode session(s) and shutting down`)
    this.requestedAt = this.now()
    this.controller.abort(new UserAbortError(`${source} received`))
    this.forceTimer = setTimeout(() => {
      log.warn("Shutdown cleanup timed out; forcing owned-server cleanup before exit")
      this.forceShutdown()
    }, this.graceMs)
    this.forceTimer.unref?.()
  }

  /**
   * The shared cleanup budget a helper owned by this shutdown must respect
   * (design D2): helpers running under a coordinator draw from its remaining
   * global deadline instead of starting a fresh standalone allowance. Before a
   * shutdown is requested this returns the standalone defaults; once requested
   * it clamps the graceful window and the forced-observation window so their
   * sum never exceeds the time left before the forced edge — and therefore
   * never restarts or extends the coordinator's budget.
   */
  stopBudget(): StopPolicy {
    if (this.requestedAt === undefined) return {}
    const remaining = Math.max(0, this.graceMs - (this.now() - this.requestedAt))
    const graceMs = Math.min(defaultStopPolicy.graceMs, remaining)
    const forceObservationMs = Math.min(this.forceObservationMs, Math.max(0, remaining - graceMs))
    return { graceMs, forceObservationMs }
  }

  /**
   * Idempotent last resort: deliver the synchronous SIGKILL edge to owned
   * servers, observe for at most the reserved second, then exit with the
   * existing abort code. Repeated signals while forcing are no-ops rather than
   * new immediate exits, so a burst of signals cannot skip the server stop.
   */
  private forceShutdown() {
    if (this.forcing || this.disposed) return
    this.forcing = true
    try {
      this.forceHandler?.()
    } catch (error) {
      log.warn(`couldn't force owned-server cleanup: ${String(error)}`)
    }
    this.exitTimer = setTimeout(() => this.exit(130), this.forceObservationMs)
    this.exitTimer.unref?.()
  }

  throwIfRequested() {
    if (this.aborted) throw this.abortError()
  }

  abortError(fallback?: unknown) {
    if (isUserAbortError(this.signal.reason)) return this.signal.reason
    if (isUserAbortError(fallback)) return fallback
    return new UserAbortError()
  }

  setActiveSession(session: ActiveSession) {
    this.activeSessions.set(session.phaseName, session)
  }

  clearActiveSession(phaseName: string, sessionID: string) {
    if (this.activeSessions.get(phaseName)?.sessionID === sessionID) {
      this.activeSessions.delete(phaseName)
    }
  }

  async abortActiveSessions(progress?: ProgressUI) {
    if (this.abortingSessions) return this.abortingSessions
    const sessions = [...this.activeSessions.values()]
    if (sessions.length === 0) return

    this.abortingSessions = (async () => {
      await Promise.allSettled(
        sessions.map(async (session) => {
          progress?.phaseActivity(session.phaseName, "aborting active OpenCode session")
          try {
            const response = await session.client.session.abort({ sessionID: session.sessionID, directory: session.directory })
            if (response.error) log.warn(`couldn't abort OpenCode session ${session.sessionID}: ${formatSdkError(response.error)}`)
          } catch (error) {
            log.warn(`couldn't abort OpenCode session ${session.sessionID}: ${formatSdkError(error)}`)
          }
        }),
      )
    })().finally(() => {
      this.abortingSessions = undefined
    })

    return this.abortingSessions
  }

  dispose() {
    if (this.forceTimer) clearTimeout(this.forceTimer)
    if (this.exitTimer) clearTimeout(this.exitTimer)
    this.disposed = true
  }
}

/** Cooperative pause controller: an in-flight parallel batch remains atomic. */
export class RunControl {
  private state: RunControlState
  private activePhases = 0
  private waiters: Array<() => void> = []
  private progress?: ProgressUI

  constructor(private readonly metadata: RunMetadataStore) {
    this.state = metadata.controlState()
  }

  bind(progress: ProgressUI) {
    this.progress = progress
    this.publish()
  }

  beginBatch(activePhases: number) {
    this.activePhases = activePhases
  }

  async toggle() {
    if (this.state === "running") await this.requestPause()
    else await this.resume()
  }

  async requestPause() {
    if (this.state !== "running") return
    this.state = this.activePhases > 0 ? "pausing" : "paused"
    await this.metadata.setControlState(this.state)
    this.publish()
  }

  async resume() {
    if (this.state === "running") return
    this.state = "running"
    await this.metadata.setControlState("running")
    this.publish()
    for (const resolve of this.waiters.splice(0)) resolve()
  }

  async awaitRunnable(signal?: AbortSignal) {
    if (this.state === "running") return
    if (signal?.aborted) throw signal.reason ?? new UserAbortError()
    await new Promise<void>((resolve, reject) => {
      const resume = () => {
        signal?.removeEventListener("abort", abort)
        resolve()
      }
      const abort = () => {
        const index = this.waiters.indexOf(resume)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(signal?.reason ?? new UserAbortError())
      }
      this.waiters.push(resume)
      signal?.addEventListener("abort", abort, { once: true })
    })
  }

  async checkpointAfterBatch(signal?: AbortSignal) {
    this.activePhases = 0
    if (this.state === "pausing") {
      this.state = "paused"
      await this.metadata.setControlState("paused")
      this.publish()
    }
    await this.awaitRunnable(signal)
  }

  private publish() {
    this.progress?.runControlState?.(this.state, this.activePhases)
  }
}

/** Exclusive per-run lease preventing two coordinators from mutating one pipeline. */
export async function acquireRunLease(workspace: Workspace): Promise<() => Promise<void>> {
  const path = join(workspace.dir, "coordinator.lock")
  const token = `${process.pid}:${Date.now()}:${randomUUID()}`
  // Publish a complete owner record before atomically linking it into the lock
  // pathname. `open(path, "wx")` exposes an empty lock between creation and
  // write, letting another coordinator delete it and acquire the same run.
  const candidate = `${path}.${randomUUID()}.candidate`
  await writeFile(candidate, token, { encoding: "utf8", mode: 0o600, flag: "wx" })
  try {
    await link(candidate, path)
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error
    const owner = Number((await readFile(path, "utf8").catch(() => "")).split(":", 1)[0])
    if (owner > 0 && processIsAlive(owner)) throw new Error(`run ${workspace.runID} is already controlled by process ${owner}`)
    // Never reclaim a lease with a read-then-unlink sequence: two resumptions
    // can both observe a stale owner and one can remove the other's new lock.
    // Failing closed preserves exclusive ownership; an operator can remove a
    // stale lock after verifying no coordinator still owns the run.
    throw new Error(`run ${workspace.runID} has a stale coordinator lease at ${path}; remove it only after confirming no Convoy coordinator is running`)
  } finally {
    await unlink(candidate).catch(() => undefined)
  }

  return async () => {
    // Cooperating coordinators cannot replace an extant lock, so checking the
    // token before unlinking cannot race with a newly acquired lease.
    const current = await readFile(path, "utf8").catch(() => "")
    if (current === token) await unlink(path).catch(() => undefined)
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM")
  }
}

/**
 * Groups the flat step list into batches the runner executes together: a
 * human gate is always its own batch, and consecutive agent steps sharing a
 * groupId (a `parallel:` block, or one step fanned out across `models:`) form
 * one batch that runs concurrently. Validation guarantees group members are
 * always contiguous, so a linear scan suffices.
 */
/**
 * Whether a run needs its own OpenCode server: an OpenCode step anywhere in the
 * plan (goal fragments included), an advisor that runs on OpenCode, or an
 * OpenCode smart judge. Everything else — Claude steps, Claude advisors and
 * judges, reports, the dashboard journal — works without one.
 */
export function runNeedsOpencodeServer(pipeline: Pipeline, smartJudge?: { providerID: string }): boolean {
  if ([...pipelineRunners(pipeline)].some((runner) => !stepRunnerFor(runner).qualifiedModels)) return true
  const steps = [...pipeline.steps, ...(pipeline.goalPlan ? [...pipeline.goalPlan.improve.steps, ...pipeline.goalPlan.measure.steps] : [])]
  if (steps.some((step) => step.type === "agent" && step.resolvedAdvisor !== undefined && !isCliAdvisor(step.resolvedAdvisor))) return true
  return smartJudge !== undefined && !isCliJudge(smartJudge)
}

/** The authentication the run's smart judge runs under: its runner's configured auth. */
function judgeAuthOf(options: Pick<RunOptions, "smartJudgeModel" | "runnerAuth">): AuthenticationSelection | undefined {
  if (!options.smartJudgeModel) return undefined
  return options.runnerAuth?.[runnerOfModelReference(options.smartJudgeModel)]
}

/** The judge model selection from its frozen route (a CLI runner's route keeps its variant as effort). */
function judgeModelOf(route: string): { providerID: string; modelID: string; variant?: string } {
  const split = splitModelVariant(route)
  const model = parseModel(split.model)
  return qualifiedRunnerOf(route) && split.variant ? { ...model, variant: split.variant } : model
}

export function planBatches(steps: readonly Step[]): Step[][] {
  const batches: Step[][] = []
  for (const step of steps) {
    const last = batches[batches.length - 1]
    const lastFirst = last?.[0]
    if (step.type === "agent" && lastFirst?.type === "agent" && step.groupId !== undefined && lastFirst.groupId === step.groupId) {
      last.push(step)
    } else {
      batches.push([step])
    }
  }
  return batches
}

/** Default cap on how many agents run at once inside one concurrent group. */
export const defaultMaxConcurrentAgents = 30

/**
 * Bounds how many jobs run at once. A group smaller than `limit` is never
 * throttled; a larger fan-out queues the overflow so the run never holds more
 * than `limit` live model sessions — each with its own event stream and poll
 * timer — open at the same time.
 */
export function createConcurrencyLimiter(limit: number) {
  let active = 0
  const waiters: Array<() => void> = []
  const release = () => {
    active--
    waiters.shift()?.()
  }
  return async <T>(job: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiters.push(resolve))
    active++
    try {
      return await job()
    } finally {
      release()
    }
  }
}

/** Every group member runs to completion before the pipeline fails; this aggregates their failures into one error. */
export class PhaseGroupError extends Error {
  readonly failures: { name: string; error: unknown }[]

  constructor(failures: { name: string; error: unknown }[]) {
    super(failures.map((failure) => `[${failure.name}] ${formatSdkError(failure.error)}`).join("; "))
    this.name = "PhaseGroupError"
    this.failures = failures
  }
}

type GitLock = <T>(job: () => Promise<T>) => Promise<T>

/**
 * Serializes git operations across concurrently-running phases in the same
 * group: their agent sessions run fully in parallel, but git.ts's mutating
 * calls (`git add`, `git commit`, `git reset --hard`) would otherwise race on
 * `.git/index.lock`. Forced-read-only group members never actually change the
 * tree, so this only ever arbitrates housekeeping, not real content conflicts.
 */
export function createGitLock(): GitLock {
  let tail: Promise<unknown> = Promise.resolve()
  return function withGitLock<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job, job)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

export function installShutdownSignals(shutdown: RunShutdown) {
  // Bun delivers the numeric signal value to handlers; normalize for logs.
  const nameOf = (signal: NodeJS.Signals | number) => {
    if (typeof signal !== "number") return signal
    if (signal === 1) return "SIGHUP"
    if (signal === 2) return "SIGINT"
    if (signal === 15) return "SIGTERM"
    return `signal ${signal}`
  }
  const handler = (signal: NodeJS.Signals | number) => shutdown.request(nameOf(signal))
  // SIGINT/SIGTERM/SIGHUP all route to the one owner shutdown state. The
  // coordinator is spawned detached and unref'd, so closing the parent terminal
  // never forwards its SIGHUP here; this handler only answers a HUP delivered
  // directly to the owning process (design D3).
  process.on("SIGHUP", handler)
  process.on("SIGINT", handler)
  process.on("SIGTERM", handler)
  return () => {
    process.off("SIGHUP", handler)
    process.off("SIGINT", handler)
    process.off("SIGTERM", handler)
  }
}

export type RunResult = {
  runID: string
  /** Absolute path of the run workspace; removed on success unless the run is kept. */
  dir: string
  /** Parsed consensus score when the pipeline ended in a quality-score-report step. */
  qualityScore?: QualityScore
  /** Present when the pipeline's terminal goal step ran: the complete cycle outcome. */
  goal?: GoalCycleOutcome
  /**
   * Present on a hosted run (options.progress set): closes the run's opencode
   * server, releases its coordinator lease, and clears its metadata server
   * entry — everything the finally defers so the caller decides when the run
   * may shut down.
   */
  release?: () => Promise<void>
}

/**
 * Runs under a hosted `options.progress` defer their server/lease cleanup to a
 * `RunResult.release`. A failed run throws instead of returning a result, so the
 * teardown (and the run dir, which the loop's failed finish screen needs) rides
 * on the error object itself; the goal loop fetches it with this helper in its
 * failure path.
 */
export type HostedRunTeardown = {
  release: () => Promise<void>
  runDir: string
}

const hostedTeardowns = new WeakMap<object, HostedRunTeardown>()

export function hostedTeardownFromError(error: unknown): HostedRunTeardown | undefined {
  if (error && typeof error === "object") return hostedTeardowns.get(error)
  return undefined
}

/**
 * Injected dependencies for `run()`, mirroring the goal loop's `default*Deps`
 * pattern: a named constant covering every member so the seam is discoverable
 * and every override replaces the whole surface at once. The hosted-run tests
 * override `startOpencode` to exercise `run()` without spawning a real SDK
 * server — this keeps that fake out of `mock.module`, which is process-global
 * and would otherwise poison `test/opencode.test.ts`'s import of the real
 * module whenever test load order puts the hosted tests first.
 */
export type RunDeps = {
  startOpencode: typeof startOpencode
  /** Hosted-run tests inject a recorder; production constructs a real reporter. */
  createHerdrReporter?: (input: { runID: string }) => HerdrReporter
  /** Test seam: overrides the finalization retry policy (injected sleep/limits). */
  finalizationRetry?: FinalizationRetryOptions
}

const defaultRunDeps: RunDeps = { startOpencode }

export async function run(options: RunOptions, deps: RunDeps = defaultRunDeps) {
  // CLI callers hand the exact reviewed plan to the runner. Keep accepting
  // legacy programmatic RunOptions for API/tests, but never re-resolve a plan.
  const modelOverride = options.modelOverride
  if (options.plan) {
    options.pipeline = options.plan.pipeline
    options.onlySteps = []
    options.skipSteps = []
    options.modelOverride = ""
    if (options.plan.smartJudge) options.smartJudgeModel = options.plan.smartJudge.model.target
  }
  if (options.plan) ensureRunnersAvailable(options.plan.pipeline)
  await ensureRepoReady(options.targetDir, {
    includeDirty: options.includeDirty,
    baseRef: options.baseRef,
    allowDirty: Boolean(options.resumeRunID),
  })

  const workspace = options.resumeRunID
    ? await resumeWorkspace(options.resumeRunID)
    : await createWorkspace(options.prompt)

  if (options.prdHistory && !options.resumeRunID && options.prompt.trim()) {
    try {
      await writePrdHistory({
        targetDir: options.targetDir,
        runID: workspace.runID,
        prompt: options.prompt,
        pipeline: options.pipeline.name,
        branch: await currentBranch(options.targetDir),
      })
    } catch (error) {
      log.warn(`couldn't write PRD history: ${formatSdkError(error)}`)
    }
  }

  let runErr: unknown
  let opencode: Awaited<ReturnType<typeof startOpencode>> | undefined
  let progress: ProgressUI = noopProgress
  let permissions: PermissionGate | undefined
  // One arbiter shared by the permission gate and every phase gate so a --no-tui
  // parallel run never opens two readlines on stdin at once.
  const terminalInput = createTerminalInput()
  let advisorBridge: AdvisorBridge | undefined
  let reportBridge: ReportBridge | undefined
  let advisorJournal: AdvisorEventJournal | undefined
  let metadata: RunMetadataStore | undefined
  let control: RunControl | undefined
  let caffeinate: Caffeinate | undefined
  let notifier: Notifier | undefined
  let herdr: HerdrReporter | undefined
  let statusTracker: RunStatusTracker | undefined
  let titleSaved = false
  let releaseLease: (() => Promise<void>) | undefined
  let hookSet = options.plan?.hooks ?? hooksForPipeline(options.hooks, options.pipeline.name)
  let pipelineNameForHooks = options.pipeline.name
  let postHooksStarted = false
  // Hosted runs defer the server/lease teardown here; the loop calls it between
  // iterations and after its finish hold.
  let deferredRelease: (() => Promise<void>) | undefined
  const shutdown = options.shutdown ?? new RunShutdown()
  // A coordinated run injects the coordinator-owned scope so the process
  // signal handlers stay installed through the terminal finish hold and final
  // release; direct runs own their scope locally (design D3).
  const ownsShutdown = options.shutdown === undefined
  const removeSignalHandlers = ownsShutdown ? installShutdownSignals(shutdown) : () => {}

  const autoAccept: AutoAccept = options.autoAccept ?? options.progress?.autoAccept ?? { mode: options.yolo ? "all" : options.smart ? "smart" : "off" }
  // cli.ts always resolves a concrete model string (--smart-model → config →
  // --model → defaults.model), so smart mode never lacks a judge.
  const judgeModel = parseModel(splitModelVariant(options.smartJudgeModel).model)

  /**
   * Stops the owned server and only then clears the live-server pointer and
   * the run's execution ownership. Awaiting `stop()` is not proof of exit: an
   * `unresolved` outcome keeps both as evidence rather than reporting a clean
   * shutdown, and the child's identity record survives independently under
   * `~/.convoy/processes` (design D3).
   */
  const stopOwnedServer = async (): Promise<StopOutcome | undefined> => {
    const stop = await opencode?.stop()
    if (stop?.status === "unresolved") {
      log.warn(`run server stop unresolved; keeping live-server metadata and execution ownership: ${stop.reason}`)
      await metadata?.flush().catch((error) => log.warn(`couldn't flush run metadata: ${String(error)}`))
      return stop
    }
    await metadata?.serverStopped().catch((error) => log.warn(`couldn't persist server-stopped metadata: ${String(error)}`))
    await metadata?.flush().catch((error) => log.warn(`couldn't flush run metadata: ${String(error)}`))
    await clearServerAuth(workspace.dir).catch(() => {})
    await releaseLease?.().catch((error) => log.warn(`couldn't release run lease: ${String(error)}`))
    return stop
  }

  try {
    releaseLease = await acquireRunLease(workspace)
    // The run's branch, resolved once: the confirmed worktree branch for an
    // isolated run, otherwise whatever the execution tree has checked out. The
    // persisted run title (capability run-titles) and the terminal-title
    // identity both derive from it and must agree.
    const runBranch = options.branch ?? (await currentBranch(options.targetDir))
    metadata = await openRunMetadata(workspace, options.targetDir, options.pipeline, {
      gateway: options.plan?.modelRouting.gateway ?? options.gateway ?? "configured",
      gatewayOverride: options.gatewayExplicit ?? false,
      modelOverride: Boolean(modelOverride),
      // The plan has already applied --only/--skip. Never re-expand a reviewed
      // resume back to the entire persisted pipeline.
      useExecutionPipeline: Boolean(options.resumeRunID && options.plan),
      // The reviewed feature link persists before any execution (task 4.2).
      ...(options.plan?.feature ? { feature: options.plan.feature } : {}),
      // The accepted ordered local changes feed the run-title precedence
      // (capability run-titles, task 10.3): proposal title → humanized branch
      // → prompt line, resolved once at open and persisted.
      ...(options.plan?.specs ? { specs: options.plan.specs } : {}),
      ...(runBranch ? { branch: runBranch } : {}),
    })
    const pipeline = metadata.pipeline
    pipelineNameForHooks = pipeline.name
    hookSet = options.plan?.hooks ?? hooksForPipeline(options.hooks, pipeline.name)
    validateStepFilters(pipeline, options)
    // The run boundary (capability run-finalization, design D2) is persisted
    // before pre-hooks or any writable execution, so automatic compaction has
    // a durable run-start HEAD and branch identity to verify against. A
    // boundary that cannot be persisted refuses to start writable execution;
    // a pipeline with only read-only steps never rewrites history and may run.
    await persistRunBoundary(metadata, options, pipeline)
    // Parallel/multi-model steps are forced read-only and point at a synthesized
    // "<agent>__ro" variant when their base agent isn't already read-only;
    // verifying steps that share an agent with a non-verifying use get
    // "<agent>__verify". Register those variants alongside the catalogue.
    const agents = agentsForPipeline(pipeline, options.agents)
    ensureAgentsAvailable(pipeline, agents)
    // A CLI runner is an optional dependency: only a pipeline that actually
    // runs a step on it needs its CLI, checked before anything runs.
    ensureRunnersAvailable(pipeline)
    // A run interrupted before its phase commit leaves the tree dirty; on resume
    // offer to commit that work as the interrupted phase and continue. Runs here,
    // before the TUI grabs the terminal, so the readline prompt stays visible.
    await maybeRecoverDirtyTree(workspace, metadata, options)
    control = new RunControl(metadata)
    caffeinate = new Caffeinate()

    // Identity for the terminal title and notifications, reusing the branch
    // resolved for metadata above.
    const phases = progressPhases(pipeline, hookSet)
    // Persist the canonical planned list once so attach and history can render
    // every row — hook rows included — before it runs, in canonical order.
    await metadata.recordPlannedPhases(phases).catch((error) => log.warn(`couldn't persist planned phases: ${formatSdkError(error)}`))
    const identity = {
      project: projectName(options.targetDir),
      pipeline: pipeline.name,
      ...(runBranch ? { branch: runBranch } : {}),
    }
    // Resolve the defaults up front. An unset CLI switch preserves config;
    // explicit --notify and --no-notify apply after that merge.
    const notificationSettings = {
      ...defaultNotificationSettings,
      ...options.notifications,
      ...(options.notify === undefined ? {} : { enabled: options.notify }),
    }
    notifier = new Notifier({ settings: notificationSettings })
    // Outside a Herdr pane this is a silent no-op; inside one it claims the
    // pane as agent "convoy" and publishes the live pipeline state.
    herdr = (deps.createHerdrReporter ?? ((input) => new HerdrReporter(input)))({ runID: workspace.runID })
    // A repeated signal can force exit while pre-hooks or server boot are still
    // running. Arm pane cleanup as soon as the reporter exists; once the owned
    // server starts, the handler below is widened to force both resources.
    shutdown.setForceHandler(() => {
      void herdr?.forceRelease()
    })
    statusTracker = new RunStatusTracker({
      phases,
      identity,
      sinks: {
        ...(notifier.available ? { notify: (event) => void notifier?.notify(event) } : {}),
        // Replaced by bind() below when the UI offers its own title channel;
        // this fallback is what --no-tui runs use.
        ...(notificationSettings.terminalTitle ? { title: (status) => void writeTerminalTitle(formatTerminalTitle(status)) } : {}),
        // The reporter dedupes identical statuses, so the tracker can fire on
        // every publish without flooding Herdr.
        herdr: (status) => void herdr?.report(status),
      },
    })
    // Saved before the renderer exists so the pop in the finally block hands the
    // tab back to whatever owned it, rather than leaving Convoy's last title up.
    if (notificationSettings.terminalTitle) titleSaved = pushTerminalTitle()

    // Imported lazily: publish pulls in the summary readers, which a run that
    // never reaches its finish screen shouldn't pay for.
    const { createPublishSeam } = await import("./publish")
    const hostControls: ProgressHostControls = {
      onPauseToggle: () => {
        void control?.toggle().catch((error) => log.warn(`couldn't persist pause state: ${formatSdkError(error)}`))
      },
      onKeepAwakeToggle: () => {
        void caffeinate?.toggle().catch((error) => log.warn(`couldn't toggle Caffeinate: ${formatSdkError(error)}`))
      },
      publish: createPublishSeam({ cwd: options.targetDir, runDir: workspace.dir }),
    }
    if (options.progress) {
      // Hosted by the coordinator (or the goal loop): reuse its dashboard or
      // control adapter, repoint it at this run's controls and shutdown, and
      // let this run's finally never tear it down.
      options.progress.setHostControls?.(hostControls)
      options.progress.setAbortHandler?.(() => shutdown.request("Ctrl+C"))
      options.progress.resetPipeline?.(phases, { runID: workspace.runID, targetDir: options.targetDir, runDir: workspace.dir, pipeline })
      progress = trackRunStatus(recordProgress(options.progress, metadata), statusTracker)
    } else {
      // Production CLI never reaches here: every run is a coordinated process
      // with a ControlProgress adapter (slice 2+). Direct programmatic callers
      // and tests that pass no `progress` get a silent noop renderer — no TUI
      // is created inside run() anymore (slice 4).
      progress = trackRunStatus(recordProgress(noopProgress, metadata), statusTracker)
    }
    control.bind(progress)
    caffeinate.bind(progress)
    if (notificationSettings.terminalTitle) statusTracker.bind(progress)
    progress.start(workspace.runID, options.targetDir, workspace.dir)
    log.info(`Run ${workspace.runID} - dir: ${workspace.dir}`)
    // Use the captured flag: options.modelOverride was already cleared when a
    // reviewed plan took over, but the Claude Code notice must still fire.
    const overrideNotice = modelOverrideNotice(pipeline, modelOverride)
    if (overrideNotice) {
      progress.message(overrideNotice)
      log.warn(overrideNotice)
    }
    if (options.yolo) {
      progress.message("YOLO enabled: ask-level permissions will be auto-allowed (denylist still applies); shift+tab toggles")
      log.warn("YOLO enabled: unknown non-denied commands will be auto-allowed")
    } else if (options.smart) {
      progress.message(`smart auto-accept enabled: ${formatModel(judgeModel)} judges each request; risky ones still prompt (shift+tab toggles)`)
      log.warn(`smart auto-accept enabled: ${formatModel(judgeModel)} will auto-allow requests it judges safe`)
    }

    if (!options.resumeRunID) {
      await runHooks("pre", hookSet.pre, {
        workspace,
        targetDir: options.targetDir,
        pipelineName: pipeline.name,
        prompt: options.prompt,
        progress,
        signal: shutdown.signal,
      })
    } else if (hookSet.pre.length > 0) {
      for (const name of hookPhaseNames("pre", hookSet.pre)) progress.phaseSkipped(name)
      progress.message("pre-hooks skipped while resuming an existing run")
      log.info("pre-hooks skipped on resume")
    }

    const extraFiles = await fileParts(options.files, options.targetDir, "error")
    if (extraFiles.length > 0) log.info(`User attachments: ${extraFiles.map((file) => file.filename).join(", ")}`)
    const projectContextFiles = await discoverProjectContextFiles(options.targetDir)
    if (projectContextFiles.length > 0) log.info(`Project context: ${projectContextFiles.join(", ")}`)

    // The signal must only cover the boot wait: the SDK binds it to the server
    // process and would kill opencode the instant Ctrl+C lands, breaking the
    // graceful session-abort that runs during shutdown.
    const boot = new AbortController()
    const abortBoot = () => boot.abort(shutdown.signal.reason)
    shutdown.signal.addEventListener("abort", abortBoot, { once: true })
    // Derived from the frozen pipeline, so a resume rebuilds the same advisor
    // machinery the run started with.
    const advisorNeeds = advisorNeedsOf(pipeline.steps)
    // The nitro gateway routes every OpenRouter model of this run by throughput.
    // The routing is injected as per-model provider options in the run's own
    // OpenCode config, never as a model-id suffix (OpenCode's catalog cannot
    // resolve `:nitro`), so the user's global config keeps its default routing.
    const throughputModels =
      (options.plan?.modelRouting.gateway ?? options.gateway ?? "configured") === "nitro"
        ? throughputRoutedModels(pipeline, autoAccept.mode === "smart" ? judgeModel : undefined)
        : []
    // The run's OpenCode server exists only for what runs on OpenCode: an
    // OpenCode step (goal fragments included), an OpenCode-routed advisor, or
    // an OpenCode smart judge. A Claude-only plan never installs, boots, or
    // authenticates OpenCode (spec runner-execution, "Claude-only workstation").
    const needsServer = runNeedsOpencodeServer(pipeline, options.smart ? judgeModel : undefined)
    // The report bridge serves every runner: OpenCode's write_report plugin and
    // Claude's write_report MCP tool both submit through the run's runtime.
    let reports: ReportRuntime | undefined
    reportBridge = await startReportBridge({ reports: () => reports })
    let advisors: AdvisorRuntime | undefined
    if (needsServer) {
      // Every custom tool must exist before the server spawns: the run config
      // names each plugin package and the server loads them at startup. Every
      // OpenCode phase owns a report, so this path is deliberately independent
      // of whether any phase has an advisor. The run's agents scope each
      // phase's write_report schema (no commit when read-only, scores only
      // for scorers).
      // Per-run plugin directory: each package embeds this run's bridge URL and
      // token, and V2 watches plugin sources, so a shared location would let a
      // concurrent run rewrite a live run's tools.
      const pluginDir = runPrivateDir(workspace.dir)
      const pluginEntries = [await installWriteReportTool({ url: reportBridge.url, token: reportBridge.token, dir: pluginDir, agents })]
      // The advisor bridge serves a runtime created only after the SDK returns a
      // client, so it uses the same deferred lookup pattern.
      if (advisorNeeds.agents.size > 0) {
        // Start the bridge first so we have the URL and token to embed in the
        // tool source. The tool file must exist before the server spawns, but
        // the bridge only needs to be listening — no client yet.
        advisorBridge = await startAdvisorBridge({ advisors: () => advisors })
        // Embed the URL and token as string literals in the tool source so
        // subprocesses (bash tool calls) cannot read them via process.env.
        pluginEntries.push(...(await installAdvisorTool({ url: advisorBridge.url, token: advisorBridge.token, dir: pluginDir })))
      }
      try {
        opencode = await deps.startOpencode(
          opencodeConfig(workspace.dir, options.targetDir, agents, options.permissions, {
            advisorAgents: advisorNeeds.agents,
            advisorModels: advisorNeeds.models,
            throughputModels,
            plugins: pluginEntries.map((entry) => dirname(entry)),
          }),
          boot.signal,
          // The run server is owned through the coordinator's release; helpers
          // default to their own short-lived lifetime class. The run id rides the
          // lifetime record so a later orphan recovery can tie the child back to
          // its run (design D6).
          { lifetime: "run", runId: workspace.runID, env: specStepEnv(options.targetDir, options.plan?.specs) },
        )
      } finally {
        shutdown.signal.removeEventListener("abort", abortBoot)
      }
      const server = opencode
      // A repeated abort or the shutdown deadline forces this owned server
      // before the process exits; without this edge a wedged cleanup would
      // abandon the child (design D3).
      shutdown.setForceHandler(() => {
        // Start the bounded pane release before the last-resort exit timer. The
        // normal finally still awaits the same idempotent promise when it wins.
        void herdr?.forceRelease()
        server.forceStop()
      })
      progress.serverReady(server.url)
      // Publish the private connection auth for the dashboard's attach path
      // (design D2): the password stays out of the generic run metadata.
      await writeServerAuth(workspace.dir, { url: server.url, ...(server.password ? { password: server.password } : {}) }).catch(() => {})
      // Link the live-server block to the actual child identity (design D6): the
      // historical coordinator `pid` stays, and the record id / child PID/birth
      // let an operator (or later recovery) identify the `serve` child without
      // reinterpreting legacy metadata. An unresolved stop keeps this block.
      metadata.recordServerChild({
        ...(server.recordId ? { recordId: server.recordId } : {}),
        pid: server.pid,
        ...(server.identity?.birth ? { birth: server.identity.birth } : {}),
      })
      // serverReady persists asynchronously through the progress adapter. Flush
      // before phases (or a hosted return) can expose this run for [o] attach.
      await metadata.flush()
      log.info(`opencode SDK ready at ${server.url}`)
    } else {
      shutdown.signal.removeEventListener("abort", abortBoot)
      log.info("no step, advisor, or judge of this plan runs on OpenCode: no OpenCode server is started")
    }

    advisors = createAdvisorRuntime({
      ...(opencode ? { client: opencode.client } : {}),
      // A CLI-routed advising model consults under its reviewed route's auth:
      // the advisor route's override, else its runner's configured auth.
      advisorAuth: (runner) => advisorAuthFor(runner, options),
      directory: options.targetDir,
      signal: shutdown.signal,
      auditPolicy: options.advisorAuditPolicy ?? "summary",
      ...(advisorNeeds.agents.size > 0
        ? {
            onEvent: async (event: AdvisorEvent) => {
              advisorJournal ??= await createAdvisorEventJournal(workspace)
              await advisorJournal.append(event)
              progress.phaseAdvisorEvent(event.phase, event)
              const detail = advisorEventLogLine(event)
              progress.phaseActivity(event.phase, detail, event.type === "advisor.failed" ? "error" : "info")
            },
          }
        : {}),
    })
    reports = createReportRuntime(workspace.dir)

    // OpenCode's asks arrive on its server's event bus; Claude's reach the
    // operator through each attempt's approval service instead.
    if (opencode) {
      permissions = startPermissionGate({
        client: opencode.client,
        progress,
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        directory: options.targetDir,
        autoAccept,
        judgeModel,
        ...(judgeAuthOf(options) ? { judgeAuth: judgeAuthOf(options)! } : {}),
        terminalInput,
        serverUrl: opencode.url,
        ...(opencode.password ? { serverPassword: opencode.password } : {}),
        ...(advisorNeeds.agents.size > 0 ? { advisorCheckpoint: advisors.checkpoint } : {}),
      })
    }

    const resuming = Boolean(options.resumeRunID)
    const gitLock = createGitLock()
    // Caps concurrent agents within a group so a large `parallel:`/`models:`
    // fan-out doesn't open dozens of live sessions (each an event stream + poll
    // timer) at once; smaller groups are unaffected.
    const limitAgents = createConcurrencyLimiter(Math.max(1, options.maxConcurrentAgents ?? defaultMaxConcurrentAgents))
    // Narrow once, outside any closure: opencode/metadata are `let`s assigned
    // above, and TS won't retain that narrowing inside the batch's nested
    // arrow functions, but a `const` alias captured here stays narrowed.
    const client = opencode?.client
    const serverUrl = opencode?.url
    const serverPassword = opencode?.password
    const runMetadata = metadata

    // One shared execution context: the pipeline prefix and every goal
    // fragment invocation run through the same machinery against the same
    // workspace, metadata store, server, and gates.
    const phaseGroupsContext = {
      client,
      workspace,
      metadata: runMetadata,
      options,
      extraFiles,
      projectContextFiles,
      progress,
      shutdown,
      control,
      gitLock,
      limitAgents,
      resuming,
      serverUrl,
      serverPassword,
      permissions,
      terminalInput,
      advisors,
      reports,
    } satisfies PhaseGroupContext

    await executePhaseGroups(phaseGroupsContext, pipeline.steps)

    // The embedded goal cycle: measurement zero, then bounded improve/measure
    // rounds — all inside this one run context. One workspace, one metadata
    // store, one server, one hook lifecycle; every invocation runs through the
    // same phase machinery as the prefix, under invocation-qualified physical
    // phase IDs and iteration-qualified report paths.
    let goalOutcome: GoalCycleOutcome | undefined
    let goalView: GoalLoopView | undefined
    if (pipeline.goalPlan) {
      const rubricWeights = await loadQualityRubricWeights(options.targetDir)
      goalOutcome = await runGoalCycle(pipeline.goalPlan, {
        targetDir: options.targetDir,
        isAbort: isUserAbortError,
        // A resumed goal run continues from its durable record's pending
        // improve/measure group instead of restarting the cycle.
        ...(options.resumeRunID ? { resume: runMetadata.goalState() } : {}),
      }, {
        executeGroups: (invocation) => executePhaseGroups(phaseGroupsContext, invocation.steps),
        parseScore: async (invocation) => (await readRunQualityScore({ name: pipeline.name, steps: invocation.steps }, workspace.dir, rubricWeights))?.score,
        promoteScore: (invocation) => promoteScoreReport(workspace.dir, invocation),
        captureSnapshot: createCleanRepoSnapshot,
        // A goal-discarded attempt tip is protected with a create-only ref
        // before the best measured state is restored (capability
        // run-finalization, task 1.4), so the discarded work stays inspectable
        // even after the restore and ordinary garbage collection. A protection
        // failure refuses the restoration (design D3): restoreBestEffort
        // discloses the refusal and the branch stays where the last iteration
        // left it, instead of the tip being reset away unprotected.
        restoreSnapshot: async (snapshot, cwd) => {
          const head = await currentHead(cwd)
          if (head) {
            const protectedTip = await protectAttemptTip(`${runRefPrefix(workspace.runID)}/goal-attempts/${head.slice(0, 12)}`, head, cwd)
            if (!protectedTip) {
              throw new Error(
                `couldn't protect the goal attempt tip ${head.slice(0, 12)} behind its evidence ref; refusing to restore the best measured state`,
              )
            }
          }
          await restoreRepoSnapshot(snapshot, cwd)
        },
        isCleanRepo: async (cwd) => (await statusPorcelain(cwd)).trim() === "",
        currentHead,
        checkpoint: (state) => runMetadata.checkpointGoal(state),
        onView: (view) => {
          goalView = view
          progress.setGoalLoop?.(view)
        },
      })
    }

    progress.message("writing run summary")
    const advisorSection = advisorNeeds.agents.size > 0 ? renderAdvisorSplit(await readAdvisorSplit(workspace.dir)) : undefined
    const goalSection = goalOutcome && pipeline.goalPlan ? renderGoalSummarySection(goalOutcome, pipeline.goalPlan) : undefined
    await writeSummary(
      workspace,
      pipeline.steps.map((step) => step.name),
      [...(goalSection ? [goalSection] : []), ...(advisorSection ? [advisorSection] : [])],
    )
    // Capture the consensus score before cleanup: the workspace (and with it
    // reports/score-report.md) is deleted on success, and finish tooling needs
    // the score and the report text. Under a goal cycle the authoritative
    // measurement lives in the measure fragment's latest invocation, which the
    // scheduler promoted to the conventional reports/score-report.md. The
    // fragment copy below is resolved with unqualified names, so a
    // custom-named consensus step would point at a report path that never got
    // written; point it at the promoted conventional location instead.
    const rubricWeights = await loadQualityRubricWeights(options.targetDir)
    let scorePipeline = pipeline
    if (pipeline.goalPlan) {
      const consensus = pipeline.goalPlan.measure.steps.find((step) => step.deliverableContract?.kind === "quality-score-report")
      scorePipeline = consensus
        ? { ...pipeline, steps: [{ ...consensus, reportPath: "reports/score-report.md" }] }
        : { ...pipeline, steps: pipeline.goalPlan.measure.steps }
    }
    const runScoreResult = await readRunQualityScore(scorePipeline, workspace.dir, rubricWeights)
    if (runScoreResult) {
      log.info(`quality score: ${runScoreResult.score.score}/100 (${runScoreResult.score.verdict})`)
    }
    // Automatic run finalization (capability run-finalization): the terminal
    // `Compact run` lifecycle row. It runs once, after phases and goal
    // settlement and BEFORE the success post-hooks, so a hook that publishes
    // acts on the compacted result instead of un-compacted history. It is not
    // a configurable step, cannot be filtered, and its outcome is persisted
    // independently of the pipeline result — a safely blocked or failed
    // compaction leaves this execution successful.
    const { runFinalizationWithRetry } = await import("./finalization/compact")
    progress.phaseStarted(compactRunRowName, "compacting this run's commits")
    const finalizationRecord = await (async () => {
      try {
        return await runFinalizationWithRetry(
          {
            runID: workspace.runID,
            targetDir: options.targetDir,
            runDir: workspace.dir,
            boundary: metadata.boundary(),
            ledger: metadata.ledger(),
            ...(identity.branch ? { branch: identity.branch } : {}),
            // The reviewed feature link survives workspace cleanup (task 5.1).
            ...(options.plan?.feature ? { feature: options.plan.feature } : {}),
            // The commit writer follows its configured route; a CLI runner's
            // route runs under that runner's auth, never OpenCode.
            ...(options.commitMessageModel ? { commitMessageModel: options.commitMessageModel } : {}),
            ...(options.commitMessageModel && options.runnerAuth?.[runnerOfModelReference(options.commitMessageModel)]
              ? { commitMessageAuth: options.runnerAuth[runnerOfModelReference(options.commitMessageModel)]! }
              : {}),
            signal: shutdown.signal,
            // The commit writer's helper runs under this coordinator, so its
            // bounded stop draws from the coordinator's remaining shutdown
            // budget instead of a fresh standalone allowance (design D2).
            stopPolicy: () => shutdown.stopBudget(),
            progress: {
              activity: (detail, kind) => progress.phaseActivity(compactRunRowName, detail, kind),
            },
          },
          deps.finalizationRetry,
        )
      } catch (error) {
        // A crash inside finalization is itself a failed attempt, not a
        // pipeline failure: record it and keep the run's success intact.
        return {
          schemaVersion: 1 as const,
          state: "failed" as const,
          reason: `finalization crashed: ${error instanceof Error ? error.message : String(error)}`,
          updatedAt: Date.now(),
        }
      }
    })()
    await metadata.setFinalization(finalizationRecord).catch((error) => log.warn(`couldn't persist finalization outcome: ${String(error)}`))
    if (finalizationRecord.state === "completed") {
      progress.phaseCompleted(compactRunRowName, finalizationRecord.producedSha ? `compacted into ${finalizationRecord.producedSha.slice(0, 8)}` : finalizationRecord.reason)
    } else {
      const detail = [finalizationRecord.reason, finalizationRecord.state].filter(Boolean).join(" — ")
      if (finalizationRecord.state === "failed") progress.phaseFailed(compactRunRowName, detail)
      else progress.phaseSkipped(compactRunRowName)
      const line = `run compaction ${finalizationRecord.state}${finalizationRecord.reason ? `: ${finalizationRecord.reason}` : ""}`
      progress.message(line)
      log.warn(line)
    }
    const finalizationSection = renderFinalizationSummarySection(finalizationRecord)
    await appendSummarySection(workspace, finalizationSection).catch((error) => log.warn(`couldn't append finalization summary: ${String(error)}`))

    // Success post-hooks run once, after the whole cycle and after compaction
    // (a goal cycle's outcome rides along: CONVOY_GOAL_REACHED distinguishes
    // "cleared the bar" from "gave up short of it" in a way `when: success`
    // alone cannot). The compaction outcome rides along too, so a publishing
    // hook can gate on a completed compaction instead of re-deriving it.
    postHooksStarted = true
    await runHooks("post", hookSet.post, {
      workspace,
      targetDir: options.targetDir,
      pipelineName: pipeline.name,
      prompt: options.prompt,
      status: "success",
      progress,
      signal: shutdown.signal,
      ...(runScoreResult ? { score: runScoreResult.score.score } : {}),
      ...(goalOutcome && pipeline.goalPlan
        ? {
            goal: {
              reached: goalOutcome.reached,
              target: pipeline.goalPlan.target,
              ...(goalOutcome.bestScore !== undefined ? { score: goalOutcome.bestScore } : {}),
            },
          }
        : {}),
      finalization: {
        state: finalizationRecord.state,
        ...(finalizationRecord.producedSha ? { producedSha: finalizationRecord.producedSha } : {}),
        ...(finalizationRecord.producedMessage ? { producedMessage: finalizationRecord.producedMessage } : {}),
        ...(finalizationRecord.reason ? { reason: finalizationRecord.reason } : {}),
      },
    })

    await caffeinate.stop()
    await holdFinishScreen(progress, shutdown, {
      status: "completed",
      runDir: workspace.dir,
      ...(runScoreResult ? { qualityScore: runScoreResult.score.score } : {}),
      // The finish screen freezes the verdict and the full measured trajectory.
      ...(goalView ? { goalLoop: goalView } : {}),
      // The compaction outcome rides the finish screen separately from the
      // pipeline result (capability run-finalization, design D8): blocked or
      // failed compaction stays visible without turning execution into failure.
      ...(finalizationRecord
        ? {
            finalization: {
              state: finalizationRecord.state,
              ...(finalizationRecord.reason ? { reason: finalizationRecord.reason } : {}),
              ...(finalizationRecord.producedSha ? { producedSha: finalizationRecord.producedSha } : {}),
            },
          }
        : {}),
    }, Boolean(options.progress))
    // Hosted runs skip the finish hold, so the tracker's runFinished wrapper
    // never fires here. Publish the terminal snapshot now so Herdr shows
    // idle/completed while the coordinator holds the finish screen — instead
    // of vanishing from the agents list via a premature release-agent.
    statusTracker.finished({
      status: "completed",
      runDir: workspace.dir,
      ...(runScoreResult ? { qualityScore: runScoreResult.score.score } : {}),
      ...(goalView ? { goalLoop: goalView } : {}),
    })
    return {
      runID: workspace.runID,
      dir: workspace.dir,
      ...(runScoreResult ? { qualityScore: runScoreResult.score } : {}),
      ...(goalOutcome ? { goal: goalOutcome } : {}),
      // The release closure is built by the finally below; the arrow reads the
      // variable afterwards, so it is always ready by the time the loop calls it.
      ...(options.progress ? { release: async () => { await deferredRelease?.() } } : {}),
    }
  } catch (error) {
    let failure = error
    // A primitive thrown value (string, number, …) cannot key the WeakMap the
    // goal loop fetches the hosted teardown from, so wrap it in an Error
    // preserving the original as the message. The goal loop already handles
    // both Error and primitive throws via `instanceof Error` checks and
    // `String(error)`, so the wrapped value reads identically to the original.
    if (typeof failure !== "object" || failure === null) failure = new Error(String(failure))
    // Deferral does not apply here: a failed run ends the loop, so there is no
    // later point to defer to, and the failure hooks must still fire. They run
    // without CONVOY_GOAL_* — the loop never reached an outcome — so a hook that
    // gates on CONVOY_GOAL_REACHED correctly stays inert.
    if (!postHooksStarted && !isUserAbortError(failure)) {
      postHooksStarted = true
      try {
        await runHooks("post", hookSet.post, {
          workspace,
          targetDir: options.targetDir,
          pipelineName: pipelineNameForHooks,
          prompt: options.prompt,
          status: "failure",
          progress,
          signal: shutdown.signal,
        })
      } catch (hookError) {
        failure = new Error(`${formatSdkError(error)}; post-hook failed: ${formatSdkError(hookError)}`)
      }
    }
    runErr = failure
    if (!isUserAbortError(failure)) {
      await caffeinate?.stop()
      await holdFinishScreen(progress, shutdown, { status: "failed", error: formatSdkError(failure), runDir: workspace.dir }, Boolean(options.progress))
      statusTracker?.finished({ status: "failed", error: formatSdkError(failure), runDir: workspace.dir })
    } else if (options.progress) {
      // A hosted abort never reaches progress.stop() below (the coordinator
      // owns the shared UI and skips it), so the tracker's terminal snapshot
      // would never publish: Herdr's agent vanished with the release-agent
      // command instead of showing the run stopped. In-process aborts still
      // publish through progress.stop() in the finally.
      statusTracker?.stopped()
    }
    throw failure
  } finally {
    removeSignalHandlers()
    if (shutdown.aborted) await shutdown.abortActiveSessions(progress)
    // The run's attempt compositions end with it.
    await releaseAttemptCompositions(workspace.runID)
    await caffeinate?.stop()
    await notifier?.stop()
    await permissions?.stop()
    if (options.progress) {
      // The goal loop owns the dashboard and decides when this run's server may
      // shut down: hand the teardown back as a release, and never stop the
      // shared UI or restore the constructor abort handler yet.
      options.progress.setAbortHandler?.(undefined)
      deferredRelease = async () => {
        // The finish hold has ended: release the pane first, before any server,
        // workspace, or bridge cleanup that can reject or fail to settle.
        await herdr?.stop()
        // Before the server: a tool call still in flight would otherwise hang on
        // a socket nobody is going to answer. The bridge goes first — the tool
        // source carries the URL and token embedded as string literals (not
        // process.env), and they point at a bridge that no longer exists.
        reportBridge?.close()
        advisorBridge?.close()
        // Bridges first, then confirm the owned child exited before clearing
        // the live-server pointer or releasing execution ownership (design D3).
        await stopOwnedServer()
        // Hosted teardown runs after the coordinator's finish hold, so an
        // attached [i]/[o] can still flip keepRunDirRequested before we decide
        // whether the workspace may go. In-process runs settle in the finally
        // below — they have already left their own finish screen.
        await settleRunWorkspace(workspace, options, progress, runErr)
      }
      if (runErr && typeof runErr === "object") {
        hostedTeardowns.set(runErr, { release: deferredRelease, runDir: workspace.dir })
      }
    } else {
      // Stop the tracker first so an interrupted run publishes its final
      // stopped snapshot, then release Herdr before server teardown can stall.
      progress.stop()
      await herdr?.stop()
      // Before the server: a tool call still in flight would otherwise hang on a
      // socket nobody is going to answer. The bridge goes first — the tool source
      // carries the URL and token embedded as string literals (not process.env),
      // and they point at a bridge that no longer exists. The tool's execute will
      // fail with a fetch error, which it handles gracefully.
      reportBridge?.close()
      advisorBridge?.close()
      // The owned server stops and its exit is confirmed before the
      // live-server pointer and execution ownership are cleared (design D3).
      await stopOwnedServer()
    }
    // In-process runs stop the tracker and Herdr above; hosted runs keep Herdr
    // claimed until release(), after the coordinator's finish hold.
    // After the renderer is gone: restoring the title while it still owns the
    // alternate screen would be overwritten by its teardown.
    if (titleSaved) popTerminalTitle()
    // A coordinator-owned scope outlives this run: it stays live through the
    // finish hold and release, and its caller disposes it (design D3).
    if (ownsShutdown) shutdown.dispose()

    // Hosted runs settle the workspace in release(), after the coordinator
    // (or goal loop) has held the finish screen. Doing it here would delete
    // the run dir before [i] iterate can ask to keep it.
    if (!options.progress) await settleRunWorkspace(workspace, options, progress, runErr)
  }
}

/**
 * Everything `executePhaseGroups` needs to run one ordered list of steps
 * against the run's shared machinery. Built once per run by `run()` — the
 * workspace, metadata store, OpenCode client, permission gate, control
 * bindings, and hooks all outlive any single phase group.
 */
export type PhaseGroupContext = {
  /** The run's OpenCode server client; absent when nothing in the plan runs on OpenCode. */
  client: OpencodeClient | undefined
  workspace: Workspace
  metadata: RunMetadataStore
  options: RunOptions
  extraFiles: FilePartInput[]
  projectContextFiles: string[]
  progress: ProgressUI
  shutdown: RunShutdown
  control: RunControl
  gitLock: GitLock
  limitAgents: ReturnType<typeof createConcurrencyLimiter>
  resuming: boolean
  serverUrl: string | undefined
  serverPassword: string | undefined
  permissions: PermissionGate | undefined
  terminalInput: TerminalInput
  advisors: AdvisorRuntime | undefined
  reports: ReportRuntime | undefined
}

/**
 * Executes an ordered list of pipeline steps as phase groups: batches them
 * (parallel blocks and model fan-outs share a group), gates each batch on
 * pause/control state, restores completed phases on resume, and runs each
 * phase through the full attempt/commit/permission/baseline machinery.
 *
 * Extracted from `run()` verbatim so a future scheduler can execute goal
 * fragments through exactly this path — same attempts, commits, permissions,
 * advisors, failure gates, read-only baselines, and usage accounting — while
 * the outer run keeps one workspace, one metadata store, and one lifecycle.
 * Every batch member runs to completion (Promise.allSettled, not fail-fast)
 * since forced-read-only siblings can't corrupt each other's work; a user
 * abort takes priority and propagates unwrapped, and ordinary failures
 * aggregate into one `PhaseGroupError` after the control checkpoint.
 */
export async function executePhaseGroups(ctx: PhaseGroupContext, steps: readonly Step[]): Promise<void> {
  const { client, workspace, metadata, options, extraFiles, projectContextFiles, progress, shutdown, control, gitLock, limitAgents, resuming, serverUrl, serverPassword, permissions, terminalInput, advisors, reports } = ctx

  for (const batch of planBatches(steps)) {
    shutdown.throwIfRequested()
    await control.awaitRunnable(shutdown.signal)
    const [first] = batch

    if (batch.length === 1 && first?.type === "human") {
      control.beginBatch(1)
      if (shouldSkip(first, options)) {
        progress.phaseSkipped(first.name)
        log.warn(`[${first.name}] skipped by flag`)
        await control.checkpointAfterBatch(shutdown.signal)
        continue
      }
      await runHumanReviewGate(workspace, options, serverUrl ? { url: serverUrl, ...(serverPassword ? { password: serverPassword } : {}) } : undefined, progress, permissions, first.name, undefined, metadata)
      await control.checkpointAfterBatch(shutdown.signal)
      continue
    }

    const agentBatch = batch as AgentStep[]
    control.beginBatch(agentBatch.filter((step) => !shouldSkip(step, options)).length)
    const results = await Promise.allSettled(
      agentBatch.map(async (step) => {
        if (shouldSkip(step, options)) {
          progress.phaseSkipped(step.name)
          log.warn(`[${step.name}] skipped by flag`)
          return
        }
        await limitAgents(async () => {
          const restored = resuming && (await restorePhaseFromPreviousRun(workspace, metadata, step, progress))
          if (!restored) {
            await runPhase(client, workspace, metadata, step, options, extraFiles, projectContextFiles, progress, shutdown, gitLock, { ...(serverUrl ? { serverUrl } : {}), ...(serverPassword ? { serverPassword } : {}), permissions, terminalInput }, advisors, reports)
          }
        })
      }),
    )

    const userAbort = results.find((result): result is PromiseRejectedResult => result.status === "rejected" && isUserAbortError(result.reason))
    if (userAbort) throw userAbort.reason
    const failures = results.flatMap((result, index) => (result.status === "rejected" ? [{ name: agentBatch[index]!.name, error: result.reason }] : []))
    await control.checkpointAfterBatch(shutdown.signal)
    if (failures.length > 0) throw new PhaseGroupError(failures)
  }
}

async function settleRunWorkspace(
  workspace: Workspace,
  options: Pick<RunOptions, "keepRunDir">,
  progress: ProgressUI,
  runErr: unknown,
) {
  if (runErr) {
    log.warn(`Run dir preserved at ${workspace.dir}`)
    return
  }
  if (options.keepRunDir || progress.keepRunDirRequested?.()) {
    log.info(`Run dir kept at ${workspace.dir}`)
    return
  }
  await cleanupWorkspace(workspace).catch((error) => log.warn(`couldn't clean ${workspace.dir}: ${String(error)}`))
}

// The finish screen holds the run open while the opencode server and the run
// dir are still alive, so [o] can attach to phase sessions and reports stay
// readable. A signal (SIGTERM, a second Ctrl+C) must still tear the run down
// without user input, hence the race against the shutdown signal.
//
// A hosted run (options.progress set) never holds: its caller — the
// coordinator — owns the terminal and the attached dashboard shows the finish
// screen through the control protocol. A goal cycle runs inside the run, so
// there is exactly one hold, at the very end, with the verdict and trajectory.
export async function holdFinishScreen(progress: ProgressUI, shutdown: RunShutdown, outcome: RunOutcome, hosted = false) {
  if (!progress.runFinished || shutdown.aborted || hosted) return
  await Promise.race([
    progress.runFinished(outcome),
    new Promise<void>((resolve) => shutdown.signal.addEventListener("abort", () => resolve(), { once: true })),
  ])
}

// A failed or interrupted phase can still leave a report behind (the agent
// writes it mid-session before the commit step or a later attempt blows up),
// so the report's existence alone can't prove the phase finished. Its stale
// report must go before persistPhaseReport would keep it on the rerun.
export async function restorePhaseFromPreviousRun(
  workspace: Workspace,
  metadata: RunMetadataStore,
  phase: AgentStep,
  progress: ProgressUI,
): Promise<boolean> {
  if (await phaseNeedsRun(workspace, metadata, phase)) {
    if (await removePhaseReport(workspace, phase)) {
      log.info(`[${phase.name}] failed in the previous run; retrying`)
    }
    return false
  }

  const snapshot = metadata.snapshot(phase.name)
  if (snapshot) progress.phaseRestored(phase.name, snapshot)
  else progress.phaseCompleted(phase.name, "already completed in previous run")
  log.info(`[${phase.name}] report exists; skipping on resume`)
  return true
}

async function removePhaseReport(workspace: Workspace, phase: AgentStep): Promise<boolean> {
  const reportAbs = join(workspace.dir, phase.reportPath)
  if (!(await exists(reportAbs))) return false
  await rm(reportAbs, { force: true })
  return true
}

// A phase still needs to run on resume when its report is missing (it never
// finished), or metadata says the earlier process never finalized it. A report
// can be written before the phase commit, so it cannot turn a running/failed
// phase into a completed one.
async function phaseNeedsRun(workspace: Workspace, metadata: RunMetadataStore, phase: AgentStep): Promise<boolean> {
  if (metadata.phaseStatus?.(phase.name) === "skipped") return false
  if (!(await exists(join(workspace.dir, phase.reportPath)))) return true
  if (metadata.phaseStatus?.(phase.name) === "running") return true
  return metadata.snapshot(phase.name)?.status === "failed"
}

// The agent phase a resume would run next: the first one still needing a run,
// skipping human gates. The dirty tree belongs to whichever phase was
// interrupted before its commit, which is exactly that phase.
export async function selectInterruptedPhase(
  workspace: Workspace,
  metadata: RunMetadataStore,
  pipeline: Pipeline,
): Promise<AgentStep | undefined> {
  // Lifecycle metadata is authoritative when present: a later running/failed
  // phase must not be hidden by an earlier skipped/completed phase whose agent
  // happened not to produce a report.
  for (const step of pipeline.steps) {
    if (step.type !== "agent") continue
    const status = metadata.phaseStatus?.(step.name)
    if (status === "running" || status === "failed") return step
  }
  for (const step of pipeline.steps) {
    if (step.type !== "agent") continue
    if (await phaseNeedsRun(workspace, metadata, step)) return step
  }
  return undefined
}

// On resume with a dirty tree, offer to commit the interrupted phase's leftover
// work and continue. Runs before the TUI starts so the prompt owns the terminal.
async function maybeRecoverDirtyTree(workspace: Workspace, metadata: RunMetadataStore, options: RunOptions) {
  if (!options.resumeRunID) return
  await assertPendingReadOnlyResumeBaselines(metadata, metadata.pipeline, options.targetDir)
  const phase = await selectInterruptedPhase(workspace, metadata, metadata.pipeline)

  const porcelain = await statusPorcelain(options.targetDir)
  if (porcelain.trim() === "") return

  const dirty = () => dirtyTreeError(options.targetDir, porcelain, { resuming: true })
  // No pending agent phase means the changes don't belong to an interrupted
  // phase (stray edits); leave them for the user rather than guess.
  if (!phase) throw dirty()
  // Read-only output is never recoverable agent work: it may be a concurrent
  // user edit, so committing it under the phase name would misattribute it.
  if (phase.readOnly) throw dirty()
  if (!(stdin.isTTY && stdout.isTTY)) throw dirty()
  if (!(await confirmRecovery(phase.name, porcelain))) throw dirty()

  await commitRecoveredPhase(workspace, metadata, phase, options.targetDir)
}

async function confirmRecovery(phaseName: string, porcelain: string): Promise<boolean> {
  stdout.write(`Resume found uncommitted changes from interrupted phase "${phaseName}":\n${dirtyFilesPreview(porcelain)}\n`)
  const rl = createInterface({ input: stdin, output: stdout })
  const controller = new AbortController()
  let interrupted = false
  // Raw-mode readline swallows the process SIGINT and emits this event instead;
  // without it Ctrl+C at the prompt would hang.
  rl.on("SIGINT", () => {
    interrupted = true
    controller.abort()
  })
  try {
    const answer = (await rl.question(`commit changes as '${phaseName}' and continue? [y/N] > `, { signal: controller.signal })).trim().toLowerCase()
    return answer === "y" || answer === "yes"
  } catch (error) {
    if (interrupted) throw new UserAbortError("Ctrl+C received")
    throw error
  } finally {
    rl.close()
  }
}

/** The terminal lifecycle row's stable identity (capability run-finalization, design D1/D8). */
export const compactRunRowName = "Compact run"

/** Renders the finalization outcome as a summary section; always present so a blocked attempt is as durable as a success. */
function renderFinalizationSummarySection(record: {
  state: string
  reason?: string
  producedSha?: string
  producedMessage?: string
  recoveryRef?: string
}): string | undefined {
  const lines = ["## Run finalization", "", `- State: ${record.state}`]
  if (record.producedSha) lines.push(`- Compacted into ${record.producedSha.slice(0, 8)}`)
  if (record.recoveryRef) lines.push(`- Pre-compaction history protected at ${record.recoveryRef}`)
  if (record.reason) lines.push(`- Reason: ${record.reason}`)
  return `${lines.join("\n")}\n`
}

async function appendSummarySection(workspace: Workspace, section: string | undefined) {
  if (!section) return
  await appendFile(join(workspace.dir, "SUMMARY.md"), section)
}

/**
 * Persists the run boundary before pre-hooks or any writable execution
 * (capability run-finalization, task 1.2). The store ignores repeat calls, so
 * a same-run resume keeps the original boundary. A persist failure refuses to
 * start writable execution — without a durable boundary, automatic compaction
 * could not verify what it owns — while a read-only-only pipeline may proceed.
 */
export async function persistRunBoundary(metadata: RunMetadataStore, options: RunOptions, pipeline: Pipeline): Promise<void> {
  const head = await currentHead(options.targetDir)
  if (!head) {
    // A repository with no commits has no boundary to record; the first
    // writable commit will fail long before compaction could matter.
    log.warn("no run boundary recorded: the repository has no commits yet")
    return
  }
  const boundary: RunBoundary = {
    schemaVersion: 1,
    worktreeDir: options.targetDir,
    branch: await currentBranch(options.targetDir),
    startHead: head,
    commonDir: (await gitCommonDir(options.targetDir)) ?? "",
    includeDirty: options.includeDirty === true,
    recordedAt: Date.now(),
  }
  try {
    await metadata.recordBoundary(boundary)
  } catch (error) {
    const writable = pipeline.steps.some((step) => step.type === "agent" && !step.readOnly)
    if (!writable) {
      log.warn(`couldn't persist the run boundary; continuing because no step is writable: ${formatSdkError(error)}`)
      return
    }
    throw new Error(`couldn't persist the run boundary before execution; refusing to start writable work: ${formatSdkError(error)}`)
  }
}

// Treats the dirty tree as the interrupted phase's output: writes a recovery
// report if the phase never wrote one, commits everything as that phase, and
// marks it completed so the resume loop skips it and runs the rest.
export async function commitRecoveredPhase(
  workspace: Workspace,
  metadata: RunMetadataStore,
  phase: AgentStep,
  targetDir: string,
) {
  if (phase.readOnly) {
    throw new Error(`[${phase.name}] refusing to commit preserved changes from a read-only phase; resolve them manually before resuming`)
  }
  const reportAbs = join(workspace.dir, phase.reportPath)
  if (!(await exists(reportAbs))) {
    await mkdir(dirname(reportAbs), { recursive: true })
    await writeFile(reportAbs, recoveryReport(phase.name))
  }

  const committed = await recordLedgeredCommit(
    (entry) => metadata.appendLedgerEntry(entry).catch((error) => log.warn(`couldn't persist commit ledger entry: ${String(error)}`)),
    { mode: "recovery", step: phase.name, cwd: targetDir },
    () =>
      addAllAndCommit(
        stepCommitMessageFactory({ workspace, step: phase.name, mode: "recovery", phaseName: phase.agentName, reportPath: reportAbs }),
        targetDir,
      ),
  )
  if (committed) log.info(`[${phase.name}] recovered uncommitted changes into a run-linked commit; continuing from the next phase`)
  else log.warn(`[${phase.name}] nothing to commit during recovery`)

  await metadata.phaseEnded(phase.name, "completed").catch((error) => log.warn(`couldn't persist phase-ended metadata: ${String(error)}`))
  await metadata.flush()
}

function recoveryReport(phaseName: string) {
  return [
    "# Recovered uncommitted changes",
    "",
    `Phase "${phaseName}" was interrupted before convoy committed its work. The`,
    "uncommitted changes left in the working tree were committed as this phase during a",
    "manual resume recovery, and the pipeline continued from the next phase.",
    "",
  ].join("\n")
}

/** What the mid-step interactive gate needs to reopen the session window and hold permission prompts. */
export type TakeoverContext = {
  /** The run's OpenCode server, for reopening an OpenCode phase's session; absent on a Claude-only run. */
  serverUrl?: string
  /** The run server's generated password; the reopened OpenCode client needs it to connect. */
  serverPassword?: string
  permissions?: PermissionGate
  /** Shared terminal-input arbiter so a failed member's gate and a live sibling's permission prompt never both read stdin. */
  terminalInput?: TerminalInput
}

async function runPhase(
  client: OpencodeClient | undefined,
  workspace: Workspace,
  metadata: RunMetadataStore,
  phase: AgentStep,
  options: RunOptions,
  extraFiles: FilePartInput[],
  projectContextFiles: string[],
  progress: ProgressUI,
  shutdown: RunShutdown,
  gitLock: GitLock,
  takeover?: TakeoverContext,
  advisors?: AdvisorRuntime,
  reports?: ReportRuntime,
) {
  progress.phaseStarted(phase.name, phase.description)
  log.section(`${phase.name} - ${phase.description}`)

  try {
    const prepared = await preparePhaseRun(workspace, phase, options, extraFiles, projectContextFiles)
    const baseline = await gitLock(async () => {
      const snapshot = await createCleanRepoSnapshot(options.targetDir)
      if (phase.readOnly && !snapshot) {
        const porcelain = await statusPorcelain(options.targetDir)
        throw new Error(
          `[${phase.name}] read-only steps require a clean working tree so Convoy can detect unexpected side effects without discarding concurrent user work\n${dirtyFilesPreview(porcelain)}`,
        )
      }
      return snapshot
    })
    if (phase.readOnly && baseline) await metadata.phaseRepositoryBaseline(phase.name, baseline)
    const reportAbs = await withReadOnlyRepositoryBoundary(phase, options.targetDir, baseline, gitLock, async () => {
      const contract = deliverableContractForPhase(phase)
      // One rubric read shared by the phase loop and the persist step, so the
      // artifact that persists is always validated with the same weights the
      // loop accepted it with.
      const rubricWeights = contract.kind === "quality-score-report" ? ((await loadQualityRubricWeights(options.targetDir)) ?? qualityDimensionWeights) : qualityDimensionWeights
      const candidate = await runPhaseUntilResolved(client, workspace, phase, options.targetDir, prepared, baseline, progress, shutdown, gitLock, takeover, undefined, advisors, reports, rubricWeights)
      return persistPhaseReport(workspace, phase, candidate, contract, rubricWeights)
    })
    // The phase commit is ledgered (capability run-finalization): before/after
    // endpoints land in durable metadata so compaction can verify run
    // ownership by provenance instead of authorship. A failed ledger write
    // leaves the commit unaccounted for, which blocks compaction — fails
    // closed, never over-includes.
    await gitLock(() =>
      recordLedgeredCommit(
        (entry) => metadata.appendLedgerEntry(entry).catch((error) => log.warn(`couldn't persist commit ledger entry: ${String(error)}`)),
        { mode: "phase", step: phase.name, cwd: options.targetDir },
        () => finalizePhaseRepository(phase, reportAbs, options.targetDir, baseline, undefined, workspace),
      ),
    )
    progress.phaseCompleted(phase.name, "report saved and commit checked")
  } catch (error) {
    progress.phaseFailed(phase.name, formatSdkError(error))
    throw error
  }
}

/** Clear ambient feature routing before applying the reviewed bundle's tool. Never mutates its input. */
export function specStepEnv(checkout: string, bundle?: SpecBundle, inherited: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const { SPECIFY_FEATURE_DIRECTORY: _directory, SPECIFY_FEATURE_NO_PERSIST: _persist, ...env } = inherited
  return { ...env, ...(bundle ? specTools[bundle.tool].stepEnv(checkout, bundle.changeIds) : {}) }
}

type PreparedPhaseRun = {
  /** A per-run copy: retries and every runner inherit the frozen spec selection. */
  env?: Record<string, string | undefined>
  attachments: FilePartInput[]
  /** The overflow fallback: the prompt lists the attachments by path instead of inlining them. */
  attachmentsByPath?: boolean
  prompt: string
  model: ModelSelection
  /** Resolved exactly once, here, and threaded through unchanged: re-resolving would re-arm defaults over `maxPhaseCost: false`. */
  loopGuard: LoopGuardConfig
  /** Project additions to the bash policy, for runners that enforce it themselves. */
  permissions?: PermissionAdditions
  /** The run's live auto-accept reference; read when each attempt starts. */
  autoAccept?: AutoAccept
  /** The configured authentication of the phase's runner; absent means subscription. */
  auth?: AuthenticationSelection
  /** The authentication a CLI-routed smart judge runs under. */
  judgeAuth?: AuthenticationSelection
  /** The smart auto-accept judge, for a runner whose asks the engine decides. */
  judgeModel?: { providerID: string; modelID: string; variant?: string }
  /** No human decides this run (human steps off): failure and budget gates fail the step instead of holding. */
  unattended?: boolean
}

export async function preparePhaseRun(
  workspace: Workspace,
  phase: AgentStep,
  options: RunOptions,
  extraFiles: FilePartInput[],
  projectContextFiles: string[],
): Promise<PreparedPhaseRun> {
  const inputs = [...phase.inputFiles]
  if (phase.inputDiff) {
    // An oversized diff comes back as its overview; the full diff stays beside it.
    inputs.push(await writeDiff(join(workspace.dir, "diffs", `${phase.name}.pre.diff`), options.baseRef, options.targetDir))
  }

  const phaseFiles = await fileParts(inputs, workspace.dir, "skip")
  const contextFiles = await projectContextFileParts(projectContextFiles, options.targetDir)
  // The spec bundle is the live contract: attach it to every agent step. Steps
  // that already receive it through the prdHistory slot (scope/scorers) must
  // not get it twice — `scopeContractFiles` either attaches the bundle or
  // falls back to the historical PRD.
  const historyCoversBundle = Boolean(options.prdHistory && phase.prdHistory)
  const historyFiles = historyCoversBundle ? await scopeContractFiles(options, workspace.runID) : []
  const specFiles = historyCoversBundle ? [] : await specBundleFileParts(options)
  const attachments = [...contextFiles, ...phaseFiles, ...historyFiles, ...specFiles, ...extraFiles]
  const prompt = buildPhasePrompt(workspace, phase, options.plan?.specs)
  const model = selectedModel(phase, options.modelOverride)

  return {
    env: specStepEnv(options.targetDir, options.plan?.specs),
    attachments,
    prompt,
    model,
    loopGuard: resolveLoopGuard(options.loopGuard),
    permissions: options.permissions,
    autoAccept: options.autoAccept ?? options.progress?.autoAccept ?? { mode: options.yolo ? "all" : options.smart ? "smart" : "off" },
    ...(options.runnerAuth?.[stepRunnerFor(phase.runner).id] ? { auth: options.runnerAuth[stepRunnerFor(phase.runner).id]! } : {}),
    ...(judgeAuthOf(options) ? { judgeAuth: judgeAuthOf(options)! } : {}),
    ...(options.smartJudgeModel ? { judgeModel: judgeModelOf(options.smartJudgeModel) } : {}),
    ...(options.humanReview ? {} : { unattended: true }),
  }
}

/** Best-effort dynamic attachment: history stays out of frozen pipeline metadata. */
async function historicalPrdFileParts(targetDir: string, excludeRunID: string): Promise<FilePartInput[]> {
  try {
    const branch = await currentBranch(targetDir)
    if (!branch) return []
    const entry = pickPrdHistory(await readPrdHistoryIndex(targetDir), {
      branch,
      excludeRunID,
      fileExists: (candidate) => {
        try {
          return existsSync(prdHistoryFile(targetDir, candidate))
        } catch {
          return false
        }
      },
    })
    if (!entry) return []
    return await fileParts([prdHistoryFile(targetDir, entry)], targetDir, "skip")
  } catch (error) {
    log.warn(`couldn't read PRD history: ${formatSdkError(error)}`)
    return []
  }
}

/**
 * The scope contract for a prdHistory-opted phase: the selected spec bundle when
 * an active change resolved on this checkout, else the single oldest historical
 * PRD. The bundle supersedes history only on detection — a repo without
 * a configured spec layout, or one with no active change, keeps today's behavior.
 */
async function scopeContractFiles(options: RunOptions, excludeRunID: string): Promise<FilePartInput[]> {
  const bundle = options.plan?.specs
  if (bundle && bundle.changeIds.length > 0) return specBundleFileParts(options)
  return historicalPrdFileParts(options.targetDir, excludeRunID)
}

/**
 * Attaches every file of the frozen contract bundle. Empty when
 * no change resolved, so callers can always concatenate it.
 */
async function specBundleFileParts(options: RunOptions): Promise<FilePartInput[]> {
  const bundle = options.plan?.specs
  if (!bundle || bundle.changeIds.length === 0) return []
  try {
    // The run's checkout is the only artifact source (delta run-launcher:
    // preparation and execution resolve inputs from the execution checkout;
    // a missing selected source is disclosed, never borrowed from the launch
    // directory or another checkout).
    const paths: string[] = []
    for (const file of bundle.specFiles) {
      const inRun = join(options.targetDir, file)
      if (existsSync(inRun)) paths.push(inRun)
    }
    if (paths.length < bundle.specFiles.length) {
      log.warn(`${specTools[bundle.tool].label} spec bundle: ${bundle.specFiles.length - paths.length} of ${bundle.specFiles.length} spec files are missing from the run's checkout; skipped — no other checkout was consulted`)
    }
    return await fileParts(paths, options.targetDir, "skip")
  } catch (error) {
    log.warn(`couldn't attach ${specTools[bundle.tool].label} spec bundle: ${formatSdkError(error)}`)
    return []
  }
}

async function projectContextFileParts(paths: string[], targetDir: string) {
  const out: FilePartInput[] = []
  for (const path of paths) {
    const parts = await fileParts([path], targetDir, "skip")
    out.push(...parts.map((part) => ({ ...part, filename: path })))
  }
  return out
}

type PhaseRetryDeps = {
  runPhaseAttempt: typeof runPhaseAttempt
  restorePhaseBaseline: typeof restorePhaseBaseline
}

class DeliverableValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DeliverableValidationError"
  }
}


export async function runPhaseUntilResolved(
  client: OpencodeClient | undefined,
  workspace: Workspace,
  phase: AgentStep,
  targetDir: string,
  prepared: PreparedPhaseRun,
  baseline: RepoSnapshot | undefined,
  progress: ProgressUI,
  shutdown: RunShutdown,
  gitLock: GitLock,
  takeover?: TakeoverContext,
  deps: PhaseRetryDeps = { runPhaseAttempt, restorePhaseBaseline },
  advisors?: AdvisorRuntime,
  reports?: ReportRuntime,
  /** The rubric weights used for score validation; shared with persistPhaseReport so both sites agree. */
  rubricWeights?: Record<QualityDimension, number>,
) {
  const sessionRef: SessionRef = {}
  const deliverableContract = deliverableContractForPhase(phase)
  const weights =
    rubricWeights ??
    (deliverableContract.kind === "quality-score-report" ? ((await loadQualityRubricWeights(targetDir)) ?? qualityDimensionWeights) : qualityDimensionWeights)
  let automaticDeliverableRetries = 0
  // Swapped once, for the by-path fallback, when the inlined attachments overflow the model's context.
  let run = prepared
  // A budget-gate reset starts a new prompt but keeps the renewable guard's
  // other fuses (especially accumulated cost) intact. Ordinary retries still
  // receive a fresh guard because they begin a clean phase attempt.
  let budgetGuard: LoopGuard | undefined
  // Read fresh at each decision point: the user can arm/disarm [i] mid-attempt.
  const armed = () => Boolean(takeover && progress.isInteractiveTakeover?.(phase.name))

  try {
    for (let attempt = 1; ; attempt++) {
      shutdown.throwIfRequested()
      const loopGuard = budgetGuard ?? new LoopGuard(prepared.loopGuard)
      budgetGuard = undefined
      progress.phaseAttempt(phase.name, { attempt, model: formatModel(prepared.model) })
      log.info(`[${phase.name}] attempt ${attempt} with ${formatModel(prepared.model)}`)
      try {
        const text = await deps.runPhaseAttempt(
          client,
          workspace,
          phase,
          targetDir,
          run,
          attempt,
          progress,
          shutdown,
          sessionRef,
          advisors,
          reports,
          deliverableContract,
          weights,
          loopGuard,
        )
        let candidate = await resolveDeliverableCandidate(workspace, phase, text, reports?.candidateFor(sessionRef.id ?? ""))
        const validation = validateDeliverableContract(deliverableContract, candidate, weights)
        if (!validation.valid) {
          await persistInvalidPhaseReport(workspace, phase, attempt, candidate)
          // An armed takeover owns the step even when its deliverable fails
          // validation: hand it to the user instead of auto-retrying or failing
          // terminally behind their back. Continue re-resolves the report — a
          // write_report made in the reopened session ends the phase; without a
          // valid report the gate re-opens instead of advancing.
          if (armed()) {
            for (;;) {
              const outcome = await waitForPhaseGate(phase.name, targetDir, sessionRef.id, takeover, progress, {
                kind: "interactive",
                canRetry: false,
                error: validation.error,
                signal: shutdown.signal,
                onAbort: () => {
                  if (!shutdown.aborted) shutdown.request("phase gate abort")
                },
                runner: phase.runner,
                runDir: workspace.dir,
                ...(run.auth ? { auth: run.auth } : {}),
              })
              // "unavailable": nobody can take over, so the automatic policy below applies.
              if (outcome !== "continue") break
              const rescued = await resolveDeliverableCandidate(workspace, phase, "", reports?.candidateFor(sessionRef.id ?? ""))
              const rescuedValidation = validateDeliverableContract(deliverableContract, rescued, weights)
              if (rescuedValidation.valid) return rescued
            }
          }
          const totalAttempts = deliverableContract.kind === "quality-score-report" ? deliverableContract.retryOnMissingOrInvalid + 1 : undefined
          const attemptContext = totalAttempts === undefined ? `attempt ${attempt}` : `attempt ${attempt} of ${totalAttempts}`
          const canRetryAutomatically =
            deliverableContract.kind === "quality-score-report" && automaticDeliverableRetries < deliverableContract.retryOnMissingOrInvalid
          if (canRetryAutomatically) {
            automaticDeliverableRetries++
            log.warn(
              `[${phase.name}] deliverable validation failed (${attemptContext}): ${validation.error}; retrying automatically`,
            )
            await gitLock(() => deps.restorePhaseBaseline(phase, baseline, targetDir, new DeliverableValidationError(validation.error)))
            await removePhaseReport(workspace, phase)
            // The retry starts a fresh session: release the old session's handles so a
            // late write_report from its window cannot reach the new attempt.
            releasePhaseSession(sessionRef, reports, advisors)
            continue
          }
          log.error(`[${phase.name}] deliverable validation failed (${attemptContext}): ${validation.error}`)
          // Only the scored contract is terminal by policy: accepting a missing
          // score through the human failure gate would complete a scored run with
          // no machine-readable result. A markdown-report failure is an ordinary
          // attempt failure — the human gate ([r]/[o]/[a]) decides.
          if (deliverableContract.kind === "quality-score-report") throw new DeliverableValidationError(validation.error)
          throw new Error(validation.error)
        }
        if (armed()) {
          // Armed means "this step is mine": even a clean finish waits for the
          // user's decision before the step commits and the pipeline moves on.
          // Continue re-resolves the deliverable so a write_report made while the
          // gate was open wins over the candidate computed before the gate.
          log.info(`[${phase.name}] attempt succeeded with interactive mode armed; waiting for manual action`)
          for (;;) {
            const outcome = await waitForPhaseGate(phase.name, targetDir, sessionRef.id, takeover, progress, {
              kind: "interactive",
              canRetry: false,
              signal: shutdown.signal,
              onAbort: () => {
                if (!shutdown.aborted) shutdown.request("phase gate abort")
              },
              runner: phase.runner,
              runDir: workspace.dir,
              ...(run.auth ? { auth: run.auth } : {}),
            })
            // A gate that cannot be asked (no TUI, no controller) must not spin
            // on re-resolution: keep the already-validated candidate, exactly
            // like the pre-gate behavior. Only a real continue re-resolves.
            if (outcome !== "continue") break
            candidate = await resolveDeliverableCandidate(workspace, phase, text, reports?.candidateFor(sessionRef.id ?? ""))
            if (validateDeliverableContract(deliverableContract, candidate, weights).valid) break
          }
        }
        return candidate
      } catch (error) {
        if (shutdown.aborted || isUserAbortError(error)) throw shutdown.abortError(error)
        if (error instanceof LoopGuardError && error.trip.reason === "max-steps") {
          // The budget gate replaces the failure gate for this trip, so journal
          // the attempt here — the generic path below is never reached for it.
          if (!(error instanceof LoggedAttemptError)) await writeAttemptLog(workspace, phase, attempt, { error: formatSdkError(error) })
          const outcome = await waitForPhaseGate(phase.name, targetDir, sessionRef.id, takeover, progress, {
            kind: "budget-gate",
            error: formatSdkError(error),
            canRetry: false,
            ...(run.unattended ? { unattended: true } : {}),
            signal: shutdown.signal,
            onAbort: () => {
              if (!shutdown.aborted) shutdown.request("budget gate abort")
            },
            runner: phase.runner,
            runDir: workspace.dir,
            ...(run.auth ? { auth: run.auth } : {}),
          })
          // A noninteractive budget gate cannot choose reset, so preserve the
          // original hard-limit failure instead of allowing a silent continuation.
          // Any unexpected outcome fails too: falling through to the failure gate
          // below would re-offer [o]+[c], continuing a budget-exhausted phase
          // without the reset the budget contract requires.
          if (outcome !== "reset") throw error
          loopGuard.resetSteps()
          budgetGuard = loopGuard
          // The reset starts a new prompt with a new session: end the pre-reset
          // attempt's handles so its write_report window cannot leak into the reset.
          releasePhaseSession(sessionRef, reports, advisors)
          continue
        }
        // The inlined attachments did not fit the model's context and compaction
        // had nothing earlier to shrink, so the same prompt can only fail again.
        // Retry once listing the files by path: the agent reads what it needs.
        if (isContextOverflowError(error) && !run.attachmentsByPath && run.attachments.length > 0) {
          if (!(error instanceof LoggedAttemptError)) await writeAttemptLog(workspace, phase, attempt, { error: formatSdkError(error) })
          log.warn(`[${phase.name}] attempt ${attempt} overflowed the model's context: ${formatSdkError(error)}; retrying with attachments by path`)
          progress.phaseActivity(phase.name, "context overflow; retrying with attachments by path", "retry")
          run = { ...run, attachmentsByPath: true }
          await gitLock(() => deps.restorePhaseBaseline(phase, baseline, targetDir, error))
          await removePhaseReport(workspace, phase)
          releasePhaseSession(sessionRef, reports, advisors)
          continue
        }
        // A scored-contract failure is terminal after its bounded automatic retry:
        // accepting a missing score through the human failure gate would turn a
        // missing score into a successful scored run with no machine-readable
        // result. Other contract failures (empty markdown) are ordinary attempt
        // failures and reach the gate like any other failed attempt.
        if (error instanceof DeliverableValidationError && deliverableContract.kind === "quality-score-report") throw error
        if (!(error instanceof LoggedAttemptError)) await writeAttemptLog(workspace, phase, attempt, { error: formatSdkError(error) })
        progress.phaseRunning(phase.name, "step failed — waiting for your decision")
        log.warn(`[${phase.name}] attempt ${attempt} failed: ${formatSdkError(error)}`)
        // The failure/interactive gate decides the failed attempt. A continue
        // re-resolves the deliverable from the recovered session's write_report:
        // with a valid report the step advances with it, and without one the gate
        // re-opens with the validation error instead of skipping the deliverable.
        let gateError = formatSdkError(error)
        for (;;) {
          const outcome = await waitForPhaseGate(phase.name, targetDir, sessionRef.id, takeover, progress, {
            kind: armed() ? "interactive" : "failure",
            error: gateError,
            canRetry: Boolean(baseline),
            ...(run.unattended ? { unattended: true } : {}),
            signal: shutdown.signal,
            onAbort: () => {
              if (!shutdown.aborted) shutdown.request("phase gate abort")
            },
            runner: phase.runner,
            runDir: workspace.dir,
            ...(run.auth ? { auth: run.auth } : {}),
          })
          if (outcome === "continue") {
            // The failed attempt's chat text is gone; the rescued deliverable can
            // only come from the report runtime or the phase file.
            const rescued = await resolveDeliverableCandidate(workspace, phase, "", reports?.candidateFor(sessionRef.id ?? ""))
            const rescuedValidation = validateDeliverableContract(deliverableContract, rescued, weights)
            if (rescuedValidation.valid) return rescued
            gateError = rescuedValidation.error
            continue
          }
          if (outcome === "unavailable") throw error
          if (outcome === "retry") {
            await gitLock(() => deps.restorePhaseBaseline(phase, baseline, targetDir, error))
            // An agent can write its report before the attempt fails. A clean retry
            // must not later commit or feed that stale report to following phases.
            await removePhaseReport(workspace, phase)
            // Retrying starts a fresh session; the stale handle must release so a
            // late write_report from the old window cannot reach the next attempt.
            releasePhaseSession(sessionRef, reports, advisors)
            break
          }
        }
      }
    }
  } finally {
    // The report/advisor handles must not outlive the phase's decision. Every
    // exit — a delivered candidate, a terminal failure, an abort, or a
    // budget/reset continue — releases the attempt's session so a late
    // write_report from a resolved window cannot touch a later phase.
    releasePhaseSession(sessionRef, reports, advisors)
  }
}

/** Last session created for the phase's attempts, so the interactive gate can reopen its window. */

/**
 * Ends the report/advisor handles of the phase's last live session. Idempotent:
 * a handle that was already ended, or a session that never began one, is a
 * no-op. The map entry has to outlive an idle/failed prompt — the human gate
 * reopens the same session with [o] and writes through write_report — so it is
 * released at the phase's decision point, never while the gate is open.
 */
function releasePhaseSession(sessionRef: SessionRef, reports?: ReportRuntime, advisors?: AdvisorRuntime): void {
  releaseSessionHandles(sessionRef.id, reports, advisors)
}

type PhaseGateOptions = {
  kind: PhaseGateKind
  error?: string
  canRetry: boolean
  /** Cancels an open decision gate promptly during a run-wide shutdown. */
  signal?: AbortSignal
  /** A gate-level abort must also stop live siblings in a parallel batch. */
  onAbort?: () => void
  /** Which runner's session the gate reopens; resolved through the opener table. */
  runner?: StepRunnerId
  /** The reviewed authentication the phase's session ran under, which reopening it needs. */
  auth?: AuthenticationSelection
  runDir?: string
  /**
   * The run has no human decisions (human steps off, the default off a TTY):
   * a failure or budget gate is "unavailable" so the step fails and the run
   * exits non-zero. A coordinated run always has a hold to wait on, so without
   * this a headless failure waited forever for an answer nobody would give.
   */
  unattended?: boolean
}

type SessionWindowInput = { targetDir: string; sessionID: string; runDir: string; url?: string; password?: string; auth?: AuthenticationSelection }

type PhaseGateDeps = {
  /** Legacy test seam: the OpenCode session-window opener. */
  openWindow?: typeof openOpencodeSessionWindow
  /** Legacy test seam: the Claude session-window opener. */
  openClaudeWindow?: typeof openClaudeSessionWindow
  /** Openers by runner id; a runner absent here cannot reopen a window. */
  openers?: Partial<Record<StepRunnerId, (input: SessionWindowInput) => Promise<string>>>
}

/**
 * The session-window openers by runner id. This is a registration, not a core
 * branch: core looks a runner up in the table and never compares a runner name
 * (change `unify-runner-system`, task 4.2).
 */
function sessionWindowOpeners(deps: PhaseGateDeps): Partial<Record<StepRunnerId, (input: SessionWindowInput) => Promise<string>>> {
  if (deps.openers) return deps.openers
  const opencode = deps.openWindow ?? openOpencodeSessionWindow
  const claude = deps.openClaudeWindow ?? openClaudeSessionWindow
  return {
    "opencode": (input) =>
      opencode({ url: input.url ?? "", ...(input.password ? { password: input.password } : {}), targetDir: input.targetDir, sessionID: input.sessionID }),
    "claude-code": (input) => claude({ targetDir: input.targetDir, sessionID: input.sessionID, runDir: input.runDir }),
    codex: (input) => openCodexSessionWindow({ targetDir: input.targetDir, sessionID: input.sessionID, ...(input.auth ? { auth: input.auth } : {}) }),
  }
}

/**
 * What a process-owned session records when it starts, so `[o]` can reopen
 * it later, by runner id: a Claude session remembers the directories it
 * could read. A runner absent here records nothing.
 */
const sessionRecorders: Partial<Record<StepRunnerId, (runDir: string, sessionID: string, attachments: FilePartInput[], targetDir: string) => Promise<void>>> = {
  "claude-code": (runDir, sessionID, attachments, targetDir) => writeClaudeSessionDirectories(runDir, sessionID, claudeReadableDirectories(attachments, targetDir, runDir)),
}

const defaultPhaseGateDeps: PhaseGateDeps = {}

type PhaseGateKind = "interactive" | "failure" | "budget-gate"

export type PhaseGateOutcome = "continue" | "retry" | "reset" | "unavailable"

/** The actions a human gate answers with, per mode. */
function gateAllowedActions(kind: PhaseGateKind, canRetry: boolean): readonly HumanReviewAction[] {
  if (kind === "budget-gate") return ["reset", "abort"]
  if (kind === "interactive") return ["continue", "iterate", "abort"]
  return canRetry ? ["retry", "iterate", "abort"] : ["iterate", "abort"]
}

/**
 * The decision gate after a phase attempt. In "interactive" mode (armed with
 * [i]) it holds a clean finish; in "failure" mode it holds a failed step while
 * the user chooses [r] retry cleanly, [o] open the OpenCode session and fix by
 * hand, or [a] abort. A successful [o] flips a failure gate to "interactive":
 * the user now owns the tree, so [c] unlocks (they know what it holds) and [r]
 * is withdrawn (restoring the baseline would wipe their manual work).
 *
 * Permission prompts pause only while an interactive session is owned — in
 * failure mode a dead step must never freeze the prompts of its live siblings.
 *
 * Returns "unavailable" when nobody can be asked (no dashboard and no TTY): the
 * step then fails with its original error, exactly as it did when attempts ran
 * out.
 */
export async function waitForPhaseGate(
  phaseName: string,
  targetDir: string,
  sessionID: string | undefined,
  takeover: TakeoverContext | undefined,
  progress: ProgressUI,
  options: PhaseGateOptions,
  deps: PhaseGateDeps = defaultPhaseGateDeps,
): Promise<PhaseGateOutcome> {
  // An armed takeover is a human's explicit request, so it holds regardless.
  if (options.unattended && options.kind !== "interactive") return "unavailable"
  const askInTui = progress.askHumanReview?.bind(progress)
  const usingTui = Boolean(askInTui)
  if (!usingTui && !(stdin.isTTY && stdout.isTTY)) return "unavailable"

  let kind: PhaseGateKind = options.kind
  progress.phaseRunning(
    phaseName,
    kind === "interactive" ? "interactive session — waiting for your decision" : kind === "budget-gate" ? "step budget reached — waiting for your decision" : "step failed — waiting for your decision",
  )
  let iterations = 0
  let permissionsPaused = false
  // Pause only the session the interactive TUI owns, never the whole directory:
  // a directory-wide pause would also drop the prompts of live siblings in the
  // same parallel batch, deadlocking them waiting for replies Convoy never sends.
  const pausePermissions = () => {
    if (permissionsPaused || !takeover?.permissions || !sessionID) return
    permissionsPaused = true
    takeover.permissions.pause(sessionID)
  }
  // An interactive session owns the terminal and answers its ordinary prompts,
  // so Convoy's permission gate stays paused for that session while it waits.
  // A failure gate starts without pausing — a dead step must never freeze sibling prompts.
  if (kind === "interactive") pausePermissions()

  // The readline fallback owns the terminal; the TUI path keeps the dashboard
  // active and resolves actions via ProgressUI.askHumanReview. The fallback
  // goes through the run's shared terminal-input arbiter so it can't race a
  // permission prompt for stdin in a --no-tui parallel run.
  const terminalInput = takeover?.terminalInput
  if (!usingTui) progress.suspend()
  try {
    for (;;) {
      const allowed = gateAllowedActions(kind, kind === "failure" ? options.canRetry : false)
      const action = await awaitActionOrAbort(
        askInTui
          ? askInTui({ stepName: phaseName, iterations, kind, error: options.error, canRetry: kind === "failure" ? options.canRetry : false })
          : askHumanAction({ prompt: phaseGatePrompt({ stepName: phaseName, kind, error: options.error, allowed }), allowed, ...(terminalInput ? { terminalInput } : {}) }),
        options.signal,
      )

      // ProgressUI implementations normally enforce the action set themselves;
      // keep the budget gate authoritative so a malformed dashboard reply
      // cannot reopen or continue a phase that exhausted its step budget.
      if (kind === "budget-gate" && action !== "reset" && action !== "abort") continue
      if (action === "continue") return "continue"
      if (action === "abort") {
        options.onAbort?.()
        throw new UserAbortError("aborted from phase gate")
      }
      if (action === "retry") return "retry"
      if (action === "reset") return "reset"

      iterations++
      if (!sessionID) {
        progress.phaseActivity(phaseName, "no session to reopen; use the OpenCode window you already have", "info")
        continue
      }
      try {
        const runnerId = stepRunnerFor(options.runner).id
        const open = sessionWindowOpeners(deps)[runnerId]
        if (!open) {
          progress.phaseActivity(phaseName, `no session-window opener is registered for ${runnerId}`, "error")
          continue
        }
        const backend = await open({
          targetDir,
          sessionID,
          runDir: options.runDir ?? "",
          ...(options.auth ? { auth: options.auth } : {}),
          ...(takeover?.serverUrl ? { url: takeover.serverUrl } : {}),
          ...(takeover?.serverPassword ? { password: takeover.serverPassword } : {}),
        })
        if (kind === "failure") {
          // Only a successfully opened session proves the user took control.
          // Until then, keep [c] unavailable and preserve [r].
          kind = "interactive"
          pausePermissions()
        }
        progress.phaseActivity(phaseName, `session reopened in ${backend}; return here and press c to continue`, "system")
      } catch (error) {
        progress.phaseActivity(phaseName, `couldn't reopen the session window: ${error instanceof Error ? error.message : String(error)}`, "error")
      }
    }
  } finally {
    if (permissionsPaused) takeover?.permissions?.resume(sessionID)
    if (!usingTui) progress.resume()
  }
}

/** Resolves a dashboard/readline action unless a run-wide shutdown arrives first. */
function awaitActionOrAbort<T>(action: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return action
  if (signal.aborted) return Promise.reject(signal.reason ?? new UserAbortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort)
      reject(signal.reason ?? new UserAbortError())
    }
    signal.addEventListener("abort", onAbort, { once: true })
    void action.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Dispatches one phase attempt through the registered composition: the engine
 * prepares a single neutral context, validates the required services by
 * capability, and calls the runner's registered attempt. There is no
 * harness-specific execution branch left in core (tasks 4.1/4.4).
 */
async function runPhaseAttempt(
  client: OpencodeClient | undefined,
  workspace: Workspace,
  phase: AgentStep,
  targetDir: string,
  prepared: PreparedPhaseRun,
  attempt: number,
  progress: ProgressUI,
  shutdown: RunShutdown,
  sessionRef?: SessionRef,
  advisors?: AdvisorRuntime,
  reports?: ReportRuntime,
  deliverableContract?: DeliverableContract,
  rubricWeights?: Record<QualityDimension, number>,
  loopGuard?: LoopGuard,
) {
  const runnerId = stepRunnerFor(phase.runner).id
  const contract = deliverableContract ?? deliverableContractForPhase(phase)
  // One composition per run directory, reused across the run's attempts. It
  // carries the Claude enforcement plan (this Convoy's hook and permission host
  // unless the environment overrides them).
  const env = prepared.env ?? specStepEnv(targetDir)
  const composition = attemptCompositionFor({ runId: workspace.runID, cwd: targetDir, env })

  const registration = composition.registry.require(runnerId)
  const capabilities = await registration.execution.capabilities()
  const weights = rubricWeights ?? qualityDimensionWeights
  // The engine owns the runtimes; the runner's composition binds the ones it
  // honors to the session the attempt creates itself (task 6.2).
  let activeSessionID: string | undefined
  const services = composition.servicesFor(
    runnerId,
    {
      approvals: createOperatorApprovalService({
        ...(client ? { client } : {}),
        ...(prepared.judgeAuth ? { judgeAuth: prepared.judgeAuth } : {}),
        progress,
        directory: targetDir,
        ...(prepared.autoAccept ? { autoAccept: prepared.autoAccept } : {}),
        ...(prepared.judgeModel ? { judgeModel: prepared.judgeModel } : {}),
        signal: shutdown.signal,
        session: () => activeSessionID,
      }),
      ...(reports ? { reports } : {}),
      ...(advisors ? { advisors } : {}),
      loopGuard: loopGuard ?? new LoopGuard(prepared.loopGuard),
      expected: contract.kind === "none" ? [] : ["report"],
      accepts: async (candidate) => {
        const text = candidate ?? (await readFile(join(workspace.dir, phase.reportPath), "utf8").catch(() => undefined))
        return text !== undefined && validateDeliverableContract(contract, text, weights).valid
      },
      session: () => activeSessionID,
    },
    capabilities,
  )
  // A bound service is only reachable once its session is registered with the
  // runtime behind it: the write_report and advisor bridges look the session up
  // there. The handles live until the phase's decision releases them.
  const beginSession = (sessionID: string) => {
    // The phase's gate reopens, and its decision releases, this exact session.
    if (sessionRef) sessionRef.id = sessionID
    beginSessionHandles(sessionID, {
      services,
      ...(reports ? { reports } : {}),
      ...(advisors ? { advisors } : {}),
      phase,
      contract,
      weights,
      attempt,
    })
  }
  const serverSession = composition.abortsSessionOnShutdown(runnerId)
  // The same rules the OpenCode run config encodes, for a runner that enforces
  // them out of process; the auto-accept mode is read when the attempt starts.
  const policy = phasePolicy({
    mode: phase.readOnly ? (phase.verify ? "verify" : "read-only") : "write",
    autoAccept: prepared.autoAccept?.mode ?? "off",
    checkout: targetDir,
    runDir: workspace.dir,
    privateDirs: agentDeniedDirs(workspace.dir),
    commands: bashPolicy(targetDir, prepared.permissions ?? noAdditions, agentDeniedDirs(workspace.dir)),
    advised: Boolean(phase.resolvedAdvisor),
    attachments: prepared.attachments.flatMap((file) => {
      try {
        return [fileURLToPath(file.url)]
      } catch {
        return []
      }
    }),
  })

  // Validate the phase's required services against this runner's own
  // capabilities and resolve its registered attempt, before anything runs.
  const attemptRunner = await resolveAttempt({
    runner: runnerId,
    contract,
    capabilities: async () => capabilities,
    attempt: composition.attemptFor(runnerId),
  })

  // The engine renders the attempt's neutral events, so the attempt never
  // receives the engine's progress target. It also learns the session from the
  // attempt's own `session` event, which is why no shutdown handle is passed.
  const render = progressSink(progress, { runId: workspace.runID, phaseName: phase.name, attempt })

  const context: AttemptContext = {
    identity: { runId: workspace.runID, phaseName: phase.name, attempt },
    runner: runnerId,
    phase,
    targetDir,
    prompt: prepared.attachmentsByPath ? withAttachmentsByPath(prepared.prompt, prepared.attachments) : prepared.prompt,
    model: prepared.model,
    attachments: prepared.attachmentsByPath ? [] : prepared.attachments,
    sink: (event) => {
      // OpenCode's phase logs its session and usage itself; a process-owned
      // session (Claude) reports them only as events, so log the same lines
      // here for whoever follows the coordinator's log, such as a CLI agent.
      if (!serverSession && event.type === "session" && event.session.sessionId !== activeSessionID) {
        log.info(`[${phase.name}] session: ${event.session.sessionId}`)
        // [o] reopens a finished session with what it needs (Claude: the directories it could read).
        void sessionRecorders[runnerId]?.(workspace.dir, event.session.sessionId, prepared.attachments, targetDir).catch((error: unknown) =>
          log.warn(`[${phase.name}] couldn't record the session's readable directories: ${error instanceof Error ? error.message : String(error)}`),
        )
      }
      if (!serverSession && event.type === "usage") log.info(`[${phase.name}] usage: ${formatUsageForLog(toProgressUsage(event.usage))}`)
      if (event.type === "session" && event.session.sessionId !== activeSessionID) {
        activeSessionID = event.session.sessionId
        beginSession(activeSessionID)
        if (serverSession && client) shutdown.setActiveSession({ client, sessionID: activeSessionID, directory: targetDir, phaseName: phase.name })
        // A process-owned session (Claude) has no server holding its
        // transcript: record it, prompt first, for the phase's advisor.
        if (!serverSession && phase.resolvedAdvisor) advisors?.record?.(activeSessionID, { prompt: context.prompt })
      } else if (!serverSession && phase.resolvedAdvisor && activeSessionID) {
        advisors?.record?.(activeSessionID, { event })
      }
      render(event)
    },
    signal: shutdown.signal,
    attempt,
    services,
    policy,
    ...(prepared.auth ? { auth: prepared.auth } : {}),
    // A process-owned session tees its raw stream (`logs/<step>.<attempt>.<runner>.jsonl`).
    ...(!serverSession ? { streamLogPath: join(workspace.dir, "logs", `${phase.name}.${attempt}.${stepRunnerFor(phase.runner).sessionName}.jsonl`) } : {}),
    env,
    client,
  }

  let result: AttemptResult
  try {
    result = await attemptRunner(context)
  } finally {
    if (activeSessionID && serverSession) shutdown.clearActiveSession(phase.name, activeSessionID)
    // Versioned provenance for the attempt (design D11): which runner ran it,
    // under which non-secret authentication, model, and exact native session,
    // so recovery and history never have to guess. Recorded even on failure.
    progress.phaseExecution?.(
      phase.name,
      runnerExecutionRecord({
        runner: runnerId,
        // Only a runner that authenticates selects one; OpenCode uses its provider credentials.
        ...(runnerDescriptor(runnerId).authenticates ? { auth: { mode: context.auth?.mode ?? "subscription", ...(context.auth?.credentialRef ? { credentialRef: context.auth.credentialRef } : {}) } } : {}),
        checkout: targetDir,
        model: { modelId: prepared.model.modelID, ...(prepared.model.variant ? { variant: prepared.model.variant } : {}) },
        ...(activeSessionID ? { sessionId: activeSessionID } : {}),
        attempt: { runId: workspace.runID, phase: phase.name, attempt },
      }),
    )
  }

  // Advisor usage and events stay on the runtime's handle, not the attempt
  // result; the attempt log reads them from there before the phase releases it.
  const advisorHandle = activeSessionID ? advisors?.handleFor(activeSessionID) : undefined
  const advisorUsage = result.advisorUsage ?? (advisorHandle && advisorHandle.usage.length > 0 ? [...advisorHandle.usage] : undefined)
  const advisorEvents = result.advisorEvents ?? (advisorHandle && advisorHandle.events.length > 0 ? [...advisorHandle.events] : undefined)

  await writeAttemptLog(workspace, phase, attempt, {
    session: result.sessionID,
    agent: phase.agentName,
    model: result.model,
    attachments: prepared.attachments.map((file) => ({ filename: file.filename, mime: file.mime, url: file.url })),
    ...(prepared.attachmentsByPath ? { attachmentsByPath: true } : {}),
    finish: result.finish,
    cost: result.cost,
    tokens: result.tokens,
    error: result.error,
    // Logged as its own line, never folded into the executor's totals: the whole
    // economic claim of the pattern is that this stays a small fraction.
    ...(advisorUsage ? { advisor: totalAdvisorUsage(advisorUsage) } : {}),
    // Fallback copy for writeAttemptLog's journal merge; it is replaced by the
    // merged event list before the log is written.
    ...(advisorEvents && advisorEvents.length > 0 ? { advisorEvents } : {}),
    text: result.assistantText,
  })

  if (result.error) {
    if (isMessageAbortedError(result.error)) throw new SessionAbortedError(result.error)
    throw new LoggedAttemptError(formatSdkError(result.error), { cause: result.error })
  }
  return result.assistantText
}

/** Validates a candidate deliverable; on failure keeps it as forensics and throws. */
async function ensureValidDeliverable(
  workspace: Workspace,
  phase: AgentStep,
  contract: DeliverableContract,
  weights: Record<QualityDimension, number>,
  candidate: string,
) {
  const validation = validateDeliverableContract(contract, candidate, weights)
  if (!validation.valid) {
    await persistInvalidPhaseReport(workspace, phase, undefined, candidate)
    throw new DeliverableValidationError(validation.error)
  }
}

async function persistPhaseReport(
  workspace: Workspace,
  phase: AgentStep,
  candidate: string,
  contract = deliverableContractForPhase(phase),
  weights: Record<QualityDimension, number> = qualityDimensionWeights,
) {
  const reportAbs = join(workspace.dir, phase.reportPath)
  // The candidate was resolved before validation in strict tool → file → chat
  // order. When a tool report beats a later direct-file mutation, rewrite the
  // candidate here so persistence has the same precedence as validation.
  if (candidate.trim() !== "") {
    await ensureValidDeliverable(workspace, phase, contract, weights, candidate)
    const existing = await readFile(reportAbs, "utf8").catch(() => undefined)
    if (existing !== candidate) {
      await mkdir(dirname(reportAbs), { recursive: true })
      // Write to a temporary path then rename atomically, matching the
      // metadata.ts pattern (tmp+rename). A crash mid-write must never leave
      // a truncated report that phaseNeedsRun would treat as complete.
      const tmpPath = `${reportAbs}.tmp`
      await writeFile(tmpPath, candidate)
      await rename(tmpPath, reportAbs)
    }
  } else if (await exists(reportAbs)) {
    // An empty candidate is normally the human-continue signal. Preserve the
    // legacy behavior for a file an interactive user intentionally left behind.
    await ensureValidDeliverable(workspace, phase, contract, weights, await readFile(reportAbs, "utf8"))
  } else {
    // An empty candidate is the human-continue signal ("accept the tree as-is")
    // and no report exists either: there is nothing to validate or persist.
    log.warn(`[${phase.name}] agent didn't write the expected report at ${reportAbs}`)
  }

  return reportAbs
}

/** Resolves the exact artifact the contract validates: tool, direct file, then chat fallback. */
export async function resolveDeliverableCandidate(workspace: Workspace, phase: AgentStep, assistantText: string, toolCandidate?: string): Promise<string> {
  if (toolCandidate !== undefined) return toolCandidate
  const reportAbs = join(workspace.dir, phase.reportPath)
  try {
    return await readFile(reportAbs, "utf8")
  } catch {
    return assistantText
  }
}

/** Keeps a rejected candidate available as forensics without allowing it to become the phase report. */
async function persistInvalidPhaseReport(workspace: Workspace, phase: AgentStep, attempt: number | undefined, candidate: string) {
  const reportAbs = join(workspace.dir, phase.reportPath)
  await mkdir(dirname(reportAbs), { recursive: true })
  const suffix = attempt === undefined ? Date.now() : attempt
  await writeFile(`${reportAbs}.attempt-${suffix}.raw.md`, candidate)
}

async function commitPhase(phase: AgentStep, reportAbs: string, targetDir: string, workspace: Workspace) {
  // The message is composed inside the commit seam, after staging, so it can
  // describe the exact staged change set (design D5). Convoy owns the
  // `Convoy-Run` trailer; the phase only contributes the report and sidecar.
  const messageFactory = stepCommitMessageFactory({ workspace, step: phase.name, mode: "phase", phaseName: phase.agentName, reportPath: reportAbs })
  const committed = await addAllAndCommit(messageFactory, targetDir)
  if (!committed) {
    log.info(`[${phase.name}] no changes - no commit`)
  } else {
    log.info(`[${phase.name}] committed run-linked step changes (${workspace.runID})`)
  }
}

export async function finalizePhaseRepository(
  phase: AgentStep,
  reportAbs: string,
  targetDir: string,
  baseline: RepoSnapshot | undefined,
  originalError?: unknown,
  workspace?: Workspace,
): Promise<void> {
  if (!phase.readOnly) {
    if (!workspace) throw new Error(`[${phase.name}] cannot commit a writable phase without run provenance (workspace run ID)`)
    await commitPhase(phase, reportAbs, targetDir, workspace)
    return
  }
  if (!baseline) throw new Error(`[${phase.name}] read-only step has no clean repository baseline`)

  const difference = await describeRepoSnapshotDifference(baseline, targetDir)
  if (!difference) {
    log.info(`[${phase.name}] read-only step left the repository unchanged`)
    return
  }

  if (originalError instanceof ReadOnlyRepositoryMutationError) throw originalError
  const message = `[${phase.name}] repository changed during a read-only step; Convoy left these changes intact to avoid discarding concurrent user work\n${difference}${
      originalError === undefined ? "" : `\nOriginal failure: ${formatSdkError(originalError)}`
    }`
  if (isUserAbortError(originalError)) throw new UserAbortError(message)
  throw new ReadOnlyRepositoryMutationError(message)
}

async function restorePhaseBaseline(phase: AgentStep, baseline: RepoSnapshot | undefined, targetDir: string, originalError: unknown) {
  if (!baseline) return
  if (phase.readOnly) {
    await finalizePhaseRepository(phase, "", targetDir, baseline, originalError)
    return
  }
  try {
    await restoreRepoSnapshot(baseline, targetDir)
  } catch (restoreError) {
    throw new Error(
      `[${phase.name}] failed and couldn't restore git snapshot: ${formatSdkError(restoreError)}; original error: ${formatSdkError(
        originalError,
      )}`,
    )
  }
}

class ReadOnlyRepositoryMutationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReadOnlyRepositoryMutationError"
  }
}

/**
 * Checks the read-only boundary in a finally block so aborts, failed attempts,
 * and report persistence errors cannot bypass mutation detection. Detection is
 * deliberately non-destructive because Convoy cannot distinguish an extension
 * side effect from a user's concurrent edit in the same working tree.
 */
export async function withReadOnlyRepositoryBoundary<T>(
  phase: AgentStep,
  targetDir: string,
  baseline: RepoSnapshot | undefined,
  gitLock: GitLock,
  action: () => Promise<T>,
): Promise<T> {
  if (!phase.readOnly) return action()
  if (!baseline) throw new Error(`[${phase.name}] read-only step has no clean repository baseline`)

  let originalError: unknown
  try {
    return await action()
  } catch (error) {
    originalError = error
    throw error
  } finally {
    await gitLock(() => finalizePhaseRepository(phase, "", targetDir, baseline, originalError))
  }
}

export async function assertReadOnlyResumeBaseline(metadata: RunMetadataStore, phase: AgentStep, targetDir: string): Promise<void> {
  if (!phase.readOnly) return
  const baseline = metadata.repositoryBaseline(phase.name)
  if (!baseline) return
  const difference = await describeRepoSnapshotDifference(baseline, targetDir)
  if (!difference) return
  throw new Error(
    `[${phase.name}] repository changed since this read-only phase began; Convoy left the changes intact. Restore the recorded HEAD/branch or start a new run before resuming\n${difference}`,
  )
}

export async function assertPendingReadOnlyResumeBaselines(metadata: RunMetadataStore, pipeline: Pipeline, targetDir: string): Promise<void> {
  for (const step of pipeline.steps) {
    if (step.type !== "agent" || !step.readOnly) continue
    const status = metadata.phaseStatus(step.name)
    if (status !== "running" && status !== "failed") continue
    await assertReadOnlyResumeBaseline(metadata, step, targetDir)
  }
}



/** Names each attachment instead of inlining it, for a turn whose attachments overflow the model's context. */
export function withAttachmentsByPath(prompt: string, attachments: readonly FilePartInput[]): string {
  const lines = attachments.flatMap((file) => {
    try {
      return [`- ${fileURLToPath(file.url)}${file.filename ? ` (${file.filename})` : ""}`]
    } catch {
      return []
    }
  })
  if (lines.length === 0) return prompt
  return [
    prompt,
    "",
    "## Attachments by path",
    "The attachments did not fit in this model's context window, so they are listed by path instead of attached. Decide which ones you need and read them with the read tool; read large files, such as the diff, in sections rather than whole.",
    ...lines,
  ].join("\n")
}

function buildPhasePrompt(workspace: Workspace, phase: AgentStep, specs?: SpecBundle) {
  // Every runner submits through Convoy's write_report tool: OpenCode's plugin,
  // the CLI runners' MCP tool, named the way each runner lists it.
  const tool = runnerDescriptor(stepRunnerFor(phase.runner).id).reportTool
  const specTool = specs ? specTools[specs.tool] : undefined
  return [
    `# Pipeline phase: ${phase.name}`,
    "",
    phase.description,
    "",
    "## Run context",
    `- Run dir: ${workspace.dir}`,
    `- Report: call ${tool} with the complete Markdown report before finishing. Convoy fixes the path; do not use write or edit for the report. In read-only phases this is the only permitted report write.`,
    // Structured commit metadata (capability step-commit-messages): Convoy
    // renders the phase's step commit from it, so ask for an outcome-oriented
    // subject instead of leaving the subject to first-heading inference.
    ...(!phase.readOnly
      ? [
          `- Commit: Convoy commits this phase's repository changes as \`convoy(<step>): <subject>\` with a \`Convoy-Run\` trailer. In the same ${tool} call, include an optional \`commit\` object: { "subject": "...", "details": ["..."] }. The \`subject\` is an imperative English line describing the repository outcome — never the report, the phase, the agent, or the process. \`details\` holds at most three concrete statements about what changed. Convoy falls back to your report or the staged changes when you omit it.`,
        ]
      : []),
    "- Working directory: the directory where `convoy` was invoked (root of the target repo).",
    "",
    "## Access mode",
    phase.readOnly && phase.verify
      ? `This phase verifies without editing: you have bash, so run the tests, typecheck, lint, and other checks your instructions call for, and quote the exact command and its real result as evidence — never claim a check you did not run. Do not run commands that modify the repository either — no snapshot updates (\`-u\`, \`--update-snapshots\`), no formatters that rewrite files, no dependency installs; Convoy fails this phase if the repository changes. You have no write or edit tools. Use ${tool}, not write or edit, to persist the final report.`
      : phase.readOnly
        ? `This phase is read-only: do not modify the target repository or try to use write, edit, or bash. Call ${tool} to persist the complete final report; this tool is the only permitted write.`
        : `This phase may edit the target repository when the phase-specific instructions call for it. Call ${tool} to persist the final report rather than writing a report file directly.`,
    "",
    "## Attachments",
    `You will receive as file attachments: project context files when present, the original PRD, ${specTool ? `the ${specTool.label} spec bundle when an active change is attached, ` : ""}the project's historical PRD for this branch when present, previous phase reports, the cumulative diff against the base branch (or, when it is too large to attach, an overview that inlines what fits and points to the full diff; read the omitted files from it), and any \`--file\` passed by the user. Read them before acting.${specTool ? ` When ${specTool.changeArticle} ${specTool.changeNoun} is attached, those spec files are the contract — implement and grade against them, not a reconstructed brief.` : ""}`,
    "",
    "## Project context",
    "Convoy automatically attaches these target-repo files when they exist: `.convoy/rules.md`, `AGENTS.md`, and `CLAUDE.md`.",
    "Read them before making changes. `.convoy/rules.md` is the project-specific Convoy contract unless it conflicts with Convoy runtime safety guard rails.",
    "",
    "## Closing",
    "Before finishing, make sure to:",
    phase.readOnly && phase.verify
      ? "1. Have not modified the target repository — only read it and run checks against it."
      : phase.readOnly
        ? "1. Have not modified the target repository."
        : "1. Have applied necessary changes to the repo code.",
    `2. Have called ${tool} with the complete report (markdown, max ~80 lines). If the tool is unavailable, make the report your entire final message and Convoy will save it.`,
    "3. Leave the tree in a compilable state.",
    "",
    // The goal brief is untrusted, agent-authored text. It is appended AFTER the
    // non-overridable guard rails (Access mode, Attachments, Closing) so it can
    // never forge or fence off those sections for the write-enabled goal-fixer.
    ...(phase.goalBrief ? ["## Phase brief (untrusted evidence — validate before acting)", phase.goalBrief, ""] : []),
    "Follow your system prompt instructions for everything else.",
  ].join("\n")
}

/** Reads and parses the run's consensus quality score from its workspace, when the pipeline scored itself. */
async function readRunQualityScore(
  pipeline: Pipeline,
  workspaceDir: string,
  weights: Record<QualityDimension, number> = qualityDimensionWeights,
): Promise<{ score: QualityScore } | undefined> {
  const step = consensusStep(pipeline)
  if (!step) return undefined
  const reportAbs = join(workspaceDir, step.reportPath)
  let text: string
  try {
    text = await readFile(reportAbs, "utf8")
  } catch {
    // A scored pipeline that produced no consensus report is a real failure
    // mode (the consensus step crashed or was skipped); log it so a silent
    // "no-score" stop in the goal loop has a cause instead of a mystery.
    log.error(`quality score: consensus report not found at ${step.reportPath}; the run produced no machine-readable score`)
    return undefined
  }
  const score = parseQualityScoreReport(text, weights)
  if (!score) {
    // The report exists but failed the strict contract (missing fence,
    // invalid JSON, or out-of-range dimensions). An excerpt helps diagnose a
    // misbehaving consensus agent.
    const excerpt = text.slice(0, 120).replace(/\n/g, " ")
    log.error(`quality score: consensus report at ${step.reportPath} could not be parsed (malformed or incomplete); the run produced no machine-readable score. Excerpt: ${excerpt}…`)
    return undefined
  }
  return { score }
}

export function parseModel(value: string) {
  const [providerID, ...rest] = value.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID || !isSafeModelSegment(providerID) || rest.some((segment) => !isSafeModelSegment(segment))) {
    throw new Error(`invalid model: ${value}`)
  }
  return { providerID, modelID }
}

function isSafeModelSegment(value: string) {
  return value.length > 0 && !/[\s/#\u0000-\u001f\u007f-\u009f]/u.test(value)
}

function selectedModel(phase: AgentStep, override: string): ModelSelection {
  const { label: _label, ...model } = stepRunnerModel(phase.runner, phase.model, phase.variant, override)
  return model
}

function formatModel(model: ModelSelection) {
  const base = `${model.providerID}/${model.modelID}`
  return model.variant ? `${base}#${model.variant}` : base
}

// A fanned-out step (name "clean-code__anthropic-claude-opus-4-7") matches
// --only/--skip by its full name or by its shared stepName ("clean-code"),
// so a filter can target one variant or every variant of a fanned-out step.
export function shouldSkip(step: Step, options: Pick<RunOptions, "onlySteps" | "skipSteps">) {
  const names = step.type === "agent" ? [step.name, step.stepName] : [step.name]
  if (options.onlySteps.length > 0) return !names.some((name) => options.onlySteps.includes(name))
  return names.some((name) => options.skipSteps.includes(name))
}

// A resumed run can outlive its config: the frozen pipeline may reference a
// project agent that has since been renamed or removed. Fail before any
// session starts instead of mid-pipeline.
function ensureAgentsAvailable(pipeline: Pipeline, agents: readonly AgentSpec[]) {
  const available = new Set(agents.map((agent) => agent.name))
  for (const step of pipeline.steps) {
    if (step.type !== "agent" || available.has(step.agentName)) continue
    throw new Error(`pipeline "${pipeline.name}" needs agent "${step.agentName}", which is not defined (removed from .convoy/config.yaml?)`)
  }
}

export function progressPhases(pipeline: Pipeline, hooks?: HookSet): ProgressPhase[] {
  const steps = pipeline.steps.map((step) =>
    step.type === "agent"
      ? {
          name: step.name,
          description: step.description,
          kind: "step" as const,
          groupId: step.groupId,
          stepName: step.stepName,
          plannedModel: stepRunnerFor(step.runner).modelLabel(step.model),
          ...(step.variant ? { plannedVariant: step.variant } : {}),
          ...(step.runner ? { runner: step.runner } : {}),
          ...(step.readOnly ? { readOnly: true } : {}),
          reportPath: step.reportPath,
          ...(step.resolvedAdvisor ? { plannedAdvisor: step.resolvedAdvisor.target } : step.advisor ? { plannedAdvisor: step.advisor } : {}),
          ...(step.advisorMaxCalls !== undefined ? { advisorMaxCalls: step.advisorMaxCalls } : {}),
        }
      : { name: step.name, description: step.description, kind: "step" as const },
  )
  // Hooks are dashboard rows too, so their execution is watchable like any
  // step: pre-hooks ahead of the pipeline, post-hooks after the `Compact run`
  // lifecycle row (which executes after phases and before success hooks).
  const hookPhase = (stage: HookStage, specs: readonly HookSpec[]): ProgressPhase[] =>
    hookPhaseNames(stage, specs).map((name, index) => ({ name, description: specs[index]!.command, kind: "hook" }))
  return orderPhaseRows({ pre: hooks ? hookPhase("pre", hooks.pre) : [], steps, post: hooks ? hookPhase("post", hooks.post) : [] })
}

/**
 * The terminal `Compact run` lifecycle row (capability run-finalization,
 * design D1/D8): it always executes as the epilogue, so it is always a
 * dashboard row — not a configurable step and never a filter target. It must
 * appear in every phase list handed to `resetPipeline` (live) and
 * `reconstructedPhases` (attach/history), or dashboards silently drop the
 * finalization row's started/completed/failed events as unknown phases.
 */
export function compactRunRow(): ProgressPhase {
  return {
    name: compactRunRowName,
    description: "compacts this run's commits into one operator-authored conventional commit",
    kind: "lifecycle",
  }
}

/**
 * The one canonical display order every dashboard phase list follows: pre-hook
 * rows, pipeline step rows, goal invocation groups, the `Compact run`
 * lifecycle row, then post-hook rows. The terminal row is the last post-hook
 * row (or the lifecycle row when the run has no post-hooks), matching the
 * execution order the runner now uses.
 */
export function orderPhaseRows(parts: {
  pre?: readonly ProgressPhase[]
  steps: readonly ProgressPhase[]
  goal?: readonly ProgressPhase[]
  post?: readonly ProgressPhase[]
}): ProgressPhase[] {
  return [...(parts.pre ?? []), ...parts.steps, ...(parts.goal ?? []), compactRunRow(), ...(parts.post ?? [])]
}

/**
 * Inserts goal invocation rows ahead of the `Compact run` row, preserving the
 * canonical order around them (steps above, post-hooks below). A list missing
 * the lifecycle row gains it before its post-hook rows (or at the end).
 */
export function withGoalPhases(rows: readonly ProgressPhase[], goalRows: readonly ProgressPhase[]): ProgressPhase[] {
  const normalized = ensureCompactRow(rows)
  if (goalRows.length === 0) return normalized
  const index = normalized.findIndex((row) => row.name === compactRunRowName)
  if (index === -1) return [...normalized, ...goalRows]
  return [...normalized.slice(0, index), ...goalRows, ...normalized.slice(index)]
}

/** Guarantees the lifecycle row exists, placing it before any post-hook rows. */
function ensureCompactRow(rows: readonly ProgressPhase[]): ProgressPhase[] {
  if (rows.some((row) => row.name === compactRunRowName)) return [...rows]
  const firstPost = rows.findIndex((row) => row.kind === "hook" && row.name.startsWith("post-hook"))
  if (firstPost === -1) return [...rows, compactRunRow()]
  return [...rows.slice(0, firstPost), compactRunRow(), ...rows.slice(firstPost)]
}

/** The goal-cycle section embedded in SUMMARY.md: policy, trajectory, verdict, and restore status. */
function renderGoalSummarySection(outcome: GoalCycleOutcome, plan: ResolvedGoalPlan): string {
  const final = outcome.bestScore ?? outcome.scores[outcome.scores.length - 1]
  const trajectory = outcome.scores.length > 0 ? `trajectory: ${outcome.scores.join(" → ")}` : "trajectory: (no completed measurement)"
  return [
    "## Goal cycle",
    "",
    `target ${plan.target}/100 · up to ${1 + plan.maxIterations} measurements (${plan.maxIterations} improve rounds) · plateau ${plan.plateau} · brief to ${plan.briefRecipient}`,
    trajectory,
    `outcome: ${outcome.reason}${outcome.reached ? " (goal met)" : ""}${final !== undefined ? ` · best ${final}/100` : ""} · restored: ${outcome.restored ? "yes" : "no"}`,
  ].join("\n")
}

export function modelOverrideNotice(pipeline: Pipeline, override: string): string | undefined {
  if (!override) return undefined
  const unaffected = pipeline.steps
    .filter((step): step is AgentStep => step.type === "agent" && !stepRunnerFor(step.runner).capabilities.globalModelOverride)
    .map((step) => step.name)
  if (unaffected.length === 0) return undefined
  return `--model applies to OpenCode steps only (scope it with <runner>/<model> for a CLI runner); these steps keep their configured model: ${unaffected.join(", ")}`
}

class LoggedAttemptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "LoggedAttemptError"
  }
}

/** Typed cancellation returned when Esc aborts an OpenCode message. */
export class SessionAbortedError extends LoggedAttemptError {
  constructor(error: { name: "MessageAbortedError"; data?: { message?: string } }) {
    super(error.data?.message || "OpenCode session message aborted", { cause: error })
    this.name = "SessionAbortedError"
  }
}

export function isMessageAbortedError(error: unknown): error is { name: "MessageAbortedError"; data?: { message?: string } } {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "MessageAbortedError")
}


async function writeAttemptLog(workspace: Workspace, phase: AgentStep, attempt: number, payload: unknown) {
  const body: Record<string, unknown> = payload && typeof payload === "object" ? { ...(payload as Record<string, unknown>) } : { value: payload }
  const journaled = (await readAdvisorEvents(workspace.dir)).filter((event) => event.phase === phase.name && event.attempt === attempt)
  // The journal is authoritative, but its appends are allowed to fail without
  // blocking the phase. Merge the attempt's in-memory events (carried on the
  // attempt result for exactly this) so a failed append cannot erase advisor
  // activity from the attempt log. The aggregate's field names stay a superset
  // of the legacy `advisor` shape, so historical readers stay compatible.
  const inMemory = Array.isArray(body.advisorEvents) ? (body.advisorEvents as AdvisorEvent[]) : []
  const seen = new Set(journaled.map((event) => event.id))
  const events = [...journaled, ...inMemory.filter((event) => !seen.has(event.id) && event.phase === phase.name && event.attempt === attempt)]
  if (events.length > 0) {
    const aggregate = aggregateAdvisorEvents(events)
    body.advisor = {
      calls: aggregate.attempted,
      succeeded: aggregate.succeeded,
      failed: aggregate.failed,
      exhausted: aggregate.exhausted,
      byTrigger: aggregate.byTrigger,
      callIds: aggregate.callIds,
      cost: aggregate.cost,
      inputTokens: aggregate.tokens.input + aggregate.tokens.cacheRead + aggregate.tokens.cacheWrite,
      outputTokens: aggregate.tokens.output + aggregate.tokens.reasoning,
      tokens: aggregate.tokens,
      feedback: aggregate.feedback,
      lastAt: aggregate.lastAt,
    }
    body.advisorEvents = events
    body.costSplit = { executor: typeof body.cost === "number" ? body.cost : 0, advisor: aggregate.cost }
  }
  await writeFile(join(workspace.dir, "logs", `${phase.name}.${attempt}.json`), JSON.stringify(body, null, 2), { mode: 0o600 })
}

function advisorEventLogLine(event: AdvisorEvent): string {
  if (event.type === "advisor.requested") return `advisor requested · ${event.trigger} · ${event.budget.used}/${event.budget.max}`
  if (event.type === "advisor.completed") return `advisor completed · ${event.trigger} · ${event.latencyMs}ms${event.usage ? ` · $${event.usage.cost.toFixed(4)}` : ""}`
  if (event.type === "advisor.failed") return `advisor failed · ${event.trigger} · ${event.error.code}`
  if (event.type === "advisor.budget_exhausted") return `advisor budget exhausted · ${event.trigger}`
  if (event.type === "advisor.delivered") return `advisor delivered · ${event.trigger} · ${event.delivery}`
  return `advisor feedback · ${event.trigger} · ${event.outcome}`
}

async function exists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
