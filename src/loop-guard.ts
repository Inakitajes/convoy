/**
 * Circuit breaker for an OpenCode phase that is going nowhere.
 *
 * OpenCode's own `permission.doom_loop` only inspects the *current* assistant
 * message, so the loop that actually burns money — one identical tool call per
 * turn, the Kimi/GLM pattern — never trips it. When it does fire, it also
 * false-positives on reading a large file in sections. OpenCode's schema
 * only accepts ask/allow/deny for that permission, so Convoy asks and the
 * permission gate allows read/grep/glob/list and still rejects write/bash.
 * Convoy intentionally does not set OpenCode's `agent.steps`: its hardcoded
 * limit can stop tool use before an agent has durably completed its phase.
 *
 * This guard watches the live event stream across turns and aborts the session
 * when a phase repeats itself, fails the same tool over and over, blows a step
 * ceiling, or crosses a dollar cap.
 */

export type LoopGuardConfig = {
  /**
   * Set by resolveLoopGuard and absent from user settings, so a resolved
   * config is not assignable to LoopGuardSettings: feeding one back into
   * resolveLoopGuard (which would re-arm the defaults over `false`) is a
   * compile error, not a silent bug.
   */
  readonly resolved: true
  enabled: boolean
  /** Consecutive calls of the same tool with the same arguments. */
  identicalCalls: number
  /** Consecutive failures of the same tool, even when the arguments drift. */
  sameToolFailures: number
  /** Model round-trips between budget-gate resets. */
  maxSteps: number
  /**
   * USD spent by the executor in one phase attempt. `undefined` means no cost
   * fuse. `false` in user config resolves to `undefined` exactly once, here.
   */
  maxPhaseCost?: number
}

/** What a config file may set; missing keys keep the built-in defaults. */
export type LoopGuardSettings = Partial<{
  enabled: boolean
  identicalCalls: number
  sameToolFailures: number
  maxSteps: number
  /** Number to cap, `false` to disable the cost fuse even when the default is on. */
  maxPhaseCost: number | false
  /**
   * Marks a resolved config so it can't be passed back to resolveLoopGuard.
   * User settings never carry it (validation rejects unknown keys).
   */
  resolved?: false
}>

export const defaultLoopGuard: LoopGuardConfig = {
  resolved: true,
  enabled: true,
  identicalCalls: 4,
  sameToolFailures: 6,
  maxSteps: 200,
  maxPhaseCost: 20,
}

export function resolveLoopGuard(settings?: LoopGuardSettings): LoopGuardConfig {
  return {
    resolved: true,
    enabled: settings?.enabled ?? defaultLoopGuard.enabled,
    identicalCalls: settings?.identicalCalls ?? defaultLoopGuard.identicalCalls,
    sameToolFailures: settings?.sameToolFailures ?? defaultLoopGuard.sameToolFailures,
    maxSteps: settings?.maxSteps ?? defaultLoopGuard.maxSteps,
    maxPhaseCost: resolveCostCap(settings?.maxPhaseCost),
  }
}

function resolveCostCap(value: number | false | undefined): number | undefined {
  if (value === false) return undefined
  if (typeof value === "number") return value
  return defaultLoopGuard.maxPhaseCost
}

/** The model-only soft-nudge threshold before the hard budget gate. */
export function softNudgeSteps(maxSteps: number): number {
  return Math.floor(maxSteps / 2)
}

export type LoopGuardReason = "identical-calls" | "same-tool-failures" | "soft-nudge" | "max-steps" | "max-cost"

export type LoopGuardTrip = {
  reason: LoopGuardReason
  message: string
  count: number
  tool?: string
}

export class LoopGuardError extends Error {
  readonly trip: LoopGuardTrip

  constructor(trip: LoopGuardTrip) {
    super(trip.message)
    this.name = "LoopGuardError"
    this.trip = trip
  }
}

export type LoopGuardObservation =
  | { kind: "call"; name?: string; input?: unknown; callID?: string }
  | { kind: "named"; name: string; callID: string }
  | { kind: "result"; name?: string; failed: boolean; callID?: string }
  | { kind: "step" }
  | { kind: "cost"; messageID: string; cost: number }

