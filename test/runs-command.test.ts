import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ControlPendingQueue, startControlServer } from "../src/control-server"
import type { RunEntry } from "../src/runs"
import {
  findCoordinatorLog,
  parseDuration,
  parseRunsArgs,
  runAction,
  runStateOf,
  waitExitCode,
  waitForRun,
  waitingView,
  type WaitDeps,
} from "../src/runs-command"
import { runsRoot } from "../src/workspace"

const runID = "20261019-120000-abcd"

function entry(overrides: Partial<RunEntry> = {}): RunEntry {
  return {
    runID,
    dir: join(runsRoot(), runID),
    title: "a run",
    status: "incomplete (0/1)",
    statusKind: "incomplete",
    live: true,
    phases: [],
    ...overrides,
  }
}

describe("parseRunsArgs", () => {
  test("bare and run-id forms stay the browser", () => {
    expect(parseRunsArgs([])).toEqual({ kind: "browse" })
    expect(parseRunsArgs([runID])).toEqual({ kind: "browse", runID })
  })

  test("--json with and without a run id", () => {
    expect(parseRunsArgs(["--json"])).toEqual({ kind: "json" })
    expect(parseRunsArgs([runID, "--json"])).toEqual({ kind: "json", runID })
  })

  test("--wait defaults to five minutes and takes --timeout in either spelling", () => {
    expect(parseRunsArgs([runID, "--wait"])).toEqual({ kind: "wait", runID, timeoutMs: 300_000, json: false })
    expect(parseRunsArgs([runID, "--wait", "--timeout", "90s", "--json"])).toEqual({ kind: "wait", runID, timeoutMs: 90_000, json: true })
    expect(parseRunsArgs([runID, "--wait", "--timeout=2m"])).toEqual({ kind: "wait", runID, timeoutMs: 120_000, json: false })
  })

  test("--wait needs a run id and --timeout needs --wait", () => {
    expect(() => parseRunsArgs(["--wait"])).toThrow("--wait needs a run id")
    expect(() => parseRunsArgs([runID, "--timeout", "1m"])).toThrow("--timeout only applies to --wait")
  })

  test("answers name the request they answer", () => {
    expect(parseRunsArgs([runID, "approve", "req-1"])).toEqual({ kind: "action", runID, action: { kind: "approve", requestId: "req-1", always: false } })
    expect(parseRunsArgs([runID, "approve", "req-1", "--always"])).toEqual({ kind: "action", runID, action: { kind: "approve", requestId: "req-1", always: true } })
    expect(parseRunsArgs([runID, "deny", "req-1"])).toEqual({ kind: "action", runID, action: { kind: "deny", requestId: "req-1" } })
    expect(parseRunsArgs([runID, "abort"])).toEqual({ kind: "action", runID, action: { kind: "abort" } })
    expect(() => parseRunsArgs([runID, "approve"])).toThrow("usage: convoy runs <run-id> approve <request-id>")
    expect(() => parseRunsArgs([runID, "deny", "req-1", "--always"])).toThrow("--always only applies to approve")
    expect(() => parseRunsArgs([runID, "abort", "req-1"])).toThrow("usage: convoy runs <run-id> abort")
    expect(() => parseRunsArgs([runID, "approve", "req-1", "--json"])).toThrow("takes no --json")
  })

  test("refuses unknown actions, flags, and malformed run ids", () => {
    expect(() => parseRunsArgs([runID, "extra"])).toThrow("usage: convoy runs")
    expect(() => parseRunsArgs(["--follow"])).toThrow("unknown flag: --follow")
    expect(() => parseRunsArgs(["not-a-run"])).toThrow("invalid run id")
  })
})

describe("parseDuration", () => {
  test("accepts seconds, minutes, and hours; bare numbers are seconds", () => {
    expect(parseDuration("45", "--timeout")).toBe(45_000)
    expect(parseDuration("45s", "--timeout")).toBe(45_000)
    expect(parseDuration("9m", "--timeout")).toBe(540_000)
    expect(parseDuration("1h", "--timeout")).toBe(3_600_000)
  })

  test("refuses zero and anything else", () => {
    expect(() => parseDuration("0", "--timeout")).toThrow("longer than zero")
    expect(() => parseDuration("1.5m", "--timeout")).toThrow("duration like")
    expect(() => parseDuration("soon", "--timeout")).toThrow("duration like")
  })
})

