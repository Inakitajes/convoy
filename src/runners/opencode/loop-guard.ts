/**
 * OpenCode loop-guard service (change `unify-runner-system`, task 2.4).
 *
 * Feeds the neutral observations into Convoy's shared loop guard and turns its
 * trip into a continue/nudge/stop decision, so the engine applies one guard
 * policy rather than an OpenCode-shaped one. Repeated-call and repeated-failure
 * detection keep the stable call id and effective arguments; usage keeps the
 * message id so cumulative figures are folded as a delta and never
 * double-counted.
 */

import { LoopGuard, type LoopGuardObservation, type LoopGuardTrip } from "../../loop-guard"
import type { LoopDecision, LoopGuardService, LoopObservation } from "../contracts"

/** Maps a neutral observation onto the guard's own observation vocabulary. */
export function toGuardObservation(observation: LoopObservation): LoopGuardObservation | undefined {
  switch (observation.kind) {
    case "call":
      return { kind: "call", name: observation.tool, input: observation.args, callID: observation.callId }
    case "result":
      return { kind: "result", name: observation.tool, callID: observation.callId, failed: observation.failed }
    case "step":
      return { kind: "step" }
    case "usage": {
      // The cost fuse is fed per assistant message; without an estimate there is
      // nothing for it to accumulate.
      const cost = observation.usage.costEstimate
      if (typeof cost !== "number") return undefined
      return { kind: "cost", messageID: observation.messageId ?? "message", cost }
    }
  }
}

/** Turns a guard trip into the decision an adapter must apply. */
export function decideFromTrip(trip: LoopGuardTrip): LoopDecision {
  if (trip.reason === "soft-nudge") return { action: "nudge", reason: trip.message }
  return { action: "stop", code: trip.reason, reason: trip.message }
}

export function createOpencodeLoopGuardService(guard: LoopGuard): LoopGuardService {
  return {
    observe(observation: LoopObservation): LoopDecision {
      const mapped = toGuardObservation(observation)
      if (!mapped) return { action: "continue" }
      const trip = guard.observe(mapped)
      return trip ? decideFromTrip(trip) : { action: "continue" }
    },
  }
}
