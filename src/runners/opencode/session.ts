/**
 * OpenCode session/watch/checkpoint runtime (change `unify-runner-system`,
 * task 2.1).
 *
 * The OpenCode attempt machinery — session watching, the advisor and report
 * checkpoints, event decoding and the backfill transcript — lives here so the
 * adapter owns its harness specifics and never imports the engine. The engine
 * imports these back; `ShutdownHandle` is the structural slice of `RunShutdown`
 * the runtime needs, so no cycle is introduced.
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"

import type { AssistantMessage, OpencodeClient, Part } from "../../opencode-client"
import { completionQuestion, type AdvisorUsage, type ModelSelection } from "../../advisor"
import type { AdvisorEvent } from "../../advisor-events"
import type { AdvisorService } from "../contracts"
import { getSessionEventHub, payloadProperties } from "../../event-hub"
import { log } from "../../log"
import { LoopGuardError, observationFromSessionEvent, type LoopGuardObservation } from "../../loop-guard"
import { toNeutralObservation } from "./loop-guard"
import { deliverableContractForPhase } from "../../pipeline"
import { qualityDimensionWeights, type QualityDimension } from "../../quality-score"
import type { ReportPhaseHandle } from "../../report-runtime"
import type { AgentStep, DeliverableContract } from "../../types"
import { addTokens, emptyTokens, tokensFromValue } from "../../usage"
import type { Workspace } from "../../workspace"
import type {
  ActivityKind,
  ProgressDiffSummary,
  ProgressMessage,
  ProgressStepUsage,
  ProgressTodo,
  ProgressTokens,
  ProgressUI,
  ProgressUsage,
} from "../../progress"
import { UserAbortError, isUserAbortError } from "../abort"
import { ContextOverflowError, formatSdkError } from "../errors"
import type { DeliverableService, LoopGuardService } from "../contracts"
import { validateDeliverableContract } from "../quality-contract"

/** Last session created for a phase's attempts; opaque to the engine. */
export type SessionRef = { id?: string }

/** Throws the run's abort reason when the attempt's signal has fired. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new UserAbortError()
}
export type SessionResult = {
  info: AssistantMessage
  parts: Part[]
  assistantInfos: AssistantMessage[]
  /** Parts emitted by the final assistant message only, excluding turn narration. */
  lastAssistantParts: Part[]
  /** Present only when this attempt consulted an advisor; kept apart from executor usage so the split stays visible. */
  advisorUsage?: readonly AdvisorUsage[]
  advisorEvents?: readonly AdvisorEvent[]
}

/** Sentinel the closing checkpoint asks a read-only phase to reply with when the advice changes nothing. */
const noChangesReply = "NO CHANGES"

/**
 * Consults the advisor once the phase believes it is finished, and gives it one
 * more turn in the SAME session when there is something to act on. Same session
 * on purpose: nothing is re-serialized, so the phase keeps every bit of context
 * it built up.
 *
 * Read-only phases retain the sentinel protocol for advisor corrections. Their
 * corrected artifact now goes through write_report, so a chatty extra turn
 * cannot replace a report the runtime already persisted.
 */
export async function applyCompletionCheckpoint(
  client: OpencodeClient,
  input: {
    phase: AgentStep
    targetDir: string
    model: ModelSelection
    progress: ProgressUI
    signal: AbortSignal
    sessionID: string
    /** The live guard from the first turn; the follow-up watcher shares it so cost and repeats accumulate. */
    loopGuard?: LoopGuardService
  },
  first: SessionResult,
  advisor: AdvisorService,
): Promise<SessionResult> {
  const advice = await advisor.consult({ trigger: "completion", question: completionQuestion(Boolean(input.phase.readOnly)) })
  if (!advice.ok) return first
  throwIfAborted(input.signal)

  input.progress.phaseActivity(input.phase.name, "advisor reviewed the finished phase", "info")

  const watcher = watchSession(client, {
    directory: input.targetDir,
    phaseName: input.phase.name,
    sessionID: input.sessionID,
    progress: input.progress,
    signal: input.signal,
    loopGuard: input.loopGuard,
    // Second turn of a session that already has one: anchored so the result is
    // this turn alone, which is what the composition below assumes.
    sinceMessageID: first.info.id,
  })
  try {
    await Promise.race([watcher.ready, sleep(3_000)])
    const accepted = await client.session.promptAsync({
      sessionID: input.sessionID,
      directory: input.targetDir,
      agent: input.phase.agentName,
      model: { providerID: input.model.providerID, modelID: input.model.modelID },
      variant: input.model.variant,
      parts: [{ type: "text", text: completionFollowUp(input.phase, advice.text) }],
    }, { signal: input.signal })
    if (accepted.error) throw new Error(formatSdkError(accepted.error))
    await advisor.delivered?.(advice.callId, "follow-up")

    const second = await watcher.result
    // The watcher resolves on a terminal error as readily as on a completion, so
    // the review turn's failure surfaces here and not only in the catch below.
    // Propagating it would fail the attempt and roll the finished phase back.
    if (second.info.error) return keepCompletedPhase(input.phase.name, first, formatSdkError(second.info.error))

    const secondText = extractAssistantText(second.lastAssistantParts).trim()
    const unchanged = secondText.length === 0 || secondText.toUpperCase().startsWith(noChangesReply)

    return {
      info: second.info,
      // A read-only phase keeps the legacy chat fallback semantics; the durable
      // report itself is resolved separately from write_report/file/chat.
      parts: input.phase.readOnly ? (unchanged ? first.parts : second.parts) : [...first.parts, ...second.parts],
      assistantInfos: [...first.assistantInfos, ...second.assistantInfos],
      // An unchanged follow-up means the first turn still holds the report, for
      // a writing phase too: the NO CHANGES sentinel must never become the phase
      // report through the text-fallback channel.
      lastAssistantParts: unchanged ? first.lastAssistantParts : second.lastAssistantParts,
    }
  } catch (error) {
    // A guard trip in the follow-up turn is the same decision a trip in the
    // first turn makes: the attempt must fail through the normal decision gate.
    // Only genuine review-turn failures (a dead provider, a wedged session) are
    // absorbed, because the phase already produced a durable deliverable.
    if (input.signal.aborted || isUserAbortError(error) || error instanceof LoopGuardError) throw error
    return keepCompletedPhase(input.phase.name, first, error instanceof Error ? error.message : String(error))
  } finally {
    await watcher.stop()
  }
}

