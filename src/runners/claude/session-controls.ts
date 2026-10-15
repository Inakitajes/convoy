/**
 * Claude session facets (change `unify-runner-system`, task 3.5).
 *
 * Reconciles the session operations with Claude's effective capabilities: print
 * mode does not expose a recorded transcript, so `history` always refuses
 * (`session-history` is advertised unavailable), while `resume` and `attach`
 * are present only when the composition supplies the underlying continuation or
 * window opener.
 */

import type { SessionControls, SessionHistoryResult, SessionResumeRequest, SessionResumeResult, SessionAttachResult } from "../contracts"

export type ClaudeSessionOptions = {
  /** Opens a live session window for a human; supplying it enables `attach`. */
  openWindow?: (sessionId: string) => Promise<{ backend: string }>
  /** Continues an exact recorded session; supplying it enables `resume`. */
  continueSession?: (request: SessionResumeRequest) => Promise<SessionResumeResult>
}

export function createClaudeSessionControls(options: ClaudeSessionOptions = {}): SessionControls {
  const controls: SessionControls = {
    async history({ session }): Promise<SessionHistoryResult> {
      // Print mode has no recorded transcript to reconstruct; the engine gates
      // this on `session-history`, so it should never be reached.
      return { ok: false, error: `Claude does not reconstruct a recorded transcript (${session.runner})` }
    },
  }

  if (options.openWindow) {
    const openWindow = options.openWindow
    controls.attach = async ({ session }): Promise<SessionAttachResult> => {
      if (session.runner !== "claude-code") return { ok: false, error: `not a claude-code session: ${session.runner}` }
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
      if (request.session.runner !== "claude-code") {
        return { ok: false, error: `not a claude-code session: ${request.session.runner}` }
      }
      return continueSession(request)
    }
  }

  return controls
}