export class LoopGuard {
  private identicalSignature = ""
  private identicalCount = 0
  private failedTool = ""
  private failedCount = 0
  private steps = 0
  private readonly messageCosts = new Map<string, number>()
  private totalCost = 0
  /**
   * Tool name for each in-flight callID. OpenCode pins a call id on every tool
   * event but only `input.started` carries the tool name, so the call and its
   * success/failed result must be correlated back through that id. Without this, distinct tools' failures collapse into one
   * synthetic `"tool"` and false-trip the same-tool fuse.
   */
  private readonly callIDToTool = new Map<string, string>()

  constructor(private readonly config: LoopGuardConfig) {}

  /** Reset only the renewable step budget; all other fuses retain their history. */
  resetSteps(): void {
    this.steps = 0
  }

  getSteps(): number {
    return this.steps
  }

  getTotalCost(): number {
    return this.totalCost
  }

  observe(observation: LoopGuardObservation): LoopGuardTrip | undefined {
    if (!this.config.enabled) return undefined
    switch (observation.kind) {
      case "named":
        this.callIDToTool.set(observation.callID, observation.name)
        return undefined
      case "call":
        return this.observeCall(observation.name ?? (observation.callID ? this.callIDToTool.get(observation.callID) : undefined) ?? "tool", observation.input, observation.callID)
      case "result":
        return this.observeResult(observation.name, observation.callID, observation.failed)
      case "step":
        return this.observeStep()
      case "cost":
        return this.observeCost(observation.messageID, observation.cost)
    }
  }

  private observeCall(name: string, input: unknown, callID: string | undefined): LoopGuardTrip | undefined {
    if (callID) this.callIDToTool.set(callID, name)
    const signature = `${name}\0${canonicalInput(input)}`
    if (signature === this.identicalSignature) this.identicalCount++
    else {
      this.identicalSignature = signature
      this.identicalCount = 1
    }
    if (this.identicalCount < this.config.identicalCalls) return undefined
    return trip(
      "identical-calls",
      `${name} called ${this.identicalCount} times in a row with the same arguments${targetHint(name, input)}. The phase was aborted to stop a runaway session.`,
      this.identicalCount,
      name,
    )
  }

  private observeResult(name: string | undefined, callID: string | undefined, failed: boolean): LoopGuardTrip | undefined {
    // Resolve tool identity: an explicit name wins (a direct observation or a
    // called event that carried the tool); otherwise correlate through the
    // callID the SDK pins on every tool event. A result we cannot identify is
    // ignored rather than merged into a synthetic "tool", so unidentified
    // failures from distinct tools can't false-trip the same-tool fuse.
    const tool = this.resolveToolName(name, callID)
    if (!failed) {
      this.failedTool = ""
      this.failedCount = 0
      return undefined
    }
    if (!tool) return undefined
    if (tool === this.failedTool) this.failedCount++
    else {
      this.failedTool = tool
      this.failedCount = 1
    }
    if (this.failedCount < this.config.sameToolFailures) return undefined
    return trip(
      "same-tool-failures",
      `${tool} failed ${this.failedCount} times in a row. The phase was aborted to stop a runaway session.`,
      this.failedCount,
      tool,
    )
  }

  private resolveToolName(name: string | undefined, callID: string | undefined): string | undefined {
    if (name) return name
    if (callID) {
      // Consume the mapping: a call resolves to exactly one terminal result,
      // so dropping it here bounds the map to in-flight calls.
      const mapped = this.callIDToTool.get(callID)
      this.callIDToTool.delete(callID)
      return mapped
    }
    return undefined
  }

  private observeStep(): LoopGuardTrip | undefined {
    this.steps++
    const softSteps = softNudgeSteps(this.config.maxSteps)
    if (this.steps === softSteps) {
      return trip(
        "soft-nudge",
        `phase reached ${this.steps} model steps (soft budget ${softSteps}; hard cap ${this.config.maxSteps}).`,
        this.steps,
      )
    }
    if (this.steps < this.config.maxSteps) return undefined
    return trip(
      "max-steps",
      `phase reached ${this.steps} model steps without finishing (cap ${this.config.maxSteps}). The phase was aborted to stop a runaway session.`,
      this.steps,
    )
  }

