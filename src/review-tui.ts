import { homedir } from "node:os"

import { StyledText, fg } from "@opentui/core"

import { defaultAdvisorMaxCalls } from "./advisor"
import { gatewayLabel } from "./model-routing"
import { prdHistoryPreviewCopy } from "./prd-history"
import { plannedStepAdvisor, plannedStepModel } from "./run-plan"
import { sanitizeReviewInline, sanitizeReviewText } from "./run-review"
import { stepRunnerFor } from "./step-runners"
import { plain, raw, sectionLabel, theme, truncate } from "./tui-theme"

import type { TextChunk } from "@opentui/core"
import type { AgentStep, HookSpec, RunPlan } from "./types"

// Same 9-cell label column as the launcher's options screen ("pipeline ", …).
const labelWidth = 9

export type RunReviewRenderOptions = {
  /** Show the complete sanitized prompt instead of its one-line excerpt. */
  fullPrompt?: boolean
}

/**
 * The launcher's full-width Review step: a sectioned, styled rendering of the
 * exact frozen plan the runner will execute. Section labels share the options
 * screen's label column; models collapse to one dim line when logical and
 * physical targets match and become `logical → target` when a gateway reroutes
 * them, so the physical target is always visible without duplicated noise.
 */
export function runReviewLines(plan: RunPlan, width: number, options: RunReviewRenderOptions = {}): StyledText[] {
  const rows: StyledText[] = []
  const value = Math.max(20, width - labelWidth)

  const prompt = sanitizeReviewText(plan.prompt.text)
  const lineCount = prompt.split("\n").length
  rows.push(labelRow("prompt", [fg(theme.text)(`${plan.prompt.source} · ${prompt.length} characters · ${lineCount} line${lineCount === 1 ? "" : "s"}`)]))
  if (options.fullPrompt) {
    for (const line of prompt.split("\n")) {
      for (const wrapped of hardWrap(line, value)) rows.push(continuation([fg(theme.dim)(wrapped)]))
    }
  } else {
    rows.push(continuation([fg(theme.dim)(truncate(prompt.replace(/\s+/g, " ").trim(), value))]))
  }
  rows.push(plain(""))

  rows.push(labelRow("target", [fg(theme.text)(truncate(displayPath(sanitizeReviewInline(plan.target.directory)), value))]))
  rows.push(continuation([fg(theme.dim)(`diff base ${sanitizeReviewInline(plan.target.baseRef)} · ${plan.target.dirty ? "dirty tree included" : "clean tree required"}`)]))
  if (plan.target.worktree) {
    rows.push(continuation([fg(theme.faint)("branch "), fg(theme.text)(truncate(sanitizeReviewInline(plan.target.branch ?? "?"), Math.max(8, value - 7)))]))
    if (plan.target.worktreeDir) {
      rows.push(continuation([fg(theme.faint)("worktree "), fg(theme.dim)(truncate(displayPath(sanitizeReviewInline(plan.target.worktreeDir)), Math.max(8, value - 9)))]))
    }
  } else {
    rows.push(continuation([fg(theme.dim)("runs in the current checkout")]))
  }
  pushContractRows(rows, plan, value)
  rows.push(plain(""))

  rows.push(labelRow("gateway", [fg(theme.text)(gatewayLabel(plan.modelRouting.gateway))]))
  if (plan.modelRouting.gateway === "nitro") {
    rows.push(continuation([fg(theme.dim)("every OpenRouter model routed by throughput (provider.sort), injected for this run only")]))
  }
  if (plan.resume?.gatewayOverride) {
    const override = plan.resume.gatewayOverride
    rows.push(continuation([fg(theme.yellow)("resume override · "), fg(theme.dim)(`original ${gatewayLabel(override.original)} · pending phases ${gatewayLabel(override.pending)}`)]))
  }
  rows.push(plain(""))

  rows.push(sectionRow("pipeline", [fg(theme.text)(truncate(`${sanitizeReviewInline(plan.pipeline.name)} · ${pipelineSummary(plan)}`, value))]))
  pushStepRows(rows, plan, width)
  rows.push(plain(""))

  // The goal cycle is a bounded loop the operator is consenting to in full:
  // iteration-zero measurement plus up to maxIterations improve/measure
  // rounds. Surface it before confirmation so the cost/mutation envelope is
  // explicit in the TUI review, not just the headless plan.
  if (plan.goal) {
    const measurements = 1 + plan.goal.maxIterations
    rows.push(sectionRow("goal", [fg(theme.text)(`target ${plan.goal.target}/100 · up to ${counted(measurements, "measurement")} · plateau ${plan.goal.plateau}`)]))
    // The fragments are subsections of the goal block, so they sit one indent
    // deeper than a plain continuation row under the label column.
    rows.push(continuation([fg(theme.faint)("improve "), fg(theme.dim)(`${counted(plan.goal.improve.steps.length, "step")} · brief goes to ${sanitizeReviewInline(plan.goal.briefRecipient)}`)], labelWidth + 2))
    rows.push(continuation([fg(theme.faint)("measure "), fg(theme.dim)(`${counted(plan.goal.measure.steps.length, "step")} · score from ${sanitizeReviewInline(plan.goal.scoreProducer)}`)], labelWidth + 2))
    rows.push(plain(""))
  }

  const hooks = [...plan.hooks.pre.map((hook) => hookChunks("pre", hook, value)), ...plan.hooks.post.map((hook) => hookChunks("post", hook, value))]
  if (hooks.length > 0) {
    rows.push(sectionRow("hooks", hooks[0]!))
    for (const chunks of hooks.slice(1)) rows.push(continuation(chunks))
    rows.push(plain(""))
  }

  // The permission vocabulary names the mode, and the flag form is what the
  // operator would have typed: show both so the review names the exact
  // auto-accept flag the launcher's permission selector resolved to.
  const permissionFlag = plan.permissions === "yolo" ? " (--yolo)" : plan.permissions === "smart" ? " (--smart)" : ""
  const runtime = `${plan.permissions} permissions${permissionFlag} · ${plan.attachments.length} attachment${plan.attachments.length === 1 ? "" : "s"}`
  const judge = plan.smartJudge ? sanitizeReviewInline(plan.smartJudge.model.target) : ""
  if (judge && labelWidth + runtime.length + 9 + judge.length <= width) {
    rows.push(labelRow("runtime", [fg(theme.text)(runtime), fg(theme.faint)(" · judge "), fg(theme.dim)(judge)]))
  } else {
    rows.push(labelRow("runtime", [fg(theme.text)(runtime)]))
    if (judge) rows.push(continuation([fg(theme.faint)("judge "), fg(theme.dim)(truncate(judge, Math.max(8, value - 6)))]))
  }

  return rows
}

