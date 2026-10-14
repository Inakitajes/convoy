/**
 * Runner-neutral deliverable contracts (change `runner-parity-opencode-v2`,
 * tasks 7.1–7.3, design D8).
 *
 * Every supported runner submits the same three artifacts — a Markdown report,
 * a structured score, and an optional structured commit description — through
 * one validator and one ledger. Convoy, not the agent, owns the attempt identity
 * and the destination: a submission carries no path, so a tool call cannot
 * redirect an artifact to a sibling attempt or an arbitrary file.
 *
 * The ledger accepts at most one artifact per `(kind, attempt)`, bounds how many
 * corrections an attempt may make, and — the property that matters most — keeps
 * the last accepted artifact when a malformed replacement arrives. A runner
 * process exiting successfully never implies a valid deliverable; that
 * distinction lives here and in the validation, not in the harness.
 */

export type DeliverableKind = "report" | "score" | "commit-description"

/** Convoy-owned attempt identity. The submission cannot override it. */
export type DeliverableAttempt = {
  runId: string
  phase: string
  attempt: number
}

export type DeliverableSubmission = {
  kind: DeliverableKind
  attempt: DeliverableAttempt
  body: string
}

export type DeliverableValidation = { ok: true } | { ok: false; error: string }

/** The score contract's inclusive upper bound. */
export const maxDeliverableScore = 100
/** One subject line plus at most this many detail lines. */
export const maxDeliverableDetailLines = 3
/** Boundary guard mirroring the commit-description tool field limit. */
export const maxDeliverableLineChars = 300

export type DeliverableValidationOptions = {
  /** Inclusive upper bound for `score` submissions; defaults to 100. */
  maxScore?: number
}

function attemptError(attempt: unknown): string | undefined {
  if (typeof attempt !== "object" || attempt === null) return "deliverable attempt is required"
  const record = attempt as Record<string, unknown>
  if (typeof record.runId !== "string" || record.runId.trim() === "") return "attempt.runId must be a non-empty string"
  if (typeof record.phase !== "string" || record.phase.trim() === "") return "attempt.phase must be a non-empty string"
  if (typeof record.attempt !== "number" || !Number.isInteger(record.attempt) || record.attempt < 1) {
    return "attempt.attempt must be a positive integer"
  }
  return undefined
}

function validateReport(body: string): DeliverableValidation {
  if (body.trim() === "") return { ok: false, error: "report must be non-empty markdown" }
  return { ok: true }
}

function validateScore(body: string, maxScore: number): DeliverableValidation {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { ok: false, error: "score must be valid JSON" }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "score JSON must be an object" }
  }
  const score = (parsed as Record<string, unknown>).score
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return { ok: false, error: "score must be a finite number" }
  }
  if (score < 0 || score > maxScore) {
    return { ok: false, error: `score must be between 0 and ${maxScore}` }
  }
  return { ok: true }
}

function validateCommitDescription(body: string): DeliverableValidation {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) return { ok: false, error: "commit description needs a subject line" }
  const subject = lines[0]
  if (subject.length > maxDeliverableLineChars) {
    return { ok: false, error: `commit subject must be at most ${maxDeliverableLineChars} characters` }
  }
  const details = lines.slice(1)
  if (details.length > maxDeliverableDetailLines) {
    return { ok: false, error: `commit description allows at most ${maxDeliverableDetailLines} detail lines` }
  }
  for (const detail of details) {
    if (detail.length > maxDeliverableLineChars) {
      return { ok: false, error: `commit detail must be at most ${maxDeliverableLineChars} characters` }
    }
  }
  return { ok: true }
}

/**
 * Validates one submission against its contract. Report: non-empty Markdown.
 * Score: valid JSON with a finite numeric `score` in `0..maxScore`. Commit
 * description: one subject line plus at most three detail lines.
 */
export function validateDeliverable(
  submission: DeliverableSubmission,
  options: DeliverableValidationOptions = {},
): DeliverableValidation {
  if (typeof submission !== "object" || submission === null) return { ok: false, error: "deliverable submission must be an object" }
  const identity = attemptError(submission.attempt)
  if (identity) return { ok: false, error: identity }
  if (typeof submission.body !== "string") return { ok: false, error: "deliverable body must be a string" }

  switch (submission.kind) {
    case "report":
      return validateReport(submission.body)
    case "score":
      return validateScore(submission.body, options.maxScore ?? maxDeliverableScore)
    case "commit-description":
      return validateCommitDescription(submission.body)
    default:
      return { ok: false, error: `unknown deliverable kind: ${String((submission as { kind?: unknown }).kind)}` }
  }
}

// ---------------------------------------------------------------------------
// Accepted-artifact ledger
// ---------------------------------------------------------------------------

/** An artifact Convoy accepted for one attempt, persisted before acknowledgement. */
export type AcceptedDeliverable = {
  kind: DeliverableKind
  attempt: DeliverableAttempt
  body: string
  acceptedAt: number
}

