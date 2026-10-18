/**
 * The neutral attempt sink (change `unify-runner-system`, tasks 4.1/6.2).
 *
 * An attempt emits normalized `RunnerEvent`s to one sink; the engine maps them
 * onto whatever it renders. This keeps the attempt free of the engine's
 * `ProgressUI` while preserving the exact dashboard output (the widened event
 * vocabulary carries the activity kind, todos and diff detail the panel uses).
 */

import type { AttemptIdentity, RunnerEvent, RunnerId, Usage } from "./contracts"
import type { ActivityKind, ProgressDiffSummary, ProgressMessage, ProgressStepUsage, ProgressTodo, ProgressTokens, ProgressUI, ProgressUsage } from "../progress"

export type AttemptSink = (event: RunnerEvent) => void

/** Reconstructs the dashboard's usage shape (it wants an explicit token total). */
export function toProgressUsage(usage: Usage): ProgressUsage {
  const hasTokens =
    usage.input !== undefined || usage.output !== undefined || usage.reasoning !== undefined || usage.cacheRead !== undefined || usage.cacheWrite !== undefined
  const tokens: ProgressTokens | undefined = hasTokens
    ? {
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        reasoning: usage.reasoning ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        total: (usage.input ?? 0) + (usage.output ?? 0) + (usage.reasoning ?? 0),
      }
    : undefined
  return {
    ...(usage.sessionID ? { sessionID: usage.sessionID } : {}),
    ...(usage.costEstimate !== undefined ? { cost: usage.costEstimate } : {}),
    ...(tokens ? { tokens } : {}),
    ...(usage.model ? { model: usage.model } : {}),
  }
}

/** The neutral usage for a dashboard reading (the inverse of {@link toProgressUsage}). */
export function fromProgressUsage(usage: ProgressUsage): Usage {
  const tokens = usage.tokens
  return {
    ...(tokens
      ? { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite }
      : {}),
    ...(usage.cost !== undefined ? { costEstimate: usage.cost } : {}),
    ...(usage.sessionID ? { sessionID: usage.sessionID } : {}),
    ...(usage.model ? { model: usage.model } : {}),
  }
}

/**
 * The engine's sink: neutral events rendered onto the run's progress target.
 * Permission and terminal events are handled by the engine, not rendered here.
 */
export function progressSink(progress: ProgressUI, identity: AttemptIdentity): AttemptSink {
  const phase = identity.phaseName
  return (event) => {
    switch (event.type) {
      case "session":
        progress.phaseSession(phase, event.session.sessionId)
        return
      case "message":
        progress.phaseMessage(phase, { channel: event.channel, text: event.text, ...(event.partId ? { partID: event.partId } : {}) })
        return
      case "text":
        progress.phaseMessage(phase, { channel: "response", text: event.text, ...(event.partId ? { partID: event.partId } : {}) })
        return
      case "reasoning":
        progress.phaseMessage(phase, { channel: "reasoning", text: event.text, ...(event.partId ? { partID: event.partId } : {}) })
        return
      case "tool":
        progress.phaseActivity(phase, event.detail ? `${event.name}: ${event.detail}` : event.name, "tool")
        return
      case "usage":
        progress.phaseUsageTotal(phase, toProgressUsage(event.usage))
        return
      case "step-usage":
        progress.phaseStepUsage(phase, event.usage)
        return
      case "activity":
        if (event.stepUsage) progress.phaseStepUsage(phase, event.stepUsage)
        progress.phaseActivity(phase, event.message, event.kind, event.pulse)
        return
      case "todos":
        progress.phaseTodos(phase, [...event.todos])
        if (event.message) progress.phaseActivity(phase, event.message, "todo")
        return
      case "diff":
        progress.phaseDiff(phase, event.summary)
        return
      default:
        return
    }
  }
}

/**
 * The adapter-side progress surface: an attempt that still speaks the engine's
 * `ProgressUI` renders through the neutral sink instead, so the attempt never
 * needs the engine's progress target (task 6.2).
 */
export function sinkProgress(sink: AttemptSink, runner: RunnerId, attempt: number): ProgressUI {
  return {
    phaseSession(_name: string, sessionId: string) {
      sink({ type: "session", runner, attempt, session: { runner, sessionId } })
    },
    phaseMessage(_name: string, message: ProgressMessage) {
      sink({ type: "message", runner, attempt, channel: message.channel, text: message.text, ...(message.partID ? { partId: message.partID } : {}) })
    },
    phaseActivity(_name: string, message: string, kind?: ActivityKind, pulse?: boolean) {
      sink({ type: "activity", runner, attempt, message, ...(kind ? { kind } : {}), ...(pulse ? { pulse } : {}) })
    },
    phaseUsageTotal(_name: string, usage: ProgressUsage) {
      sink({ type: "usage", runner, attempt, usage: fromProgressUsage(usage) })
    },
    phaseStepUsage(_name: string, usage: ProgressStepUsage) {
      sink({ type: "step-usage", runner, attempt, usage })
    },
    phaseTodos(_name: string, todos: ProgressTodo[]) {
      sink({ type: "todos", runner, attempt, todos })
    },
    phaseDiff(_name: string, summary: ProgressDiffSummary) {
      sink({ type: "diff", runner, attempt, summary })
    },
  } as ProgressUI
}
