import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { startPendingPoller, type AttachSession } from "../src/attach"
import { createControlClient } from "../src/control-client"
import { ControlProgress } from "../src/control-progress"
import { startControlServer, type ControlReset } from "../src/control-server"
import type { ProgressPhase, ProgressUI, RunOutcome } from "../src/progress"

/**
 * The composition band the unit suites never overlap: a REAL control server,
 * a REAL ControlProgress (the coordinator's adapter), a REAL controller
 * client, and the REAL pending poller — all in one process. The poller tests
 * fake the client; the server tests drive raw fetch with no poller. The
 * coordinated bugs (a sticky boot reset hiding the finish hold, an abort
 * dying silently during the hold) lived exactly in that gap.
 */

const dirs: string[] = []

afterAll(async () => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))))

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "convoy-coordinated-journey-"))
  dirs.push(dir)
  return dir
}

const phases: ProgressPhase[] = [{ name: "implement", description: "" }]
const pipeline = { name: "implement", steps: [] }

/**
 * Records what the dashboard renders. The finish screen waits for the user,
 * exactly like the attach TUI: the poller's dismiss POST only fires once the
 * user answers the screen.
 */
function dashboardSpy() {
  const outcomes: RunOutcome[] = []
  const waiters: Array<() => void> = []
  const tui = {
    runFinished: (outcome: RunOutcome) => {
      outcomes.push(outcome)
      return new Promise<void>((resolve) => waiters.push(resolve))
    },
  } as Partial<ProgressUI> as ProgressUI
  return {
    tui,
    outcomes,
    /** The user presses [q] on the finish screen. */
    userDismisses: () => {
      for (const resolve of waiters.splice(0)) resolve()
    },
  }
}

/**
 * The attach session with the same-runID dedupe openRunDashboard's closure
 * performs: the sticky boot reset must not rebuild the view, but a NEW runID
 * (goal-loop iteration) still applies.
 */
function sessionFor(tui: ProgressUI, runID: string) {
  const applied: string[] = []
  let lastResetRunID = runID
  let finishDismissed = false
  let gone = false
  const session: AttachSession = {
    tui,
    view: () => ({ runDir: "", metaPath: "" }),
    applyReset: (reset: ControlReset) => {
      if (reset.runID === lastResetRunID) return
      lastResetRunID = reset.runID
      applied.push(reset.runID)
    },
    coordinatorGone: () => {
      gone = true
    },
    onFinishDismissed: () => {
      finishDismissed = true
    },
  }
  return { session, applied, wasFinishDismissed: () => finishDismissed, isGone: () => gone }
}

async function until(ready: () => boolean, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (ready()) return true
    await Bun.sleep(10)
  }
  return ready()
}

describe("coordinated finish hold over a real server, adapter, client, and poller", () => {
  test("the finish hold surfaces past the sticky boot reset and unwinds on the user's dismiss", async () => {
    const dir = await scratch()
    const server = await startControlServer()
    const progress = new ControlProgress({ server })
    const { tui, outcomes, userDismisses } = dashboardSpy()
    const state = sessionFor(tui, "20260101-000000-ab12")
    const client = createControlClient({ url: server.url, token: server.token })
    const poller = startPendingPoller(client, state.session, 10)
    let heldSettled = false
    try {
      await client.claimController()
      // The coordinator boots a hosted run(): start, sticky boot reset…
      progress.start("20260101-000000-ab12", dir)
      progress.resetPipeline(phases, {
        runID: "20260101-000000-ab12",
        targetDir: dir,
        runDir: dir,
        pipeline,
      })
      // …the run completes, and coordinate.ts holds the finish screen.
      const held = progress.runFinished({ status: "completed", runDir: dir })
      void held.then(() => {
        heldSettled = true
      })

      // The poller renders the finish screen — the sticky boot reset shares
      // the snapshot but cannot hide it, and its runID matches the current
      // view so the dashboard is not rebuilt.
      expect(await until(() => outcomes.length === 1)).toBe(true)
      expect(outcomes).toEqual([{ status: "completed", runDir: "" }])
      expect(state.applied).toEqual([])
      // The user has not answered the screen yet: the coordinator is still
      // holding, and the poller has not posted any dismiss.
      expect(heldSettled).toBe(false)
      expect(state.wasFinishDismissed()).toBe(false)

      // The user presses [q]: the poller posts /finish-dismiss and the
      // coordinator's hold unwinds.
      userDismisses()
      expect(await until(() => heldSettled)).toBe(true)
      expect(await until(() => state.wasFinishDismissed())).toBe(true)
      expect(state.isGone()).toBe(false)
    } finally {
      poller.stop()
      server.close()
    }
  })

  test("a controller abort during the held finish unwinds the coordinator", async () => {
    const dir = await scratch()
    const server = await startControlServer()
    const progress = new ControlProgress({ server })
    // The user never answers the finish screen: the poller rendered it and is
    // busy awaiting the user, so nothing else can unwind the hold.
    const { tui, outcomes } = dashboardSpy()
    const state = sessionFor(tui, "20260101-000000-cd34")
    const client = createControlClient({ url: server.url, token: server.token })
    const poller = startPendingPoller(client, state.session, 10)
    try {
      await client.claimController()
      progress.start("20260101-000000-cd34", dir)
      progress.resetPipeline(phases, {
        runID: "20260101-000000-cd34",
        targetDir: dir,
        runDir: dir,
        pipeline,
      })
      // run()'s finally has cleared the runner abort handler by now (its
      // shutdown is disposed) — exactly the production state of the hold.
      progress.setAbortHandler(undefined)
      const held = progress.runFinished({ status: "completed", runDir: dir })

      // The finish screen is up and the user is away.
      expect(await until(() => outcomes.length === 1)).toBe(true)

      // The controller aborts from the dashboard palette while the finish
      // screen is up. The coordinator must unwind and exit, not hang.
      await client.abort()
      const settled = await Promise.race([held.then(() => true), Bun.sleep(500).then(() => false)])
      expect(settled).toBe(true)
      expect(state.isGone()).toBe(false)
    } finally {
      poller.stop()
      server.close()
    }
  })
})

describe("unattended holds", () => {
  test("a hold with no controller says what waits and how to release it, and still holds", async () => {
    const server = await startControlServer()
    const progress = new ControlProgress({ server })
    progress.start("20260101-000000-cd34", await scratch())
    const lines: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void lines.push(args.join(" "))
    try {
      const reply = progress.askPermission({ id: "per-1", permission: "bash", patterns: ["rm -rf build"], command: "rm -rf build" })
      void progress.askHumanReview({ stepName: "review", iterations: 0 })
      const text = lines.join("\n")
      expect(text).toContain("[permission] waiting for an answer: bash: rm -rf build")
      expect(text).toContain("[human] review is waiting for a decision")
      expect(text).toContain("convoy runs 20260101-000000-cd34")
      expect(text).toContain("--smart or --yolo")
      // Waiting is the design: nobody being attached never auto-rejects.
      expect(server.pending.resolvePermission("per-1", "once")).toBe(true)
      expect(await reply).toBe("once")
    } finally {
      console.error = original
      server.close()
    }
  })
})
