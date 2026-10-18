/**
 * OpenCode phase execution (change `unify-runner-system`, tasks 2a/2.1).
 *
 * The OpenCode attempt loop — session creation, async prompt, event-stream
 * watching, advisor/report checkpoints, loop guard, usage — lives here so the
 * integration sits with the OpenCode adapter instead of inside the engine. It
 * imports the session runtime from its own directory and never imports
 * `runner.ts`, so there is no adapter-to-engine dependency.
 */

import { log } from "../../log"
import { LoopGuard, type LoopGuardConfig } from "../../loop-guard"
import { deliverableContractForPhase } from "../../pipeline"
import { qualityDimensionWeights, type QualityDimension } from "../../quality-score"
import type { ModelSelection } from "../../advisor"
import type { AdvisorRuntime } from "../../advisor-runtime"
import type { OpencodeClient, FilePartInput } from "../../opencode-client"
import type { ProgressUI } from "../../progress"
import type { ReportRuntime } from "../../report-runtime"
import type { AgentStep, DeliverableContract } from "../../types"
import type { AttemptIdentity, ExecutionServices, LoopGuardService } from "../contracts"
import type { Workspace } from "../../workspace"
import { isUserAbortError } from "../abort"
import { formatSdkError } from "../errors"

import {
  abortSessionQuietly,
  applyCompletionCheckpoint,
  applyReportCheckpoint,
  combinedAssistantUsage,
  formatUsageForLog,
  sleep,
  throwIfAborted,
  watchSession,
  type SessionRef,
  type SessionResult,
} from "./session"

export async function promptPhase(
  client: OpencodeClient,
  input: {
    identity: AttemptIdentity
    phase: AgentStep
    targetDir: string
    prompt: string
    model: ModelSelection
    attachments: FilePartInput[]
    progress: ProgressUI
    signal: AbortSignal
    attempt: number
    /** The services this runner honors; the engine owns their implementations. */
    services: ExecutionServices
    /** A budget-gate reset reuses this guard so cost remains capped across prompts. */
    loopGuard?: LoopGuardService
  },
): Promise<SessionResult> {
  throwIfAborted(input.signal)
  const session = await client.session.create({
    directory: input.targetDir,
    title: `convoy ${input.identity.runId} ${input.phase.name}`,
    metadata: { convoyRunID: input.identity.runId, convoyPhase: input.phase.name },
  }, { signal: input.signal })
  if (session.error) throw new Error(formatSdkError(session.error))
  if (!session.data?.id) throw new Error("opencode didn't return session id")


  const advisor = input.services.advisor
  const deliverables = input.services.deliverables
  input.progress.phaseSession(input.phase.name, session.data.id)
  log.info(`[${input.phase.name}] session: ${session.data.id}`)


  const watcher = watchSession(client, {
    directory: input.targetDir,
    phaseName: input.phase.name,
    sessionID: session.data.id,
    progress: input.progress,
    signal: input.signal,
    ...(input.loopGuard ? { loopGuard: input.loopGuard } : {}),
  })

  try {
    await Promise.race([watcher.ready, sleep(3_000)])
    throwIfAborted(input.signal)

    const accepted = await client.session.promptAsync({
      sessionID: session.data.id,
      directory: input.targetDir,
      agent: input.phase.agentName,
      model: { providerID: input.model.providerID, modelID: input.model.modelID },
      variant: input.model.variant,
      parts: [...input.attachments, { type: "text", text: input.prompt }],
    }, { signal: input.signal })
    if (accepted.error) throw new Error(formatSdkError(accepted.error))
    const first = await watcher.result
    throwIfAborted(input.signal)

    const reviewed = advisor ? await applyCompletionCheckpoint(client, { ...input, sessionID: session.data.id }, first, advisor) : first
    const reported = deliverables
      ? await applyReportCheckpoint(client, { ...input, sessionID: session.data.id }, reviewed, deliverables)
      : reviewed

    const usage = combinedAssistantUsage(reported.assistantInfos, session.data.id)
    if (usage) {
      input.progress.phaseUsageTotal(input.phase.name, usage)
      log.info(`[${input.phase.name}] usage: ${formatUsageForLog(usage)}`)
    }
    return reported
  } catch (error) {
    if (!input.signal.aborted && !isUserAbortError(error)) {
      await abortSessionQuietly(client, session.data.id, input.targetDir, input.phase.name)
    }
    throw error
  } finally {
    await watcher.stop()
  }
}
