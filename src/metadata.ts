import { readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { log } from "./log"
import { isSafeStepName } from "./pipeline"

import type { RepoSnapshot } from "./git"
import type {
  ProgressPhaseSnapshot,
  ProgressStepUsage,
  ProgressTokens,
  ProgressUI,
  ProgressUsage,
  RunControlState,
} from "./progress"
import type { QualityScore } from "./quality-score"
import type { FeaturePlanLink, Pipeline } from "./types"
import type { ModelGateway } from "./model-routing"
import { PhaseUsage } from "./usage"
import { aggregateAdvisorEvents, type AdvisorEvent, type AdvisorPhaseAggregate } from "./advisor-events"
import { readCommitLedger, readFinalizationRecord, readRunBoundary, type CommitLedgerEntry, type FinalizationRecord, type RunBoundary } from "./finalization/types"
import { resolveRunTitleFor } from "./run-title"
import type { Workspace } from "./workspace"

export type PhaseMetadataStatus = "pending" | "running" | "completed" | "skipped" | "failed"

export type PhaseMetadata = {
  status: PhaseMetadataStatus
  sessionID?: string
  startedAt?: number
  endedAt?: number
  durationMs?: number
  cost?: number
  tokens?: ProgressTokens
  model?: string
  logicalModel?: string
  targetModel?: string
  repositoryBaseline?: RepoSnapshot
  advisor?: AdvisorPhaseAggregate
  advisorEvents?: AdvisorEvent[]
}

/** The stage a goal cycle's durable record says the run is in. */
export type GoalRunStage = "measure" | "improve" | "complete"

/** The final outcome of a goal cycle, when it settled. */
export type GoalRunOutcome = "goal" | "plateau" | "max-iterations" | "no-score" | "failed"

/**
 * The durable goal-cycle record (schema v4). Written by the embedded scheduler
 * after every stage boundary so a crashed coordinator can resume from the exact
 * pending improve/measure group, and so live attach, run history, and stopped-run
 * reconstruction can present the same target, trajectory, stage, outcome, and
 * restore result from durable state instead of ephemeral process data. `scores`
 * holds every completed authoritative measurement as a complete `QualityScore`
 * object; the numeric trajectory and best score are derived from it.
 */
export type GoalRunState = {
  /** The frozen goal policy every stage of the cycle runs under. */
  target: number
  maxIterations: number
  plateau: number
  /** The measurement round the cycle is in (0 for the opening measurement). */
  iteration: number
  /** The activity the cycle is in, or "complete" once it settled. */
  stage: GoalRunStage
  /** Every completed authoritative measurement, oldest first. */
  scores: QualityScore[]
  /** The highest authoritative score measured across the cycle. */
  bestScore?: number
  outcome?: GoalRunOutcome
  /** Whether the branch was restored to the best measured state at settlement. */
  restored?: boolean
  /** Why a best-state restore did not happen (concurrent commit, dirty tree, missing snapshot). */
  restoreRefusedReason?: string
}

export type RunMetadata = {
  schemaVersion: 3 | 4 | 5
  runID: string
  targetDir: string
  createdAt: number
  updatedAt: number
  /** The resolved pipeline this run executes; resume replays it even if the project config changed since. */
  pipeline?: Pipeline
  modelRouting?: { gateway: ModelGateway }
  /** The live opencode server for this run while it executes; cleared on shutdown, so a lingering entry means the run process died mid-flight. Lets `convoy runs` attach to a running run. */
  server?: { url: string; pid: number; startedAt: number; controlUrl?: string }
  control: { state: RunControlState; requestedAt?: number; pausedAt?: number }
  phases: Record<string, PhaseMetadata>
  /** The durable goal-cycle record, present when the pipeline declares a terminal goal step (schema v4). */
  goal?: GoalRunState
  /** The run boundary persisted before any run-owned mutation (schema v5; capability run-finalization). */
  boundary?: RunBoundary
  /**
   * The reviewed feature link (capability feature-lifecycle, task 5.1):
   * persisted at metadata open — before any execution — so board, attach, and
   * history join by stable identity and never reinterpret a stored path.
   */
  feature?: FeaturePlanLink
  /**
   * The run's human title (capability run-titles), resolved once at metadata
   * open — change proposal title → humanized branch slug → prompt first line —
   * and never recomputed afterwards: a goal-loop prompt rewrite or a workspace
   * cleanup must not rename a run. Legacy records without the field keep the
   * prompt-first-line fallback in their discovery readers.
   */
  title?: string
  /** The ordered ledger of Convoy-created commits, recorded as each commit lands (schema v5). */
  commitLedger?: CommitLedgerEntry[]
  /** The automatic compaction outcome, independent of the pipeline result (schema v5). */
  finalization?: FinalizationRecord
}

export type RunMetadataStore = {
  /** The effective pipeline for this run: the frozen one on resume, the freshly resolved one otherwise. */
  pipeline: Pipeline
  snapshot(name: string): ProgressPhaseSnapshot | undefined
  phaseStatus(name: string): PhaseMetadataStatus | undefined
  /** The durable goal-cycle record, when the run has reached a goal checkpoint. */
  goalState(): GoalRunState | undefined
  /** Persists a goal checkpoint after a stage boundary, score promotion, or settlement. */
  checkpointGoal(state: GoalRunState): Promise<void>
  /** The run boundary persisted before any run-owned mutation; undefined on legacy runs. */
  boundary(): RunBoundary | undefined
  /** Persists the run boundary once, before pre-hooks and writable execution; a resume never replaces it. */
  recordBoundary(boundary: RunBoundary): Promise<void>
  /** The ordered ledger of Convoy-created commits, oldest first. */
  ledger(): CommitLedgerEntry[]
  /** Appends one ledgered commit endpoint to the ordered commit ledger. */
  appendLedgerEntry(entry: CommitLedgerEntry): Promise<void>
  /** The automatic compaction outcome, when finalization has reported one. */
  finalization(): FinalizationRecord | undefined
  /** Persists the finalization outcome (pending/running/completed/skipped/blocked/failed). */
  setFinalization(record: FinalizationRecord): Promise<void>
  /** Records the run's live opencode server URL so `convoy runs` can attach; cleared by serverStopped. */
  serverStarted(url: string): void
  serverStopped(): Promise<void>
  phaseStarted(name: string): Promise<void>
  phaseSession(name: string, sessionID: string): void
  phaseStepUsage(name: string, usage: ProgressStepUsage): void
  phaseUsageTotal(name: string, usage: ProgressUsage): void
  phaseAdvisorEvent(name: string, event: AdvisorEvent): void
  repositoryBaseline(name: string): RepoSnapshot | undefined
  phaseRepositoryBaseline(name: string, baseline: RepoSnapshot): Promise<void>
  phaseEnded(name: string, status: "completed" | "skipped" | "failed"): Promise<void>
  controlState(): RunControlState
  setControlState(state: RunControlState): Promise<void>
  flush(): Promise<void>
}

export type OpenRunMetadataOptions = {
  gateway?: ModelGateway
  /** A CLI gateway override reroutes only phases that have not finished. */
  gatewayOverride?: boolean
  /** A CLI model override reroutes only phases that have not finished. */
  modelOverride?: boolean
  /** Execute the reviewed resume subset without replacing the stored full pipeline. */
  useExecutionPipeline?: boolean
  /** The reviewed feature link, persisted at open — before any execution (task 4.2/5.1). */
  feature?: FeaturePlanLink
  /**
   * The run's branch as the caller knows it (the confirmed worktree branch, or
   * whatever the execution tree has checked out). Title resolution prefers a
   * resumed record's durable boundary branch, then this value, then the
   * reviewed feature link's branch.
   */
  branch?: string
}

const saveDebounceMs = 2_000

export async function openRunMetadata(
  workspace: Workspace,
  targetDir: string,
  pipeline: Pipeline,
  options: OpenRunMetadataOptions = {},
): Promise<RunMetadataStore> {
  const gateway = options.gateway ?? "configured"
  const path = join(workspace.dir, "metadata.json")
  const data = (await loadMetadata(path, workspace.runID)) ?? newMetadata(workspace.runID, targetDir)
  // The reviewed feature link persists from the first open onward, including
  // for failed/aborted runs (capability feature-lifecycle: the link is
  // written before execution, not only after success).
  if (options.feature && !data.feature) data.feature = options.feature
  // Capability run-titles (design D2/D3): resolve the human title once at
  // open — change proposal title → humanized branch slug → prompt first line —
  // and persist it with the record. An existing record keeps its stored title:
  // a goal-loop prompt rewrite must not rename a live run, so re-opens never
  // replace one. A legacy record without a title gains one here (a fill, not
  // an overwrite), preferring the durable run-start boundary branch over the
  // caller's current view so the persisted title reflects run start.
  if (!data.title) {
    const prompt = await readPromptDocument(workspace.dir)
    const branch = data.boundary?.branch ?? options.branch ?? options.feature?.branch
    data.title = (await resolveRunTitleFor({ targetDir, branch, prompt })) || undefined
  }
  // Opening metadata means a new coordinator owns the run. It resumes from the
  // next pending batch; pausing/running crashes still use normal phase recovery.
  if (data.control.state !== "running") data.control = { state: "running" }
  // Step names are user-configurable safe identifiers and may still equal
  // Object.prototype keys such as "constructor" or "__proto__".
  data.phases = Object.assign(Object.create(null) as Record<string, PhaseMetadata>, data.phases)
  // First open freezes the pipeline; pre-pipeline (v1) runs adopt the current
  // one, whose default step names match what those runs executed.
  let frozenPipeline = (data.pipeline ??= pipeline)
  if (options.gatewayOverride || options.modelOverride) {
    const routedByName = new Map(pipeline.steps.map((step) => [step.name, step]))
    frozenPipeline = data.pipeline = {
      ...frozenPipeline,
      steps: frozenPipeline.steps.map((step) => {
        const status = data.phases[step.name]?.status
        return status === "completed" || status === "skipped" ? step : (routedByName.get(step.name) ?? step)
      }),
    }
    if (options.gatewayOverride) data.modelRouting = { gateway }
  } else {
    data.modelRouting ??= { gateway }
  }
  // A filtered resume is deliberately transient: it executes exactly the
  // reviewed subset, while metadata retains the complete frozen pipeline for
  // future resumes.
  const effectivePipeline = options.useExecutionPipeline ? pipeline : frozenPipeline
  assertSafePipelineArtifacts(frozenPipeline)
  assertSafePipelineArtifacts(effectivePipeline)
  // One accumulator per phase. Kept out of the persisted shape — PhaseUsage holds
  // cumulative per-session totals, so re-counting them on resume would double up.
  const usage = new Map<string, PhaseUsage>()
  const phaseUsage = (name: string) => {
    let entry = usage.get(name)
    if (!entry) usage.set(name, (entry = new PhaseUsage()))
    return entry
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  // Single chain so a slow write can never interleave with the next one.
  let writing: Promise<void> = Promise.resolve()

  const persist = (options: { throwOnError?: boolean } = {}) => {
    if (timer) clearTimeout(timer)
    timer = undefined
    data.updatedAt = Date.now()
    const body = JSON.stringify(data, null, 2)
    const attempt = writing.then(async () => {
      // tmp + rename: a kill mid-write must never corrupt the resume data.
      await writeFile(`${path}.tmp`, body)
      await rename(`${path}.tmp`, path)
    })
    writing = attempt.catch((error) => {
      log.warn(`couldn't write run metadata: ${error instanceof Error ? error.message : String(error)}`)
    })
    return options.throwOnError ? attempt : writing
  }

  const scheduleSave = () => {
    if (timer) return
    timer = setTimeout(() => void persist(), saveDebounceMs)
    timer.unref?.()
  }

  const phase = (name: string) => (data.phases[name] ??= { status: "pending" })
  for (const step of effectivePipeline.steps) {
    if (step.type !== "agent" || !step.resolvedModel) continue
    const entry = phase(step.name)
    if ((options.gatewayOverride || options.modelOverride) && entry.status !== "completed" && entry.status !== "skipped") {
      entry.logicalModel = step.resolvedModel.logical
      entry.targetModel = step.resolvedModel.target
    } else {
      entry.logicalModel ??= step.resolvedModel.logical
      entry.targetModel ??= step.resolvedModel.target
    }
  }

  const recalculate = (name: string) => {
    const accumulator = usage.get(name)
    if (!accumulator || accumulator.isEmpty) return
    const totals = accumulator.totals()
    const entry = phase(name)
    entry.cost = totals.cost
    entry.tokens = totals.tokens
    if (totals.model) entry.model = totals.model
  }

  void persist()

  return {
    pipeline: effectivePipeline,
    snapshot(name) {
      const entry = data.phases[name]
      if (!entry) return undefined
      return {
        // Callers only restore phases whose report exists, so a stale
        // "running" left by a crash still means the phase finished its work.
        status: entry.status === "skipped" || entry.status === "failed" ? entry.status : "completed",
        sessionID: entry.sessionID,
        durationMs: entry.durationMs,
        cost: entry.cost,
        tokens: entry.tokens,
        model: entry.model,
        advisor: entry.advisor,
        advisorEvents: entry.advisorEvents,
      }
    },
    phaseStatus(name) {
      return data.phases[name]?.status
    },
    goalState() {
      return data.goal
    },
    async checkpointGoal(state) {
      data.goal = state
      await persist({ throwOnError: true })
    },
    boundary() {
      return readRunBoundary(data.boundary)
    },
    async recordBoundary(boundary) {
      // A same-run resume must find the original boundary it was started
      // with: once recorded, the boundary is immutable for this run.
      if (data.boundary) return
      data.boundary = boundary
      await persist({ throwOnError: true })
    },
    ledger() {
      return readCommitLedger(data.commitLedger)
    },
    async appendLedgerEntry(entry) {
      ;(data.commitLedger ??= []).push(entry)
      await persist({ throwOnError: true })
    },
    finalization() {
      return readFinalizationRecord(data.finalization)
    },
    async setFinalization(record) {
      data.finalization = record
      await persist({ throwOnError: true })
    },
    serverStarted(url) {
      // The coordinator sets CONVOY_CONTROL_URL before run() boots; the token
      // never lives in metadata — only the no-secret control URL does, so
      // liveness/debug can see the control plane without exposing auth.
      const controlUrl = process.env.CONVOY_CONTROL_URL
      data.server = { url, pid: process.pid, startedAt: Date.now(), ...(controlUrl ? { controlUrl } : {}) }
      void persist()
    },
    async serverStopped() {
      data.server = undefined
      await persist({ throwOnError: true })
    },
    async phaseStarted(name) {
      const entry = phase(name)
      entry.status = "running"
      entry.startedAt ??= Date.now()
      await persist({ throwOnError: true })
    },
    phaseSession(name, sessionID) {
      phase(name).sessionID = sessionID
      void persist()
    },
    phaseStepUsage(name, usage_) {
      if (!phaseUsage(name).addStep(usage_)) return
      recalculate(name)
      scheduleSave()
    },
    phaseUsageTotal(name, usage_) {
      phaseUsage(name).setTotal(usage_)
      recalculate(name)
      scheduleSave()
    },
    phaseAdvisorEvent(name, event) {
      const entry = phase(name)
      const events = (entry.advisorEvents ??= [])
      if (events.some((existing) => existing.id === event.id)) return
      events.push(event)
      entry.advisor = aggregateAdvisorEvents(events)
      // Advisor events are sparse and operationally important; persist now so a crash does not erase them.
      void persist()
    },
    repositoryBaseline(name) {
      return data.phases[name]?.repositoryBaseline
    },
    async phaseRepositoryBaseline(name, baseline) {
      phase(name).repositoryBaseline = baseline
      await persist({ throwOnError: true })
    },
    async phaseEnded(name, status) {
      const entry = phase(name)
      entry.status = status
      entry.endedAt = Date.now()
      if (entry.startedAt !== undefined) entry.durationMs = entry.endedAt - entry.startedAt
      await persist({ throwOnError: true })
    },
    controlState() {
      return data.control.state
    },
    async setControlState(state) {
      data.control = {
        state,
        ...(state === "pausing" ? { requestedAt: Date.now() } : {}),
        ...(state === "paused" ? { requestedAt: data.control.requestedAt ?? Date.now(), pausedAt: Date.now() } : {}),
      }
      await persist({ throwOnError: true })
    },
    async flush() {
      await persist()
    },
  }
}

function assertSafePipelineArtifacts(pipeline: Pipeline): void {
  if (!pipeline || !Array.isArray(pipeline.steps)) throw new Error("unsafe frozen pipeline: steps must be a list")
  for (const step of pipeline.steps) {
    if (!step || typeof step.name !== "string" || !isSafeStepName(step.name)) {
      throw new Error("unsafe frozen pipeline: every step must have a filesystem-safe name")
    }
    if (step.type === "human") continue
    if (step.type !== "agent") throw new Error("unsafe frozen pipeline: unknown step type")
    if (step.reportPath !== `reports/${step.name}.md`) {
      throw new Error(`unsafe frozen pipeline: report path for step "${step.name}" is outside its canonical location`)
    }
    if (!Array.isArray(step.inputFiles) || step.inputFiles.some((path) => !isSafePipelineInput(path))) {
      throw new Error(`unsafe frozen pipeline: input path for step "${step.name}" is outside its canonical location`)
    }
  }
}

function isSafePipelineInput(path: unknown): path is string {
  if (path === "prd.md") return true
  if (typeof path !== "string" || !path.startsWith("reports/") || !path.endsWith(".md")) return false
  return isSafeStepName(path.slice("reports/".length, -".md".length))
}

/** Forwards every ProgressUI call unchanged while recording phase lifecycle and usage into the store. */
export function recordProgress(progress: ProgressUI, store: RunMetadataStore): ProgressUI {
  const recorder: ProgressUI = {
    start: (runID, targetDir, runDir) => progress.start(runID, targetDir, runDir),
    serverReady: (url) => {
      store.serverStarted(url)
      progress.serverReady(url)
    },
    async phaseStarted(name, detail) {
      await store.phaseStarted(name).catch((error) => log.warn(`couldn't persist phase-started metadata: ${String(error)}`))
      progress.phaseStarted(name, detail)
    },
    phaseRunning: (name, detail) => progress.phaseRunning(name, detail),
    phaseAttempt: (name, info) => progress.phaseAttempt(name, info),
    phaseSession(name, sessionID) {
      store.phaseSession(name, sessionID)
      progress.phaseSession(name, sessionID)
    },
    phaseActivity: (name, detail, kind, pulse) => progress.phaseActivity(name, detail, kind, pulse),
    // The live transcript is UI-only (never persisted): just forward it.
    phaseMessage: (name, message) => progress.phaseMessage(name, message),
    phaseStepUsage(name, usage) {
      store.phaseStepUsage(name, usage)
      progress.phaseStepUsage(name, usage)
    },
    phaseUsageTotal(name, usage) {
      store.phaseUsageTotal(name, usage)
      progress.phaseUsageTotal(name, usage)
    },
    phaseAdvisorEvent(name, event) {
      store.phaseAdvisorEvent(name, event)
      progress.phaseAdvisorEvent(name, event)
    },
    phaseTodos: (name, todos) => progress.phaseTodos(name, todos),
    phaseDiff: (name, summary) => progress.phaseDiff(name, summary),
    async phaseCompleted(name, detail) {
      await store.phaseEnded(name, "completed").catch((error) => log.warn(`couldn't persist phase-completed metadata: ${String(error)}`))
      progress.phaseCompleted(name, detail)
    },
    async phaseSkipped(name) {
      await store.phaseEnded(name, "skipped").catch((error) => log.warn(`couldn't persist phase-skipped metadata: ${String(error)}`))
      progress.phaseSkipped(name)
    },
    async phaseFailed(name, detail) {
      await store.phaseEnded(name, "failed").catch((error) => log.warn(`couldn't persist phase-failed metadata: ${String(error)}`))
      progress.phaseFailed(name, detail)
    },
    phaseRestored: (name, snapshot) => progress.phaseRestored(name, snapshot),
    message: (message) => progress.message(message),
    suspend: () => progress.suspend(),
    resume: () => progress.resume(),
    stop: () => progress.stop(),
  }
  // The gate decides between in-place prompts and the readline fallback by
  // probing for askPermission, so its presence must mirror the wrapped UI.
  if (progress.askPermission) recorder.askPermission = progress.askPermission.bind(progress)
  if (progress.askHumanReview) recorder.askHumanReview = progress.askHumanReview.bind(progress)
  if (progress.isInteractiveTakeover) recorder.isInteractiveTakeover = progress.isInteractiveTakeover.bind(progress)
  if (progress.runControlState) recorder.runControlState = progress.runControlState.bind(progress)
  // Keep-awake is UI-only, but like run-control state its publisher binds to
  // the wrapped progress object owned by the runner.
  if (progress.keepAwakeState) recorder.keepAwakeState = progress.keepAwakeState.bind(progress)
  // Host-local too: the run status drives the terminal title, never metadata.
  if (progress.runStatus) recorder.runStatus = progress.runStatus.bind(progress)
  // Same probing contract: the runner only holds the finish screen when the UI offers one.
  if (progress.runFinished) recorder.runFinished = progress.runFinished.bind(progress)
  if (progress.keepRunDirRequested) recorder.keepRunDirRequested = progress.keepRunDirRequested.bind(progress)
  // Goal-loop hosting methods: purely forwarded, never recorded.
  if (progress.setGoalLoop) recorder.setGoalLoop = progress.setGoalLoop.bind(progress)
  if (progress.resetPipeline) recorder.resetPipeline = progress.resetPipeline.bind(progress)
  if (progress.setAbortHandler) recorder.setAbortHandler = progress.setAbortHandler.bind(progress)
  if (progress.setHostControls) recorder.setHostControls = progress.setHostControls.bind(progress)
  return recorder
}

async function loadMetadata(path: string, runID: string): Promise<RunMetadata | undefined> {
  const parsed = await readRunMetadata(path)
  return parsed ? { ...parsed, runID } : undefined
}

/** Reads a run's metadata.json without taking ownership of it (also used by the run-history browser). */
export async function readRunMetadata(path: string): Promise<RunMetadata | undefined> {
  let body: string
  try {
    body = await readFile(path, "utf8")
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(body) as Partial<RunMetadata> & { schemaVersion?: number }
    // v1 predates the frozen pipeline; v1/v2/v3 predate cooperative run control
    // and durable goal state. Schema-v3 records (including historical goal-fix
    // child runs) stay readable as plain runs; the goal record only exists
    // from v4 onward, and boundary/ledger/finalization from v5.
    if (![1, 2, 3, 4, 5].includes(parsed.schemaVersion ?? 0) || typeof parsed.phases !== "object" || !parsed.phases) {
      log.warn(`ignoring run metadata with unknown shape at ${path}`)
      return undefined
    }
    const state = parsed.control?.state
    const control = state === "running" || state === "pausing" || state === "paused" ? parsed.control! : { state: "running" as const }
    // Normalize: old records without newer-era fields keep their own schema
    // version, so their readers never guess that those eras existed.
    const normalized = parsed.schemaVersion === 5 ? 5 : parsed.schemaVersion === 4 ? 4 : 3
    return { ...parsed, schemaVersion: normalized, control, phases: parsed.phases } as RunMetadata
  } catch {
    log.warn(`ignoring corrupt run metadata at ${path}`)
    return undefined
  }
}

function newMetadata(runID: string, targetDir: string): RunMetadata {
  const now = Date.now()
  return { schemaVersion: 5, runID, targetDir, createdAt: now, updatedAt: now, control: { state: "running" }, phases: {} }
}

/** The prompt document in the run workspace; a missing or unreadable one simply resolves no prompt title. */
async function readPromptDocument(runDir: string): Promise<string | undefined> {
  try {
    return await readFile(join(runDir, "prd.md"), "utf8")
  } catch {
    return undefined
  }
}
