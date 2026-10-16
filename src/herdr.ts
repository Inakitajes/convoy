import type { RunStatus } from "./progress"
import { log } from "./log"
import { cleanText, truncateText } from "./run-status"

/**
 * Herdr sidebar agent reporting. When Convoy runs inside a Herdr pane
 * (`HERDR_ENV=1` + `HERDR_PANE_ID`), the reporter claims the pane as the
 * "convoy" agent and publishes the live pipeline state through Herdr's CLI:
 *
 *   herdr pane report-agent    lifecycle state (working / blocked / idle)
 *   herdr pane report-metadata display tokens ($pipeline, $progress, …)
 *   herdr pane release-agent   hand the lifecycle authority back
 *
 * Everything here is best effort, mirroring the Notifier's contract: a missing
 * binary, a dead socket, or a rejected command must never fail a run. Outside
 * Herdr the reporter is a silent no-op (no spawn, no thrown errors).
 */

export const HERDR_SOURCE = "custom:convoy"
export const HERDR_AGENT = "convoy"
export const HERDR_DISPLAY_AGENT = "Convoy"

/** Herdr caps display text at 80 chars; longer tokens are truncated identically. */
const maxTokenLength = 80

/** A stalled herdr CLI is best effort, not permission to hold a run open. */
const stopDrainMs = 250

/** One local CLI cleanup attempt must not be able to stall process teardown. */
const cleanupAttemptMs = 250

/** Retry transient socket/process failures without making a run depend on Herdr. */
const cleanupAttempts = 3

/** Metadata should eventually disappear even after an uncatchable hard crash. */
export const HERDR_METADATA_TTL_MS = 86_400_000

/** Refresh well before expiry without turning unchanged UI events into churn. */
const metadataHeartbeatMs = HERDR_METADATA_TTL_MS / 2

export const HERDR_TOKEN_NAMES = ["pipeline", "progress", "step", "summary", "run_id"] as const

// ---------------------------------------------------------------------------
// Pure contract
// ---------------------------------------------------------------------------

/**
 * Whether this process is a live Herdr pane Convoy may claim. Enablement is
 * env-only: the binary may be missing from Convoy's own PATH and the pane id
 * is still valid.
 */
export function herdrEnabled(env: Record<string, string | undefined>): boolean {
  return env.HERDR_ENV === "1" && Boolean(env.HERDR_PANE_ID)
}

export type HerdrState = "idle" | "working" | "blocked" | "unknown"

export type HerdrMappedState = {
  state: HerdrState
  /** Shown under the state icon; carries the wait reason for `blocked`. */
  message?: string
  /** Overrides Herdr's default label for `state` (used for Convoy's pause). */
  stateLabel?: string
}

/**
 * Maps Convoy's four run activities onto Herdr's lifecycle states:
 *   working→working; waiting→blocked (wait reason as message); paused→idle
 *   labelled "paused"; stopped+completed→idle; stopped+failed→blocked.
 */
export function mapHerdrState(status: RunStatus): HerdrMappedState {
  switch (status.activity) {
    case "working":
      return { state: "working" }
    case "waiting": {
      const message = status.waitReason ? cleanText(status.waitReason) : ""
      return { state: "blocked", ...(message ? { message } : {}) }
    }
    case "paused":
      return { state: "idle", stateLabel: "paused" }
    case "stopped":
      return status.outcome === "failed" ? { state: "blocked" } : { state: "idle" }
  }
}

export type HerdrTokens = {
  pipeline?: string
  progress?: string
  step?: string
  summary?: string
  run_id?: string
}

/**
 * The display tokens Herdr's sidebar can interpolate. `progress` counts batches
 * (a `parallel:` / `models:` fan-out is one), `step` is the logical label the
 * tracker derives, and `run_id` is the Convoy run id — never an OpenCode
 * session id.
 */
