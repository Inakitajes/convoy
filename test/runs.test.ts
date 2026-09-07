import { createServer, type Server } from "node:net"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { isServerLive, listRuns, probeRunWaiting, refreshRunWaiting } from "../src/runs"
import { startControlServer, type ControlServer } from "../src/control-server"

function listen(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("no port"))
      resolve({ port: address.port, close: () => server.close() })
    })
  })
}

let root: string
let savedHome: string | undefined
let convoyHomeDir: string

beforeAll(async () => {
  // Isolate the cleanup-surviving run-record index. listRuns merges workspace
  // runs with the index under <convoy-home>/run-records, so a parallel
  // finalization test writing a real record would otherwise leak that run into
  // this listing and make these assertions platform/timing dependent.
  savedHome = process.env.CONVOY_HOME
  convoyHomeDir = await mkdtemp(join(tmpdir(), "convoy-home-"))
  process.env.CONVOY_HOME = convoyHomeDir

  root = await mkdtemp(join(tmpdir(), "convoy-runs-test-"))

  // Newer run with metadata: gets targetDir, phase summary, and cost.
  const newer = join(root, "20260610-120000-bbbb")
  await mkdir(newer, { recursive: true })
  await writeFile(join(newer, "prd.md"), "# Add onboarding\n\ndetails\n")
  await writeFile(
    join(newer, "metadata.json"),
    JSON.stringify({
      schemaVersion: 1,
      runID: "20260610-120000-bbbb",
      targetDir: "/tmp/repo",
      createdAt: 1,
      updatedAt: 2,
      phases: {
        implementer: { status: "completed", cost: 1.25 },
        tests: { status: "failed", cost: 0.25 },
      },
    }),
  )

  // Older run from before metadata.json existed.
  await mkdir(join(root, "20260601-090000-aaaa"), { recursive: true })

  // Not a run ID; must be ignored.
  await mkdir(join(root, "not-a-run"), { recursive: true })
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(convoyHomeDir, { recursive: true, force: true })
  if (savedHome === undefined) delete process.env.CONVOY_HOME
  else process.env.CONVOY_HOME = savedHome
})

