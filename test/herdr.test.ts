import { describe, expect, test } from "bun:test"

import {
  HERDR_AGENT,
  HERDR_DISPLAY_AGENT,
  HERDR_METADATA_TTL_MS,
  HERDR_SOURCE,
  HERDR_TOKEN_NAMES,
  HerdrReporter,
  clearMetadataArgv,
  herdrEnabled,
  herdrTokens,
  mapHerdrState,
  releaseAgentArgv,
  reportAgentArgv,
  reportMetadataArgv,
  withoutHerdrEnv,
  type HerdrProcess,
  type HerdrSpawn,
} from "../src/herdr"
import type { RunStatus } from "../src/progress"
import { RunShutdown } from "../src/runner"

const identity = { project: "convoy", pipeline: "implement", branch: "feat/notify" }

function status(overrides: Partial<RunStatus> = {}): RunStatus {
  return { activity: "working", step: 3, totalSteps: 7, identity, stepLabel: "security", ...overrides }
}

const herdrEnv = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }

/** Records exact argv; every command exits 0 (or the given code, in order). */
function recorder(exitCodes: number[] = []) {
  const commands: string[][] = []
  const spawn: HerdrSpawn = (command) => {
    commands.push(command)
    const code = exitCodes[commands.length - 1] ?? 0
    return { exited: Promise.resolve(code) }
  }
  return { commands, spawn }
}

function lastSeq(command: string[]): number {
  const at = command.indexOf("--seq")
  return Number(command[at + 1])
}

describe("herdrEnabled", () => {
  test("is false when HERDR_ENV is unset, empty, or not exactly \"1\", or when the pane id is missing", () => {
    expect(herdrEnabled({ HERDR_PANE_ID: "w1:p1" })).toBe(false)
    expect(herdrEnabled({ HERDR_ENV: "", HERDR_PANE_ID: "w1:p1" })).toBe(false)
    expect(herdrEnabled({ HERDR_ENV: "true", HERDR_PANE_ID: "w1:p1" })).toBe(false)
    expect(herdrEnabled({ HERDR_ENV: "0", HERDR_PANE_ID: "w1:p1" })).toBe(false)
    expect(herdrEnabled({ HERDR_ENV: "1" })).toBe(false)
  })

  test("is true when HERDR_ENV=1 and HERDR_PANE_ID is set, even without the binary", () => {
    expect(herdrEnabled(herdrEnv)).toBe(true)
  })
})

describe("mapHerdrState", () => {
  test("maps every Convoy activity onto a Herdr lifecycle state", () => {
    expect(mapHerdrState(status({ activity: "working" }))).toEqual({ state: "working" })
    expect(mapHerdrState(status({ activity: "waiting", waitReason: "waiting for your permission" }))).toEqual({
      state: "blocked",
      message: "waiting for your permission",
    })
    expect(mapHerdrState(status({ activity: "paused" }))).toEqual({ state: "idle", stateLabel: "paused" })
    expect(mapHerdrState(status({ activity: "stopped", outcome: "completed" }))).toEqual({ state: "idle" })
    expect(mapHerdrState(status({ activity: "stopped", outcome: "failed" }))).toEqual({ state: "blocked" })
    // Torn down by a signal with no outcome recorded.
    expect(mapHerdrState(status({ activity: "stopped" }))).toEqual({ state: "idle" })
  })

  test("waiting without a reason maps to blocked with no message", () => {
    expect(mapHerdrState({ activity: "waiting", step: 1, totalSteps: 1, identity })).toEqual({ state: "blocked" })
  })

  test("strips control characters from the wait reason before it becomes --message", () => {
    expect(mapHerdrState(status({ activity: "waiting", waitReason: "waiting\nfor\tyour permission" }))).toEqual({
      state: "blocked",
      message: "waiting for your permission",
    })
    expect(mapHerdrState(status({ activity: "waiting", waitReason: "\n\t" }))).toEqual({ state: "blocked" })
  })
})

