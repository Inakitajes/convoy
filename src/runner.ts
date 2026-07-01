import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline/promises"

import type { AssistantMessage, FilePartInput, OpencodeClient, Part } from "@opencode-ai/sdk/v2"

import { opencodeConfig } from "./agents"
import { fileParts } from "./attachments"
import { addAllAndCommit, createCleanRepoSnapshot, dirtyFilesPreview, dirtyTreeError, ensureRepoReady, restoreRepoSnapshot, type RepoSnapshot, statusPorcelain, writeDiff } from "./git"
import { runHumanReviewGate } from "./human"
import { log } from "./log"
import { openRunMetadata, recordProgress, type RunMetadataStore } from "./metadata"
import { startOpencode } from "./opencode"
import { startPermissionGate, type PermissionGate } from "./permissions"
import { splitModelVariant, synthesizeReadOnlyAgents, validateStepFilters } from "./pipeline"
import {
  createProgressUI,
  noopProgress,
  type ActivityKind,
  type AutoAccept,
  type ProgressDiffSummary,
  type ProgressPhase,
  type ProgressStepUsage,
  type ProgressTodo,
  type ProgressTokens,
  type ProgressUI,
  type ProgressUsage,
  type RunOutcome,
} from "./progress"
import { discoverProjectContextFiles } from "./project-context"
import type { AgentSpec, AgentStep, Pipeline, RunOptions, Step } from "./types"
import { addTokens, emptyTokens, tokensFromValue } from "./usage"
import { cleanupWorkspace, createWorkspace, resumeWorkspace, type Workspace, writeSummary } from "./workspace"

export type ActiveSession = {
  client: OpencodeClient
  sessionID: string
  directory: string
  phaseName: string
}

export class UserAbortError extends Error {
  constructor(message = "aborted by user") {
    super(message)
    this.name = "UserAbortError"
  }
}

