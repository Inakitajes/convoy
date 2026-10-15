/**
 * Claude phase attempt (change `unify-runner-system`, task 4.1).
 *
 * The Claude twin of the OpenCode attempt: same prompt, same attempt-log shape,
 * same report contract (a read-only step's report is the final assistant text),
 * executed by the local `claude` CLI. It lives in the adapter module so the
 * engine has no harness-specific execution branch.
 */

import { fileURLToPath } from "node:url"

import { loadAgentPrompt } from "../../agents"
import { baseAgentName } from "../agent-source"
import { stepRunnerFor } from "../../step-runners"
import { createClaudeRunner } from "./adapter"
import { claudeEnforcementFromEnv } from "./enforcement-plan"
import type { AttemptContext, AttemptResult } from "../attempt"
import type { AttachmentDescriptor, ExecutionMode, ExecutionRequest } from "../contracts"
import type { FilePartInput } from "../../opencode-client"

/** FilePartInput (OpenCode parts) → neutral attachment descriptors. */
export function claudeAttachmentDescriptors(files: readonly FilePartInput[]): AttachmentDescriptor[] {
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
      // A non-file URL cannot be delivered to the CLI; skip it here.
    }
  }
  return descriptors
}

export async function executeClaudeAttempt(context: AttemptContext): Promise<AttemptResult> {
  const phase = context.phase
  const base = baseAgentName(phase.agentName)
  const mode: ExecutionMode = phase.readOnly ? (phase.verify ? "verify" : "read-only") : "write"
  const env = context.env ?? process.env
  const enforcement = claudeEnforcementFromEnv(env)
  const runner = createClaudeRunner({
    cwd: context.targetDir,
    env,
    ...(enforcement ? { enforcement } : {}),
  })

  const request: ExecutionRequest = {
    identity: context.identity,
    runner: "claude-code",
    checkout: context.targetDir,
    agent: {
      name: base,
      mode,
      model: { runner: "claude-code", modelId: phase.model && phase.model.length > 0 ? phase.model : "default" },
      instructions: loadAgentPrompt(base, context.targetDir),
    },
    prompt: context.prompt,
    auth: { mode: "subscription" },
    mode,
    approvals: "auto",
    attachments: claudeAttachmentDescriptors(context.attachments),
    signal: context.signal,
  }

  // The adapter emits neutral events; the engine's sink renders them.
  const outcome = await runner.executeAttempt(request, (event) => context.sink(event))

  return {
    assistantText: outcome.assistantText ?? "",
    ...(outcome.session ? { sessionID: outcome.session.sessionId } : {}),
    model: stepRunnerFor("claude-code").modelLabel(phase.model),
    ...(outcome.finish !== undefined ? { finish: outcome.finish } : {}),
    ...(outcome.usage?.costEstimate !== undefined ? { cost: outcome.usage.costEstimate } : {}),
    ...(outcome.usage ? { tokens: outcome.usage } : {}),
    ...(outcome.error !== undefined ? { error: outcome.error } : {}),
  }
}
