/**
 * Session-scoped deliverable service (change `unify-runner-system`, task 2.2;
 * shared by both runners since `runner-parity-opencode-v2`).
 *
 * Adapts Convoy's `write_report` runtime (`ReportRuntime`) to the neutral
 * deliverable service — reached by OpenCode's plugin tool and Claude's MCP
 * tool alike — reusing its existing payload validation, its atomic
 * report + commit-sidecar persistence, and its candidate precedence. A
 * submission is addressed to one exact session: once that session's handle is
 * released (retry, abort or the phase decision), a late submission is refused
 * rather than accepted into a later attempt.
 */

import type { ReportRuntime } from "../report-runtime"
import type { DeliverableKind, DeliverableResult, DeliverableService, DeliverableSubmission } from "./contracts"

export type SessionDeliverableService = DeliverableService & {
  /** Release the attempt's session; every later submission is refused as stale. */
  release(): void
}

export type SessionDeliverableOptions = {
  runtime: ReportRuntime
  /** A fixed session id, or a getter when the session is known only after creation. */
  sessionID?: string
  session?: () => string | undefined
  /** Artifacts this attempt's contract expects; defaults to a report. */
  expected?: readonly DeliverableKind[]
  /** Core's contract check for the candidate so far (falls back to the report file). */
  accepts?: (candidate: string | undefined) => Promise<boolean>
}

type Mapped = { ok: true; payload: unknown } | { ok: false; error: string }

/**
 * Maps a neutral submission onto the OpenCode `write_report` call. OpenCode has
 * one call: a report carries its optional structured commit metadata, and a
 * scoring agent supplies its dimensions in that same call (Convoy derives the
 * numeric score). A separate commit-description artifact does not exist here,
 * and a raw `{ score }` body is rejected exactly as the tool boundary does.
 */
export function toWriteReportPayload(submission: DeliverableSubmission): Mapped {
  if (submission.kind === "commit-description") {
    return { ok: false, error: "OpenCode carries commit metadata on the report submission, not as a separate artifact" }
  }
  const commit = submission.commit
    ? { subject: submission.commit.subject, ...(submission.commit.details ? { details: [...submission.commit.details] } : {}) }
    : undefined
  if (submission.kind === "report") {
    return { ok: true, payload: { markdown: submission.body, ...(commit ? { commit } : {}) } }
  }

  // score: the OpenCode tool takes the dimension fields, not a raw score.
  let parsed: unknown
  try {
    parsed = JSON.parse(submission.body)
  } catch {
    return { ok: false, error: "score must be valid JSON" }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "score JSON must be an object" }
  }
  if (typeof (parsed as { markdown?: unknown }).markdown !== "string") {
    return { ok: false, error: "score must include the report markdown" }
  }
  return { ok: true, payload: parsed }
}

export function createSessionDeliverableService(options: SessionDeliverableOptions): SessionDeliverableService {
  const { runtime } = options
  const sessionOf = () => (options.session ? options.session() : options.sessionID)
  let released = false

  return {
    expected: options.expected ?? ["report"],
    release() {
      released = true
    },
    candidate() {
      const id = sessionOf()
      return id ? runtime.handleFor(id)?.candidate : undefined
    },
    ...(options.accepts
      ? {
          accepted: async () => {
            const id = sessionOf()
            return await options.accepts!(id ? runtime.handleFor(id)?.candidate : undefined)
          },
        }
      : {}),
    async submit(submission: DeliverableSubmission): Promise<DeliverableResult> {
      if (released) {
        return { ok: false, error: "the attempt's report session was released", retryable: false, preserved: false }
      }
      const id = sessionOf()
      const handle = id ? runtime.handleFor(id) : undefined
      if (!handle) {
        return { ok: false, error: "no live report session for this attempt", retryable: false, preserved: false }
      }
      const mapped = toWriteReportPayload(submission)
      if (!mapped.ok) {
        return { ok: false, error: mapped.error, retryable: true, preserved: handle.candidate !== undefined }
      }
      const written = await handle.write(mapped.payload)
      if ("error" in written) {
        return { ok: false, error: written.error, retryable: true, preserved: handle.candidate !== undefined }
      }
      return { ok: true }
    },
  }
}
