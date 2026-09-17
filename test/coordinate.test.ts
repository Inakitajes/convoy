import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { advisorNeedsOf } from "../src/advisor"
import { ControlProgress } from "../src/control-progress"
import {
  convoyCoordinateArgv,
  assertInternalLaunchPath,
  forwardCoordinatorLogs,
  launchPayload,
  readLaunchFile,
  rmPendingLaunch,
  runCoordinateBoot,
  spawnCoordinator,
  sweepPendingLaunches,
  waitForCoordinatorReady,
  writePendingLaunch,
} from "../src/coordinate"
import type { AutoAccept, RunOutcome } from "../src/progress"
import { RunShutdown, UserAbortError } from "../src/runner"
import type { AgentStep, RunOptions, RunPlan } from "../src/types"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "convoy-coordinate-"))
  dirs.push(dir)
  return dir
}

describe("convoyCoordinateArgv", () => {
  test("a standalone executable passes execPath --coordinate <launch>", () => {
    const argv = convoyCoordinateArgv("/tmp/launch.json")
    // Bun source invocations run process.argv[1] (this script); the standalone
    // branch is covered structurally: no "run" wrapper is ever inserted.
    expect(argv[0]).toBe(process.execPath)
    expect(argv).toContain("--coordinate")
    expect(argv[argv.length - 1]).toBe("/tmp/launch.json")
  })
})

describe("launch file round-trip", () => {
  test("drops the progress function before persisting", async () => {
    const dir = await scratch()
    const options: RunOptions = {
      prompt: "do the thing",
      files: [],
      onlySteps: [],
      skipSteps: [],
      resumeRunID: "",
      keepRunDir: true,
      modelOverride: "",
      advisorOverride: "",
      advisorDisabled: false,
      tui: true,
      notify: undefined,
      notifications: {},
      humanReview: false,
      baseRef: "main",
      targetDir: "/tmp/repo",
      worktree: false,
      includeDirty: false,
      yolo: false,
      smart: false,
      smartJudgeModel: "openai/gpt-5",
      pipeline: { name: "implement", steps: [] },
      agents: [],
      permissions: { allow: [], deny: [] },
      hooks: { pre: [], post: [], pipelines: {} },
      prdHistory: true,
      planOnly: false,
      noConfirm: false,
    }
    const payload = launchPayload(options, undefined)
    const pending = await writePendingLaunch(payload, dir)
    const loaded = await readLaunchFile(pending.launchPath)

    expect(loaded.schemaVersion).toBe(1)
    expect(loaded.options.targetDir).toBe("/tmp/repo")
    expect("progress" in loaded.options).toBe(false)
    expect(loaded.plan).toBeUndefined()
  })

  test("rejects a malformed launch file", async () => {
    const dir = await scratch()
    await writeFile(join(dir, "bad.json"), "{}")
    await expect(readLaunchFile(join(dir, "bad.json"))).rejects.toThrow(/invalid convoy launch/)
  })

  test("--coordinate only accepts launch files under the pending root", () => {
    const root = "/home/user/.convoy/pending"
    // A pending launch dir is a child of the root.
    expect(() => assertInternalLaunchPath(join(root, "abc", "launch.json"), root)).not.toThrow()
    // Anything else — /tmp, a sibling directory, or a path that merely starts
    // with the same prefix — is refused: a launch file carries full RunOptions
    // (hooks, target dir, permission policy) and must not be hand-fed.
    expect(() => assertInternalLaunchPath("/tmp/launch.json", root)).toThrow(/must live under/)
    expect(() => assertInternalLaunchPath("/home/user/.convoy/pending-evil/launch.json", root)).toThrow(/must live under/)
    expect(() => assertInternalLaunchPath("/etc/passwd", root)).toThrow(/must live under/)
  })
})

describe("waitForCoordinatorReady", () => {
  test("parses the ready file", async () => {
    const dir = await scratch()
    const readyPath = join(dir, "ready")
    await writeFile(readyPath, JSON.stringify({ runID: "20260101-000000-ab12", controlUrl: "http://127.0.0.1:1234" }))
    expect(await waitForCoordinatorReady(readyPath)).toEqual({ runID: "20260101-000000-ab12", controlUrl: "http://127.0.0.1:1234" })
  })

  test("times out when the coordinator never writes it", async () => {
    const dir = await scratch()
    const error = await waitForCoordinatorReady(join(dir, "never"), 120).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/did not become ready/)
    expect((error as Error).name).toBe("CoordinatorBootTimeoutError")
  })
})

