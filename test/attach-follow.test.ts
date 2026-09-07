import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { LiveAttach, liveGoalLoopView, waitForServerUrl } from "../src/attach-runtime"
import { claimAttachRole, startResetFollower, type AttachSession } from "../src/attach"
import { createControlClient } from "../src/control-client"
import { ControlProgress } from "../src/control-progress"
import { startControlServer } from "../src/control-server"
import { noopProgress, type ProgressMessage, type ProgressUI } from "../src/progress"
import { builtInAgents, builtInPipelines, resolvePipeline } from "../src/pipeline"
import { compactRunRowName } from "../src/runner"

import type { GoalRunState } from "../src/metadata"
import type { GoalLoopView } from "../src/progress"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "convoy-attach-follow-"))
  dirs.push(dir)
  return dir
}

const never = new Promise<unknown>(() => {})

describe("waitForServerUrl", () => {
  test("returns immediately when the run already recorded its server", async () => {
    const dir = await scratch()
    await writeFile(join(dir, "metadata.json"), JSON.stringify({ schemaVersion: 3, phases: {}, server: { url: "http://127.0.0.1:4321", pid: 1, startedAt: 1 } }))
    expect(await waitForServerUrl(join(dir, "metadata.json"), never)).toBe("http://127.0.0.1:4321")
  })

  test("waits until the server entry appears", async () => {
    const dir = await scratch()
    const metaPath = join(dir, "metadata.json")
    await writeFile(metaPath, JSON.stringify({ schemaVersion: 3, phases: {} }))
    const waiting = waitForServerUrl(metaPath, never, 10)
    await Bun.sleep(40)
    await writeFile(metaPath, JSON.stringify({ schemaVersion: 3, phases: {}, server: { url: "http://127.0.0.1:8765", pid: 2, startedAt: 2 } }))
    expect(await waiting).toBe("http://127.0.0.1:8765")
  })

  test("gives up when the caller leaves (coordinator died or user detached)", async () => {
    const dir = await scratch()
    const metaPath = join(dir, "metadata.json")
    await writeFile(metaPath, JSON.stringify({ schemaVersion: 3, phases: {} }))
    const abort = Promise.resolve("gone")
    expect(await waitForServerUrl(metaPath, abort, 10)).toBeUndefined()
  })

  test("tolerates missing metadata (a run dir that never got one)", async () => {
    const dir = await scratch()
    // A missing file must poll, not throw — the workspace may not exist yet.
    const waiting = waitForServerUrl(join(dir, "none", "metadata.json"), never, 10)
    await mkdir(join(dir, "none"), { recursive: true })
    await writeFile(join(dir, "none", "metadata.json"), JSON.stringify({ schemaVersion: 3, phases: {}, server: { url: "http://127.0.0.1:9", pid: 3, startedAt: 3 } }))
    expect(await waiting).toBe("http://127.0.0.1:9")
  })
})

/**
 * LiveAttach's view-following: rows, header goal segments, and session
 * transcripts must all follow a live goal cycle from durable state alone.
 * The fake dashboard records what a real TuiProgress would receive; the fake
 * opencode client answers session history for the backfill tests. Following
 * is driven purely by polled metadata, so these tests are role-agnostic: an
 * observer dashboard runs the very same LiveAttach (attach.ts builds it
 * identically for controllers and reset-following observers).
 */
/** An opencode client whose only life is the session-history endpoint. */
const historyClient = (messages: unknown[]) =>
  ({
    event: { subscribe: async () => ({ stream: (async function* () { await new Promise<void>(() => {}) })() }) },
    session: { messages: async () => ({ data: messages }), status: async () => ({ data: {} }) },
  }) as never

/** Records what a real TuiProgress would receive; shared by both follow describes. */
function fakeTui() {
  const state = {
    tui: undefined as unknown as ProgressUI,
    synced: [] as string[][],
    goalViews: [] as GoalLoopView[],
    started: [] as string[],
    restored: [] as string[],
    sessions: [] as string[],
    messages: [] as ProgressMessage[],
    resets: [] as string[],
  }
  state.tui = {
    ...noopProgress,
    syncPhases: (rows) => void state.synced.push(rows.map((row) => row.name)),
    setGoalLoop: (view) => void state.goalViews.push(view),
    phaseStarted: (name) => void state.started.push(name),
    phaseRestored: (name) => void state.restored.push(name),
    phaseSession: (name, id) => void state.sessions.push(`${name}:${id}`),
    phaseMessage: (name, message) => void state.messages.push(message),
    resetPipeline: (_rows, next) => void state.resets.push(next.runID),
  }
  return state
}

