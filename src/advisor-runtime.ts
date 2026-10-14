import type { OpencodeClient } from "./opencode-client"

import {
  advisorFallbackText,
  advisorSelectionFor,
  consultAdvisor,
  defaultAdvisorMaxCalls,
  type AdvisorReason,
  type AdvisorResult,
  type AdvisorUsage,
} from "./advisor"
import { log } from "./log"
import {
  auditText,
  type AdvisorAuditPolicy,
  type AdvisorEvent,
  type AdvisorFeedbackOutcome,
} from "./advisor-events"
import type { AdvisorCheckpoint, AdvisorGateDecision } from "./permissions"
import type { AgentStep } from "./types"

/**
 * Per-run advisor policy: which phase owns which live session, how many
 * consultations each attempt has left, and what the permission gate should do
 * with a phase's first write.
 *
 * The registry exists because the two places that trigger a consultation — the
 * permission gate and the session watcher — only know a sessionID, while the
 * advising model, the budget, and the usage tally belong to a phase attempt.
 */

export type AdvisorConsultation = { callId: string; reason: AdvisorReason; result: AdvisorResult }

/**
 * `text` is always safe to hand the executor — degradation guidance when the
 * consultation failed. `ok` distinguishes the two, because a caller that would
 * spend a turn delivering the advice should not spend it on "no advice".
 */
export type AdvisorAdvice = { text: string; ok: boolean; callId?: string }

export type AdvisorPhaseHandle = {
  /** Consultations attempted by this phase attempt, successful or not. */
  readonly calls: number
  /** Usage of the successful ones, for the attempt log's executor/advisor split. */
  readonly usage: readonly AdvisorUsage[]
  /** Structured records emitted during this attempt, including failures and exhaustion. */
  readonly events: readonly AdvisorEvent[]
  consult(reason: AdvisorReason, question?: string): Promise<AdvisorAdvice>
  delivered(callId: string | undefined, delivery: "permission" | "tool" | "follow-up"): Promise<void>
  feedback(callId: string | undefined, outcome: AdvisorFeedbackOutcome, note?: string): Promise<boolean>
  end(): void
}

export type AdvisorRuntimeOptions = {
  client: OpencodeClient
  directory: string
  signal?: AbortSignal
  /** Injected in tests; defaults to the real consultation. */
  consult?: typeof consultAdvisor
  auditPolicy?: AdvisorAuditPolicy
  /** Called synchronously with runtime ordering; persistence failures must be handled by the sink. */
  onEvent?: (event: AdvisorEvent) => void | Promise<void>
}

export type AdvisorRuntime = {
  /** Registers a phase attempt's live session. Returns undefined for steps with no advisor. */
  begin(sessionID: string, step: AgentStep, attempt?: number): AdvisorPhaseHandle | undefined
  /** Wired into the permission gate for the first-write checkpoint. */
  checkpoint: AdvisorCheckpoint
  /** Looks up a live phase by session, for the completion checkpoint and the on-demand tool. */
  handleFor(sessionID: string): AdvisorPhaseHandle | undefined
}

