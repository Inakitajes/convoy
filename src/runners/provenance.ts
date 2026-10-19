/**
 * Versioned runner provenance (change `runner-parity-opencode-v2`, design D11).
 *
 * Persists, per attempt, who ran it (runner), how it was authenticated, which
 * model and native session it used, and its identity — without secrets. A
 * compatibility reader keeps legacy records readable and never guesses a runner
 * for an unqualified session id or reinterprets the historical coordinator PID.
 */

import { isRegisteredRunnerId } from "./descriptors"
import type { AuthenticationMode, RunnerId, RunnerSessionRef } from "./contracts"

export const runnerExecutionVersion = 1

export type RunnerExecutionRecord = {
  version: typeof runnerExecutionVersion
  runner: RunnerId
  /** Claude's reviewed authentication; OpenCode authenticates with its own provider credentials. */
  auth?: { mode: AuthenticationMode; credentialRef?: string }
  /** The verified checkout the attempt ran in. */
  checkout?: string
  model?: { modelId: string; variant?: string }
  session?: { sessionId: string }
  attempt?: { runId: string; phase: string; attempt: number }
  /** Harness/protocol version the attempt ran against, when known. */
  protocolVersion?: string
}

export function runnerExecutionRecord(input: {
  runner: RunnerId
  auth?: { mode: AuthenticationMode; credentialRef?: string }
  checkout?: string
  model?: { modelId: string; variant?: string }
  sessionId?: string
  attempt?: { runId: string; phase: string; attempt: number }
  protocolVersion?: string
}): RunnerExecutionRecord {
  return {
    version: runnerExecutionVersion,
    runner: input.runner,
    ...(input.auth ? { auth: { mode: input.auth.mode, ...(input.auth.credentialRef ? { credentialRef: input.auth.credentialRef } : {}) } } : {}),
    ...(input.checkout ? { checkout: input.checkout } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.sessionId ? { session: { sessionId: input.sessionId } } : {}),
    ...(input.attempt ? { attempt: input.attempt } : {}),
    ...(input.protocolVersion ? { protocolVersion: input.protocolVersion } : {}),
  }
}

function isRunnerId(value: unknown): value is RunnerId {
  return isRegisteredRunnerId(value)
}

function isAuthMode(value: unknown): value is AuthenticationMode {
  return value === "subscription" || value === "api-key"
}

/** Structural validation of a persisted v1 record. */
export function isRunnerExecutionRecord(value: unknown): value is RunnerExecutionRecord {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return record.version === runnerExecutionVersion && isRunnerId(record.runner) && (record.auth === undefined || isAuthObject(record.auth))
}

function isAuthObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  return isAuthMode((value as Record<string, unknown>).mode)
}

/** The old shapes found on pre-migration records, preserved without reinterpretation. */
export type LegacyPhaseExecution = {
  kind: "legacy"
  /** A bare session id with no runner qualification. */
  sessionId?: string
  /**
   * The legacy live-server block. `pid` keeps its historical meaning (the
   * coordinator/owner anchor); `childPid` is the explicit child when present.
   */
  server?: { url: string; pid: number; childPid?: number }
}

export type PhaseExecutionRead = { kind: "record"; record: RunnerExecutionRecord } | LegacyPhaseExecution | { kind: "none" }

/**
 * Reads a phase's execution provenance from a persisted entry. A v1 record wins
 * (whether passed directly or under a phase entry's `execution` field);
 * otherwise the legacy shape is reported as legacy (never silently upgraded to a
 * runner), and anything else is `none`.
 */
export function readPhaseExecution(value: unknown): PhaseExecutionRead {
  if (isRunnerExecutionRecord(value)) return { kind: "record", record: value }
  if (typeof value !== "object" || value === null) return { kind: "none" }
  const entry = value as Record<string, unknown>

  if (isRunnerExecutionRecord(entry.execution)) return { kind: "record", record: entry.execution }

  const sessionId = typeof entry.sessionID === "string" ? entry.sessionID : undefined
  const server = readLegacyServer(entry.server)
  if (sessionId === undefined && server === undefined) return { kind: "none" }
  return { kind: "legacy", ...(sessionId !== undefined ? { sessionId } : {}), ...(server ? { server } : {}) }
}

function readLegacyServer(value: unknown): LegacyPhaseExecution["server"] {
  if (typeof value !== "object" || value === null) return undefined
  const server = value as Record<string, unknown>
  if (typeof server.url !== "string" || typeof server.pid !== "number") return undefined
  return {
    url: server.url,
    pid: server.pid,
    ...(typeof server.childPid === "number" ? { childPid: server.childPid } : {}),
  }
}

/** A runner-qualified session, only when the read produced a v1 record. */
export function runnerQualifiedSession(read: PhaseExecutionRead): RunnerSessionRef | undefined {
  if (read.kind !== "record" || !read.record.session) return undefined
  return { runner: read.record.runner, sessionId: read.record.session.sessionId }
}