function pushContractRows(rows: StyledText[], plan: RunPlan, value: number) {
  const openspecWins = Boolean(plan.openspec && plan.openspec.changeIds.length > 0)
  // One contract: an active OpenSpec change supersedes historical PRD, so the
  // review must not claim both will attach.
  if (openspecWins) {
    pushOpenSpecRows(rows, plan, value)
    return
  }
  pushHistoryRows(rows, plan, value)
  pushOpenSpecRows(rows, plan, value)
}

function pushOpenSpecRows(rows: StyledText[], plan: RunPlan, value: number) {
  if (!plan.openspec) return
  if (plan.openspec.changeIds.length === 0) {
    rows.push(sectionRow("openspec", [fg(theme.dim)(truncate("no active change · scope will infer from the diff", value))]))
    return
  }
  const ids = sanitizeReviewInline(plan.openspec.changeIds.join(", "))
  const count = plan.openspec.specFiles.length
  const headline = `${ids} · contract attached (${count} spec file${count === 1 ? "" : "s"})`
  rows.push(sectionRow("openspec", [fg(theme.teal)(truncate(headline, value))]))
}

function pushHistoryRows(rows: StyledText[], plan: RunPlan, value: number) {
  if (!plan.prdHistory) return
  const copy = prdHistoryPreviewCopy(plan.prdHistory)
  if (!copy) return
  const tone = copy.tone === "attach" ? theme.teal : copy.tone === "warn" ? theme.yellow : theme.dim
  rows.push(labelRow("history", [fg(tone)(truncate(sanitizeReviewInline(copy.headline), value))]))
  if (copy.detail) {
    rows.push(continuation([fg(theme.dim)(truncate(sanitizeReviewInline(copy.detail), value))]))
  }
}

function pipelineSummary(plan: RunPlan): string {
  const steps = plan.pipeline.steps
  const agents = steps.filter((step): step is AgentStep => step.type === "agent")
  const writable = agents.filter((step) => !step.readOnly).length
  const readOnly = agents.length - writable
  const humans = steps.length - agents.length
  const parts = [`${steps.length} step${steps.length === 1 ? "" : "s"}`]
  if (writable) parts.push(`${writable} writable`)
  if (readOnly) parts.push(`${readOnly} read-only`)
  if (humans) parts.push(`${humans} manual`)
  return parts.join(" · ")
}

function pushStepRows(rows: StyledText[], plan: RunPlan, width: number) {
  const steps = plan.pipeline.steps
  let index = 0
  while (index < steps.length) {
    const step = steps[index]!
    if (step.type === "human") {
      rows.push(continuation([fg(theme.faint)("○ "), fg(theme.yellow)(truncate(sanitizeReviewInline(step.name), Math.max(8, width - labelWidth - 16))), fg(theme.faint)(" · manual gate")]))
      index += 1
      continue
    }

    let end = index + 1
    while (end < steps.length) {
      const next = steps[end]!
      if (next.type !== "agent" || next.groupId !== step.groupId) break
      end += 1
    }
    const members = steps.slice(index, end) as AgentStep[]
    if (members.length === 1) {
      pushAgentStep(rows, step, plan, width)
    } else {
      const shared = members.every((member) => member.stepName === members[0]!.stepName)
      const title = shared ? members[0]!.stepName : "parallel"
      const meta = `${members.length} runs · ${members[0]!.readOnly ? "read-only" : "writable"}`
      rows.push(continuation([fg(theme.faint)("○ "), fg(theme.text)(truncate(sanitizeReviewInline(title), Math.max(8, width - labelWidth - meta.length - 6))), fg(theme.faint)(` · ${meta}`)]))
      members.forEach((member, memberIndex) => {
        const connector = memberIndex === members.length - 1 ? "└─ " : "├─ "
        const sharedPrefix = `${member.stepName}__`
        const label = shared && member.name.startsWith(sharedPrefix) ? member.name.slice(sharedPrefix.length) : member.name
        rows.push(continuation([fg(theme.faint)(connector), fg(theme.text)(truncate(sanitizeReviewInline(label), Math.max(8, width - labelWidth - 5)))], labelWidth + 2))
        rows.push(...modelRows(member, labelWidth + 5, width))
      })
    }
    index = end
  }
}

