/**
 * Quiesced handoff (change `runner-parity-opencode-v2`, task 11.2).
 *
 * A handoff transfers human control without ever running two writers: the prior
 * writer is quiesced and verified stopped, the session checkpoint is persisted,
 * and only then is writer authority transferred and the session opened. The
 * ordered steps are enforced, so opening cannot happen before the transfer.
 */

export type HandoffStep = "quiesce" | "verify-no-write" | "persist-checkpoint" | "transfer-writer" | "open-session"

export const handoffSequence: readonly HandoffStep[] = [
  "quiesce",
  "verify-no-write",
  "persist-checkpoint",
  "transfer-writer",
  "open-session",
]

export type HandoffState = {
  quiesced?: boolean
  writeVerifiedStopped?: boolean
  checkpointPersisted?: boolean
  writerTransferred?: boolean
  opened?: boolean
}

export class HandoffError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HandoffError"
  }
}

/** The next step to perform, or "done"/"blocked". */
export function nextHandoffStep(state: HandoffState): HandoffStep | "done" {
  for (const step of handoffSequence) {
    if (step === "quiesce" && !state.quiesced) return step
    if (step === "verify-no-write" && !state.writeVerifiedStopped) return step
    if (step === "persist-checkpoint" && !state.checkpointPersisted) return step
    if (step === "transfer-writer" && !state.writerTransferred) return step
    if (step === "open-session" && !state.opened) return step
  }
  return "done"
}

/** True only when every step completed in order. */
export function isHandoffComplete(state: HandoffState): boolean {
  return nextHandoffStep(state) === "done"
}

/**
 * Guards a state transition: the step must be the next one in sequence, so no
 * caller can open a session before authority has been transferred.
 */
export function advanceHandoff(state: HandoffState, step: HandoffStep): HandoffState {
  const expected = nextHandoffStep(state)
  if (expected === "done") throw new HandoffError("the handoff is already complete")
  if (expected !== step) throw new HandoffError(`cannot perform ${step} before ${expected}`)
  return { ...state, [stepKey(step)]: true }
}

function stepKey(step: HandoffStep): keyof HandoffState {
  switch (step) {
    case "quiesce":
      return "quiesced"
    case "verify-no-write":
      return "writeVerifiedStopped"
    case "persist-checkpoint":
      return "checkpointPersisted"
    case "transfer-writer":
      return "writerTransferred"
    case "open-session":
      return "opened"
  }
}

/** Throws if a session would be opened without writer authority transferred. */
export function assertAuthorityBeforeOpen(state: HandoffState): void {
  if (state.opened && !state.writerTransferred) {
    throw new HandoffError("refusing to open a session before writer authority is transferred")
  }
}