describe("run history listing", () => {
  test("lists valid runs newest first with metadata details", async () => {
    const runs = await listRuns(root)

    expect(runs.map((run) => run.runID)).toEqual(["20260610-120000-bbbb", "20260601-090000-aaaa"])

    const [newer, older] = runs
    expect(newer!.dir).toBe(join(root, "20260610-120000-bbbb"))
    expect(newer!.title).toBe("Add onboarding")
    expect(newer!.targetDir).toBe("/tmp/repo")
    expect(newer!.status).toBe("failed (1/2 ok)")
    expect(newer!.cost).toBeCloseTo(1.5)

    expect(older!.title).toBe("(no prd)")
    expect(older!.targetDir).toBeUndefined()
    expect(older!.status).toBe("-")
    expect(older!.cost).toBeUndefined()
  })

  test("a schema-v4 goal run exposes its score, trajectory, stage, and outcome in history", async () => {
    const runID = "20260614-000000-gool"
    const dir = join(root, runID)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "prd.md"), "# Goal run\n")
    await writeFile(
      join(dir, "metadata.json"),
      JSON.stringify({
        schemaVersion: 4,
        runID,
        targetDir: "/tmp/repo",
        createdAt: 1,
        updatedAt: 2,
        control: { state: "running" },
        phases: { "goal-measure-0-score": { status: "completed" }, "goal-measure-1-score-report": { status: "completed" } },
        goal: {
          target: 90,
          maxIterations: 3,
          plateau: 3,
          iteration: 1,
          stage: "complete",
          scores: [
            { score: 71, dimensions: { prd: 60, tests: 70, security: 90, maintainability: 80, operational: 85, scope: 80 }, verdict: "not-ready", mustFix: [] },
            { score: 92, dimensions: { prd: 92, tests: 88, security: 95, maintainability: 90, operational: 94, scope: 90 }, verdict: "ready-with-caveats", mustFix: [] },
          ],
          bestScore: 92,
          outcome: "goal",
          restored: false,
        },
      }),
    )
    const runs = await listRuns(root)
    const run = runs.find((entry) => entry.runID === runID)!
    expect(run.goal).toBeDefined()
    expect(run.goal!.target).toBe(90)
    expect(run.goal!.stage).toBe("complete")
    expect(run.goal!.outcome).toBe("goal")
    expect(run.goal!.score).toBe(92)
    expect(run.goal!.trajectory).toEqual([71, 92])
    expect(run.goal!.restored).toBe(false)
    // The completion of every recorded phase keeps the status a normal completion.
    expect(run.statusKind).toBe("completed")
  })

  test("returns empty for a missing root", async () => {
    expect(await listRuns(join(root, "does-not-exist"))).toEqual([])
  })

  test("runs without a live server entry are not live", async () => {
    const [newer] = await listRuns(root)
    expect(newer!.live).toBe(false)
    expect(newer!.serverUrl).toBeUndefined()
  })

  test("combines metadata and attempt-log executor costs without double counting, plus advisor journal cost", async () => {
    const runID = "20260611-120000-mixd"
    const dir = join(root, runID)
    await mkdir(join(dir, "logs"), { recursive: true })
    await mkdir(join(dir, "events"), { recursive: true })
    await writeFile(join(dir, "prd.md"), "# Mixed cost recovery\n")
    await writeFile(join(dir, "metadata.json"), JSON.stringify({
      schemaVersion: 3,
      runID,
      targetDir: "/tmp/repo",
      createdAt: 1,
      updatedAt: 2,
      control: { state: "running" },
      phases: {
        build: { status: "completed", cost: 1 },
        tests: { status: "completed" },
      },
    }))
    await writeFile(join(dir, "logs", "build.1.json"), JSON.stringify({ cost: 1, tokens: { output: 100 } }))
    await writeFile(join(dir, "logs", "tests.1.json"), JSON.stringify({ cost: 2, tokens: { output: 200 } }))
    const event = {
      id: "evt-1",
      type: "advisor.completed",
      timestamp: new Date(0).toISOString(),
      callId: "call-1",
      phase: "tests",
      attempt: 1,
      trigger: "completion",
      budget: { used: 1, max: 3 },
      model: "anthropic/opus",
      latencyMs: 10,
      adviceChars: 3,
      usage: { model: "anthropic/opus", cost: 0.2, tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
    }
    await writeFile(join(dir, "events", "advisor.jsonl"), `${JSON.stringify(event)}\n`)

    const run = (await listRuns(root)).find((entry) => entry.runID === runID)!

    expect(run.executorCost).toBe(3)
    expect(run.advisorCost).toBe(0.2)
    expect(run.cost).toBe(3.2)
  })
})

describe("run liveness detection", () => {
  test("no server entry is never live", async () => {
    expect(await isServerLive(undefined)).toBe(false)
  })

  test("a dead process is not live", async () => {
    const proc = Bun.spawn(["true"])
    await proc.exited
    expect(await isServerLive({ url: "http://127.0.0.1:59999", pid: proc.pid, startedAt: Date.now() })).toBe(false)
  })

  test("an alive process whose port isn't listening is not live", async () => {
    // Nothing is bound here, so the TCP probe must fail even though the pid is alive.
    expect(await isServerLive({ url: "http://127.0.0.1:1", pid: process.pid, startedAt: Date.now() })).toBe(false)
  })

  test("an alive process with a listening port is live", async () => {
    const server = await listen()
    try {
      expect(await isServerLive({ url: `http://127.0.0.1:${server.port}`, pid: process.pid, startedAt: Date.now() })).toBe(true)
    } finally {
      server.close()
    }
  })

  test("a coordinated run's server entry stays live with its optional controlUrl", async () => {
    // metadata.server gains controlUrl (no token) on a coordinated run;
    // liveness is still keyed on pid + the OpenCode TCP probe alone.
    const server = await listen()
    try {
      expect(
        await isServerLive({ url: `http://127.0.0.1:${server.port}`, pid: process.pid, startedAt: Date.now(), controlUrl: "http://127.0.0.1:59998" }),
      ).toBe(true)
    } finally {
      server.close()
    }
  })
})

