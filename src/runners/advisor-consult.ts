/**
 * Runner-neutral advisor consultation (change `runner-parity-opencode-v2`,
 * tasks 7.4–7.5, design D8).
 *
 * Two separable pieces:
 *
 *  1. `buildConsultationContext` turns a normalized transcript into a bounded,
 *     normalized snapshot. Core — not a vendor message type — owns the context,
 *     so the same snapshot feeds a Claude or OpenCode advisor.
 *  2. `AdvisorCheckpoint` enforces the mandatory first-write / protected-work
 *     gate. A consultation that succeeds marks the attempt satisfied; a failed
 *     or empty consultation leaves it blocked, and no native auto-approval can
 *     bypass a gate that lives in core.
 *
 * Routing is explicit and runner-qualified (`AdvisorRoute`), independent of the
 * executor, so a Claude executor can consult an OpenCode advisor and vice versa.
 *
 * A harness-native advisor is not parity by name. It is usable only when it
 * preserves this explicit routing, the checkpoint enforcement, the bounded
 * context, the call/output/deadline limits, and the separate attribution; a
 * similarly named option that cannot evidence those does not substitute.
 */

import type { AuthenticationSelection, ModelReference, RunnerId, Usage } from "./contracts"

/** Convoy-owned attempt identity for a consultation. */
export type ConsultAttempt = {
  runId: string
  phase: string
  attempt: number
}

/** The consultation handed to a provider. The executor is recorded for attribution. */
export type ConsultRequest = {
  executor: RunnerId
  /** The question or instruction for the advisor. */
  ask: string
  /** Bounded, normalized snapshot supplied by `buildConsultationContext`. */
  context: string
}

/** One advisor's answer. `runner` is the advisor's runner, not the executor's. */
export type ConsultResult = {
  runner: RunnerId
  text: string
  usage?: Usage
}

/** A runner-agnostic consultation transport (Claude MCP bridge, OpenCode tool, a test fake). */
export type ConsultProvider = (request: ConsultRequest) => Promise<ConsultResult>

export type ConsultationContext = {
  maxBytes: number
}

/** Explicit, frozen advisor routing: runner, model, and authentication are all named. */
export type AdvisorRoute = {
  runner: RunnerId
  model: ModelReference
  auth: AuthenticationSelection
}

// ---------------------------------------------------------------------------
// Bounded consultation context
// ---------------------------------------------------------------------------

/** Reserve bytes for the omission marker so the final string fits `maxBytes`. */
const markerReserveBytes = 120

function omittedMarker(bytes: number): string {
  return `\n\n… [${bytes} bytes of consultation context omitted] …\n\n`
}

/** Decodes UTF-8 bytes `[start, end)` without splitting a multi-byte character. */
function sliceUtf8(buffer: Buffer, start: number, end: number): string {
  let from = Math.max(0, start)
  let to = Math.min(buffer.length, Math.max(from, end))
  while (from < to && ((buffer[from] ?? 0) & 0xc0) === 0x80) from++
  while (to > from && ((buffer[to] ?? 0) & 0xc0) === 0x80) to--
  return buffer.subarray(from, to).toString("utf8")
}

/**
 * Keeps both ends and drops the middle: the task is at the start and the current
 * state at the end, while the middle of a long tool-call run is the most
 * droppable part.
 */
function clampUtf8Middle(text: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return ""
  const buffer = Buffer.from(text, "utf8")
  if (buffer.length <= maxBytes) return text
  const budget = maxBytes - markerReserveBytes
  if (budget <= 0) return sliceUtf8(buffer, 0, maxBytes)

  const headBytes = Math.ceil(budget / 2)
  const tailBytes = budget - headBytes
  const head = sliceUtf8(buffer, 0, headBytes)
  const tail = sliceUtf8(buffer, buffer.length - tailBytes, buffer.length)
  const omitted = buffer.length - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8")
  return `${head}${omittedMarker(omitted)}${tail}`
}

/**
 * Builds the bounded consultation context from normalized transcript fragments.
 * Line endings are normalized and trailing whitespace is stripped so both
 * runners send byte-comparable context. Throws when the transcript contains a
 * non-string entry rather than silently dropping it.
 */