export function herdrTokens(status: RunStatus, runID?: string): HerdrTokens {
  const pipeline = truncateText(cleanText(status.identity.pipeline), maxTokenLength)
  const progress = status.totalSteps > 0 ? `${status.step}/${status.totalSteps}` : ""
  const step = status.stepLabel ? truncateText(cleanText(status.stepLabel), maxTokenLength) : undefined
  const summary = truncateText(cleanText([pipeline, progress && step ? `${progress} ${step}` : progress].filter(Boolean).join(" · ")), maxTokenLength)
  return {
    ...(pipeline ? { pipeline } : {}),
    ...(progress ? { progress } : {}),
    ...(step ? { step } : {}),
    ...(summary ? { summary } : {}),
    ...(runID ? { run_id: runID } : {}),
  }
}

export type HerdrReportAgentArgs = {
  state: HerdrState
  message?: string
  seq: number
}

export function reportAgentArgv(bin: string, paneId: string, args: HerdrReportAgentArgs): string[] {
  return [
    bin, "pane", "report-agent", paneId,
    "--source", HERDR_SOURCE,
    "--agent", HERDR_AGENT,
    "--state", args.state,
    ...(args.message ? ["--message", args.message] : []),
    "--seq", String(args.seq),
  ]
}

export type HerdrReportMetadataArgs = {
  seq: number
  displayAgent?: string
  /** Pre-formatted `STATE=LABEL` pair, present only for a custom label (paused). */
  stateLabel?: string
  tokens: HerdrTokens
}

export function reportMetadataArgv(bin: string, paneId: string, args: HerdrReportMetadataArgs): string[] {
  return [
    bin, "pane", "report-metadata", paneId,
    "--source", HERDR_SOURCE,
    "--agent", HERDR_AGENT,
    ...(args.displayAgent ? ["--display-agent", args.displayAgent] : []),
    ...(args.stateLabel ? ["--state-label", args.stateLabel] : []),
    ...Object.entries(args.tokens).flatMap(([name, value]) => ["--token", `${name}=${value}`]),
    "--seq", String(args.seq),
    "--ttl-ms", String(HERDR_METADATA_TTL_MS),
  ]
}

/** Clears every presentation field and token Convoy owns before lifecycle release. */
export function clearMetadataArgv(bin: string, paneId: string, seq: number): string[] {
  return [
    bin, "pane", "report-metadata", paneId,
    "--source", HERDR_SOURCE,
    "--clear-display-agent",
    "--clear-state-labels",
    ...HERDR_TOKEN_NAMES.flatMap((name) => ["--clear-token", name]),
    "--seq", String(seq),
  ]
}

export function releaseAgentArgv(bin: string, paneId: string, seq: number): string[] {
  return [
    bin, "pane", "release-agent", paneId,
    "--source", HERDR_SOURCE,
    "--agent", HERDR_AGENT,
    "--seq", String(seq),
  ]
}

/**
 * A copy of `env` with every `HERDR_*` key removed. Applied when spawning the
 * OpenCode server child so a global `herdr integration install opencode`
 * plugin cannot claim the pane as an `opencode` agent.
 */
export function withoutHerdrEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const filtered: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("HERDR_")) filtered[key] = value
  }
  return filtered
}

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

export type HerdrProcess = {
  exited: Promise<number>
  kill?(signal?: NodeJS.Signals): void
  unref?(): void
}
export type HerdrSpawn = (command: string[]) => HerdrProcess

export type HerdrReporterOptions = {
  env?: Record<string, string | undefined>
  spawn?: HerdrSpawn
  now?: () => number
  runID?: string
  cleanupAttemptMs?: number
  cleanupAttempts?: number
  metadataHeartbeatMs?: number
  warn?: (message: string) => void
}

/**
 * Best-effort lifecycle authority for the Herdr sidebar. Live reports remain
 * fire-and-forget; `stop()` drains them and observes bounded cleanup before it
 * resolves. A run constructs one, feeds it statuses through the
 * RunStatusTracker's `herdr` sink, and calls `stop()` from its finally block so
 * `release-agent` is the last command for the source.
 */