/** The same-session reminder used when an OpenCode phase only described its report in chat. */
const writeReportReminder = [
  "You did not call write_report. Call it now with the complete report.",
  "If you have not finished, continue working and then call it. Pasting Markdown in chat is not enough.",
].join("\n")

/**
 * Gives OpenCode two opportunities to persist the report without discarding the
 * live session. Claude Code has no custom-tool capability and never enters here.
 */
export async function applyReportCheckpoint(
  client: OpencodeClient,
  input: {
    phase: AgentStep
    targetDir: string
    model: ModelSelection
    progress: ProgressUI
    signal: AbortSignal
    sessionID: string
    loopGuard?: LoopGuardService
  },
  first: SessionResult,
  deliverables: DeliverableService,
): Promise<SessionResult> {
  // A contract expecting nothing owns no deliverable; there is nothing to remind about.
  if (deliverables.expected.length === 0) return first
  if (await hasAcceptedDeliverable(deliverables)) return first

  let latest = first
  for (let reminder = 0; reminder < 2; reminder++) {
    throwIfAborted(input.signal)
    input.progress.phaseActivity(input.phase.name, `reminding the agent to save its report (${reminder + 1}/2)`, "info")
    const watcher = watchSession(client, {
      directory: input.targetDir,
      phaseName: input.phase.name,
      sessionID: input.sessionID,
      progress: input.progress,
      signal: input.signal,
      loopGuard: input.loopGuard,
      sinceMessageID: latest.info.id,
    })
    try {
      await Promise.race([watcher.ready, sleep(3_000)])
      const accepted = await client.session.promptAsync({
        sessionID: input.sessionID,
        directory: input.targetDir,
        agent: input.phase.agentName,
        model: { providerID: input.model.providerID, modelID: input.model.modelID },
        variant: input.model.variant,
        parts: [{ type: "text", text: writeReportReminder }],
      }, { signal: input.signal })
      if (accepted.error) throw new Error(formatSdkError(accepted.error))
      const next = await watcher.result
      if (next.info.error) return keepCompletedPhase(input.phase.name, latest, formatSdkError(next.info.error), "report reminder turn")
      latest = {
        info: next.info,
        parts: [...latest.parts, ...next.parts],
        assistantInfos: [...latest.assistantInfos, ...next.assistantInfos],
        lastAssistantParts: next.lastAssistantParts,
      }
      if (await hasAcceptedDeliverable(deliverables)) return latest
    } catch (error) {
      if (input.signal.aborted || isUserAbortError(error) || error instanceof LoopGuardError) throw error
      return keepCompletedPhase(input.phase.name, latest, error instanceof Error ? error.message : String(error), "report reminder turn")
    } finally {
      await watcher.stop()
    }
  }
  return latest
}

/** Whether the attempt already holds a deliverable its contract accepts; the engine owns that validation. */
async function hasAcceptedDeliverable(deliverables: DeliverableService): Promise<boolean> {
  if (deliverables.accepted) return await deliverables.accepted()
  return deliverables.candidate?.() !== undefined
}

/** The phase already produced a durable deliverable; a failed follow-up turn must not discard it. */
function keepCompletedPhase(phaseName: string, first: SessionResult, reason: string, turn = "advisor review turn"): SessionResult {
  log.warn(`[${phaseName}] ${turn} failed, keeping the completed phase: ${reason}`)
  return first
}

