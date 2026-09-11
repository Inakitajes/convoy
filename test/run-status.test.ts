import { describe, expect, test } from "bun:test"

import { noopProgress, type ProgressPhase, type ProgressUI, type RunStatus, type SessionErrorSignal } from "../src/progress"
import { planBatches } from "../src/runner"
import {
  formatTerminalTitle,
  projectName,
  RunStatusTracker,
  statusSteps,
  trackRunStatus,
  type NotificationEvent,
} from "../src/run-status"
import type { AgentStep, Step } from "../src/types"

const identity = { project: "convoy", pipeline: "implement", branch: "feat/notify" }

function agentStep(name: string, groupId: string): AgentStep {
  return {
    type: "agent",
    name,
    agentName: name,
    description: name,
    model: "openai/gpt-5.5",
    inputFiles: [],
    inputDiff: false,
    reportPath: `reports/${name}.md`,
    groupId,
    stepName: name.split("__")[0]!,
  }
}

function agentPhase(name: string, groupId?: string, stepName?: string): ProgressPhase {
  return {
    name,
    description: `${name} description`,
    ...(groupId ? { groupId } : {}),
    ...(stepName ? { stepName } : {}),
  }
}

/** A pipeline shaped like the real thing: a hook, a plain step, a 3-way fan-out, a human gate. */
function mixedPhases(): ProgressPhase[] {
  return [
    agentPhase("pre-hook-1"),
    agentPhase("plan"),
    agentPhase("review__opus", "g1", "review"),
    agentPhase("review__gpt", "g1", "review"),
    agentPhase("review__gemini", "g1", "review"),
    agentPhase("human-review"),
  ]
}

function trackerWith(phases: ProgressPhase[]) {
  const events: NotificationEvent[] = []
  const titles: RunStatus[] = []
  const herdrs: RunStatus[] = []
  const tracker = new RunStatusTracker({
    phases,
    identity,
    sinks: { notify: (event) => events.push(event), title: (status) => titles.push(status), herdr: (status) => herdrs.push(status) },
  })
  return { tracker, events, titles, herdrs }
}

describe("statusSteps", () => {
  test("collapses a fan-out into one step and keeps everything else separate", () => {
    const steps = statusSteps(mixedPhases())
    expect(steps.map((step) => step.label)).toEqual(["pre-hook-1", "plan", "review", "human-review"])
    expect(steps[2]!.members).toEqual(["review__opus", "review__gpt", "review__gemini"])
  })

  test("a six-model fan-out is one step, not six", () => {
    const phases = Array.from({ length: 6 }, (_, index) => agentPhase(`review__m${index}`, "g1", "review"))
    expect(statusSteps(phases)).toEqual([
      { label: "review", members: ["review__m0", "review__m1", "review__m2", "review__m3", "review__m4", "review__m5"] },
    ])
  })

  test("identical groupIds that are not adjacent stay separate, matching planBatches", () => {
    const steps = statusSteps([agentPhase("a", "g1", "a"), agentPhase("b"), agentPhase("c", "g1", "c")])
    expect(steps.map((step) => step.label)).toEqual(["a", "b", "c"])
  })

  test("an empty pipeline produces no steps", () => {
    expect(statusSteps([])).toEqual([])
  })

  // statusSteps and planBatches answer the same question ("what is one step?")
  // over different inputs: the dashboard's phase rows vs. the executable step
  // list. They are deliberately not shared — coupling a cosmetic counter to the
  // execution loop means a title tweak could reorder real work — so this pins
  // them to the same answer instead, and fails loudly if either drifts.
  test("agrees with the runner's own batching", () => {
    const steps: Step[] = [
      agentStep("plan", "g-plan"),
      agentStep("review__opus", "g1"),
      agentStep("review__gpt", "g1"),
      { type: "human", name: "human-review", description: "manual gate" },
      agentStep("ship", "g-ship"),
    ]
    const phases = steps.map((step) =>
      step.type === "agent"
        ? { name: step.name, description: step.description, groupId: step.groupId, stepName: step.stepName }
        : { name: step.name, description: step.description },
    )

    expect(statusSteps(phases).map((step) => step.members)).toEqual(planBatches(steps).map((batch) => batch.map((step) => step.name)))
  })
})

