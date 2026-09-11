import { afterAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { PermissionPromptInfo, PermissionReply, ProgressUI, RunOutcome } from "../src/progress"
import type { RunOptions } from "../src/types"

import { preparePhaseRun, run as realRun, hostedTeardownFromError, UserAbortError, compactRunRowName, type RunDeps } from "../src/runner"
import { buildRunPlan } from "../src/run-plan"
import { noopProgress } from "../src/progress"
import { builtInAgents } from "../src/pipeline"
import { prdHistoryDir, readPrdHistoryIndex, writePrdHistory } from "../src/prd-history"
import { loadOpenSpecBundle } from "../src/openspec"
import { prepareWorktreeForRun } from "../src/cli"
import { HerdrReporter } from "../src/herdr"

// The runner's run() spawns a real opencode server. Inject the fake through
// run()'s deps seam rather than `mock.module("../src/opencode", …)`: that mock
// is process-global under bun:test and would replace the *whole* opencode
// module for every other test file in the run, so test/opencode.test.ts would
// import the stub's identity `shellQuote`/empty `sessionShellCommand` instead
// of the real ones whenever test load order put this file first (which is
// exactly what flipped the ubuntu CI red while macOS stayed green). The deps
// seam keeps the fake local: only `startOpencode` is swapped, and only here.
const fakeClient = {
  event: { subscribe: async () => ({ stream: (async function* () {})() }) },
  session: { status: async () => ({ data: {} }), messages: async () => ({ data: [] }) },
  permission: { reply: async () => ({}) },
}

// SC-4: When this flag is set, startOpencode throws a primitive (not an Error)
// so the runner's catch-block wrapping can be tested against a real run().
let throwPrimitiveFromStart = false

const fakeStartOpencode: RunDeps["startOpencode"] = async () => {
  if (throwPrimitiveFromStart) throw "primitive boom"
  return {
    client: fakeClient as never,
    url: "http://127.0.0.1:41234",
    close: () => {},
  }
}

// Bind the fake opencode handle so every test in this file exercises the
// hosted-progress contract without spawning a real SDK server.
const run = (options: RunOptions) => realRun(options, { startOpencode: fakeStartOpencode })

const hostedHome = await mkdtemp(join(tmpdir(), "convoy-hosted-home-"))

afterAll(async () => {
  await rm(hostedHome, { recursive: true, force: true })
})

async function git(args: string[], cwd: string) {
  const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`)
  return out
}

async function cleanRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-hosted-repo-"))
  await git(["init", "-q"], dir)
  await Bun.write(join(dir, "keep.txt"), "base\n")
  await git(["add", "-A"], dir)
  await git(["commit", "-qm", "base"], dir)
  return dir
}

const emptyPipeline = { name: "hosted-test", steps: [] }

function makeOptions(repo: string, overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    prompt: "build it",
    prdHistory: true,
    files: [],
    onlySteps: [],
    skipSteps: [],
    resumeRunID: "",
    keepRunDir: true,
    modelOverride: "",
    advisorOverride: "",
    advisorDisabled: false,
    tui: false,
    notify: false,
    notifications: { enabled: false, terminalTitle: false },
    humanReview: false,
    baseRef: "HEAD",
    targetDir: repo,
    worktree: false,
    includeDirty: false,
    yolo: false,
    smart: false,
    smartJudgeModel: "openai/gpt-5.6-sol",
    pipeline: emptyPipeline,
    agents: [...builtInAgents],
    permissions: { allow: [], deny: [] },
    hooks: { pre: [], post: [], pipelines: {} },
    ...overrides,
  }
}

/** A dashboard recording the hosted-mode calls and never resolving the finish hold. */
function fakeDashboard() {
  const events: string[] = []
  const progress: ProgressUI = {
    ...noopProgress,
    start: () => void events.push("start"),
    serverReady: () => void events.push("serverReady"),
    message: () => void events.push("message"),
    setGoalLoop: () => void events.push("setGoalLoop"),
    resetPipeline: () => void events.push("resetPipeline"),
    setAbortHandler: (handler) => void events.push(handler ? "setAbortHandler" : "clearAbortHandler"),
    setHostControls: () => void events.push("setHostControls"),
    runFinished: (outcome: RunOutcome) => {
      events.push(`runFinished:${outcome.status}`)
      return new Promise<void>(() => {})
    },
    stop: () => void events.push("stop"),
  }
  return { progress, events }
}

describe("run() with a hosted progress", () => {
  const originalHome = process.env.CONVOY_HOME
  process.env.CONVOY_HOME = hostedHome

  test("never stops the shared UI and defers server teardown to release", async () => {
    const repo = await cleanRepo()
    const dashboard = fakeDashboard()
    try {
      const result = await run(makeOptions(repo, { progress: dashboard.progress }))

      // Hosted mode: the dashboard is repointed at this run, never stopped, and
      // the run never holds a finish screen.
      expect(dashboard.events).toContain("resetPipeline")
      expect(dashboard.events).toContain("setHostControls")
      expect(dashboard.events).toContain("setAbortHandler")
      expect(dashboard.events).not.toContain("stop")
      expect(dashboard.events).not.toContain("runFinished:completed")
      expect(dashboard.events).not.toContain("runFinished:failed")
      // The abort handler is cleared on the way out, not left pointing at a dead run.
      expect(dashboard.events).toContain("clearAbortHandler")
      // Every OpenCode run receives the report shim, even without an advisor.
      expect(existsSync(join(hostedHome, ".convoy", "opencode", "tools", "write_report.ts"))).toBe(true)

      // The finally no longer closes the server/lease: those ride on release.
      expect(result.release).toBeFunction()
      const metadata = JSON.parse(await readFile(join(result.dir, "metadata.json"), "utf8"))
      expect(metadata.server).toBeDefined()

      await result.release?.()
      const after = JSON.parse(await readFile(join(result.dir, "metadata.json"), "utf8"))
      expect(after.server).toBeUndefined()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("keeps the Herdr agent claimed through the finish hold and only then release-agent", async () => {
    // Hosted run() used to herdr.stop() in its finally — before the coordinator
    // holds the finish screen — so Herdr dropped Convoy from the agents list
    // (back to spaces) without ever publishing idle/completed.
    const repo = await cleanRepo()
    const dashboard = fakeDashboard()
    const commands: string[][] = []
    const herdr = new HerdrReporter({
      env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
      spawn: (command) => {
        commands.push(command)
        return { exited: Promise.resolve(0) }
      },
      now: () => 1_000,
    })
    try {
      const result = await realRun(makeOptions(repo, { progress: dashboard.progress }), {
        startOpencode: fakeStartOpencode,
        createHerdrReporter: () => herdr,
      })

      const verbs = () => commands.map((command) => command[2])
      expect(verbs()).toContain("report-agent")
      expect(verbs()).not.toContain("release-agent")
      const lastAgent = [...commands].reverse().find((command) => command[2] === "report-agent")
      expect(lastAgent?.[lastAgent.indexOf("--state") + 1]).toBe("idle")

      await result.release?.()
      expect(verbs()).toContain("release-agent")
      expect(verbs().at(-1)).toBe("release-agent")
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("a hosted user abort publishes the stopped snapshot to Herdr before release-agent", async () => {
    // A user abort in hosted mode: the coordinator owns the UI so run()'s
    // finally never calls progress.stop() (which is what publishes the
    // terminal snapshot in-process). Without an explicit publish the Herdr
    // agent used to vanish via release-agent without ever showing stopped.
    const repo = await cleanRepo()
    const dashboard = fakeDashboard()
    const commands: string[][] = []
    const herdr = new HerdrReporter({
      env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
      spawn: (command) => {
        commands.push(command)
        return { exited: Promise.resolve(0) }
      },
      now: () => 1_000,
    })
    // POST /abort lands while run() is still booting: the handler run() arms
    // at boot fires the real shutdown request, and the pre-hook's
    // throwIfAborted surfaces it as the run's UserAbortError.
    const progress: ProgressUI = {
      ...dashboard.progress,
      setAbortHandler: (handler) => {
        dashboard.progress.setAbortHandler?.(handler)
        if (handler) handler()
      },
    }
    let aborted: unknown
    try {
      await realRun(
        makeOptions(repo, {
          progress,
          hooks: { pre: [{ name: "gate", command: "true" }], post: [], pipelines: {} },
        }),
        { startOpencode: fakeStartOpencode, createHerdrReporter: () => herdr },
      )
      throw new Error("expected the aborted run to reject")
    } catch (error) {
      aborted = error
    }
    expect(aborted).toBeInstanceOf(UserAbortError)

    // Before release: the last report-agent state must be idle (the terminal
    // "stopped" snapshot), not a bare vanish.
    const verbs = () => commands.map((command) => command[2])
    expect(verbs()).not.toContain("release-agent")
    const lastAgent = [...commands].reverse().find((command) => command[2] === "report-agent")
    expect(lastAgent?.[lastAgent.indexOf("--state") + 1]).toBe("idle")

    // The coordinator releases the aborted run's teardown, like
    // coordinate.ts does for a user abort.
    const teardown = hostedTeardownFromError(aborted)
    await teardown?.release?.()
    expect(verbs()).toContain("release-agent")
    expect(verbs().at(-1)).toBe("release-agent")
  })

  test("a hosted --no-keep-run-dir run keeps the workspace until release, then deletes it", async () => {
    // The coordinator holds the finish screen AFTER run() returns. Deleting
    // the workspace in run()'s finally would yank reports out from under [i].
    const repo = await cleanRepo()
    const dashboard = fakeDashboard()
    try {
      const result = await run(makeOptions(repo, { progress: dashboard.progress, keepRunDir: false }))
      expect(existsSync(result.dir)).toBe(true)
      await result.release?.()
      expect(existsSync(result.dir)).toBe(false)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("a hosted --no-keep-run-dir run keeps the workspace when the dashboard asked to keep it before release", async () => {
    const repo = await cleanRepo()
    let keep = false
    const dashboard = fakeDashboard()
    dashboard.progress.keepRunDirRequested = () => keep
    try {
      const result = await run(makeOptions(repo, { progress: dashboard.progress, keepRunDir: false }))
      expect(existsSync(result.dir)).toBe(true)
      keep = true
      await result.release?.()
      expect(existsSync(result.dir)).toBe(true)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("a failing hosted run never holds and hands its teardown back on the error", async () => {
    const repo = await cleanRepo()
    const dashboard = fakeDashboard()
    try {
      // A post-hook that exits non-zero fails the run after the server is up
      // and its metadata entry recorded, so the deferred teardown has something
      // observable to close.
      let failure: unknown
      try {
        await run(makeOptions(repo, {
          progress: dashboard.progress,
          hooks: { pre: [], post: [{ name: "boom", command: "exit 1" }], pipelines: {} },
        }))
        throw new Error("the failing run should have rejected")
      } catch (error) {
        failure = error
      }

      expect(String(failure)).toContain("exited with code 1")
      // Hosted failure: no failed hold on the shared dashboard (the goal loop
      // holds it, not this run) and the dashboard is never stopped.
      expect(dashboard.events).not.toContain("runFinished:failed")
      expect(dashboard.events).not.toContain("runFinished:completed")
      expect(dashboard.events).not.toContain("stop")
      // The abort handler is still cleared on the way out.
      expect(dashboard.events).toContain("clearAbortHandler")

      // The finally no longer closes the server/lease: that teardown rides on
      // the thrown error, tagged with the run dir the failed screen needs.
      const teardown = hostedTeardownFromError(failure)
      expect(teardown).toBeDefined()
      if (!teardown) return
      expect(teardown.runDir).not.toBe("")
      const metadata = JSON.parse(await readFile(join(teardown.runDir, "metadata.json"), "utf8"))
      expect(metadata.server).toBeDefined()

      await teardown.release()
      const after = JSON.parse(await readFile(join(teardown.runDir, "metadata.json"), "utf8"))
      expect(after.server).toBeUndefined()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("without a hosted progress the run still completes and owns its teardown", async () => {
    const repo = await cleanRepo()
    try {
      const result = await run(makeOptions(repo))
      expect(result.release).toBeUndefined()
      // A normal run closes its own server entry during cleanup.
      const metadata = JSON.parse(await readFile(join(result.dir, "metadata.json"), "utf8"))
      expect(metadata.server).toBeUndefined()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("failure post-hooks omit cost and tokens when no phase recorded usage", async () => {
    const repo = await cleanRepo()
    try {
      let failure: unknown
      try {
        await run(makeOptions(repo, {
          hooks: {
            pre: [{ name: "fail-before-session", command: "exit 1" }],
            post: [{ name: "record-usage", when: "always", command: 'printf "%s:%s:%s:%s" "$CONVOY_RUN_STATUS" "${CONVOY_RUN_COST-unset}" "${CONVOY_RUN_TOKENS_TOTAL-unset}" "$CONVOY_RUN_DURATION_MS" > hook-usage.out' }],
            pipelines: {},
          },
        }))
      } catch (error) {
        failure = error
      }
      expect(String(failure)).toContain("exited with code 1")
      const values = (await readFile(join(repo, "hook-usage.out"), "utf8")).split(":")
      expect(values.slice(0, 3)).toEqual(["failure", "unset", "unset"])
      expect(values[3]).toMatch(/^\d+$/)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("a hosted askPermission is honoured without a TTY — the run never auto-rejects it", async () => {
    const repo = await cleanRepo()
    // A coordinated run has no TTY on the coordinator: "interactive" there
    // means "a controller can answer", i.e. progress.askPermission exists.
    // Force the no-TTY world for the whole run window and prove the hosted
    // prompt is asked and its reply forwarded, not auto-rejected.
    const stdinTty = process.stdin.isTTY
    const stdoutTty = process.stdout.isTTY
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true })

    const asked: PermissionPromptInfo[] = []
    const replies: Array<{ reply: string }> = []
    let resolveAsk!: (reply: PermissionReply) => void
    const open = new Promise<PermissionReply>((resolve) => {
      resolveAsk = resolve
    })

    const permissionClient = {
      ...fakeClient,
      event: {
        subscribe: async () => ({
          stream: (async function* () {
            yield {
              type: "permission.asked",
              properties: { id: "perm-hosted", sessionID: "sess-hosted", permission: "bash", patterns: ["bash"], metadata: { command: "ls -la" }, always: [] },
            }
          })(),
        }),
      },
      permission: {
        reply: async ({ reply }: { reply: string }) => {
          replies.push({ reply })
          return { data: undefined, error: undefined }
        },
      },
    }
    const gatedStart: RunDeps["startOpencode"] = async () => ({
      client: permissionClient as never,
      url: "http://127.0.0.1:41235",
      close: () => {},
    })

    const progress: ProgressUI = {
      ...noopProgress,
      askPermission: (info) => {
        asked.push(info)
        return open
      },
    }

    try {
      // The pre-hook keeps the run (and its permission gate) alive long enough
      // for the event pump to deliver permission.asked before teardown.
      const promise = realRun(
        makeOptions(repo, {
          progress,
          hooks: { pre: [{ name: "hold-gate-open", command: "sleep 0.3" }], post: [], pipelines: {} },
        }),
        { startOpencode: gatedStart },
      )

      const deadline = Date.now() + 5_000
      while (asked.length === 0 && Date.now() < deadline) await Bun.sleep(10)
      expect(asked).toMatchObject([{ id: "perm-hosted", permission: "bash", patterns: ["bash"] }])
      // Nothing auto-rejected while the controller had not answered.
      expect(replies).toEqual([])

      // The controller answers; the gate forwards the reply to OpenCode.
      resolveAsk("once")
      const replied = Date.now() + 5_000
      while (replies.length === 0 && Date.now() < replied) await Bun.sleep(10)
      expect(replies).toEqual([{ reply: "once" }])

      await promise
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: stdinTty, configurable: true })
      Object.defineProperty(process.stdout, "isTTY", { value: stdoutTty, configurable: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("a nitro run injects throughput routing into its own OpenCode config", async () => {
    const repo = await cleanRepo()
    // Capture the config the runner hands the (fake) opencode server; the phase
    // itself then fails on the fake client's missing session API, which is fine
    // — the injection happens at server start, before any phase runs.
    let captured: Awaited<Parameters<RunDeps["startOpencode"]>[0]> | undefined
    const capturingStart: RunDeps["startOpencode"] = async (config) => {
      captured = config
      return { client: fakeClient as never, url: "http://127.0.0.1:41235", close: () => {} }
    }
    try {
      const options = makeOptions(repo, {
        gateway: "nitro",
        pipeline: {
          name: "nitro-test",
          steps: [
            {
              type: "agent",
              name: "scope",
              stepName: "scope",
              groupId: "g1",
              agentName: "review-scope",
              description: "Scope",
              model: "zai/glm-5.2#high",
              inputFiles: ["prd.md"],
              inputDiff: false,
              reportPath: "reports/scope.md",
            },
          ],
        },
      })
      try {
        await realRun({ ...options, plan: buildRunPlan(options) }, { startOpencode: capturingStart })
      } catch {
        // Expected: the fake client cannot run the phase.
      }

      expect(captured?.provider?.openrouter?.models?.["z-ai/glm-5.2"]).toEqual({
        options: { provider: { sort: "throughput" } },
      })
      // The provider-level timeout settings still ride along.
      expect(captured?.provider?.openrouter?.options?.timeout).toBe(false)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("a non-nitro run leaves the OpenCode config free of throughput routing", async () => {
    const repo = await cleanRepo()
    let captured: Awaited<Parameters<RunDeps["startOpencode"]>[0]> | undefined
    const capturingStart: RunDeps["startOpencode"] = async (config) => {
      captured = config
      return { client: fakeClient as never, url: "http://127.0.0.1:41236", close: () => {} }
    }
    try {
      const options = makeOptions(repo, {
        gateway: "openrouter",
        pipeline: {
          name: "openrouter-test",
          steps: [
            {
              type: "agent",
              name: "scope",
              stepName: "scope",
              groupId: "g1",
              agentName: "review-scope",
              description: "Scope",
              model: "zai/glm-5.2#high",
              inputFiles: ["prd.md"],
              inputDiff: false,
              reportPath: "reports/scope.md",
            },
          ],
        },
      })
      try {
        await realRun({ ...options, plan: buildRunPlan(options) }, { startOpencode: capturingStart })
      } catch {
        // Expected: the fake client cannot run the phase.
      }

      expect(Object.keys(captured?.provider?.openrouter?.models ?? {})).toEqual([])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("records fresh prompts in the target checkout and skips the duplicate on resume", async () => {
    const repo = await cleanRepo()
    try {
      const first = await run(makeOptions(repo, { prompt: "original PRD" }))
      const history = prdHistoryDir(repo)
      const entries = await readPrdHistoryIndex(repo)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ runID: first.runID, pipeline: "hosted-test" })
      expect(await readFile(join(history, `${first.runID}.prd.md`), "utf8")).toBe("original PRD")

      await run(makeOptions(repo, { prompt: "disabled PRD", prdHistory: false }))
      expect(await readPrdHistoryIndex(repo)).toHaveLength(1)

      await run(makeOptions(repo, { prompt: "", resumeRunID: first.runID }))
      expect(await readPrdHistoryIndex(repo)).toHaveLength(1)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("writes a worktree run's history in the new worktree, not the launch checkout", async () => {
    const launchRepo = await cleanRepo()
    let isolated: RunOptions | undefined
    try {
      isolated = await prepareWorktreeForRun(
        launchRepo,
        makeOptions(launchRepo, { prompt: "worktree PRD", worktree: true, branch: "feat/prd-history-location" }),
      )
      expect(isolated.targetDir).not.toBe(launchRepo)

      const result = await run(isolated)
      expect(await readPrdHistoryIndex(isolated.targetDir)).toEqual([
        expect.objectContaining({ runID: result.runID, file: `${result.runID}.prd.md`, pipeline: "hosted-test" }),
      ])
      expect(existsSync(join(isolated.targetDir, ".convoy", "prd-history", `${result.runID}.prd.md`))).toBe(true)
      expect(existsSync(join(launchRepo, ".convoy", "prd-history", "index.jsonl"))).toBe(false)
    } finally {
      if (isolated) await git(["worktree", "remove", "--", isolated.targetDir], launchRepo)
      await rm(launchRepo, { recursive: true, force: true })
    }
  })

  test("attaches only the oldest historical PRD for an opted-in scope step", async () => {
    const repo = await cleanRepo()
    const workspace = await mkdtemp(join(tmpdir(), "convoy-history-phase-"))
    const phase = {
      type: "agent" as const,
      name: "scope",
      stepName: "scope",
      groupId: "g1",
      agentName: "review-scope",
      description: "scope",
      model: "openai/gpt-5.6-terra",
      inputFiles: [],
      inputDiff: false,
      reportPath: "reports/scope.md",
      readOnly: true,
      prdHistory: true,
    }
    try {
      const branch = (await git(["branch", "--show-current"], repo)).trim()
      await writePrdHistory({ targetDir: repo, runID: "original", prompt: "original PRD", pipeline: "implement", branch })
      await writePrdHistory({ targetDir: repo, runID: "current", prompt: "review request", pipeline: "review", branch })

      const prepared = await preparePhaseRun({ dir: workspace, runID: "current" }, phase, makeOptions(repo), [], [])
      expect(prepared.attachments).toHaveLength(1)
      expect(prepared.attachments[0]).toMatchObject({ filename: "original.prd.md" })
      expect(prepared.attachments[0]?.url).toStartWith("file:///")
      expect(prepared.attachments[0]?.url).toContain(".convoy/prd-history/original.prd.md")
      expect((await preparePhaseRun({ dir: workspace, runID: "current" }, phase, makeOptions(repo, { prdHistory: false }), [], [])).attachments).toEqual([])

      await rm(join(prdHistoryDir(repo), "index.jsonl"))
      await mkdir(join(prdHistoryDir(repo), "index.jsonl"))
      expect((await preparePhaseRun({ dir: workspace, runID: "current" }, phase, makeOptions(repo), [], [])).attachments).toEqual([])
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("attaches the OpenSpec spec bundle instead of the historical PRD when a change resolved", async () => {
    const repo = await cleanRepo()
    const workspace = await mkdtemp(join(tmpdir(), "convoy-openspec-phase-"))
    const phase = {
      type: "agent" as const,
      name: "scope",
      stepName: "scope",
      groupId: "g1",
      agentName: "review-scope",
      description: "scope",
      model: "openai/gpt-5.6-terra",
      inputFiles: [],
      inputDiff: false,
      reportPath: "reports/scope.md",
      readOnly: true,
      prdHistory: true,
    }
    try {
      await writePrdHistory({ targetDir: repo, runID: "original", prompt: "original PRD", pipeline: "implement", branch: "main" })
      await mkdir(join(repo, "openspec", "changes", "add-login", "specs", "auth"), { recursive: true })
      await mkdir(join(repo, "openspec", "specs", "auth"), { recursive: true })
      await writeFile(join(repo, "openspec", "changes", "add-login", "proposal.md"), "# Add Login\n")
      await writeFile(join(repo, "openspec", "changes", "add-login", "specs", "auth", "spec.md"), "## ADDED Scenarios\n")
      await writeFile(join(repo, "openspec", "specs", "auth", "spec.md"), "# Auth spec\n")

      const bundle = await loadOpenSpecBundle({ targetDir: repo, explicitIds: ["add-login"] })
      expect(bundle).toBeDefined()
      const options = makeOptions(repo)
      const plan = buildRunPlan({ ...options, openspec: bundle!, promptSource: "inline" })
      const prepared = await preparePhaseRun({ dir: workspace, runID: "current" }, phase, { ...options, plan }, [], [])

      const filenames = prepared.attachments.map((part) => part.filename)
      expect(filenames).toContain("proposal.md")
      expect(filenames).toContain("spec.md")
      // The bundle supersedes the checkout's historical PRD.
      expect(filenames).not.toContain("original.prd.md")
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("never attaches the spec bundle from the launch checkout when the run's checkout lacks it (CC-6)", async () => {
    // Delta run-launcher: the execution checkout is the only artifact source.
    // A change that exists only in the launch checkout is disclosed as
    // missing, never borrowed across checkouts.
    const launch = await cleanRepo()
    const isolated = await cleanRepo()
    const workspace = await mkdtemp(join(tmpdir(), "convoy-openspec-fallback-"))
    const phase = {
      type: "agent" as const,
      name: "scope",
      stepName: "scope",
      groupId: "g1",
      agentName: "review-scope",
      description: "scope",
      model: "openai/gpt-5.6-terra",
      inputFiles: [],
      inputDiff: false,
      reportPath: "reports/scope.md",
      readOnly: true,
      prdHistory: true,
    }
    try {
      await mkdir(join(launch, "openspec", "changes", "add-login"), { recursive: true })
      await writeFile(join(launch, "openspec", "changes", "add-login", "proposal.md"), "# Add Login\n")

      const bundle = await loadOpenSpecBundle({ targetDir: launch })
      expect(bundle).toBeDefined()
      expect(bundle!.rootDir).toBe(launch)
      // The run executes in a checkout that does not carry the change files.
      const options = makeOptions(isolated)
      const plan = buildRunPlan({ ...options, openspec: bundle!, promptSource: "inline" })
      const prepared = await preparePhaseRun({ dir: workspace, runID: "current" }, phase, { ...options, plan }, [], [])

      const filenames = prepared.attachments.map((part) => part.filename)
      // The launch checkout's copy was NOT attached: the missing selected
      // source is skipped with a warning, never substituted.
      expect(filenames).not.toContain("proposal.md")
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(launch, { recursive: true, force: true })
      await rm(isolated, { recursive: true, force: true })
    }
  })

  test("attaches the OpenSpec spec bundle to implement steps that have no prdHistory flag", async () => {
    const repo = await cleanRepo()
    const workspace = await mkdtemp(join(tmpdir(), "convoy-openspec-implement-"))
    const phase = {
      type: "agent" as const,
      name: "implementer",
      stepName: "implementer",
      groupId: "g1",
      agentName: "implementer",
      description: "implement",
      model: "openai/gpt-5.6-terra",
      inputFiles: [],
      inputDiff: false,
      reportPath: "reports/implementer.md",
    }
    try {
      await mkdir(join(repo, "openspec", "changes", "add-login"), { recursive: true })
      await mkdir(join(repo, "openspec", "specs", "auth"), { recursive: true })
      await writeFile(join(repo, "openspec", "changes", "add-login", "proposal.md"), "# Add Login\n")
      await writeFile(join(repo, "openspec", "changes", "add-login", "design.md"), "# Design\n")
      await writeFile(join(repo, "openspec", "changes", "add-login", "tasks.md"), "# Tasks\n")
      await writeFile(join(repo, "openspec", "specs", "auth", "spec.md"), "# Auth spec\n")

      const bundle = await loadOpenSpecBundle({ targetDir: repo, explicitIds: ["add-login"] })
      const options = makeOptions(repo)
      const plan = buildRunPlan({ ...options, openspec: bundle!, promptSource: "inline" })
      const prepared = await preparePhaseRun({ dir: workspace, runID: "current" }, phase, { ...options, plan }, [], [])

      const filenames = prepared.attachments.map((part) => part.filename)
      expect(filenames).toContain("proposal.md")
      expect(filenames).toContain("design.md")
      expect(filenames).toContain("tasks.md")
      expect(filenames).toContain("spec.md")
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  // SC-4: A primitive thrown value (string, number, …) cannot key the WeakMap
  // the goal loop fetches the hosted teardown from. The runner wraps it in an
  // Error before storing, so the teardown survives any thrown value.
  test("SC-4: a primitive thrown by startOpencode is wrapped so the teardown is preserved", async () => {
    const repo = await cleanRepo()
    const dashboard: ProgressUI = { ...noopProgress }
    try {
      throwPrimitiveFromStart = true
      let failure: unknown
      try {
        await run(makeOptions(repo, { progress: dashboard }))
        throw new Error("the run should have rejected")
      } catch (error) {
        failure = error
      }

      // The primitive was wrapped in an Error (not the raw string).
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toBe("primitive boom")

      // The wrapped error can key the WeakMap, so the teardown is recoverable.
      // Without the SC-4 wrap, hostedTeardownFromError would return undefined
      // because a string cannot key a WeakMap.
      const teardown = hostedTeardownFromError(failure)
      expect(teardown).toBeDefined()
      if (!teardown) return
      expect(teardown.runDir).not.toBe("")
      // The release closure runs without throwing — it releases the lease
      // and flushes metadata.
      await teardown.release()
    } finally {
      throwPrimitiveFromStart = false
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("drives the embedded goal cycle through run() with correctly wired deps", async () => {
    const repo = await cleanRepo()
    const dashboard = fakeDashboard()
    // A goal pipeline whose fragments are empty: the scheduler still runs
    // measure(0), which produces no authoritative score, so the cycle settles
    // as no-score. This exercises the full run() → runGoalCycle wiring — the
    // live view through the hosted progress, the durable checkpoint, and the
    // score read — without needing a real agent session.
    const goalPipeline: RunOptions["pipeline"] = {
      name: "goal-run",
      steps: [],
      goalPlan: {
        target: 90,
        maxIterations: 3,
        plateau: 3,
        briefRecipient: "fix",
        improve: { steps: [] },
        measure: { steps: [] },
        scoreProducer: "score-report",
      },
    }
    try {
      const result = await run(makeOptions(repo, { pipeline: goalPipeline, progress: dashboard.progress }))
      try {
        // The scheduler published the live goal view through the hosted progress.
        expect(dashboard.events).toContain("setGoalLoop")
        expect(dashboard.events).toContain("resetPipeline")
        // The durable goal record was checkpointed with the settled outcome.
        const metadata = JSON.parse(await readFile(join(result.dir, "metadata.json"), "utf8"))
        expect(metadata.goal).toMatchObject({ target: 90, outcome: "no-score" })
        // No consensus step exists, so the run carries no quality score.
        expect(result.qualityScore).toBeUndefined()
      } finally {
        await result.release?.()
      }
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe("automatic run finalization lifecycle", () => {
  // Records only the terminal `Compact run` lifecycle row the runner emits
  // (task 3.1/3.3/3.5): the row is separate from configurable steps, cannot be
  // filtered, and its outcome is persisted independently of pipeline success.
  function finalizationTrackingProgress() {
    const finalizationEvents: string[] = []
    const progress: ProgressUI = {
      ...noopProgress,
      phaseStarted: (name, detail) => {
        if (name === compactRunRowName) finalizationEvents.push(`started${detail ? `:${detail}` : ""}`)
      },
      phaseCompleted: (name, detail) => {
        if (name === compactRunRowName) finalizationEvents.push(`completed${detail ? `:${detail}` : ""}`)
      },
      phaseSkipped: (name) => {
        if (name === compactRunRowName) finalizationEvents.push("skipped")
      },
      phaseFailed: (name, detail) => {
        if (name === compactRunRowName) finalizationEvents.push(`failed${detail ? `:${detail}` : ""}`)
      },
    }
    return { progress, finalizationEvents }
  }

  // The runner emits the lifecycle row through the persisted-progress adapter
  // (`recordProgress`), whose phase calls are awaited internally but not by
  // run() itself, so the events can land a tick after run() resolves.
  async function waitForEvents(events: string[], count: number, timeoutMs = 5_000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs
    while (events.length < count && Date.now() < deadline) await Bun.sleep(10)
    return events
  }

  test("a successful run records the Compact run lifecycle row as skipped and persists its summary section", async () => {
    // A pipeline that creates no commits still gets the lifecycle row exactly
    // once, after its phases and success hooks, and the durable outcome says
    // skipped (not a hidden block).
    const repo = await cleanRepo()
    const tracking = finalizationTrackingProgress()
    try {
      const result = await run(makeOptions(repo, { progress: tracking.progress }))
      try {
        expect(await waitForEvents(tracking.finalizationEvents, 2)).toEqual(["started:compacting this run's commits", "skipped"])

        const metadata = JSON.parse(await readFile(join(result.dir, "metadata.json"), "utf8"))
        expect(metadata.finalization).toMatchObject({ state: "skipped" })
        expect(metadata.finalization.reason).toContain("no commits")

        // The durable summary carries the same fact.
        const summary = await readFile(join(result.dir, "SUMMARY.md"), "utf8")
        expect(summary).toContain("## Run finalization")
        expect(summary).toContain("- State: skipped")

        // The skip is honest: the execution tree is clean, so the zero-commit
        // verdict is not a silent block on uncommitted changes.
        expect((await git(["status", "--porcelain"], repo)).trim()).toBe("")
      } finally {
        await result.release?.()
      }
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("a success post-hook that mutates the repository blocks compaction but keeps the run successful", async () => {
    // Design D1 ordering: finalization runs after success hooks, so a hook
    // that mutates/publishes the tree must make the compaction refuse (the
    // dirty-tree guard fires before any rewrite) without failing the run.
    const repo = await cleanRepo()
    const tracking = finalizationTrackingProgress()
    try {
      const result = await run(
        makeOptions(repo, {
          progress: tracking.progress,
          hooks: { pre: [], post: [{ name: "publish-artifact", command: "printf 'hook\n' >> hook.txt" }], pipelines: {} },
        }),
      )
      try {
        expect((await waitForEvents(tracking.finalizationEvents, 1))[0]).toBe("started:compacting this run's commits")

        const metadata = JSON.parse(await readFile(join(result.dir, "metadata.json"), "utf8"))
        // Blocked (not skipped): the hook left an uncommitted change, and the
        // lifecycle row must not present that as a clean no-commit skip.
        expect(metadata.finalization).toMatchObject({ state: "blocked" })
        expect(metadata.finalization.reason).toMatch(/uncommitted changes|working tree/)

        const summary = await readFile(join(result.dir, "SUMMARY.md"), "utf8")
        expect(summary).toContain("## Run finalization")
        expect(summary).toContain("- State: blocked")

        // The run itself remained successful despite the blocked compaction.
        expect(result.dir).toBeTruthy()
      } finally {
        await result.release?.()
      }
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("a failing run never reaches finalization and persists no compaction outcome", async () => {
    // A fatal success-hook failure must still count as failed execution and
    // must prevent automatic compaction entirely (design D1).
    const repo = await cleanRepo()
    const tracking = finalizationTrackingProgress()
    try {
      let failure: unknown
      try {
        await run(
          makeOptions(repo, {
            progress: tracking.progress,
            hooks: { pre: [], post: [{ name: "boom", command: "exit 1" }], pipelines: {} },
          }),
        )
        throw new Error("the failing run should have rejected")
      } catch (error) {
        failure = error
      }
      expect(String(failure)).toContain("exited with code 1")
      expect(tracking.finalizationEvents).toEqual([])

      const teardown = hostedTeardownFromError(failure)
      expect(teardown).toBeDefined()
      if (!teardown) return
      expect(teardown.runDir).not.toBe("")
      const metadata = JSON.parse(await readFile(join(teardown.runDir, "metadata.json"), "utf8"))
      expect(metadata.finalization).toBeUndefined()
      await teardown.release()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
