/**
 * The loop-guard service (change `unify-runner-system`, task 2.4), shared by
 * every runner that can apply a nudge or a stop.
 *
 * Feeds the neutral observations into Convoy's shared loop guard and turns its
 * trip into a continue/nudge/stop decision, so the engine applies one guard
 * policy rather than an OpenCode-shaped one. Repeated-call and repeated-failure
 * detection keep the stable call id and effective arguments; usage keeps the
 * message id so cumulative figures are folded as a delta and never
 * double-counted.
 */

import { LoopGuard, type LoopGuardObservation, type LoopGuardTrip } from "../loop-guard"
import type { LoopDecision, LoopGuardService, LoopObservation } from "./contracts"

/** Maps a neutral observation onto the guard's own observation vocabulary. */
export function toGuardObservation(observation: LoopObservation): LoopGuardObservation | undefined {
  switch (observation.kind) {
    case "call":
      return { kind: "call", name: observation.tool, input: observation.args, callID: observation.callId }
    case "named":
      return { kind: "named", name: observation.tool, callID: observation.callId }
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

/** Maps the guard's own observation onto the neutral vocabulary (the inverse). */
export function toNeutralObservation(observation: LoopGuardObservation): LoopObservation {
  switch (observation.kind) {
    case "call":
      return { kind: "call", tool: observation.name ?? "tool", args: observation.input, callId: observation.callID }
    case "named":
      return { kind: "named", tool: observation.name, callId: observation.callID }
    case "result":
      return { kind: "result", tool: observation.name, callId: observation.callID, failed: observation.failed }
    case "step":
      return { kind: "step" }
    case "cost":
      return { kind: "usage", usage: { costEstimate: observation.cost }, messageId: observation.messageID }
  }
}

/** Turns a guard trip into the decision an adapter must apply. */
export function decideFromTrip(trip: LoopGuardTrip): LoopDecision {
  if (trip.reason === "soft-nudge") return { action: "nudge", reason: trip.message }
  return { action: "stop", code: trip.reason, reason: trip.message }
}

export function createLoopGuardService(guard: LoopGuard): LoopGuardService {
  return {
    observe(observation: LoopObservation): LoopDecision {
      const mapped = toGuardObservation(observation)
      if (!mapped) return { action: "continue" }
      const trip = guard.observe(mapped)
      return trip ? decideFromTrip(trip) : { action: "continue" }
    },
  }
}

/** The OpenCode binding's historical name for the shared service. */
export const createOpencodeLoopGuardService = createLoopGuardService
