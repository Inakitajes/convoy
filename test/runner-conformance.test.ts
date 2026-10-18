import { runExecutionConformance } from "./helpers/runner-conformance"

import { createClaudeRunner, type ClaudeProcess } from "../src/runners/claude/adapter"
import { buildEnforcementPlan } from "../src/runners/compose"

/**
 * The shared conformance suite against the real Claude execution adapter —
 * the production `ExecutionAdapter` — driving a scripted CLI stream instead of
 * a model. (OpenCode attempts run on the run-owned server through the engine's
 * `executeOpencodeAttempt`; their contract is covered by the engine tests.)
 */
function scriptedClaude(): ClaudeProcess {
  const lines = [
    { type: "system", subtype: "init", session_id: "ses_conformance" },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } } },
    { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "ses_conformance" },
  ]
  return {
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(lines.map((line) => JSON.stringify(line)).join("\n") + "\n"))
        controller.close()
      },
    }),
    stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    exited: Promise.resolve(0),
    exitCode: 0,
    kill: () => {},
  }
}

runExecutionConformance("claude-code", () =>
  createClaudeRunner({
    cwd: "/tmp",
    env: { PATH: "/bin" },
    enforcement: buildEnforcementPlan({ hookCommand: "convoy hook", permissionCommand: "convoy-mcp" }),
    deps: { spawn: () => scriptedClaude(), probeAuth: async () => ({ authMethod: "claude.ai" }) },
  }),
)