export function isUserAbortError(error: unknown): error is UserAbortError {
  return error instanceof UserAbortError || (error instanceof Error && error.name === "UserAbortError")
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

export function shouldRetryAttempt(error: unknown, signal: AbortSignal, attempt: number, maxAttempts: number) {
  return !signal.aborted && !isUserAbortError(error) && attempt < maxAttempts
}

export class RunShutdown {
  private readonly controller = new AbortController()
  private readonly activeSessions = new Map<string, ActiveSession>()
  private abortingSessions: Promise<void> | undefined
  private requests = 0
  private forceTimer: ReturnType<typeof setTimeout> | undefined

  get signal() {
    return this.controller.signal
  }

  get aborted() {
    return this.controller.signal.aborted
  }

  request(source: string) {
    this.requests++
    if (this.requests > 1) {
      log.warn(`${source} received again; forcing exit`)
      process.exit(130)
    }

    log.warn(`${source} received; aborting active OpenCode session(s) and shutting down`)
    this.controller.abort(new UserAbortError(`${source} received`))
    this.forceTimer = setTimeout(() => {
      log.warn("Shutdown cleanup timed out; forcing exit")
      process.exit(130)
    }, 15_000)
    this.forceTimer.unref?.()
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
    if (this.activeSessions.get(phaseName)?.sessionID === sessionID) this.activeSessions.delete(phaseName)
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
  }
}

/**
 * Groups the flat step list into batches the runner executes together: a
 * human gate is always its own batch, and consecutive agent steps sharing a
 * groupId (a `parallel:` block, or one step fanned out across `models:`) form
 * one batch that runs concurrently. Validation guarantees group members are
 * always contiguous, so a linear scan suffices.
 */
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

function installShutdownSignals(shutdown: RunShutdown) {
  // Bun delivers the numeric signal value to handlers; normalize for logs.
  const handler = (signal: NodeJS.Signals | number) =>
    shutdown.request(typeof signal === "number" ? (signal === 15 ? "SIGTERM" : signal === 2 ? "SIGINT" : `signal ${signal}`) : signal)
  process.on("SIGINT", handler)
  process.on("SIGTERM", handler)
  return () => {
    process.off("SIGINT", handler)
    process.off("SIGTERM", handler)
  }
}

export async function run(options: RunOptions) {
  await ensureRepoReady(options.targetDir, {
    includeDirty: options.includeDirty,
    maxAttempts: options.maxAttempts,
    baseRef: options.baseRef,
    allowDirty: Boolean(options.resumeRunID),
  })

  const workspace = options.resumeRunID
    ? await resumeWorkspace(options.resumeRunID)
    : await createWorkspace(options.prompt)

  let runErr: unknown
  let opencode: Awaited<ReturnType<typeof startOpencode>> | undefined
  let progress: ProgressUI = noopProgress
  let permissions: PermissionGate | undefined
  let metadata: RunMetadataStore | undefined
  const shutdown = new RunShutdown()
  const removeSignalHandlers = installShutdownSignals(shutdown)

  const autoAccept: AutoAccept = { mode: options.yolo ? "all" : options.smart ? "smart" : "off" }
  // cli.ts always resolves a concrete model string (--smart-model → config →
  // --model → defaults.model), so smart mode never lacks a judge.
  const judgeModel = parseModel(splitModelVariant(options.smartJudgeModel).model)

  try {
    metadata = await openRunMetadata(workspace, options.targetDir, options.pipeline)
    // Resumed runs replay the pipeline frozen in their metadata, so the steps
    // (and thus --only/--skip names and required agents) come from there.
    const pipeline = metadata.pipeline
    validateStepFilters(pipeline, options)
    // Parallel/multi-model steps are forced read-only and point at a synthesized
    // "<agent>__ro" variant when their base agent isn't already read-only;
    // register those variants alongside the normal registry for this run.
    const agents = [...options.agents, ...synthesizeReadOnlyAgents(pipeline, options.agents)]
    ensureAgentsAvailable(pipeline, agents)
    // A run interrupted before its phase commit leaves the tree dirty; on resume
    // offer to commit that work as the interrupted phase and continue. Runs here,
    // before the TUI grabs the terminal, so the readline prompt stays visible.
    await maybeRecoverDirtyTree(workspace, metadata, options)
    progress = recordProgress(
      await createProgressUI(progressPhases(pipeline), options.tui, () => shutdown.request("Ctrl+C"), autoAccept),
      metadata,
    )
    progress.start(workspace.runID, options.targetDir)
    log.info(`Run ${workspace.runID} - dir: ${workspace.dir}`)
    if (options.yolo) {
      progress.message("YOLO enabled: ask-level permissions will be auto-allowed (denylist still applies); shift+tab toggles")
      log.warn("YOLO enabled: unknown non-denied commands will be auto-allowed")
    } else if (options.smart) {
      progress.message(`smart auto-accept enabled: ${formatModel(judgeModel)} judges each request; risky ones still prompt (shift+tab toggles)`)
      log.warn(`smart auto-accept enabled: ${formatModel(judgeModel)} will auto-allow requests it judges safe`)
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
    try {
      opencode = await startOpencode(opencodeConfig(workspace.dir, options.targetDir, agents, options.permissions), boot.signal)
    } finally {
      shutdown.signal.removeEventListener("abort", abortBoot)
    }
    progress.serverReady(opencode.url)
    log.info(`opencode SDK ready at ${opencode.url}`)

    permissions = startPermissionGate({
      client: opencode.client,
      progress,
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      directory: options.targetDir,
      autoAccept,
      judgeModel,
    })

    const resuming = Boolean(options.resumeRunID)
    const gitLock = createGitLock()
    // Narrow once, outside any closure: opencode/metadata are `let`s assigned
    // above, and TS won't retain that narrowing inside the batch's nested
    // arrow functions, but a `const` alias captured here stays narrowed.
    const client = opencode.client
    const runMetadata = metadata

    for (const batch of planBatches(pipeline.steps)) {
      shutdown.throwIfRequested()
      const [first] = batch

      if (batch.length === 1 && first?.type === "human") {
        if (shouldSkip(first, options)) {
          progress.phaseSkipped(first.name)
          log.warn(`[${first.name}] skipped by flag`)
          continue
        }
        await runHumanReviewGate(workspace, options, opencode.url, progress, permissions, first.name)
        continue
      }

      const agentBatch = batch as AgentStep[]
      const results = await Promise.allSettled(
        agentBatch.map(async (step) => {
          if (shouldSkip(step, options)) {
            progress.phaseSkipped(step.name)
            log.warn(`[${step.name}] skipped by flag`)
            return
          }
          const restored = resuming && (await restorePhaseFromPreviousRun(workspace, runMetadata, step, progress))
          if (!restored) {
            await runPhase(client, workspace, step, options, extraFiles, projectContextFiles, progress, shutdown, gitLock)
          }
        }),
      )

      // Every batch member runs to completion (Promise.allSettled, not
      // fail-fast) since forced-read-only siblings can't corrupt each other's
      // work; a user abort takes priority and propagates unwrapped so the
      // existing isUserAbortError handling below keeps working.
      const userAbort = results.find((result): result is PromiseRejectedResult => result.status === "rejected" && isUserAbortError(result.reason))
      if (userAbort) throw userAbort.reason
      const failures = results.flatMap((result, index) => (result.status === "rejected" ? [{ name: agentBatch[index]!.name, error: result.reason }] : []))
      if (failures.length > 0) throw new PhaseGroupError(failures)
    }

    progress.message("writing run summary")
    await writeSummary(workspace, pipeline.steps.map((step) => step.name))
    await holdFinishScreen(progress, shutdown, { status: "completed", runDir: workspace.dir })
  } catch (error) {
    runErr = error
    if (!isUserAbortError(error)) {
      await holdFinishScreen(progress, shutdown, { status: "failed", error: formatSdkError(error), runDir: workspace.dir })
    }
    throw error
  } finally {
    removeSignalHandlers()
    if (shutdown.aborted) await shutdown.abortActiveSessions(progress)
    await permissions?.stop()
    await metadata?.flush().catch((error) => log.warn(`couldn't flush run metadata: ${String(error)}`))
    progress.stop()
    shutdown.dispose()

    if (runErr || options.keepRunDir) {
      log.warn(`Run dir preserved at ${workspace.dir}`)
    } else {
      await cleanupWorkspace(workspace).catch((error) => log.warn(`couldn't clean ${workspace.dir}: ${String(error)}`))
    }

    // Kill the server last and return immediately: once it dies, any event
    // stream still held open by the SDK starts failing, and those failures
    // must not get a chance to surface mid-cleanup.
    opencode?.close()
  }
}

// The finish screen holds the run open while the opencode server and the run
// dir are still alive, so [o] can attach to phase sessions and reports stay
// readable. A signal (SIGTERM, a second Ctrl+C) must still tear the run down
// without user input, hence the race against the shutdown signal.
async function holdFinishScreen(progress: ProgressUI, shutdown: RunShutdown, outcome: RunOutcome) {
  if (!progress.runFinished || shutdown.aborted) return
  await Promise.race([
    progress.runFinished(outcome),
    new Promise<void>((resolve) => shutdown.signal.addEventListener("abort", () => resolve(), { once: true })),
  ])
}

// A failed phase can still leave a report behind (the agent writes it
// mid-session before the commit step or a later attempt blows up), so the
// report's existence alone can't prove the phase finished: a phase the
// metadata marks as failed must retry, and its stale report must go first or
// persistPhaseReport would keep it on the rerun.
export async function restorePhaseFromPreviousRun(
  workspace: Workspace,
  metadata: RunMetadataStore,
  phase: AgentStep,
  progress: ProgressUI,
): Promise<boolean> {
  if (await phaseNeedsRun(workspace, metadata, phase)) {
    // A failed phase can leave its report behind; drop it so persistPhaseReport
    // writes a fresh one on the rerun instead of keeping the stale one.
    const reportAbs = join(workspace.dir, phase.reportPath)
    if (await exists(reportAbs)) {
      await rm(reportAbs, { force: true })
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

// A phase still needs to run on resume when its report is missing (it never
// finished) or the metadata marks it failed (its report, if any, is stale).
async function phaseNeedsRun(workspace: Workspace, metadata: RunMetadataStore, phase: AgentStep): Promise<boolean> {
  if (!(await exists(join(workspace.dir, phase.reportPath)))) return true
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
  const porcelain = await statusPorcelain(options.targetDir)
  if (porcelain.trim() === "") return

  const dirty = () => dirtyTreeError(options.targetDir, porcelain, { resuming: true })
  const phase = await selectInterruptedPhase(workspace, metadata, metadata.pipeline)
  // No pending agent phase means the changes don't belong to an interrupted
  // phase (stray edits); leave them for the user rather than guess.
  if (!phase) throw dirty()
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

// Treats the dirty tree as the interrupted phase's output: writes a recovery
// report if the phase never wrote one, commits everything as that phase, and
// marks it completed so the resume loop skips it and runs the rest.
export async function commitRecoveredPhase(
  workspace: Workspace,
  metadata: RunMetadataStore,
  phase: AgentStep,
  targetDir: string,
) {
  const reportAbs = join(workspace.dir, phase.reportPath)
  if (!(await exists(reportAbs))) {
    await mkdir(dirname(reportAbs), { recursive: true })
    await writeFile(reportAbs, recoveryReport(phase.name))
  }

  const committed = await addAllAndCommit(`archer(${phase.name}): ${await summaryFromReport(reportAbs)}`, targetDir)
  if (committed) log.info(`[${phase.name}] recovered uncommitted changes into a commit; continuing from the next phase`)
  else log.warn(`[${phase.name}] nothing to commit during recovery`)

  metadata.phaseEnded(phase.name, "completed")
  await metadata.flush()
}

function recoveryReport(phaseName: string) {
  return [
    "# Recovered uncommitted changes",
    "",
    `Phase "${phaseName}" was interrupted before archer committed its work. The`,
    "uncommitted changes left in the working tree were committed as this phase during a",
    "manual resume recovery, and the pipeline continued from the next phase.",
    "",
  ].join("\n")
}

async function runPhase(
  client: OpencodeClient,
  workspace: Workspace,
  phase: AgentStep,
  options: RunOptions,
  extraFiles: FilePartInput[],
  projectContextFiles: string[],
  progress: ProgressUI,
  shutdown: RunShutdown,
  gitLock: GitLock,
) {
  progress.phaseStarted(phase.name, phase.description)
  log.section(`${phase.name} - ${phase.description}`)

  try {
    const prepared = await preparePhaseRun(workspace, phase, options, extraFiles, projectContextFiles)
    const baseline = await gitLock(() => createCleanRepoSnapshot(options.targetDir))
    const assistantText = await runPhaseWithRetries(client, workspace, phase, options.targetDir, prepared, baseline, progress, shutdown, gitLock)

    const reportAbs = await persistPhaseReport(workspace, phase, assistantText)
    await gitLock(() => commitPhase(phase, reportAbs, options.targetDir))
    progress.phaseCompleted(phase.name, "report saved and commit checked")
  } catch (error) {
    progress.phaseFailed(phase.name, formatSdkError(error))
    throw error
  }
}

type PreparedPhaseRun = {
  attachments: FilePartInput[]
  prompt: string
  model: ModelSelection
  maxAttempts: number
}

type ModelSelection = { providerID: string; modelID: string; variant?: string }

async function preparePhaseRun(
  workspace: Workspace,
  phase: AgentStep,
  options: RunOptions,
  extraFiles: FilePartInput[],
  projectContextFiles: string[],
): Promise<PreparedPhaseRun> {
  const inputs = [...phase.inputFiles]
  if (phase.inputDiff) {
    const diffRel = join("diffs", `${phase.name}.pre.diff`)
    const diffAbs = join(workspace.dir, diffRel)
    await writeDiff(diffAbs, options.baseRef, options.targetDir)
    inputs.push(diffRel)
  }

  const phaseFiles = await fileParts(inputs, workspace.dir, "skip")
  const contextFiles = await projectContextFileParts(projectContextFiles, options.targetDir)
  const attachments = [...contextFiles, ...phaseFiles, ...extraFiles]
  const prompt = buildPhasePrompt(workspace, phase)
  const model = selectedModel(phase, options.modelOverride)
  const maxAttempts = Math.max(1, phase.maxAttempts ?? options.maxAttempts)

  return { attachments, prompt, model, maxAttempts }
}

async function projectContextFileParts(paths: string[], targetDir: string) {
  const out: FilePartInput[] = []
  for (const path of paths) {
    const parts = await fileParts([path], targetDir, "skip")
    out.push(...parts.map((part) => ({ ...part, filename: path })))
  }
  return out
}

async function runPhaseWithRetries(
  client: OpencodeClient,
  workspace: Workspace,
  phase: AgentStep,
  targetDir: string,
  prepared: PreparedPhaseRun,
  baseline: RepoSnapshot | undefined,
  progress: ProgressUI,
  shutdown: RunShutdown,
  gitLock: GitLock,
) {
  if (!baseline && prepared.maxAttempts > 1) {
    throw new Error(`[${phase.name}] can't retry with dirty working tree; use --max-attempts 1 or clean the repo`)
  }

  let lastError: unknown

  for (let attempt = 1; attempt <= prepared.maxAttempts; attempt++) {
    shutdown.throwIfRequested()
    progress.phaseAttempt(phase.name, { attempt, maxAttempts: prepared.maxAttempts, model: formatModel(prepared.model) })
    log.info(`[${phase.name}] attempt ${attempt}/${prepared.maxAttempts} with ${formatModel(prepared.model)}`)
    try {
      return await runPhaseAttempt(client, workspace, phase, targetDir, prepared, attempt, progress, shutdown)
    } catch (error) {
      if (!shouldRetryAttempt(error, shutdown.signal, attempt, prepared.maxAttempts) && (shutdown.aborted || isUserAbortError(error))) {
        throw shutdown.abortError(error)
      }
      lastError = error
      progress.phaseRunning(phase.name, `attempt ${attempt} failed`)
      log.warn(`[${phase.name}] attempt ${attempt} failed: ${formatSdkError(error)}`)
      if (!(error instanceof LoggedAttemptError)) {
        await writeAttemptLog(workspace, phase, attempt, { error: formatSdkError(error) })
      }
      if (shouldRetryAttempt(error, shutdown.signal, attempt, prepared.maxAttempts)) await gitLock(() => restorePhaseBaseline(phase, baseline, targetDir, error))
    }
  }

  if (lastError) {
    await gitLock(() => restorePhaseBaseline(phase, baseline, targetDir, lastError))
    throw lastError
  }

  return ""
}

async function runPhaseAttempt(
  client: OpencodeClient,
  workspace: Workspace,
  phase: AgentStep,
  targetDir: string,
  prepared: PreparedPhaseRun,
  attempt: number,
  progress: ProgressUI,
  shutdown: RunShutdown,
) {
  const result = await promptPhase(client, {
    phase,
    workspace,
    targetDir,
    prompt: prepared.prompt,
    model: prepared.model,
    attachments: prepared.attachments,
    progress,
    shutdown,
  })
  const assistantText = extractAssistantText(result.parts)

  await writeAttemptLog(workspace, phase, attempt, {
    session: result.info.sessionID,
    agent: phase.agentName,
    model: prepared.model,
    attachments: prepared.attachments.map((file) => ({ filename: file.filename, mime: file.mime, url: file.url })),
    finish: result.info.finish,
    cost: result.info.cost,
    tokens: result.info.tokens,
    error: result.info.error,
    text: assistantText,
  })

  if (result.info.error) throw new LoggedAttemptError(formatSdkError(result.info.error))

  return assistantText
}

async function persistPhaseReport(workspace: Workspace, phase: AgentStep, assistantText: string) {
  const reportAbs = join(workspace.dir, phase.reportPath)
  if (!(await exists(reportAbs)) && assistantText.trim() !== "") {
    await mkdir(dirname(reportAbs), { recursive: true })
    await writeFile(reportAbs, assistantText)
  }

  if (!(await exists(reportAbs))) {
    log.warn(`[${phase.name}] agent didn't write the expected report at ${reportAbs}`)
  }

  return reportAbs
}

async function commitPhase(phase: AgentStep, reportAbs: string, targetDir: string) {
  const message = `archer(${phase.name}): ${await summaryFromReport(reportAbs)}`
  const committed = await addAllAndCommit(message, targetDir)
  if (!committed) {
    log.info(`[${phase.name}] no changes - no commit`)
  } else {
    log.info(`[${phase.name}] commit: ${message}`)
  }
}

async function restorePhaseBaseline(phase: AgentStep, baseline: RepoSnapshot | undefined, targetDir: string, originalError: unknown) {
  if (!baseline) return
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

async function promptPhase(
  client: OpencodeClient,
  input: {
    phase: AgentStep
    workspace: Workspace
    targetDir: string
    prompt: string
    model: ModelSelection
    attachments: FilePartInput[]
    progress: ProgressUI
    shutdown: RunShutdown
  },
): Promise<SessionResult> {
  input.shutdown.throwIfRequested()
  const session = await client.session.create({
    directory: input.targetDir,
    title: `archer ${input.workspace.runID} ${input.phase.name}`,
    metadata: { archerRunID: input.workspace.runID, archerPhase: input.phase.name },
  }, { signal: input.shutdown.signal })
  if (session.error) throw new Error(formatSdkError(session.error))
  if (!session.data?.id) throw new Error("opencode didn't return session id")

  input.progress.phaseSession(input.phase.name, session.data.id)
  input.shutdown.setActiveSession({ client, sessionID: session.data.id, directory: input.targetDir, phaseName: input.phase.name })
  log.info(`[${input.phase.name}] session: ${session.data.id}`)

  // The prompt is fired asynchronously and completion is detected through the
  // event stream plus status polling. A single blocking HTTP request can't
  // survive a phase that runs for an hour (Bun kills idle sockets after 5min).
  const watcher = watchSession(client, {
    directory: input.targetDir,
    phaseName: input.phase.name,
    sessionID: session.data.id,
    progress: input.progress,
    signal: input.shutdown.signal,
  })

  try {
    // Don't fire the prompt until the event stream is listening, or the first
    // events of a fast-failing session are lost.
    await Promise.race([watcher.ready, sleep(3_000)])
    input.shutdown.throwIfRequested()

    const accepted = await client.session.promptAsync({
      sessionID: session.data.id,
      directory: input.targetDir,
      agent: input.phase.agentName,
      model: { providerID: input.model.providerID, modelID: input.model.modelID },
      variant: input.model.variant,
      parts: [...input.attachments, { type: "text", text: input.prompt }],
    }, { signal: input.shutdown.signal })
    if (accepted.error) throw new Error(formatSdkError(accepted.error))
    const result = await watcher.result
    input.shutdown.throwIfRequested()

    const usage = combinedAssistantUsage(result.assistantInfos, session.data.id)
    if (usage) {
      input.progress.phaseUsageTotal(input.phase.name, usage)
      log.info(`[${input.phase.name}] usage: ${formatUsageForLog(usage)}`)
    }
    return result
  } catch (error) {
    if (!input.shutdown.aborted && !isUserAbortError(error)) {
      await abortSessionQuietly(client, session.data.id, input.targetDir, input.phase.name)
    }
    throw error
  } finally {
    if (input.shutdown.aborted) await input.shutdown.abortActiveSessions(input.progress)
    input.shutdown.clearActiveSession(input.phase.name, session.data.id)
    await watcher.stop()
  }
}

type SessionResult = {
  info: AssistantMessage
  parts: Part[]
  assistantInfos: AssistantMessage[]
}

type SessionWatcher = {
  result: Promise<SessionResult>
  ready: Promise<void>
  stop(): Promise<void>
}

type ActivityState = {
  reasoningChars: number
  textChars: number
  textTail: string
  currentStepModel: string
  lastReasoningUpdate: number
  lastTextUpdate: number
  lastServerEvent: number
  messageUsage: Map<string, { cost: number; tokens: ProgressTokens }>
  usageSignature: string
}

type SessionSignal =
  | { type: "activity"; kind: ActivityKind; message: string; stepUsage?: ProgressStepUsage; pulse?: boolean }
  | { type: "usage"; usage: ProgressUsage }
  | { type: "todos"; todos: ProgressTodo[]; message: string }
  | { type: "diff"; summary: ProgressDiffSummary }
  | { type: "idle" }
  | { type: "error"; error: string }

const sessionPollMs = 30_000
const maxConsecutivePollFailures = 10
const reconnectBaseMs = 1_000
const reconnectMaxMs = 15_000

function watchSession(
  client: OpencodeClient,
  input: {
    directory: string
    phaseName: string
    sessionID: string
    progress: ProgressUI
    signal: AbortSignal
  },
): SessionWatcher {
  const controller = new AbortController()
  const state = newActivityState()

  let settled = false
  let sawWork = false
  let idlePollsWithoutResult = 0
  let lastSessionError: string | undefined
  let verifying: Promise<boolean> | undefined

  let resolveResult!: (value: SessionResult) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<SessionResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  result.catch(() => {}) // the watcher may be stopped before anyone awaits the result

  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  const finish = (outcome: { value?: SessionResult; error?: unknown }) => {
    if (settled) return
    settled = true
    controller.abort(new Error("session watcher finished"))
    if (outcome.value) resolveResult(outcome.value)
    else rejectResult(outcome.error)
  }

  const onExternalAbort = () => finish({ error: new UserAbortError() })
  input.signal.addEventListener("abort", onExternalAbort, { once: true })
  if (input.signal.aborted) onExternalAbort()

  // A session is complete once its last assistant message either finished or
  // carries a terminal error. Verified against the server, never assumed.
  const verifyCompletion = () => {
    if (settled) return Promise.resolve(true)
    verifying ??= (async () => {
      try {
        const response = await client.session.messages({ sessionID: input.sessionID, directory: input.directory })
        if (response.error || !response.data) return false
        const assistant = response.data.filter(
          (message): message is { info: AssistantMessage; parts: Part[] } => message.info.role === "assistant",
        )
        const last = assistant[assistant.length - 1]
        if (!last || (!last.info.time.completed && !last.info.error)) return false
        finish({
          value: {
            info: last.info,
            parts: assistant.flatMap((message) => message.parts),
            assistantInfos: assistant.map((message) => message.info),
          },
        })
        return true
      } catch {
        return false
      } finally {
        verifying = undefined
      }
    })()
    return verifying
  }

  const handleSignal = async (signal: SessionSignal) => {
    switch (signal.type) {
      case "activity":
        if (signal.stepUsage) input.progress.phaseStepUsage(input.phaseName, signal.stepUsage)
        input.progress.phaseActivity(input.phaseName, signal.message, signal.kind, signal.pulse)
        return
      case "usage":
        input.progress.phaseUsageTotal(input.phaseName, signal.usage)
        return
      case "todos":
        input.progress.phaseTodos(input.phaseName, signal.todos)
        input.progress.phaseActivity(input.phaseName, signal.message, "todo")
        return
      case "diff":
        input.progress.phaseDiff(input.phaseName, signal.summary)
        return
      case "error":
        lastSessionError = signal.error
        input.progress.phaseActivity(input.phaseName, `session error: ${signal.error}`, "error")
        await verifyCompletion()
        return
      case "idle":
        input.progress.phaseActivity(input.phaseName, "session idle; collecting results", "info")
        if (!(await verifyCompletion()) && sawWork) {
          finish({ error: new Error(lastSessionError ?? "session went idle without a completed response") })
        }
        return
    }
  }

  const eventLoop = (async () => {
    let reconnectDelay = reconnectBaseMs
    while (!controller.signal.aborted && !settled) {
      try {
        const stream = await client.event.subscribe({ directory: input.directory }, { signal: controller.signal })
        reconnectDelay = reconnectBaseMs
        for await (const event of stream.stream) {
          resolveReady() // any event (server.connected included) proves the stream is live
          if (controller.signal.aborted || settled) return
          const payload = eventPayload(event)
          if (!payloadMatchesSession(payload, input.sessionID)) continue
          state.lastServerEvent = Date.now()
          const signal = describeSessionActivity(payload, state)
          if (signal) {
            if (signal.type !== "idle" && signal.type !== "error") sawWork = true
            await handleSignal(signal)
          }
          if (settled) return
        }
      } catch (error) {
        resolveReady()
        if (controller.signal.aborted || settled) return
        input.progress.phaseActivity(input.phaseName, `event stream dropped; reconnecting: ${formatSdkError(error)}`, "info")
      }
      if (controller.signal.aborted || settled) return
      await sleep(reconnectDelay, controller.signal)
      reconnectDelay = Math.min(reconnectDelay * 2, reconnectMaxMs)
    }
  })()

  const pollLoop = (async () => {
    let failures = 0
    while (!controller.signal.aborted && !settled) {
      await sleep(sessionPollMs, controller.signal)
      if (controller.signal.aborted || settled) return
      try {
        const response = await client.session.status({ directory: input.directory })
        if (response.error) throw new Error(formatSdkError(response.error))
        failures = 0
        const status = response.data?.[input.sessionID]
        if (!status || status.type === "idle") {
          if (await verifyCompletion()) return
          idlePollsWithoutResult++
          const limit = sawWork ? 2 : 4
          if (idlePollsWithoutResult >= limit) {
            finish({ error: new Error(lastSessionError ?? `session ${sawWork ? "went idle" : "never started"} without a completed response`) })
            return
          }
        } else {
          sawWork = true
          idlePollsWithoutResult = 0
          if (Date.now() - state.lastServerEvent >= sessionPollMs) {
            const detail = status.type === "retry" ? `provider retry ${status.attempt}: ${status.message}` : "opencode is still working (no events)"
            input.progress.phaseActivity(input.phaseName, detail, status.type === "retry" ? "retry" : "info")
          }
        }
      } catch (error) {
        failures++
        if (failures >= maxConsecutivePollFailures) {
          finish({ error: new Error(`lost contact with the opencode server: ${formatSdkError(error)}`) })
          return
        }
        input.progress.phaseActivity(input.phaseName, `status check failed (${failures}/${maxConsecutivePollFailures}): ${formatSdkError(error)}`, "error")
      }
    }
  })()

  return {
    result,
    ready,
    async stop() {
      settled = true
      resolveReady()
      controller.abort(new Error("session watcher stopped"))
      input.signal.removeEventListener("abort", onExternalAbort)
      // Aborting tears the subscription down promptly; the race is a safety
      // net so a misbehaving stream can never hold the whole run hostage.
      await Promise.race([Promise.allSettled([eventLoop, pollLoop]), sleep(3_000)])
    },
  }
}

async function abortSessionQuietly(client: OpencodeClient, sessionID: string, directory: string, phaseName: string) {
  try {
    const response = await client.session.abort({ sessionID, directory })
    if (response.error) log.warn(`[${phaseName}] couldn't abort session ${sessionID}: ${formatSdkError(response.error)}`)
  } catch (error) {
    log.warn(`[${phaseName}] couldn't abort session ${sessionID}: ${formatSdkError(error)}`)
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const done = () => {
      signal?.removeEventListener("abort", done)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener("abort", done, { once: true })
  })
}

function eventPayload(event: unknown) {
  if (event && typeof event === "object" && "payload" in event) return (event as { payload?: unknown }).payload
  return event
}

function payloadProperties(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined
  const properties = (payload as { properties?: unknown }).properties
  if (properties && typeof properties === "object") return properties as Record<string, unknown>
  const data = (payload as { data?: unknown }).data
  if (data && typeof data === "object") return data as Record<string, unknown>
  return undefined
}

function payloadType(payload: unknown) {
  if (!payload || typeof payload !== "object") return ""
  const type = (payload as { type?: unknown }).type
  if (typeof type === "string") return type === "sync" ? String((payload as { name?: unknown }).name ?? "").replace(/\.1$/, "") : type
  const name = (payload as { name?: unknown }).name
  return typeof name === "string" ? name.replace(/\.1$/, "") : ""
}

function payloadMatchesSession(payload: unknown, sessionID: string) {
  const properties = payloadProperties(payload)
  return properties?.sessionID === sessionID
}

export function newActivityState(): ActivityState {
  return {
    reasoningChars: 0,
    textChars: 0,
    textTail: "",
    currentStepModel: "",
    lastReasoningUpdate: 0,
    lastTextUpdate: 0,
    lastServerEvent: Date.now(),
    messageUsage: new Map(),
    usageSignature: "",
  }
}

function activity(kind: ActivityKind, message: string, stepUsage?: ProgressStepUsage): SessionSignal {
  return { type: "activity", kind, message, stepUsage }
}

// Heartbeats refresh the live status line but never land in the activity feed.
function pulse(kind: ActivityKind, message: string): SessionSignal {
  return { type: "activity", kind, message, pulse: true }
}

export function describeSessionActivity(payload: unknown, state: ActivityState): SessionSignal | undefined {
  const type = payloadType(payload)
  const properties = payloadProperties(payload)
  if (!properties) return undefined
  const now = Date.now()

  switch (type) {
    case "session.next.prompted":
      return activity("info", "prompt submitted")
    case "session.next.step.started":
      state.currentStepModel = formatModelFromEvent(properties.model)
      return activity("step", `working with ${state.currentStepModel}`)
    case "session.next.step.ended": {
      const message = `step finished: ${pickString(properties, ["finish"]) || "complete"}${formatCost(properties)}`
      return activity("step", message, stepUsageFromEvent(payload, properties, state.currentStepModel))
    }
    case "session.next.step.failed":
      return activity("error", `step failed: ${formatEventError(properties.error)}`)
    case "session.status":
      return describeSessionStatus(properties.status)
    case "session.idle":
      return { type: "idle" }
    case "session.next.reasoning.started":
      state.reasoningChars = 0
      state.lastReasoningUpdate = now
      return activity("think", "thinking…")
    case "session.next.reasoning.delta":
      state.reasoningChars += pickString(properties, ["delta"]).length
      if (now - state.lastReasoningUpdate < 1000) return undefined
      state.lastReasoningUpdate = now
      return activity("think", `thinking… ${formatCharCount(state.reasoningChars)} hidden chars`)
    case "session.next.reasoning.ended":
      return activity("think", "thinking complete")
    case "session.next.text.started":
      state.textChars = 0
      state.textTail = ""
      state.lastTextUpdate = now
      return activity("write", "writing response…")
    case "session.next.text.delta": {
      const delta = pickString(properties, ["delta"])
      state.textChars += delta.length
      state.textTail = `${state.textTail}${delta}`.slice(-160)
      if (now - state.lastTextUpdate < 350) return undefined
      state.lastTextUpdate = now
      return activity("write", `writing (${formatCharCount(state.textChars)}): ${state.textTail}`)
    }
    case "session.next.text.ended":
      return activity("write", `response complete (${formatCharCount(pickString(properties, ["text"]).length || state.textChars)})`)
    case "message.updated":
      return messageUsageSignal(properties, state)
    case "message.part.delta":
      return pulse("write", `streaming ${pickString(properties, ["field"]) || "message"}`)
    case "session.next.tool.input.started":
      return activity("tool", `preparing ${pickString(properties, ["name"]) || "tool"}`)
    case "session.next.tool.called":
      return activity("tool", describeToolCall(properties))
    case "session.next.tool.progress":
      return activity("tool", `tool progress: ${describeToolContent(properties.content)}`)
    case "session.next.tool.success":
      return activity("tool", `tool done: ${describeToolContent(properties.content)}`)
    case "session.next.tool.failed":
      return activity("error", `tool failed: ${formatEventError(properties.error)}`)
    case "session.next.shell.started":
      return activity("bash", pickString(properties, ["command"]))
    case "session.next.shell.ended":
      return activity("bash", `done: ${firstLine(pickString(properties, ["output"]))}`)
    case "session.next.retried":
      return activity("retry", `provider retry ${properties.attempt ?? ""}: ${formatEventError(properties.error)}`)
    case "session.next.compaction.started":
      return activity("info", `compacting context (${pickString(properties, ["reason"]) || "auto"})`)
    case "session.next.compaction.delta":
      return activity("info", "compacting context…")
    case "session.next.compaction.ended":
      return activity("info", "context compaction complete")
    case "permission.asked":
      return activity("permission", `permission requested: ${pickString(properties, ["permission"])}`)
    case "permission.replied":
      return activity("permission", `permission ${pickString(properties, ["reply"])}`)
    case "todo.updated": {
      const todos = todosFromEvent(properties.todos)
      const done = todos.filter((todo) => todo.status === "completed").length
      return { type: "todos", todos, message: `todos updated (${done}/${todos.length} done)` }
    }
    case "session.diff":
      return { type: "diff", summary: diffSummaryFromEvent(properties.diff) }
    case "session.error":
      return { type: "error", error: formatEventError(properties.error) }
    default:
      if (type.startsWith("session.next.")) return activity("info", type.replace(/^session\.next\./, ""))
      return undefined
  }
}

function describeSessionStatus(value: unknown): SessionSignal | undefined {
  if (!value || typeof value !== "object") return undefined
  const status = value as { type?: unknown; attempt?: unknown; message?: unknown }
  if (status.type === "busy") return pulse("info", "provider busy")
  if (status.type === "idle") return pulse("info", "provider idle")
  if (status.type === "retry") {
    return activity("retry", `provider retry ${status.attempt ?? ""}: ${typeof status.message === "string" ? status.message : "waiting"}`)
  }
  return undefined
}

function todosFromEvent(value: unknown): ProgressTodo[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const todo = item as { content?: unknown; status?: unknown }
    if (typeof todo.content !== "string") return []
    return [{ content: todo.content, status: typeof todo.status === "string" ? todo.status : "pending" }]
  })
}

function diffSummaryFromEvent(value: unknown): ProgressDiffSummary {
  if (!Array.isArray(value)) return { files: 0, additions: 0, deletions: 0 }
  let additions = 0
  let deletions = 0
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const diff = item as { additions?: unknown; deletions?: unknown }
    if (typeof diff.additions === "number") additions += diff.additions
    if (typeof diff.deletions === "number") deletions += diff.deletions
  }
  return { files: value.length, additions, deletions }
}

function formatCharCount(value: number) {
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function formatModelFromEvent(value: unknown) {
  if (!value || typeof value !== "object") return "selected model"
  const model = value as { providerID?: unknown; id?: unknown; variant?: unknown }
  const provider = typeof model.providerID === "string" ? model.providerID : "provider"
  const id = typeof model.id === "string" ? model.id : "model"
  const variant = typeof model.variant === "string" && model.variant ? `#${model.variant}` : ""
  return `${provider}/${id}${variant}`
}

function formatCost(properties: Record<string, unknown>) {
  const tokens = tokensFromValue(properties.tokens)
  const cost = typeof properties.cost === "number" ? `, $${properties.cost.toFixed(4)}` : ""
  if (!tokens) return cost
  const reasoning = tokens.reasoning ? `/${tokens.reasoning}` : ""
  return `, tokens ${tokens.input}/${tokens.output}${reasoning}${cost}`
}

function stepUsageFromEvent(payload: unknown, properties: Record<string, unknown>, model: string): ProgressStepUsage | undefined {
  const usage = usageFromRecord(properties)
  if (!usage) return undefined
  return {
    ...usage,
    stepID: payloadID(payload),
    sessionID: typeof properties.sessionID === "string" ? properties.sessionID : undefined,
    model: model || usage.model,
  }
}

// Assistant messages carry cumulative cost/tokens that opencode refreshes on
// every model round-trip, so message.updated is the live usage signal; step
// deltas only matter as fallback until the first one arrives.
function messageUsageSignal(properties: Record<string, unknown>, state: ActivityState): SessionSignal | undefined {
  const info = properties.info
  if (!info || typeof info !== "object") return undefined
  const message = info as Partial<AssistantMessage> & { role?: unknown }
  if (message.role !== "assistant" || typeof message.id !== "string") return undefined

  const tokens = tokensFromValue(message.tokens)
  const cost = typeof message.cost === "number" && Number.isFinite(message.cost) ? message.cost : 0
  // All-zero updates (message creation) must not claim the authoritative total,
  // or step-delta accounting would be suppressed with nothing to replace it.
  if (!tokens || (tokens.total === 0 && cost === 0)) return undefined
  state.messageUsage.set(message.id, { cost, tokens })

  let totalCost = 0
  let total = emptyTokens()
  for (const usage of state.messageUsage.values()) {
    totalCost += usage.cost
    total = addTokens(total, usage.tokens)
  }

  const signature = `${totalCost.toFixed(6)}:${total.input}:${total.output}:${total.reasoning}:${total.total}`
  if (signature === state.usageSignature) return undefined
  state.usageSignature = signature

  const variant = typeof message.variant === "string" && message.variant ? `#${message.variant}` : ""
  const model = message.providerID && message.modelID ? `${message.providerID}/${message.modelID}${variant}` : undefined
  const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : undefined
  return { type: "usage", usage: { cost: totalCost, tokens: total, sessionID, model } }
}

function combinedAssistantUsage(infos: AssistantMessage[], sessionID: string): ProgressUsage | undefined {
  if (infos.length === 0) return undefined
  let cost = 0
  let tokens = emptyTokens()
  for (const info of infos) {
    if (typeof info.cost === "number" && Number.isFinite(info.cost)) cost += info.cost
    const messageTokens = tokensFromValue(info.tokens)
    if (!messageTokens) continue
    tokens = addTokens(tokens, messageTokens)
  }
  const last = infos[infos.length - 1]!
  const variant = last.variant ? `#${last.variant}` : ""
  const model = last.providerID && last.modelID ? `${last.providerID}/${last.modelID}${variant}` : undefined
  return { cost, tokens, sessionID, model }
}

function usageFromRecord(values: Record<string, unknown>): ProgressUsage | undefined {
  const cost = typeof values.cost === "number" && Number.isFinite(values.cost) ? values.cost : undefined
  const tokens = tokensFromValue(values.tokens)
  if (cost === undefined && !tokens) return undefined
  return { cost, tokens }
}

function payloadID(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined
  const id = (payload as { id?: unknown }).id
  return typeof id === "string" ? id : undefined
}

function formatUsageForLog(usage: ProgressUsage) {
  const cost = typeof usage.cost === "number" ? `$${usage.cost.toFixed(4)}` : "cost unavailable"
  const tokens = usage.tokens ? `tokens ${usage.tokens.input}/${usage.tokens.output}${usage.tokens.reasoning ? `/${usage.tokens.reasoning}` : ""}` : "tokens unavailable"
  const model = usage.model ? ` model ${usage.model}` : ""
  return `${cost}, ${tokens}${model}`
}

function describeToolCall(properties: Record<string, unknown>) {
  const tool = pickString(properties, ["tool"]) || "tool"
  const input = properties.input && typeof properties.input === "object" ? (properties.input as Record<string, unknown>) : {}
  const target = pickString(input, ["command", "cmd", "filePath", "path", "pattern", "query", "url", "description"])
  return target ? `${tool}: ${target}` : tool
}

function describeToolContent(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return "done"
  const text = value.find((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "text") as { text?: unknown } | undefined
  if (typeof text?.text === "string" && text.text.trim()) return firstLine(text.text)
  const file = value.find((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "file") as { name?: unknown; uri?: unknown } | undefined
  if (typeof file?.name === "string") return file.name
  if (typeof file?.uri === "string") return file.uri
  return "done"
}

function formatEventError(value: unknown) {
  if (!value || typeof value !== "object") return String(value ?? "unknown error")
  const message = (value as { message?: unknown }).message
  if (typeof message === "string") return message
  const data = (value as { data?: unknown }).data
  if (data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string") return (data as { message: string }).message
  return String((value as { name?: unknown; type?: unknown }).name ?? (value as { type?: unknown }).type ?? "unknown error")
}

function pickString(values: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = values[key]
    if (typeof value === "string" && value.length > 0) return truncate(value, 220)
  }
  return ""
}

function firstLine(value: string) {
  return truncate(value.split("\n").find((line) => line.trim()) ?? "done", 220)
}

function truncate(value: string, max: number) {
  const singleLine = value.replace(/\s+/g, " ").trim()
  if (singleLine.length <= max) return singleLine
  return `${singleLine.slice(0, Math.max(0, max - 3))}...`
}

function buildPhasePrompt(workspace: Workspace, phase: AgentStep) {
  return [
    `# Pipeline phase: ${phase.name}`,
    "",
    phase.description,
    "",
    "## Run context",
    `- Run dir: ${workspace.dir}`,
    phase.readOnly
      ? `- Report: Archer saves your report itself as ${phase.reportPath}; you do not (and cannot) write it.`
      : `- Write your final report to: ${join(workspace.dir, phase.reportPath)}`,
    "- Working directory: the directory where `archer` was invoked (root of the target repo).",
    "",
    "## Access mode",
    phase.readOnly
      ? "This phase is read-only: Archer gives you no write, edit, or bash tools, and that is expected — do not try to write any file, and do not apologize for or comment on being unable to. Archer saves your report itself by concatenating the text you emit and storing it verbatim, so your visible output for this phase must be the report and nothing else: no preamble (\"I'll review…\", \"Let me write the report…\"), no step-by-step narration, and no closing note about writing. Keep any planning in your private reasoning; begin your visible output at the report's first line (e.g. the `#` heading)."
      : "This phase may edit the target repository when the phase-specific instructions call for it.",
    "",
    "## Attachments",
    "You will receive as file attachments: project context files when present, the original PRD, previous phase reports, the cumulative diff against the base branch, and any `--file` passed by the user. Read them before acting.",
    "",
    "## Project context",
    "Archer automatically attaches these target-repo files when they exist: `.archer/rules.md`, `AGENTS.md`, and `CLAUDE.md`.",
    "Read them before making changes. `.archer/rules.md` is the project-specific Archer contract unless it conflicts with Archer runtime safety guard rails.",
    "",
    "## Closing",
    "Before finishing, make sure to:",
    phase.readOnly ? "1. Have not modified the target repository." : "1. Have applied necessary changes to the repo code.",
    phase.readOnly
      ? "2. Make the report (markdown, max ~80 lines) your entire visible output — Archer persists it for you. Nothing before or after it."
      : "2. Have written the report (markdown, max ~80 lines) at the absolute path indicated above. If you can't write it, respond with the exact report content and Archer will save it.",
    "3. Leave the tree in a compilable state.",
    "",
    "Follow your system prompt instructions for everything else.",
  ].join("\n")
}

export function parseModel(value: string) {
  const [providerID, ...rest] = value.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) throw new Error(`invalid model: ${value}`)
  return { providerID, modelID }
}

function selectedModel(phase: AgentStep, override: string): ModelSelection {
  if (override) {
    const { model, variant } = splitModelVariant(override)
    return { ...parseModel(model), ...(variant ? { variant } : {}) }
  }
  const model = parseModel(phase.model)
  return phase.variant ? { ...model, variant: phase.variant } : model
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
    throw new Error(`pipeline "${pipeline.name}" needs agent "${step.agentName}", which is not defined (removed from .archer/config.yaml?)`)
  }
}

function progressPhases(pipeline: Pipeline): ProgressPhase[] {
  return pipeline.steps.map((step) =>
    step.type === "agent"
      ? {
          name: step.name,
          description: step.description,
          groupId: step.groupId,
          stepName: step.stepName,
          plannedModel: step.model,
          ...(step.variant ? { plannedVariant: step.variant } : {}),
        }
      : { name: step.name, description: step.description },
  )
}

class LoggedAttemptError extends Error {}

function extractAssistantText(parts: Part[]) {
  return parts
    .filter((part): part is Part & { type: "text"; text: string } => part.type === "text")
    .filter((part) => !("synthetic" in part && part.synthetic) && !("ignored" in part && part.ignored))
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
}

async function summaryFromReport(path: string) {
  try {
    const content = await readFile(path, "utf8")
    for (const raw of content.split("\n")) {
      let line = raw.trim().replace(/^#+\s*/, "")
      if (!line) continue
      if (line.length > 72) line = line.slice(0, 72)
      return line
    }
  } catch {
    return "no summary"
  }
  return "no summary"
}

async function writeAttemptLog(workspace: Workspace, phase: AgentStep, attempt: number, payload: unknown) {
  await writeFile(join(workspace.dir, "logs", `${phase.name}.${attempt}.json`), JSON.stringify(payload, null, 2))
}

async function exists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function formatSdkError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error && "data" in error) {
    const data = (error as { data?: unknown }).data
    if (typeof data === "object" && data && "message" in data) return String((data as { message?: unknown }).message)
  }
  if (typeof error === "object" && error && "name" in error) return String((error as { name?: unknown }).name)
  return String(error)
}
