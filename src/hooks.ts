import { join } from "node:path"

import { log } from "./log"

import type { ProgressUI } from "./progress"
import type { HookSet, HookSpec, HookWhen, HooksConfig } from "./types"
import type { Workspace } from "./workspace"

export type HookStage = "pre" | "post"
export type HookRunStatus = "success" | "failure"

export type RunHookContext = {
  workspace: Workspace
  targetDir: string
  pipelineName: string
  prompt: string
  status?: HookRunStatus
  progress: ProgressUI
  signal?: AbortSignal
}

type HookCommandResult = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export function hooksForPipeline(config: HooksConfig, pipelineName: string): HookSet {
  const pipeline = config.pipelines[pipelineName]
  return {
    pre: [...config.pre, ...(pipeline?.pre ?? [])],
    post: [...config.post, ...(pipeline?.post ?? [])],
  }
}

export async function runHooks(stage: HookStage, hooks: readonly HookSpec[], context: RunHookContext): Promise<void> {
  if (hooks.length === 0) return
  const names = hookPhaseNames(stage, hooks)
  const status = context.status ?? "success"
  const selected = hooks.filter((hook) => stage === "pre" || shouldRunPostHook(hook, status))

  if (selected.length > 0) {
    const noun = `${stage}-hook${selected.length === 1 ? "" : "s"}`
    context.progress.message(`running ${selected.length} ${noun}`)
    log.section(`archer ${noun}`)
  }

  // Every hook has a dashboard phase (added by progressPhases), so each one is
  // marked started/completed/failed/skipped there rather than only logged.
  let ran = 0
  for (const [index, hook] of hooks.entries()) {
    const phase = names[index]!
    const label = hookLabel(hook)
    if (stage === "post" && !shouldRunPostHook(hook, status)) {
      context.progress.phaseSkipped(phase)
      log.info(`[${stage}-hook:${label}] skipped (when: ${hook.when ?? "success"}, run ${status})`)
      continue
    }

    throwIfAborted(context.signal)
    ran++
    context.progress.phaseStarted(phase, hook.command)
    context.progress.message(`${stage}-hook ${ran}/${selected.length}: ${label}`)
    log.info(`[${stage}-hook:${label}] ${hook.command}`)

    const result = await runHookCommand(stage, hook, context)
    logHookOutput(stage, label, result)
    surfaceHookOutput(context.progress, phase, result)

    if (result.exitCode === 0 && !result.timedOut) {
      context.progress.phaseCompleted(phase, "exit 0")
      context.progress.message(`${stage}-hook completed: ${label}`)
      continue
    }

    const reason = result.timedOut
      ? `timed out after ${hook.timeoutSeconds}s`
      : `exited with code ${result.exitCode}`
    const message = `${stage}-hook "${label}" ${reason}`
    context.progress.phaseFailed(phase, reason)
    if (hook.continueOnError) {
      log.warn(`${message}; continuing because continueOnError is true`)
      context.progress.message(`${message}; continuing`)
      continue
    }
    throw new Error(message)
  }
}

/**
 * Dashboard phase names for a stage's hooks, in execution order. Shared by the
 * TUI phase list and the runner so both resolve the same rows; an index suffix
 * disambiguates hooks that share a label.
 */
export function hookPhaseNames(stage: HookStage, hooks: readonly HookSpec[]): string[] {
  const names: string[] = []
  for (const [index, hook] of hooks.entries()) {
    const base = `${stage}-hook: ${hookLabel(hook).replace(/\s+/g, " ").trim().slice(0, 48)}`
    names.push(names.includes(base) ? `${base} (${index + 1})` : base)
  }
  return names
}

// The tail of the hook's output lands in its phase feed, so the dashboard's
// logs tab shows what the command did without leaving the run.
const hookFeedLines = 20

function surfaceHookOutput(progress: ProgressUI, phase: string, result: HookCommandResult) {
  const emit = (text: string, kind: "info" | "error") => {
    const lines = text.split("\n").map((line) => line.trimEnd()).filter(Boolean)
    for (const line of lines.slice(-hookFeedLines)) progress.phaseActivity(phase, line, kind)
  }
  emit(result.stdout, "info")
  emit(result.stderr, "error")
}

function shouldRunPostHook(hook: HookSpec, status: HookRunStatus): boolean {
  const when: HookWhen = hook.when ?? "success"
  return when === "always" || when === status
}

function hookLabel(hook: HookSpec): string {
  return hook.name ?? hook.command
}

async function runHookCommand(stage: HookStage, hook: HookSpec, context: RunHookContext): Promise<HookCommandResult> {
  const shell = process.env.SHELL || "/bin/sh"
  const cwd = hook.cwd === "run" ? context.workspace.dir : context.targetDir
  const env = {
    ...process.env,
    ARCHER_HOOK_STAGE: stage,
    ARCHER_HOOK_NAME: hook.name ?? "",
    ARCHER_PIPELINE: context.pipelineName,
    ARCHER_RUN_ID: context.workspace.runID,
    ARCHER_RUN_DIR: context.workspace.dir,
    ARCHER_TARGET_DIR: context.targetDir,
    ARCHER_PROMPT_FILE: join(context.workspace.dir, "prd.md"),
    ...(context.status ? { ARCHER_RUN_STATUS: context.status } : {}),
  }

  const proc = Bun.spawn([shell, "-lc", hook.command], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })

  let timedOut = false
  let abortKillTimer: ReturnType<typeof setTimeout> | undefined
  const kill = (signal: NodeJS.Signals = "SIGTERM") => {
    try {
      proc.kill(signal)
    } catch {
      // Process may already have exited.
    }
  }

  const abort = () => {
    kill()
    abortKillTimer = setTimeout(() => kill("SIGKILL"), 2_000)
    abortKillTimer.unref?.()
  }
  context.signal?.addEventListener("abort", abort, { once: true })

  let timeout: ReturnType<typeof setTimeout> | undefined
  if (hook.timeoutSeconds !== undefined) {
    timeout = setTimeout(() => {
      timedOut = true
      kill()
      abortKillTimer = setTimeout(() => kill("SIGKILL"), 2_000)
      abortKillTimer.unref?.()
    }, hook.timeoutSeconds * 1_000)
    timeout.unref?.()
  }

  try {
    const stdoutPromise = new Response(proc.stdout).text()
    const stderrPromise = new Response(proc.stderr).text()
    const exitCode = await proc.exited
    const outputBudgetMs = timedOut || context.signal?.aborted ? 100 : undefined
    const [stdout, stderr] = await Promise.all([readOutput(stdoutPromise, outputBudgetMs), readOutput(stderrPromise, outputBudgetMs)])
    throwIfAborted(context.signal)
    return { stdout, stderr, exitCode, timedOut }
  } finally {
    if (timeout) clearTimeout(timeout)
    if (abortKillTimer) clearTimeout(abortKillTimer)
    context.signal?.removeEventListener("abort", abort)
  }
}

async function readOutput(promise: Promise<string>, timeoutMs: number | undefined): Promise<string> {
  if (timeoutMs === undefined) return promise
  return Promise.race([
    promise,
    new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve(""), timeoutMs)
      timer.unref?.()
    }),
  ])
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error("aborted")
}

function logHookOutput(stage: HookStage, label: string, result: HookCommandResult) {
  for (const line of result.stdout.trimEnd().split("\n").filter(Boolean)) log.info(`[${stage}-hook:${label}] ${line}`)
  for (const line of result.stderr.trimEnd().split("\n").filter(Boolean)) log.warn(`[${stage}-hook:${label}] ${line}`)
}
