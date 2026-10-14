/**
 * Conversation planning (change `runner-parity-opencode-v2`, tasks 11.1/11.2).
 *
 * Observation, native live attach, an explicit quiesced handoff, and post-exit
 * resume are four different operations. This module decides which is available
 * for a runner from its effective capabilities and the current writer/session
 * state, instead of conflating "cannot attach" with "cannot observe".
 */

import { isAvailable, type RunnerCapabilities, type RunnerId, type RunnerSessionRef } from "./contracts"

export type ConversationMode = "observe" | "native-attach" | "quiesced-handoff" | "post-exit-resume"

export type ConversationPlan = {
  ok: boolean
  mode: ConversationMode
  runner: RunnerId
  /** Ordered operations the caller must perform for this mode. */
  steps: string[]
  reason?: string
}

export function planConversation(input: {
  requested: ConversationMode
  runner: RunnerId
  capabilities: RunnerCapabilities
  session?: RunnerSessionRef
  sessionRunning?: boolean
  /** A different managed writer already holds the checkout. */
  anotherWriterHolds?: boolean
}): ConversationPlan {
  const { requested, runner, capabilities } = input
  const fail = (reason: string, steps: string[] = []): ConversationPlan => ({ ok: false, mode: requested, runner, steps, reason })

  if (input.session && input.session.runner !== runner) {
    return fail("the recorded session belongs to a different runner")
  }

  switch (requested) {
    case "observe":
      return { ok: true, mode: requested, runner, steps: ["observe"] }
    case "native-attach":
      return isAvailable(capabilities, "native-live-attach")
        ? { ok: true, mode: requested, runner, steps: ["open-attached-client"] }
        : fail("this runner has no supported native live attach", ["observe"])
    case "quiesced-handoff":
      if (!isAvailable(capabilities, "explicit-handoff")) return fail("this runner has no verified quiesced handoff", ["observe"])
      if (input.anotherWriterHolds) return fail("another managed writer holds this checkout")
      return {
        ok: true,
        mode: requested,
        runner,
        steps: ["quiesce", "verify-no-write", "persist-checkpoint", "transfer-writer", "open-session"],
      }
    case "post-exit-resume":
      if (!input.session) return fail("no recorded session to resume")
      if (input.sessionRunning) return fail("the session is still running; use attach or a handoff instead", ["observe", "native-attach"])
      return { ok: true, mode: requested, runner, steps: ["validate-target", "open-exact-session"] }
    default:
      return fail("unknown conversation mode")
  }
}