describe("formatTerminalTitle", () => {
  const base: RunStatus = { activity: "working", step: 3, totalSteps: 7, identity }

  test("leads with state and progress so a narrow tab still says whether it needs you", () => {
    expect(formatTerminalTitle(base)).toBe("⚙ 3/7 convoy · feat/notify · implement")
    expect(formatTerminalTitle({ ...base, activity: "waiting" })).toStartWith("⏳ 3/7 ")
    expect(formatTerminalTitle({ ...base, activity: "paused" })).toStartWith("⏸ 3/7 ")
  })

  test("a finished run shows its outcome instead of a generic stopped marker", () => {
    expect(formatTerminalTitle({ ...base, activity: "stopped", outcome: "completed", step: 7 })).toStartWith("✓ 7/7 ")
    expect(formatTerminalTitle({ ...base, activity: "stopped", outcome: "failed" })).toStartWith("✗ 3/7 ")
    // Torn down by a signal, with no outcome recorded.
    expect(formatTerminalTitle({ ...base, activity: "stopped" })).toStartWith("■ 3/7 ")
  })

  test("truncation eats the identity and never the state or the counter", () => {
    const long = { ...base, identity: { ...identity, branch: "feat/a-very-long-branch-name-that-will-not-fit-anywhere" } }
    const title = formatTerminalTitle(long, 24)
    expect(title).toStartWith("⚙ 3/7 ")
    expect(title.length).toBeLessThanOrEqual(24)
    expect(title).toEndWith("…")
  })

  test("a branch equal to the project name is not repeated", () => {
    const title = formatTerminalTitle({ ...base, identity: { project: "convoy", branch: "convoy", pipeline: "implement" } })
    expect(title).toBe("⚙ 3/7 convoy · implement")
  })

  test("control characters in a branch name cannot break out of the escape sequence", () => {
    const title = formatTerminalTitle({ ...base, identity: { ...identity, branch: "feat/\u001b]0;pwned\u0007x" } })
    expect(title).not.toContain("\u001b")
    expect(title).not.toContain("\u0007")
  })
})

