import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"

import { defaultAdvisorMaxCalls } from "./advisor"
import { gatewayLabel } from "./model-routing"
import { prdHistoryPreviewCopy } from "./prd-history"
import { plannedStepAdvisor, plannedStepModel } from "./run-plan"
import { stepRunnerFor } from "./step-runners"
import type { RunPlan } from "./types"

const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g
const ansiSequences = /\u001b\[[0-?]*[ -/]*[@-~]/g

export type RunPlanReviewRenderOptions = {
  /** Show the complete sanitized prompt rather than its normal terminal-safe excerpt. */
  fullPrompt?: boolean
}

export function renderRunPlan(plan: RunPlan, compact = false, options: RunPlanReviewRenderOptions = {}): string {
  const prompt = sanitize(plan.prompt.text)
  const preview = prompt.replace(/\s+/g, " ").slice(0, compact ? 100 : 180)
  const lines = [
    compact ? "Convoy run plan" : "Review Convoy run",
    "",
    `Prompt: ${plan.prompt.source} · ${prompt.length} characters · ${prompt.split("\n").length} lines`,
    `Target: ${sanitizeInline(plan.target.directory)}`,
    `  Diff base: ${sanitizeInline(plan.target.baseRef)} · working tree: ${plan.target.dirty ? "include dirty" : "clean required"}`,
    `  Worktree: ${plan.target.worktree ? `yes · branch ${plan.target.branch ? sanitizeInline(plan.target.branch) : "named at start"}` : "no"}`,
    ...prdHistoryPlanLines(plan),
    ...openspecPlanLines(plan),
    ...(plan.target.worktree && plan.openspec && plan.openspec.changeIds.length > 0
      ? ["Scope: the selected changes scope this run's diff and OpenSpec inputs — they never narrow whole-branch publication or squash scope; those act on the entire branch."]
      : []),
    `Pipeline: ${sanitizeInline(plan.pipeline.name)} · ${plan.pipeline.steps.length} steps`,
    `Gateway: ${gatewayLabel(plan.modelRouting.gateway)}${plan.modelRouting.gateway === "nitro" ? " · every OpenRouter model routed by throughput (injected for this run only)" : ""}`,
    `Advisors: ${plan.pipeline.steps.filter((step) => step.type === "agent" && Boolean(plannedStepAdvisor(step))).length}/${plan.pipeline.steps.filter((step) => step.type === "agent").length} steps advised`,
  ]
  if (plan.goal) {
    // The goal cycle is a bounded loop the operator is consenting to in full:
    // iteration-zero measurement plus up to maxIterations improve/measure
    // rounds. Surface it before confirmation so the cost/mutation envelope is
    // explicit, not discovered after the first run.
    const measurements = 1 + plan.goal.maxIterations
    lines.push(
      `Goal cycle: target ${plan.goal.target}/100 · up to ${measurements} measurements (${plan.goal.maxIterations} improve rounds) · plateau ${plan.goal.plateau}`,
      `  Improve: ${plan.goal.improve.steps.length} step${plan.goal.improve.steps.length === 1 ? "" : "s"} · brief goes to ${sanitizeInline(plan.goal.briefRecipient)}`,
      `  Measure: ${plan.goal.measure.steps.length} step${plan.goal.measure.steps.length === 1 ? "" : "s"} · authoritative score from ${sanitizeInline(plan.goal.scoreProducer)}`,
    )
  }
  const promptLines = options.fullPrompt && !compact
    ? prompt.split("\n").map((line) => `  ${line}`)
    : [`  ${preview}${preview.length < prompt.replace(/\s+/g, " ").length ? "…" : ""}`]
  lines.splice(3, 0, ...promptLines)
  // A resumed run rerouted by an explicit --gateway must say so in every
  // review format: pending phases will not use the original gateway.
  if (plan.resume?.gatewayOverride) {
    lines.push(
      "Resume gateway override:",
      `  original: ${gatewayLabel(plan.resume.gatewayOverride.original)}`,
      `  pending phases: ${gatewayLabel(plan.resume.gatewayOverride.pending)}`,
    )
  }
  if (!compact) {
    if (plan.target.worktreeDir) lines.push(`Worktree directory: ${sanitizeInline(plan.target.worktreeDir)}`)
    plan.pipeline.steps.forEach((step, index) => {
      if (step.type === "human") lines.push(`  ${index + 1}. ${sanitizeInline(step.name)} · human gate`)
      else {
        lines.push(`  ${index + 1}. ${sanitizeInline(step.name)} · ${stepRunnerFor(step.runner).displayName} · ${step.readOnly ? "read-only" : "writable"}`)
        if (step.resolvedModel) lines.push(`     Logical: ${sanitizeInline(step.resolvedModel.logical)}`, `     Target:  ${sanitizeInline(step.resolvedModel.target)}`)
        else lines.push(`     Model: ${sanitizeInline(plannedStepModel(step))}`)
        const advisor = plannedStepAdvisor(step)
        if (advisor) {
          const resolved = step.resolvedAdvisor
          const model = resolved && resolved.logical !== resolved.target ? `${resolved.logical} → ${resolved.target}` : advisor
          lines.push(`     Advisor: ${sanitizeInline(model)} · max ${step.advisorMaxCalls ?? defaultAdvisorMaxCalls} calls/attempt`, "     Context: advisor reviews the executor's full session; it does not own the deliverable")
        }
      }
    })
    if (plan.hooks.pre.length || plan.hooks.post.length) {
      lines.push("Hooks:")
      for (const hook of plan.hooks.pre) lines.push(`  pre: ${sanitizeInline(hook.command)}`)
      for (const hook of plan.hooks.post) lines.push(`  post: ${sanitizeInline(hook.command)}${hook.when ? ` (${sanitizeInline(hook.when)})` : ""}`)
    }
    lines.push(`Runtime: ${plan.permissions} permissions · ${plan.attachments.length} attachments`)
    if (plan.smartJudge) lines.push(`  Judge: ${sanitizeInline(plan.smartJudge.model.target)}`)
  }
  return `${lines.join("\n")}\n`
}

export async function confirmRunPlan(plan: RunPlan): Promise<boolean> {
  stdout.write(renderRunPlan(plan))
  const prompt = createInterface({ input: stdin, output: stdout })
  const controller = new AbortController()
  let interrupted = false
  // In raw-mode terminals readline emits SIGINT instead of process-level SIGINT.
  // Handle it here so confirmation follows the other interactive prompts.
  prompt.on("SIGINT", () => {
    interrupted = true
    controller.abort()
  })
  try {
    const answer = (await prompt.question("Start run? [y/N] ", { signal: controller.signal })).trim().toLowerCase()
    return answer === "y" || answer === "yes" || answer === "s" || answer === "sí" || answer === "si"
  } catch (error) {
    if (interrupted && error instanceof Error && error.name === "AbortError") {
      stdout.write("\n")
      return false
    }
    throw error
  } finally {
    prompt.close()
  }
}

function prdHistoryPlanLines(plan: RunPlan): string[] {
  // An active OpenSpec change is the contract; do not also claim the historical
  // PRD will attach (the runner supersedes it).
  if (plan.openspec && plan.openspec.changeIds.length > 0) return []
  if (!plan.prdHistory) return []
  const copy = prdHistoryPreviewCopy(plan.prdHistory)
  if (!copy) return []
  const headline = sanitizeInline(copy.headline)
  if (copy.detail) return [`PRD history: ${headline}`, `  ${sanitizeInline(copy.detail)}`]
  return [`PRD history: ${headline}`]
}

function openspecPlanLines(plan: RunPlan): string[] {
  if (!plan.openspec) return []
  if (plan.openspec.changeIds.length === 0) {
    return ["OpenSpec: openspec/ present but no active change — scope falls back to the diff"]
  }
  const ids = sanitizeInline(plan.openspec.changeIds.join(", "))
  const count = plan.openspec.specFiles.length
  return [`OpenSpec change: ${ids} · contract attached (${count} spec files)`]
}

function sanitize(value: string) {
  return value.replace(ansiSequences, "").replace(controlCharacters, "").replace(/\t/g, " ")
}

function sanitizeInline(value: string) {
  return sanitize(value).replace(/\s+/g, " ").trim()
}

/** Multi-line sanitize for untrusted plan fields (prompt text), shared with the TUI review. */
export function sanitizeReviewText(value: string) {
  return sanitize(value)
}

/** Single-line sanitize for untrusted plan fields (paths, names, commands), shared with the TUI review. */
export function sanitizeReviewInline(value: string) {
  return sanitizeInline(value)
}
