/**
 * OpenCode phase attempt (change `unify-runner-system`, task 4.1).
 *
 * Hosts the rich OpenCode attempt in the adapter module so the engine has no
 * harness-specific execution branch. The engine prepares one `AttemptContext`
 * and dispatches through the registry; this function runs the attempt and
 * normalizes the result for the attempt log.
 */

import type { AttemptContext, AttemptResult } from "../attempt"
import { sinkProgress } from "../attempt-sink"
import { promptPhase } from "./phase"
import { combinedAssistantUsage, extractAssistantText } from "./session"

export async function executeOpencodeAttempt(context: AttemptContext): Promise<AttemptResult> {
  if (!context.client) throw new Error("opencode attempt requires the run's client")
  // The attempt renders through the neutral sink; it never receives the
  // engine's progress target (task 6.2).
  const progress = sinkProgress(context.sink, context.runner, context.attempt)
  const result = await promptPhase(context.client, {
    phase: context.phase,
    workspace: context.workspace,
    targetDir: context.targetDir,
    prompt: context.prompt,
    model: context.model,
    attachments: context.attachments,
    progress,
    signal: context.signal,
    sessionRef: context.sessionRef,
    attempt: context.attempt,
    ...(context.services.loopGuard ? { loopGuard: context.services.loopGuard } : {}),

    ...(context.advisors ? { advisors: context.advisors } : {}),
    ...(context.reports ? { reports: context.reports } : {}),
    ...(context.deliverableContract ? { deliverableContract: context.deliverableContract } : {}),
    ...(context.rubricWeights ? { rubricWeights: context.rubricWeights } : {}),
  })
  const assistantText = extractAssistantText(result.lastAssistantParts)
  // Totals for the whole attempt, not the final message: the attempt log's
  // executor figures are what the advisor split is measured against, and a
  // headline ratio computed from one message of a many-message phase would
  // understate the executor by however much it happened to do first.
  const usage = combinedAssistantUsage(result.assistantInfos, result.info.sessionID)
  return {
    assistantText,
    sessionID: result.info.sessionID,
    model: context.model,
    finish: result.info.finish,
    cost: usage?.cost ?? result.info.cost,
    tokens: usage?.tokens ?? result.info.tokens,
    error: result.info.error,
    ...(result.advisorUsage && result.advisorUsage.length > 0 ? { advisorUsage: result.advisorUsage } : {}),
    ...(result.advisorEvents && result.advisorEvents.length > 0 ? { advisorEvents: result.advisorEvents } : {}),
  }
}
