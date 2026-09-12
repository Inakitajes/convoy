import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { reconstructedPhases } from "../src/attach"
import { goalLoopViewFrom, overallStatus, reconcileAdvisorJournal, replayHistory } from "../src/attach-runtime"
import { noopProgress } from "../src/progress"
import { builtInAgents, builtInPipelines, resolvePipeline } from "../src/pipeline"
import { qualifyInvocation } from "../src/goal-scheduler"

import type { AdvisorEvent } from "../src/advisor-events"
import type { GoalRunState, PhaseMetadata, RunMetadata } from "../src/metadata"
import type { QualityScore } from "../src/quality-score"
import type { ProgressPhaseSnapshot, ProgressUI } from "../src/progress"

const dirs: string[] = []
afterAll(async () => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))))

function metadata(phases: Record<string, PhaseMetadata>): RunMetadata {
  return {
    schemaVersion: 3,
    runID: "run-test",
    targetDir: "/repo",
    createdAt: 1,
    updatedAt: 1,
    control: { state: "running" },
    phases,
  }
}

function score(value: number): QualityScore {
  return { score: value, dimensions: { prd: 0, tests: 0, security: 0, maintainability: 0, operational: 0, scope: 0 }, verdict: "ready-with-caveats", mustFix: [], gaps: {} }
}

test("overall status requires every recorded phase to finish cleanly", () => {
  expect(overallStatus(metadata({ design: { status: "completed" }, review: { status: "skipped" } }))).toBe("completed")
  expect(overallStatus(metadata({ design: { status: "completed" }, review: { status: "failed" } }))).toBe("failed")
  expect(overallStatus(metadata({}))).toBe("failed")
})

test("history replay restores sessions and maps interrupted phases to failed", () => {
  const sessions: Array<[string, string]> = []
  const restored: Array<[string, ProgressPhaseSnapshot]> = []
  const progress: ProgressUI = {
    ...noopProgress,
    phaseSession: (name, sessionID) => sessions.push([name, sessionID]),
    phaseRestored: (name, snapshot) => restored.push([name, snapshot]),
  }

  replayHistory(progress, metadata({
    design: { status: "completed", sessionID: "ses-design", cost: 0.1 },
    build: { status: "running", sessionID: "ses-build" },
    review: { status: "pending" },
  }))

  expect(sessions).toEqual([["design", "ses-design"], ["build", "ses-build"]])
  expect(restored).toEqual([
    ["design", expect.objectContaining({ status: "completed", sessionID: "ses-design", cost: 0.1 })],
    ["build", expect.objectContaining({ status: "failed", sessionID: "ses-build" })],
  ])
})

test("goalLoopViewFrom reconstructs the dashboard's goal view from the durable record", () => {
  expect(goalLoopViewFrom(undefined)).toBeUndefined()

  const goal: GoalRunState = {
    target: 90,
    maxIterations: 3,
    plateau: 3,
    iteration: 2,
    stage: "complete",
    scores: [score(71), score(92)],
    bestScore: 92,
    outcome: "goal",
    restored: false,
  }
  expect(goalLoopViewFrom(goal)).toEqual({
    target: 90,
    iteration: 2,
    maxRuns: 4,
    plateau: 3,
    scores: [71, 92],
    outcome: { reason: "goal", reached: true, restored: false },
  })
})

test("goalLoopViewFrom maps every settled outcome to the dashboard verdict", () => {
  const base: GoalRunState = { target: 85, maxIterations: 3, plateau: 3, iteration: 1, stage: "complete", scores: [score(71), score(84)], bestScore: 84 }
  expect(goalLoopViewFrom({ ...base, outcome: "plateau", restored: true })?.outcome).toEqual({
    reason: "plateau",
    reached: false,
    restored: true,
  })
  expect(goalLoopViewFrom({ ...base, outcome: "max-iterations" })?.outcome).toEqual({
    reason: "max-iterations",
    reached: false,
    restored: false,
  })
  expect(goalLoopViewFrom({ ...base, outcome: "no-score" })?.outcome).toEqual({
    reason: "no-score",
    reached: false,
    restored: false,
  })
  // A "failed" record left the cycle un-settled: no verdict is shown.
  expect(goalLoopViewFrom({ ...base, outcome: "failed" })?.outcome).toBeUndefined()
})