export class HerdrReporter {
  private readonly env: Record<string, string | undefined>
  private readonly spawn: HerdrSpawn
  private readonly now: () => number
  private readonly runID?: string
  private readonly cleanupAttemptMs: number
  private readonly cleanupAttempts: number
  private readonly metadataHeartbeatMs: number
  private readonly warn: (message: string) => void
  private readonly bin: string
  private readonly paneId: string
  private seq: number
  private lastKey?: string
  private released = false
  private stopped = false
  private stopPromise?: Promise<void>
  private forceReleasePromise?: Promise<void>
  private metadataHeartbeat?: ReturnType<typeof setTimeout>
  private lastMetadata?: HerdrReportMetadataArgs
  private readonly children = new Map<HerdrProcess, Promise<number>>()

  constructor(options: HerdrReporterOptions = {}) {
    this.env = options.env ?? process.env
    this.spawn = options.spawn ?? ((command) => Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }))
    this.now = options.now ?? (() => Date.now())
    this.runID = options.runID
    this.cleanupAttemptMs = Math.max(1, Math.trunc(options.cleanupAttemptMs ?? cleanupAttemptMs))
    this.cleanupAttempts = Math.max(1, Math.trunc(options.cleanupAttempts ?? cleanupAttempts))
    this.metadataHeartbeatMs = Math.max(1, Math.trunc(options.metadataHeartbeatMs ?? metadataHeartbeatMs))
    this.warn = options.warn ?? ((message) => log.warn(message))
    this.bin = this.env.HERDR_BIN_PATH?.trim() || "herdr"
    this.paneId = this.env.HERDR_PANE_ID ?? ""
    // Seed from the clock so a successor instance (a new coordinator for the
    // same pane) can never go backwards relative to this one's reports.
    this.seq = this.now() * 1000
  }

  get available(): boolean {
    return herdrEnabled(this.env)
  }

  /**
   * Publishes the current status to Herdr. Returns true when a spawn was
   * queued. No-op (and false) when disabled, after `release()`, after
   * `stop()`, or when the status is identical to the last one sent.
   */
  report(status: RunStatus): boolean {
    if (!this.available || this.released || this.stopped) return false
    const mapped = mapHerdrState(status)
    const tokens = herdrTokens(status, this.runID)
    const key = JSON.stringify({ state: mapped, tokens })
    if (key === this.lastKey) return false
    this.lastKey = key
    this.dispatch(reportAgentArgv(this.bin, this.paneId, { state: mapped.state, message: mapped.message, seq: this.nextSeq() }))
    this.lastMetadata = {
      seq: this.nextSeq(),
      displayAgent: HERDR_DISPLAY_AGENT,
      stateLabel: mapped.stateLabel ? `${mapped.state}=${mapped.stateLabel}` : undefined,
      tokens,
    }
    this.dispatch(reportMetadataArgv(this.bin, this.paneId, this.lastMetadata))
    this.armMetadataHeartbeat()
    return true
  }

  /**
   * Starts the same observed cleanup as `stop()`. Kept synchronous for callers
   * that only need to schedule release; `stop()` awaits this shared work.
   */
  release(): boolean {
    if (!this.available || this.released || this.stopped) return false
    this.released = true
    this.stopped = true
    this.clearMetadataHeartbeat()
    this.stopPromise = this.stopImpl()
    return true
  }

  /**
   * Starts lifecycle release immediately, bypassing report draining and
   * metadata cleanup. The forced-shutdown observation window is only one
   * second; normal `stop()` still performs and awaits the complete cleanup.
   */
  forceRelease(): Promise<void> {
    this.stopped = true
    this.released = true
    this.clearMetadataHeartbeat()
    if (!this.available) return Promise.resolve()
    if (!this.forceReleasePromise) {
      this.forceReleasePromise = this.retryCleanup(
        "force-release the Convoy Herdr agent",
        () => releaseAgentArgv(this.bin, this.paneId, this.nextSeq()),
      )
    }
    return this.forceReleasePromise
  }

  /**
   * Drains in-flight commands so the release lands after the final report,
   * then releases if the runner never did. Idempotent. A wedged `herdr` child
   * is killed after `stopDrainMs` so teardown cannot hang the run.
   */
  stop(): Promise<void> {
    if (!this.stopPromise) {
      this.stopped = true
      this.released = true
      this.clearMetadataHeartbeat()
      this.stopPromise = this.stopImpl()
    }
    return this.stopPromise
  }

  private async stopImpl(): Promise<void> {
    if (!this.available) return
    const children = [...this.children]
    await Promise.all(children.map(([, exited]) => this.drain(exited)))
    for (const [child] of children) this.kill(child)
    await this.retryCleanup(
      "clear Convoy metadata from the Herdr pane",
      () => clearMetadataArgv(this.bin, this.paneId, this.nextSeq()),
    )
    await this.retryCleanup(
      "release the Convoy Herdr agent",
      () => releaseAgentArgv(this.bin, this.paneId, this.nextSeq()),
    )
  }

  /** Strictly increasing per source; each outgoing request consumes one. */
  private nextSeq(): number {
    this.seq = Math.max(this.seq + 1, this.now() * 1000)
    return this.seq
  }

  private dispatch(command: string[]) {
    try {
      const child = this.spawn(command)
      child.unref?.()
      const exited = Promise.resolve(child.exited).catch(() => -1)
      const tracked = exited.finally(() => this.children.delete(child))
      this.children.set(child, tracked)
    } catch {
      // Best effort, same contract as the Notifier: a missing binary or a dead
      // socket must never fail a run.
    }
  }

  private async retryCleanup(label: string, command: () => string[]): Promise<void> {
    let reason = "unknown failure"
    for (let attempt = 1; attempt <= this.cleanupAttempts; attempt++) {
      const result = await this.runCleanupCommand(command())
      if (result.ok) return
      reason = result.reason
    }
    try {
      this.warn(`couldn't ${label} after ${this.cleanupAttempts} attempts: ${reason}`)
    } catch {
      // Diagnostics are best effort too; an injected logger cannot fail a run.
    }
  }

  private async runCleanupCommand(command: string[]): Promise<{ ok: true } | { ok: false; reason: string }> {
    let child: HerdrProcess
    try {
      // Unlike live status reports, cleanup children remain referenced and are
      // observed: process teardown must not outrun the release command.
      child = this.spawn(command)
    } catch (error) {
      return { ok: false, reason: `spawn failed (${error instanceof Error ? error.message : String(error)})` }
    }

    let timeout: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([
      Promise.resolve(child.exited).then(
        (code) => ({ type: "exit" as const, code }),
        (error) => ({ type: "error" as const, error }),
      ),
      new Promise<{ type: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ type: "timeout" }), this.cleanupAttemptMs)
      }),
    ])
    if (timeout) clearTimeout(timeout)

    if (result.type === "exit") {
      return result.code === 0 ? { ok: true } : { ok: false, reason: `exit ${result.code}` }
    }
    if (result.type === "error") {
      this.kill(child, "SIGKILL")
      child.unref?.()
      return { ok: false, reason: `wait failed (${result.error instanceof Error ? result.error.message : String(result.error)})` }
    }
    this.kill(child, "SIGKILL")
    child.unref?.()
    return { ok: false, reason: `timed out after ${this.cleanupAttemptMs}ms` }
  }

  private kill(child: HerdrProcess, signal?: NodeJS.Signals) {
    try {
      child.kill?.(signal)
    } catch {
      // The child may have exited between tracking and teardown.
    }
  }

  private async drain(exited: Promise<number>) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, stopDrainMs)
      void exited.then(() => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }

  private armMetadataHeartbeat() {
    this.clearMetadataHeartbeat()
    this.metadataHeartbeat = setTimeout(() => {
      this.metadataHeartbeat = undefined
      if (this.stopped || !this.lastMetadata) return
      this.lastMetadata = { ...this.lastMetadata, seq: this.nextSeq() }
      this.dispatch(reportMetadataArgv(this.bin, this.paneId, this.lastMetadata))
      this.armMetadataHeartbeat()
    }, this.metadataHeartbeatMs)
    this.metadataHeartbeat.unref?.()
  }

  private clearMetadataHeartbeat() {
    if (!this.metadataHeartbeat) return
    clearTimeout(this.metadataHeartbeat)
    this.metadataHeartbeat = undefined
  }
}