describe("herdrTokens", () => {
  test("builds the sidebar tokens from a status and the convoy run id", () => {
    expect(herdrTokens(status(), "20260519-103045-x7q2")).toEqual({
      pipeline: "implement",
      progress: "3/7",
      step: "security",
      summary: "implement · 3/7 security",
      run_id: "20260519-103045-x7q2",
    })
  })

  test("omits run_id without one, progress without steps, and step without a label", () => {
    expect(herdrTokens({ activity: "working", step: 1, totalSteps: 0, identity })).toEqual({
      pipeline: "implement",
      summary: "implement",
    })
    expect(herdrTokens({ activity: "working", step: 2, totalSteps: 5, identity })).toEqual({
      pipeline: "implement",
      progress: "2/5",
      summary: "implement · 2/5",
    })
  })

  test("omits pipeline and summary when there is nothing to say", () => {
    expect(herdrTokens({ activity: "working", step: 1, totalSteps: 0, identity: { project: "x", pipeline: "" } })).toEqual({})
  })

  test("a 200-char step label is capped at 80 before it becomes a token", () => {
    const tokens = herdrTokens(status({ stepLabel: "s".repeat(200) }))
    expect(tokens.step).toHaveLength(80)
    expect(tokens.step).toEndWith("…")
    expect(tokens.summary!.length).toBeLessThanOrEqual(80)
  })
})

describe("argv builders", () => {
  test("reportAgentArgv is a pure argv builder with the agent and source", () => {
    expect(reportAgentArgv("herdr", "w1:p1", { state: "working", seq: 7 })).toEqual([
      "herdr", "pane", "report-agent", "w1:p1",
      "--source", HERDR_SOURCE,
      "--agent", HERDR_AGENT,
      "--state", "working",
      "--seq", "7",
    ])
    expect(reportAgentArgv("/custom/herdr", "w1:p1", { state: "blocked", message: "waiting for your permission", seq: 8 })).toEqual([
      "/custom/herdr", "pane", "report-agent", "w1:p1",
      "--source", HERDR_SOURCE,
      "--agent", HERDR_AGENT,
      "--state", "blocked",
      "--message", "waiting for your permission",
      "--seq", "8",
    ])
  })

  test("reportMetadataArgv carries the display agent, tokens, and an optional state label", () => {
    expect(
      reportMetadataArgv("herdr", "w1:p1", {
        seq: 9,
        displayAgent: HERDR_DISPLAY_AGENT,
        tokens: { pipeline: "implement", progress: "3/7", step: "security", summary: "implement · 3/7 security", run_id: "20260519-103045-x7q2" },
      }),
    ).toEqual([
      "herdr", "pane", "report-metadata", "w1:p1",
      "--source", HERDR_SOURCE,
      "--agent", HERDR_AGENT,
      "--display-agent", HERDR_DISPLAY_AGENT,
      "--token", "pipeline=implement",
      "--token", "progress=3/7",
      "--token", "step=security",
      "--token", "summary=implement · 3/7 security",
      "--token", "run_id=20260519-103045-x7q2",
      "--seq", "9",
      "--ttl-ms", String(HERDR_METADATA_TTL_MS),
    ])
    expect(reportMetadataArgv("herdr", "w1:p1", { seq: 10, stateLabel: "idle=paused", tokens: {} })).toEqual([
      "herdr", "pane", "report-metadata", "w1:p1",
      "--source", HERDR_SOURCE,
      "--agent", HERDR_AGENT,
      "--state-label", "idle=paused",
      "--seq", "10",
      "--ttl-ms", String(HERDR_METADATA_TTL_MS),
    ])
  })

  test("clearMetadataArgv removes every Convoy presentation field and token", () => {
    const command = clearMetadataArgv("herdr", "w1:p1", 10)
    expect(command).toEqual([
      "herdr", "pane", "report-metadata", "w1:p1",
      "--source", HERDR_SOURCE,
      "--clear-display-agent",
      "--clear-state-labels",
      ...HERDR_TOKEN_NAMES.flatMap((name) => ["--clear-token", name]),
      "--seq", "10",
    ])
  })

  test("releaseAgentArgv is a pure argv builder", () => {
    expect(releaseAgentArgv("herdr", "w1:p1", 11)).toEqual([
      "herdr", "pane", "release-agent", "w1:p1",
      "--source", HERDR_SOURCE,
      "--agent", HERDR_AGENT,
      "--seq", "11",
    ])
  })
})