test("advisor journal reconciliation restores events missing from metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "convoy-attach-runtime-"))
  dirs.push(dir)
  await mkdir(join(dir, "events"))
  const event: AdvisorEvent = {
    id: "evt-1",
    type: "advisor.requested",
    timestamp: new Date(0).toISOString(),
    callId: "call-1",
    phase: "design",
    attempt: 1,
    trigger: "completion",
    budget: { used: 1, max: 2 },
    model: "anthropic/opus",
  }
  await writeFile(join(dir, "events", "advisor.jsonl"), `${JSON.stringify(event)}\n`)
  const run = metadata({})

  await reconcileAdvisorJournal(run, dir)

  expect(run.phases.design).toMatchObject({
    status: "pending",
    advisorEvents: [event],
    advisor: { attempted: 1 },
  })
})

describe("reconstructedPhases", () => {
  const ship = resolvePipeline({ name: "ship", spec: builtInPipelines.ship!, agents: builtInAgents })
  const goalPlan = ship.goalPlan!
  const qualified = (stage: "improve" | "measure", iteration: number) =>
    qualifyInvocation(stage, iteration, goalPlan[stage].steps).map((step) => step.name)

  function runMetadata(phases: Record<string, PhaseMetadata>, goal?: GoalRunState): RunMetadata {
    return {
      schemaVersion: 4,
      runID: "run-goal",
      targetDir: "/repo",
      createdAt: 1,
      updatedAt: 1,
      control: { state: "running" },
      pipeline: ship,
      phases,
      ...(goal ? { goal } : {}),
    }
  }

  test("rebuilds a stopped goal run's phases grouped per invocation, prefix and hooks first", () => {
    const metadata = runMetadata({
      "pre-hook-1": { status: "completed" },
      sync: { status: "completed" },
      ...Object.fromEntries(qualified("measure", 0).map((name) => [name, { status: "completed" as const }])),
      ...Object.fromEntries(qualified("improve", 1).map((name) => [name, { status: "completed" as const }])),
    })

    const rows = reconstructedPhases(metadata, false)
    expect(rows.map((row) => row.name)).toEqual([
      "pre-hook-1",
      "sync",
      "scope",
      "clean-code__openrouter-deepseek-deepseek-v4-flash-0731-high",
      "clean-code__openrouter-z-ai-glm-5-3-flash-high",
      "security__openrouter-deepseek-deepseek-v4-flash-0731-high",
      "security__openrouter-z-ai-glm-5-3-flash-high",
      "bugs__openrouter-deepseek-deepseek-v4-flash-0731-high",
      "bugs__openrouter-z-ai-glm-5-3-flash-high",
      "report",
      "triage",
      "fixes",
      "run-report",
      ...qualified("measure", 0),
      ...qualified("improve", 1),
      // The terminal lifecycle row closes every phase list (SC-2).
      "Compact run",
    ])
    // Display groups are per-invocation ids, never the shared fragment groupId.
    expect(new Set(rows.map((row) => row.groupId))).toEqual(
      new Set([undefined, "g1", "g2", "g3", "g4", "g5", "g6", "g7", "goal-measure-0", "goal-improve-1"]),
    )
  })

  test("a live run lists the in-flight invocation before its phases start", () => {
    const metadata = runMetadata(
      Object.fromEntries(qualified("measure", 0).map((name) => [name, { status: "completed" as const }])),
      { target: 85, maxIterations: 3, plateau: 3, iteration: 1, stage: "improve", scores: [] },
    )
    expect(reconstructedPhases(metadata, true).map((row) => row.groupId)).toEqual([
      "g1",
      "g2",
      ...Array(6).fill("g3"),
      "g4",
      "g5",
      "g6",
      "g7",
      ...qualified("measure", 0).map(() => "goal-measure-0"),
      ...qualified("improve", 1).map(() => "goal-improve-1"),
      // The lifecycle row is not a goal invocation; it has no group.
      undefined,
    ])
    // The same metadata on a settled (non-live) view lists no pending improve.
    expect(reconstructedPhases(metadata, false).map((row) => row.groupId)).not.toContain("goal-improve-1")
  })

  test("recorded goal-phase names survive as bare rows when no goal plan exists", () => {
    const legacy = { ...runMetadata({}), pipeline: resolvePipeline({ name: "fixer", spec: builtInPipelines.fixer!, agents: builtInAgents }) }
    legacy.phases = {
      "pre-hook-1": { status: "completed" },
      reproduction: { status: "completed" },
      "goal-measure-0-score-report": { status: "failed" },
    }
    expect(reconstructedPhases(legacy, false).map((row) => row.name)).toEqual([
      "pre-hook-1",
      "reproduction",
      "fixes",
      "validation",
      "goal-measure-0-score-report",
      // The lifecycle row still closes the list even for a legacy pipeline.
      "Compact run",
    ])
  })
})