describe("spawnCoordinator", () => {
  test("records the child pid so the sweep can tell live coordinators from orphans", async () => {
    const root = await scratch()
    const pending = await writePendingLaunch(launchPayload({ ...minimalOptions() } as RunOptions, undefined), root)
    // writePendingLaunch fires a concurrent sweep that deletes pending dirs
    // whose recorded pid is not alive. A fabricated pid races that sweep into
    // deleting this dir between the pid write and the read below; the test
    // process's own pid is always alive, so the sweep spares it.
    const fakePid = process.pid
    const fakeSpawn = (() =>
      ({
        pid: fakePid,
        unref: () => {},
        exited: Promise.resolve(0),
      })) as unknown as typeof Bun.spawn
    const result = await spawnCoordinator(pending, { spawn: fakeSpawn, isStandalone: () => false })
    expect(result.pid).toBe(fakePid)
    expect(await readFile(join(pending.dir, "pid"), "utf8")).toBe(String(fakePid))
  })
})

describe("sweepPendingLaunches", () => {
  test("removes dead-pid and stale pid-less dirs, keeps live-pid and young dirs", async () => {
    const root = await scratch()
    const live = "11111111-1111-4111-8111-111111111111"
    const dead = "22222222-2222-4222-8222-222222222222"
    const young = "33333333-3333-4333-8333-333333333333"
    const stale = "44444444-4444-4444-8444-444444444444"
    const foreign = "not-a-uuid"
    for (const name of [live, dead, young, stale, foreign]) {
      const dir = join(root, name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, "launch.json"), "{}")
    }

    await writeFile(join(root, live, "pid"), String(process.pid))
    const gone = Bun.spawn(["true"])
    await gone.exited
    await writeFile(join(root, dead, "pid"), String(gone.pid))
    // No pid file: young dirs survive (spawn may be in flight), old ones go.
    const ancient = new Date(Date.now() - 48 * 60 * 60 * 1000)
    await utimes(join(root, stale), ancient, ancient)

    await sweepPendingLaunches(root)

    expect((await readdir(root)).sort()).toEqual([foreign, live, young].sort())
  })
})

describe("forwardCoordinatorLogs", () => {
  test("streams appended bytes and drains the tail on stop", async () => {
    const dir = await scratch()
    const logPath = join(dir, "coordinator.log")
    await writeFile(logPath, "first line\n")
    const chunks: string[] = []
    const forwarder = await forwardCoordinatorLogs(logPath, (chunk) => chunks.push(chunk), 20)

    await Bun.sleep(60)
    await writeFile(logPath, "first line\nsecond line\n")
    await Bun.sleep(60)

    // Content appended after the last pump but before the child's exit is
    // drained by stop(), which is why the parent calls it after exited.
    await writeFile(logPath, "first line\nsecond line\nthird line\n")
    await forwarder.stop()

    expect(chunks.join("")).toBe("first line\nsecond line\nthird line\n")
  })

  test("rmPendingLaunch deletes the dir and tolerates it being gone already", async () => {
    const dir = await scratch()
    await rmPendingLaunch(dir)
    await expect(readdir(dir)).rejects.toThrow()
    await rmPendingLaunch(dir) // no throw the second time
  })
})

