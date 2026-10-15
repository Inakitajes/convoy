import { runExecutionConformance, makeRequest } from "./helpers/runner-conformance"

import type { ExecutionAdapter, ExecutionRequest, RunnerEvent, RunnerId } from "../src/runners/contracts"

/**
 * A vendor-free double used to exercise the shared conformance suite today.
 * When the real OpenCode v2 and Claude adapters land (groups 4 and 5) they call
 * `runExecutionConformance` from their own tests, so the contract is asserted in
 * exactly one place.
 */
function doubleAdapter(id: RunnerId): ExecutionAdapter {
  return {
    id,
    async capabilities() {
      return { runner: id, version: "double", capabilities: [{ id: "write", availability: "available" }] }
    },
    async executeAttempt(request: ExecutionRequest, sink: (event: RunnerEvent) => void) {
      sink({ type: "session", runner: id, attempt: request.identity.attempt, session: { runner: id, sessionId: "ses_double" } })
      sink({ type: "text", runner: id, attempt: request.identity.attempt, text: "ok" })
      sink({ type: "terminal", runner: id, attempt: request.identity.attempt, outcome: { status: "completed", finish: "stop" } })
      return { status: "completed", finish: "stop" }
    },
    async cancelAttempt() {},
  }
}

runExecutionConformance("opencode", () => doubleAdapter("opencode"))
runExecutionConformance("claude-code", () => doubleAdapter("claude-code"))

// Keep the helper's request factory exercised so it stays in step with the contract.
void makeRequest()