function completionFollowUp(phase: AgentStep, advice: string): string {
  const protocol = phase.readOnly
    ? `If this changes your findings, call \`write_report\` again with the COMPLETE corrected report. If it changes nothing, reply with exactly \`${noChangesReply}\`.`
    : `If this identifies real work, do it now and then say what you changed. If it changes nothing, say so briefly and stop.`

  return [
    "Before this phase is accepted, a reviewing model read your full transcript. Its guidance:",
    "",
    advice,
    "",
    protocol,
    "",
    "Weigh it seriously, but you have first-hand evidence it lacks: if something it claims is contradicted by what you actually read or ran, say so instead of complying.",
  ].join("\n")
}

export type SessionWatcher = {
  result: Promise<SessionResult>
  ready: Promise<void>
  stop(): Promise<void>
}

/** A one-time, best-effort, model-only queued reminder; it never opens a Convoy UI surface. */
export const softBudgetNudgeText = [
  "You have used half of this phase's step budget.",
  "Review your progress now, avoid repeating work, and complete or persist the deliverable with the remaining budget.",
].join(" ")

async function queueSoftBudgetNudge(client: OpencodeClient, sessionID: string, phaseName: string) {
  try {
    // Queued behind the in-flight turn (non-interrupting delivery). Best-effort:
    // OpenCode may accept the queue on a busy session without injecting the
    // instruction into later turns. The hard budget gate is the real stop.
    const queued = await client.session.promptAsync({ sessionID, parts: [{ type: "text", text: softBudgetNudgeText }], delivery: "queue" })
    if (queued.error) log.warn(`[${phaseName}] couldn't queue the soft step-budget nudge: ${formatSdkError(queued.error)}`)
  } catch (error) {
    // A failed nudge must not change the active turn or bypass the hard budget
    // gate. In particular, no abort-and-reprompt fallback is used here.
    log.warn(`[${phaseName}] couldn't queue the soft step-budget nudge: ${formatSdkError(error)}`)
  }
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
  messagePartChannels: Map<string, "reasoning" | "response">
  // Counters behind the synthetic part IDs for the session.next.* stream, which
  // carries no part identity of its own: each reasoning/text burst gets its own
  // transcript block instead of merging into the one before it.
  reasoningPart: number
  textPart: number
  usageSignature: string
  /** The most recent tool name (V2 `session.tool.input.started` carries it; `session.tool.called` does not). */
  lastToolName: string
}

type SessionSignal =
  | { type: "activity"; kind: ActivityKind; message: string; stepUsage?: ProgressStepUsage; pulse?: boolean }
  | { type: "usage"; usage: ProgressUsage }
  | { type: "todos"; todos: ProgressTodo[]; message: string }
  | { type: "diff"; summary: ProgressDiffSummary }
  | { type: "idle" }
  /**
   * `terminal`: the turn is over (V2 `session.execution.failed`); no `idle` follows.
   * `overflow`: it failed because the turn could not be compacted to fit the context.
   */
  | { type: "error"; error: string; terminal?: boolean; overflow?: boolean }

const sessionPollMs = 30_000
const maxConsecutivePollFailures = 10