describe("withoutHerdrEnv", () => {
  test("drops every HERDR_* key and leaves everything else untouched", () => {
    const input = {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/tmp/x",
      HERDR_BIN_PATH: "/bin/herdr",
      PATH: "/usr/bin",
      OPENCODE_CONFIG_DIR: "/tmp/oc",
    }
    expect(withoutHerdrEnv(input)).toEqual({ PATH: "/usr/bin", OPENCODE_CONFIG_DIR: "/tmp/oc" })
  })

  test("does not mutate its input", () => {
    const input = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", PATH: "/usr/bin" }
    withoutHerdrEnv(input)
    expect(input).toEqual({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", PATH: "/usr/bin" })
  })

  test("strips any key matching /^HERDR_/, including workspace, tab, plugin, and active keys", () => {
    const input = { HERDR_WORKSPACE_ID: "w", HERDR_TAB_ID: "t", HERDR_PLUGIN_X: "x", HERDR_ACTIVE_Y: "y", KEEP: "k" }
    expect(withoutHerdrEnv(input)).toEqual({ KEEP: "k" })
  })
})

describe("HerdrReporter", () => {
  test("disabled env: report, release, and stop spawn nothing", async () => {
    const { commands, spawn } = recorder()
    const reporter = new HerdrReporter({ env: {}, spawn, now: () => 1_000 })

    expect(reporter.available).toBe(false)
    expect(reporter.report(status())).toBe(false)
    expect(reporter.release()).toBe(false)
    await reporter.stop()
    expect(commands).toEqual([])
  })

  test("enabled env: a report spawns report-agent then report-metadata for the same pane", () => {
    const { commands, spawn } = recorder()
    const reporter = new HerdrReporter({ env: herdrEnv, spawn, now: () => 1_000 })

    expect(reporter.available).toBe(true)
    expect(reporter.report(status())).toBe(true)

    expect(commands).toHaveLength(2)
    expect(commands[0]![2]).toBe("report-agent")
    expect(commands[1]![2]).toBe("report-metadata")
    expect(commands[0]![3]).toBe("w1:p1")
    expect(commands[1]![3]).toBe("w1:p1")
    expect(commands[0]).toContain("--seq")
    expect(commands[1]).toContain("--seq")
    expect(commands[0]).toContain("--state")
    expect(commands[1]).toContain("--display-agent")
    expect(commands[1]).toContain("Convoy")
  })

  // The mapHerdrState table and the argv builders are each tested in isolation
  // above; these two exercise the composition inside report() so a change to
  // how report() threads the mapped state through the builders is caught.
  test("a paused report emits idle with a 'paused' state label and the run_id token", () => {
    const { commands, spawn } = recorder()
    const reporter = new HerdrReporter({ env: herdrEnv, spawn, now: () => 1_000, runID: "20260519-103045-x7q2" })

    expect(reporter.report(status({ activity: "paused" }))).toBe(true)

    const agent = commands.find((c) => c[2] === "report-agent")!
    expect(agent[agent.indexOf("--state") + 1]).toBe("idle")
    // paused has no wait reason, so no --message is emitted.
    expect(agent).not.toContain("--message")

    const metadata = commands.find((c) => c[2] === "report-metadata")!
    expect(metadata[metadata.indexOf("--state-label") + 1]).toBe("idle=paused")
    // runID from the constructor reaches the metadata run_id token.
    const tokens = metadata.filter((_, i) => metadata[i - 1] === "--token").map((v) => v)
    expect(tokens).toContain("run_id=20260519-103045-x7q2")
  })

  test("a waiting report emits blocked with the wait reason as the agent message", () => {
    const { commands, spawn } = recorder()
    const reporter = new HerdrReporter({ env: herdrEnv, spawn, now: () => 1_000 })

    expect(reporter.report(status({ activity: "waiting", waitReason: "waiting for your permission" }))).toBe(true)

    const agent = commands.find((c) => c[2] === "report-agent")!
    expect(agent[agent.indexOf("--state") + 1]).toBe("blocked")
    expect(agent[agent.indexOf("--message") + 1]).toBe("waiting for your permission")
    // A blocked wait has no custom state label, so no --state-label is emitted.
    const metadata = commands.find((c) => c[2] === "report-metadata")!
    expect(metadata).not.toContain("--state-label")
  })

  test("two reports produce strictly increasing seq values", () => {
    const { commands, spawn } = recorder()
    const reporter = new HerdrReporter({ env: herdrEnv, spawn, now: () => 1_000 })

    reporter.report(status())
    const first = commands.map(lastSeq)
    const firstCount = commands.length
    reporter.report(status({ step: 4, stepLabel: "validate" }))
    const second = commands.slice(firstCount).map(lastSeq)

    expect(first).toEqual([1_000_001, 1_000_002])
    expect(second).toEqual([1_000_003, 1_000_004])
    expect(Math.max(...second)).toBeGreaterThan(Math.max(...first))
  })

  test("an identical status does not spawn again", () => {
    const { commands, spawn } = recorder()
    const reporter = new HerdrReporter({ env: herdrEnv, spawn, now: () => 1_000 })

    expect(reporter.report(status())).toBe(true)
    expect(reporter.report(status())).toBe(false)
    expect(commands).toHaveLength(2)
  })

  test("refreshes unchanged metadata before its TTL expires", async () => {
    const { commands, spawn } = recorder()
    const reporter = new HerdrReporter({
      env: herdrEnv,
      spawn,
      now: () => 1_000,
      metadataHeartbeatMs: 10,
    })

    reporter.report(status())
    await Bun.sleep(25)
    const metadata = commands.filter((command) => command[2] === "report-metadata")
    expect(metadata.length).toBeGreaterThanOrEqual(2)
    expect(lastSeq(metadata.at(-1)!)).toBeGreaterThan(lastSeq(metadata[0]!))

    await reporter.stop()
    const afterStop = commands.length
    await Bun.sleep(25)
    expect(commands).toHaveLength(afterStop)
  })

  test("release schedules observed metadata cleanup and release-agent with greater seq values", async () => {
    const { commands, spawn } = recorder()
    const reporter = new HerdrReporter({ env: herdrEnv, spawn, now: () => 1_000 })

    reporter.report(status())
    const reportSeq = Math.max(...commands.map(lastSeq))

    expect(reporter.release()).toBe(true)
    await reporter.stop()
    expect(commands).toHaveLength(4)
    expect(commands[2]![2]).toBe("report-metadata")
    expect(commands[2]).toContain("--clear-token")
    expect(commands[3]![2]).toBe("release-agent")
    expect(lastSeq(commands[2]!)).toBeGreaterThan(reportSeq)
    expect(lastSeq(commands[3]!)).toBeGreaterThan(lastSeq(commands[2]!))

    expect(reporter.report(status({ step: 5 }))).toBe(false)
    expect(commands).toHaveLength(4)
  })

  test("release twice schedules only one cleanup", async () => {
    const { commands, spawn } = recorder()
    const reporter = new HerdrReporter({ env: herdrEnv, spawn, now: () => 1_000 })

    reporter.report(status())
    expect(reporter.release()).toBe(true)
    expect(reporter.release()).toBe(false)
    await reporter.stop()
    expect(commands.filter((command) => command[2] === "release-agent")).toHaveLength(1)
    expect(commands.filter((command) => command.includes("--clear-display-agent"))).toHaveLength(1)
  })

  test("a throwing spawn or a non-zero live-report exit never throws to the caller", async () => {
    const throwing = new HerdrReporter({
      env: herdrEnv,
      spawn: () => { throw new Error("no herdr binary") },
      now: () => 1_000,
      cleanupAttempts: 1,
      warn: () => {},
    })
    expect(throwing.report(status())).toBe(true)
    expect(throwing.release()).toBe(true)
    await expect(throwing.stop()).resolves.toBeUndefined()

    const { commands, spawn } = recorder([1, 1, 1])
    const failing = new HerdrReporter({ env: herdrEnv, spawn, now: () => 1_000 })
    expect(failing.report(status())).toBe(true)
    expect(failing.report(status({ step: 4, stepLabel: "validate" }))).toBe(true)
    expect(commands).toHaveLength(4)
  })

  test("HERDR_BIN_PATH selects the binary; otherwise herdr", () => {
    const { commands, spawn } = recorder()
    const reporter = new HerdrReporter({ env: { ...herdrEnv, HERDR_BIN_PATH: "/custom/herdr" }, spawn, now: () => 1_000 })

    reporter.report(status())
    expect(commands[0]![0]).toBe("/custom/herdr")
    expect(commands[1]![0]).toBe("/custom/herdr")
  })

  test("stop drains in-flight commands, then releases", async () => {
    let resolveExit!: (code: number) => void
    const pending = { exited: new Promise<number>((resolve) => { resolveExit = resolve }) }
    const commands: string[][] = []
    const spawn: HerdrSpawn = (command) => {
      commands.push(command)
      return commands.length === 1 ? pending : { exited: Promise.resolve(0) }
    }
    const reporter = new HerdrReporter({ env: herdrEnv, spawn, now: () => 1_000 })

    reporter.report(status())
    const stopping = reporter.stop()

    // The release must wait for the in-flight command to drain.
    expect(commands.some((command) => command[2] === "release-agent")).toBe(false)
    resolveExit(0)
    await stopping

    expect(commands.at(-1)![2]).toBe("release-agent")
    expect(reporter.report(status({ step: 9 }))).toBe(false)
  })

  test("stop is idempotent and releases only once", async () => {
    const { commands, spawn } = recorder()
    const reporter = new HerdrReporter({ env: herdrEnv, spawn, now: () => 1_000 })

    reporter.report(status())
    await reporter.stop()
    await reporter.stop()

    expect(commands.filter((command) => command[2] === "release-agent")).toHaveLength(1)
    // The stopped reporter rejects both reports and explicit releases.
    expect(reporter.report(status({ step: 9 }))).toBe(false)
    expect(reporter.release()).toBe(false)
  })

  test("concurrent stop callers share one cleanup promise", async () => {
    const { commands, spawn } = recorder()
    const reporter = new HerdrReporter({ env: herdrEnv, spawn, now: () => 1_000 })
    reporter.report(status())

    const first = reporter.stop()
    const second = reporter.stop()
    expect(second).toBe(first)
    await Promise.all([first, second])

    expect(commands.filter((command) => command[2] === "release-agent")).toHaveLength(1)
  })

  test("stop waits for the observed release child to exit", async () => {
    let resolveRelease!: (code: number) => void
    let settled = false
    const commands: string[][] = []
    const spawn: HerdrSpawn = (command) => {
      commands.push(command)
      if (command[2] === "release-agent") {
        return { exited: new Promise<number>((resolve) => { resolveRelease = resolve }) }
      }
      return { exited: Promise.resolve(0) }
    }
    const reporter = new HerdrReporter({ env: herdrEnv, spawn, now: () => 1_000 })
    reporter.report(status())

    const stopping = reporter.stop().then(() => { settled = true })
    await Bun.sleep(0)
    expect(commands.at(-1)?.[2]).toBe("release-agent")
    expect(settled).toBe(false)

    resolveRelease(0)
    await stopping
    expect(settled).toBe(true)
  })

  test("a rejected release retries with a fresh greater sequence", async () => {
    const commands: string[][] = []
    let releases = 0
    const spawn: HerdrSpawn = (command) => {
      commands.push(command)
      if (command[2] === "release-agent") {
        releases++
        return { exited: Promise.resolve(releases === 1 ? 1 : 0) }
      }
      return { exited: Promise.resolve(0) }
    }
    const reporter = new HerdrReporter({ env: herdrEnv, spawn, now: () => 1_000 })
    reporter.report(status())
    await reporter.stop()

    const attempts = commands.filter((command) => command[2] === "release-agent")
    expect(attempts).toHaveLength(2)
    expect(lastSeq(attempts[1]!)).toBeGreaterThan(lastSeq(attempts[0]!))
  })

  test("a hung release is killed within the bound and retried", async () => {
    let releaseAttempts = 0
    let kills = 0
    let unrefs = 0
    const signals: Array<NodeJS.Signals | undefined> = []
    const commands: string[][] = []
    const spawn: HerdrSpawn = (command) => {
      commands.push(command)
      if (command[2] !== "release-agent") return { exited: Promise.resolve(0) }
      releaseAttempts++
      if (releaseAttempts > 1) return { exited: Promise.resolve(0) }
      return {
        exited: new Promise<number>(() => {}),
        kill(signal) { kills++; signals.push(signal) },
        unref() { unrefs++ },
      }
    }
    const reporter = new HerdrReporter({
      env: herdrEnv,
      spawn,
      now: () => 1_000,
      cleanupAttemptMs: 10,
      cleanupAttempts: 2,
    })

    await Promise.race([
      reporter.stop(),
      Bun.sleep(500).then(() => { throw new Error("release retry exceeded its bound") }),
    ])
    expect(kills).toBe(1)
    expect(signals).toEqual(["SIGKILL"])
    expect(unrefs).toBe(1)
    expect(commands.filter((command) => command[2] === "release-agent")).toHaveLength(2)
  })

  test("forced shutdown attempts release before its observation window exits", async () => {
    const commands: string[][] = []
    const exits: number[] = []
    const reporter = new HerdrReporter({
      env: herdrEnv,
      spawn: (command) => {
        commands.push(command)
        // Simulate a status report that would consume stop()'s drain budget.
        if (command[2] === "report-agent") return { exited: new Promise<number>(() => {}), unref() {} }
        return { exited: Promise.resolve(0) }
      },
      now: () => 1_000,
    })
    reporter.report(status())
    const shutdown = new RunShutdown({
      exit: (code) => { exits.push(code) },
      graceMs: 1_000,
      forceObservationMs: 20,
    })
    shutdown.setForceHandler(() => { void reporter.forceRelease() })

    try {
      shutdown.request("SIGINT")
      shutdown.request("SIGINT")
      await Bun.sleep(0)
      expect(commands.some((command) => command[2] === "release-agent")).toBe(true)
      expect(exits).toEqual([])
      await Bun.sleep(30)
      expect(exits).toEqual([130])
    } finally {
      shutdown.dispose()
    }
  })

  test("cleanup exhausts spawn failures safely and reports one warning per command", async () => {
    let spawns = 0
    const warnings: string[] = []
    const reporter = new HerdrReporter({
      env: herdrEnv,
      spawn: () => { spawns++; throw new Error("socket unavailable") },
      now: () => 1_000,
      cleanupAttempts: 2,
      warn: (message) => warnings.push(message),
    })

    await expect(reporter.stop()).resolves.toBeUndefined()
    expect(spawns).toBe(4)
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain("clear Convoy metadata")
    expect(warnings[1]).toContain("release the Convoy Herdr agent")
  })

  test("stop after an explicit release does not release again", async () => {
    const { commands, spawn } = recorder()
    const reporter = new HerdrReporter({ env: herdrEnv, spawn, now: () => 1_000 })

    reporter.report(status())
    expect(reporter.release()).toBe(true)
    await reporter.stop()

    expect(commands.filter((command) => command[2] === "release-agent")).toHaveLength(1)
  })

  test("stop returns within the drain bound when a herdr child never exits", async () => {
    let kills = 0
    let unrefs = 0
    const hung: HerdrProcess = {
      exited: new Promise<number>(() => {}),
      kill() {
        kills++
      },
      unref() {
        unrefs++
      },
    }
    const commands: string[][] = []
    const spawn: HerdrSpawn = (command) => {
      commands.push(command)
      return commands.length === 1 ? hung : { exited: Promise.resolve(0) }
    }
    const reporter = new HerdrReporter({ env: herdrEnv, spawn, now: () => 1_000 })
    reporter.report(status())
    expect(unrefs).toBeGreaterThan(0)

    await Promise.race([
      reporter.stop(),
      Bun.sleep(1_000).then(() => {
        throw new Error("stop() did not return within the drain bound")
      }),
    ])

    expect(kills).toBe(1)
    expect(commands.at(-1)![2]).toBe("release-agent")
    expect(reporter.report(status({ step: 9 }))).toBe(false)
  })
})
