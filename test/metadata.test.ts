import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readRunMetadata, openRunMetadata, recordProgress, type RunMetadataStore } from "../src/metadata"
import type { RepoSnapshot } from "../src/git"
import type { Pipeline, AgentStep, HumanStep } from "../src/types"
import type { Workspace } from "../src/workspace"
import type { ProgressUI, GoalLoopView } from "../src/progress"
import type { AdvisorEvent } from "../src/advisor-events"

function validAgentStep(name: string): AgentStep {
  return {
    type: "agent",
    name,
    agentName: "default",
    description: `step ${name}`,
    model: "gpt-4",
    resolvedModel: { configured: "gpt-4", logical: "gpt-4", gateway: "configured", providerID: "openai", modelID: "gpt-4", target: "gpt-4" },
    inputFiles: [],
    inputDiff: false,
    reportPath: `reports/${name}.md`,
    groupId: name,
    stepName: name,
  }
}

function validPipeline(steps: (AgentStep | HumanStep)[]): Pipeline {
  return { name: "test-pipeline", steps }
}

async function withDir(name: string): Promise<{ dir: string; ws: Workspace; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), `convoy-test-meta-${name}-`))
  return {
    dir,
    ws: { dir, runID: "run-test" },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

function advisorRequestedEvent(id: string): AdvisorEvent {
  return {
    id,
    type: "advisor.requested",
    timestamp: new Date(0).toISOString(),
    callId: `call-${id}`,
    phase: "design",
    attempt: 1,
    trigger: "completion",
    budget: { used: 1, max: 3 },
    model: "anthropic/claude-opus-4",
  }
}

const baseV3 = {
  schemaVersion: 3 as const,
  runID: "run-test",
  targetDir: "/repo",
  createdAt: 1000,
  updatedAt: 2000,
  control: { state: "running" as const },
  phases: {},
}

describe("readRunMetadata", () => {
  test("returns undefined for a non-existent path", async () => {
    const result = await readRunMetadata("/nonexistent/path.json")
    expect(result).toBeUndefined()
  })

  test("parses v3 metadata", async () => {
    const { dir, cleanup } = await withDir("parse-v3")
    const path = `${dir}/metadata.json`
    await Bun.write(path, JSON.stringify(baseV3))
    try {
      const result = await readRunMetadata(path)
      expect(result).toBeDefined()
      expect(result!.schemaVersion).toBe(3)
      expect(result!.runID).toBe("run-test")
      expect(result!.control.state).toBe("running")
    } finally {
      await cleanup()
    }
  })

  test("ignores unknown schema version", async () => {
    const { dir, cleanup } = await withDir("unk")
    const path = `${dir}/metadata.json`
    await Bun.write(path, JSON.stringify({ ...baseV3, schemaVersion: 99 }))
    try {
      const result = await readRunMetadata(path)
      expect(result).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  test("ignores metadata with missing phases", async () => {
    const { dir, cleanup } = await withDir("noph")
    const path = `${dir}/metadata.json`
    await Bun.write(path, JSON.stringify({ schemaVersion: 3, runID: "test" }))
    try {
      const result = await readRunMetadata(path)
      expect(result).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  test("ignores corrupt JSON", async () => {
    const { dir, cleanup } = await withDir("corrupt")
    const path = `${dir}/metadata.json`
    await Bun.write(path, "not json")
    try {
      const result = await readRunMetadata(path)
      expect(result).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  test("normalizes v1 to schemaVersion 3", async () => {
    const { dir, cleanup } = await withDir("v1")
    const path = `${dir}/metadata.json`
    await Bun.write(path, JSON.stringify({ schemaVersion: 1, phases: { design: { status: "completed" } } }))
    try {
      const result = await readRunMetadata(path)
      expect(result).toBeDefined()
      expect(result!.schemaVersion).toBe(3)
      expect(result!.phases.design?.status).toBe("completed")
      expect(result!.control.state).toBe("running")
    } finally {
      await cleanup()
    }
  })

  test("normalizes v1 without control field", async () => {
    const { dir, cleanup } = await withDir("v1noc")
    const path = `${dir}/metadata.json`
    await Bun.write(path, JSON.stringify({ schemaVersion: 1, phases: { plan: { status: "running" } } }))
    try {
      const result = await readRunMetadata(path)
      expect(result).toBeDefined()
      expect(result!.schemaVersion).toBe(3)
      expect(result!.control.state).toBe("running")
      expect(result!.phases.plan?.status).toBe("running")
    } finally {
      await cleanup()
    }
  })

  test("normalizes v2 without control field", async () => {
    const { dir, cleanup } = await withDir("v2noc")
    const path = `${dir}/metadata.json`
    await Bun.write(path, JSON.stringify({ schemaVersion: 2, phases: { code: { status: "running" } } }))
    try {
      const result = await readRunMetadata(path)
      expect(result).toBeDefined()
      expect(result!.schemaVersion).toBe(3)
      expect(result!.control.state).toBe("running")
    } finally {
      await cleanup()
    }
  })

  test("round-trips a schema-v4 goal record with its complete goal state", async () => {
    const { dir, cleanup } = await withDir("v4goal")
    const path = `${dir}/metadata.json`
    const goal = {
      target: 90,
      maxIterations: 3,
      plateau: 3,
      iteration: 1,
      stage: "complete" as const,
      scores: [
        { score: 71, dimensions: { prd: 60, tests: 70, security: 90, maintainability: 80, operational: 85, scope: 80 }, verdict: "not-ready", mustFix: [] },
        { score: 92, dimensions: { prd: 92, tests: 88, security: 95, maintainability: 90, operational: 94, scope: 90 }, verdict: "ready-with-caveats" as const, mustFix: ["SC-1"], gaps: { prd: "more tests" } },
      ],
      bestScore: 92,
      outcome: "goal",
      restored: false,
    }
    await Bun.write(
      path,
      JSON.stringify({ schemaVersion: 4, runID: "run-goal", targetDir: "/repo", createdAt: 1, updatedAt: 2, control: { state: "running" }, phases: {}, goal }),
    )
    try {
      const result = await readRunMetadata(path)
      expect(result).toBeDefined()
      expect(result!.schemaVersion).toBe(4)
      expect(result!.goal).toBeDefined()
      expect(result!.goal!.target).toBe(90)
      expect(result!.goal!.stage).toBe("complete")
      expect(result!.goal!.outcome).toBe("goal")
      expect(result!.goal!.bestScore).toBe(92)
      // Complete QualityScore objects, not just numbers: the trajectory and the
      // next improve brief can be rebuilt from the durable record.
      expect(result!.goal!.scores).toHaveLength(2)
      expect(result!.goal!.scores[0]!.score).toBe(71)
      expect(result!.goal!.scores[1]!.dimensions.prd).toBe(92)
      expect(result!.goal!.scores[1]!.mustFix).toEqual(["SC-1"])
      expect(result!.goal!.scores.map((entry) => entry.score)).toEqual([71, 92])
    } finally {
      await cleanup()
    }
  })

  test("a schema-v4 record without a goal member reads as a plain run with no goal state", async () => {
    const { dir, cleanup } = await withDir("v4nogoal")
    const path = `${dir}/metadata.json`
    await Bun.write(path, JSON.stringify({ schemaVersion: 4, runID: "run-plain", targetDir: "/repo", createdAt: 1, updatedAt: 2, control: { state: "running" }, phases: { a: { status: "completed" } } }))
    try {
      const result = await readRunMetadata(path)
      expect(result!.schemaVersion).toBe(4)
      expect(result!.goal).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  test("preserves pausing control state", async () => {
    const { dir, cleanup } = await withDir("pausing")
    const path = `${dir}/metadata.json`
    await Bun.write(path, JSON.stringify({ schemaVersion: 3, control: { state: "pausing" }, phases: {} }))
    try {
      const result = await readRunMetadata(path)
      expect(result!.control.state).toBe("pausing")
    } finally {
      await cleanup()
    }
  })

  test("preserves paused control state", async () => {
    const { dir, cleanup } = await withDir("paused")
    const path = `${dir}/metadata.json`
    await Bun.write(path, JSON.stringify({ schemaVersion: 3, control: { state: "paused" }, phases: {} }))
    try {
      const result = await readRunMetadata(path)
      expect(result!.control.state).toBe("paused")
    } finally {
      await cleanup()
    }
  })

  test("resets invalid control state to running", async () => {
    const { dir, cleanup } = await withDir("badctl")
    const path = `${dir}/metadata.json`
    await Bun.write(path, JSON.stringify({ schemaVersion: 3, control: { state: "stopped" }, phases: {} }))
    try {
      const result = await readRunMetadata(path)
      expect(result!.control.state).toBe("running")
    } finally {
      await cleanup()
    }
  })

  test("ignores null phases", async () => {
    const { dir, cleanup } = await withDir("nullph")
    const path = `${dir}/metadata.json`
    await Bun.write(path, JSON.stringify({ schemaVersion: 3, phases: null }))
    try {
      const result = await readRunMetadata(path)
      expect(result).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  test("ignores schemaVersion 0", async () => {
    const { dir, cleanup } = await withDir("v0")
    const path = `${dir}/metadata.json`
    await Bun.write(path, JSON.stringify({ schemaVersion: 0, phases: {} }))
    try {
      const result = await readRunMetadata(path)
      expect(result).toBeUndefined()
    } finally {
      await cleanup()
    }
  })
})

describe("openRunMetadata", () => {
  test("creates metadata file with defaults for a new run", async () => {
    const { dir, ws, cleanup } = await withDir("new")
    const pipeline = validPipeline([validAgentStep("design")])
    const store = await openRunMetadata(ws, "/target", pipeline)
    await store.flush()
    try {
      expect(store).toBeDefined()
      expect(store.controlState()).toBe("running")
      const raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw).toBeDefined()
      expect(raw!.runID).toBe("run-test")
      expect(raw!.targetDir).toBe("/target")
      expect(raw!.control.state).toBe("running")
    } finally {
      await cleanup()
    }
  })

  test("has all required methods on the store", async () => {
    const { dir, ws, cleanup } = await withDir("methods")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]))
    await store.flush()
    try {
      expect(typeof store.snapshot).toBe("function")
      expect(typeof store.phaseStatus).toBe("function")
      expect(typeof store.serverStarted).toBe("function")
      expect(typeof store.serverStopped).toBe("function")
      expect(typeof store.phaseStarted).toBe("function")
      expect(typeof store.phaseSession).toBe("function")
      expect(typeof store.phaseStepUsage).toBe("function")
      expect(typeof store.phaseUsageTotal).toBe("function")
      expect(typeof store.phaseAdvisorEvent).toBe("function")
      expect(typeof store.repositoryBaseline).toBe("function")
      expect(typeof store.phaseRepositoryBaseline).toBe("function")
      expect(typeof store.phaseEnded).toBe("function")
      expect(typeof store.controlState).toBe("function")
      expect(typeof store.setControlState).toBe("function")
      expect(typeof store.flush).toBe("function")
    } finally {
      await cleanup()
    }
  })

  test("phaseStarted updates status and timestamp", async () => {
    const { dir, ws, cleanup } = await withDir("pstart")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]))
    try {
      expect(store.phaseStatus("design")).toBe("pending")
      await store.phaseStarted("design")
      // Wait for persist to settle
      await store.flush()
      expect(store.phaseStatus("design")).toBe("running")
      const raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.phases.design?.status).toBe("running")
      expect(raw!.phases.design?.startedAt).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  })

  test("phaseStarted is idempotent for startedAt", async () => {
    const { dir, ws, cleanup } = await withDir("pidemp")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]))
    try {
      await store.phaseStarted("design")
      await store.flush()
      const first = (await readRunMetadata(`${dir}/metadata.json`))!.phases.design!.startedAt!
      await store.phaseStarted("design")
      await store.flush()
      const second = (await readRunMetadata(`${dir}/metadata.json`))!.phases.design!.startedAt!
      expect(second).toBe(first)
    } finally {
      await cleanup()
    }
  })

  test("phaseSession sets sessionID", async () => {
    const { dir, ws, cleanup } = await withDir("session")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]))
    try {
      store.phaseSession("design", "sess-abc")
      await store.flush()
      expect((await readRunMetadata(`${dir}/metadata.json`))!.phases.design?.sessionID).toBe("sess-abc")
    } finally {
      await cleanup()
    }
  })

  test("phaseEnded sets status, endedAt, and durationMs", async () => {
    const { dir, ws, cleanup } = await withDir("pend")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]))
    try {
      await store.phaseStarted("design")
      const before = Date.now()
      await store.phaseEnded("design", "completed")
      await store.flush()
      const raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.phases.design?.status).toBe("completed")
      expect(raw!.phases.design?.endedAt).toBeGreaterThanOrEqual(before)
      expect(raw!.phases.design?.durationMs).toBeGreaterThanOrEqual(0)
    } finally {
      await cleanup()
    }
  })

  test("serverStarted and serverStopped", async () => {
    const { dir, ws, cleanup } = await withDir("srv")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]))
    try {
      store.serverStarted("http://localhost:8080")
      await store.flush()
      let raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.server?.url).toBe("http://localhost:8080")
      expect(raw!.server?.pid).toBeGreaterThan(0)
      expect(raw!.server?.startedAt).toBeGreaterThan(0)

      await store.serverStopped()
      raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.server).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  test("setControlState from running to pausing to paused", async () => {
    const { dir, ws, cleanup } = await withDir("ctrl")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]))
    try {
      expect(store.controlState()).toBe("running")

      await store.setControlState("pausing")
      await store.flush()
      expect(store.controlState()).toBe("pausing")
      let raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.control.state).toBe("pausing")
      expect(raw!.control.requestedAt).toBeGreaterThan(0)
      expect(raw!.control.pausedAt).toBeUndefined()

      await store.setControlState("paused")
      await store.flush()
      expect(store.controlState()).toBe("paused")
      raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.control.state).toBe("paused")
      expect(raw!.control.pausedAt).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  })

  test("snapshot returns undefined for unknown phase", async () => {
    const { ws, cleanup } = await withDir("snap-unk")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]))
    try {
      expect(store.snapshot("nonexistent")).toBeUndefined()
    } finally {
      await store.flush()
      await cleanup()
    }
  })

  test("snapshot returns data for completed phase", async () => {
    const { ws, cleanup } = await withDir("snap")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]))
    try {
      await store.phaseStarted("design")
      await store.phaseEnded("design", "completed")
      const snap = store.snapshot("design")
      expect(snap).toBeDefined()
      expect(snap!.status).toBe("completed")
      expect(snap!.durationMs).toBeGreaterThanOrEqual(0)
    } finally {
      await cleanup()
    }
  })

  test("snapshot normalizes running to completed", async () => {
    const { ws, cleanup } = await withDir("snap-run")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]))
    try {
      await store.phaseStarted("design")
      const snap = store.snapshot("design")
      expect(snap!.status).toBe("completed")
    } finally {
      await cleanup()
    }
  })

  test("snapshot preserves skipped and failed", async () => {
    const { ws, cleanup } = await withDir("snap-sf")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design"), validAgentStep("code")]))
    try {
      await store.phaseStarted("design")
      await store.phaseEnded("design", "skipped")
      expect(store.snapshot("design")!.status).toBe("skipped")

      await store.phaseStarted("code")
      await store.phaseEnded("code", "failed")
      expect(store.snapshot("code")!.status).toBe("failed")
    } finally {
      await cleanup()
    }
  })

  test("phaseStepUsage accumulates", async () => {
    const { dir, ws, cleanup } = await withDir("pusage")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]))
    try {
      store.phaseStepUsage("design", { cost: 1.5, tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 150 }, model: "gpt-4" })
      await store.flush()
      let raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.phases.design?.cost).toBe(1.5)

      store.phaseStepUsage("design", { cost: 0.5, tokens: { input: 50, output: 25, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 75 } })
      await store.flush()
      raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.phases.design?.cost).toBe(2.0)
    } finally {
      await cleanup()
    }
  })

  test("phaseUsageTotal sets total", async () => {
    const { dir, ws, cleanup } = await withDir("tusage")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]))
    try {
      store.phaseUsageTotal("design", { cost: 10, tokens: { input: 1000, output: 500, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1500 }, model: "gpt-4" })
      await store.flush()
      const raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.phases.design?.cost).toBe(10)
    } finally {
      await cleanup()
    }
  })

  test("phaseAdvisorEvent deduplicates and aggregates", async () => {
    const { dir, ws, cleanup } = await withDir("adv")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]))
    try {
      const evt1 = advisorRequestedEvent("evt-1")
      store.phaseAdvisorEvent("design", evt1)
      await store.flush()
      let raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.phases.design?.advisorEvents).toHaveLength(1)

      store.phaseAdvisorEvent("design", evt1)
      await store.flush()
      raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.phases.design?.advisorEvents).toHaveLength(1)

      const evt2 = advisorRequestedEvent("evt-2")
      store.phaseAdvisorEvent("design", evt2)
      await store.flush()
      raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.phases.design?.advisorEvents).toHaveLength(2)
      expect(raw!.phases.design?.advisor?.attempted).toBe(2)
    } finally {
      await cleanup()
    }
  })

  test("default modelRouting gateway is configured", async () => {
    const { dir, ws, cleanup } = await withDir("gwdef")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]))
    await store.flush()
    try {
      const raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.modelRouting?.gateway).toBe("configured")
    } finally {
      await cleanup()
    }
  })

  test("explicit gateway sets modelRouting", async () => {
    const { dir, ws, cleanup } = await withDir("gwexp")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]), { gateway: "direct" })
    await store.flush()
    try {
      const raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.modelRouting?.gateway).toBe("direct")
    } finally {
      await cleanup()
    }
  })

  test("gatewayOverride updates modelRouting", async () => {
    const { dir, ws, cleanup } = await withDir("gwovr")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]), { gateway: "openrouter", gatewayOverride: true })
    await store.flush()
    try {
      const raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.modelRouting?.gateway).toBe("openrouter")
    } finally {
      await cleanup()
    }
  })

  test("modelOverride alone does not set modelRouting (it only reroutes step models)", async () => {
    const { dir, ws, cleanup } = await withDir("movr")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]), { modelOverride: true })
    await store.flush()
    try {
      const raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.modelRouting).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  test("resume resets paused to running", async () => {
    const { dir, ws, cleanup } = await withDir("resume")
    await Bun.write(`${dir}/metadata.json`, JSON.stringify({
      schemaVersion: 3,
      runID: "run-test",
      targetDir: "/target",
      createdAt: 1000,
      updatedAt: 2000,
      control: { state: "paused" },
      phases: {},
    }))
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]))
    await store.flush()
    try {
      expect(store.controlState()).toBe("running")
      const raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.control.state).toBe("running")
    } finally {
      await cleanup()
    }
  })

  test("checkpointGoal persists a durable goal record across reopen", async () => {
    const { dir, ws, cleanup } = await withDir("goal-state")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]))
    expect(store.goalState()).toBeUndefined()
    await store.checkpointGoal({
      target: 90,
      maxIterations: 3,
      plateau: 3,
      iteration: 1,
      stage: "measure",
      scores: [{ score: 71, dimensions: { prd: 60, tests: 70, security: 90, maintainability: 80, operational: 85, scope: 80 }, verdict: "not-ready", mustFix: [] }],
      bestScore: 71,
    })
    try {
      const raw = await readRunMetadata(`${dir}/metadata.json`)
      // New runs persist schema v5 (boundary/ledger/finalization era) while
      // goal records from the v4 era remain readable unchanged.
      expect(raw!.schemaVersion).toBe(5)
      expect(raw!.goal).toBeDefined()
      expect(raw!.goal!.stage).toBe("measure")
      expect(raw!.goal!.iteration).toBe(1)
      expect(raw!.goal!.scores[0]!.score).toBe(71)
      expect(raw!.goal!.bestScore).toBe(71)
      // A reopened store exposes the same durable record: resume derives its
      // next action from it rather than reconstructing a child pipeline.
      const reopened = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]))
      expect(reopened.goalState()!.scores.map((entry) => entry.score)).toEqual([71])
      expect(reopened.goalState()!.stage).toBe("measure")
    } finally {
      await cleanup()
    }
  })

  test("assertSafePipelineArtifacts: rejects null steps", async () => {
    const { ws, cleanup } = await withDir("err1")
    const bad = { name: "bad", steps: null } as unknown as Pipeline
    await expect(openRunMetadata(ws, "/target", bad)).rejects.toThrow("steps must be a list")
    await cleanup()
  })

  test("assertSafePipelineArtifacts: rejects unsafe step name", async () => {
    const { ws, cleanup } = await withDir("err2")
    const bad = validPipeline([{ ...validAgentStep("design"), name: "../escape" }])
    await expect(openRunMetadata(ws, "/target", bad)).rejects.toThrow("filesystem-safe name")
    await cleanup()
  })

  test("assertSafePipelineArtifacts: rejects wrong reportPath", async () => {
    const { ws, cleanup } = await withDir("err3")
    const bad = validPipeline([{ ...validAgentStep("design"), reportPath: "reports/other.md" }])
    await expect(openRunMetadata(ws, "/target", bad)).rejects.toThrow("report path")
    await cleanup()
  })

  test("assertSafePipelineArtifacts: rejects unknown step type", async () => {
    const { ws, cleanup } = await withDir("err4")
    const bad = {
      name: "test-pipeline",
      steps: [{ ...validAgentStep("design"), type: "invalid" }],
    } as unknown as Pipeline
    await expect(openRunMetadata(ws, "/target", bad)).rejects.toThrow("unknown step type")
    await cleanup()
  })

  test("assertSafePipelineArtifacts: rejects bad inputFiles", async () => {
    const { ws, cleanup } = await withDir("err5")
    const bad = validPipeline([{ ...validAgentStep("design"), inputFiles: ["../../etc/passwd"] }])
    await expect(openRunMetadata(ws, "/target", bad)).rejects.toThrow("input path")
    await cleanup()
  })

  test("assertSafePipelineArtifacts: accepts prd.md as input", async () => {
    const { ws, cleanup } = await withDir("ok1")
    const step = validAgentStep("design")
    step.inputFiles = ["prd.md"]
    const store = await openRunMetadata(ws, "/target", validPipeline([step]))
    try {
      expect(store).toBeDefined()
    } finally {
      await store.flush()
      await cleanup()
    }
  })

  test("assertSafePipelineArtifacts: accepts a frozen PRD history flag", async () => {
    const { ws, cleanup } = await withDir("history")
    const step = { ...validAgentStep("scope"), prdHistory: true }
    const store = await openRunMetadata(ws, "/target", validPipeline([step]))
    try {
      expect(store).toBeDefined()
    } finally {
      await store.flush()
      await cleanup()
    }
  })

  test("assertSafePipelineArtifacts: accepts reports/<step>.md as input", async () => {
    const { ws, cleanup } = await withDir("ok2")
    const step = validAgentStep("design")
    step.inputFiles = ["reports/previous-step.md"]
    const store = await openRunMetadata(ws, "/target", validPipeline([step]))
    try {
      expect(store).toBeDefined()
    } finally {
      await store.flush()
      await cleanup()
    }
  })

  test("human steps pass assertSafePipelineArtifacts", async () => {
    const { ws, cleanup } = await withDir("human")
    const pipeline = validPipeline([{ type: "human", name: "review", description: "human review" }])
    const store = await openRunMetadata(ws, "/target", pipeline)
    try {
      expect(store).toBeDefined()
      expect(store.phaseStatus("review")).toBeUndefined()
    } finally {
      await store.flush()
      await cleanup()
    }
  })

  test("repositoryBaseline round-trips", async () => {
    const { dir, ws, cleanup } = await withDir("baseline")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]))
    try {
      expect(store.repositoryBaseline("design")).toBeUndefined()
      const baseline: RepoSnapshot = { head: "abc123", ref: "refs/heads/main" }
      await store.phaseRepositoryBaseline("design", baseline)
      expect(store.repositoryBaseline("design")).toEqual(baseline)
      const raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.phases.design?.repositoryBaseline).toEqual(baseline)
    } finally {
      await cleanup()
    }
  })

  test("phaseStatus returns undefined for unknown phase", async () => {
    const { ws, cleanup } = await withDir("psunk")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]))
    try {
      expect(store.phaseStatus("nonexistent")).toBeUndefined()
    } finally {
      await store.flush()
      await cleanup()
    }
  })

  test("persists a title resolved once at open, preferring the change proposal over the branch slug and prompt", async () => {
    // A target checkout carrying the change the branch resolves to.
    const target = await mkdtemp(join(tmpdir(), "convoy-meta-title-target-"))
    const changeDir = join(target, "openspec", "changes", "add-attach-flow")
    await mkdir(changeDir, { recursive: true })
    await writeFile(join(changeDir, "proposal.md"), "# Attachment flow for run reports\n")

    const { dir, ws, cleanup } = await withDir("title")
    await writeFile(join(dir, "prd.md"), "# Implement the attach\n")
    const store = await openRunMetadata(ws, target, validPipeline([validAgentStep("design")]), { branch: "feat/add-attach-flow" })
    try {
      await store.flush()
      const raw = await readRunMetadata(`${dir}/metadata.json`)
      // The proposal title wins over the branch slug and the prompt line.
      expect(raw!.title).toBe("Attachment flow for run reports")
    } finally {
      await cleanup()
      await rm(target, { recursive: true, force: true })
    }
  })

  test("falls back to the humanized branch slug, then the prompt first line", async () => {
    const { ws, dir, cleanup } = await withDir("title-slug")
    await writeFile(join(dir, "prd.md"), "# Implement the attach\n")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]), { branch: "feat/quiet-notifications" })
    try {
      await store.flush()
      const raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.title).toBe("quiet notifications")
    } finally {
      await cleanup()
    }
  })

  test("a run without a branch or usable slug keeps the prompt fallback", async () => {
    const { ws, dir, cleanup } = await withDir("title-prompt")
    await writeFile(join(dir, "prd.md"), "# Refactor the retry loop\n\ndetails\n")
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]))
    try {
      await store.flush()
      const raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.title).toBe("Refactor the retry loop")
    } finally {
      await cleanup()
    }
  })

  test("re-opening an existing record never recomputes or replaces its title", async () => {
    const { ws, dir, cleanup } = await withDir("title-stable")
    const first = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]), { branch: "feat/quiet-notifications" })
    await first.flush()
    // A goal-loop reset rewrites the prompt document; the stored title must not follow it.
    await writeFile(join(dir, "prd.md"), "# A completely different prompt now\n")
    const reopened = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]), { branch: "feat/other-thing" })
    await reopened.flush()
    try {
      const raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.title).toBe("quiet notifications")
    } finally {
      await cleanup()
    }
  })

  test("a legacy record without a title gains one at open without disturbing its other fields", async () => {
    const { dir, ws, cleanup } = await withDir("title-legacy")
    await writeFile(join(dir, "metadata.json"), JSON.stringify({ ...baseV3 }))
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]), { branch: "feat/quiet-notifications" })
    try {
      await store.flush()
      const raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.schemaVersion).toBe(3)
      expect(raw!.title).toBe("quiet notifications")
    } finally {
      await cleanup()
    }
  })

  test("a resumed record's durable boundary branch outranks the caller's current branch", async () => {
    const { dir, ws, cleanup } = await withDir("title-boundary")
    await writeFile(
      join(dir, "metadata.json"),
      JSON.stringify({
        ...baseV3,
        boundary: { schemaVersion: 1, worktreeDir: "/repo", branch: "feat/boundary-change", startHead: "a".repeat(40), commonDir: "", includeDirty: false, recordedAt: 1 },
      }),
    )
    const store = await openRunMetadata(ws, "/target", validPipeline([validAgentStep("design")]), { branch: "feat/other-branch" })
    try {
      await store.flush()
      const raw = await readRunMetadata(`${dir}/metadata.json`)
      expect(raw!.title).toBe("boundary change")
    } finally {
      await cleanup()
    }
  })
})

