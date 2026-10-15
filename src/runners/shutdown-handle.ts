/**
 * The shutdown surface an attempt runtime needs (change `unify-runner-system`,
 * task 2.1). The engine's `RunShutdown` satisfies it structurally, so an adapter
 * never imports the engine.
 */

import type { OpencodeClient } from "../opencode-client"
import type { ProgressUI } from "../progress"

export type ShutdownHandle = {
  readonly signal: AbortSignal
  readonly aborted: boolean
  throwIfRequested(): void
  setActiveSession(session: { client: OpencodeClient; sessionID: string; directory: string; phaseName: string }): void
  clearActiveSession(phaseName: string, sessionID: string): void
  abortActiveSessions(progress?: ProgressUI): Promise<void>
}