describe("run state", () => {
  test("a live run is running, or waiting at a gate", () => {
    expect(runStateOf({ live: true, statusKind: "incomplete" })).toBe("running")
    expect(runStateOf({ live: true, statusKind: "incomplete", waiting: "permission" })).toBe("waiting")
  })

  test("an ended run reports its recorded outcome; one that never ran a phase failed", () => {
    expect(runStateOf({ live: false, statusKind: "completed" })).toBe("completed")
    expect(runStateOf({ live: false, statusKind: "failed" })).toBe("failed")
    expect(runStateOf({ live: false, statusKind: "incomplete" })).toBe("incomplete")
    expect(runStateOf({ live: false, statusKind: "empty" })).toBe("failed")
    expect(runStateOf({ live: false, statusKind: "unknown" })).toBe("unknown")
  })

  test("--wait exit codes", () => {
    expect(waitExitCode("completed")).toBe(0)
    expect(waitExitCode("failed")).toBe(1)
    expect(waitExitCode("incomplete")).toBe(1)
    expect(waitExitCode("unknown")).toBe(1)
    expect(waitExitCode("running")).toBe(2)
    expect(waitExitCode("waiting")).toBe(3)
  })

  test("waitingView prefers the permission request and carries what to show the user", () => {
    expect(waitingView(undefined)).toBeUndefined()
    expect(
      waitingView({
        permission: { requestId: "p1", permission: "bash", patterns: ["npm test"], command: "npm test" },
        human: { requestId: "h1", stepName: "qa", iterations: 0 },
      }),
    ).toEqual({ kind: "permission", requestId: "p1", permission: "bash", patterns: ["npm test"], command: "npm test" })
    expect(waitingView({ human: { requestId: "h1", stepName: "qa", iterations: 0, error: "boom" } })).toEqual({ kind: "review", requestId: "h1", step: "qa", error: "boom" })
  })
})

function fakeWaitDeps(states: RunEntry[], pending: WaitDeps["pending"] = async () => undefined): WaitDeps & { output: string[]; slept: number[] } {
  let time = 0
  let index = 0
  const output: string[] = []
  const slept: number[] = []
  return {
    output,
    slept,
    load: async () => states[Math.min(index++, states.length - 1)],
    pending,
    now: () => time,
    sleep: async (ms) => {
      slept.push(ms)
      time += ms
    },
    write: (text) => output.push(text),
  }
}

describe("waitForRun", () => {
  test("narrates phase changes and returns 0 once the run completes", async () => {
    const deps = fakeWaitDeps([
      entry({ phases: [{ name: "implementer", status: "completed" }, { name: "tests", status: "running" }] }),
      entry({ phases: [{ name: "implementer", status: "completed" }, { name: "tests", status: "completed", cost: 0.5 }] }),
      entry({ live: false, statusKind: "completed", status: "completed", cost: 0.5, phases: [{ name: "implementer", status: "completed" }, { name: "tests", status: "completed", cost: 0.5 }] }),
    ])
    const code = await waitForRun(runID, { timeoutMs: 60_000, json: false, pollMs: 1000 }, deps)
    expect(code).toBe(0)
    const text = deps.output.join("")
    // The first pass only reports the running phase, not the history before it.
    expect(text).not.toContain("[implementer]")
    expect(text).toContain("[tests] running")
    expect(text).toContain("[tests] completed · $0.5000")
    expect(text).toContain(`run ${runID}: completed`)
  })

  test("returns 3 with the request to answer when the run stops at a permission", async () => {
    const deps = fakeWaitDeps([entry()], async () => ({ permission: { requestId: "p1", permission: "bash", patterns: ["rm -rf build"], command: "rm -rf build" } }))
    const code = await waitForRun(runID, { timeoutMs: 60_000, json: false }, deps)
    expect(code).toBe(3)
    const text = deps.output.join("")
    expect(text).toContain("permission request p1: bash · rm -rf build\n")
    expect(text).toContain(`convoy runs ${runID} approve p1`)
  })

  test("returns 2 at the timeout without sleeping past it", async () => {
    const deps = fakeWaitDeps([entry()])
    const code = await waitForRun(runID, { timeoutMs: 5000, json: false, pollMs: 2000 }, deps)
    expect(code).toBe(2)
    expect(deps.slept).toEqual([2000, 2000, 1000])
    expect(deps.output.join("")).toContain("still running (wait timed out)")
  })

  test("JSON mode prints one snapshot and nothing else", async () => {
    const deps = fakeWaitDeps([entry({ live: false, statusKind: "failed", status: "failed (0/1 ok)", phases: [{ name: "implementer", status: "failed" }] })])
    const code = await waitForRun(runID, { timeoutMs: 60_000, json: true }, deps)
    expect(code).toBe(1)
    expect(deps.output).toHaveLength(1)
    const snapshot = JSON.parse(deps.output[0]!)
    expect(snapshot).toMatchObject({ runID, state: "failed", live: false, reports: [] })
  })

  test("an unknown run is an error", async () => {
    const deps: WaitDeps = { ...fakeWaitDeps([]), load: async () => undefined }
    await expect(waitForRun(runID, { timeoutMs: 1000, json: false }, deps)).rejects.toThrow(`run ${runID} doesn't exist`)
  })
})