describe("recordProgress", () => {
  function makeFakeUI(calls: string[]): ProgressUI {
    return {
      start: (runID: string, ..._: unknown[]) => { calls.push(`start(${runID})`) },
      serverReady: (url: string) => { calls.push(`serverReady(${url})`) },
      phaseStarted: (name: string, ..._: unknown[]) => { calls.push(`phaseStarted(${name})`) },
      phaseRunning: (name: string, ..._: unknown[]) => { calls.push(`phaseRunning(${name})`) },
      phaseAttempt: (name: string, ..._: unknown[]) => { calls.push(`phaseAttempt(${name})`) },
      phaseSession: (name: string, ..._: unknown[]) => { calls.push(`phaseSession(${name})`) },
      phaseActivity: (name: string, ..._: unknown[]) => { calls.push(`phaseActivity(${name})`) },
      phaseMessage: (name: string, ..._: unknown[]) => { calls.push(`phaseMessage(${name})`) },
      phaseStepUsage: (name: string, ..._: unknown[]) => { calls.push(`phaseStepUsage(${name})`) },
      phaseUsageTotal: (name: string, ..._: unknown[]) => { calls.push(`phaseUsageTotal(${name})`) },
      phaseAdvisorEvent: (name: string, ..._: unknown[]) => { calls.push(`phaseAdvisorEvent(${name})`) },
      phaseTodos: (name: string, ..._: unknown[]) => { calls.push(`phaseTodos(${name})`) },
      phaseDiff: (name: string, ..._: unknown[]) => { calls.push(`phaseDiff(${name})`) },
      phaseCompleted: (name: string, ..._: unknown[]) => { calls.push(`phaseCompleted(${name})`) },
      phaseSkipped: (name: string) => { calls.push(`phaseSkipped(${name})`) },
      phaseFailed: (name: string, ..._: unknown[]) => { calls.push(`phaseFailed(${name})`) },
      phaseRestored: (name: string, ..._: unknown[]) => { calls.push(`phaseRestored(${name})`) },
      message: (msg: string) => { calls.push(`message(${msg})`) },
      suspend: () => { calls.push("suspend()") },
      resume: () => { calls.push("resume()") },
      stop: () => { calls.push("stop()") },
    }
  }

  function makeMockStore(storeCalls: string[]): RunMetadataStore {
    return {
      pipeline: validPipeline([]),
      snapshot: () => undefined,
      phaseStatus: () => undefined,
      goalState: () => undefined,
      checkpointGoal: () => Promise.resolve(),
      boundary: () => undefined,
      recordBoundary: () => Promise.resolve(),
      ledger: () => [],
      appendLedgerEntry: () => Promise.resolve(),
      finalization: () => undefined,
      setFinalization: () => Promise.resolve(),
      serverStarted: (url: string) => { storeCalls.push(`serverStarted(${url})`) },
      serverStopped: () => Promise.resolve(),
      phaseStarted: (name: string) => { storeCalls.push(`phaseStarted(${name})`); return Promise.resolve() },
      phaseSession: (name: string) => { storeCalls.push(`phaseSession(${name})`) },
      phaseStepUsage: (name: string) => { storeCalls.push(`phaseStepUsage(${name})`) },
      phaseUsageTotal: (name: string) => { storeCalls.push(`phaseUsageTotal(${name})`) },
      phaseAdvisorEvent: (name: string) => { storeCalls.push(`phaseAdvisorEvent(${name})`) },
      repositoryBaseline: () => undefined,
      phaseRepositoryBaseline: () => Promise.resolve(),
      phaseEnded: (name: string, status: string) => { storeCalls.push(`phaseEnded(${name}, ${status})`); return Promise.resolve() },
      controlState: () => "running" as const,
      setControlState: () => Promise.resolve(),
      flush: () => Promise.resolve(),
    }
  }

  test("forwards start and serverReady to UI and store", async () => {
    const calls: string[] = []
    const storeCalls: string[] = []
    const fakeUI = makeFakeUI(calls)
    const mockStore = makeMockStore(storeCalls)
    const recorder = recordProgress(fakeUI, mockStore)

    recorder.start("run-1", "/repo", "/run-dir")
    expect(calls).toContain("start(run-1)")

    recorder.serverReady("http://localhost")
    expect(calls).toContain("serverReady(http://localhost)")
    expect(storeCalls).toContain("serverStarted(http://localhost)")
  })

  test("forwards phase lifecycle methods", async () => {
    const calls: string[] = []
    const fakeUI = makeFakeUI(calls)
    const mockStore = makeMockStore([])
    const recorder = recordProgress(fakeUI, mockStore)

    recorder.phaseRunning("design")
    expect(calls).toContain("phaseRunning(design)")

    recorder.phaseAttempt("design", { attempt: 1 })
    expect(calls).toContain("phaseAttempt(design)")

    recorder.phaseMessage("design", { channel: "response", text: "hello" })
    expect(calls).toContain("phaseMessage(design)")

    recorder.phaseActivity("design", "tool called", "tool", true)
    expect(calls).toContain("phaseActivity(design)")

    recorder.phaseTodos("design", [{ content: "todo1", status: "done" }])
    expect(calls).toContain("phaseTodos(design)")

    recorder.phaseDiff("design", { files: 3, additions: 10, deletions: 2 })
    expect(calls).toContain("phaseDiff(design)")

    recorder.phaseRestored("design", { status: "completed" })
    expect(calls).toContain("phaseRestored(design)")
  })

  test("forwards usage methods to both UI and store", async () => {
    const calls: string[] = []
    const storeCalls: string[] = []
    const fakeUI = makeFakeUI(calls)
    const mockStore = makeMockStore(storeCalls)
    const recorder = recordProgress(fakeUI, mockStore)

    recorder.phaseStepUsage("design", { cost: 0.5 })
    expect(calls).toContain("phaseStepUsage(design)")
    expect(storeCalls).toContain("phaseStepUsage(design)")

    recorder.phaseUsageTotal("design", { cost: 5.0 })
    expect(calls).toContain("phaseUsageTotal(design)")
    expect(storeCalls).toContain("phaseUsageTotal(design)")

    recorder.phaseAdvisorEvent("design", advisorRequestedEvent("evt-1"))
    expect(calls).toContain("phaseAdvisorEvent(design)")
    expect(storeCalls).toContain("phaseAdvisorEvent(design)")
  })

  test("forwards phaseCompleted, phaseSkipped, phaseFailed", async () => {
    const calls: string[] = []
    const storeCalls: string[] = []
    const fakeUI = makeFakeUI(calls)
    const mockStore = makeMockStore(storeCalls)
    const recorder = recordProgress(fakeUI, mockStore)

    await recorder.phaseCompleted("design")
    expect(calls).toContain("phaseCompleted(design)")
    expect(storeCalls).toContain("phaseEnded(design, completed)")

    await recorder.phaseSkipped("code")
    expect(calls).toContain("phaseSkipped(code)")
    expect(storeCalls).toContain("phaseEnded(code, skipped)")

    await recorder.phaseFailed("test")
    expect(calls).toContain("phaseFailed(test)")
    expect(storeCalls).toContain("phaseEnded(test, failed)")
  })

  test("forwards suspend, resume, stop, message", async () => {
    const calls: string[] = []
    const fakeUI = makeFakeUI(calls)
    const mockStore = makeMockStore([])
    const recorder = recordProgress(fakeUI, mockStore)

    recorder.suspend()
    expect(calls).toContain("suspend()")
    recorder.resume()
    expect(calls).toContain("resume()")
    recorder.stop()
    expect(calls).toContain("stop()")
    recorder.message("hi")
    expect(calls).toContain("message(hi)")
  })

  test("askPermission is bound when present", async () => {
    const calls: string[] = []
    let boundThis: unknown = null
    const fakeUI = makeFakeUI(calls)
    fakeUI.askPermission = async function (this: ProgressUI) { boundThis = this; return "once" }
    const mockStore = makeMockStore([])
    const recorder = recordProgress(fakeUI, mockStore)

    expect(typeof recorder.askPermission).toBe("function")
    if (recorder.askPermission) {
      const result = await recorder.askPermission({ id: "permission-1", permission: "read", patterns: ["src/**"] })
      expect(result).toBe("once")
      expect(boundThis).toBe(fakeUI)
    }
  })

  test("askHumanReview is bound when present", async () => {
    const calls: string[] = []
    const fakeUI = makeFakeUI(calls)
    let callArgs: unknown[] = []
    fakeUI.askHumanReview = async function (...args: unknown[]) { callArgs = args; return "iterate" }
    const mockStore = makeMockStore([])
    const recorder = recordProgress(fakeUI, mockStore)

    expect(typeof recorder.askHumanReview).toBe("function")
    if (recorder.askHumanReview) {
      const result = await recorder.askHumanReview({ stepName: "design", iterations: 0 })
      expect(result).toBe("iterate")
      expect(callArgs).toEqual([{ stepName: "design", iterations: 0 }])
    }
  })

  test("runFinished is bound when present", async () => {
    const calls: string[] = []
    const fakeUI = makeFakeUI(calls)
    let resolved: unknown = null
    fakeUI.runFinished = function (outcome: unknown) { resolved = outcome; return Promise.resolve() }
    const mockStore = makeMockStore([])
    const recorder = recordProgress(fakeUI, mockStore)

    expect(typeof recorder.runFinished).toBe("function")
    if (recorder.runFinished) {
      await recorder.runFinished({ status: "completed", runDir: "/tmp" })
      expect(resolved).toEqual({ status: "completed", runDir: "/tmp" })
    }
  })

  test("keepAwakeState is bound when present", async () => {
    const calls: string[] = []
    const fakeUI = makeFakeUI(calls)
    let state: unknown = null
    fakeUI.keepAwakeState = function (s: unknown) { state = s }
    const mockStore = makeMockStore([])
    const recorder = recordProgress(fakeUI, mockStore)

    expect(typeof recorder.keepAwakeState).toBe("function")
    if (recorder.keepAwakeState) {
      recorder.keepAwakeState({ status: "on", detail: "test" })
      expect(state).toEqual({ status: "on", detail: "test" })
    }
  })

  test("isInteractiveTakeover is bound when present", async () => {
    const calls: string[] = []
    const fakeUI = makeFakeUI(calls)
    fakeUI.isInteractiveTakeover = function () { return true }
    const mockStore = makeMockStore([])
    const recorder = recordProgress(fakeUI, mockStore)

    expect(typeof recorder.isInteractiveTakeover).toBe("function")
    if (recorder.isInteractiveTakeover) {
      expect(recorder.isInteractiveTakeover("design")).toBe(true)
    }
  })

  test("runStatus is bound when present", async () => {
    const fakeUI = makeFakeUI([])
    fakeUI.runStatus = function () {}
    const recorder = recordProgress(fakeUI, makeMockStore([]))
    expect(typeof recorder.runStatus).toBe("function")
  })

  test("runControlState is bound when present", async () => {
    const fakeUI = makeFakeUI([])
    fakeUI.runControlState = function () {}
    const recorder = recordProgress(fakeUI, makeMockStore([]))
    expect(typeof recorder.runControlState).toBe("function")
  })

  test("keepRunDirRequested is bound when present", async () => {
    const fakeUI = makeFakeUI([])
    fakeUI.keepRunDirRequested = function () { return false }
    const recorder = recordProgress(fakeUI, makeMockStore([]))
    expect(typeof recorder.keepRunDirRequested).toBe("function")
    if (recorder.keepRunDirRequested) {
      expect(recorder.keepRunDirRequested()).toBe(false)
    }
  })

  test("goal-loop hosting methods are bound when present", async () => {
    const calls: string[] = []
    const fakeUI = makeFakeUI(calls)
    const view: GoalLoopView = { target: 90, iteration: 2, maxRuns: 4, plateau: 3, scores: [71] }
    fakeUI.setGoalLoop = function (v: GoalLoopView) { calls.push(`setGoalLoop(${v.iteration})`) }
    fakeUI.resetPipeline = function () { calls.push("resetPipeline()") }
    fakeUI.setAbortHandler = function () { calls.push("setAbortHandler()") }
    fakeUI.setHostControls = function () { calls.push("setHostControls()") }
    const recorder = recordProgress(fakeUI, makeMockStore([]))

    expect(typeof recorder.setGoalLoop).toBe("function")
    if (recorder.setGoalLoop) recorder.setGoalLoop(view)
    if (recorder.resetPipeline) recorder.resetPipeline([], { runID: "r", targetDir: "/t", runDir: "", pipeline: { name: "goal-fix", steps: [] } })
    if (recorder.setAbortHandler) recorder.setAbortHandler(undefined)
    if (recorder.setHostControls) recorder.setHostControls({})

    expect(calls).toContain("setGoalLoop(2)")
    expect(calls).toContain("resetPipeline()")
    expect(calls).toContain("setAbortHandler()")
    expect(calls).toContain("setHostControls()")
  })

  test("goal-loop hosting methods are absent when UI lacks them", async () => {
    const fakeUI = makeFakeUI([])
    const recorder = recordProgress(fakeUI, makeMockStore([]))
    expect(recorder.setGoalLoop).toBeUndefined()
    expect(recorder.resetPipeline).toBeUndefined()
    expect(recorder.setAbortHandler).toBeUndefined()
    expect(recorder.setHostControls).toBeUndefined()
  })

  test("optional methods are absent when UI lacks them", async () => {
    const fakeUI = makeFakeUI([])
    const recorder = recordProgress(fakeUI, makeMockStore([]))
    expect(recorder.askPermission).toBeUndefined()
    expect(recorder.askHumanReview).toBeUndefined()
    expect(recorder.runFinished).toBeUndefined()
    expect(recorder.keepAwakeState).toBeUndefined()
    expect(recorder.isInteractiveTakeover).toBeUndefined()
    expect(recorder.runControlState).toBeUndefined()
    expect(recorder.runStatus).toBeUndefined()
    expect(recorder.keepRunDirRequested).toBeUndefined()
    expect(recorder.setGoalLoop).toBeUndefined()
    expect(recorder.resetPipeline).toBeUndefined()
    expect(recorder.setAbortHandler).toBeUndefined()
    expect(recorder.setHostControls).toBeUndefined()
  })
})
