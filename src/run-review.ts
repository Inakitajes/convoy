import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"

import { plannedStepModel } from "./run-plan"
import { stepRunnerFor } from "./step-runners"
import type { RunPlan } from "./types"

const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g
const ansiSequences = /\u001b\[[0-?]*[ -/]*[@-~]/g

export function renderRunPlan(plan: RunPlan, compact = false): string {
  const prompt = sanitize(plan.prompt.text)
  const preview = prompt.replace(/\s+/g, " ").slice(0, compact ? 100 : 180)
  const lines = [
    compact ? "Convoy run plan" : "Review Convoy run",
    "",
    `Prompt: ${plan.prompt.source} · ${prompt.length} characters · ${prompt.split("\n").length} lines`,
    `  ${preview}${preview.length < prompt.replace(/\s+/g, " ").length ? "…" : ""}`,
    `Target: ${plan.target.directory}`,
    `  Diff base: ${plan.target.baseRef} · working tree: ${plan.target.dirty ? "include dirty" : "clean required"}`,
    `Pipeline: ${plan.pipeline.name} · ${plan.pipeline.steps.length} steps`,
    `Gateway: ${gatewayLabel(plan.modelRouting.gateway)}`,
  ]
  if (!compact) {
    plan.pipeline.steps.forEach((step, index) => {
      if (step.type === "human") lines.push(`  ${index + 1}. ${step.name} · human gate`)
      else {
        lines.push(`  ${index + 1}. ${step.name} · ${stepRunnerFor(step.runner).displayName} · ${step.readOnly ? "read-only" : "writable"} · ${step.maxAttempts ?? plan.maxAttempts} attempts`)
        if (step.resolvedModel) lines.push(`     Logical: ${step.resolvedModel.logical}`, `     Target:  ${step.resolvedModel.target}`)
        else lines.push(`     Model: ${plannedStepModel(step)}`)
      }
    })
    if (plan.hooks.pre.length || plan.hooks.post.length) {
      lines.push("Hooks:")
      for (const hook of plan.hooks.pre) lines.push(`  pre: ${sanitize(hook.command)}`)
      for (const hook of plan.hooks.post) lines.push(`  post: ${sanitize(hook.command)}${hook.when ? ` (${hook.when})` : ""}`)
    }
    lines.push(`Runtime: ${plan.permissions} permissions · ${plan.attachments.length} attachments`)
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
  return value.replace(ansiSequences, "").replace(controlCharacters, "")
}

function gatewayLabel(gateway: RunPlan["modelRouting"]["gateway"]) {
  return gateway === "vercel" ? "Vercel AI Gateway" : gateway === "openrouter" ? "OpenRouter" : gateway === "direct" ? "Direct" : "As configured"
}
