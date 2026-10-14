/**
 * Attempt recovery decisions (change `runner-parity-opencode-v2`, tasks 10.3/10.4).
 *
 * After an interruption, Convoy reconciles what it knows before continuing or
 * retrying: an uncertain prompt admission or write is never retried
 * automatically, a missing/changed target produces an explicit operator choice
 * rather than silently retargeting, and only a fully verified exact session is
 * continued in place.
 */

import type { RunnerSessionRef } from "./contracts"

export type RecoveryEvidence = {
  /** The runner's binary/version is present and supported. */
  runnerAvailable: boolean
  /** A recorded session was reported to still exist (undefined = unknown). */
  sessionExists?: boolean
  /** The checkout is the same verified location as the attempt recorded. */
  checkoutMatches: boolean
  /** The authentication mode is still valid (undefined = unknown). */
  authValid?: boolean
  /** The resolved harness version is still the supported one (undefined = unknown). */
  versionSupported?: boolean
  /** An accepted deliverable is already durable for the attempt. */
  reportAccepted?: boolean
  /** The write/admission outcome could not be confirmed. */
  uncertainOutcome?: boolean
  /** The repository has uncommitted changes. */
  gitDirty?: boolean
}

export type RecoveryDecision = {
  action: "continue-exact" | "retry-fresh" | "request-explicit-choice" | "refuse"
  reasons: string[]
  /** The exact session to continue, when the action is `continue-exact`. */
  session?: RunnerSessionRef
}

/** Decides how to recover an interrupted attempt from durable evidence. */
export function decideRecovery(evidence: RecoveryEvidence, prior: { session?: RunnerSessionRef } = {}): RecoveryDecision {
  const reasons: string[] = []

  if (evidence.uncertainOutcome) {
    return {
      action: "request-explicit-choice",
      reasons: ["the previous prompt or write outcome is unconfirmed; automatic retry could duplicate work"],
    }
  }

  if (!evidence.runnerAvailable) {
    return { action: "refuse", reasons: ["the runner for this attempt is not available"] }
  }
  if (evidence.versionSupported === false) {
    return { action: "request-explicit-choice", reasons: ["the harness version changed since the attempt"] }
  }
  if (!evidence.checkoutMatches) {
    return { action: "request-explicit-choice", reasons: ["the recorded checkout is not the verified target"] }
  }
  if (evidence.authValid === false) {
    return { action: "request-explicit-choice", reasons: ["the authentication mode is no longer valid"] }
  }

  if (prior.session) {
    if (evidence.sessionExists === true) {
      return { action: "continue-exact", reasons: ["the recorded session is available and the target is verified"], session: prior.session }
    }
    if (evidence.sessionExists === false) {
      return { action: "request-explicit-choice", reasons: ["the recorded session no longer exists"] }
    }
    reasons.push("the session's existence is unknown")
    return { action: "request-explicit-choice", reasons }
  }

  if (evidence.reportAccepted) {
    return { action: "continue-exact", reasons: ["an accepted deliverable exists; continue without repeating the write"] }
  }

  return { action: "retry-fresh", reasons: ["no recorded session; a fresh attempt is safe"] }
}
