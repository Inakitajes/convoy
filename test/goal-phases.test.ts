import { describe, expect, test } from "bun:test"

import { goalInvocationSequence, goalProgressPhases } from "../src/goal-phases"
import { qualifyInvocation } from "../src/goal-scheduler"
import { builtInAgents, builtInPipelines, resolvePipeline } from "../src/pipeline"
import type { AgentStep } from "../src/types"

const ship = () => resolvePipeline({ name: "ship", spec: builtInPipelines.ship!, agents: builtInAgents })

/** The qualified physical phase names of one invocation. */
function qualifiedNames(plan: NonNullable<ReturnType<typeof ship>["goalPlan"]>, stage: "improve" | "measure", iteration: number): string[] {
  return qualifyInvocation(stage, iteration, plan[stage].steps).map((step) => step.name)
}

describe("goalProgressPhases", () => {
  test("returns nothing for pipelines without a goal plan", () => {
    const pipeline = resolvePipeline({ name: "fixer", spec: builtInPipelines.fixer!, agents: builtInAgents })
    expect(goalProgressPhases(pipeline, new Set(["anything"]))).toEqual([])
  })

  test("reconstructs a recorded measurement with fan-out nesting under one invocation group", () => {
    const pipeline = ship()
    const plan = pipeline.goalPlan!
    const recorded = new Set(qualifiedNames(plan, "measure", 0))

    const rows = goalProgressPhases(pipeline, recorded)
    expect(rows.map((row) => row.name)).toEqual(qualifiedNames(plan, "measure", 0))
    // Every row carries the invocation's display group id, not the fragment's
    // positional groupId (`measure-g1`) that every measurement round shares.
    expect(rows.every((row) => row.groupId === "goal-measure-0")).toBe(true)
    // The fanned-out scorers keep their logical step name, model labels, and
    // read-only status; the singleton consensus keeps its own step name.
    const scorers = rows.filter((row) => row.stepName === "score")
    expect(scorers).toHaveLength(2)
    expect(scorers.every((row) => row.readOnly && row.plannedModel)).toBe(true)
    // Each fan-out member carries its model variant, so the tree can render the
    // model label with its `#high` suffix rather than an anonymous id.
    expect(scorers.every((row) => row.plannedVariant === "high")).toBe(true)
    expect(scorers.map((row) => row.plannedModel)).not.toEqual([scorers[0]!.plannedModel, scorers[0]!.plannedModel])
    const consensus = rows.find((row) => row.stepName === "score-report")
    expect(consensus).toBeDefined()
    expect(consensus!.name).toBe(qualifiedNames(plan, "measure", 0).at(-1)!)
  })

  test("emits invocations in execution order and keeps rounds as distinct groups", () => {
    const pipeline = ship()
    const plan = pipeline.goalPlan!
    const recorded = new Set([
      ...qualifiedNames(plan, "measure", 0),
      ...qualifiedNames(plan, "improve", 1),
      ...qualifiedNames(plan, "measure", 1),
    ])

    const rows = goalProgressPhases(pipeline, recorded)
    const groupIdOf = (stage: "improve" | "measure", iteration: number) => `goal-${stage}-${iteration}`
    expect(rows.map((row) => row.groupId)).toEqual([
      ...Array(qualifiedNames(plan, "measure", 0).length).fill(groupIdOf("measure", 0)),
      ...Array(qualifiedNames(plan, "improve", 1).length).fill(groupIdOf("improve", 1)),
      ...Array(qualifiedNames(plan, "measure", 1).length).fill(groupIdOf("measure", 1)),
    ])
  })

  test("a settled run lists only executed invocations", () => {
    const pipeline = ship()
    const plan = pipeline.goalPlan!
    // Stopped right after measurement zero: no improvement rows may appear,
    // even live, once the record carries an outcome.
    const recorded = new Set(qualifiedNames(plan, "measure", 0))
    const settled = { stage: "complete" as const, iteration: 0, outcome: "goal" as const, target: 85, maxIterations: 3, plateau: 3, scores: [] }
    expect(goalProgressPhases(pipeline, recorded, { live: true, goal: settled }).every((row) => row.groupId === "goal-measure-0")).toBe(true)
    expect(goalProgressPhases(pipeline, new Set(), { live: false, goal: { ...settled, outcome: undefined } })).toEqual([])
  })

  test("a live run seeds the in-flight invocation before any of its phases starts", () => {
    const pipeline = ship()
    const plan = pipeline.goalPlan!
    const recorded = new Set(qualifiedNames(plan, "measure", 0))
    const goal = { stage: "improve" as const, iteration: 1, target: 85, maxIterations: 3, plateau: 3, scores: [] }

    const rows = goalProgressPhases(pipeline, recorded, { live: true, goal })
    expect(rows.map((row) => row.groupId)).toEqual([
      ...Array(qualifiedNames(plan, "measure", 0).length).fill("goal-measure-0"),
      ...Array(qualifiedNames(plan, "improve", 1).length).fill("goal-improve-1"),
    ])
    expect(rows.slice(-1)[0]!.name).toBe(qualifiedNames(plan, "improve", 1).at(-1)!)
  })

  test("the in-flight seed is gated on liveness and an unsettled record", () => {
    const pipeline = ship()
    const plan = pipeline.goalPlan!
    const goal = { stage: "measure" as const, iteration: 1, target: 85, maxIterations: 3, plateau: 3, scores: [] }
    // Not live: no seed.
    expect(goalProgressPhases(pipeline, new Set(), { live: false, goal })).toEqual([])
    // Live but settled: no seed.
    expect(goalProgressPhases(pipeline, new Set(), { live: true, goal: { ...goal, outcome: "plateau" } })).toEqual([])
    // No durable record at all: nothing to seed.
    expect(goalProgressPhases(pipeline, new Set(), { live: true })).toEqual([])
  })

  test("respects the policy's improvement cap when enumerating the sequence", () => {
    const pipeline = ship()
    expect(goalInvocationSequence(pipeline.goalPlan!).map((invocation) => `${invocation.stage}-${invocation.iteration}`)).toEqual([
      "measure-0",
      "improve-1",
      "measure-1",
      "improve-2",
      "measure-2",
      "improve-3",
      "measure-3",
      "improve-4",
      "measure-4",
      "improve-5",
      "measure-5",
    ])
  })

  test("qualified goal rows carry their iteration-qualified report paths", () => {
    const pipeline = ship()
    const plan = pipeline.goalPlan!
    const recorded = new Set([...qualifiedNames(plan, "measure", 0), ...qualifiedNames(plan, "improve", 1)])

    const rows = goalProgressPhases(pipeline, recorded)
    for (const row of rows) {
      const qualified = /^goal-(improve|measure)-(\d+)-(.+)$/.exec(row.name)!
      expect(row.reportPath).toBe(`reports/goal/iteration-${qualified[2]}/${qualified[1]}/${qualified[3]}.md`)
    }
    // The consensus step of measurement zero points at its own round's report,
    // not the promoted conventional copy or another round's.
    const consensus = rows.find((row) => row.stepName === "score-report")!
    expect(consensus.reportPath).toBe(`reports/goal/iteration-0/measure/${consensus.stepName}.md`)
  })

  test("prefix rows keep their canonical report paths alongside the goal rows", () => {
    const pipeline = ship()
    const plan = pipeline.goalPlan!
    const recorded = new Set(qualifiedNames(plan, "measure", 0))
    const rows = goalProgressPhases(pipeline, recorded)
    // Prefix rows are not part of the reconstruction; the assertion here is
    // that the qualified mapping did not leak a goal path onto a prefix-named
    // row if any prefix step shared a logical name with a fragment step.
    for (const row of rows) {
      if (pipeline.steps.some((step) => step.name === row.name)) {
        expect(row.reportPath).toBe(`reports/${row.name}.md`)
      }
    }
  })
})