export type DeliverableLedgerOptions = {
  /** Extra submissions allowed after the first. `0` disallows correction. */
  maxCorrections?: number
  maxScore?: number
  now?: () => number
}

export type DeliverableSubmissionResult =
  | { ok: true; accepted: AcceptedDeliverable; correctionsRemaining: number }
  | {
      ok: false
      error: string
      correctionsRemaining: number
      /** True once no correction remains; the caller should fail the phase. */
      limitReached: boolean
      /** The last valid artifact for this attempt, preserved intact. */
      candidate?: AcceptedDeliverable
    }

export type DeliverableLedgerSnapshot = {
  version: 1
  maxCorrections: number
  maxScore: number
  accepted: readonly AcceptedDeliverable[]
  /** Submissions processed per key, so a restart resumes the correction bound. */
  submissions: Record<string, number>
}

export const defaultMaxCorrections = 3

function attemptKey(kind: DeliverableKind, attempt: DeliverableAttempt): string {
  return `${kind}\u0000${attempt.runId}\u0000${attempt.phase}\u0000${attempt.attempt}`
}

/**
 * Holds accepted artifacts for a run. One entry per `(kind, attempt)`; a valid
 * replacement overwrites it exactly once, and a malformed replacement leaves the
 * previous artifact untouched while consuming the correction budget.
 */
export class DeliverableLedger {
  private readonly maxCorrections: number
  private readonly maxScore: number
  private readonly now: () => number
  private readonly acceptedByKey = new Map<string, AcceptedDeliverable>()
  private readonly submissions = new Map<string, number>()

  constructor(options: DeliverableLedgerOptions = {}) {
    this.maxCorrections = Math.max(0, options.maxCorrections ?? defaultMaxCorrections)
    this.maxScore = options.maxScore ?? maxDeliverableScore
    this.now = options.now ?? Date.now
  }

  /** Records one submission, applying the contract, correction bound, and preservation rule. */
  submit(submission: DeliverableSubmission): DeliverableSubmissionResult {
    const identity = attemptError(submission?.attempt)
    if (identity) {
      return { ok: false, error: identity, correctionsRemaining: 0, limitReached: true }
    }

    const key = attemptKey(submission.kind, submission.attempt)
    const allowance = 1 + this.maxCorrections
    const used = this.submissions.get(key) ?? 0
    const candidate = this.acceptedByKey.get(key)

    if (used >= allowance) {
      return {
        ok: false,
        error: `correction limit reached (${this.maxCorrections})`,
        correctionsRemaining: 0,
        limitReached: true,
        ...(candidate ? { candidate } : {}),
      }
    }

    const validation = validateDeliverable(submission, { maxScore: this.maxScore })
    this.submissions.set(key, used + 1)
    const correctionsRemaining = Math.max(0, allowance - (used + 1))

    if (!validation.ok) {
      // A malformed replacement must never erase the last valid artifact.
      return {
        ok: false,
        error: validation.error,
        correctionsRemaining,
        limitReached: correctionsRemaining === 0,
        ...(candidate ? { candidate } : {}),
      }
    }

    const accepted: AcceptedDeliverable = {
      kind: submission.kind,
      attempt: submission.attempt,
      body: submission.body,
      acceptedAt: this.now(),
    }
    this.acceptedByKey.set(key, accepted)
    return { ok: true, accepted, correctionsRemaining }
  }

  /** The accepted artifact for an attempt, when one exists. */
  accepted(kind: DeliverableKind, attempt: DeliverableAttempt): AcceptedDeliverable | undefined {
    return this.acceptedByKey.get(attemptKey(kind, attempt))
  }

  /** Every accepted artifact, in insertion order. */
  acceptedList(): readonly AcceptedDeliverable[] {
    return [...this.acceptedByKey.values()]
  }

  /** Serializable state for recovery; contains bodies but no secrets. */
  snapshot(): DeliverableLedgerSnapshot {
    return {
      version: 1,
      maxCorrections: this.maxCorrections,
      maxScore: this.maxScore,
      accepted: [...this.acceptedByKey.values()],
      submissions: Object.fromEntries(this.submissions),
    }
  }

  /** Rebuilds a ledger from `snapshot()`, so recovery reuses identity and bounds. */
  static restore(snapshot: DeliverableLedgerSnapshot, options: DeliverableLedgerOptions = {}): DeliverableLedger {
    if (snapshot.version !== 1) throw new Error(`unsupported deliverable snapshot version: ${String(snapshot.version)}`)
    const ledger = new DeliverableLedger({
      maxCorrections: options.maxCorrections ?? snapshot.maxCorrections,
      maxScore: options.maxScore ?? snapshot.maxScore,
      ...(options.now ? { now: options.now } : {}),
    })
    for (const accepted of snapshot.accepted) {
      ledger.acceptedByKey.set(attemptKey(accepted.kind, accepted.attempt), accepted)
    }
    for (const [key, count] of Object.entries(snapshot.submissions)) {
      ledger.submissions.set(key, count)
    }
    return ledger
  }
}
