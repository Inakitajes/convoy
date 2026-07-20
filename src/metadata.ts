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
} from "./progress"
import type { Pipeline } from "./types"
import type { ModelGateway } from "./model-routing"
import { PhaseUsage } from "./usage"
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
}

export type RunMetadata = {
  schemaVersion: 2
  runID: string
  targetDir: string
  createdAt: number
  updatedAt: number
  /** The resolved pipeline this run executes; resume replays it even if the project config changed since. */
  pipeline?: Pipeline
  modelRouting?: { gateway: ModelGateway }
  /** The live opencode server for this run while it executes; cleared on shutdown, so a lingering entry means the run process died mid-flight. Lets `convoy runs` attach to a running run. */
  server?: { url: string; pid: number; startedAt: number }
  phases: Record<string, PhaseMetadata>
}

export type RunMetadataStore = {
  /** The effective pipeline for this run: the frozen one on resume, the freshly resolved one otherwise. */
  pipeline: Pipeline
  snapshot(name: string): ProgressPhaseSnapshot | undefined
  phaseStatus(name: string): PhaseMetadataStatus | undefined
  /** Records the run's live opencode server URL so `convoy runs` can attach; cleared by serverStopped. */
  serverStarted(url: string): void
  serverStopped(): void
  phaseStarted(name: string): void
  phaseSession(name: string, sessionID: string): void
  phaseStepUsage(name: string, usage: ProgressStepUsage): void
  phaseUsageTotal(name: string, usage: ProgressUsage): void
  repositoryBaseline(name: string): RepoSnapshot | undefined
  phaseRepositoryBaseline(name: string, baseline: RepoSnapshot): Promise<void>
  phaseEnded(name: string, status: "completed" | "skipped" | "failed"): void
  flush(): Promise<void>
}

const saveDebounceMs = 2_000

export async function openRunMetadata(workspace: Workspace, targetDir: string, pipeline: Pipeline, gateway: ModelGateway = "configured", gatewayOverride = false): Promise<RunMetadataStore> {
  const path = join(workspace.dir, "metadata.json")
  const data = (await loadMetadata(path, workspace.runID)) ?? newMetadata(workspace.runID, targetDir)
  // Step names are user-configurable safe identifiers and may still equal
  // Object.prototype keys such as "constructor" or "__proto__".
  data.phases = Object.assign(Object.create(null) as Record<string, PhaseMetadata>, data.phases)
  // First open freezes the pipeline; pre-pipeline (v1) runs adopt the current
  // one, whose default step names match what those runs executed.
  let effectivePipeline = (data.pipeline ??= pipeline)
  if (gatewayOverride && data.pipeline) {
    const routedByName = new Map(pipeline.steps.map((step) => [step.name, step]))
    effectivePipeline = data.pipeline = {
      ...data.pipeline,
      steps: data.pipeline.steps.map((step) => {
        const status = data.phases[step.name]?.status
        return status === "completed" || status === "skipped" ? step : (routedByName.get(step.name) ?? step)
      }),
    }
    data.modelRouting = { gateway }
  } else {
    data.modelRouting ??= { gateway }
  }
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
    if (gatewayOverride && entry.status !== "completed" && entry.status !== "skipped") {
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
      }
    },
    phaseStatus(name) {
      return data.phases[name]?.status
    },
    serverStarted(url) {
      data.server = { url, pid: process.pid, startedAt: Date.now() }
      void persist()
    },
    serverStopped() {
      data.server = undefined
      void persist()
    },
    phaseStarted(name) {
      const entry = phase(name)
      entry.status = "running"
      entry.startedAt ??= Date.now()
      void persist()
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
    repositoryBaseline(name) {
      return data.phases[name]?.repositoryBaseline
    },
    async phaseRepositoryBaseline(name, baseline) {
      phase(name).repositoryBaseline = baseline
      await persist({ throwOnError: true })
    },
    phaseEnded(name, status) {
      const entry = phase(name)
      entry.status = status
      entry.endedAt = Date.now()
      if (entry.startedAt !== undefined) entry.durationMs = entry.endedAt - entry.startedAt
      void persist()
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
    phaseStarted(name, detail) {
      store.phaseStarted(name)
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
    phaseTodos: (name, todos) => progress.phaseTodos(name, todos),
    phaseDiff: (name, summary) => progress.phaseDiff(name, summary),
    phaseCompleted(name, detail) {
      store.phaseEnded(name, "completed")
      progress.phaseCompleted(name, detail)
    },
    phaseSkipped(name) {
      store.phaseEnded(name, "skipped")
      progress.phaseSkipped(name)
    },
    phaseFailed(name, detail) {
      store.phaseEnded(name, "failed")
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
  // Same probing contract: the runner only holds the finish screen when the UI offers one.
  if (progress.runFinished) recorder.runFinished = progress.runFinished.bind(progress)
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
    // v1 is v2 minus the frozen pipeline; openRunMetadata backfills it.
    if (![1, 2].includes(parsed.schemaVersion ?? 0) || typeof parsed.phases !== "object" || !parsed.phases) {
      log.warn(`ignoring run metadata with unknown shape at ${path}`)
      return undefined
    }
    return { ...parsed, schemaVersion: 2, phases: parsed.phases } as RunMetadata
  } catch {
    log.warn(`ignoring corrupt run metadata at ${path}`)
    return undefined
  }
}

function newMetadata(runID: string, targetDir: string): RunMetadata {
  const now = Date.now()
  return { schemaVersion: 2, runID, targetDir, createdAt: now, updatedAt: now, phases: {} }
}
