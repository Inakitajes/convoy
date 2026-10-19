/**
 * Codex preflight (change `add-codex-runner`): before a run starts, verify the
 * account Codex resolves under the reviewed authentication, and that every
 * Codex model and reasoning effort the plan names is offered to that account
 * (`model/list`), so a model the account cannot use fails before any write.
 */

import { planAgentSteps } from "../../run-plan"
import { qualifiedModelRoute, stepRunnerFor } from "../../step-runners"
import type { RunPlan } from "../../types"
import type { AuthenticationSelection } from "../contracts"
import { codexVersionProblem } from "../declarations"
import { codexAppServerArgs } from "./adapter"
import { codexVersionOf, startCodexAppServer, type CodexSpawn } from "./app-server"
import { codexAccountMismatch, prepareCodexAuth, type CodexLogin } from "./auth"
import { asRecord, stringField } from "./protocol"

export type CodexModelRequirement = { model: string; effort?: string; label: string }

export type CodexPreflightInput = {
  selection: AuthenticationSelection
  models: readonly CodexModelRequirement[]
  cwd: string
  env?: NodeJS.ProcessEnv
  binary?: string
  spawn?: CodexSpawn
  login?: CodexLogin
}

type OfferedModel = { ids: Set<string>; efforts: Set<string> }

/** The models `model/list` offers, by id and model name, with their supported efforts. */
export function offeredCodexModels(result: unknown): OfferedModel[] {
  const data = asRecord(result)?.data
  if (!Array.isArray(data)) return []
  return data.flatMap((entry) => {
    const record = asRecord(entry)
    if (!record) return []
    const ids = new Set([stringField(record, "id"), stringField(record, "model")].filter((id): id is string => Boolean(id)))
    const efforts = new Set(
      (Array.isArray(record.supportedReasoningEfforts) ? record.supportedReasoningEfforts : [])
        .map((option) => stringField(asRecord(option), "reasoningEffort"))
        .filter((effort): effort is string => Boolean(effort)),
    )
    return [{ ids, efforts }]
  })
}

/** Why a required model or effort is not offered, or undefined when every one is. */
export function missingCodexModel(requirements: readonly CodexModelRequirement[], offered: readonly OfferedModel[]): string | undefined {
  for (const requirement of requirements) {
    if (!requirement.model || requirement.model === "default") continue
    const match = offered.find((candidate) => candidate.ids.has(requirement.model))
    if (!match) return `${requirement.label} names the Codex model "${requirement.model}", which this account does not offer`
    if (requirement.effort && match.efforts.size > 0 && !match.efforts.has(requirement.effort)) {
      return `${requirement.label} asks "${requirement.model}" for reasoning effort "${requirement.effort}", which it does not support (${[...match.efforts].join(", ")})`
    }
  }
  return undefined
}

/** Verifies the Codex release, the effective account and the plan's models; resolves to an error message, or undefined when ready. */
export async function preflightCodex(input: CodexPreflightInput): Promise<string | undefined> {
  const binary = input.binary ?? "codex"
  const auth = await prepareCodexAuth({ selection: input.selection, env: input.env ?? process.env, binary, cwd: input.cwd, ...(input.login ? { login: input.login } : {}) })
  try {
    const server = await startCodexAppServer({ binary, args: codexAppServerArgs(), cwd: input.cwd, env: auth.env, ...(input.spawn ? { spawn: input.spawn } : {}) })
    try {
      const outdated = codexVersionProblem(codexVersionOf(server.info))
      if (outdated) return `${outdated}; update Codex with \`codex update\``
      const mismatch = codexAccountMismatch(auth.mode, await server.request("account/read", {}))
      if (mismatch) return mismatch
      if (input.models.some((requirement) => requirement.model && requirement.model !== "default")) {
        return missingCodexModel(input.models, offeredCodexModels(await server.request("model/list", { includeHidden: true, limit: 200 })))
      }
      return undefined
    } finally {
      await server.close()
    }
  } finally {
    await auth.discard()
  }
}

/** Every Codex model the plan names: steps, advisors, the judge, and the commit writer. */
export function codexModelRequirements(plan: RunPlan): CodexModelRequirement[] {
  const requirements: CodexModelRequirement[] = []
  for (const step of planAgentSteps(plan.pipeline)) {
    if (stepRunnerFor(step.runner).id === "codex") requirements.push({ model: step.model, ...(step.variant ? { effort: step.variant } : {}), label: `step ${step.name}` })
    const advisor = step.resolvedAdvisor
    if (advisor?.providerID === "codex") requirements.push({ model: advisor.modelID, ...(advisor.variant ? { effort: advisor.variant } : {}), label: `step ${step.name}'s advisor` })
  }
  const judge = plan.smartJudge?.runner === "codex" ? plan.smartJudge.model : undefined
  if (judge) requirements.push({ model: judge.modelID, ...(judge.variant ? { effort: judge.variant } : {}), label: "the smart judge" })
  const writer = plan.commitMessageModel ? qualifiedModelRoute(plan.commitMessageModel) : undefined
  if (writer?.runner === "codex") requirements.push({ model: writer.model, ...(writer.variant ? { effort: writer.variant } : {}), label: "the commit writer" })
  return requirements
}