describe("LiveAttach follows a goal cycle", () => {
  const ship = () => resolvePipeline({ name: "ship", spec: builtInPipelines.ship!, agents: builtInAgents })

  const qualifiedNames = (plan: NonNullable<ReturnType<typeof ship>["goalPlan"]>, stage: "improve" | "measure", iteration: number) =>
    plan[stage].steps.map((step) => `goal-${stage}-${iteration}-${step.name}`)

  async function writeMeta(dir: string, body: unknown) {
    await writeFile(join(dir, "metadata.json"), JSON.stringify(body))
  }

  const baseMeta = (pipeline: ReturnType<typeof ship>) => ({
    schemaVersion: 4,
    runID: "20260905-000000-goal",
    targetDir: "/repo",
    createdAt: 0,
    updatedAt: 0,
    control: { state: "running" as const },
    pipeline,
    phases: {},
  })

  test("a dashboard attached at measurement zero gains improve-one rows without re-attaching", async () => {
    const dir = await scratch()
    const pipeline = ship()
    const plan = pipeline.goalPlan!
    const measure0 = qualifiedNames(plan, "measure", 0)
    const improve1 = qualifiedNames(plan, "improve", 1)
    const prefixNames = pipeline.steps.map((step) => step.name)

    const meta = { ...baseMeta(pipeline), phases: Object.fromEntries(measure0.map((name, index) => [name, { status: index === 0 ? "running" : "completed", sessionID: `ses_${index}` }])) }
    await writeMeta(dir, meta)
    const state = fakeTui()
    // Every phase is marked without live attach: this test pins the metadata
    // flow (rows, events, header), not watcher mechanics.
    const attach = new LiveAttach(historyClient([]), state.tui, "/repo", join(dir, "metadata.json"), new Set([...prefixNames, ...measure0, ...improve1]), 10)
    try {
      await attach.start()

      // Measurement zero's rows are synced in canonical display order (prefix,
      // then the invocation, with the terminal lifecycle row last), its
      // running phase started, and every recorded session is attached to its row.
      expect(state.synced[0]).toEqual([...prefixNames, ...measure0, compactRunRowName])
      expect(state.started).toEqual([measure0[0]])
      expect(state.sessions).toEqual(measure0.map((name, index) => `${name}:ses_${index}`))
      expect(state.goalViews).toEqual([])

      // The scheduler checkpoints after measurement zero: the durable record
      // now names improvement one as the cycle's current position, and its
      // first phase starts running.
      const next = {
        ...baseMeta(pipeline),
        updatedAt: 1,
        phases: {
          ...Object.fromEntries(measure0.map((name) => [name, { status: "completed" }])),
          [improve1[0]]: { status: "running", sessionID: "ses_fix" },
        },
        goal: { target: plan.target, maxIterations: plan.maxIterations, plateau: plan.plateau, iteration: 1, stage: "improve", scores: [{ score: 81, verdict: "fair" }] },
      }
      await writeMeta(dir, next)
      for (let attempt = 0; attempt < 200 && !state.synced.at(-1)!.includes(improve1[0]); attempt++) await Bun.sleep(5)

      // The improvement's rows appeared through the ordinary poll — no
      // detach/re-attach — their events land on them, and the lifecycle row
      // still closes the payload.
      expect(state.synced.at(-1)).toEqual([...prefixNames, ...measure0, ...improve1, compactRunRowName])
      expect(state.started).toContain(improve1[0])
      expect(state.sessions).toContain(`${improve1[0]}:ses_fix`)
      // Measurement zero's completion is restored onto its existing rows, and
      // the header advanced to the checkpointed trajectory.
      expect(state.restored).toContain(measure0[0])
      expect(state.goalViews.at(-1)).toEqual({ target: plan.target, iteration: 2, maxRuns: 1 + plan.maxIterations, plateau: plan.plateau, scores: [81] })
    } finally {
      await attach.stop()
    }
  })

  test("a mid-cycle attach shows the accumulated trajectory on its first tick", async () => {
    const dir = await scratch()
    const pipeline = ship()
    const plan = pipeline.goalPlan!
    const meta = {
      ...baseMeta(pipeline),
      goal: { target: plan.target, maxIterations: plan.maxIterations, plateau: plan.plateau, iteration: 2, stage: "improve", scores: [{ score: 81, verdict: "fair" }, { score: 90, verdict: "good" }] },
    }
    await writeMeta(dir, meta)
    const state = fakeTui()
    const attach = new LiveAttach(historyClient([]), state.tui, "/repo", join(dir, "metadata.json"), new Set(["everything"]), 10)
    try {
      await attach.start()
      expect(state.goalViews).toEqual([{ target: plan.target, iteration: 3, maxRuns: 1 + plan.maxIterations, plateau: plan.plateau, scores: [81, 90] }])
    } finally {
      await attach.stop()
    }
  })

  test("a run without a goal step never grows goal header segments", async () => {
    const dir = await scratch()
    const pipeline = resolvePipeline({ name: "fixer", spec: builtInPipelines.fixer!, agents: builtInAgents })
    await writeMeta(dir, { ...baseMeta(pipeline), phases: { fix: { status: "running", sessionID: "ses_1" } } })
    const state = fakeTui()
    const attach = new LiveAttach(historyClient([]), state.tui, "/repo", join(dir, "metadata.json"), new Set(["fix"]), 10)
    try {
      await attach.start()
      await Bun.sleep(40)
      // The prefix rows sync (a no-op merge on the dashboard) and no view is
      // ever derived.
      expect(state.synced.at(-1)).toEqual(pipeline.steps.map((step) => step.name).concat(compactRunRowName))
      expect(state.goalViews).toEqual([])
    } finally {
      await attach.stop()
    }
  })

  test("a running phase's watcher eagerly backfills the session it did not watch from birth", async () => {
    const dir = await scratch()
    const pipeline = resolvePipeline({ name: "fixer", spec: builtInPipelines.fixer!, agents: builtInAgents })
    await writeMeta(dir, { ...baseMeta(pipeline), phases: { fix: { status: "running", sessionID: "ses_1" } } })
    const state = fakeTui()
    const history = [
      {
        info: { id: "msg_1", role: "assistant", time: { created: 1, completed: 2 } },
        parts: [{ id: "mp1", type: "text", text: "earlier output" }],
      },
    ]
    const attach = new LiveAttach(historyClient(history), state.tui, "/repo", join(dir, "metadata.json"), new Set(), 10)
    try {
      await attach.start()
      for (let attempt = 0; attempt < 200 && state.messages.length === 0; attempt++) await Bun.sleep(5)
      expect(state.messages).toEqual([{ channel: "response", text: "earlier output", partID: "mp1" }])
    } finally {
      await attach.stop()
    }
  })

  test("a completed phase's session reconstructs once on request, from the live server", async () => {
    const dir = await scratch()
    const pipeline = resolvePipeline({ name: "fixer", spec: builtInPipelines.fixer!, agents: builtInAgents })
    await writeMeta(dir, { ...baseMeta(pipeline), phases: { fix: { status: "completed", sessionID: "ses_9" } } })
    const history = [
      {
        info: { id: "msg_1", role: "assistant", time: { created: 1, completed: 2 } },
        parts: [
          { id: "mr1", type: "reasoning", text: "planning" },
          { id: "mt1", type: "text", text: "final answer" },
        ],
      },
    ]
    const state = fakeTui()
    const attach = new LiveAttach(historyClient(history), state.tui, "/repo", join(dir, "metadata.json"), new Set(), 10)
    try {
      await attach.start()
      expect(state.messages).toEqual([])

      attach.requestSessionBackfill("fix")
      for (let attempt = 0; attempt < 200 && state.messages.length < 2; attempt++) await Bun.sleep(5)
      expect(state.messages).toEqual([
        { channel: "reasoning", text: "planning", partID: "mr1" },
        { channel: "response", text: "final answer", partID: "mt1" },
      ])

      // One attempt per phase: a second ask never re-emits.
      attach.requestSessionBackfill("fix")
      await Bun.sleep(40)
      expect(state.messages).toHaveLength(2)

      // A phase the attach cannot reconstruct (no live attach capability) is
      // refused without touching the client.
      attach.requestSessionBackfill("never-recorded")
      await Bun.sleep(40)
      expect(state.messages).toHaveLength(2)
    } finally {
      await attach.stop()
    }
  })

  test("a phase without live-attach capability never backfills", async () => {
    const dir = await scratch()
    const pipeline = resolvePipeline({ name: "fixer", spec: builtInPipelines.fixer!, agents: builtInAgents })
    await writeMeta(dir, { ...baseMeta(pipeline), phases: { fix: { status: "completed", sessionID: "ses_9" } } })
    const state = fakeTui()
    const attach = new LiveAttach(historyClient([]), state.tui, "/repo", join(dir, "metadata.json"), new Set(["fix"]), 10)
    try {
      await attach.start()
      attach.requestSessionBackfill("fix")
      await Bun.sleep(40)
      expect(state.messages).toEqual([])
    } finally {
      await attach.stop()
    }
  })

  test("a stopped attach's in-flight eager backfill never delivers into the reused view", async () => {
    // A hosted reset replaces the dashboard's view and stops the old attach;
    // its backfill fetch is still in flight. When the old server finally
    // answers, the stale history must not land in a phase name the next run
    // reuses — that would both show wrong content and suppress the new run's
    // correct lazy backfill.
    const dir = await scratch()
    const pipeline = resolvePipeline({ name: "fixer", spec: builtInPipelines.fixer!, agents: builtInAgents })
    await writeMeta(dir, { ...baseMeta(pipeline), phases: { fix: { status: "running", sessionID: "ses_1" } } })
    const state = fakeTui()
    let resolveMessages: (value: { data: unknown[] }) => void = () => {}
    const client = {
      event: { subscribe: async () => ({ stream: (async function* () { await new Promise<void>(() => {}) })() }) },
      session: { messages: () => new Promise<{ data: unknown[] }>((resolve) => { resolveMessages = resolve }), status: async () => ({ data: {} }) },
    } as never
    const attach = new LiveAttach(client, state.tui, "/repo", join(dir, "metadata.json"), new Set(), 10)
    await attach.start()
    await Bun.sleep(20) // the watcher subscribed; its backfill fetch is pending
    await attach.stop()
    resolveMessages({
      data: [
        {
          info: { id: "msg_1", role: "assistant", time: { created: 1, completed: 2 } },
          parts: [{ id: "mp1", type: "text", text: "stale history" }],
        },
      ],
    })
    await Bun.sleep(40)
    expect(state.messages).toEqual([])
  })

  test("a stopped attach's lazy backfill never delivers into the reused view", async () => {
    const dir = await scratch()
    const pipeline = resolvePipeline({ name: "fixer", spec: builtInPipelines.fixer!, agents: builtInAgents })
    await writeMeta(dir, { ...baseMeta(pipeline), phases: { fix: { status: "completed", sessionID: "ses_9" } } })
    const state = fakeTui()
    let resolveMessages: (value: { data: unknown[] }) => void = () => {}
    const client = {
      event: { subscribe: async () => ({ stream: (async function* () { await new Promise<void>(() => {}) })() }) },
      session: { messages: () => new Promise<{ data: unknown[] }>((resolve) => { resolveMessages = resolve }), status: async () => ({ data: {} }) },
    } as never
    const attach = new LiveAttach(client, state.tui, "/repo", join(dir, "metadata.json"), new Set(), 10)
    await attach.start()
    attach.requestSessionBackfill("fix") // the fetch is issued
    await attach.stop() // the view is replaced before the server answers
    resolveMessages({
      data: [
        {
          info: { id: "msg_1", role: "assistant", time: { created: 1, completed: 2 } },
          parts: [{ id: "mp1", type: "text", text: "stale history" }],
        },
      ],
    })
    await Bun.sleep(40)
    expect(state.messages).toEqual([])
  })
})

