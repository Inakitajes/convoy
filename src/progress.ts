import { log } from "./log"
import type { Phase } from "./types"

export type ProgressPhase = Pick<Phase, "name" | "description">

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

export type ProgressUI = {
  start(runID: string, targetDir: string): void
  serverReady(url: string): void
  phaseStarted(name: string, detail?: string): void
  phaseRunning(name: string, detail?: string): void
  phaseSession(name: string, sessionID: string): void
  phaseActivity(name: string, detail: string, kind?: ActivityKind): void
  phaseStepUsage(name: string, usage: ProgressStepUsage): void
  phaseUsageTotal(name: string, usage: ProgressUsage): void
  phaseTodos(name: string, todos: ProgressTodo[]): void
  phaseDiff(name: string, summary: ProgressDiffSummary): void
  phaseCompleted(name: string, detail?: string): void
  phaseSkipped(name: string): void
  phaseFailed(name: string, detail?: string): void
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
  phaseSession() {},
  phaseActivity() {},
  phaseStepUsage() {},
  phaseUsageTotal() {},
  phaseTodos() {},
  phaseDiff() {},
  phaseCompleted() {},
  phaseSkipped() {},
  phaseFailed() {},
  message() {},
  suspend() {},
  resume() {},
  stop() {},
}

export async function createProgressUI(phases: readonly ProgressPhase[], enabled: boolean, onAbort?: () => void): Promise<ProgressUI> {
  if (!enabled || !process.stdout.isTTY) return noopProgress

  try {
    const { createTuiProgress } = await import("./tui")
    const progress = await createTuiProgress(phases, onAbort)
    log.mute(true)
    return progress
  } catch (error) {
    log.mute(false)
    log.warn(`OpenTUI unavailable; falling back to plain logs: ${error instanceof Error ? error.message : String(error)}`)
    return noopProgress
  }
}
