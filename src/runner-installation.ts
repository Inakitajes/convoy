/**
 * Fail-fast runner installation checks: a CLI runner is optional, so only a
 * pipeline that actually runs a step on it requires its CLI, and a missing one
 * must fail at launch, never minutes into a run.
 */

import { runnerDescriptor } from "./runners/descriptors"
import { stepRunnerFor, stepRunnerIds, type StepRunnerId } from "./step-runners"
import type { Pipeline } from "./types"

/**
 * Resolves a binary against the current `PATH`. `Bun.which` alone reads the
 * PATH the process started with, while spawning resolves against the live
 * environment, so a check without this can disagree with the launch it guards.
 */
export function whichOnPath(bin: string): string | null {
  return Bun.which(bin, { PATH: process.env.PATH ?? "" })
}

/** Throws when a runner the pipeline's agent steps (goal fragments included) use has no CLI on PATH. */
export function ensureRunnersAvailable(pipeline: Pipeline, which: (bin: string) => string | null = whichOnPath, only: readonly StepRunnerId[] = stepRunnerIds): void {
  const steps = [...pipeline.steps, ...(pipeline.goalPlan ? [...pipeline.goalPlan.improve.steps, ...pipeline.goalPlan.measure.steps] : [])]
  for (const runner of only) {
    const descriptor = runnerDescriptor(runner)
    if (!descriptor.binary) continue
    const names = steps.filter((step) => step.type === "agent" && stepRunnerFor(step.runner).id === runner).map((step) => step.name)
    if (names.length === 0 || which(descriptor.binary)) continue
    throw new Error(
      `pipeline "${pipeline.name}" uses runner: ${runner} (steps: ${names.join(", ")}) but the \`${descriptor.binary}\` CLI was not found in PATH; ${descriptor.installHint ?? `install ${descriptor.displayName}`} or remove those steps`,
    )
  }
}