describe("waiting state (coordinated live runs)", () => {
  const servers: ControlServer[] = []
  afterAll(() => {
    for (const server of servers) server.close()
  })

  async function coordinatedRun(root: string, runID: string): Promise<ControlServer> {
    // A "live" coordinated run: a listening server whose pid is this process,
    // plus a control.json pointing at a real control server.
    const server = await startControlServer()
    servers.push(server)
    const dir = join(root, runID)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "prd.md"), "# Waiting run\n")
    await writeFile(
      join(dir, "metadata.json"),
      JSON.stringify({
        schemaVersion: 3,
        runID,
        targetDir: "/tmp/repo",
        createdAt: 1,
        updatedAt: 2,
        server: { url: server.url, pid: process.pid, startedAt: Date.now() },
        phases: { implementer: { status: "running" } },
      }),
    )
    await writeFile(join(dir, "control.json"), JSON.stringify({ url: server.url, token: server.token, pid: process.pid }))
    return server
  }

  test("a parked permission shows as waiting for a permission", async () => {
    const root = await mkdtemp(join(tmpdir(), "convoy-runs-waiting-"))
    try {
      const runID = "20260613-000000-wa12"
      const server = await coordinatedRun(root, runID)
      void server.pending.holdPermission({ id: "p1", permission: "bash", patterns: ["bash"] })

      expect(await probeRunWaiting(runID, root)).toBe("permission")
      const runs = await listRuns(root)
      expect(runs.find((run) => run.runID === runID)?.waiting).toBe("permission")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a parked human gate shows as waiting for review", async () => {
    const root = await mkdtemp(join(tmpdir(), "convoy-runs-waiting-"))
    try {
      const runID = "20260613-000001-wa34"
      const server = await coordinatedRun(root, runID)
      void server.pending.holdHuman({ stepName: "review", iterations: 0 })

      expect(await probeRunWaiting(runID, root)).toBe("review")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("an idle coordinated run and non-coordinated runs are not waiting", async () => {
    const root = await mkdtemp(join(tmpdir(), "convoy-runs-waiting-"))
    try {
      const runID = "20260613-000002-wa56"
      await coordinatedRun(root, runID)
      // No pending gate: not waiting.
      expect(await probeRunWaiting(runID, root)).toBeUndefined()

      // A legacy live run (no control.json) never probes.
      const legacyID = "20260613-000003-wa78"
      const listener = await listen()
      try {
        const dir = join(root, legacyID)
        await mkdir(dir, { recursive: true })
        await writeFile(
          join(dir, "metadata.json"),
          JSON.stringify({
            schemaVersion: 3,
            runID: legacyID,
            targetDir: "/tmp/repo",
            createdAt: 1,
            updatedAt: 2,
            server: { url: `http://127.0.0.1:${listener.port}`, pid: process.pid, startedAt: Date.now() },
            phases: {},
          }),
        )
        expect(await probeRunWaiting(legacyID, root)).toBeUndefined()
      } finally {
        listener.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("refreshRunWaiting updates a live entry in place", async () => {
    const root = await mkdtemp(join(tmpdir(), "convoy-runs-waiting-"))
    try {
      const runID = "20260613-000004-wa90"
      const server = await coordinatedRun(root, runID)
      const runs = await listRuns(root)
      const run = runs.find((entry) => entry.runID === runID)!
      expect(run.live).toBe(true)
      expect(run.waiting).toBeUndefined()

      // A gate lands after the list was loaded: the browser's refresh picks it up.
      const held = server.pending.holdPermission({ id: "p3", permission: "bash", patterns: ["bash"] })
      await refreshRunWaiting(run, root)
      expect(run.waiting).toBe("permission")

      // And clears again once the gate is answered.
      await server.pending.resolvePermission("p3", "once")
      void held
      await refreshRunWaiting(run, root)
      expect(run.waiting).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a coordinated run stays live when its OpenCode server is down between iterations", async () => {
    const root = await mkdtemp(join(tmpdir(), "convoy-runs-coord-live-"))
    try {
      const runID = "20260613-000005-wa12"
      const server = await startControlServer()
      servers.push(server)
      const dir = join(root, runID)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, "prd.md"), "# Between iterations\n")
      await writeFile(
        join(dir, "metadata.json"),
        JSON.stringify({
          schemaVersion: 3,
          runID,
          targetDir: "/tmp/repo",
          createdAt: 1,
          updatedAt: 2,
          // Per-iteration server is gone; the coordinator is not.
          phases: { implementer: { status: "completed" } },
        }),
      )
      await writeFile(join(dir, "control.json"), JSON.stringify({ url: server.url, token: server.token, pid: process.pid }))
      void server.pending.holdPermission({ id: "p-between", permission: "bash", patterns: ["bash"] })

      const runs = await listRuns(root)
      const run = runs.find((entry) => entry.runID === runID)
      expect(run?.live).toBe(true)
      expect(run?.waiting).toBe("permission")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("statusSummary (pure function exercised through listRuns)", () => {
  test("lists all expected run IDs", async () => {
    const runs = await listRuns(root)
    const ids = runs.map(r => r.runID)
    expect(ids).toContain("20260610-120000-bbbb")
    expect(ids).toContain("20260601-090000-aaaa")
  })

  test("creates and finds a new run", async () => {
    const runID = "20260612-000000-debg"
    const dir = join(root, runID)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "metadata.json"), JSON.stringify({
      schemaVersion: 3, runID, targetDir: "/tmp", createdAt: 1, updatedAt: 2,
      control: { state: "running" }, phases: { x: { status: "completed" } },
    }))
    const { readFile } = await import("node:fs/promises")
    const content = await readFile(join(dir, "metadata.json"), "utf8")
    expect(content).toContain("schemaVersion")
    const runs = await listRuns(root)
    const found = runs.find(r => r.runID === runID)
    expect(found).toBeDefined()
    expect(found!.statusKind).toBe("completed")
  })

  test("no metadata → {label: '-', kind: 'unknown'}", async () => {
    const dir = join(root, "20260601-090000-aaaa")
    const runs = await listRuns(root)
    const run = runs.find((r) => r.runID === "20260601-090000-aaaa")!
    expect(run.status).toBe("-")
    expect(run.statusKind).toBe("unknown")
  })

  test("empty phases → status 'empty' kind 'empty'", async () => {
    const runID = "20260612-010000-empt"
    const dir = join(root, runID)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "prd.md"), "# Empty phases\n")
    await writeFile(join(dir, "metadata.json"), JSON.stringify({
      schemaVersion: 3, runID, targetDir: "/tmp", createdAt: 1, updatedAt: 2,
      control: { state: "running" }, phases: {},
    }))

    const runs = await listRuns(root)
    const run = runs.find((r) => r.runID === runID)
    expect(run).toBeDefined()
    expect(run!.status).toBe("empty")
    expect(run!.statusKind).toBe("empty")
  })

  test("all completed → status 'completed' kind 'completed'", async () => {
    const runID = "20260612-020000-comp"
    const dir = join(root, runID)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "prd.md"), "# All completed\n")
    await writeFile(join(dir, "metadata.json"), JSON.stringify({
      schemaVersion: 3, runID, targetDir: "/tmp", createdAt: 1, updatedAt: 2,
      control: { state: "running" },
      phases: { a: { status: "completed" }, b: { status: "completed" } },
    }))

    const runs = await listRuns(root)
    const run = runs.find((r) => r.runID === runID)
    expect(run).toBeDefined()
    expect(run!.status).toBe("completed")
    expect(run!.statusKind).toBe("completed")
  })

  test("all completed/skipped → status 'completed' kind 'completed'", async () => {
    const runID = "20260612-030000-skip"
    const dir = join(root, runID)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "prd.md"), "# With skipped\n")
    await writeFile(join(dir, "metadata.json"), JSON.stringify({
      schemaVersion: 3, runID, targetDir: "/tmp", createdAt: 1, updatedAt: 2,
      control: { state: "running" },
      phases: { a: { status: "completed" }, b: { status: "skipped" } },
    }))

    const runs = await listRuns(root)
    const run = runs.find((r) => r.runID === runID)
    expect(run).toBeDefined()
    expect(run!.status).toBe("completed")
    expect(run!.statusKind).toBe("completed")
  })

  test("any failed → status 'failed (X/Y ok)' kind 'failed'", async () => {
    const runID = "20260612-040000-fail"
    const dir = join(root, runID)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "prd.md"), "# Has failure\n")
    await writeFile(join(dir, "metadata.json"), JSON.stringify({
      schemaVersion: 3, runID, targetDir: "/tmp", createdAt: 1, updatedAt: 2,
      control: { state: "running" },
      phases: { a: { status: "completed" }, b: { status: "failed" }, c: { status: "completed" } },
    }))

    const runs = await listRuns(root)
    const run = runs.find((r) => r.runID === runID)
    expect(run).toBeDefined()
    expect(run!.status).toBe("failed (2/3 ok)")
    expect(run!.statusKind).toBe("failed")
  })

  test("some completed, some pending → status 'incomplete (X/Y)' kind 'incomplete'", async () => {
    const runID = "20260612-050000-pend"
    const dir = join(root, runID)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "prd.md"), "# Incomplete\n")
    await writeFile(join(dir, "metadata.json"), JSON.stringify({
      schemaVersion: 3, runID, targetDir: "/tmp", createdAt: 1, updatedAt: 2,
      control: { state: "running" },
      phases: { a: { status: "completed" }, b: { status: "pending" } },
    }))

    const runs = await listRuns(root)
    const run = runs.find((r) => r.runID === runID)
    expect(run).toBeDefined()
    expect(run!.status).toBe("incomplete (1/2)")
    expect(run!.statusKind).toBe("incomplete")
  })
})

