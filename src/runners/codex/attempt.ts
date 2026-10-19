/**
 * Codex phase attempt (change `add-codex-runner`).
 *
 * The Codex twin of the Claude attempt: the same prompt, attempt-log shape and
 * report contract, executed on an owned `codex app-server`. It lives in the
 * adapter module so the engine has no harness-specific execution branch.
 */

import { fileURLToPath } from "node:url"

import { loadAgentPrompt } from "../../agents"
import { stepRunnerFor } from "../../step-runners"
import { baseAgentName } from "../agent-source"
import type { AttemptContext, AttemptResult } from "../attempt"
import type { AttachmentDescriptor, ExecutionMode, ExecutionRequest } from "../contracts"
import { convoySubcommandArgv } from "../subcommand"
import type { FilePartInput } from "../../opencode-client"
import { createCodexRunner, type CodexRunner } from "./adapter"

/** The argv of Convoy's MCP host: an environment override, else this Convoy's own `mcp` subcommand. */
export function codexMcpHost(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.CONVOY_CODEX_MCP_COMMAND
  return override ? override.split(" ").filter((part) => part.length > 0) : convoySubcommandArgv("mcp")
}

/** FilePartInput (OpenCode parts) → neutral attachment descriptors. */
export function codexAttachmentDescriptors(files: readonly FilePartInput[]): AttachmentDescriptor[] {
  const descriptors: AttachmentDescriptor[] = []
  for (const file of files) {
    try {
      descriptors.push({
        kind: file.mime === "application/x-directory" ? "directory" : "file",
        path: fileURLToPath(file.url),
        mime: file.mime,
        ...(file.filename ? { filename: file.filename } : {}),
      })
    } catch {
      // A non-file URL cannot be named to the agent by path; skip it here.
    }
  }
  return descriptors
}

/** Runs one Codex phase attempt on the composed adapter; a standalone call builds its own. */
export async function executeCodexAttempt(context: AttemptContext, adapter?: CodexRunner): Promise<AttemptResult> {
  const phase = context.phase
  const base = baseAgentName(phase.agentName)
  const mode: ExecutionMode = phase.readOnly ? (phase.verify ? "verify" : "read-only") : "write"
  const env = context.env ?? process.env
  const runner = adapter ?? createCodexRunner({ cwd: context.targetDir, env, mcpHost: codexMcpHost(env) })

  const request: ExecutionRequest = {
    identity: context.identity,
    runner: "codex",
    checkout: context.targetDir,
    agent: {
      name: base,
      mode,
      model: {
        runner: "codex",
        modelId: phase.model && phase.model.length > 0 ? phase.model : "default",
        ...(phase.variant ? { effort: phase.variant } : {}),
      },
      instructions: loadAgentPrompt(base, context.targetDir),
    },
    prompt: context.prompt,
    auth: context.auth ?? { mode: "subscription" },
    mode,
    approvals: context.policy?.approvals ?? "auto",
    ...(context.policy ? { policy: context.policy } : {}),
    ...(phase.resolvedAdvisor ? { advised: true } : {}),
    attachments: codexAttachmentDescriptors(context.attachments),
    ...(context.streamLogPath ? { streamLogPath: context.streamLogPath } : {}),
    signal: context.signal,
  }

  const outcome = await runner.executeAttempt(request, (event) => context.sink(event), context.services)

  return {
    assistantText: outcome.assistantText ?? "",
    ...(outcome.session ? { sessionID: outcome.session.sessionId } : {}),
    model: stepRunnerFor("codex").modelLabel(phase.model, phase.variant),
    ...(outcome.finish !== undefined ? { finish: outcome.finish } : {}),
    ...(outcome.usage?.costEstimate !== undefined ? { cost: outcome.usage.costEstimate } : {}),
    ...(outcome.usage ? { tokens: outcome.usage } : {}),
    ...(outcome.error !== undefined ? { error: outcome.error } : {}),
  }
}