describe("runCoordinateBoot", () => {
  const previousControlUrl = process.env.CONVOY_CONTROL_URL
  afterAll(() => {
    if (previousControlUrl === undefined) delete process.env.CONVOY_CONTROL_URL
    else process.env.CONVOY_CONTROL_URL = previousControlUrl
  })

  async function writeBootLaunch(root: string) {
    return writePendingLaunch(launchPayload({ ...minimalOptions() } as RunOptions, minimalPlan()), root)
  }

  test("a non-goal run releases the hosted teardown and drives the finish hold", async () => {
    const root = await scratch()
    const pending = await writeBootLaunch(root)
    let released = 0
    const finished: RunOutcome[] = []

    const code = await runCoordinateBoot(pending.launchPath, pending.readyPath, {
      launchRoot: root,
      createProgress: (opts) => {
        const progress = new ControlProgress(opts)
        const orig = progress.runFinished.bind(progress)
        progress.runFinished = async (outcome) => {
          finished.push(outcome)
          return orig(outcome)
        }
        return progress
      },
      run: async () => ({
        runID: "20260101-000000-ab12",
        dir: "/tmp/run",
        release: async () => {
          released += 1
        },
      }),
    })

    expect(code).toBe(0)
    expect(released).toBe(1)
    expect(finished).toEqual([{ status: "completed", runDir: "/tmp/run" }])
  })

  test("a thrown hosted run still releases via hostedTeardownFromError after the failed finish hold", async () => {
    const root = await scratch()
    const pending = await writeBootLaunch(root)
    const boom = new Error("phase tests failed")
    let released = 0
    const finished: RunOutcome[] = []

    await expect(
      runCoordinateBoot(pending.launchPath, pending.readyPath, {
        launchRoot: root,
        createProgress: (opts) => {
          const progress = new ControlProgress(opts)
          const orig = progress.runFinished.bind(progress)
          progress.runFinished = async (outcome) => {
            finished.push(outcome)
            return orig(outcome)
          }
          return progress
        },
        run: async () => {
          throw boom
        },
        hostedTeardownFromError: (error) =>
          error === boom
            ? {
                runDir: "/tmp/run",
                release: async () => {
                  released += 1
                },
              }
            : undefined,
      }),
    ).rejects.toThrow(/phase tests failed/)

    expect(released).toBe(1)
    expect(finished).toEqual([{ status: "failed", runDir: "/tmp/run", error: "phase tests failed" }])
  })

  test("hands the reviewed plan to run so resolvedAdvisor survives the coordinator hop", async () => {
    // Mirrors a real launch.json: options.pipeline is the unresolved config
    // (advisor string only), while plan.pipeline carries the routed
    // resolvedAdvisor. Dropping the plan here is what silently turns an
    // advised pipeline into an unadvised one — advisorNeedsOf only looks at
    // resolvedAdvisor, and run() only swaps in the reviewed pipeline when
    // options.plan is set.
    const root = await scratch()
    const unresolved = advisedImplementerStep()
    const resolved = {
      ...unresolved,
      model: "openrouter/deepseek/deepseek-v4.1-flash",
      resolvedModel: {
        configured: "nan/deepseek-v4-flash#high",
        logical: "nan/deepseek-v4-flash#high",
        gateway: "nitro" as const,
        providerID: "openrouter",
        modelID: "deepseek/deepseek-v4.1-flash",
        variant: "high",
        target: "openrouter/deepseek/deepseek-v4.1-flash#high",
      },
      resolvedAdvisor: {
        configured: "openrouter/x-ai/grok-4.6#high",
        logical: "xai/grok-4.6#high",
        gateway: "nitro" as const,
        providerID: "openrouter",
        modelID: "x-ai/grok-4.6",
        variant: "high",
        target: "openrouter/x-ai/grok-4.6#high",
      },
    }
    const pending = await writePendingLaunch(
      launchPayload(
        { ...minimalOptions(), pipeline: { name: "implement-lite", steps: [unresolved] } } as RunOptions,
        { ...minimalPlan(), pipeline: { name: "implement-lite", steps: [resolved] } },
      ),
      root,
    )
    let received: RunOptions | undefined

    const code = await runCoordinateBoot(pending.launchPath, pending.readyPath, {
      launchRoot: root,
      run: async (options) => {
        received = options
        return { runID: "20260101-000000-ab12", dir: "/tmp/run" }
      },
    })

    expect(code).toBe(0)
    expect(received).toBeDefined()
    // The unresolved options.pipeline is what a boot that forgets the plan
    // would execute — and it has no advisor at all.
    expect(advisorNeedsOf(received!.pipeline.steps).agents.size).toBe(0)
    expect(received?.plan).toBeDefined()
    // Same selection run() makes: the reviewed plan's pipeline, not the
    // unresolved options.pipeline that launch.json also carries.
    const executed = received?.plan ? received.plan.pipeline : received!.pipeline
    expect(advisorNeedsOf(executed.steps).agents.size).toBe(1)
    expect([...advisorNeedsOf(executed.steps).agents]).toEqual(["implementer"])
  })

  test("a --yolo launch seeds the shared autoAccept so the gate starts in all mode", async () => {
    // launch.json carries yolo/smart as booleans and no autoAccept object.
    // run() uses options.autoAccept when present and only falls back to
    // yolo/smart when it is absent. The boot currently hands run() the
    // ControlProgress default ({ mode: "off" }), so --yolo advertises itself
    // in the log but the first ask-level permission is not auto-allowed.
    const root = await scratch()
    const pending = await writePendingLaunch(
      launchPayload({ ...minimalOptions(), yolo: true } as RunOptions, minimalPlan()),
      root,
    )
    let received: RunOptions | undefined
    let shared: AutoAccept | undefined

    const code = await runCoordinateBoot(pending.launchPath, pending.readyPath, {
      launchRoot: root,
      createProgress: (opts) => {
        const progress = new ControlProgress(opts)
        shared = progress.autoAccept
        return progress
      },
      run: async (options) => {
        received = options
        return { runID: "20260101-000000-ab12", dir: "/tmp/run" }
      },
    })

    expect(code).toBe(0)
    expect(received?.yolo).toBe(true)
    expect(received?.autoAccept).toBe(shared)
    expect(received?.autoAccept?.mode).toBe("all")
  })

  test("a --smart launch seeds the shared autoAccept so the judge is on from the first permission", async () => {
    const root = await scratch()
    const pending = await writePendingLaunch(
      launchPayload({ ...minimalOptions(), smart: true } as RunOptions, minimalPlan()),
      root,
    )
    let received: RunOptions | undefined

    const code = await runCoordinateBoot(pending.launchPath, pending.readyPath, {
      launchRoot: root,
      run: async (options) => {
        received = options
        return { runID: "20260101-000000-ab12", dir: "/tmp/run" }
      },
    })

    expect(code).toBe(0)
    expect(received?.smart).toBe(true)
    expect(received?.autoAccept?.mode).toBe("smart")
  })

  test("a user abort releases without driving the finish hold", async () => {
    const root = await scratch()
    const pending = await writeBootLaunch(root)
    const abort = new UserAbortError()
    let released = 0
    const finished: RunOutcome[] = []

    await expect(
      runCoordinateBoot(pending.launchPath, pending.readyPath, {
        launchRoot: root,
        createProgress: (opts) => {
          const progress = new ControlProgress(opts)
          const orig = progress.runFinished.bind(progress)
          progress.runFinished = async (outcome) => {
            finished.push(outcome)
            return orig(outcome)
          }
          return progress
        },
        run: async () => {
          throw abort
        },
        hostedTeardownFromError: (error) =>
          error === abort
            ? {
                runDir: "/tmp/run",
                release: async () => {
                  released += 1
                },
              }
            : undefined,
      }),
    ).rejects.toBe(abort)

    expect(released).toBe(1)
    expect(finished).toEqual([])
  })

  test("SC-1: a signal during the finish hold releases it and runs the owned stop", async () => {
    // The coordinator's shutdown scope must outlive run(): a SIGTERM after
    // execution finishes but before the owned server stops has to release the
    // parked terminal wait and fall through to the bounded stop (spec R4). The
    // scope is injected so the test delivers the signal without killing the
    // test runner.
    const root = await scratch()
    const pending = await writeBootLaunch(root)
    const order: string[] = []
    const shutdown = new RunShutdown({ exit: () => {} })
    let holdRegistered!: () => void
    const registered = new Promise<void>((resolve) => {
      holdRegistered = resolve
    })

    const promise = runCoordinateBoot(pending.launchPath, pending.readyPath, {
      launchRoot: root,
      createShutdown: () => shutdown,
      // The test's manual `request` stands in for the process signal; no real
      // handler is installed.
      installSignals: () => () => {},
      createProgress: (opts) => {
        const progress = new ControlProgress(opts)
        progress.runFinished = async () => {
          order.push("hold")
          holdRegistered()
          await new Promise<void>(() => {})
        }
        return progress
      },
      run: async () => ({
        runID: "20260101-000000-ab12",
        dir: "/tmp/run",
        release: async () => {
          order.push("release")
        },
      }),
    })

    await registered
    shutdown.request("SIGTERM")
    const code = await promise
    expect(code).toBe(0)
    expect(order).toEqual(["hold", "release"])
    // The scope is disposed after release: a later request is inert.
    shutdown.request("SIGTERM")
    expect(order).toEqual(["hold", "release"])
  })
})

