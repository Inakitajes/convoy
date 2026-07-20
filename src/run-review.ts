import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"

import { gatewayLabel } from "./model-routing"
import { plannedStepModel } from "./run-plan"
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
    `  Worktree: ${plan.target.worktree ? "yes (created after confirmation)" : "no"}`,
    `Pipeline: ${sanitizeInline(plan.pipeline.name)} · ${plan.pipeline.steps.length} steps`,
    `Gateway: ${gatewayLabel(plan.modelRouting.gateway)}`,
  ]
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
    if (plan.branchNamer) lines.push(`Branch naming: ${sanitizeInline(plan.branchNamer.model.target)} (generated after confirmation)`)
    plan.pipeline.steps.forEach((step, index) => {
      if (step.type === "human") lines.push(`  ${index + 1}. ${sanitizeInline(step.name)} · human gate`)
      else {
        lines.push(`  ${index + 1}. ${sanitizeInline(step.name)} · ${stepRunnerFor(step.runner).displayName} · ${step.readOnly ? "read-only" : "writable"} · ${step.maxAttempts ?? plan.maxAttempts} attempts`)
        if (step.resolvedModel) lines.push(`     Logical: ${sanitizeInline(step.resolvedModel.logical)}`, `     Target:  ${sanitizeInline(step.resolvedModel.target)}`)
        else lines.push(`     Model: ${sanitizeInline(plannedStepModel(step))}`)
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
