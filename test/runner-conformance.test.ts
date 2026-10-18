import { runExecutionConformance } from "./helpers/runner-conformance"

import { createClaudeRunner, type ClaudeProcess } from "../src/runners/claude/adapter"
import { createCodexRunner } from "../src/runners/codex/adapter"
import { buildEnforcementPlan } from "../src/runners/compose"
import { completeTurn, defaultCodexHandlers, fakeCodex } from "./helpers/fake-codex"

/**
 * The shared conformance suite against the real Claude and Codex execution
 * adapters — the production `ExecutionAdapter`s — driving a scripted CLI
 * stream or app-server instead of a model. (OpenCode attempts run on the run-owned server through the engine's
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

runExecutionConformance("codex", () =>
  createCodexRunner({
    cwd: "/tmp",
    env: { PATH: "/bin" },
    deps: {
      spawn: fakeCodex(
        defaultCodexHandlers({
          "turn/start": (_params, server) => {
            setTimeout(() => completeTurn(server, "ok"), 0)
            return { turn: { id: "turn-1", status: "inProgress" } }
          },
        }),
      ).spawn,
    },
  }),
)