describe("runTitle (pure function exercised through listRuns)", () => {
  test("returns '(no prd)' when prd.md does not exist", async () => {
    const runID = "20260612-060000-nopr"
    const dir = join(root, runID)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "metadata.json"), JSON.stringify({
      schemaVersion: 3, runID, targetDir: "/tmp", createdAt: 1, updatedAt: 2,
      control: { state: "running" }, phases: { a: { status: "completed" } },
    }))

    const runs = await listRuns(root)
    const run = runs.find((r) => r.runID === runID)
    expect(run).toBeDefined()
    expect(run!.title).toBe("(no prd)")
  })

  test("returns '(empty prd)' when prd.md has no non-whitespace content", async () => {
    const runID = "20260612-070000-empt"
    const dir = join(root, runID)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "prd.md"), "   \n\n#   \n")
    await writeFile(join(dir, "metadata.json"), JSON.stringify({
      schemaVersion: 3, runID, targetDir: "/tmp", createdAt: 1, updatedAt: 2,
      control: { state: "running" }, phases: { a: { status: "completed" } },
    }))

    const runs = await listRuns(root)
    const run = runs.find((r) => r.runID === runID)
    expect(run).toBeDefined()
    expect(run!.title).toBe("(empty prd)")
  })

  test("returns first non-empty heading line from prd.md", async () => {
    const runID = "20260612-080000-head"
    const dir = join(root, runID)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "prd.md"), "\n\n##  \n# My Feature Title\n\ndetails\n")
    await writeFile(join(dir, "metadata.json"), JSON.stringify({
      schemaVersion: 3, runID, targetDir: "/tmp", createdAt: 1, updatedAt: 2,
      control: { state: "running" }, phases: { a: { status: "completed" } },
    }))

    const runs = await listRuns(root)
    const run = runs.find((r) => r.runID === runID)
    expect(run).toBeDefined()
    expect(run!.title).toBe("My Feature Title")
  })

  test("truncates long headings to 60 chars", async () => {
    const longHeading = "# " + "a very long heading that definitely exceeds the sixty character truncation limit in the runs module"
    const runID = "20260612-090000-long"
    const dir = join(root, runID)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "prd.md"), longHeading + "\n")
    await writeFile(join(dir, "metadata.json"), JSON.stringify({
      schemaVersion: 3, runID, targetDir: "/tmp", createdAt: 1, updatedAt: 2,
      control: { state: "running" }, phases: { a: { status: "completed" } },
    }))

    const runs = await listRuns(root)
    const run = runs.find((r) => r.runID === runID)
    expect(run).toBeDefined()
    expect(run!.title.length).toBeLessThanOrEqual(63)
    expect(run!.title.endsWith("...")).toBe(true)
  })
})

