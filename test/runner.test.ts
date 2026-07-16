import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { openRunMetadata, type RunMetadataStore } from "../src/metadata"
import { createCleanRepoSnapshot } from "../src/git"
import { noopProgress, type HumanReviewAction, type HumanReviewPromptInfo, type ProgressPhaseSnapshot, type ProgressUI } from "../src/progress"
import {
  assertPendingReadOnlyResumeBaselines,
  RunShutdown,
  UserAbortError,
  waitForInteractiveGate,
  commitRecoveredPhase,
  createGitLock,
  describeMessageChunk,
  describeSessionActivity,
  finalizePhaseRepository,
  isIgnorableRejection,
  isUserAbortError,
  newActivityState,
  modelOverrideNotice,
  parseModel,
  planBatches,
  progressPhases,
  restorePhaseFromPreviousRun,
  selectInterruptedPhase,
  shouldRetryAttempt,
  shouldSkip,
  withReadOnlyRepositoryBoundary,
  type ActiveSession,
} from "../src/runner"
import type { AgentStep, HumanStep, Pipeline, Step } from "../src/types"
import type { Workspace } from "../src/workspace"

const recoveryDirs: string[] = []

afterAll(async () => {
  await Promise.all(recoveryDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function git(args: string[], cwd: string) {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`)
  return out
}

async function dirtyRepo(): Promise<string> {
  const dir = await cleanRepo()
  // leave an uncommitted change behind, as an interrupted phase would
  await writeFile(join(dir, "feature.txt"), "work in progress\n")
  return dir
}

async function cleanRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-recover-repo-"))
  recoveryDirs.push(dir)
  await git(["init", "-q"], dir)
  await writeFile(join(dir, "keep.txt"), "base\n")
  await git(["add", "-A"], dir)
  await git(["commit", "-qm", "base"], dir)
  return dir
}

function agentStep(name: string): AgentStep {
  return {
    type: "agent",
    name,
    agentName: name,
    description: name,
    model: "openai/gpt-5.5",
    inputFiles: [],
    inputDiff: false,
    reportPath: `reports/${name}.md`,
    groupId: `g-${name}`,
    stepName: name,
  }
}

function messageUpdated(info: Record<string, unknown>) {
  return { type: "message.updated", properties: { sessionID: "ses_1", info } }
}

function assistantInfo(id: string, cost: number, input: number, output: number) {
  return {
    id,
    sessionID: "ses_1",
    role: "assistant",
    cost,
    tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
    providerID: "openai",
    modelID: "gpt-5.5",
    variant: "xhigh",
  }
}

describe("runner helpers", () => {
  test("parses provider/model values", () => {
    expect(parseModel("anthropic/claude-sonnet-4-6")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6",
    })
    expect(parseModel("custom/provider/model")).toEqual({ providerID: "custom", modelID: "provider/model" })
    expect(() => parseModel("claude-sonnet-4-6")).toThrow("invalid model")
  })

  test("applies only and skip phase filters", () => {
    expect(shouldSkip(agentStep("security"), { onlySteps: ["implementer"], skipSteps: [] })).toBe(true)
    expect(shouldSkip(agentStep("implementer"), { onlySteps: ["implementer"], skipSteps: ["implementer"] })).toBe(false)
    expect(shouldSkip(agentStep("design"), { onlySteps: [], skipSteps: ["design"] })).toBe(true)
    expect(shouldSkip(agentStep("tests"), { onlySteps: [], skipSteps: [] })).toBe(false)
  })

  test("only/skip also match a fanned-out step's shared stepName", () => {
    const variant = { ...agentStep("clean-code__anthropic-claude-opus-4-7"), stepName: "clean-code" }
    expect(shouldSkip(variant, { onlySteps: ["clean-code"], skipSteps: [] })).toBe(false)
    expect(shouldSkip(variant, { onlySteps: ["some-other-step"], skipSteps: [] })).toBe(true)
    expect(shouldSkip(variant, { onlySteps: [], skipSteps: ["clean-code"] })).toBe(true)
  })

  test("explains which runner steps a global model override cannot affect", () => {
    const claude = { ...agentStep("security-claude"), runner: "claude-code" as const, model: "opus", readOnly: true }
    const pipeline: Pipeline = { name: "review", steps: [agentStep("security-gpt"), claude] }

    expect(modelOverrideNotice(pipeline, "openai/gpt-5.6#xhigh")).toBe(
      "--model applies to OpenCode steps only; Claude Code steps keep their configured model: security-claude",
    )
    expect(modelOverrideNotice(pipeline, "")).toBeUndefined()
    expect(modelOverrideNotice({ name: "review", steps: [agentStep("security-gpt")] }, "openai/gpt-5.6")).toBeUndefined()
  })

  test("progress phases expose runner labels and read-only state", () => {
    const claude = { ...agentStep("security-claude"), runner: "claude-code" as const, model: "opus", readOnly: true }
    const [phase] = progressPhases({ name: "review", steps: [claude] })

    expect(phase).toMatchObject({ runner: "claude-code", plannedModel: "claude-code/opus", readOnly: true })
  })

  test("turns assistant message updates into live cumulative usage", () => {
    const state = newActivityState()

    // Creation update carries no usage yet; it must not claim the total.
    expect(describeSessionActivity(messageUpdated(assistantInfo("msg_1", 0, 0, 0)), state)).toBeUndefined()

    const first = describeSessionActivity(messageUpdated(assistantInfo("msg_1", 0.02, 1_000, 200)), state)
    expect(first).toEqual({
      type: "usage",
      usage: {
        cost: 0.02,
        tokens: { input: 1_000, output: 200, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_200 },
        sessionID: "ses_1",
        model: "openai/gpt-5.5#xhigh",
      },
    })

    // Same totals again: deduplicated so the UI isn't re-rendered for nothing.
    expect(describeSessionActivity(messageUpdated(assistantInfo("msg_1", 0.02, 1_000, 200)), state)).toBeUndefined()

    // A second message accumulates on top of the first.
    const second = describeSessionActivity(messageUpdated(assistantInfo("msg_2", 0.01, 500, 100)), state)
    expect(second?.type).toBe("usage")
    if (second?.type === "usage") {
      expect(second.usage.cost).toBeCloseTo(0.03)
      expect(second.usage.tokens?.input).toBe(1_500)
      expect(second.usage.tokens?.output).toBe(300)
    }

    // User messages never carry usage.
    expect(describeSessionActivity(messageUpdated({ id: "msg_3", role: "user" }), state)).toBeUndefined()
  })

  test("marks provider heartbeats and streaming deltas as feed-exempt pulses", () => {
    const state = newActivityState()

    const busy = describeSessionActivity({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } }, state)
    expect(busy).toMatchObject({ type: "activity", message: "provider busy", pulse: true })

    const streaming = describeSessionActivity({ type: "message.part.delta", properties: { sessionID: "ses_1", field: "text" } }, state)
    expect(streaming).toMatchObject({ type: "activity", message: "streaming text", pulse: true })

    const tool = describeSessionActivity({ type: "session.next.tool.called", properties: { sessionID: "ses_1", tool: "bash" } }, state)
    expect(tool).toMatchObject({ type: "activity", message: "bash" })
    expect((tool as { pulse?: boolean }).pulse).toBeUndefined()
  })

  test("extracts the verbatim model stream for the session transcript", () => {
    const props = (properties: Record<string, unknown>) => properties

    // Reasoning and response deltas come through untouched, tagged by channel —
    // and uncapped, unlike the 220-char pickString the activity path uses.
    const long = "x".repeat(500)
    expect(describeMessageChunk({ type: "session.next.reasoning.delta", properties: props({ delta: "let me check " }) })).toEqual({
      channel: "reasoning",
      text: "let me check ",
    })
    expect(describeMessageChunk({ type: "session.next.text.delta", properties: props({ delta: long }) })).toEqual({
      channel: "response",
      text: long,
    })

    // Tool calls and shell commands become one-line action markers.
    expect(describeMessageChunk({ type: "session.next.tool.called", properties: props({ tool: "read", input: { filePath: "src/x.ts" } }) })).toEqual({
      channel: "tool",
      text: "read: src/x.ts",
    })
    expect(describeMessageChunk({ type: "session.next.shell.started", properties: props({ command: "bun test" }) })).toEqual({
      channel: "bash",
      text: "bun test",
    })

    // Current opencode streams text through message.part.delta. If no part
    // metadata has arrived yet, show it as response text rather than leaving
    // the session tab blank.
    const state = newActivityState()
    expect(describeMessageChunk({ type: "message.part.delta", properties: props({ field: "text", partID: "part_1", delta: "hello" }) }, state)).toEqual({
      channel: "response",
      text: "hello",
    })

    // message.part.updated teaches the transcript whether later deltas belong
    // to reasoning or response content.
    expect(describeMessageChunk({ type: "message.part.updated", properties: props({ part: { id: "part_2", type: "reasoning" } }) }, state)).toBeUndefined()
    expect(describeMessageChunk({ type: "message.part.delta", properties: props({ field: "text", partID: "part_2", delta: "thinking" }) }, state)).toEqual({
      channel: "reasoning",
      text: "thinking",
    })

    // Empty deltas and everything else (usage, todos, heartbeats) are not
    // transcript content.
    expect(describeMessageChunk({ type: "session.next.text.delta", properties: props({ delta: "" }) })).toBeUndefined()
    expect(describeMessageChunk({ type: "message.part.delta", properties: props({ field: "metadata", partID: "part_1", delta: "ignored" }) }, state)).toBeUndefined()
    expect(describeMessageChunk({ type: "session.status", properties: props({ status: { type: "busy" } }) })).toBeUndefined()
  })

  test("restores on resume only when the phase didn't fail", async () => {
    const phase = { name: "design", reportPath: "reports/design.md" } as AgentStep

    const workspaceWith = async (report: boolean) => {
      const dir = await mkdtemp(join(tmpdir(), "convoy-resume-"))
      if (report) {
        await mkdir(join(dir, "reports"), { recursive: true })
        await writeFile(join(dir, "reports", "design.md"), "# stale report")
      }
      return { dir, runID: "20260101-000000-test" } as Workspace
    }
    const metadataWith = (snapshot?: ProgressPhaseSnapshot) => ({ snapshot: () => snapshot }) as unknown as RunMetadataStore
    const progressSpy = () => {
      const calls: string[] = []
      return {
        calls,
        progress: {
          ...noopProgress,
          phaseRestored: () => void calls.push("restored"),
          phaseCompleted: () => void calls.push("completed"),
        },
      }
    }

    // No report: nothing to restore.
    const bare = await workspaceWith(false)
    expect(await restorePhaseFromPreviousRun(bare, metadataWith({ status: "completed" }), phase, noopProgress)).toBe(false)

    // Failed phase: retry, and the stale report must be gone.
    const failed = await workspaceWith(true)
    expect(await restorePhaseFromPreviousRun(failed, metadataWith({ status: "failed" }), phase, noopProgress)).toBe(false)
    expect(await Bun.file(join(failed.dir, "reports", "design.md")).exists()).toBe(false)

    // Completed phase: restored with its snapshot.
    const completed = await workspaceWith(true)
    const restoredSpy = progressSpy()
    expect(await restorePhaseFromPreviousRun(completed, metadataWith({ status: "completed" }), phase, restoredSpy.progress)).toBe(true)
    expect(restoredSpy.calls).toEqual(["restored"])

    // Pre-metadata run: the report alone still counts as completed.
    const legacy = await workspaceWith(true)
    const legacySpy = progressSpy()
    expect(await restorePhaseFromPreviousRun(legacy, metadataWith(undefined), phase, legacySpy.progress)).toBe(true)
    expect(legacySpy.calls).toEqual(["completed"])
  })

  test("does not retry after user abort", () => {
    const controller = new AbortController()
    expect(shouldRetryAttempt(new Error("temporary"), controller.signal, 1, 2)).toBe(true)

    controller.abort(new UserAbortError())
    expect(shouldRetryAttempt(new Error("aborted fetch"), controller.signal, 1, 2)).toBe(false)
    expect(shouldRetryAttempt(new UserAbortError(), new AbortController().signal, 1, 2)).toBe(false)
    expect(shouldRetryAttempt(new Error("exhausted"), new AbortController().signal, 2, 2)).toBe(false)
  })

  test("only the benign SSE abort is ignorable; real faults must surface", () => {
    // The known-benign cases swallowed at the process level.
    expect(isIgnorableRejection(new UserAbortError())).toBe(true)
    const abortError = new Error("The operation was aborted")
    abortError.name = "AbortError"
    expect(isIgnorableRejection(abortError)).toBe(true)
    expect(isIgnorableRejection(new Error("request was aborted"))).toBe(true)

    // Everything else is a real fault and stays visible.
    expect(isIgnorableRejection(new Error("Cannot read properties of undefined"))).toBe(false)
    expect(isIgnorableRejection(new TypeError("boom"))).toBe(false)
    expect(isIgnorableRejection("aborted")).toBe(false)
    expect(isIgnorableRejection(undefined)).toBe(false)
  })
})

describe("planBatches", () => {
  const human = (name: string): HumanStep => ({ type: "human", name, description: name })

  test("sequential steps and human gates are each their own batch", () => {
    const steps: Step[] = [agentStep("implementer"), human("human-review"), agentStep("tests")]
    expect(planBatches(steps)).toEqual([[steps[0]], [steps[1]], [steps[2]]])
  })

  test("consecutive agent steps sharing a groupId batch together", () => {
    const patterns = { ...agentStep("patterns"), groupId: "g2" }
    const security = { ...agentStep("security"), groupId: "g2" }
    const steps: Step[] = [agentStep("implementer"), patterns, security, agentStep("triage")]
    expect(planBatches(steps)).toEqual([[steps[0]], [patterns, security], [steps[3]]])
  })

  test("a groupId doesn't merge across a human gate between them", () => {
    const before = { ...agentStep("a"), groupId: "shared" }
    const after = { ...agentStep("b"), groupId: "shared" }
    const steps: Step[] = [before, human("human-review"), after]
    expect(planBatches(steps)).toEqual([[before], [human("human-review")], [after]])
  })

  test("consecutive agent steps with an undefined groupId never batch together", () => {
    // Legacy metadata.json from before groupId existed (schemaVersion 1-2)
    // loads steps missing the field entirely; guard against undefined === undefined.
    const a = { ...agentStep("a"), groupId: undefined } as unknown as AgentStep
    const b = { ...agentStep("b"), groupId: undefined } as unknown as AgentStep
    const steps: Step[] = [a, b]
    expect(planBatches(steps)).toEqual([[a], [b]])
  })
})

describe("RunShutdown multi-session tracking", () => {
  function fakeSession(phaseName: string, sessionID: string, aborted: string[]): ActiveSession {
    return {
      sessionID,
      directory: "/tmp/target",
      phaseName,
      client: {
        session: {
          abort: async ({ sessionID }: { sessionID: string; directory: string }) => {
            aborted.push(sessionID)
            return { error: undefined }
          },
        },
      } as unknown as ActiveSession["client"],
    }
  }

  test("tracks one active session per phase independently", () => {
    const shutdown = new RunShutdown()
    const aborted: string[] = []
    shutdown.setActiveSession(fakeSession("patterns", "ses_1", aborted))
    shutdown.setActiveSession(fakeSession("security", "ses_2", aborted))

    // Clearing one phase's session doesn't touch the other's.
    shutdown.clearActiveSession("patterns", "ses_1")
    shutdown.clearActiveSession("security", "ses_wrong-id")
    return shutdown.abortActiveSessions().then(() => {
      expect(aborted).toEqual(["ses_2"])
    })
  })

  test("abortActiveSessions aborts every currently-tracked session", async () => {
    const shutdown = new RunShutdown()
    const aborted: string[] = []
    shutdown.setActiveSession(fakeSession("patterns", "ses_1", aborted))
    shutdown.setActiveSession(fakeSession("security", "ses_2", aborted))
    shutdown.setActiveSession(fakeSession("clean-code", "ses_3", aborted))

    await shutdown.abortActiveSessions()
    expect(aborted.sort()).toEqual(["ses_1", "ses_2", "ses_3"])
  })

  test("concurrent callers share the same in-flight abort", async () => {
    const shutdown = new RunShutdown()
    const aborted: string[] = []
    shutdown.setActiveSession(fakeSession("patterns", "ses_1", aborted))

    const [a, b] = await Promise.all([shutdown.abortActiveSessions(), shutdown.abortActiveSessions()])
    expect(a).toBe(b)
    expect(aborted).toEqual(["ses_1"])
  })
})

describe("createGitLock", () => {
  test("serializes concurrent jobs in enqueue order, regardless of individual duration", async () => {
    const gitLock = createGitLock()
    const order: number[] = []
    const job = (id: number, delayMs: number) =>
      gitLock(async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        order.push(id)
      })

    // Job 1 is slowest but enqueued first; it must still finish before 2 and 3 start.
    await Promise.all([job(1, 30), job(2, 10), job(3, 0)])
    expect(order).toEqual([1, 2, 3])
  })

  test("a rejected job doesn't break the chain for jobs queued after it", async () => {
    const gitLock = createGitLock()
    const order: string[] = []

    const first = gitLock(async () => {
      order.push("first")
      throw new Error("boom")
    })
    const second = gitLock(async () => {
      order.push("second")
    })

    await expect(first).rejects.toThrow("boom")
    await second
    expect(order).toEqual(["first", "second"])
  })
})

describe("read-only repository boundary", () => {
  test("preserves tracked and untracked mutations while refusing to commit them", async () => {
    const repo = await cleanRepo()
    const baseline = await createCleanRepoSnapshot(repo)
    if (!baseline?.ref) throw new Error("expected a clean repository branch baseline")
    const phase = { ...agentStep("security"), readOnly: true }
    await writeFile(join(repo, "keep.txt"), "mutated by extension\n")
    await writeFile(join(repo, "extension.txt"), "unexpected\n")

    await expect(finalizePhaseRepository(phase, "/unused/report.md", repo, baseline)).rejects.toThrow(
      "left these changes intact",
    )

    expect(await readFile(join(repo, "keep.txt"), "utf8")).toBe("mutated by extension\n")
    expect(await readFile(join(repo, "extension.txt"), "utf8")).toBe("unexpected\n")
    const status = await git(["status", "--porcelain"], repo)
    expect(status).toContain("keep.txt")
    expect(status).toContain("extension.txt")
    expect((await git(["rev-list", "--count", "HEAD"], repo)).trim()).toBe("1")
  })

  test("detects untracked mutations even when git config hides untracked files", async () => {
    const repo = await cleanRepo()
    await git(["config", "status.showUntrackedFiles", "no"], repo)
    const baseline = await createCleanRepoSnapshot(repo)
    const phase = { ...agentStep("security"), readOnly: true }
    await mkdir(join(repo, "nested"), { recursive: true })
    await writeFile(join(repo, "nested", "hidden.txt"), "unexpected\n")

    await expect(finalizePhaseRepository(phase, "/unused/report.md", repo, baseline)).rejects.toThrow("nested/hidden.txt")
    expect(await readFile(join(repo, "nested", "hidden.txt"), "utf8")).toBe("unexpected\n")
  })

  test("preserves commits created during a read-only step", async () => {
    const repo = await cleanRepo()
    const baseline = await createCleanRepoSnapshot(repo)
    const phase = { ...agentStep("security"), readOnly: true }
    await writeFile(join(repo, "extension.txt"), "unexpected\n")
    await git(["add", "-A"], repo)
    await git(["commit", "-qm", "extension side effect"], repo)

    await expect(finalizePhaseRepository(phase, "/unused/report.md", repo, baseline)).rejects.toThrow(
      "left these changes intact",
    )

    expect((await git(["status", "--porcelain"], repo)).trim()).toBe("")
    expect((await git(["rev-list", "--count", "HEAD"], repo)).trim()).toBe("2")
    expect(await readFile(join(repo, "extension.txt"), "utf8")).toBe("unexpected\n")
  })

  test("preserves a concurrent commit followed by tracked and untracked changes", async () => {
    const repo = await cleanRepo()
    const baseline = await createCleanRepoSnapshot(repo)
    const phase = { ...agentStep("security"), readOnly: true }
    await writeFile(join(repo, "keep.txt"), "committed side effect\n")
    await git(["add", "-A"], repo)
    await git(["commit", "-qm", "extension side effect"], repo)
    await writeFile(join(repo, "keep.txt"), "dirty after commit\n")
    await writeFile(join(repo, "untracked.txt"), "dirty after commit\n")

    await expect(finalizePhaseRepository(phase, "/unused/report.md", repo, baseline)).rejects.toThrow(
      "left these changes intact",
    )

    expect(await readFile(join(repo, "keep.txt"), "utf8")).toBe("dirty after commit\n")
    expect(await readFile(join(repo, "untracked.txt"), "utf8")).toBe("dirty after commit\n")
    expect(await git(["status", "--porcelain"], repo)).toContain("untracked.txt")
    expect((await git(["rev-list", "--count", "HEAD"], repo)).trim()).toBe("2")
  })

  test("preserves a concurrent branch change", async () => {
    const repo = await cleanRepo()
    const baseline = await createCleanRepoSnapshot(repo)
    if (!baseline?.ref) throw new Error("expected a clean repository branch baseline")
    const phase = { ...agentStep("security"), readOnly: true }
    await git(["checkout", "-qb", "extension-branch"], repo)

    await expect(finalizePhaseRepository(phase, "/unused/report.md", repo, baseline)).rejects.toThrow(
      "left these changes intact",
    )

    expect((await git(["branch", "--show-current"], repo)).trim()).toBe("extension-branch")
    expect((await git(["rev-parse", "HEAD"], repo)).trim()).toBe(baseline.head)
  })

  test("checks and preserves mutations when a read-only step is aborted", async () => {
    const repo = await cleanRepo()
    const baseline = await createCleanRepoSnapshot(repo)
    const phase = { ...agentStep("security"), readOnly: true }

    let failure: unknown
    try {
      await withReadOnlyRepositoryBoundary(phase, repo, baseline, createGitLock(), async () => {
        await writeFile(join(repo, "concurrent.txt"), "keep me\n")
        throw new UserAbortError()
      })
    } catch (error) {
      failure = error
    }

    expect(isUserAbortError(failure)).toBe(true)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/left these changes intact[\s\S]*Original failure: aborted by user/)
    expect(await readFile(join(repo, "concurrent.txt"), "utf8")).toBe("keep me\n")
  })

  test("checks and preserves mutations when report persistence fails", async () => {
    const repo = await cleanRepo()
    const baseline = await createCleanRepoSnapshot(repo)
    const phase = { ...agentStep("security"), readOnly: true }

    await expect(
      withReadOnlyRepositoryBoundary(phase, repo, baseline, createGitLock(), async () => {
        await writeFile(join(repo, "concurrent.txt"), "keep me\n")
        throw new Error("report persistence failed")
      }),
    ).rejects.toThrow(/left these changes intact[\s\S]*Original failure: report persistence failed/)

    expect(await readFile(join(repo, "concurrent.txt"), "utf8")).toBe("keep me\n")
  })

  test("blocks resume when a preserved commit changed the recorded baseline", async () => {
    const repo = await cleanRepo()
    const baseline = await createCleanRepoSnapshot(repo)
    if (!baseline) throw new Error("expected repository baseline")
    const phase = { ...agentStep("security"), readOnly: true }
    const ws: Workspace = { dir: await mkdtemp(join(tmpdir(), "convoy-read-only-resume-")), runID: "20260101-000000-readonly" }
    recoveryDirs.push(ws.dir)
    const skipped = agentStep("setup")
    const pipeline: Pipeline = { name: "audit", steps: [skipped, phase] }
    const metadata = await openRunMetadata(ws, repo, pipeline)
    metadata.phaseEnded(skipped.name, "skipped")
    metadata.phaseStarted(phase.name)
    await metadata.phaseRepositoryBaseline(phase.name, baseline)
    await mkdir(join(ws.dir, "reports"), { recursive: true })
    await writeFile(join(ws.dir, phase.reportPath), "# interrupted audit\n")

    await writeFile(join(repo, "preserved.txt"), "keep me\n")
    await git(["add", "-A"], repo)
    await git(["commit", "-qm", "concurrent user work"], repo)
    expect((await git(["status", "--porcelain"], repo)).trim()).toBe("")

    const resumed = await openRunMetadata(ws, repo, pipeline)
    expect((await selectInterruptedPhase(ws, resumed, pipeline))?.name).toBe(phase.name)
    await expect(assertPendingReadOnlyResumeBaselines(resumed, pipeline, repo)).rejects.toThrow("repository changed since this read-only phase began")
    expect((await git(["rev-list", "--count", "HEAD"], repo)).trim()).toBe("2")
  })

  test("blocks dirty recovery for a later read-only phase even when an earlier skipped phase has no report", async () => {
    const repo = await cleanRepo()
    const baseline = await createCleanRepoSnapshot(repo)
    if (!baseline) throw new Error("expected repository baseline")
    const skipped = agentStep("setup")
    const phase = { ...agentStep("security"), readOnly: true }
    const ws: Workspace = { dir: await mkdtemp(join(tmpdir(), "convoy-read-only-dirty-resume-")), runID: "20260101-000000-readonly-dirty" }
    recoveryDirs.push(ws.dir)
    const pipeline: Pipeline = { name: "audit", steps: [skipped, phase] }
    const metadata = await openRunMetadata(ws, repo, pipeline)
    metadata.phaseEnded(skipped.name, "skipped")
    metadata.phaseStarted(phase.name)
    await metadata.phaseRepositoryBaseline(phase.name, baseline)
    await writeFile(join(repo, "preserved.txt"), "keep me\n")

    await expect(assertPendingReadOnlyResumeBaselines(metadata, pipeline, repo)).rejects.toThrow("repository changed since this read-only phase began")
    expect(await readFile(join(repo, "preserved.txt"), "utf8")).toBe("keep me\n")
    expect((await git(["rev-list", "--count", "HEAD"], repo)).trim()).toBe("1")
  })
})

describe("dirty-tree recovery", () => {
  const agent = agentStep
  const pipeline: Pipeline = {
    name: "p",
    steps: [agent("implementer"), { type: "human", name: "review", description: "review" }, agent("patterns"), agent("tests")],
  }
  const fakeMetadata = (statuses: Record<string, ProgressPhaseSnapshot | undefined>): RunMetadataStore =>
    ({ snapshot: (name: string) => statuses[name] }) as unknown as RunMetadataStore

  async function workspaceWithReports(reports: string[]): Promise<Workspace> {
    const dir = await mkdtemp(join(tmpdir(), "convoy-recover-ws-"))
    recoveryDirs.push(dir)
    await mkdir(join(dir, "reports"), { recursive: true })
    for (const name of reports) await writeFile(join(dir, "reports", `${name}.md`), `# ${name}`)
    return { dir, runID: "20260101-000000-test" }
  }

  test("selects the first agent phase a resume would re-run, skipping human gates", async () => {
    // implementer done, patterns failed (stale report), tests never ran.
    const ws = await workspaceWithReports(["implementer", "patterns"])
    const metadata = fakeMetadata({ implementer: { status: "completed" }, patterns: { status: "failed" } })
    const phase = await selectInterruptedPhase(ws, metadata, pipeline)
    expect(phase?.name).toBe("patterns")
  })

  test("falls back to the first phase missing its report", async () => {
    const ws = await workspaceWithReports(["implementer"])
    const metadata = fakeMetadata({ implementer: { status: "completed" } })
    const phase = await selectInterruptedPhase(ws, metadata, pipeline)
    expect(phase?.name).toBe("patterns")
  })

  test("returns undefined when every agent phase is already done", async () => {
    const ws = await workspaceWithReports(["implementer", "patterns", "tests"])
    const metadata = fakeMetadata({ implementer: { status: "completed" }, patterns: { status: "completed" }, tests: { status: "completed" } })
    expect(await selectInterruptedPhase(ws, metadata, pipeline)).toBeUndefined()
  })

  test("commits the dirty tree as the phase, writes a recovery report, and marks it completed", async () => {
    const repo = await dirtyRepo()
    const ws = await workspaceWithReports([])
    const metadata = await openRunMetadata(ws, repo, pipeline)

    await commitRecoveredPhase(ws, metadata, agent("implementer"), repo)

    // working tree is clean and the leftover work is in a new convoy commit
    expect((await git(["status", "--porcelain"], repo)).trim()).toBe("")
    expect(await git(["log", "-1", "--pretty=%s"], repo)).toContain("convoy(implementer):")
    expect((await git(["show", "--name-only", "--pretty=", "HEAD"], repo)).trim()).toBe("feature.txt")

    // a recovery report was written and the phase is marked completed
    expect(await readFile(join(ws.dir, "reports", "implementer.md"), "utf8")).toContain("Recovered uncommitted changes")
    expect(metadata.snapshot("implementer")?.status).toBe("completed")
  })

  test("refuses to recover preserved changes as output from a read-only phase", async () => {
    const repo = await dirtyRepo()
    const ws = await workspaceWithReports([])
    const phase = { ...agent("security"), readOnly: true }
    const metadata = await openRunMetadata(ws, repo, { name: "audit", steps: [phase] })

    await expect(commitRecoveredPhase(ws, metadata, phase, repo)).rejects.toThrow("refusing to commit preserved changes")

    expect((await git(["status", "--porcelain"], repo))).toContain("feature.txt")
    expect((await git(["rev-list", "--count", "HEAD"], repo)).trim()).toBe("1")
    expect(metadata.snapshot(phase.name)).toBeUndefined()
  })

  test("keeps an existing report instead of overwriting it", async () => {
    const repo = await dirtyRepo()
    const ws = await workspaceWithReports(["implementer"])
    const metadata = await openRunMetadata(ws, repo, pipeline)

    await commitRecoveredPhase(ws, metadata, agent("implementer"), repo)

    expect(await readFile(join(ws.dir, "reports", "implementer.md"), "utf8")).toBe("# implementer")
    expect(await git(["log", "-1", "--pretty=%s"], repo)).toContain("convoy(implementer): implementer")
  })
})

describe("waitForInteractiveGate", () => {
  function gateProgress(actions: HumanReviewAction[]) {
    const calls = { prompts: [] as HumanReviewPromptInfo[], activities: [] as string[] }
    const progress: ProgressUI = {
      ...noopProgress,
      phaseActivity: (_name, detail) => void calls.activities.push(detail),
      askHumanReview: (info) => {
        calls.prompts.push(info)
        return Promise.resolve(actions.shift() ?? "continue")
      },
    }
    return { calls, progress }
  }

  function trackedPermissions() {
    const events: string[] = []
    const permissions = {
      stop: async () => {},
      pause: () => void events.push("pause"),
      resume: () => void events.push("resume"),
    }
    return { events, permissions }
  }

  test("continue resolves the gate and pauses permissions only while waiting", async () => {
    const { calls, progress } = gateProgress(["continue"])
    const { events, permissions } = trackedPermissions()

    await waitForInteractiveGate("implementer", "/repo", "ses_1", { serverUrl: "http://127.0.0.1:1", permissions }, progress)

    expect(events).toEqual(["pause", "resume"])
    expect(calls.prompts).toEqual([{ stepName: "implementer", iterations: 0, kind: "interactive" }])
  })

  test("iterate reopens the phase session window, then waits again", async () => {
    const { calls, progress } = gateProgress(["iterate", "continue"])
    const { permissions } = trackedPermissions()
    const opened: unknown[] = []

    await waitForInteractiveGate("implementer", "/repo", "ses_1", { serverUrl: "http://127.0.0.1:1", permissions }, progress, {
      openWindow: async (input) => {
        opened.push(input)
        return "terminal"
      },
    })

    expect(opened).toEqual([{ url: "http://127.0.0.1:1", targetDir: "/repo", sessionID: "ses_1" }])
    expect(calls.prompts.map((prompt) => prompt.iterations)).toEqual([0, 1])
    expect(calls.activities).toContain("session reopened in terminal; return here and press c to continue")
  })

  test("a failed window reopen keeps the gate waiting instead of crashing", async () => {
    const { calls, progress } = gateProgress(["iterate", "continue"])
    const { events, permissions } = trackedPermissions()

    await waitForInteractiveGate("implementer", "/repo", "ses_1", { serverUrl: "http://127.0.0.1:1", permissions }, progress, {
      openWindow: async () => {
        throw new Error("no window backend")
      },
    })

    expect(events).toEqual(["pause", "resume"])
    expect(calls.activities).toContain("couldn't reopen the session window: no window backend")
  })

  test("abort throws a user abort and still resumes permissions", async () => {
    const { progress } = gateProgress(["abort"])
    const { events, permissions } = trackedPermissions()

    await expect(
      waitForInteractiveGate("implementer", "/repo", "ses_1", { serverUrl: "http://127.0.0.1:1", permissions }, progress),
    ).rejects.toBeInstanceOf(UserAbortError)
    expect(events).toEqual(["pause", "resume"])
  })

  test("without a dashboard gate the wait is a no-op", async () => {
    const { events, permissions } = trackedPermissions()

    await waitForInteractiveGate("implementer", "/repo", "ses_1", { serverUrl: "http://127.0.0.1:1", permissions }, noopProgress)

    expect(events).toEqual([])
  })
})
