/**
 * OpenCode advisor service (change `unify-runner-system`, task 2.3).
 *
 * Adapts the OpenCode advisor runtime to the neutral advisor service. The
 * OpenCode gate is a **hold**, not a block: the first protected write is held
 * once, the advisor is consulted, and the write is then permitted — including
 * after a failed consultation, so the executor never loses a turn. Consultations
 * share the attempt's session (the advisor reads its transcript), and advisor
 * usage is attributed separately from the executor's.
 */

import type { AdvisorUsage as AdvisorCallUsage } from "../../advisor"
import type { AdvisorRuntime } from "../../advisor-runtime"
import type { AdvisorAdvice, AdvisorConsultation, AdvisorService, Usage } from "../contracts"

export type OpencodeAdvisorService = AdvisorService & {
  /** Release the attempt's session; later consultations find no live advisor. */
  release(): void
}

export type OpencodeAdvisorOptions = {
  runtime: AdvisorRuntime
  sessionID: string
}

/** Folds the per-call advisor usage added during one consultation into neutral `Usage`. */
function usageOf(entries: readonly AdvisorCallUsage[]): Usage | undefined {
  if (entries.length === 0) return undefined
  let input = 0
  let output = 0
  let reasoning = 0
  let cacheRead = 0
  let cacheWrite = 0
  let cost = 0
  for (const entry of entries) {
    input += entry.tokens.input
    output += entry.tokens.output
    reasoning += entry.tokens.reasoning
    cacheRead += entry.tokens.cacheRead
    cacheWrite += entry.tokens.cacheWrite
    cost += entry.cost
  }
  return { input, output, reasoning, cacheRead, cacheWrite, costEstimate: cost }
}

export function createOpencodeAdvisorService(options: OpencodeAdvisorOptions): OpencodeAdvisorService {
  const { runtime, sessionID } = options
  let released = false
  const handle = () => (released ? undefined : runtime.handleFor(sessionID))

  return {
    // A phase with no advisor has no gate to hold; an advised phase holds the
    // first write exactly once.
    get firstWriteGate() {
      return handle() ? "hold" : "none"
    },
    satisfied() {
      const live = handle()
      if (!live) return true
      // The gate consults on the first write and permits work afterwards, even
      // when the consultation failed (a failed consult must not cost a turn).
      return live.calls > 0
    },
    async consult(consultation: AdvisorConsultation): Promise<AdvisorAdvice> {
      const live = handle()
      if (!live) return { text: "no advisor is configured for this attempt", ok: false }
      const before = live.usage.length
      const advice = await live.consult(consultation.trigger, consultation.question)
      const usage = usageOf(live.usage.slice(before))
      return { text: advice.text, ok: advice.ok, ...(usage ? { usage } : {}) }
    },
    release() {
      released = true
    },
  }
}