describe("persisted run titles (capability run-titles)", () => {
  test("a stored title wins over the prompt document, even after a goal-loop rewrite", async () => {
    const runID = "20260615-100000-titl"
    const dir = join(root, runID)
    await mkdir(dir, { recursive: true })
    // The prompt document disagrees with the persisted title (a goal-loop
    // reset rewrote it): the stored title still names the run.
    await writeFile(join(dir, "prd.md"), "# A completely different prompt now\n")
    await writeFile(join(dir, "metadata.json"), JSON.stringify({
      schemaVersion: 5, runID, targetDir: "/tmp", createdAt: 1, updatedAt: 2,
      control: { state: "running" }, title: "Tabbed reading in the specs viewer", phases: { a: { status: "completed" } },
    }))

    const runs = await listRuns(root)
    const run = runs.find((r) => r.runID === runID)
    expect(run).toBeDefined()
    expect(run!.title).toBe("Tabbed reading in the specs viewer")
  })

  test("the list display truncates a long stored title while the record stays exact", async () => {
    const runID = "20260615-110000-wido"
    const storedTitle = "a stored title that is far longer than sixty characters and must not be truncated in the durable record itself"
    const dir = join(root, runID)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "metadata.json"), JSON.stringify({
      schemaVersion: 5, runID, targetDir: "/tmp", createdAt: 1, updatedAt: 2,
      control: { state: "running" }, title: storedTitle, phases: { a: { status: "completed" } },
    }))

    const runs = await listRuns(root)
    const run = runs.find((r) => r.runID === runID)
    expect(run).toBeDefined()
    expect(run!.title.length).toBeLessThanOrEqual(63)
    expect(run!.title.endsWith("...")).toBe(true)
    // The record itself keeps the exact value.
    const metadata = JSON.parse(await readFile(join(dir, "metadata.json"), "utf8"))
    expect(metadata.title).toBe(storedTitle)
  })

  test("a cleaned-up run rediscovers through the index with its exact persisted title", async () => {
    // Isolate the run-record index so parallel finalization tests cannot leak into this listing.
    const savedHome = process.env.CONVOY_HOME
    const home = await mkdtemp(join(tmpdir(), "convoy-runs-title-home-"))
    process.env.CONVOY_HOME = home
    try {
      const indexRunID = "20260615-120000-cldn"
      const exactTitle = "a long index title that stays exact and untruncated in the durable run-record evidence on disk"
      await mkdir(join(home, ".convoy", "run-records"), { recursive: true })
      await writeFile(join(home, ".convoy", "run-records", `${indexRunID}.json`), JSON.stringify({
        schemaVersion: 1, runID: indexRunID, title: exactTitle, state: "completed",
        manifestPath: "/repo/.git/convoy/finalization/manifest.json", recordedAt: 1, updatedAt: 2,
      }))
      const { readRunIndexEntry } = await import("../src/runs")
      const record = await readRunIndexEntry(indexRunID)
      expect(record!.title).toBe(exactTitle)

      const runs = await listRuns()
      const run = runs.find((r) => r.runID === indexRunID)
      expect(run).toBeDefined()
      expect(run!.title.length).toBeLessThanOrEqual(63)
    } finally {
      if (savedHome === undefined) delete process.env.CONVOY_HOME
      else process.env.CONVOY_HOME = savedHome
      await rm(home, { recursive: true, force: true })
    }
  })
})