export function createAdvisorRuntime(options: AdvisorRuntimeOptions): AdvisorRuntime {
  const consultFn = options.consult ?? consultAdvisor
  const phases = new Map<string, PhaseState>()

  type PhaseState = {
    step: AgentStep
    calls: number
    usage: AdvisorUsage[]
    events: AdvisorEvent[]
    attempt: number
    latestCallId?: string
  }

  const handleOf = (sessionID: string, state: PhaseState): AdvisorPhaseHandle => ({
    get calls() {
      return state.calls
    },
    get usage() {
      return state.usage
    },
    get events() {
      return state.events
    },
    consult: (reason, question) => consultFor(sessionID, state, reason, question),
    delivered: (callId, delivery) => deliver(state, callId, delivery),
    feedback: (callId, outcome, note) => feedback(state, callId, outcome, note),
    end: () => {
      phases.delete(sessionID)
    },
  })

  async function consultFor(sessionID: string, state: PhaseState, reason: AdvisorReason, question?: string): Promise<AdvisorAdvice> {
    const model = advisorSelectionFor(state.step)
    if (!model) {
      return degraded({ kind: "error", code: "unavailable", message: "no advisor configured for this phase" })
    }

    const budget = state.step.advisorMaxCalls ?? defaultAdvisorMaxCalls
    if (state.calls >= budget) {
      log.info(`[advisor] ${state.step.name} exhausted its budget of ${budget} consultations`)
      const callId = crypto.randomUUID()
      await emit(state, {
        ...baseEvent(state, reason, callId, budget),
        type: "advisor.budget_exhausted",
      })
      return degraded({ kind: "error", code: "max_uses_exceeded", message: `budget of ${budget} reached` })
    }

    // Counted before the call, not after: a failing advisor must not be retried
    // on every edit, and the budget is a cost ceiling, not a success quota.
    state.calls += 1
    const callId = crypto.randomUUID()
    state.latestCallId = callId
    const modelName = `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}`
    await emit(state, {
      ...baseEvent(state, reason, callId, budget),
      type: "advisor.requested",
      model: modelName,
      ...auditText(question, options.auditPolicy ?? "summary", "question"),
    })
    const startedAt = performance.now()
    let transcript: string | undefined
    const result = await consultFn({
      client: options.client,
      sessionID,
      directory: options.directory,
      model,
      reason,
      ...(question ? { question } : {}),
      onTranscript: (value) => {
        transcript = value
      },
      ...(options.signal ? { signal: options.signal } : {}),
    })

    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt))
    if (result.kind === "error") {
      await emit(state, {
        ...baseEvent(state, reason, callId, budget),
        type: "advisor.failed",
        model: modelName,
        latencyMs,
        ...auditText(transcript, options.auditPolicy ?? "summary", "transcript"),
        error: { code: result.code, ...auditText(result.message.slice(0, 4_000), options.auditPolicy ?? "summary", "message") },
      })
      return { ...degraded(result), callId }
    }
    if (result.usage) state.usage.push(result.usage)
    await emit(state, {
      ...baseEvent(state, reason, callId, budget),
      type: "advisor.completed",
      model: result.usage?.model ?? modelName,
      latencyMs,
      ...(result.usage ? { usage: result.usage } : {}),
      adviceChars: result.text.length,
      ...auditText(result.text, options.auditPolicy ?? "summary", "advice"),
      ...auditText(transcript, options.auditPolicy ?? "summary", "transcript"),
    })
    log.info(`[advisor] ${state.step.name} consulted ${model.providerID}/${model.modelID} (${reason}), ${result.text.length} chars`)
    return { text: result.text, ok: true, callId }
  }

  async function deliver(state: PhaseState, callId: string | undefined, delivery: "permission" | "tool" | "follow-up") {
    const target = callId ?? state.latestCallId
    if (!target) return
    const requested = [...state.events].reverse().find((event) => event.callId === target && event.type === "advisor.requested")
    if (!requested) return
    await emit(state, { ...baseEvent(state, requested.trigger, target, requested.budget.max), type: "advisor.delivered", delivery })
  }

  async function feedback(state: PhaseState, callId: string | undefined, outcome: AdvisorFeedbackOutcome, note?: string): Promise<boolean> {
    const target = callId ?? state.latestCallId
    if (!target || !state.events.some((event) => event.callId === target && event.type === "advisor.completed")) return false
    const existing = state.events.find((event): event is Extract<AdvisorEvent, { type: "advisor.feedback" }> => event.callId === target && event.type === "advisor.feedback")
    if (existing) return existing.outcome === outcome
    const requested = state.events.find((event) => event.callId === target && event.type === "advisor.requested")!
    await emit(state, {
      ...baseEvent(state, requested.trigger, target, requested.budget.max),
      type: "advisor.feedback",
      outcome,
      ...auditText(note, options.auditPolicy ?? "summary", "note"),
    })
    return true
  }

  function baseEvent(state: PhaseState, trigger: AdvisorReason, callId: string, max: number) {
    return {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      callId,
      phase: state.step.name,
      attempt: state.attempt,
      trigger,
      budget: { used: state.calls, max },
    }
  }

  async function emit(state: PhaseState, event: AdvisorEvent) {
    state.events.push(event)
    try {
      await options.onEvent?.(event)
    } catch (error) {
      log.warn(`[advisor] event sink failed, continuing: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function degraded(result: Extract<AdvisorResult, { kind: "error" }>): AdvisorAdvice {
    return { text: advisorFallbackText(result), ok: false }
  }

  return {
    begin(sessionID, step, attempt = 1) {
      if (!step.resolvedAdvisor) return undefined
      const state: PhaseState = { step, calls: 0, usage: [], events: [], attempt }
      phases.set(sessionID, state)
      return handleOf(sessionID, state)
    },

    handleFor(sessionID) {
      const state = phases.get(sessionID)
      return state ? handleOf(sessionID, state) : undefined
    },

    async checkpoint({ sessionID }): Promise<AdvisorGateDecision> {
      const state = phases.get(sessionID)
      // Unknown session — including a phase whose agent is advised in some
      // *other* step, since `begin` registers advised phases only. Allowing
      // rather than deferring is what keeps the `edit: "ask"` this feature puts
      // on the agent from reaching the gate's normal handling, which would mean
      // a human prompt on every edit interactively and a rejected edit in CI.
      if (!state) return { action: "allow" }
      if (state.calls > 0) return { action: "allow" }

      const advice = await consultFor(sessionID, state, "first-write")
      // A failed consultation must not cost the executor a turn: nothing useful
      // would come back, so let the write through and let it proceed.
      if (!advice.ok) return { action: "allow" }
      await handleOf(sessionID, state).delivered(advice.callId, "permission")
      return { action: "advise", message: firstWriteMessage(advice.text) }
    },
  }
}

/**
 * The advice reaches the executor as a denied-permission message, so it has to
 * explain the denial too — otherwise the model reads a bare rejection as "not
 * allowed to edit" and starts working around it instead of acting on the advice.
 */
export function firstWriteMessage(advice: string): string {
  return [
    "Convoy held this first edit to consult the advisor. You may proceed: repeat the edit and it will go through.",
    "",
    "Advice:",
    advice,
  ].join("\n")
}

/** Totals across a phase attempt's consultations, for the attempt log and SUMMARY. */
export function totalAdvisorUsage(usage: readonly AdvisorUsage[]): { calls: number; cost: number; inputTokens: number; outputTokens: number; model?: string } {
  let cost = 0
  let inputTokens = 0
  let outputTokens = 0
  for (const entry of usage) {
    cost += entry.cost
    inputTokens += entry.tokens.input + entry.tokens.cacheRead + entry.tokens.cacheWrite
    outputTokens += entry.tokens.output + entry.tokens.reasoning
  }
  return { calls: usage.length, cost, inputTokens, outputTokens, ...(usage[0]?.model ? { model: usage[0].model } : {}) }
}