export function watchSession(
  client: OpencodeClient,
  input: {
    directory: string
    phaseName: string
    sessionID: string
    progress: ProgressUI
    signal: AbortSignal
    /**
     * Circuit breaker for this attempt. The live instance is shared across the
     * first turn and the advisor follow-up; the guard holds the running totals
     * (repeats, steps, and per-message cost), so a fresh watcher for the
     * follow-up turn observes its own events but cannot reset the fuse.
     */
    loopGuard?: LoopGuardService
    /**
     * Anchor for a watcher that covers a follow-up turn in an already-used
     * session: everything up to and including this assistant message belongs to
     * the previous turn and is excluded from the result. Omitted, the result
     * covers the whole session — which is the same thing for a fresh one.
     */
    sinceMessageID?: string
    /**
     * Reconstruct the session's earlier output for a dashboard that did not
     * watch the session from birth: subscribe first but buffer live transcript
     * chunks, fetch the session history from the server, emit the history as
     * transcript blocks, then release the buffer minus what history already
     * covers — so history and live stream merge in order without duplication.
     * The runner's own watchers never set this (they hold the session from
     * birth); only the attach path does.
     */
    backfill?: boolean
    /**
     * Attach-level teardown, consulted only when `backfill` is set: when the
     * attach that owns this watcher is stopped (a reset replaced the
     * dashboard's view), a backfill fetch still in flight must not deliver the
     * previous run's history into a phase name the next run reuses. A
     * same-run watcher stop — the phase finalized while its fetch was in
     * flight — deliberately does not flip this: that completed phase still
     * wants its history.
     */
    isCancelled?: () => boolean
  },
): SessionWatcher {
  const controller = new AbortController()
  const state = newActivityState()
  // Built before the subscription registers, so every transcript chunk the
  // hub delivers from the first moment is buffered while history is fetched.
  const transcript = input.backfill
    ? createBackfillTranscript(client, {
        sessionID: input.sessionID,
        directory: input.directory,
        phaseName: input.phaseName,
        progress: input.progress,
        ...(input.isCancelled ? { isCancelled: input.isCancelled } : {}),
      })
    : undefined

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

  // One directory-scoped subscription is shared across all phases; this watcher
  // just registers for its own session's events (see event-hub).
  const hub = getSessionEventHub(client, input.directory)

  const finish = (outcome: { value?: SessionResult; error?: unknown }) => {
    if (settled) return
    settled = true
    controller.abort(new Error("session watcher finished"))
    if (outcome.value) resolveResult(outcome.value)
    else rejectResult(outcome.error)
  }

  const tripLoopGuard = (observation: LoopGuardObservation) => {
    if (!input.loopGuard || settled) return
    const decision = input.loopGuard.observe(toNeutralObservation(observation))
    if (decision.action === "continue") return
    if (decision.action === "nudge") {
      // Queued delivery is model-only: don't add activity to the dashboard or
      // interrupt the current turn. The guard emits this exactly once per
      // budget cycle, and resetSteps deliberately makes it eligible again.
      void queueSoftBudgetNudge(client, input.sessionID, input.phaseName)
      return
    }
    input.progress.phaseActivity(input.phaseName, decision.reason, "error")
    log.warn(`[${input.phaseName}] ${decision.reason}`)
    void abortSessionQuietly(client, input.sessionID, input.directory, input.phaseName)
    finish({ error: new LoopGuardError({ reason: decision.code, message: decision.reason, count: 0 }) })
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
        // A result describes ONE turn. The server hands back the whole session,
        // so a follow-up watcher drops everything through its anchor: a caller
        // that composes two turns would otherwise double-count their usage and
        // concatenate the first turn's report onto the second's.
        const anchor = input.sinceMessageID ? assistant.findIndex((message) => message.info.id === input.sinceMessageID) : -1
        const turn = anchor === -1 ? assistant : assistant.slice(anchor + 1)
        const last = turn[turn.length - 1]
        if (!last || (!last.info.time.completed && !last.info.error)) return false
        finish({
          value: {
            info: last.info,
            parts: turn.flatMap((message) => message.parts),
            assistantInfos: turn.map((message) => message.info),
            lastAssistantParts: last.parts,
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
        // Display only. The guard's cost fuse is fed per assistant message in
        // observationFromSessionEvent, not from this summed total, so a shared
        // guard can accumulate across the advisor's follow-up watcher.
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
        // A V2 execution failure ends the turn without an idle: settle it now
        // rather than waiting on a status poll that may keep reporting it active.
        if (!(await verifyCompletion()) && signal.terminal) {
          finish({ error: signal.overflow ? new ContextOverflowError(signal.error) : new Error(signal.error) })
        }
        return
      case "idle":
        input.progress.phaseActivity(input.phaseName, "session idle; collecting results", "info")
        if (!(await verifyCompletion()) && sawWork) {
          finish({ error: new Error(lastSessionError ?? "session went idle without a completed response") })
        }
        return
    }
  }

  // The hub delivers only this session's events (it filters by sessionID), so we
  // describe them into the same activity/message signals the old per-session
  // subscription produced — just without owning a subscription of our own.
  const unsubscribe = hub.onSession(input.sessionID, (payload) => {
    if (settled || controller.signal.aborted) return
    state.lastServerEvent = Date.now()
    const properties = payloadProperties(payload)
    const observation = guardObservationFrom(payload)
    if (observation) tripLoopGuard(observation)
    if (settled) return
    const signal = describeSessionActivity(payload, state)
    if (signal) {
      if (signal.type !== "idle" && signal.type !== "error") sawWork = true
      // handleSignal's only async work is completion verification, which is
      // idempotent; fire-and-forget keeps the hub's dispatch non-blocking so one
      // session's network round-trip can't stall the others'.
      void handleSignal(signal).catch(() => {})
    }
    if (settled) return
    // The verbatim model stream for the session transcript, extracted separately
    // so the summarized activity/status signals above are untouched. Appends
    // only — the TUI repaints it on its own ticker.
    const chunk = describeMessageChunk(payload, state)
    if (chunk) {
      sawWork = true
      if (transcript) transcript.live(chunk, chunkIdentity(properties))
      else input.progress.phaseMessage(input.phaseName, chunk)
    }
  })

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
    // Readiness now means "the shared subscription is live"; the hub opens it
    // once at run start, before any phase prompts, so early events aren't lost.
    ready: hub.ready,
    async stop() {
      settled = true
      unsubscribe() // last listener to leave tears the shared subscription down
      controller.abort(new Error("session watcher stopped"))
      input.signal.removeEventListener("abort", onExternalAbort)
      // The poll loop unwinds on abort; the race is a safety net so a stuck
      // request can never hold the whole run hostage.
      await Promise.race([pollLoop, sleep(3_000)])
    },
  }
}

export async function abortSessionQuietly(client: OpencodeClient, sessionID: string, directory: string, phaseName: string) {
  try {
    const response = await client.session.abort({ sessionID, directory })
    if (response.error) log.warn(`[${phaseName}] couldn't abort session ${sessionID}: ${formatSdkError(response.error)}`)
  } catch (error) {
    log.warn(`[${phaseName}] couldn't abort session ${sessionID}: ${formatSdkError(error)}`)
  }
}

export function sleep(ms: number, signal?: AbortSignal) {
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

function payloadType(payload: unknown) {
  if (!payload || typeof payload !== "object") return ""
  const type = (payload as { type?: unknown }).type
  if (typeof type === "string") return type === "sync" ? String((payload as { name?: unknown }).name ?? "").replace(/\.1$/, "") : type
  const name = (payload as { name?: unknown }).name
  return typeof name === "string" ? name.replace(/\.1$/, "") : ""
}

/**
 * Maps the released V2 event vocabulary to the names the activity/transcript
 * switch understands. V2 renamed the stream (`session.text.delta`,
 * `session.tool.*`, `session.execution.*`) and moved the payload to `data`;
 * `payloadProperties` already reads `data`, so only the type name — and a few
 * field names — differ. Verified against a real V2 server's event stream.
 */
const v2EventAliases: Record<string, string> = {
  "session.reasoning.started": "session.next.reasoning.started",
  "session.reasoning.delta": "session.next.reasoning.delta",
  "session.reasoning.ended": "session.next.reasoning.ended",
  "session.text.started": "session.next.text.started",
  "session.text.delta": "session.next.text.delta",
  "session.text.ended": "session.next.text.ended",
  "session.tool.input.started": "session.next.tool.input.started",
  "session.tool.input.delta": "session.next.tool.input.delta",
  "session.tool.input.ended": "session.next.tool.input.ended",
  "session.tool.called": "session.next.tool.called",
  "session.tool.progress": "session.next.tool.progress",
  "session.tool.success": "session.next.tool.success",
  "session.tool.failed": "session.next.tool.failed",
  "session.shell.started": "session.next.shell.started",
  "session.shell.ended": "session.next.shell.ended",
  "session.retry.scheduled": "session.next.retried",
  "session.compaction.started": "session.next.compaction.started",
  "session.compaction.delta": "session.next.compaction.delta",
  "session.compaction.ended": "session.next.compaction.ended",
  "session.step.started": "session.next.step.started",
  "session.step.ended": "session.next.step.ended",
  "session.step.failed": "session.next.step.failed",
  "session.usage.updated": "message.updated",
  // V2 has no `session.idle`: a settled turn is an execution outcome.
  "session.execution.succeeded": "session.idle",
  "session.execution.failed": "session.error",
  "session.execution.interrupted": "session.error",
}

export function normalizeEventType(type: string): string {
  return v2EventAliases[type] ?? type
}

/** The loop-guard observation for a V2 session event, read through the same aliases as the activity feed. */
export function guardObservationFrom(payload: unknown): LoopGuardObservation | undefined {
  const properties = payloadProperties(payload)
  return properties ? observationFromSessionEvent(normalizeEventType(payloadType(payload)), properties) : undefined
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
    messagePartChannels: new Map(),
    reasoningPart: 0,
    textPart: 0,
    usageSignature: "",
    lastToolName: "",
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
  const type = normalizeEventType(payloadType(payload))
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
      state.lastToolName = pickString(properties, ["name"]) || state.lastToolName
      return activity("tool", `preparing ${state.lastToolName || "tool"}`)
    case "session.next.tool.called":
      return activity("tool", describeToolCall({ tool: pickString(properties, ["tool"]) || state.lastToolName, input: properties.input }))
    case "session.next.tool.progress":
      return activity("tool", `tool progress: ${describeToolContent(properties.content)}`)
    case "session.next.tool.success":
      return activity("tool", `tool done: ${describeToolContent(properties.content)}`)
    case "session.next.tool.failed":
      return activity("error", `tool failed: ${formatEventError(properties.error)}`)
    case "session.next.shell.started": {
      const shell = properties.shell && typeof properties.shell === "object" ? (properties.shell as Record<string, unknown>) : properties
      return activity("bash", pickString(shell, ["command"]))
    }
    case "session.next.shell.ended": {
      const shell = properties.shell && typeof properties.shell === "object" ? (properties.shell as Record<string, unknown>) : properties
      return activity("bash", `done: ${firstLine(pickString(shell, ["output", "command"]))}`)
    }
    case "session.next.retried":
      return activity("retry", `provider retry ${properties.attempt ?? ""}: ${formatEventError(properties.error)}`)
    case "session.next.compaction.started":
      return activity("info", `compacting context (${pickString(properties, ["reason"]) || "auto"})`)
    case "session.next.compaction.delta":
      return activity("info", "compacting context…")
    case "session.next.compaction.ended":
      return activity("info", "context compaction complete")
    case "permission.asked":
      return activity("permission", `permission requested: ${pickString(properties, ["action", "permission"])}`)
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
      return {
        type: "error",
        error: formatEventError(properties.error),
        ...(payloadType(payload) === "session.execution.failed" ? { terminal: true } : {}),
        ...(isCompactionFailure(properties.error) ? { overflow: true } : {}),
      }
    default:
      if (type.startsWith("session.next.")) return activity("info", type.replace(/^session\.next\./, ""))
      return undefined
  }
}

/**
 * Extracts the verbatim model output for the live session transcript, kept
 * separate from describeSessionActivity so the summarized activity/status/feed
 * signals stay unchanged. Reasoning and response arrive as raw incremental
 * deltas (uncapped, unlike pickString), and tool calls / shell commands become
 * one-line action markers. Everything else — usage, todos, diffs, heartbeats —
 * belongs to the activity path, not the transcript.
 */
export function describeMessageChunk(payload: unknown, state?: ActivityState): ProgressMessage | undefined {
  const type = normalizeEventType(payloadType(payload))
  const properties = payloadProperties(payload)
  if (!properties) return undefined

  switch (type) {
    case "message.part.updated":
      rememberMessagePartChannel(properties, state)
      return undefined
    case "message.part.delta": {
      const text = rawString(properties.delta)
      if (!text || properties.field !== "text") return undefined
      const partID = rawString(properties.partID)
      return { channel: state?.messagePartChannels.get(partID) ?? "response", text, ...(partID ? { partID } : {}) }
    }
    // The session.next.* stream has no part IDs, so each burst is numbered here:
    // a model that emits several reasoning summaries in a row sends one
    // started/delta…/ended cycle per summary, and the counter keeps them apart.
    case "session.next.reasoning.started":
      if (state) state.reasoningPart++
      return undefined
    case "session.next.text.started":
      if (state) state.textPart++
      return undefined
    case "session.next.reasoning.delta": {
      const text = rawString(properties.delta)
      return text ? { channel: "reasoning", text, partID: `reasoning:${state?.reasoningPart ?? 0}` } : undefined
    }
    case "session.next.text.delta": {
      const text = rawString(properties.delta)
      return text ? { channel: "response", text, partID: `text:${state?.textPart ?? 0}` } : undefined
    }
    case "session.next.tool.called":
      return { channel: "tool", text: describeToolCall({ tool: pickString(properties, ["tool"]) || state?.lastToolName || "tool", input: properties.input }) }
    case "session.next.shell.started": {
      const shell = properties.shell && typeof properties.shell === "object" ? (properties.shell as Record<string, unknown>) : properties
      const command = pickString(shell, ["command"])
      return command ? { channel: "bash", text: command } : undefined
    }
    default:
      return undefined
  }
}

function rememberMessagePartChannel(properties: Record<string, unknown>, state: ActivityState | undefined) {
  if (!state) return
  const part = properties.part
  if (!part || typeof part !== "object") return
  const candidate = part as { id?: unknown; type?: unknown }
  if (typeof candidate.id !== "string") return
  if (candidate.type === "reasoning") state.messagePartChannels.set(candidate.id, "reasoning")
  else if (candidate.type === "text") state.messagePartChannels.set(candidate.id, "response")
}

function rawString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

// ---------------------------------------------------------------------------
// Session transcript backfill
//
// A dashboard that attaches mid-run (or re-attaches) did not watch a session
// from birth, so its transcript starts empty. The backfill reconstructs the
// session from the run's live OpenCode server and merges it with the live
// stream: subscribe first and buffer live chunks, fetch `session.messages`,
// emit the history as transcript blocks (same channel mapping the live chunk
// extractor uses), then release the buffer minus what history already covers.
// The overlap is the delta sequence between subscription and the server's
// history snapshot — exactly the largest suffix of a history message's text
// that matches a prefix of the buffered deltas — so a mid-stream part is
// neither duplicated nor truncated. The TUI's transcript cap bounds memory.
// ---------------------------------------------------------------------------

type SessionHistoryMessage = { info: AssistantMessage; parts: Part[] }

type SessionHistory = {
  /** History as transcript blocks, in message/part order. */
  chunks: ProgressMessage[]
  /** Full streaming text (reasoning + response parts concatenated) per assistant message. */
  messageText: Map<string, string>
  /** Tool call ids seen in history, for marker dedupe. */
  callIDs: Set<string>
  /** Assistant messages that completed — their stream can never grow again. */
  completed: Set<string>
}

/**
 * Maps a fetched session history onto the same transcript channels the live
 * extractor produces: reasoning and text parts become streaming blocks keyed
 * by their provider part id, tool parts become one-line action markers
 * rendered exactly like `describeToolCall` renders the live event. Synthetic
 * or ignored text parts (context injections the live stream never shows) are
 * skipped. Only assistant messages stream; user prompts are not transcript.
 */
function historyTranscript(messages: readonly unknown[]): SessionHistory {
  const chunks: ProgressMessage[] = []
  const messageText = new Map<string, string>()
  const callIDs = new Set<string>()
  const completed = new Set<string>()
  for (const message of messages) {
    const record = message as SessionHistoryMessage | undefined
    if (!record || typeof record !== "object" || !record.info || record.info.role !== "assistant") continue
    const messageID = record.info.id
    if (record.info.time?.completed) completed.add(messageID)
    let text = ""
    for (const part of record.parts ?? []) {
      if (!part || typeof part !== "object") continue
      if (part.type === "reasoning") {
        const body = typeof part.text === "string" ? part.text : ""
        chunks.push({ channel: "reasoning", text: body, ...(typeof part.id === "string" ? { partID: part.id } : {}) })
        text += body
      } else if (part.type === "text") {
        if ("synthetic" in part && part.synthetic) continue
        if ("ignored" in part && part.ignored) continue
        const body = typeof part.text === "string" ? part.text : ""
        chunks.push({ channel: "response", text: body, ...(typeof part.id === "string" ? { partID: part.id } : {}) })
        text += body
      } else if (part.type === "tool") {
        if (typeof part.callID === "string") callIDs.add(part.callID)
        const state = (part as { state?: { input?: unknown } }).state
        chunks.push({ channel: "tool", text: describeToolCall({ tool: part.tool, input: state?.input }) })
      }
    }
    if (text) messageText.set(messageID, text)
  }
  return { chunks, messageText, callIDs, completed }
}

/** The message/call identity a transcript event belongs to, for backfill dedupe. */
function chunkIdentity(properties: Record<string, unknown> | undefined): { messageID?: string; callID?: string } {
  if (!properties) return {}
  const messageID = [properties.messageID, properties.assistantMessageID].find((value) => typeof value === "string") as string | undefined
  // V2 tool events name their call `id`; history carries the same value as callID.
  const callID = [properties.callID, properties.id].find((value) => typeof value === "string") as string | undefined
  return { ...(messageID ? { messageID } : {}), ...(callID ? { callID } : {}) }
}

/**
 * The overlap between the buffered live deltas for one message and its
 * history text: the largest prefix of the buffer that is also a suffix of the
 * history. That suffix is precisely the delta sequence between subscription
 * and the server's snapshot, so trimming it leaves only genuinely new text —
 * even when the part began streaming before the subscription (the buffer
 * holds only its tail). A coincidental longer match trims a few extra
 * characters, degrading to a missing line, never a duplicate.
 */
function overlapLength(buffered: string, historyText: string): number {
  const max = Math.min(buffered.length, historyText.length)
  for (let k = max; k > 0; k--) {
    if (buffered.startsWith(historyText.slice(historyText.length - k))) return k
  }
  return 0
}

/**
 * Fetches a session's transcript from the live server and maps it onto the
 * transcript channels. A server that cannot answer (gone, or the request
 * failed) yields `undefined`, so every caller keeps its honest placeholder —
 * `createBackfillTranscript` then merges only the live buffer, and the lazy
 * backfill emits nothing.
 */
async function readSessionHistory(client: OpencodeClient, sessionID: string, directory: string): Promise<SessionHistory | undefined> {
  try {
    const response = await client.session.messages({ sessionID, directory })
    if (response.error || !response.data) return undefined
    return historyTranscript(response.data)
  } catch {
    return undefined
  }
}

type BackfillTranscript = {
  /** Routes a live transcript chunk: buffered before release, guarded after. */
  live(chunk: ProgressMessage, identity: { messageID?: string; callID?: string }): void
}

/**
 * The buffered backfill used by `watchSession` when `backfill` is set. The
 * fetch runs concurrently with the watcher; when it settles (or fails — a
 * server that cannot answer simply has nothing to merge) the buffer is
 * reconciled against the history and released, after which live chunks flow
 * through with cheap guards only.
 */
function createBackfillTranscript(
  client: OpencodeClient,
  input: { sessionID: string; directory: string; phaseName: string; progress: ProgressUI; isCancelled?: () => boolean },
): BackfillTranscript {
  type Pending = { chunk: ProgressMessage; messageID?: string; callID?: string }
  const pending: Pending[] = []
  let history: SessionHistory | undefined
  let released = false
  // Set when the owning attach was torn down while the fetch was in flight:
  // the previous run's history must not land in a phase name the next run
  // reuses, so the buffer is dropped and later live chunks are ignored.
  let cancelled = false
  const emit = (chunk: ProgressMessage) => input.progress.phaseMessage(input.phaseName, chunk)

  const release = () => {
    if (released) return
    released = true
    if (!history) {
      for (const entry of pending) emit(entry.chunk)
      pending.length = 0
      return
    }
    // Streaming chunks of a message history covers are reconciled per message:
    // the first buffered chunk of that message computes the total overlap once,
    // and it is consumed front-to-back across the message's buffered chunks.
    const remaining = new Map<string, number>()
    for (const entry of pending) {
      const streaming = entry.chunk.channel === "reasoning" || entry.chunk.channel === "response"
      if (!streaming) {
        // Tool/bash markers: a call history recorded (by call id) must not
        // double-post, and neither may a marker of an already-complete message.
        if (entry.callID && history!.callIDs.has(entry.callID)) continue
        if (entry.messageID && history!.completed.has(entry.messageID)) continue
        emit(entry.chunk)
        continue
      }
      if (!entry.messageID) {
        emit(entry.chunk)
        continue
      }
      // A completed message's stream can never grow: whatever the buffer holds
      // for it, history already contains whole.
      if (history!.completed.has(entry.messageID)) continue
      if (!history!.messageText.has(entry.messageID)) {
        emit(entry.chunk)
        continue
      }
      let left = remaining.get(entry.messageID!)
      if (left === undefined) {
        const buffered = pending
          .filter((other) => other.messageID === entry.messageID && (other.chunk.channel === "reasoning" || other.chunk.channel === "response"))
          .map((other) => other.chunk.text)
          .join("")
        left = overlapLength(buffered, history!.messageText.get(entry.messageID!)!)
        remaining.set(entry.messageID!, left)
      }
      if (left <= 0) {
        emit(entry.chunk)
        continue
      }
      if (entry.chunk.text.length <= left) {
        remaining.set(entry.messageID!, left - entry.chunk.text.length)
        continue
      }
      emit({ ...entry.chunk, text: entry.chunk.text.slice(left) })
      remaining.set(entry.messageID!, 0)
    }
    pending.length = 0
  }

  void (async () => {
    const fetched = await readSessionHistory(client, input.sessionID, input.directory)
    if (input.isCancelled?.()) {
      cancelled = true
      pending.length = 0
      return
    }
    history = fetched
    if (history) for (const chunk of history.chunks) emit(chunk)
    release()
  })()

  return {
    live(chunk, identity) {
      if (cancelled) return
      if (released) {
        // Post-release guards: history already holds complete messages whole,
        // and a tool call history recorded (by callID) must not double-post.
        if (!history) {
          emit(chunk)
          return
        }
        if (identity.callID && history.callIDs.has(identity.callID)) return
        if (identity.messageID && history.completed.has(identity.messageID)) return
        emit(chunk)
        return
      }
      pending.push({ chunk, ...identity })
    },
  }
}

/**
 * One-shot transcript reconstruction for a session nobody is watching: fetches
 * the session history from the live server and emits it as transcript blocks.
 * Used for a completed phase's first session-tab view on an attached dashboard
 * (a running phase's watcher does its own buffered merge instead). A server
 * that cannot answer leaves the caller's placeholder untouched.
 */
export async function backfillSessionTranscript(
  client: OpencodeClient,
  input: { directory: string; phaseName: string; sessionID: string; progress: ProgressUI; isCancelled?: () => boolean },
): Promise<void> {
  // A server that cannot answer leaves the caller's placeholder untouched;
  // nothing is fabricated for an unreachable server.
  const history = await readSessionHistory(client, input.sessionID, input.directory)
  // The owning attach stopped while the fetch was in flight (a reset replaced
  // the view): the previous run's history must not land in a phase name the
  // next run reuses.
  if (input.isCancelled?.()) return
  if (!history) return
  for (const chunk of history.chunks) input.progress.phaseMessage(input.phaseName, chunk)
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
  if (!info || typeof info !== "object") {
    // V2: `session.usage.updated` carries the cumulative session total directly
    // (no per-message `info`), so there is nothing to dedup by message id.
    const tokens = tokensFromValue(properties.tokens)
    const cost = typeof properties.cost === "number" && Number.isFinite(properties.cost) ? properties.cost : 0
    if (!tokens || (tokens.total === 0 && cost === 0)) return undefined
    const signature = `${cost.toFixed(6)}:${tokens.input}:${tokens.output}:${tokens.reasoning}:${tokens.total}`
    if (signature === state.usageSignature) return undefined
    state.usageSignature = signature
    const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : undefined
    return { type: "usage", usage: { cost, tokens, sessionID, ...(state.currentStepModel ? { model: state.currentStepModel } : {}) } }
  }
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

export function combinedAssistantUsage(infos: AssistantMessage[], sessionID: string): ProgressUsage | undefined {
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

export function formatUsageForLog(usage: ProgressUsage) {
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

/** V2 reports an unshrinkable turn as `{ type: "compaction.failed" }`. */
function isCompactionFailure(value: unknown) {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "compaction.failed")
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

export function extractAssistantText(parts: readonly Part[]) {
  return parts
    .filter((part): part is Part & { type: "text"; text: string } => part.type === "text")
    .filter((part) => !("synthetic" in part && part.synthetic) && !("ignored" in part && part.ignored))
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
}