/**
 * Derivation parity: the durable record the scheduler checkpoints at each
 * stage boundary must yield, through `liveGoalLoopView`, the very view the
 * scheduler publishes at that boundary (`viewFor`: iteration = scores.length
 * + 1, the measurement about to run, 1-based). Settled records keep the
 * historical reconstruction (`goalLoopViewFrom`), which names the last
 * measured round and attaches the verdict.
 */
describe("goal header view parity", () => {
  const target = 85
  const maxIterations = 3
  const plateau = 3

  const recordOf = (stage: GoalRunState["stage"], iteration: number, scores: number[], extra: Partial<GoalRunState> = {}): GoalRunState => ({
    target,
    maxIterations,
    plateau,
    stage,
    iteration,
    scores: scores.map((score) => ({ score, dimensions: { security: score, tests: score, scope: score, prd: score, maintainability: score, operational: score }, verdict: score >= 90 ? "ready" : "not-ready", mustFix: [] })),
    ...extra,
  })

  test("each checkpoint reproduces the scheduler's published view", () => {
    const boundaries = [
      // After measurement zero lands: publish(iteration 2, [s0]), then
      // checkpoint {improve, 1}.
      { record: recordOf("improve", 1, [81]), published: { iteration: 2, scores: [81] } },
      // After improvement one executes: checkpoint {measure, 1}; the last
      // published view is still the one from measurement zero's landing.
      { record: recordOf("measure", 1, [81]), published: { iteration: 2, scores: [81] } },
      // After measurement one lands: publish(iteration 3, [s0, s1]), then
      // checkpoint {improve, 2}.
      { record: recordOf("improve", 2, [81, 90]), published: { iteration: 3, scores: [81, 90] } },
      { record: recordOf("measure", 2, [81, 90]), published: { iteration: 3, scores: [81, 90] } },
    ]
    for (const { record, published } of boundaries) {
      expect(liveGoalLoopView(record)).toEqual({
        target,
        maxRuns: 1 + maxIterations,
        plateau,
        ...published,
      })
    }
  })

  test("a settled record keeps the historical reconstruction with its verdict", () => {
    expect(liveGoalLoopView(recordOf("complete", 2, [81, 90], { outcome: "goal", restored: false }))).toEqual({
      target,
      iteration: 2,
      maxRuns: 1 + maxIterations,
      plateau,
      scores: [81, 90],
      outcome: { reason: "goal", reached: true, restored: false },
    })
    expect(liveGoalLoopView(recordOf("complete", 1, [81], { outcome: "plateau" }))?.outcome).toEqual({ reason: "plateau", reached: false, restored: false })
    expect(liveGoalLoopView(undefined)).toBeUndefined()
  })
})