describe("RunStatusTracker", () => {
  test("a fan-out announces itself once on start and once on completion", () => {
    const phases = Array.from({ length: 6 }, (_, index) => agentPhase(`review__m${index}`, "g1", "review"))
    const { tracker, events } = trackerWith(phases)

    for (const phase of phases) tracker.phaseStarted(phase.name)
    for (const phase of phases) tracker.phaseEnded(phase.name, "completed")

    expect(events.map((event) => event.body)).toEqual(["step 1/1 · review — started", expect.stringContaining("step 1/1 · review — completed")])
  })

  test("a failure is announced immediately and suppresses the group's completion event", () => {
    const phases = [agentPhase("a__1", "g1", "a"), agentPhase("a__2", "g1", "a")]
    const { tracker, events } = trackerWith(phases)

    tracker.phaseStarted("a__1")
    tracker.phaseEnded("a__1", "failed")
    // The sibling still runs to completion; that must not produce a second event.
    tracker.phaseEnded("a__2", "completed")

    const bodies = events.map((event) => event.body)
    expect(bodies).toEqual(["step 1/1 · a — started", "step 1/1 · a — failed"])
    expect(events[1]!.category).toBe("failures")
  })

  test("a failed step remains the title's current step rather than advancing to unstarted work", () => {
    const { tracker } = trackerWith([agentPhase("plan"), agentPhase("implement"), agentPhase("validate")])

    tracker.phaseStarted("plan")
    tracker.phaseEnded("plan", "completed")
    tracker.phaseStarted("implement")
    tracker.phaseEnded("implement", "failed")
    tracker.finished({ status: "failed", runDir: "/tmp/run" })

    expect(formatTerminalTitle(tracker.snapshot())).toStartWith("✗ 2/3 ")
  })

  test("a parallel member's failure names that member instead of the first group member", () => {
    const phases = [agentPhase("lint", "checks", "lint"), agentPhase("integration", "checks", "integration")]
    const { tracker, events } = trackerWith(phases)

    tracker.phaseStarted("integration")
    tracker.phaseEnded("integration", "failed")

    expect(events.at(-1)!.body).toBe("step 1/1 · integration — failed")
  })

  test("activity precedence is stopped > paused > waiting > working", () => {
    const { tracker } = trackerWith(mixedPhases())
    expect(tracker.snapshot().activity).toBe("working")

    tracker.waitBegan("p1", "waiting for your permission: rm -rf dist")
    expect(tracker.snapshot().activity).toBe("waiting")

    // A pause outranks a pending prompt.
    tracker.controlState("paused")
    expect(tracker.snapshot().activity).toBe("paused")

    tracker.finished({ status: "completed", runDir: "/tmp/run" })
    expect(tracker.snapshot().activity).toBe("stopped")
    expect(tracker.snapshot().outcome).toBe("completed")
  })

  // Regression: --resume replays every phase an earlier run completed, and
  // --only/--skip mark the filtered ones skipped. Both arrive as a burst with
  // distinct throttle keys the instant the run opens.
  test("work finished by an earlier run advances the counter without notifying", () => {
    const { tracker, events } = trackerWith(mixedPhases())

    for (const name of ["pre-hook-1", "plan", "review__opus", "review__gpt", "review__gemini"]) {
      tracker.phaseEnded(name, "completed")
    }

    expect(events).toEqual([])
    // The restored work still counts: the run resumes at the last step.
    expect(tracker.snapshot().step).toBe(4)

    // And the step that actually runs in this process is announced normally.
    tracker.phaseStarted("human-review")
    expect(events.map((event) => event.body)).toEqual(["step 4/4 · human-review — started"])
  })

  test("a step skipped by --only never announces an end it never started", () => {
    const { tracker, events } = trackerWith(mixedPhases())
    tracker.phaseEnded("plan", "skipped")
    expect(events).toEqual([])
  })

  test("concurrent waits each hold the state until the last one clears", () => {
    const { tracker } = trackerWith(mixedPhases())
    tracker.waitBegan("p1", "first")
    tracker.waitBegan("p2", "second")
    tracker.waitEnded("p1")
    expect(tracker.snapshot().activity).toBe("waiting")
    tracker.waitEnded("p2")
    expect(tracker.snapshot().activity).toBe("working")
  })

  test("the step counter advances by batch, not by flat phase", () => {
    const { tracker } = trackerWith(mixedPhases())
    expect(tracker.snapshot().totalSteps).toBe(4)

    tracker.phaseStarted("pre-hook-1")
    expect(tracker.snapshot().step).toBe(1)
    tracker.phaseEnded("pre-hook-1", "completed")
    tracker.phaseStarted("plan")
    expect(tracker.snapshot().step).toBe(2)
    tracker.phaseEnded("plan", "completed")

    tracker.phaseStarted("review__opus")
    expect(tracker.snapshot().step).toBe(3)
    // Two of three members done still means step 3.
    tracker.phaseEnded("review__opus", "completed")
    tracker.phaseEnded("review__gpt", "completed")
    expect(tracker.snapshot().step).toBe(3)
    tracker.phaseEnded("review__gemini", "completed")
    expect(tracker.snapshot().step).toBe(4)
  })

  test("the title is written only when it would read differently", () => {
    const { tracker, titles } = trackerWith(mixedPhases())
    tracker.phaseStarted("pre-hook-1")
    const after = titles.length
    expect(after).toBeGreaterThan(0)

    // Same step, same activity: nothing new to show.
    tracker.phaseStarted("pre-hook-1")
    expect(titles.length).toBe(after)

    // A state change does reach the tab.
    tracker.waitBegan("p1", "needs you")
    expect(titles.length).toBe(after + 1)
  })

  test("unknown phase names are ignored rather than throwing", () => {
    const { tracker, events } = trackerWith(mixedPhases())
    tracker.phaseStarted("not-in-this-pipeline")
    tracker.phaseEnded("not-in-this-pipeline", "completed")
    expect(events).toEqual([])
  })

  test("snapshot exposes the logical step label, counting the pre-hook as step one", () => {
    const { tracker } = trackerWith(mixedPhases())
    tracker.phaseEnded("pre-hook-1", "completed")
    tracker.phaseStarted("plan")
    expect(tracker.snapshot().step).toBe(2)
    expect(tracker.snapshot().stepLabel).toBe("plan")
  })

  test("a fan-out collapses to one step label and counts as one step", () => {
    const { tracker } = trackerWith(mixedPhases())
    tracker.phaseEnded("pre-hook-1", "completed")
    tracker.phaseEnded("plan", "completed")
    for (const name of ["review__opus", "review__gpt", "review__gemini"]) tracker.phaseStarted(name)

    expect(tracker.snapshot().stepLabel).toBe("review")
    expect(tracker.snapshot().stepLabel).not.toContain("opus")
    expect(tracker.snapshot().totalSteps).toBe(4)
  })

  test("waiting exposes the first wait reason and drops it once cleared", () => {
    const { tracker } = trackerWith(mixedPhases())
    tracker.waitBegan("permission:1", "waiting for your permission")
    expect(tracker.snapshot().activity).toBe("waiting")
    expect(tracker.snapshot().waitReason).toBe("waiting for your permission")

    tracker.waitEnded("permission:1")
    expect(tracker.snapshot().waitReason).toBeUndefined()
  })

  test("the herdr sink fires even when the rendered title is unchanged", () => {
    const { tracker, titles, herdrs } = trackerWith(mixedPhases())
    tracker.phaseEnded("pre-hook-1", "completed")
    tracker.phaseEnded("plan", "completed")
    tracker.phaseStarted("review__opus")
    const herdrsAfterFirst = herdrs.length
    const titlesAfterFirst = titles.length

    // Same N/M, same activity, same step label: the title has nothing new to
    // say, but Herdr still wants the current step label published.
    tracker.phaseStarted("review__gpt")
    expect(titles.length).toBe(titlesAfterFirst)
    expect(herdrs.length).toBe(herdrsAfterFirst + 1)
    expect(tracker.snapshot().stepLabel).toBe("review")
  })
})

