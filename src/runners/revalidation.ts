/**
 * Interactive revalidation (change `runner-parity-opencode-v2`, task 11.3).
 *
 * Before handing a run to a human — and again after an external shell starts the
 * client — Convoy revalidates that the target, session, authentication mode, and
 * harness version are still what was reviewed. A changed credential, a moved or
 * reused path, a missing session, or a stale binary must produce an explicit
 * refusal rather than silently changing the execution target or billing.
 */

import type { AuthenticationMode, RunnerSessionRef } from "./contracts"

export type InteractiveTarget = {
  checkout: string
  session?: RunnerSessionRef
  authMode: AuthenticationMode
  /** Major version of the resolved harness, when known. */
  versionMajor?: number
}

export type RevalidationInput = {
  previous: InteractiveTarget
  current: {
    /** False when the checkout is no longer the verified incarnation. */
    checkoutMatches: boolean
    /** Whether the recorded session still exists (undefined = unknown). */
    sessionExists?: boolean
    authMode: AuthenticationMode
    versionMajor?: number
  }
}

export type Revalidation = { ok: true } | { ok: false; reasons: string[] }

const supportedMajor = 2

/** Revalidates an interactive entry/return against the reviewed target. */
export function revalidateInteractive(input: RevalidationInput): Revalidation {
  const reasons: string[] = []
  const { previous, current } = input

  if (!current.checkoutMatches) reasons.push("the checkout is no longer the verified target")

  if (previous.session) {
    if (current.sessionExists === false) reasons.push("the recorded session no longer exists")
    else if (current.sessionExists === undefined) reasons.push("the recorded session's existence is unknown")
  }

  if (current.authMode !== previous.authMode) reasons.push("the authentication mode changed since review")

  if (current.versionMajor !== undefined && current.versionMajor !== supportedMajor) {
    reasons.push(`the harness major version ${current.versionMajor} is not supported`)
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}