describe("findCoordinatorLog", () => {
  test("finds the pending launch whose ready file names the run", async () => {
    const root = await mkdtemp(join(tmpdir(), "convoy-pending-"))
    try {
      await mkdir(join(root, "other"))
      await writeFile(join(root, "other", "ready"), JSON.stringify({ runID: "20261019-120000-zzzz", controlUrl: "x" }))
      await writeFile(join(root, "other", "coordinator.log"), "")
      await mkdir(join(root, "mine"))
      await writeFile(join(root, "mine", "ready"), JSON.stringify({ runID, controlUrl: "x" }))
      await writeFile(join(root, "mine", "coordinator.log"), "[scope] attempt 1\n")
      await mkdir(join(root, "booting"))
      expect(await findCoordinatorLog(runID, root)).toBe(join(root, "mine", "coordinator.log"))
      expect(await findCoordinatorLog("20261019-120000-nope", root)).toBeUndefined()
      expect(await findCoordinatorLog(runID, join(root, "missing"))).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("runAction", () => {
  let runs = 0
  async function liveRun(pending: ControlPendingQueue, handlers = {}) {
    const server = await startControlServer({ pending, handlers })
    // A run dir with a control.json whose pid (this process) is alive reads as a live coordinator.
    const id = `20261019-1300${String(++runs).padStart(2, "0")}-live`
    const dir = join(runsRoot(), id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "control.json"), JSON.stringify({ url: server.url, token: server.token, pid: process.pid }))
    return {
      id,
      server,
      cleanup: async () => {
        server.close()
        await rm(dir, { recursive: true, force: true })
      },
    }
  }

  test("approves the named request and releases the controller slot", async () => {
    const pending = new ControlPendingQueue()
    const reply = pending.holdPermission({ id: "p1", permission: "bash", patterns: ["npm test"], command: "npm test" })
    const run = await liveRun(pending)
    try {
      const output: string[] = []
      await runAction(run.id, { kind: "approve", requestId: "p1", always: true }, (text) => output.push(text))
      expect(await reply).toBe("always")
      expect(output.join("")).toContain("approved (always) bash request p1")
      expect(run.server.hasController()).toBe(false)
    } finally {
      await run.cleanup()
    }
  })

  test("denies with a reject reply", async () => {
    const pending = new ControlPendingQueue()
    const reply = pending.holdPermission({ id: "p1", permission: "bash", patterns: ["curl x"] })
    const run = await liveRun(pending)
    try {
      await runAction(run.id, { kind: "deny", requestId: "p1" }, () => {})
      expect(await reply).toBe("reject")
    } finally {
      await run.cleanup()
    }
  })

  test("refuses a request id that isn't the one waiting", async () => {
    const pending = new ControlPendingQueue()
    pending.holdPermission({ id: "p1", permission: "bash", patterns: ["npm test"] })
    const run = await liveRun(pending)
    try {
      await expect(runAction(run.id, { kind: "approve", requestId: "p2", always: false }, () => {})).rejects.toThrow("waiting on permission request p1, not p2")
      expect(run.server.hasController()).toBe(false)
    } finally {
      await run.cleanup()
    }
  })

  test("aborts through the run's abort handler", async () => {
    let aborted = false
    const run = await liveRun(new ControlPendingQueue(), {
      onAbort: async () => {
        aborted = true
      },
    })
    try {
      await runAction(run.id, { kind: "abort" }, () => {})
      expect(aborted).toBe(true)
    } finally {
      await run.cleanup()
    }
  })

  test("refuses while a dashboard holds the controller slot", async () => {
    const pending = new ControlPendingQueue()
    pending.holdPermission({ id: "p1", permission: "bash", patterns: ["npm test"] })
    const run = await liveRun(pending)
    try {
      await fetch(`${run.server.url}/hello`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${run.server.token}` },
        body: JSON.stringify({ role: "controller" }),
      })
      await expect(runAction(run.id, { kind: "approve", requestId: "p1", always: false }, () => {})).rejects.toThrow("a dashboard is attached")
    } finally {
      await run.cleanup()
    }
  })

  test("refuses a run that isn't running", async () => {
    await expect(runAction("20261019-120000-gone", { kind: "abort" }, () => {})).rejects.toThrow("is not running")
  })
})