  private observeCost(messageID: string, cost: number): LoopGuardTrip | undefined {
    const cap = this.config.maxPhaseCost
    if (cap === undefined || !Number.isFinite(cost) || cost < 0) return undefined
    // Costs arrive per assistant message, refreshed in place as a message
    // streams and again when it completes. Accumulating the per-message delta
    // is what makes the fuse span watchers: the advisor follow-up turn runs
    // through a NEW watcher whose observations restart near zero, so the guard
    // itself must hold the running total or the turn-1 spend is lost.
    const previous = this.messageCosts.get(messageID) ?? 0
    const delta = cost - previous
    if (delta <= 0) return undefined
    this.messageCosts.set(messageID, cost)
    this.totalCost += delta
    if (this.totalCost < cap) return undefined
    return trip(
      "max-cost",
      `phase cost reached $${this.totalCost.toFixed(2)} (cap $${cap}). The phase was aborted to stop a runaway session.`,
      this.totalCost,
    )
  }
}

function trip(reason: LoopGuardReason, message: string, count: number, tool?: string): LoopGuardTrip {
  return { reason, message, count, ...(tool ? { tool } : {}) }
}

/** Stable fingerprint so key order and trivial whitespace don't reset the streak. */
export function canonicalInput(input: unknown): string {
  return JSON.stringify(canonicalize(input))
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "string") return value.trim()
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    )
  }
  return value
}

function targetHint(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const record = input as Record<string, unknown>
  for (const key of ["command", "cmd", "filePath", "path", "pattern", "query", "url"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) {
      const text = value.trim().replace(/\s+/g, " ")
      const clipped = text.length > 80 ? `${text.slice(0, 77)}...` : text
      return ` (${clipped})`
    }
  }
  return ""
}

/**
 * Turns an OpenCode session event into a guard observation. Unknown events are
 * ignored so the watcher can feed the stream through without knowing the shape.
 */
export function observationFromSessionEvent(type: string, properties: Record<string, unknown>): LoopGuardObservation | undefined {
  switch (type) {
    case "session.next.tool.input.started": {
      // V2 names the tool only here; the guard pins it to the call id so the
      // called and result events (which carry only the id) resolve back to it.
      const callID = pickCallID(properties)
      const name = toolName(properties)
      return callID && name ? { kind: "named", name, callID } : undefined
    }
    case "session.next.tool.called": {
      const name = toolName(properties)
      return { kind: "call", ...(name ? { name } : {}), input: properties.input, callID: pickCallID(properties) }
    }
    case "session.next.tool.failed":
      // SDK contract: success/failed carry callID but no tool/name. The guard
      // correlates through callID; a result with no seen callID is ignored
      // rather than merged into a synthetic "tool".
      return { kind: "result", failed: true, callID: pickCallID(properties) }
    case "session.next.tool.success":
      return { kind: "result", failed: false, callID: pickCallID(properties) }
    case "session.next.step.started":
      return { kind: "step" }
    case "message.updated":
      return costFromMessageUpdate(properties)
    default:
      return undefined
  }
}

/**
 * Assistant messages carry the cost of their own generation, refreshed in
 * place as opencode updates them. Feeding the per-message cost (not a
 * watcher-scoped total) lets the guard accumulate exactly across the advisor's
 * follow-up watcher, whose totals restart near zero.
 *
 * V2's `session.usage.updated` (aliased to `message.updated`) instead carries
 * the session's cumulative cost with no message id; keyed per session, the
 * same delta accounting counts it exactly once.
 */
function costFromMessageUpdate(properties: Record<string, unknown>): LoopGuardObservation | undefined {
  if (properties.info === undefined && typeof properties.sessionID === "string" && typeof properties.cost === "number") {
    return { kind: "cost", messageID: `session:${properties.sessionID}`, cost: properties.cost }
  }
  const info = properties.info
  if (!info || typeof info !== "object") return undefined
  const message = info as { role?: unknown; id?: unknown; cost?: unknown }
  if (message.role !== "assistant" || typeof message.id !== "string") return undefined
  const cost = typeof message.cost === "number" && Number.isFinite(message.cost) ? message.cost : 0
  return { kind: "cost", messageID: message.id, cost }
}

function toolName(properties: Record<string, unknown>): string | undefined {
  if (typeof properties.tool === "string" && properties.tool) return properties.tool
  if (typeof properties.name === "string" && properties.name) return properties.name
  return undefined
}

/** The call id OpenCode pins on every tool event (V2 names it `id`); empty for malformed payloads. */
function pickCallID(properties: Record<string, unknown>): string | undefined {
  const value = properties.callID ?? properties.id
  return typeof value === "string" && value ? value : undefined
}
