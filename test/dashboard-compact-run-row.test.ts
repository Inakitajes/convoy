import { describe, expect, test } from "bun:test"

import { compactRunRowName, progressPhases } from "../src/runner"
import { reconstructedPhases } from "../src/attach"
import type { Pipeline } from "../src/types"

/**
 * The `Compact run` lifecycle row must be part of every phase list a dashboard
 * receives — the list handed to `resetPipeline` on a live run and the one
 * `reconstructedPhases` derives for attach/history (SC-2, capability
 * run-finalization R1/D8). It now executes before the success post-hooks, so
 * the canonical order places it after the pipeline (and goal invocation rows)
 * and before the post-hook rows; only a run with no post-hooks ends on it. A
 * row dropped from either list makes the TUI no-op the finalization phase
 * events, so the epilogue's started/completed/failed narration never reaches
 * the operator.
 */

const pipeline = {
  name: "quick",
  steps: [{ type: "agent", name: "implement", description: "do the work", agentName: "builder", model: "x/y" }],
} as unknown as Pipeline

const hookSet = {
  pre: [],
  post: [{ command: "echo done" }],
}

describe("the Compact run lifecycle row in dashboard phase lists", () => {
  test("progressPhases places the row after the pipeline and before post-hooks", () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal hook fixture
    const phases = progressPhases(pipeline, hookSet as any)
    expect(phases.map((phase) => phase.name)).toEqual(["implement", compactRunRowName, "post-hook: echo done"])
    expect(phases.at(-1)?.name).toContain("post-hook")
    expect(phases[1]!.name).toBe(compactRunRowName)
  })

  test("the row is present and terminal even when no hooks exist", () => {
    const phases = progressPhases(pipeline)
    expect(phases.map((phase) => phase.name)).toEqual(["implement", compactRunRowName])
  })

  test("the row carries a description instead of rendering as a bare name", () => {
    const row = progressPhases(pipeline).find((phase) => phase.name === compactRunRowName)
    expect(row?.description).toContain("compacts")
  })

  test("attach reconstruction keeps the row when the run recorded its phase events", () => {
    const metadata = {
      pipeline,
      phases: {
        implement: { status: "completed" },
        [compactRunRowName]: { status: "completed" },
      },
    } as unknown as Parameters<typeof reconstructedPhases>[0]
    const phases = reconstructedPhases(metadata, false)
    expect(phases.some((phase) => phase.name === compactRunRowName)).toBe(true)
  })
})
