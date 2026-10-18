/**
 * Plan dependency traversal (change `runner-parity-opencode-v2`, task 8.2).
 *
 * Preflight must see every runner the whole plan will need — ordinary steps, the
 * goal cycle's improve/measure fragments, per-step advisors, the smart judge, and
 * the helper routes — before any writable phase starts. A dependency that only
 * appears late would otherwise fail after earlier steps already changed the
 * repository.
 */

import type { AgentStep, Pipeline } from "../types"
import { runnerOfModelReference, stepRunnerFor } from "../step-runners"

import type { RunnerId } from "./contracts"

export type PlanDependencyKind = "step" | "advisor" | "judge" | "helper"

export type PlanDependency = {
  kind: PlanDependencyKind
  runner: RunnerId
  /** Human label for the message (step/phase name or helper role). */
  label: string
}

export type PlanDependencyOptions = {
  helpers?: readonly { role: string; runner: RunnerId }[]
  judge?: RunnerId
}

function runnerOf(step: AgentStep): RunnerId {
  return stepRunnerFor(step.runner).id
}

function collectFromSteps(steps: readonly AgentStep[], dependencies: PlanDependency[]): void {
  for (const step of steps) {
    dependencies.push({ kind: "step", runner: runnerOf(step), label: step.name })
    if (step.resolvedAdvisor) {
      // A runner-qualified advisor (`claude-code/<model>`, `codex/<model>`) runs
      // on that runner; any other on OpenCode, whatever runner the executor
      // uses (a cross-runner consultation).
      dependencies.push({ kind: "advisor", runner: runnerOfModelReference(step.resolvedAdvisor), label: `${step.name} advisor` })
    }
  }
}

/** Every dependency the plan will need, including goal fragments and helpers. */
export function collectPlanDependencies(pipeline: Pipeline, options: PlanDependencyOptions = {}): PlanDependency[] {
  const dependencies: PlanDependency[] = []
  collectFromSteps(pipeline.steps.filter((step): step is AgentStep => step.type === "agent"), dependencies)

  if (pipeline.goalPlan) {
    collectFromSteps(pipeline.goalPlan.improve.steps, dependencies)
    collectFromSteps(pipeline.goalPlan.measure.steps, dependencies)
  }

  if (options.judge) dependencies.push({ kind: "judge", runner: options.judge, label: "smart judge" })
  for (const helper of options.helpers ?? []) {
    dependencies.push({ kind: "helper", runner: helper.runner, label: `helper:${helper.role}` })
  }
  return dependencies
}

/** The dependencies whose runner is not available. */
export function missingDependencies(
  dependencies: readonly PlanDependency[],
  available: (runner: RunnerId) => boolean,
): PlanDependency[] {
  return dependencies.filter((dependency) => !available(dependency.runner))
}

export class PlanDependencyError extends Error {
  readonly missing: readonly PlanDependency[]
  constructor(missing: readonly PlanDependency[]) {
    super(
      `plan requires unavailable runners: ${missing.map((dependency) => `${dependency.label} (${dependency.runner})`).join(", ")}`,
    )
    this.name = "PlanDependencyError"
    this.missing = missing
  }
}

/** Throws before execution when the plan needs an unavailable runner. */
export function assertPlanDependenciesAvailable(
  pipeline: Pipeline,
  options: PlanDependencyOptions,
  available: (runner: RunnerId) => boolean,
): void {
  const missing = missingDependencies(collectPlanDependencies(pipeline, options), available)
  if (missing.length > 0) throw new PlanDependencyError(missing)
}

/** The plan's judge and helper dependencies, from its frozen routes. */
export function planDependencyOptions(plan: { smartJudge?: { runner?: RunnerId }; commitMessageModel?: string }): PlanDependencyOptions {
  return {
    ...(plan.smartJudge ? { judge: stepRunnerFor(plan.smartJudge.runner).id } : {}),
    ...(plan.commitMessageModel ? { helpers: [{ role: "commit-message", runner: runnerOfModelReference(plan.commitMessageModel) }] } : {}),
  }
}