function pushAgentStep(rows: StyledText[], step: AgentStep, plan: RunPlan, width: number) {
  const runner = stepRunnerFor(step.runner)
  const engine = runner.id === "opencode" ? "" : `${runner.displayName.toLowerCase()} · `
  const meta = `${engine}${step.readOnly ? "read-only" : "writable"}`
  rows.push(continuation([fg(theme.faint)("○ "), fg(theme.text)(truncate(sanitizeReviewInline(step.name), Math.max(8, width - labelWidth - meta.length - 5))), fg(theme.faint)(` · ${meta}`)]))
  rows.push(...modelRows(step, labelWidth + 2, width))
}

function modelRows(step: AgentStep, indent: number, width: number): StyledText[] {
  return [...executorModelRows(step, indent, width), ...advisorRows(step, indent, width)]
}

function executorModelRows(step: AgentStep, indent: number, width: number): StyledText[] {
  const available = Math.max(8, width - indent)
  const resolved = step.resolvedModel
  if (!resolved) return [continuation([fg(theme.dim)(truncate(sanitizeReviewInline(plannedStepModel(step)), available))], indent)]
  const logical = sanitizeReviewInline(resolved.logical)
  const target = sanitizeReviewInline(resolved.target)
  if (logical === target) return [continuation([fg(theme.dim)(truncate(target, available))], indent)]
  if (logical.length + 3 + target.length <= available) {
    return [continuation([fg(theme.dim)(logical), fg(theme.teal)(" → "), fg(theme.text)(target)], indent)]
  }
  return [
    continuation([fg(theme.dim)(truncate(logical, available))], indent),
    continuation([fg(theme.teal)("→ "), fg(theme.text)(truncate(target, Math.max(8, available - 2)))], indent),
  ]
}

/** One extra dim row naming the advising model, only for steps that have one. */
function advisorRows(step: AgentStep, indent: number, width: number): StyledText[] {
  const advisor = plannedStepAdvisor(step)
  if (!advisor) return []
  const prefix = "Advisor "
  const available = Math.max(8, width - indent - prefix.length)
  const suffix = ` · max ${step.advisorMaxCalls ?? defaultAdvisorMaxCalls} calls/attempt`
  const resolved = step.resolvedAdvisor
  const relationship = resolved && resolved.logical !== resolved.target ? `${resolved.logical} → ${resolved.target}` : advisor
  return [continuation([fg(theme.faint)(prefix), fg(theme.dim)(truncate(`${sanitizeReviewInline(relationship)}${suffix}`, available))], indent)]
}

function hookChunks(stage: "pre" | "post", hook: HookSpec, value: number): TextChunk[] {
  const chunks: TextChunk[] = [fg(theme.teal)(stage.padEnd(4)), fg(theme.faint)("  · "), fg(theme.text)(truncate(sanitizeReviewInline(hook.command), Math.max(8, value - 8)))]
  if (stage === "post" && hook.when && hook.when !== "success") chunks.push(fg(theme.faint)(` · ${sanitizeReviewInline(hook.when)}`))
  return chunks
}

function labelRow(label: string, value: TextChunk[]): StyledText {
  return new StyledText([fg(theme.faint)(label.padEnd(labelWidth)), ...value])
}

// The run-shape sections — pipeline steps, goal, openspec, hooks — headline
// the review; their label column renders accent-bold so they scan as the
// plan's structure next to the faint metadata labels (prompt, target,
// gateway, runtime).
function sectionRow(label: string, value: TextChunk[]): StyledText {
  return new StyledText([sectionLabel(label.padEnd(labelWidth)), ...value])
}

function continuation(value: TextChunk[], indent = labelWidth): StyledText {
  return new StyledText([raw(" ".repeat(indent)), ...value])
}

function counted(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}

function displayPath(path: string): string {
  const home = homedir()
  if (path === home) return "~"
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`
  return path
}

function hardWrap(line: string, width: number): string[] {
  if (width < 1 || line.length <= width) return [line]
  const wrapped: string[] = []
  for (let index = 0; index < line.length; index += width) wrapped.push(line.slice(index, index + width))
  return wrapped
}