describe("trackRunStatus", () => {
  test("mirrors the wrapped UI's optional methods so the gates keep choosing correctly", () => {
    // permissions.ts and human.ts probe for these to decide between an
    // in-dashboard prompt and the readline fallback.
    const bare = trackRunStatus(noopProgress, new RunStatusTracker({ phases: [], identity }))
    expect(bare.askPermission).toBeUndefined()
    expect(bare.askHumanReview).toBeUndefined()
    expect(bare.runFinished).toBeUndefined()
    expect(bare.runControlState).toBeUndefined()

    const rich: ProgressUI = {
      ...noopProgress,
      askPermission: async () => "once",
      askHumanReview: async () => "continue",
      runFinished: async () => {},
      runControlState: () => {},
    }
    const wrapped = trackRunStatus(rich, new RunStatusTracker({ phases: [], identity }))
    expect(wrapped.askPermission).toBeDefined()
    expect(wrapped.askHumanReview).toBeDefined()
    expect(wrapped.runFinished).toBeDefined()
    expect(wrapped.runControlState).toBeDefined()
  })

  test("forwards the goal-loop hosting methods when the wrapped UI has them", () => {
    const bare = trackRunStatus(noopProgress, new RunStatusTracker({ phases: [], identity }))
    expect(bare.setGoalLoop).toBeUndefined()
    expect(bare.resetPipeline).toBeUndefined()
    expect(bare.setAbortHandler).toBeUndefined()
    expect(bare.setHostControls).toBeUndefined()

    const calls: string[] = []
    const hosting: ProgressUI = {
      ...noopProgress,
      setGoalLoop: (view) => calls.push(`setGoalLoop:${view.iteration}`),
      resetPipeline: () => calls.push("resetPipeline"),
      setAbortHandler: () => calls.push("setAbortHandler"),
      setHostControls: () => calls.push("setHostControls"),
    }
    const wrapped = trackRunStatus(hosting, new RunStatusTracker({ phases: [], identity }))
    wrapped.setGoalLoop?.({ target: 90, iteration: 2, maxRuns: 4, plateau: 3, scores: [71] })
    wrapped.resetPipeline?.([], { runID: "r", targetDir: "/t", runDir: "", pipeline: { name: "goal-fix", steps: [] } })
    wrapped.setAbortHandler?.(undefined)
    wrapped.setHostControls?.({})

    expect(calls).toEqual(["setGoalLoop:2", "resetPipeline", "setAbortHandler", "setHostControls"])
  })

  test("a pending permission prompt uses a generic notification and releases waiting on reply", async () => {
    const phases = [agentPhase("plan")]
    const { tracker, events } = trackerWith(phases)
    let observed: string | undefined
    const progress: ProgressUI = {
      ...noopProgress,
      askPermission: async () => {
        observed = tracker.snapshot().activity
        return "once"
      },
    }
    const wrapped = trackRunStatus(progress, tracker)

    const reply = await wrapped.askPermission!({ id: "req-1", permission: "bash", patterns: [], command: "rm -rf dist" })

    expect(reply).toBe("once")
    expect(observed).toBe("waiting")
    expect(tracker.snapshot().activity).toBe("working")
    expect(events.at(-1)!.body).toBe("waiting for your permission")
    expect(events.at(-1)!.category).toBe("waiting")
  })

  test("a rejected permission still releases the waiting state", async () => {
    const { tracker } = trackerWith([agentPhase("plan")])
    const progress: ProgressUI = {
      ...noopProgress,
      askPermission: async () => {
        throw new Error("gate torn down")
      },
    }
    const wrapped = trackRunStatus(progress, tracker)

    await expect(wrapped.askPermission!({ id: "req-1", permission: "bash", patterns: [] })).rejects.toThrow("gate torn down")
    expect(tracker.snapshot().activity).toBe("working")
  })

  test("a failure gate emits a waiting notification and sets the title to ⏳", async () => {
    const phases = [agentPhase("plan")]
    const { tracker, events, titles } = trackerWith(phases)
    let observed: string | undefined
    const progress: ProgressUI = {
      ...noopProgress,
      askHumanReview: async () => {
        observed = tracker.snapshot().activity
        return "continue"
      },
    }
    const wrapped = trackRunStatus(progress, tracker)

    const reply = await wrapped.askHumanReview!({ stepName: "plan", iterations: 0, kind: "failure", error: "network down", canRetry: true })

    expect(reply).toBe("continue")
    expect(observed).toBe("waiting")
    expect(tracker.snapshot().activity).toBe("working")
    expect(events.at(-1)!.body).toBe("step failed — waiting for your decision")
    expect(events.at(-1)!.category).toBe("waiting")
    expect(titles.some((status) => status.activity === "waiting" && formatTerminalTitle(status).startsWith("⏳ "))).toBe(true)
  })

  test("a readline failure gate emits the same waiting status until the phase advances", () => {
    const phases = [agentPhase("plan")]
    const { tracker, events, titles } = trackerWith(phases)
    const wrapped = trackRunStatus(noopProgress, tracker)

    wrapped.phaseStarted("plan")
    wrapped.phaseRunning("plan", "step failed — waiting for your decision")

    expect(tracker.snapshot().activity).toBe("waiting")
    expect(events.at(-1)?.body).toBe("step failed — waiting for your decision")
    expect(titles.some((status) => status.activity === "waiting" && formatTerminalTitle(status).startsWith("⏳ "))).toBe(true)

    wrapped.phaseAttempt("plan", { attempt: 2 })
    expect(tracker.snapshot().activity).toBe("working")
  })

  test("forwards every lifecycle call to the wrapped UI unchanged", () => {
    const calls: string[] = []
    let forwardedFailure: SessionErrorSignal | undefined
    const progress: ProgressUI = {
      ...noopProgress,
      phaseStarted: (name) => calls.push(`started:${name}`),
      phaseCompleted: (name) => calls.push(`completed:${name}`),
      phaseFailed: (name, _detail, failure) => {
        calls.push(`failed:${name}`)
        forwardedFailure = failure
      },
      phaseSkipped: (name) => calls.push(`skipped:${name}`),
      stop: () => calls.push("stop"),
    }
    const wrapped = trackRunStatus(progress, new RunStatusTracker({ phases: [agentPhase("plan")], identity }))
    const failure = { name: "APIError", message: "rate limited", statusCode: 429, isRetryable: true }

    wrapped.phaseStarted("plan")
    wrapped.phaseCompleted("plan")
    wrapped.phaseFailed("plan", "rate limited", failure)
    wrapped.phaseSkipped("plan")
    wrapped.stop()

    expect(calls).toEqual(["started:plan", "completed:plan", "failed:plan", "skipped:plan", "stop"])
    expect(forwardedFailure).toEqual(failure)
  })

  test("stop() marks the run stopped before the wrapped UI tears its renderer down", () => {
    const tracker = new RunStatusTracker({ phases: [agentPhase("plan")], identity })
    let activityAtTeardown: string | undefined
    const progress: ProgressUI = { ...noopProgress, stop: () => (activityAtTeardown = tracker.snapshot().activity) }

    trackRunStatus(progress, tracker).stop()
    expect(activityAtTeardown).toBe("stopped")
  })
})

describe("projectName", () => {
  test("takes the last path segment and tolerates trailing slashes", () => {
    expect(projectName("/Users/me/Documents/convoy")).toBe("convoy")
    expect(projectName("/Users/me/Documents/convoy/")).toBe("convoy")
    expect(projectName("")).toBe("…")
  })
})
