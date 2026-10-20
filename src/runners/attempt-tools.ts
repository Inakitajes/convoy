/**
 * Convoy's agent-facing tools for the CLI runners (`write_report`, `advisor`,
 * `advisor_feedback`), bound to one attempt's services and served through the
 * attempt bridge. Shared so every CLI runner submits and consults with the
 * same payloads and semantics as OpenCode's plugin tools.
 */

import { firstWriteMessage } from "../advisor-runtime"
import { writeReportScope } from "../report"
import type { AttemptHandlers } from "./attempt-bridge"
import type { DeliverableSubmission, ExecutionRequest, ExecutionServices } from "./contracts"

const scoreFields = ["dimensions", "mustFix", "gaps", "confidence"]

/**
 * Maps a `write_report` call onto the attempt's deliverable service with the
 * same payload OpenCode's tool sends, so both runners validate identically: a
 * scoring call carries its dimensions, a report carries its optional commit.
 */
export function toolReportSubmission(payload: unknown): DeliverableSubmission {
  const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {}
  if (scoreFields.some((field) => field in record)) return { kind: "score", body: JSON.stringify(record) }
  const commit = record.commit as { subject?: unknown; details?: unknown } | undefined
  return {
    kind: "report",
    body: typeof record.markdown === "string" ? record.markdown : "",
    ...(commit && typeof commit.subject === "string"
      ? { commit: { subject: commit.subject, ...(Array.isArray(commit.details) ? { details: commit.details.filter((detail): detail is string => typeof detail === "string") } : {}) } }
      : {}),
  }
}

/**
 * The handlers for Convoy's own agent-facing tools, bound to one attempt's
 * services: `write_report` validated by its deliverable service, and the
 * advisor's on-demand consultation, feedback, and first-write checkpoint. The
 * operator gate is the adapter's own concern.
 */
export function convoyToolHandlers(request: Pick<ExecutionRequest, "advised" | "agent" | "mode">, services: ExecutionServices | undefined): AttemptHandlers {
  const handlers: AttemptHandlers = {}
  const deliverables = services?.deliverables
  if (deliverables) {
    handlers.report = async (payload) => {
      const result = await deliverables.submit(toolReportSubmission(payload))
      return result.ok ? { ok: true, text: "Report saved." } : { ok: false, error: result.error }
    }
    // The host offers the schema of this phase's scope, as OpenCode's plugin does.
    handlers.reportScope = writeReportScope(request.agent.name, request.mode !== "write")
  }
  const advisor = services?.advisor
  if (advisor && request.advised) {
    handlers.advisor = {
      async consult(question) {
        const advice = await advisor.consult({ trigger: "on-demand", question: question ?? "" })
        if (advice.ok) await advisor.delivered?.(advice.callId, "tool")
        return { ok: true, text: advice.text, ...(advice.callId ? { callId: advice.callId } : {}) }
      },
      async feedback(callId, outcome, note) {
        if (outcome !== "adopted" && outcome !== "partially-adopted" && outcome !== "rejected") return { ok: false, error: "outcome must be adopted, partially-adopted, or rejected" }
        const recorded = (await advisor.feedback?.(callId, outcome, note)) ?? false
        return { ok: true, text: recorded ? "Advisor feedback recorded." : "No matching completed advisor call." }
      },
      // The OpenCode gate's semantics: the first write is held once for a
      // consultation, and later writes (or a failed consultation) proceed.
      async checkpoint() {
        if (advisor.satisfied()) return { decision: "allow" }
        const advice = await advisor.consult({ trigger: "first-write", question: "" })
        if (!advice.ok) return { decision: "allow" }
        await advisor.delivered?.(advice.callId, "permission")
        return { decision: "advise", message: firstWriteMessage(advice.text) }
      },
    }
  }
  return handlers
}