/**
 * The observer path's composition band: a REAL control server, a REAL client
 * that lost the controller claim (409 → observer, exactly openRunDashboard's
 * claimAttachRole mapping), the REAL reset follower wired as the only poller,
 * and the REAL LiveAttach that openRunDashboard's startView builds for either
 * role. The dashboard itself is the recording fake TuiProgress (the attach
 * TUI is not injectable — same composition convention as
 * test/coordinated-hold.test.ts). Asserts that an observer dashboard grows
 * its rows and header identically to a controller's, purely from polled
 * metadata, while the reset follower rebinds its view across iteration
 * boundaries — and never answers a gate.
 */
describe("observer dashboard follows a goal cycle", () => {
  const ship = () => resolvePipeline({ name: "ship", spec: builtInPipelines.ship!, agents: builtInAgents })

  const qualifiedNames = (plan: NonNullable<ReturnType<typeof ship>["goalPlan"]>, stage: "improve" | "measure", iteration: number) =>
    plan[stage].steps.map((step) => `goal-${stage}-${iteration}-${step.name}`)

  const until = async (ready: () => boolean, timeoutMs = 2_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (ready()) return true
      await Bun.sleep(10)
    }
    return ready()
  }

  test("a reset-follower-only dashboard gains the same rows and header as a controller", async () => {
    const dir = await scratch()
    const server = await startControlServer()
    const progress = new ControlProgress({ server })

    // A first attach already holds the controller slot; the attach under test
    // loses the claim and must come up as a read-only observer.
    const controllerClient = createControlClient({ url: server.url, token: server.token })
    expect(await controllerClient.claimController()).toBe("controller")
    const observerClient = createControlClient({ url: server.url, token: server.token })
    expect(await claimAttachRole(observerClient)).toBe("observer")

    const pipeline = ship()
    const plan = pipeline.goalPlan!
    const measure0 = qualifiedNames(plan, "measure", 0)
    const improve1 = qualifiedNames(plan, "improve", 1)
    const prefixNames = pipeline.steps.map((step) => step.name)
    const withoutLiveAttach = new Set([...prefixNames, ...measure0, ...improve1])

    const runA = "20260905-000000-aaaa"
    const runADir = join(dir, runA)
    await mkdir(runADir, { recursive: true })
    const writeRunMeta = async (runDir: string, runID: string, phases: Record<string, unknown>, goal?: Record<string, unknown>) => {
      await writeFile(
        join(runDir, "metadata.json"),
        JSON.stringify({
          schemaVersion: 4,
          runID,
          targetDir: "/repo",
          createdAt: 0,
          updatedAt: Date.now(),
          control: { state: "running" },
          pipeline,
          phases,
          ...(goal ? { goal } : {}),
        }),
      )
    }
    await writeRunMeta(runADir, runA, Object.fromEntries(measure0.map((name, index) => [name, { status: index === 0 ? "running" : "completed", sessionID: `ses_${index}` }])))

    const state = (() => {
      const built = fakeTui()
      return built
    })()
    // openRunDashboard's observer wiring, verbatim: the view-following
    // LiveAttach from startView (no controller poller, no host controls) and
    // the reset follower as the only control-channel poller.
    let attach = new LiveAttach(historyClient([]), state.tui, "/repo", join(runADir, "metadata.json"), withoutLiveAttach, 10)
    await attach.start()
    let lastResetRunID = runA // the run it opened with: its stale boot echo is skipped
    const session: AttachSession = {
      tui: state.tui,
      view: () => ({ runDir: join(dir, lastResetRunID), metaPath: join(dir, lastResetRunID, "metadata.json") }),
      applyReset: (reset) => {
        if (reset.runID === lastResetRunID) return
        lastResetRunID = reset.runID
        state.tui.resetPipeline?.(reset.phases, { runID: reset.runID, targetDir: reset.targetDir, runDir: reset.runDir, pipeline: reset.pipeline })
        const runDir = join(dir, reset.runID)
        void (async () => {
          await attach.stop()
          attach = new LiveAttach(historyClient([]), state.tui, reset.targetDir, join(runDir, "metadata.json"), withoutLiveAttach, 10)
          await attach.start()
        })()
      },
      coordinatorGone: () => {},
      onFinishDismissed: () => {},
    }
    const follower = startResetFollower(observerClient, session, 10)
    try {
      // Identical growth to the controller follow test: metadata checkpoints
      // after measurement zero, and the observer's panel and header advance.
      await writeRunMeta(runADir, runA, { ...Object.fromEntries(measure0.map((name) => [name, { status: "completed" }])), [improve1[0]]: { status: "running", sessionID: "ses_fix" } }, { target: plan.target, maxIterations: plan.maxIterations, plateau: plan.plateau, iteration: 1, stage: "improve", scores: [{ score: 81, verdict: "ready" as const, dimensions: { security: 81, tests: 81, scope: 81, prd: 81, maintainability: 81, operational: 81 }, mustFix: [] }] })
      expect(await until(() => (state.synced.at(-1) ?? []).includes(improve1[0]))).toBe(true)
      expect(state.synced.at(-1)).toEqual([...prefixNames, ...measure0, ...improve1, compactRunRowName])
      expect(state.goalViews.at(-1)).toEqual({ target: plan.target, iteration: 2, maxRuns: 1 + plan.maxIterations, plateau: plan.plateau, scores: [81] })

      // The hosted loop's next iteration publishes a reset for a NEW runID:
      // the follower rebinds the view (resetPipeline + a fresh LiveAttach over
      // the next run's metadata), and the header/rows follow across the
      // boundary too.
      progress.start(runA, dir)
      const runB = "20260905-000000-bbbb"
      const runBDir = join(dir, runB)
      await mkdir(runBDir, { recursive: true })
      await writeRunMeta(runBDir, runB, { [improve1[0]]: { status: "running", sessionID: "ses_fix" } }, { target: plan.target, maxIterations: plan.maxIterations, plateau: plan.plateau, iteration: 1, stage: "improve", scores: [{ score: 81, verdict: "ready" as const, dimensions: { security: 81, tests: 81, scope: 81, prd: 81, maintainability: 81, operational: 81 }, mustFix: [] }] })
      const syncsBeforeReset = state.synced.length
      progress.resetPipeline([...prefixNames.map((name) => ({ name, description: "" }))], { runID: runB, targetDir: "/repo", runDir: runBDir, pipeline })
      expect(await until(() => state.resets.at(-1) === runB && state.synced.length > syncsBeforeReset && state.synced.at(-1)!.includes(improve1[0]) && !(state.synced.at(-1) ?? []).some((name) => measure0.includes(name)))).toBe(true)
      // The rebound view's rows are the new iteration's, not the old run's.
      expect(state.synced.at(-1)).toEqual([...prefixNames, ...improve1, compactRunRowName])
      // The sticky reset is re-delivered on every poll; the same-runID dedupe
      // rebinds exactly once.
      await Bun.sleep(60)
      expect(state.resets.filter((runID) => runID === runB)).toHaveLength(1)
    } finally {
      follower.stop()
      await attach.stop()
      server.close()
    }
  })
})
