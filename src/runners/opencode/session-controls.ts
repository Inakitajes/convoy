/**
 * OpenCode session facets (change `unify-runner-system`, task 2.6).
 *
 * Exposes the adapter's existing session machinery through the common,
 * capability-gated session operations. `history` reconstructs the recorded
 * transcript from the server (never fabricates it; an unavailable session is an
 * honest failure); `attach` and `resume` are present only when the composition
 * supplies the underlying opener/continuation, so the facet never claims a
 * control the runner cannot honor.
 */

import type { SessionAttachResult, SessionControls, SessionHistoryResult, SessionResumeRequest, SessionResumeResult } from "../contracts"

/** The slice of the OpenCode adapter the session facets need. */
export type OpencodeSessionRunner = {
  backfillEvents(sessionId: string, attempt: number): Promise<import("../contracts").RunnerEvent[]>
}

export type OpencodeSessionOptions = {
  runner: OpencodeSessionRunner
  /**
   * Opens a live session window for a human, returning the backend that opened
   * it. Supplying it enables `attach`; the closure carries the run's directory
   * and server coordinates.
   */
  openWindow?: (sessionId: string) => Promise<{ backend: string }>
  /** Continues an exact recorded session; supplying it enables `resume`. */
  continueSession?: (request: SessionResumeRequest) => Promise<SessionResumeResult>
}

export function createOpencodeSessionControls(options: OpencodeSessionOptions): SessionControls {
  const { runner } = options
  const controls: SessionControls = {
    async history({ session, identity }): Promise<SessionHistoryResult> {
      if (session.runner !== "opencode") {
        return { ok: false, error: `not an opencode session: ${session.runner}` }
      }
      try {
        const events = await runner.backfillEvents(session.sessionId, identity.attempt)
        return { ok: true, events }
      } catch (error) {
        // A server that cannot return the session has nothing to merge; never
        // invent transcript content.
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }

  if (options.openWindow) {
    const openWindow = options.openWindow
    controls.attach = async ({ session }): Promise<SessionAttachResult> => {
      if (session.runner !== "opencode") return { ok: false, error: `not an opencode session: ${session.runner}` }
      try {
        const opened = await openWindow(session.sessionId)
        return { ok: true, detail: opened.backend }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  }

  if (options.continueSession) {
    const continueSession = options.continueSession
    controls.resume = async (request): Promise<SessionResumeResult> => {
      if (request.session.runner !== "opencode") {
        return { ok: false, error: `not an opencode session: ${request.session.runner}` }
      }
      return continueSession(request)
    }
  }

  return controls
}