export function buildConsultationContext(input: { transcript: readonly string[]; maxBytes: number }): string {
  const { transcript, maxBytes } = input
  const fragments: string[] = []
  for (const [index, entry] of transcript.entries()) {
    if (typeof entry !== "string") throw new TypeError(`transcript[${index}] must be a string`)
    const normalized = entry.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim()
    if (normalized.length > 0) fragments.push(normalized)
  }
  return clampUtf8Middle(fragments.join("\n\n").trim(), maxBytes)
}

// ---------------------------------------------------------------------------
// Mandatory checkpoint
// ---------------------------------------------------------------------------

/** Thrown when a provider fails or returns no advice; the checkpoint stays blocked. */
export class AdvisorConsultationError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = "AdvisorConsultationError"
  }
}

export type AdvisorCheckpointOptions = {
  /** When true, protected writes stay blocked until a consult succeeds. Defaults to true. */
  requireBeforeWrite?: boolean
  /** Runner recorded as the consultation's executor. */
  executor: RunnerId
  /** The question handed to the advisor; a sensible default is applied when absent. */
  ask?: string
  /** The bounded context, either static or derived per attempt. */
  context?: string | ((attempt: ConsultAttempt) => string)
  now?: () => number
}

export type AdvisorConsultRecord = {
  attempt: ConsultAttempt
  result: ConsultResult
  at: number
}

const defaultConsultAsk = "Before I continue, is this the right next step, and is anything missing or wrong?"

function consultKey(attempt: ConsultAttempt): string {
  return `${attempt.runId}\u0000${attempt.phase}\u0000${attempt.attempt}`
}

/**
 * The protected-work gate. `satisfied()` is the single source of truth the
 * permission boundary consults; a failed provider can never flip it true.
 */
export class AdvisorCheckpoint {
  readonly requireBeforeWrite: boolean
  private readonly executor: RunnerId
  private readonly ask: string
  private readonly context: string | ((attempt: ConsultAttempt) => string)
  private readonly now: () => number
  private readonly satisfiedKeys = new Set<string>()
  private readonly records: AdvisorConsultRecord[] = []

  constructor(options: AdvisorCheckpointOptions) {
    this.requireBeforeWrite = options.requireBeforeWrite ?? true
    this.executor = options.executor
    this.ask = options.ask ?? defaultConsultAsk
    this.context = options.context ?? ""
    this.now = options.now ?? Date.now
  }

  /** True when no consultation is required, or the attempt's consultation succeeded. */
  satisfied(attempt: ConsultAttempt): boolean {
    if (!this.requireBeforeWrite) return true
    return this.satisfiedKeys.has(consultKey(attempt))
  }

  /** True while protected work must not proceed. */
  isBlocked(attempt: ConsultAttempt): boolean {
    return this.requireBeforeWrite && !this.satisfied(attempt)
  }

  /**
   * Runs one consultation. On success the attempt is satisfied; on any provider
   * failure (throw or empty answer) the checkpoint is left exactly as it was —
   * blocked when it was blocked — and an `AdvisorConsultationError` is thrown.
   */
  async consult(attempt: ConsultAttempt, provider: ConsultProvider): Promise<ConsultResult> {
    const request: ConsultRequest = {
      executor: this.executor,
      ask: this.ask,
      context: typeof this.context === "function" ? this.context(attempt) : this.context,
    }

    try {
      const result = await provider(request)
      if (!result || typeof result.text !== "string" || result.text.trim() === "") {
        throw new Error("advisor returned no advice")
      }
      this.satisfiedKeys.add(consultKey(attempt))
      this.records.push({ attempt, result, at: this.now() })
      return result
    } catch (error) {
      // Deliberately do not touch `satisfiedKeys`: a failed consultation neither
      // satisfies a blocked attempt nor revokes an already-satisfied one.
      const message = error instanceof Error ? error.message : String(error)
      throw new AdvisorConsultationError(`advisor consultation failed: ${message}`, error)
    }
  }

  /** Successful consultations, for usage attribution alongside executor usage. */
  history(): readonly AdvisorConsultRecord[] {
    return this.records
  }
}
