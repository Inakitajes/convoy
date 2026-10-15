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
  watchSession,
  type SessionRef,
  type SessionResult,
  type ShutdownHandle,
} from "./session"

export async function promptPhase(
  client: OpencodeClient,
  input: {
    phase: AgentStep
    workspace: Workspace
    targetDir: string
    prompt: string
    model: ModelSelection
    attachments: FilePartInput[]
    progress: ProgressUI
    shutdown: ShutdownHandle
    sessionRef?: SessionRef
    advisors?: AdvisorRuntime
    reports?: ReportRuntime
    deliverableContract?: DeliverableContract
    rubricWeights?: Record<QualityDimension, number>
    attempt: number
    /** The resolved guard configuration; already resolved by preparePhaseRun, never re-resolved here. */
    loopGuardConfig: LoopGuardConfig
    /** A budget-gate reset reuses this guard so cost remains capped across prompts. */
    loopGuard?: LoopGuard
  },
): Promise<SessionResult> {
  input.shutdown.throwIfRequested()
  const session = await client.session.create({
    directory: input.targetDir,
    title: `convoy ${input.workspace.runID} ${input.phase.name}`,
    metadata: { convoyRunID: input.workspace.runID, convoyPhase: input.phase.name },
  }, { signal: input.shutdown.signal })
  if (session.error) throw new Error(formatSdkError(session.error))
  if (!session.data?.id) throw new Error("opencode didn't return session id")

  if (input.sessionRef) input.sessionRef.id = session.data.id
  const advisor = input.advisors?.begin(session.data.id, input.phase, input.attempt)
  const report = input.reports?.begin(
    session.data.id,
    input.phase,
    input.deliverableContract ?? deliverableContractForPhase(input.phase),
    input.rubricWeights ?? qualityDimensionWeights,
  )
  input.progress.phaseSession(input.phase.name, session.data.id)
  input.shutdown.setActiveSession({ client, sessionID: session.data.id, directory: input.targetDir, phaseName: input.phase.name })
  log.info(`[${input.phase.name}] session: ${session.data.id}`)

  const loopGuard = input.loopGuard ?? new LoopGuard(input.loopGuardConfig)

  const watcher = watchSession(client, {
    directory: input.targetDir,
    phaseName: input.phase.name,
    sessionID: session.data.id,
    progress: input.progress,
    signal: input.shutdown.signal,
    loopGuard,
  })

  try {
    await Promise.race([watcher.ready, sleep(3_000)])
    input.shutdown.throwIfRequested()

    const accepted = await client.session.promptAsync({
      sessionID: session.data.id,
      directory: input.targetDir,
      agent: input.phase.agentName,
      model: { providerID: input.model.providerID, modelID: input.model.modelID },
      variant: input.model.variant,
      parts: [...input.attachments, { type: "text", text: input.prompt }],
    }, { signal: input.shutdown.signal })
    if (accepted.error) throw new Error(formatSdkError(accepted.error))
    const first = await watcher.result
    input.shutdown.throwIfRequested()

    const reviewed = advisor ? await applyCompletionCheckpoint(client, { ...input, sessionID: session.data.id, loopGuard }, first, advisor) : first
    const reported = report
      ? await applyReportCheckpoint(client, { ...input, sessionID: session.data.id, loopGuard }, reviewed, report)
      : reviewed

    const usage = combinedAssistantUsage(reported.assistantInfos, session.data.id)
    if (usage) {
      input.progress.phaseUsageTotal(input.phase.name, usage)
      log.info(`[${input.phase.name}] usage: ${formatUsageForLog(usage)}`)
    }
    return {
      ...reported,
      ...(advisor && advisor.usage.length > 0 ? { advisorUsage: [...advisor.usage] } : {}),
      ...(advisor && advisor.events.length > 0 ? { advisorEvents: [...advisor.events] } : {}),
    }
  } catch (error) {
    if (!input.shutdown.aborted && !isUserAbortError(error)) {
      await abortSessionQuietly(client, session.data.id, input.targetDir, input.phase.name)
    }
    throw error
  } finally {
    if (input.shutdown.aborted) {
      report?.end()
      advisor?.end()
      await input.shutdown.abortActiveSessions(input.progress)
    }
    input.shutdown.clearActiveSession(input.phase.name, session.data.id)
    await watcher.stop()
  }
}
