/**
 * Session-bound handle release (change `unify-runner-system`, task 4.3).
 *
 * The report and advisor handles are bound to one session and must be released
 * at the phase's decision — never while a human gate is still open — so a late
 * submission from a resolved window cannot reach a later attempt. This is the
 * common, capability-agnostic operation the engine uses; the runner supplies the
 * handle source, core decides when to release.
 */

export type SessionHandle = { end(): void }

/** A runtime that owns handles keyed by session id (report/advisor runtimes). */
export type HandleSource = { handleFor(sessionID: string): SessionHandle | undefined }

/**
 * Ends the handles for one exact session. Idempotent: a handle that was already
 * ended, or a session that never began one, is a no-op.
 */
export function releaseSessionHandles(sessionID: string | undefined, ...sources: readonly (HandleSource | undefined)[]): void {
  if (!sessionID) return
  for (const source of sources) source?.handleFor(sessionID)?.end()
}