function advisedImplementerStep(): AgentStep {
  return {
    type: "agent",
    name: "implementer",
    stepName: "implementer",
    groupId: "g1",
    agentName: "implementer",
    description: "Implements the feature",
    model: "nan/deepseek-v4-flash",
    variant: "high",
    advisor: "openrouter/x-ai/grok-4.6",
    advisorVariant: "high",
    inputFiles: ["prd.md"],
    inputDiff: false,
    reportPath: "reports/implementer.md",
    deliverableContract: { kind: "markdown-report" },
  }
}

function minimalPlan(): RunPlan {
  return {
    prompt: { source: "inline", text: "do the thing" },
    target: { directory: "/tmp/repo", baseRef: "main", worktree: false, dirty: false },
    pipeline: { name: "implement", steps: [] },
    modelRouting: { gateway: "openrouter" },
    hooks: { pre: [], post: [] },
    attachments: [],
    permissions: "interactive",
  }
}

function minimalOptions(): Partial<RunOptions> {
  return {
    prompt: "sweep",
    files: [],
    onlySteps: [],
    skipSteps: [],
    resumeRunID: "",
    keepRunDir: true,
    modelOverride: "",
    advisorOverride: "",
    advisorDisabled: false,
    tui: false,
    humanReview: false,
    baseRef: "main",
    targetDir: "/tmp/repo",
    worktree: false,
    includeDirty: false,
    yolo: false,
    smart: false,
    pipeline: { name: "implement", steps: [] },
    agents: [],
    permissions: { allow: [], deny: [] },
    hooks: { pre: [], post: [], pipelines: {} },
    prdHistory: true,
    planOnly: false,
    noConfirm: false,
  }
}
