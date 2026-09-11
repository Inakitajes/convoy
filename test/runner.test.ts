import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { openRunMetadata, type RunMetadataStore } from "../src/metadata"
import { createCleanRepoSnapshot } from "../src/git"
import { noopProgress, type HumanReviewAction, type HumanReviewPromptInfo, type ProgressPhaseSnapshot, type ProgressUI } from "../src/progress"
import {
  assertPendingReadOnlyResumeBaselines,
  acquireRunLease,
  RunShutdown,
  RunControl,
  SessionAbortedError,
  SessionError,
  UserAbortError,
  PhaseGroupError,
  waitForPhaseGate,
  commitRecoveredPhase,
  createConcurrencyLimiter,
  createGitLock,
  defaultMaxConcurrentAgents,
  describeMessageChunk,
  describeSessionActivity,
  extractAssistantText,
  finalizePhaseRepository,
  isIgnorableRejection,
  isMessageAbortedError,
  isUserAbortError,
  newActivityState,
  modelOverrideNotice,
  parseModel,
  planBatches,
  progressPhases,
  promptPhase,
  applyCompletionCheckpoint,
  applyReportCheckpoint,
  resolveDeliverableCandidate,
  runPhaseUntilResolved,
  attemptFailureFor,
  sessionErrorFromEvent,
  sessionErrorOf,
  restorePhaseFromPreviousRun,
  selectInterruptedPhase,
  shouldSkip,
  validateDeliverable,
  watchSession,
  withReadOnlyRepositoryBoundary,
  softBudgetNudgeText,
  formatEventError,
  formatSdkError,
  type ActiveSession,
} from "../src/runner"
import type { AgentStep, DeliverableContract, HumanStep, Pipeline, Step } from "../src/types"
import type { Workspace } from "../src/workspace"
import { LoopGuard, LoopGuardError, resolveLoopGuard } from "../src/loop-guard"
import { createReportRuntime, type ReportPhaseHandle } from "../src/report-runtime"
import { startReportBridge } from "../src/report-bridge"
import { writeCommitSidecar } from "../src/step-commit"
import { qualityDimensionWeights } from "../src/quality-score"

const recoveryDirs: string[] = []

// A RunShutdown that has requested an abort arms a 15s force-exit timer
// (process.exit(130)) inside the test process. A test that never disposes its
// shutdown therefore leaves a live bomb behind: the unref'd timer fires once
// bun has moved on to other files, killing the whole suite mid-run. Track
// every shutdown a test creates and dispose the survivors after each test.
const liveShutdowns: RunShutdown[] = []
function trackedShutdown(): RunShutdown {
  const shutdown = new RunShutdown()
  liveShutdowns.push(shutdown)
  return shutdown
}
afterEach(() => {
  for (const shutdown of liveShutdowns.splice(0)) shutdown.dispose()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("defaults concurrent agent groups to 30 sessions", () => {
  expect(defaultMaxConcurrentAgents).toBe(30)
})

afterAll(async () => {
  await Promise.all(recoveryDirs.map((dir) => rm(dir, { recursive: true, force: true })))
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

async function workspaceWithReports(reports: string[]): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-recover-ws-"))
  recoveryDirs.push(dir)
  await mkdir(join(dir, "reports"), { recursive: true })
  for (const name of reports) await writeFile(join(dir, "reports", `${name}.md`), `# ${name}`)
  return { dir, runID: "20260101-000000-test" }
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
  test("extracts a report only from the last assistant message", () => {
    const lastAssistantParts = [
      { type: "text", text: "# Final report" },
      { type: "text", text: "internal synthetic text", synthetic: true },
      { type: "text", text: "ignored text", ignored: true },
    ] as never[]

    expect(extractAssistantText(lastAssistantParts)).toBe("# Final report")
  })

  test("returns an empty report when the last assistant message has no usable text", () => {
    const lastAssistantParts = [
      { type: "text", text: "synthetic", synthetic: true },
      { type: "text", text: "ignored", ignored: true },
    ] as never[]

    expect(extractAssistantText(lastAssistantParts)).toBe("")
  })

  test("validateDeliverable: the none contract accepts any text, including empty", () => {
    // A writable phase (implementer) is not gated on its report shape, so an
    // empty continue or any text is valid.
    const none: DeliverableContract = { kind: "none" }
    expect(validateDeliverable(none, "")).toEqual({ valid: true })
    expect(validateDeliverable(none, "# anything")).toEqual({ valid: true })
  })

  test("validateDeliverable: the markdown-report contract accepts non-empty text and rejects empty text", () => {
    const markdown: DeliverableContract = { kind: "markdown-report" }
    expect(validateDeliverable(markdown, "# report")).toEqual({ valid: true })
    // whitespace-only is also empty: a blank report would let a read-only phase
    // pass as if it had produced findings.
    expect(validateDeliverable(markdown, "   \n\t ")).toEqual({ valid: false, error: "phase produced an empty report" })
    expect(validateDeliverable(markdown, "")).toEqual({ valid: false, error: "phase produced an empty report" })
  })

  test("validateDeliverable: the quality-score-report contract accepts a valid score block", () => {
    const score: DeliverableContract = { kind: "quality-score-report", schemaVersion: 1, retryOnMissingOrInvalid: 1 }
    const valid = `\`\`\`quality-score\n${JSON.stringify({ dimensions: { prd: 90, tests: 90, security: 90, maintainability: 90, operational: 90, scope: 90 }, mustFix: [] })}\n\`\`\``
    expect(validateDeliverable(score, valid)).toEqual({ valid: true })
  })

  test("validateDeliverable: the quality-score-report contract rejects a missing score block", () => {
    const score: DeliverableContract = { kind: "quality-score-report", schemaVersion: 1, retryOnMissingOrInvalid: 1 }
    const result = validateDeliverable(score, "# no score block here")
    expect(result.valid).toBe(false)
    expect(result.valid === false && result.error).toBe("phase produced an invalid quality-score report")
  })

  test("validateDeliverable: the quality-score-report contract rejects malformed score JSON", () => {
    const score: DeliverableContract = { kind: "quality-score-report", schemaVersion: 1, retryOnMissingOrInvalid: 1 }
    const result = validateDeliverable(score, "```quality-score\nnot json\n```")
    expect(result.valid).toBe(false)
    expect(result.valid === false && result.error).toBe("phase produced an invalid quality-score report")
  })

  test("preserves OpenCode message aborts as typed session cancellations", () => {
    const error = { name: "MessageAbortedError" as const, data: { message: "stopped" } }
    expect(isMessageAbortedError(error)).toBeTrue()
    const wrapped = new SessionAbortedError(error)
    expect(wrapped.name).toBe("SessionAbortedError")
    expect(wrapped.cause).toBe(error)
  })

  test("preserves session-error classifications while retaining legacy message formatting", () => {
    expect(sessionErrorFromEvent({ name: "APIError", message: "rate limited", data: { statusCode: 429, isRetryable: true } })).toEqual({
      name: "APIError",
      message: "rate limited",
      statusCode: 429,
      isRetryable: true,
    })
    expect(sessionErrorFromEvent({ name: "ProviderAuthError", data: { message: "expired key", providerID: "anthropic" } })).toEqual({
      name: "ProviderAuthError",
      message: "expired key",
      providerID: "anthropic",
    })
    expect(sessionErrorFromEvent({ name: "MessageOutputLengthError", data: {} })).toEqual({
      name: "MessageOutputLengthError",
      message: "MessageOutputLengthError",
    })
    expect(sessionErrorFromEvent(undefined)).toEqual({ name: "UnknownError", message: "unknown error" })
  })

  test("keeps legacy event-error text for every message fallback", () => {
    const cases: Array<[unknown, string]> = [
      [{ message: "direct message", data: { message: "nested message" } }, "direct message"],
      [{ data: { message: "nested message" } }, "nested message"],
      [{ name: "MessageOutputLengthError", data: {} }, "MessageOutputLengthError"],
      [{ type: "UnknownError" }, "UnknownError"],
      [{}, "unknown error"],
      [[], "unknown error"],
      [undefined, "unknown error"],
    ]

    for (const [payload, expected] of cases) expect(formatEventError(payload)).toBe(expected)
  })

  test("retains only valid primitive classifications from a session error", () => {
    expect(sessionErrorFromEvent({ name: "APIError", data: { statusCode: "429", isRetryable: 1, providerID: 42 } })).toEqual({
      name: "APIError",
      message: "APIError",
    })
  })

  test("emits classified session-error signals while activity text remains unchanged", () => {
    const signal = describeSessionActivity(
      { type: "session.error", properties: { error: { name: "APIError", data: { message: "rate limited", statusCode: 429, isRetryable: true } } } },
      newActivityState(),
    )

    expect(signal).toEqual({
      type: "error",
      error: { name: "APIError", message: "rate limited", statusCode: 429, isRetryable: true },
    })
    expect(describeSessionActivity({ type: "session.next.step.failed", properties: { error: { data: { message: "rate limited" } } } }, newActivityState())).toEqual({
      type: "activity",
      kind: "error",
      message: "step failed: rate limited",
    })
  })

  test("formats typed session errors for failure surfaces without changing unclassified errors", () => {
    expect(formatSdkError(new SessionError({ name: "APIError", message: "rate limited", statusCode: 429, isRetryable: true }))).toBe(
      "rate limited (HTTP 429, retryable)",
    )
    expect(formatSdkError(new SessionError({ name: "APIError", message: "bad request", statusCode: 400, isRetryable: false }))).toBe(
      "bad request (HTTP 400, not retryable)",
    )
    expect(formatSdkError(new SessionError({ name: "UnknownError", message: "plain failure" }))).toBe("plain failure")
    expect(formatSdkError(new Error("unchanged"))).toBe("unchanged")
  })

  test("turns event-delivered message aborts into typed cancellations", () => {
    const error = new SessionError({ name: "MessageAbortedError", message: "stopped" })
    expect(isMessageAbortedError(error)).toBeTrue()
    expect(new SessionAbortedError(error).cause).toBe(error)
  })

  test("finds a session classification directly or through the attempt wrapper", () => {
    const failure = new SessionError({ name: "ProviderAuthError", message: "expired key", providerID: "anthropic" })
    expect(sessionErrorOf(failure)).toEqual(failure.signal)
    expect(sessionErrorOf(new Error("attempt failed", { cause: failure }))).toEqual(failure.signal)
    expect(sessionErrorOf(new SessionAbortedError(failure))).toBeUndefined()
    expect(sessionErrorOf(new Error("operator abort"))).toBeUndefined()
    // An abort answered at the failure gate wraps the attempt error one level deeper.
    const gateAbort = new UserAbortError("aborted from phase gate", { cause: new Error("attempt failed", { cause: failure }) })
    expect(sessionErrorOf(gateAbort)).toEqual(failure.signal)
    // A cancelled message stays a cancellation however deep it sits.
    expect(sessionErrorOf(new UserAbortError("aborted from phase gate", { cause: new SessionAbortedError(failure) }))).toBeUndefined()
  })

  test("classifies a message-level session error at the attempt boundary like an event-delivered one", () => {
    // The terminal assistant message can carry the raw SDK error without a
    // matching `session.error` event (the completion poll can win the race).
    const rateLimited = attemptFailureFor({ name: "APIError", data: { message: "rate limited", statusCode: 429, isRetryable: true } })
    expect(rateLimited.message).toBe("rate limited (HTTP 429, retryable)")
    expect(rateLimited.cause).toBeInstanceOf(SessionError)
    expect(sessionErrorOf(rateLimited)).toEqual({ name: "APIError", message: "rate limited", statusCode: 429, isRetryable: true })

    const unknown = attemptFailureFor({ name: "UnknownError", data: { message: "plain failure" } })
    expect(unknown.message).toBe("plain failure")
    expect(sessionErrorOf(unknown)).toEqual({ name: "UnknownError", message: "plain failure" })

    const aborted = attemptFailureFor({ name: "MessageAbortedError", data: { message: "stopped" } })
    expect(aborted).toBeInstanceOf(SessionAbortedError)
    expect(sessionErrorOf(aborted)).toBeUndefined()
  })

  test("a Claude Code failure string stays an unclassified attempt failure", () => {
    const failure = attemptFailureFor("claude exited with error_max_turns")
    expect(failure.message).toBe("claude exited with error_max_turns")
    expect(failure.cause).toBe("claude exited with error_max_turns")
    expect(sessionErrorOf(failure)).toBeUndefined()
  })

  test("a session error never impersonates the operator-abort sentinel", () => {
    const forged = new SessionError({ name: "UserAbortError", message: "provider said so" })
    expect(forged.name).toBe("SessionError")
    expect(isUserAbortError(forged)).toBeFalse()
    expect(isMessageAbortedError(new SessionError({ name: "MessageAbortedError", message: "stopped" }))).toBeTrue()
    expect(isMessageAbortedError(new SessionError({ name: "APIError", message: "rate limited", statusCode: 429 }))).toBeFalse()
  })

  test("parses provider/model values", () => {
    expect(parseModel("anthropic/claude-sonnet-4-6")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6",
    })
    expect(parseModel("custom/provider/model")).toEqual({ providerID: "custom", modelID: "provider/model" })
    expect(() => parseModel("claude-sonnet-4-6")).toThrow("invalid model")
    expect(() => parseModel("openai/gpt-5.6\nforged")).toThrow("invalid model")
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
      partID: "reasoning:0",
    })
    expect(describeMessageChunk({ type: "session.next.text.delta", properties: props({ delta: long }) })).toEqual({
      channel: "response",
      text: long,
      partID: "text:0",
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
      partID: "part_1",
    })

    // message.part.updated teaches the transcript whether later deltas belong
    // to reasoning or response content.
    expect(describeMessageChunk({ type: "message.part.updated", properties: props({ part: { id: "part_2", type: "reasoning" } }) }, state)).toBeUndefined()
    expect(describeMessageChunk({ type: "message.part.delta", properties: props({ field: "text", partID: "part_2", delta: "thinking" }) }, state)).toEqual({
      channel: "reasoning",
      text: "thinking",
      partID: "part_2",
    })

    // Empty deltas and everything else (usage, todos, heartbeats) are not
    // transcript content.
    expect(describeMessageChunk({ type: "session.next.text.delta", properties: props({ delta: "" }) })).toBeUndefined()
    expect(describeMessageChunk({ type: "message.part.delta", properties: props({ field: "metadata", partID: "part_1", delta: "ignored" }) }, state)).toBeUndefined()
    expect(describeMessageChunk({ type: "session.status", properties: props({ status: { type: "busy" } }) })).toBeUndefined()
  })

  test("numbers each reasoning and response burst so summaries stay separate blocks", () => {
    const props = (properties: Record<string, unknown>) => properties
    const state = newActivityState()

    // Successive reasoning summaries arrive as their own started/delta cycles;
    // without distinct part IDs the transcript would glue them into one
    // paragraph ("…scope inspectionInspecting rules…").
    expect(describeMessageChunk({ type: "session.next.reasoning.started", properties: props({}) }, state)).toBeUndefined()
    const first = describeMessageChunk({ type: "session.next.reasoning.delta", properties: props({ delta: "Planning diff scope" }) }, state)
    describeMessageChunk({ type: "session.next.reasoning.started", properties: props({}) }, state)
    const second = describeMessageChunk({ type: "session.next.reasoning.delta", properties: props({ delta: "Inspecting rules" }) }, state)

    expect(first).toEqual({ channel: "reasoning", text: "Planning diff scope", partID: "reasoning:1" })
    expect(second).toEqual({ channel: "reasoning", text: "Inspecting rules", partID: "reasoning:2" })

    // Response bursts are numbered on their own counter.
    describeMessageChunk({ type: "session.next.text.started", properties: props({}) }, state)
    expect(describeMessageChunk({ type: "session.next.text.delta", properties: props({ delta: "answer" }) }, state)).toEqual({
      channel: "response",
      text: "answer",
      partID: "text:1",
    })
  })

  test("restores on resume only when the phase didn't fail", async () => {
    const phase = agentStep("design")

    const workspaceWith = async (report: boolean) => {
      const dir = await mkdtemp(join(tmpdir(), "convoy-resume-"))
      if (report) {
        await mkdir(join(dir, "reports"), { recursive: true })
        await writeFile(join(dir, "reports", "design.md"), "# stale report")
      }
      return { dir, runID: "20260101-000000-test" } as Workspace
    }
    const metadataWith = (snapshot?: ProgressPhaseSnapshot, status?: "running" | "failed" | "completed") =>
      ({ snapshot: () => snapshot, phaseStatus: () => status }) as unknown as RunMetadataStore
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

    // A writable phase can write its report before the commit; a crashed process
    // leaves metadata running, so resume must rerun instead of accepting it.
    const interrupted = await workspaceWith(true)
    expect(await restorePhaseFromPreviousRun(interrupted, metadataWith({ status: "completed" }, "running"), phase, noopProgress)).toBe(false)
    expect(await Bun.file(join(interrupted.dir, "reports", "design.md")).exists()).toBe(false)
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

describe("RunControl", () => {
  test("waits for an active batch before pausing and resumes its checkpoint", async () => {
    let state = "running" as "running" | "pausing" | "paused"
    const persisted: string[] = []
    const paused = deferred()
    const metadata = {
      controlState: () => state,
      setControlState: async (next: typeof state) => {
        state = next
        persisted.push(next)
        if (next === "paused") paused.resolve()
      },
    } as unknown as RunMetadataStore
    const published: string[] = []
    const control = new RunControl(metadata)
    control.bind({ ...noopProgress, runControlState: (next, active) => published.push(`${next}:${active}`) })
    control.beginBatch(2)

    await control.requestPause()
    expect(state).toBe("pausing")
    let passed = false
    const checkpoint = control.checkpointAfterBatch().then(() => { passed = true })
    await paused.promise
    expect(state).toBe("paused")
    expect(passed).toBeFalse()
    await control.resume()
    await checkpoint

    expect(persisted).toEqual(["pausing", "paused", "running"])
    expect(published).toContain("pausing:2")
    expect(passed).toBeTrue()
  })

  test("unblocks a paused checkpoint when the run is aborted", async () => {
    const metadata = {
      controlState: () => "running" as const,
      setControlState: async () => {},
    } as unknown as RunMetadataStore
    const control = new RunControl(metadata)
    const shutdown = new AbortController()

    await control.requestPause()
    const checkpoint = control.checkpointAfterBatch(shutdown.signal)
    shutdown.abort(new UserAbortError("test shutdown"))
    await expect(checkpoint).rejects.toThrow("test shutdown")
  })

  test("pauses immediately when no batch is active", async () => {
    let state = "running" as "running" | "pausing" | "paused"
    const persisted: string[] = []
    const control = new RunControl({
      controlState: () => state,
      setControlState: async (next: typeof state) => {
        state = next
        persisted.push(next)
      },
    } as unknown as RunMetadataStore)

    await control.requestPause()

    expect(state).toBe("paused")
    expect(persisted).toEqual(["paused"])
  })
})

describe("run phase gate", () => {
  const prepared = {
    attachments: [],
    prompt: "test prompt",
    model: { providerID: "openai", modelID: "gpt-5.5" },
    loopGuard: resolveLoopGuard(),
  }
  async function retryWorkspace(): Promise<Workspace> {
    const dir = await mkdtemp(join(tmpdir(), "convoy-retry-"))
    recoveryDirs.push(dir)
    await mkdir(join(dir, "logs"))
    return { dir, runID: "20260724-110022-test" }
  }

  test("an armed takeover turns an OpenCode Esc cancellation into one interactive gate without retrying or restoring", async () => {
    const attempts: number[] = []
    const prompts: HumanReviewPromptInfo[] = []
    let restores = 0
    const workspace = await retryWorkspace()
    const reports = createReportRuntime(workspace.dir)
    const phase = { ...agentStep("implementer"), deliverableContract: { kind: "markdown-report" } as const }
    const progress: ProgressUI = {
      ...noopProgress,
      isInteractiveTakeover: () => true,
      askHumanReview: (info) => {
        prompts.push(info)
        return Promise.resolve("continue")
      },
    }

    const result = await runPhaseUntilResolved(
      {} as never,
      workspace,
      phase,
      "/repo",
      prepared,
      { head: "baseline" },
      progress,
      trackedShutdown(),
      createGitLock(),
      { serverUrl: "http://127.0.0.1:1" },
      {
        runPhaseAttempt: async (_client, _workspace, _phase, _targetDir, _prepared, attempt, _progress, _shutdown, sessionRef) => {
          attempts.push(attempt)
          sessionRef!.id = "ses_esc"
          // The report written before the Esc cancellation stays owned by the
          // session while the interactive gate is open, so [c] delivers it.
          const handle = reports.begin("ses_esc", phase, phase.deliverableContract, qualityDimensionWeights)
          await handle.write({ markdown: "# Esc report" })
          throw new SessionAbortedError({ name: "MessageAbortedError", data: { message: "stopped from OpenCode" } })
        },
        restorePhaseBaseline: async () => {
          restores++
        },
      },
      undefined,
      reports,
    )

    expect(result).toContain("Esc report")
    expect(attempts).toEqual([1])
    expect(restores).toBe(0)
    // After [c] the interactive gate is resolved and the phase's report becomes
    // the deliverable — no silent "" skip past the step's report.
    expect(prompts).toEqual([{ stepName: "implementer", iterations: 0, kind: "interactive", error: expect.any(String), canRetry: false }])
  })

  test("a failure does not relaunch on its own, does not restore the baseline, and waits", async () => {
    const attempts: number[] = []
    const prompts: HumanReviewPromptInfo[] = []
    let restores = 0
    const workspace = await retryWorkspace()
    const reports = createReportRuntime(workspace.dir)
    const phase = { ...agentStep("implementer"), deliverableContract: { kind: "markdown-report" } as const }
    const progress: ProgressUI = {
      ...noopProgress,
      askHumanReview: (info) => {
        prompts.push(info)
        return Promise.resolve("continue")
      },
    }

    const result = await runPhaseUntilResolved(
      {} as never,
      workspace,
      phase,
      "/repo",
      prepared,
      { head: "baseline" },
      progress,
      trackedShutdown(),
      createGitLock(),
      { serverUrl: "http://127.0.0.1:1" },
      {
        runPhaseAttempt: async (_client, _workspace, _phase, _targetDir, _prepared, attempt, _progress, _shutdown, sessionRef) => {
          attempts.push(attempt)
          sessionRef!.id = "ses_failed"
          const handle = reports.begin("ses_failed", phase, phase.deliverableContract, qualityDimensionWeights)
          await handle.write({ markdown: "# Survived the failure" })
          throw new SessionError({ name: "APIError", message: "provider temporarily unavailable", statusCode: 429, isRetryable: true })
        },
        restorePhaseBaseline: async () => {
          restores++
        },
      },
      undefined,
      reports,
    )

    // Continue resolves the gate and re-delivers the report the attempt already
    // persisted before dying — the step still produces its deliverable.
    expect(result).toContain("Survived the failure")
    expect(attempts).toEqual([1])
    expect(restores).toBe(0)
    expect(prompts[0]?.kind).toBe("failure")
    expect(prompts[0]?.canRetry).toBe(true)
    expect(prompts[0]?.error).toBe("provider temporarily unavailable (HTTP 429, retryable)")
  })

  test("a loop-guard trip reaches the decision gate instead of being swallowed", async () => {
    const attempts: number[] = []
    const prompts: HumanReviewPromptInfo[] = []
    let restores = 0
    const workspace = await retryWorkspace()
    const reports = createReportRuntime(workspace.dir)
    const phase = { ...agentStep("implementer"), deliverableContract: { kind: "markdown-report" } as const }
    const progress: ProgressUI = {
      ...noopProgress,
      askHumanReview: (info) => {
        prompts.push(info)
        return Promise.resolve("continue")
      },
    }

    // The follow-up turn's guard trip surfaces as a LoopGuardError from the
    // attempt. Like any other attempt failure it must open the normal failure
    // gate (retry / iterate / abort) rather than quietly keeping the phase.
    const result = await runPhaseUntilResolved(
      {} as never,
      workspace,
      phase,
      "/repo",
      prepared,
      { head: "baseline" },
      progress,
      trackedShutdown(),
      createGitLock(),
      { serverUrl: "http://127.0.0.1:1" },
      {
        runPhaseAttempt: async (_client, _workspace, _phase, _targetDir, _prepared, attempt, _progress, _shutdown, sessionRef) => {
          attempts.push(attempt)
          sessionRef!.id = "ses_guard"
          const handle = reports.begin("ses_guard", phase, phase.deliverableContract, qualityDimensionWeights)
          await handle.write({ markdown: "# Guard report" })
          throw new LoopGuardError({
            reason: "identical-calls",
            message: "read called 4 times in a row. The phase was aborted to stop a runaway session.",
            count: 4,
            tool: "read",
          })
        },
        restorePhaseBaseline: async () => {
          restores++
        },
      },
      undefined,
      reports,
    )

    expect(result).toContain("Guard report")
    expect(attempts).toEqual([1])
    expect(restores).toBe(0)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.kind).toBe("failure")
    expect(prompts[0]?.canRetry).toBe(true)
  })

  test("a max-steps trip opens a reset-or-abort budget gate and reuses its guard after reset", async () => {
    const attempts: LoopGuard[] = []
    const prompts: HumanReviewPromptInfo[] = []
    const workspace = await retryWorkspace()
    const progress: ProgressUI = {
      ...noopProgress,
      askHumanReview: (info) => {
        prompts.push(info)
        return Promise.resolve("reset")
      },
    }

    const result = await runPhaseUntilResolved(
      {} as never,
      workspace,
      agentStep("implementer"),
      "/repo",
      prepared,
      undefined,
      progress,
      trackedShutdown(),
      createGitLock(),
      { serverUrl: "http://127.0.0.1:1" },
      {
        runPhaseAttempt: async (...args) => {
          const guard = args[13]!
          attempts.push(guard)
          if (attempts.length === 1) {
            guard.observe({ kind: "cost", messageID: "msg_1", cost: 10 })
            for (let step = 0; step < 199; step++) guard.observe({ kind: "step" })
            const trip = guard.observe({ kind: "step" })!
            throw new LoopGuardError(trip)
          }
          expect(guard.getSteps()).toBe(0)
          expect(guard.getTotalCost()).toBe(10)
          return "# completed after reset"
        },
        restorePhaseBaseline: async () => {},
      },
    )

    expect(result).toBe("# completed after reset")
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toBe(attempts[0])
    expect(prompts).toEqual([{ stepName: "implementer", iterations: 0, kind: "budget-gate", error: expect.stringContaining("cap 200"), canRetry: false }])
  })

  test("answering abort at a budget gate throws UserAbortError and requests a run-wide shutdown", async () => {
    const workspace = await retryWorkspace()
    const progress: ProgressUI = {
      ...noopProgress,
      askHumanReview: (info) => {
        expect(info.kind).toBe("budget-gate")
        return Promise.resolve("abort")
      },
    }
    const shutdown = trackedShutdown()
    const trip = {
      reason: "max-steps" as const,
      message: "phase reached 200 model steps without finishing (cap 200). The phase was aborted to stop a runaway session.",
      count: 200,
    }

    try {
      await expect(
        runPhaseUntilResolved(
          {} as never,
          workspace,
          agentStep("implementer"),
          "/repo",
          prepared,
          undefined,
          progress,
          shutdown,
          createGitLock(),
          { serverUrl: "http://127.0.0.1:1" },
          {
            runPhaseAttempt: async () => {
              throw new LoopGuardError(trip)
            },
            restorePhaseBaseline: async () => {},
          },
        ),
      ).rejects.toThrow(UserAbortError)
      expect(shutdown.aborted).toBe(true)
    } finally {
      shutdown.dispose()
    }
  })

  test("answering abort at a failure gate keeps the failed attempt's session classification", async () => {
    const workspace = await retryWorkspace()
    const progress: ProgressUI = {
      ...noopProgress,
      askHumanReview: (info) => {
        expect(info.kind).toBe("failure")
        expect(info.error).toBe("API key is invalid.")
        return Promise.resolve("abort")
      },
    }
    const shutdown = trackedShutdown()
    const rejected = { name: "ProviderAuthError", data: { message: "API key is invalid.", providerID: "anthropic" } }

    try {
      const failure = await runPhaseUntilResolved(
        {} as never,
        workspace,
        agentStep("implementer"),
        "/repo",
        prepared,
        undefined,
        progress,
        shutdown,
        createGitLock(),
        { serverUrl: "http://127.0.0.1:1" },
        {
          runPhaseAttempt: async () => {
            throw attemptFailureFor(rejected)
          },
          restorePhaseBaseline: async () => {},
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(UserAbortError)
      expect(sessionErrorOf(failure)).toEqual({ name: "ProviderAuthError", message: "API key is invalid.", providerID: "anthropic" })
      expect(shutdown.aborted).toBe(true)
    } finally {
      shutdown.dispose()
    }
  })

  test("a max-steps trip fails instead of continuing when no dashboard or TTY can answer the budget gate", async () => {
    const workspace = await retryWorkspace()
    const trip = {
      reason: "max-steps" as const,
      message: "phase reached 200 model steps without finishing (cap 200). The phase was aborted to stop a runaway session.",
      count: 200,
    }

    await expect(
      runPhaseUntilResolved(
        {} as never,
        workspace,
        agentStep("implementer"),
        "/repo",
        prepared,
        undefined,
        noopProgress,
        trackedShutdown(),
        createGitLock(),
        undefined,
        {
          runPhaseAttempt: async () => {
            throw new LoopGuardError(trip)
          },
          restorePhaseBaseline: async () => {},
        },
      ),
    ).rejects.toMatchObject({ name: "LoopGuardError", trip })
  })

  test("retry restores the baseline and runs the attempt again", async () => {
    const attempts: number[] = []
    const prompts: HumanReviewPromptInfo[] = []
    let restores = 0
    const workspace = await retryWorkspace()
    await mkdir(join(workspace.dir, "reports"))
    await writeFile(join(workspace.dir, "reports", "implementer.md"), "# stale failed report")
    const progress: ProgressUI = {
      ...noopProgress,
      askHumanReview: (info) => {
        prompts.push(info)
        return Promise.resolve("retry")
      },
    }

    const result = await runPhaseUntilResolved(
      {} as never,
      workspace,
      agentStep("implementer"),
      "/repo",
      prepared,
      { head: "baseline" },
      progress,
      trackedShutdown(),
      createGitLock(),
      { serverUrl: "http://127.0.0.1:1" },
      {
        runPhaseAttempt: async (_client, _workspace, _phase, _targetDir, _prepared, attempt) => {
          attempts.push(attempt)
          if (attempt === 1) throw new Error("network blip")
          return "# report"
        },
        restorePhaseBaseline: async () => {
          restores++
        },
      },
    )

    expect(result).toBe("# report")
    expect(attempts).toEqual([1, 2])
    expect(restores).toBe(1)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.kind).toBe("failure")
    expect(prompts[0]?.canRetry).toBe(true)
    expect(await Bun.file(join(workspace.dir, "reports", "implementer.md")).exists()).toBe(false)
  })

  test("retry has no ceiling: a step that keeps failing can be retried indefinitely", async () => {
    const attempts: number[] = []
    const prompts: HumanReviewPromptInfo[] = []
    let restores = 0
    const workspace = await retryWorkspace()
    const progress: ProgressUI = {
      ...noopProgress,
      askHumanReview: (info) => {
        prompts.push(info)
        // Retry the first two failures; the third attempt succeeds so no third gate opens.
        return Promise.resolve(prompts.length <= 2 ? "retry" : "continue")
      },
    }

    const result = await runPhaseUntilResolved(
      {} as never,
      workspace,
      agentStep("implementer"),
      "/repo",
      prepared,
      { head: "baseline" },
      progress,
      trackedShutdown(),
      createGitLock(),
      { serverUrl: "http://127.0.0.1:1" },
      {
        runPhaseAttempt: async (_client, _workspace, _phase, _targetDir, _prepared, attempt) => {
          attempts.push(attempt)
          if (attempt < 3) throw new Error("still failing")
          return "# report"
        },
        restorePhaseBaseline: async () => {
          restores++
        },
      },
    )

    // The third attempt succeeds and returns its report — no third gate call.
    expect(result).toBe("# report")
    expect(attempts).toEqual([1, 2, 3])
    expect(restores).toBe(2)
    expect(prompts).toHaveLength(2)
    expect(prompts.every((p) => p.kind === "failure" && p.canRetry === true)).toBe(true)
  })

  const validQualityScoreReport = `\`\`\`quality-score
${JSON.stringify({ dimensions: { prd: 90, tests: 90, security: 90, maintainability: 90, operational: 90, scope: 90 }, mustFix: [] })}
\`\`\``

  function qualityScorePhase() {
    return {
      ...agentStep("score-report"),
      agentName: "quality-score-report",
      readOnly: true,
      deliverableContract: { kind: "quality-score-report" as const, schemaVersion: 1 as const, retryOnMissingOrInvalid: 1 as const },
    }
  }

  test("a missing quality score retries once without opening the human failure gate", async () => {
    const attempts: number[] = []
    let restores = 0
    const workspace = await retryWorkspace()
    const progress: ProgressUI = {
      ...noopProgress,
      askHumanReview: () => {
        throw new Error("quality-score validation must retry automatically")
      },
    }

    const result = await runPhaseUntilResolved(
      {} as never,
      workspace,
      qualityScorePhase(),
      "/repo",
      prepared,
      { head: "baseline" },
      progress,
      trackedShutdown(),
      createGitLock(),
      { serverUrl: "http://127.0.0.1:1" },
      {
        runPhaseAttempt: async (_client, _workspace, _phase, _targetDir, _prepared, attempt) => {
          attempts.push(attempt)
          return attempt === 1 ? "# no score block" : validQualityScoreReport
        },
        restorePhaseBaseline: async () => {
          restores++
        },
      },
    )

    expect(result).toBe(validQualityScoreReport)
    expect(attempts).toEqual([1, 2])
    expect(restores).toBe(1)
  })

  test("an invalid quality score retries once and then fails explicitly", async () => {
    const attempts: number[] = []
    const workspace = await retryWorkspace()
    const progress: ProgressUI = {
      ...noopProgress,
      askHumanReview: () => {
        throw new Error("quality-score validation must not wait for a human gate")
      },
    }

    await expect(
      runPhaseUntilResolved(
        {} as never,
        workspace,
        qualityScorePhase(),
        "/repo",
        prepared,
        { head: "baseline" },
        progress,
        trackedShutdown(),
        createGitLock(),
        { serverUrl: "http://127.0.0.1:1" },
        {
          runPhaseAttempt: async (_client, _workspace, _phase, _targetDir, _prepared, attempt) => {
            attempts.push(attempt)
            return "```quality-score\nnot json\n```"
          },
          restorePhaseBaseline: async () => {},
        },
      ),
    ).rejects.toThrow("invalid quality-score report")

    expect(attempts).toEqual([1, 2])
  })

  test("a valid quality score completes without a retry", async () => {
    const attempts: number[] = []
    const workspace = await retryWorkspace()

    const result = await runPhaseUntilResolved(
      {} as never,
      workspace,
      qualityScorePhase(),
      "/repo",
      prepared,
      { head: "baseline" },
      noopProgress,
      trackedShutdown(),
      createGitLock(),
      { serverUrl: "http://127.0.0.1:1" },
      {
        runPhaseAttempt: async (_client, _workspace, _phase, _targetDir, _prepared, attempt) => {
          attempts.push(attempt)
          return validQualityScoreReport
        },
        restorePhaseBaseline: async () => {},
      },
    )

    expect(result).toBe(validQualityScoreReport)
    expect(attempts).toEqual([1])
  })

  test("a write_report candidate is the deliverable when chat is empty", async () => {
    const workspace = await retryWorkspace()
    const phase = { ...agentStep("scope"), readOnly: true, deliverableContract: { kind: "markdown-report" } as const }
    const reports = createReportRuntime(workspace.dir)

    const result = await runPhaseUntilResolved(
      {} as never,
      workspace,
      phase,
      "/repo",
      prepared,
      { head: "baseline" },
      noopProgress,
      trackedShutdown(),
      createGitLock(),
      { serverUrl: "http://127.0.0.1:1" },
      {
        runPhaseAttempt: async (_client, _workspace, _phase, _targetDir, _prepared, _attempt, _progress, _shutdown, sessionRef) => {
          sessionRef!.id = "ses_report"
          const handle = reports.begin("ses_report", phase, phase.deliverableContract, qualityDimensionWeights)
          await handle.write({ markdown: "# Tool report\n\nSaved before the chat said done." })
          handle.end()
          return ""
        },
        restorePhaseBaseline: async () => {},
      },
      undefined,
      reports,
    )

    expect(result).toContain("Tool report")
  })

  test("the registered tool report wins over a direct file and chat fallback", async () => {
    const workspace = await retryWorkspace()
    const phase = agentStep("scope")
    await mkdir(join(workspace.dir, "reports"))
    await writeFile(join(workspace.dir, phase.reportPath), "direct file")

    expect(await resolveDeliverableCandidate(workspace, phase, "chat fallback", "tool report")).toBe("tool report")
  })

  test("an empty markdown report reaches the human failure gate instead of failing terminally", async () => {
    const attempts: number[] = []
    const prompts: HumanReviewPromptInfo[] = []
    let restores = 0
    const workspace = await retryWorkspace()
    const progress: ProgressUI = {
      ...noopProgress,
      askHumanReview: (info) => {
        prompts.push(info)
        return Promise.resolve("abort")
      },
    }
    const phase = { ...agentStep("scope"), readOnly: true, deliverableContract: { kind: "markdown-report" } as const }

    await expect(
      runPhaseUntilResolved(
        {} as never,
        workspace,
        phase,
        "/repo",
        prepared,
        { head: "baseline" },
        progress,
        trackedShutdown(),
        createGitLock(),
        { serverUrl: "http://127.0.0.1:1" },
        {
          runPhaseAttempt: async (_client, _workspace, _phase, _targetDir, _prepared, attempt) => {
            attempts.push(attempt)
            return ""
          },
          restorePhaseBaseline: async () => {
            restores++
          },
        },
      ),
    ).rejects.toThrow(UserAbortError)

    // SC-1: an empty read-only report is an ordinary attempt failure — the human
    // gate decides ([r]/[o]/[a]) instead of a terminal throw with no recourse.
    // A continue without a report reopens the gate (covered below), so the test
    // aborts to prove the phase never advances past the gate silently.
    expect(attempts).toEqual([1])
    expect(restores).toBe(0)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.kind).toBe("failure")
    expect(prompts[0]?.canRetry).toBe(true)
  })

  test("an armed takeover owns an invalid deliverable and presents it interactively", async () => {
    const attempts: number[] = []
    const prompts: HumanReviewPromptInfo[] = []
    let restores = 0
    const workspace = await retryWorkspace()
    const progress: ProgressUI = {
      ...noopProgress,
      isInteractiveTakeover: () => true,
      askHumanReview: (info) => {
        prompts.push(info)
        // A continue with no valid deliverable reopens the gate instead of
        // advancing; aborting here proves the step stayed where it was.
        return Promise.resolve(prompts.length === 1 ? "continue" : "abort")
      },
    }

    await expect(
      runPhaseUntilResolved(
        {} as never,
        workspace,
        qualityScorePhase(),
        "/repo",
        prepared,
        { head: "baseline" },
        progress,
        trackedShutdown(),
        createGitLock(),
        { serverUrl: "http://127.0.0.1:1" },
        {
          runPhaseAttempt: async (_client, _workspace, _phase, _targetDir, _prepared, attempt) => {
            attempts.push(attempt)
            return "# no score block"
          },
          restorePhaseBaseline: async () => {
            restores++
          },
        },
      ),
    ).rejects.toThrow(UserAbortError)

    // SC-2: armed means the step is the user's — an invalid deliverable is shown
    // to them interactively, not auto-retried or terminally thrown behind their back.
    expect(attempts).toEqual([1])
    expect(restores).toBe(0)
    expect(prompts).toHaveLength(2)
    expect(prompts[0]?.kind).toBe("interactive")
    expect(prompts[0]?.canRetry).toBe(false)
    // The reopened gate surfaces the deliverable validation error.
    expect(prompts[1]?.error).toContain("invalid quality-score report")
  })

  test("abort throws UserAbortError and requests a run-wide shutdown", async () => {
    const workspace = await retryWorkspace()
    const progress: ProgressUI = {
      ...noopProgress,
      askHumanReview: () => Promise.resolve("abort"),
    }

    const shutdown = trackedShutdown()
    try {
      await expect(
        runPhaseUntilResolved(
          {} as never,
          workspace,
          agentStep("implementer"),
          "/repo",
          prepared,
          { head: "baseline" },
          progress,
          shutdown,
          createGitLock(),
          { serverUrl: "http://127.0.0.1:1" },
          {
            runPhaseAttempt: async () => {
              throw new Error("provider temporarily unavailable")
            },
            restorePhaseBaseline: async () => {},
          },
        ),
      ).rejects.toThrow(UserAbortError)
      expect(shutdown.aborted).toBe(true)
    } finally {
      shutdown.dispose()
    }
  })

  test("without a dashboard or TTY the original error propagates", async () => {
    const workspace = await retryWorkspace()

    await expect(
      runPhaseUntilResolved(
        {} as never,
        workspace,
        agentStep("implementer"),
        "/repo",
        prepared,
        { head: "baseline" },
        noopProgress,
        trackedShutdown(),
        createGitLock(),
        { serverUrl: "http://127.0.0.1:1" },
        {
          runPhaseAttempt: async () => {
            throw new Error("network down")
          },
          restorePhaseBaseline: async () => {},
        },
      ),
    ).rejects.toThrow("network down")
  })

  test("without a baseline the failure gate reports canRetry false", async () => {
    const workspace = await retryWorkspace()
    const prompts: HumanReviewPromptInfo[] = []
    const progress: ProgressUI = {
      ...noopProgress,
      askHumanReview: (info) => {
        prompts.push(info)
        return Promise.resolve("abort")
      },
    }

    await expect(
      runPhaseUntilResolved(
        {} as never,
        workspace,
        agentStep("implementer"),
        "/repo",
        prepared,
        undefined,
        progress,
        trackedShutdown(),
        createGitLock(),
        { serverUrl: "http://127.0.0.1:1" },
        {
          runPhaseAttempt: async () => {
            throw new Error("boom")
          },
          restorePhaseBaseline: async () => {},
        },
      ),
    ).rejects.toThrow(UserAbortError)
    expect(prompts[0]?.kind).toBe("failure")
    expect(prompts[0]?.canRetry).toBe(false)
  })

  test("continue after a rescued write_report delivers the report to the step", async () => {
    const attempts: number[] = []
    const prompts: HumanReviewPromptInfo[] = []
    let restores = 0
    const workspace = await retryWorkspace()
    const reports = createReportRuntime(workspace.dir)
    const phase = { ...agentStep("implementer"), deliverableContract: { kind: "markdown-report" } as const }
    // The gate parks on a promise only the test resolves, standing in for the
    // [o] window being opened in another terminal / a late controller connect.
    let resumeGate!: (action: "continue") => void
    const parked = new Promise<"continue">((resolve) => {
      resumeGate = resolve
    })
    let writeHandle: ReportPhaseHandle | undefined
    const progress: ProgressUI = {
      ...noopProgress,
      askHumanReview: (info) => {
        prompts.push(info)
        return parked
      },
    }

    let result = ""
    const run = runPhaseUntilResolved(
      {} as never,
      workspace,
      phase,
      "/repo",
      prepared,
      { head: "baseline" },
      progress,
      trackedShutdown(),
      createGitLock(),
      { serverUrl: "http://127.0.0.1:1" },
      {
        runPhaseAttempt: async (_client, _workspace, _phase, _targetDir, _prepared, attempt, _progress, _shutdown, sessionRef) => {
          attempts.push(attempt)
          sessionRef!.id = "ses_failed"
          writeHandle = reports.begin("ses_failed", phase, phase.deliverableContract, qualityDimensionWeights)
          // No end(): the recovered window keeps this handle alive through the gate.
          throw new Error("provider temporarily unavailable")
        },
        restorePhaseBaseline: async () => {
          restores++
        },
      },
      undefined,
      reports,
    ).then((value) => {
      result = value
    })

    // While the gate is open and the coordinator detached, the report bridge has
    // to keep accepting write_report for the same session: that is exactly the
    // lost/regained controller window, not a 404-answerable stale session.
    while (prompts.length === 0) await Bun.sleep(5)
    expect(reports.handleFor("ses_failed")).toBeDefined()
    await writeHandle!.write({ markdown: "# Rescued in the reopened session" })
    resumeGate("continue")

    await run
    expect(result).toContain("Rescued in the reopened session")
    expect(attempts).toEqual([1])
    expect(restores).toBe(0)
    // The gate decided continue, and the rescued report is now the deliverable — the
    // step advances instead of skipping the report.
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.kind).toBe("failure")
  })

  test("an armed clean finish delivers the report written during the gate over the pre-gate candidate", async () => {
    const attempts: number[] = []
    const prompts: HumanReviewPromptInfo[] = []
    const workspace = await retryWorkspace()
    const reports = createReportRuntime(workspace.dir)
    const phase = { ...agentStep("implementer"), deliverableContract: { kind: "markdown-report" } as const }
    // The armed gate parks on a promise only the test resolves: the user is in
    // the [o] window of a step that already finished cleanly.
    let resumeGate!: (action: "continue") => void
    const parked = new Promise<"continue">((resolve) => {
      resumeGate = resolve
    })
    let writeHandle: ReportPhaseHandle | undefined
    const progress: ProgressUI = {
      ...noopProgress,
      isInteractiveTakeover: () => true,
      askHumanReview: (info) => {
        prompts.push(info)
        return parked
      },
    }

    let result = ""
    const run = runPhaseUntilResolved(
      {} as never,
      workspace,
      phase,
      "/repo",
      prepared,
      { head: "baseline" },
      progress,
      trackedShutdown(),
      createGitLock(),
      { serverUrl: "http://127.0.0.1:1" },
      {
        runPhaseAttempt: async (_client, _workspace, _phase, _targetDir, _prepared, attempt, _progress, _shutdown, sessionRef) => {
          attempts.push(attempt)
          sessionRef!.id = "ses_armed"
          writeHandle = reports.begin("ses_armed", phase, phase.deliverableContract, qualityDimensionWeights)
          // A clean finish: the pre-gate candidate is the assistant text.
          return "# Pre-gate report"
        },
        restorePhaseBaseline: async () => {},
      },
      undefined,
      reports,
    ).then((value) => {
      result = value
    })

    // The armed gate is open and the session is still registered. A write_report
    // from the reopened window must win over the candidate computed before the
    // gate — continue re-resolves instead of delivering the stale text.
    while (prompts.length === 0) await Bun.sleep(5)
    expect(reports.handleFor("ses_armed")).toBeDefined()
    await writeHandle!.write({ markdown: "# Rescued during the armed gate" })
    resumeGate("continue")

    await run
    expect(result).toContain("Rescued during the armed gate")
    expect(attempts).toEqual([1])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.kind).toBe("interactive")
  })

  test("a write_report posted over the bridge while the gate is held with no controller still delivers on continue", async () => {
    const prompts: HumanReviewPromptInfo[] = []
    const workspace = await retryWorkspace()
    const reports = createReportRuntime(workspace.dir)
    const phase = { ...agentStep("implementer"), deliverableContract: { kind: "markdown-report" } as const }
    // Hold harness shaped like ControlProgress (#84): askHumanReview parks on a
    // promise only a late controller can resolve. No TTY, no attached client.
    let resumeGate!: (action: "continue") => void
    const parked = new Promise<"continue">((resolve) => {
      resumeGate = resolve
    })
    const progress: ProgressUI = {
      ...noopProgress,
      askHumanReview: (info) => {
        prompts.push(info)
        return parked
      },
    }

    let result = ""
    const run = runPhaseUntilResolved(
      {} as never,
      workspace,
      phase,
      "/repo",
      prepared,
      { head: "baseline" },
      progress,
      trackedShutdown(),
      createGitLock(),
      { serverUrl: "http://127.0.0.1:1" },
      {
        runPhaseAttempt: async (_client, _workspace, _phase, _targetDir, _prepared, attempt, _progress, _shutdown, sessionRef) => {
          sessionRef!.id = "ses_hold"
          reports.begin("ses_hold", phase, phase.deliverableContract, qualityDimensionWeights)
          throw new Error("provider temporarily unavailable")
        },
        restorePhaseBaseline: async () => {},
      },
      undefined,
      reports,
    ).then((value) => {
      result = value
    })

    // The gate is open and nobody has answered yet. The user re-attaches via
    // `convoy runs`, presses [o], and the reopened session's write_report posts
    // to the report bridge — the same HTTP path production uses. The deferred
    // end() keeps the session owned, so the bridge answers 200 instead of the
    // 404 "unknown report session" that used to detach the rescued window.
    while (prompts.length === 0) await Bun.sleep(5)
    const bridge = await startReportBridge({ reports: () => reports })
    try {
      const response = await fetch(bridge.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({ sessionID: "ses_hold", payload: { markdown: "# Rescued over the bridge" } }),
      })
      expect(response.status).toBe(200)
      expect(await readFile(join(workspace.dir, phase.reportPath), "utf8")).toBe("# Rescued over the bridge")
    } finally {
      bridge.close()
    }

    // The controller finally connects and answers [c]: the bridged report is
    // re-resolved and becomes the step's deliverable.
    resumeGate("continue")
    await run
    expect(result).toContain("Rescued over the bridge")
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.kind).toBe("failure")
  })

  test("continue with no valid report reopens the gate instead of advancing", async () => {
    const attempts: number[] = []
    const prompts: HumanReviewPromptInfo[] = []
    const workspace = await retryWorkspace()
    const progress: ProgressUI = {
      ...noopProgress,
      askHumanReview: (info) => {
        prompts.push(info)
        // First [c] finds no report; the gate reopens. The second answer shows
        // the run did not silently advance — aborting surfaces the reopened gate.
        return Promise.resolve(prompts.length === 1 ? "continue" : "abort")
      },
    }

    await expect(
      runPhaseUntilResolved(
        {} as never,
        workspace,
        agentStep("implementer"),
        "/repo",
        prepared,
        { head: "baseline" },
        progress,
        trackedShutdown(),
        createGitLock(),
        { serverUrl: "http://127.0.0.1:1" },
        {
          runPhaseAttempt: async (_client, _workspace, _phase, _targetDir, _prepared, attempt) => {
            attempts.push(attempt)
            throw new Error("provider temporarily unavailable")
          },
          restorePhaseBaseline: async () => {},
        },
      ),
    ).rejects.toThrow(UserAbortError)

    expect(attempts).toEqual([1])
    // The gate asked twice: first the failure gate, then the same gate re-opened
    // with the validation error because continue had no report to deliver.
    expect(prompts).toHaveLength(2)
    expect(prompts[0]?.kind).toBe("failure")
    expect(prompts[1]?.error).toContain("phase produced an empty report")
  })

  test("retry ends the previous session's report handle before the next attempt", async () => {
    let restores = 0
    const workspace = await retryWorkspace()
    const reports = createReportRuntime(workspace.dir)
    const phase = { ...agentStep("implementer"), deliverableContract: { kind: "markdown-report" } as const }
    const progress: ProgressUI = {
      ...noopProgress,
      askHumanReview: () => Promise.resolve("retry"),
    }

    const result = await runPhaseUntilResolved(
      {} as never,
      workspace,
      phase,
      "/repo",
      prepared,
      { head: "baseline" },
      progress,
      trackedShutdown(),
      createGitLock(),
      { serverUrl: "http://127.0.0.1:1" },
      {
        runPhaseAttempt: async (_client, _workspace, _phase, _targetDir, _prepared, attempt, _progress, _shutdown, sessionRef) => {
          sessionRef!.id = attempt === 1 ? "ses_old" : "ses_new"
          reports.begin(sessionRef!.id, phase, phase.deliverableContract, qualityDimensionWeights)
          if (attempt === 1) throw new Error("network blip")
          return "# report"
        },
        restorePhaseBaseline: async () => {
          restores++
        },
      },
      undefined,
      reports,
    )

    expect(result).toBe("# report")
    expect(restores).toBe(1)
    // Retrying starts a fresh session; the stale handle must release so a late
    // write_report from the old window cannot reach the next attempt.
    expect(reports.handleFor("ses_old")).toBeUndefined()
  })
})

describe("run coordinator lease", () => {
  test("allows only one coordinator and releases ownership", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-lease-"))
    recoveryDirs.push(dir)
    const workspace = { dir, runID: "lease-test" }
    const release = await acquireRunLease(workspace)

    await expect(acquireRunLease(workspace)).rejects.toThrow("already controlled")
    await release()
    const releaseAgain = await acquireRunLease(workspace)
    await releaseAgain()
  })

  test("fails closed for an incomplete or stale lease instead of deleting it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-lease-"))
    recoveryDirs.push(dir)
    const workspace = { dir, runID: "lease-test" }
    const path = join(dir, "coordinator.lock")

    await writeFile(path, "")
    await expect(acquireRunLease(workspace)).rejects.toThrow("stale coordinator lease")
    expect(await readFile(path, "utf8")).toBe("")
  })

  test("does not release another coordinator's lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-lease-"))
    recoveryDirs.push(dir)
    const workspace = { dir, runID: "lease-test" }
    const path = join(dir, "coordinator.lock")
    const release = await acquireRunLease(workspace)

    await unlink(path)
    await writeFile(path, "other-coordinator")
    await release()
    expect(await readFile(path, "utf8")).toBe("other-coordinator")
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
    const shutdown = trackedShutdown()
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
    const shutdown = trackedShutdown()
    const aborted: string[] = []
    shutdown.setActiveSession(fakeSession("patterns", "ses_1", aborted))
    shutdown.setActiveSession(fakeSession("security", "ses_2", aborted))
    shutdown.setActiveSession(fakeSession("clean-code", "ses_3", aborted))

    await shutdown.abortActiveSessions()
    expect(aborted.sort()).toEqual(["ses_1", "ses_2", "ses_3"])
  })

  test("concurrent callers share the same in-flight abort", async () => {
    const shutdown = trackedShutdown()
    const aborted: string[] = []
    shutdown.setActiveSession(fakeSession("patterns", "ses_1", aborted))

    const [a, b] = await Promise.all([shutdown.abortActiveSessions(), shutdown.abortActiveSessions()])
    expect(a).toBe(b)
    expect(aborted).toEqual(["ses_1"])
  })
})

describe("createGitLock", () => {
  test("serializes concurrent jobs in enqueue order", async () => {
    const gitLock = createGitLock()
    const order: number[] = []
    const releaseFirst = deferred()
    const firstStarted = deferred()
    const first = gitLock(async () => {
      order.push(1)
      firstStarted.resolve()
      await releaseFirst.promise
    })
    const second = gitLock(async () => { order.push(2) })
    const third = gitLock(async () => { order.push(3) })

    await firstStarted.promise
    expect(order).toEqual([1])
    releaseFirst.resolve()
    await Promise.all([first, second, third])
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

describe("createConcurrencyLimiter", () => {
  test("never runs more than `limit` jobs at once and drains the rest", async () => {
    const limit = createConcurrencyLimiter(2)
    const release = deferred()
    let active = 0
    let peak = 0
    let completed = 0
    const job = () =>
      limit(async () => {
        active++
        peak = Math.max(peak, active)
        await release.promise
        active--
        completed++
      })

    const jobs = Array.from({ length: 6 }, job)
    expect(active).toBe(2)
    release.resolve()
    await Promise.all(jobs)
    expect(peak).toBe(2)
    expect(completed).toBe(6)
    expect(active).toBe(0)
  })

  test("a group at or below the limit runs fully in parallel (no throttling)", async () => {
    const limit = createConcurrencyLimiter(8)
    const release = deferred()
    let active = 0
    let peak = 0
    const job = () =>
      limit(async () => {
        active++
        peak = Math.max(peak, active)
        await release.promise
        active--
      })

    const jobs = Array.from({ length: 6 }, job)
    expect(active).toBe(6)
    release.resolve()
    await Promise.all(jobs)
    expect(peak).toBe(6)
  })

  test("releases its slot even when a job throws, so queued jobs still run", async () => {
    const limit = createConcurrencyLimiter(1)
    const order: string[] = []
    const boom = limit(async () => {
      order.push("boom")
      throw new Error("boom")
    })
    const after = limit(async () => {
      order.push("after")
    })

    await expect(boom).rejects.toThrow("boom")
    await after
    expect(order).toEqual(["boom", "after"])
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
    // The report's only line is the bare phase name — a generic label — so the
    // commit describes the exact staged change instead (`step-commit-messages`).
    expect(await git(["log", "-1", "--pretty=%s"], repo)).toContain("convoy(implementer): update feature.txt")
    expect(await git(["log", "-1", "--pretty=%B"], repo)).toContain("Convoy-Run: 20260101-000000-test")
  })

  test("reuses a hash-matched sidecar description when recovery follows an interrupted write_report", async () => {
    const repo = await dirtyRepo()
    const ws = await workspaceWithReports(["implementer"])
    const metadata = await openRunMetadata(ws, repo, pipeline)

    // The interrupted phase wrote a report plus a structured commit description;
    // the sidecar hashes the persisted report so recovery can trust it.
    const reportAbs = join(ws.dir, "reports", "implementer.md")
    await writeFile(reportAbs, "preserve report sessions across human gates\n")
    await writeCommitSidecar(reportAbs, {
      subject: "preserve report sessions across human gates",
      details: ["Keep report and advisor handles alive during manual iteration"],
    })

    await commitRecoveredPhase(ws, metadata, agent("implementer"), repo)

    const body = await git(["log", "-1", "--pretty=%B"], repo)
    expect(body).toContain("convoy(implementer): preserve report sessions across human gates")
    expect(body).toContain("- Keep report and advisor handles alive during manual iteration")
    expect(body).toContain("Convoy-Run: 20260101-000000-test")
  })

  test("ignores a stale sidecar whose report hash no longer matches", async () => {
    const repo = await dirtyRepo()
    const ws = await workspaceWithReports(["implementer"])
    const metadata = await openRunMetadata(ws, repo, pipeline)

    // The sidecar was written for different report content than what is
    // persisted now: recovery must degrade to the staged evidence, not pair
    // the stale description with this commit.
    const reportAbs = join(ws.dir, "reports", "implementer.md")
    await writeCommitSidecar(reportAbs, { subject: "stale description" })
    await writeFile(reportAbs, "the report changed after the sidecar was written\n")

    await commitRecoveredPhase(ws, metadata, agent("implementer"), repo)

    // The stale description is ignored; the revised report's own heading is a
    // useful subject, so that becomes the summary (not the recovery fallback).
    expect(await git(["log", "-1", "--pretty=%s"], repo)).toContain(
      "convoy(implementer): the report changed after the sidecar was written",
    )
    expect(await git(["log", "-1", "--pretty=%B"], repo)).not.toContain("stale description")
  })
})

describe("writable phase finalization", () => {
  // Uses the recovery fixtures: each repo starts with a base commit and the
  // workspace carries runID `20260101-000000-test`.

  test("a normal writable phase commits a run-linked semantic message", async () => {
    const repo = await dirtyRepo()
    const ws = await workspaceWithReports(["implementer"])
    // The phase wrote its report and a structured description through
    // write_report before finalization: the sidecar hashes the report so the
    // composer can trust the description pair.
    const reportAbs = join(ws.dir, "reports", "implementer.md")
    await writeFile(reportAbs, "preserve report sessions across human gates\n")
    await writeCommitSidecar(reportAbs, {
      subject: "preserve report sessions across human gates",
      details: ["Keep report and advisor handles alive during manual iteration"],
    })

    await finalizePhaseRepository(agentStep("implementer"), reportAbs, repo, undefined, undefined, ws)

    const body = await git(["log", "-1", "--pretty=%B"], repo)
    expect(body).toContain("convoy(implementer): preserve report sessions across human gates")
    expect(body).toContain("- Keep report and advisor handles alive during manual iteration")
    expect(body).toContain("Convoy-Run: 20260101-000000-test")
    expect(body.match(/^Convoy-Run:/gm)).toHaveLength(1)
    expect((await git(["status", "--porcelain"], repo)).trim()).toBe("")
  })

  test("without structured metadata a useful report heading becomes the subject and staged paths the details", async () => {
    const repo = await dirtyRepo()
    const ws = await workspaceWithReports(["implementer"])
    const reportAbs = join(ws.dir, "reports", "implementer.md")
    await writeFile(reportAbs, "preserve report sessions across human gates\n")

    await finalizePhaseRepository(agentStep("implementer"), reportAbs, repo, undefined, undefined, ws)

    const body = await git(["log", "-1", "--pretty=%B"], repo)
    expect(body).toContain("convoy(implementer): preserve report sessions across human gates")
    expect(body).toContain("- A feature.txt")
    expect(body).toContain("Convoy-Run: 20260101-000000-test")
  })

  test("a clean writable phase creates no empty commit", async () => {
    const repo = await cleanRepo()
    const ws = await workspaceWithReports(["implementer"])
    const reportAbs = join(ws.dir, "reports", "implementer.md")

    await finalizePhaseRepository(agentStep("implementer"), reportAbs, repo, undefined, undefined, ws)

    expect((await git(["rev-list", "--count", "HEAD"], repo)).trim()).toBe("1")
    expect((await git(["status", "--porcelain"], repo)).trim()).toBe("")
  })

  test("a writable phase without a workspace is refused: provenance is never invented", async () => {
    const repo = await dirtyRepo()
    const ws = await workspaceWithReports(["implementer"])
    const reportAbs = join(ws.dir, "reports", "implementer.md")
    await writeFile(reportAbs, "preserve report sessions\n")

    await expect(
      finalizePhaseRepository(agentStep("implementer"), reportAbs, repo, undefined, undefined, undefined),
    ).rejects.toThrow("without run provenance")
  })
})

describe("waitForPhaseGate", () => {
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
    const pauseCalls: (string | undefined)[] = []
    const resumeCalls: (string | undefined)[] = []
    const permissions = {
      stop: async () => {},
      pause: (sessionID?: string) => {
        pauseCalls.push(sessionID)
        events.push("pause")
      },
      resume: (sessionID?: string) => {
        resumeCalls.push(sessionID)
        events.push("resume")
      },
    }
    return { events, permissions, pauseCalls, resumeCalls }
  }

  test("continue resolves the interactive gate and pauses permissions only while waiting", async () => {
    const { calls, progress } = gateProgress(["continue"])
    const { events, permissions } = trackedPermissions()

    const outcome = await waitForPhaseGate("implementer", "/repo", "ses_1", { serverUrl: "http://127.0.0.1:1", permissions }, progress, { kind: "interactive", canRetry: false })

    expect(outcome).toBe("continue")
    expect(events).toEqual(["pause", "resume"])
    expect(calls.prompts).toEqual([{ stepName: "implementer", iterations: 0, kind: "interactive", canRetry: false }])
  })

  test("iterate reopens the phase session window, then waits again", async () => {
    const { calls, progress } = gateProgress(["iterate", "continue"])
    const { permissions } = trackedPermissions()
    const opened: unknown[] = []

    await waitForPhaseGate("implementer", "/repo", "ses_1", { serverUrl: "http://127.0.0.1:1", permissions }, progress, { kind: "interactive", canRetry: false }, {
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

    await waitForPhaseGate("implementer", "/repo", "ses_1", { serverUrl: "http://127.0.0.1:1", permissions }, progress, { kind: "interactive", canRetry: false }, {
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
      waitForPhaseGate("implementer", "/repo", "ses_1", { serverUrl: "http://127.0.0.1:1", permissions }, progress, { kind: "interactive", canRetry: false }),
    ).rejects.toBeInstanceOf(UserAbortError)
    expect(events).toEqual(["pause", "resume"])
  })

  test("a failure gate reports the error and canRetry, and pauses no permissions", async () => {
    const { calls, progress } = gateProgress(["abort"])
    const { events, permissions } = trackedPermissions()

    await expect(
      waitForPhaseGate("implementer", "/repo", "ses_1", { serverUrl: "http://127.0.0.1:1", permissions }, progress, {
        kind: "failure",
        error: "network down",
        canRetry: true,
      }),
    ).rejects.toBeInstanceOf(UserAbortError)
    expect(events).toEqual([])
    expect(calls.prompts).toEqual([{ stepName: "implementer", iterations: 0, kind: "failure", error: "network down", canRetry: true }])
  })

  test("a budget gate returns reset and offers neither retry nor an interactive session", async () => {
    const { calls, progress } = gateProgress(["reset"])
    const { events, permissions } = trackedPermissions()

    const outcome = await waitForPhaseGate("implementer", "/repo", "ses_1", { serverUrl: "http://127.0.0.1:1", permissions }, progress, {
      kind: "budget-gate",
      error: "step cap reached",
      canRetry: false,
    })

    expect(outcome).toBe("reset")
    expect(events).toEqual([])
    expect(calls.prompts).toEqual([{ stepName: "implementer", iterations: 0, kind: "budget-gate", error: "step cap reached", canRetry: false }])
  })

  test("a budget gate ignores an unsupported open-session reply", async () => {
    const { calls, progress } = gateProgress(["iterate", "reset"])
    let opened = 0

    const outcome = await waitForPhaseGate("implementer", "/repo", "ses_1", { serverUrl: "http://127.0.0.1:1" }, progress, {
      kind: "budget-gate",
      canRetry: false,
    }, {
      openWindow: async () => {
        opened++
        return "terminal"
      },
    })

    expect(outcome).toBe("reset")
    expect(opened).toBe(0)
    expect(calls.prompts).toHaveLength(2)
  })

  test("retry on a failure gate returns the retry outcome without restoring", async () => {
    const { calls, progress } = gateProgress(["retry"])
    const { events, permissions } = trackedPermissions()

    const outcome = await waitForPhaseGate("implementer", "/repo", "ses_1", { serverUrl: "http://127.0.0.1:1", permissions }, progress, {
      kind: "failure",
      error: "network down",
      canRetry: true,
    })

    expect(outcome).toBe("retry")
    // No permission pause in failure mode, and retry returns before the flip.
    expect(events).toEqual([])
    expect(calls.prompts).toEqual([{ stepName: "implementer", iterations: 0, kind: "failure", error: "network down", canRetry: true }])
  })

  test("iterate flips a failure gate to interactive, unlocking [c] and pausing permissions", async () => {
    const { calls, progress } = gateProgress(["iterate", "continue"])
    const { events, permissions } = trackedPermissions()

    const outcome = await waitForPhaseGate("implementer", "/repo", "ses_1", { serverUrl: "http://127.0.0.1:1", permissions }, progress, {
      kind: "failure",
      error: "network down",
      canRetry: true,
    }, {
      openWindow: async () => "terminal",
    })

    expect(outcome).toBe("continue")
    // Failure mode starts without pausing; the flip to interactive pauses, and
    // the final continue resumes — so the full lifecycle is pause→resume.
    expect(events).toEqual(["pause", "resume"])
    // First prompt is failure with canRetry; after iterate the gate flips to
    // interactive, so the second prompt has canRetry false and kind interactive.
    expect(calls.prompts).toHaveLength(2)
    expect(calls.prompts[0]).toMatchObject({ kind: "failure", canRetry: true, iterations: 0 })
    expect(calls.prompts[1]).toMatchObject({ kind: "interactive", canRetry: false, iterations: 1 })
  })

  test("a failed session open keeps the gate in failure mode, with retry still available", async () => {
    const { calls, progress } = gateProgress(["iterate", "abort"])
    const { events, permissions } = trackedPermissions()

    await expect(
      waitForPhaseGate("implementer", "/repo", "ses_1", { serverUrl: "http://127.0.0.1:1", permissions }, progress, { kind: "failure", canRetry: true }, {
        openWindow: async () => {
          throw new Error("no window backend")
        },
      }),
    ).rejects.toBeInstanceOf(UserAbortError)

    expect(events).toEqual([])
    expect(calls.prompts.map((prompt) => ({ kind: prompt.kind, canRetry: prompt.canRetry }))).toEqual([
      { kind: "failure", canRetry: true },
      { kind: "failure", canRetry: true },
    ])
  })

  test("a missing session keeps the failure gate from unlocking continue", async () => {
    const { calls, progress } = gateProgress(["iterate", "abort"])
    const { events, permissions } = trackedPermissions()

    await expect(
      waitForPhaseGate("implementer", "/repo", undefined, { serverUrl: "http://127.0.0.1:1", permissions }, progress, { kind: "failure", canRetry: true }),
    ).rejects.toBeInstanceOf(UserAbortError)

    expect(events).toEqual([])
    expect(calls.prompts.map((prompt) => prompt.kind)).toEqual(["failure", "failure"])
  })

  test("a Claude Code failure reopens its transcript through the Claude CLI", async () => {
    const { calls, progress } = gateProgress(["iterate", "continue"])
    const opened: unknown[] = []

    await waitForPhaseGate("security", "/repo", "claude-session", { serverUrl: "http://127.0.0.1:1" }, progress, {
      kind: "failure",
      canRetry: true,
      runner: "claude-code",
      runDir: "/run",
    }, {
      openWindow: async () => {
        throw new Error("OpenCode opener should not be used for Claude")
      },
      openClaudeWindow: async (input) => {
        opened.push(input)
        return "terminal"
      },
    })

    expect(opened).toEqual([{ targetDir: "/repo", sessionID: "claude-session", runDir: "/run" }])
    expect(calls.prompts.map((prompt) => prompt.kind)).toEqual(["failure", "interactive"])
  })

  test("pauses only the phase's session so a live sibling keeps being handled", async () => {
    const { progress } = gateProgress(["continue"])
    const { events, permissions, pauseCalls, resumeCalls } = trackedPermissions()

    await waitForPhaseGate("implementer", "/repo", "ses_1", { serverUrl: "http://127.0.0.1:1", permissions }, progress, { kind: "interactive", canRetry: false })

    // A directory-wide pause would freeze a live sibling's prompts; the gate
    // scopes the pause to the session the interactive TUI owns instead.
    expect(events).toEqual(["pause", "resume"])
    expect(pauseCalls).toEqual(["ses_1"])
    expect(resumeCalls).toEqual(["ses_1"])
  })

  test("a failure gate that reopens the session pauses only that session", async () => {
    const { progress } = gateProgress(["iterate", "continue"])
    const { permissions, pauseCalls, resumeCalls } = trackedPermissions()

    await waitForPhaseGate(
      "implementer",
      "/repo",
      "ses_1",
      { serverUrl: "http://127.0.0.1:1", permissions },
      progress,
      { kind: "failure", error: "network down", canRetry: true },
      { openWindow: async () => "terminal" },
    )

    expect(pauseCalls).toEqual(["ses_1"])
    expect(resumeCalls).toEqual(["ses_1"])
  })

  test("an interactive gate with no session pauses nothing, so siblings keep being handled", async () => {
    const { progress } = gateProgress(["continue"])
    const { permissions, pauseCalls, resumeCalls } = trackedPermissions()

    await waitForPhaseGate("implementer", "/repo", undefined, { serverUrl: "http://127.0.0.1:1", permissions }, progress, { kind: "interactive", canRetry: false })

    // No session to hand to an interactive TUI means no session to pause for, so
    // Convoy must keep handling every live sibling's permission prompts.
    expect(pauseCalls).toEqual([])
    expect(resumeCalls).toEqual([])
  })

  test("a failed window reopen pauses nothing until a real session opens", async () => {
    const { progress } = gateProgress(["iterate", "abort"])
    const { permissions, pauseCalls } = trackedPermissions()

    await expect(
      waitForPhaseGate(
        "implementer",
        "/repo",
        "ses_1",
        { serverUrl: "http://127.0.0.1:1", permissions },
        progress,
        { kind: "failure", error: "network down", canRetry: true },
        { openWindow: async () => { throw new Error("no window backend") } },
      ),
    ).rejects.toBeInstanceOf(UserAbortError)

    // The failure gate starts without pausing, and a failed reopen must not
    // flip to interactive (and so pause) — only a successfully opened session proves the user took control.
    expect(pauseCalls).toEqual([])
  })

  test("a run-wide shutdown resolves a dashboard gate without waiting for input", async () => {
    const controller = new AbortController()
    const { events, permissions } = trackedPermissions()
    const progress: ProgressUI = {
      ...noopProgress,
      askHumanReview: () => new Promise<HumanReviewAction>(() => {}),
    }

    const waiting = waitForPhaseGate("implementer", "/repo", "ses_1", { serverUrl: "http://127.0.0.1:1", permissions }, progress, {
      kind: "interactive",
      canRetry: false,
      signal: controller.signal,
    })
    controller.abort(new UserAbortError("test shutdown"))

    await expect(waiting).rejects.toThrow("test shutdown")
    expect(events).toEqual(["pause", "resume"])
  })

  test("without a dashboard gate or TTY the wait is unavailable", async () => {
    const { events, permissions } = trackedPermissions()

    const outcome = await waitForPhaseGate("implementer", "/repo", "ses_1", { serverUrl: "http://127.0.0.1:1", permissions }, noopProgress, { kind: "failure", canRetry: true })

    expect(outcome).toBe("unavailable")
    expect(events).toEqual([])
  })
})

/**
 * The advisor's completion checkpoint gives a finished phase a second turn in
 * the SAME session, so two watchers observe one message list. A result that
 * described the whole session instead of its own turn would make the caller
 * double-count usage and concatenate the first turn's report onto the second's.
 */
describe("watchSession turn scoping", () => {
  const assistantMessage = (id: string, cost: number, text: string) => ({
    info: {
      id,
      sessionID: "ses_1",
      role: "assistant" as const,
      time: { created: 1, completed: 2 },
      parentID: "p",
      modelID: "gpt-5.6-sol",
      providerID: "openai",
      mode: "primary",
      agent: "implementer",
      path: { cwd: "/repo", root: "/repo" },
      cost,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: `${id}_p`, sessionID: "ses_1", messageID: id, type: "text" as const, text }],
  })

  function idleClient(messages: unknown[]) {
    let release!: () => void
    const verificationFinished = deferred()
    const idled = new Promise<void>((resolve) => {
      release = resolve
    })
    const responseData = {
      filter(predicate: (message: unknown, index: number, values: unknown[]) => boolean) {
        const filtered = messages.filter(predicate)
        verificationFinished.resolve()
        return filtered
      },
    }
    async function* stream() {
      // One idle event, then hold the stream open the way a live server does.
      yield { type: "session.idle", properties: { sessionID: "ses_1" } }
      await idled
    }
    return {
      close: release,
      client: {
        event: { subscribe: async () => ({ stream: stream() }) },
        session: {
          messages: async () => ({ data: responseData }),
          status: async () => ({ data: {} }),
        },
      } as never,
      verificationFinished: verificationFinished.promise,
    }
  }

  const watch = async (messages: unknown[], sinceMessageID?: string) => {
    const { client, close } = idleClient(messages)
    const watcher = watchSession(client, {
      directory: "/repo",
      phaseName: "build",
      sessionID: "ses_1",
      progress: noopProgress,
      signal: new AbortController().signal,
      ...(sinceMessageID ? { sinceMessageID } : {}),
    })
    try {
      return await watcher.result
    } finally {
      close()
      await watcher.stop()
    }
  }

  const twoTurns = () => [assistantMessage("msg_1", 0.1, "first report"), assistantMessage("msg_2", 0.02, "NO CHANGES")]

  test("an anchored watcher reports only the messages after its anchor", async () => {
    const result = await watch(twoTurns(), "msg_1")

    expect(result.assistantInfos.map((info) => info.id)).toEqual(["msg_2"])
    expect(result.parts).toHaveLength(1)
    expect(result.lastAssistantParts).toHaveLength(1)
    // The sentinel is unreachable if the first turn's report is still in front of it.
    expect((result.parts[0] as { text: string }).text).toBe("NO CHANGES")
    expect(result.info.id).toBe("msg_2")
  })

  test("an unanchored watcher still reports the whole session", async () => {
    const result = await watch(twoTurns())

    expect(result.assistantInfos.map((info) => info.id)).toEqual(["msg_1", "msg_2"])
    expect(result.parts).toHaveLength(2)
    expect(result.lastAssistantParts).toHaveLength(1)
  })

  test("rejects idle event-delivered failures with their session classification", async () => {
    async function* stream() {
      yield { type: "session.next.prompted", properties: { sessionID: "ses_1" } }
      yield { type: "session.error", properties: { sessionID: "ses_1", error: { name: "APIError", data: { message: "rate limited", statusCode: 429, isRetryable: true } } } }
      yield { type: "session.idle", properties: { sessionID: "ses_1" } }
      await new Promise<void>(() => {})
    }
    const client = {
      event: { subscribe: async () => ({ stream: stream() }) },
      session: {
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
    } as never
    const watcher = watchSession(client, {
      directory: "/repo",
      phaseName: "build",
      sessionID: "ses_1",
      progress: noopProgress,
      signal: new AbortController().signal,
    })

    try {
      await expect(watcher.result).rejects.toMatchObject({ name: "SessionError", signal: { name: "APIError", statusCode: 429, isRetryable: true } })
    } finally {
      await watcher.stop()
    }
  })

  test("prefers an event classification over the terminal assistant error", async () => {
    async function* stream() {
      yield { type: "session.error", properties: { sessionID: "ses_1", error: { name: "APIError", data: { message: "rate limited", statusCode: 429, isRetryable: true } } } }
      await new Promise<void>(() => {})
    }
    const terminal = assistantMessage("msg_1", 0, "")
    const client = {
      event: { subscribe: async () => ({ stream: stream() }) },
      session: {
        messages: async () => ({ data: [{ ...terminal, info: { ...terminal.info, error: { name: "APIError", data: { message: "rate limited" } } } }] }),
        status: async () => ({ data: {} }),
      },
    } as never
    const watcher = watchSession(client, {
      directory: "/repo",
      phaseName: "build",
      sessionID: "ses_1",
      progress: noopProgress,
      signal: new AbortController().signal,
    })

    try {
      await expect(watcher.result).rejects.toMatchObject({ name: "SessionError", signal: { name: "APIError", statusCode: 429, isRetryable: true } })
    } finally {
      await watcher.stop()
    }
  })

  test("aborts the session when the loop guard sees the same tool call over and over", async () => {
    const aborted: string[] = []
    const activities: string[] = []
    async function* stream() {
      for (let index = 0; index < 4; index++) {
        yield {
          type: "session.next.tool.called",
          properties: { sessionID: "ses_1", tool: "read", input: { filePath: "src/a.ts" } },
        }
      }
      await new Promise<void>(() => {})
    }
    const client = {
      event: { subscribe: async () => ({ stream: stream() }) },
      session: {
        messages: async () => ({ data: [] }),
        status: async () => ({ data: { ses_1: { type: "busy" } } }),
        abort: async (args: { sessionID: string }) => {
          aborted.push(args.sessionID)
          return {}
        },
      },
    } as never
    const watcher = watchSession(client, {
      directory: "/repo",
      phaseName: "build",
      sessionID: "ses_1",
      progress: {
        ...noopProgress,
        phaseActivity: (_name, detail) => void activities.push(detail),
      },
      signal: new AbortController().signal,
      loopGuard: new LoopGuard(resolveLoopGuard({ identicalCalls: 4 })),
    })

    await expect(watcher.result).rejects.toBeInstanceOf(LoopGuardError)
    await Promise.resolve()
    expect(aborted).toEqual(["ses_1"])
    expect(activities.some((line) => line.includes("read called 4 times"))).toBe(true)
    await watcher.stop()
  })

  test("waits for the follow-up turn instead of resolving on the previous one", async () => {
    // Only the first turn exists: the anchored watcher has nothing of its own
    // yet, and resolving here would report an empty turn as a finished one.
    const { client, close, verificationFinished } = idleClient([assistantMessage("msg_1", 0.1, "first report")])
    const watcher = watchSession(client, {
      directory: "/repo",
      phaseName: "build",
      sessionID: "ses_1",
      progress: noopProgress,
      signal: new AbortController().signal,
      sinceMessageID: "msg_1",
    })

    await verificationFinished
    const settled = await Promise.race([
      watcher.result.then(() => "settled", () => "settled"),
      Promise.resolve("pending"),
    ])

    expect(settled).toBe("pending")
    close()
    await watcher.stop()
  })
})

describe("loopGuard seam regressions", () => {
  const completedMessage = (id: string, cost: number, text: string) => ({
    info: {
      id,
      sessionID: "ses_1",
      role: "assistant" as const,
      time: { created: 1, completed: 2 },
      parentID: "p",
      modelID: "gpt-5.5",
      providerID: "openai",
      mode: "primary",
      agent: "implementer",
      path: { cwd: "/repo", root: "/repo" },
      cost,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: `${id}_p`, sessionID: "ses_1", messageID: id, type: "text" as const, text }],
  })

  // A fake opencode client whose event stream yields `updates` then idles, and
  // whose session.messages hands back `messages` for completion verification.
  function watcherClient(updates: unknown[], messages: unknown[], loopGuard?: LoopGuard) {
    async function* stream() {
      for (const update of updates) yield update
      yield { type: "session.idle", properties: { sessionID: "ses_1" } }
      await new Promise<void>(() => {})
    }
    const client = {
      event: { subscribe: async () => ({ stream: stream() }) },
      session: {
        messages: async () => ({ data: messages }),
        status: async () => ({ data: {} }),
        abort: async () => ({}),
      },
    } as never
    const watcher = watchSession(client, {
      directory: "/repo",
      phaseName: "build",
      sessionID: "ses_1",
      progress: noopProgress,
      signal: new AbortController().signal,
      ...(loopGuard ? { loopGuard } : {}),
    })
    return { watcher }
  }

  test("SC-1: maxPhaseCost: false survives promptPhase without a re-armed $20 cap", async () => {
    const costOfTurn = 25 // well above the built-in $20 cap
    const messages = [completedMessage("msg_1", costOfTurn, "# report")]
    async function* stream() {
      yield messageUpdated(assistantInfo("msg_1", costOfTurn, 2_000, 400))
      yield { type: "session.idle", properties: { sessionID: "ses_1" } }
      await new Promise<void>(() => {})
    }
    const client = {
      event: { subscribe: async () => ({ stream: stream() }) },
      session: {
        create: async () => ({ data: { id: "ses_1" } }),
        promptAsync: async () => ({}),
        messages: async () => ({ data: messages }),
        status: async () => ({ data: {} }),
        abort: async () => ({}),
      },
    } as never

    // The config is resolved once by preparePhaseRun; promptPhase must not
    // resolve it again (which would re-arm the $20 default over `false`).
    const result = await promptPhase(client, {
      phase: agentStep("implementer"),
      workspace: { dir: "/run", runID: "test-run" } as Workspace,
      targetDir: "/repo",
      prompt: "do the thing",
      model: { providerID: "openai", modelID: "gpt-5.5" },
      attachments: [],
      progress: noopProgress,
      shutdown: trackedShutdown(),
      attempt: 1,
      loopGuardConfig: resolveLoopGuard({ maxPhaseCost: false }),
    })

    expect(result.info.id).toBe("msg_1")
  })

  test("promptPhase turns an event-delivered message abort into a typed cancellation", async () => {
    const started = deferred()
    async function* stream() {
      await started.promise
      yield { type: "session.next.prompted", properties: { sessionID: "ses_1" } }
      yield { type: "session.error", properties: { sessionID: "ses_1", error: { name: "MessageAbortedError", data: { message: "stopped" } } } }
      yield { type: "session.idle", properties: { sessionID: "ses_1" } }
      await new Promise<void>(() => {})
    }
    const client = {
      event: { subscribe: async () => ({ stream: stream() }) },
      session: {
        create: async () => ({ data: { id: "ses_1" } }),
        promptAsync: async () => {
          started.resolve()
          return {}
        },
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        abort: async () => ({}),
      },
    } as never

    await expect(
      promptPhase(client, {
        phase: agentStep("implementer"),
        workspace: { dir: "/run", runID: "test-run" } as Workspace,
        targetDir: "/repo",
        prompt: "do the thing",
        model: { providerID: "openai", modelID: "gpt-5.5" },
        attachments: [],
        progress: noopProgress,
        shutdown: trackedShutdown(),
        attempt: 1,
        loopGuardConfig: resolveLoopGuard({}),
      }),
    ).rejects.toBeInstanceOf(SessionAbortedError)
  })

  test("queues the soft nudge through v2 for a session created and prompted through v1", async () => {
    const started = deferred()
    const queued: unknown[] = []
    const activities: string[] = []
    let v1Prompts = 0
    async function* stream() {
      await started.promise
      for (let step = 0; step < 100; step++) {
        yield { type: "session.next.step.started", properties: { sessionID: "ses_1" } }
      }
      yield { type: "session.idle", properties: { sessionID: "ses_1" } }
      await new Promise<void>(() => {})
    }
    const client = {
      event: { subscribe: async () => ({ stream: stream() }) },
      session: {
        create: async () => ({ data: { id: "ses_1" } }),
        promptAsync: async () => {
          v1Prompts++
          started.resolve()
          return {}
        },
        messages: async () => ({ data: [completedMessage("msg_1", 0, "# report")] }),
        status: async () => ({ data: {} }),
        abort: async () => ({}),
      },
      v2: {
        session: {
          prompt: async (input: unknown) => {
            queued.push(input)
            return {}
          },
        },
      },
    } as never

    const result = await promptPhase(client, {
      phase: agentStep("implementer"),
      workspace: { dir: "/run", runID: "test-run" } as Workspace,
      targetDir: "/repo",
      prompt: "do the thing",
      model: { providerID: "openai", modelID: "gpt-5.5" },
      attachments: [],
      progress: { ...noopProgress, phaseActivity: (_name, detail) => void activities.push(detail) },
      shutdown: trackedShutdown(),
      attempt: 1,
      loopGuardConfig: resolveLoopGuard({ maxSteps: 200 }),
    })

    await Promise.resolve()
    expect(result.info.id).toBe("msg_1")
    expect(v1Prompts).toBe(1)
    expect(queued).toEqual([{ sessionID: "ses_1", prompt: { text: softBudgetNudgeText }, delivery: "queue" }])
    expect(activities.some((detail) => detail.includes("soft budget"))).toBe(false)
  })

  test("a failed soft-nudge delivery never aborts the session or fails the phase", async () => {
    const started = deferred()
    const activities: string[] = []
    let aborts = 0
    async function* stream() {
      await started.promise
      for (let step = 0; step < 100; step++) {
        yield { type: "session.next.step.started", properties: { sessionID: "ses_1" } }
      }
      yield { type: "session.idle", properties: { sessionID: "ses_1" } }
      await new Promise<void>(() => {})
    }
    // SessionBusyError-shaped rejection: the v2 queue route can refuse a
    // mid-turn delivery. The nudge is best-effort, so the turn must survive.
    const client = {
      event: { subscribe: async () => ({ stream: stream() }) },
      session: {
        create: async () => ({ data: { id: "ses_1" } }),
        promptAsync: async () => {
          started.resolve()
          return {}
        },
        messages: async () => ({ data: [completedMessage("msg_1", 0, "# report")] }),
        status: async () => ({ data: {} }),
        abort: async () => {
          aborts++
          return {}
        },
      },
      v2: {
        session: {
          prompt: async () => {
            throw new Error("Session is busy")
          },
        },
      },
    } as never

    const result = await promptPhase(client, {
      phase: agentStep("implementer"),
      workspace: { dir: "/run", runID: "test-run" } as Workspace,
      targetDir: "/repo",
      prompt: "do the thing",
      model: { providerID: "openai", modelID: "gpt-5.5" },
      attachments: [],
      progress: {
        ...noopProgress,
        phaseActivity: (_name, detail, level) => {
          activities.push(`${level}:${detail}`)
        },
      },
      shutdown: trackedShutdown(),
      attempt: 1,
      loopGuardConfig: resolveLoopGuard({ maxSteps: 200 }),
    })

    // Give the rejected nudge's catch handler a chance to (wrongly) act.
    await Promise.resolve()
    await Promise.resolve()
    expect(result.info.id).toBe("msg_1")
    expect(aborts).toBe(0)
    expect(activities.some((detail) => detail.startsWith("error:"))).toBe(false)
  })

  test("SC-2: a follow-up watcher's spend accumulates into the shared cost cap", async () => {
    const guard = new LoopGuard(resolveLoopGuard({ maxPhaseCost: 20 }))

    // Turn 1: two messages totalling $15 stay under the $20 cap.
    const first = watcherClient(
      [messageUpdated(assistantInfo("msg_1", 10, 1_000, 200)), messageUpdated(assistantInfo("msg_2", 5, 500, 100))],
      [completedMessage("msg_1", 10, "part one"), completedMessage("msg_2", 5, "part two")],
      guard,
    )
    const turn1 = await first.watcher.result
    await first.watcher.stop()
    expect(turn1.assistantInfos.map((info) => info.id)).toEqual(["msg_1", "msg_2"])

    // Turn 2: a NEW watcher (fresh state) sees only its own message, but the
    // shared guard carries the turn-1 spend, so $7 on top trips the $20 cap.
    const second = watcherClient([messageUpdated(assistantInfo("msg_3", 7, 700, 100))], [completedMessage("msg_3", 7, "follow-up")], guard)
    await expect(second.watcher.result).rejects.toBeInstanceOf(LoopGuardError)
    await second.watcher.stop()
  })

  test("SC-3: a loop-guard trip in the follow-up turn rejects instead of keeping the phase", async () => {
    const loopGuard = new LoopGuard(resolveLoopGuard({ identicalCalls: 2 }))
    const advisor = {
      consult: async () => ({ text: "redo the tests", ok: true as const, callId: "call_1" }),
      delivered: async () => {},
    }
    async function* stream() {
      yield { type: "session.next.tool.called", properties: { sessionID: "ses_1", tool: "read", input: { filePath: "a.ts" } } }
      yield { type: "session.next.tool.called", properties: { sessionID: "ses_1", tool: "read", input: { filePath: "a.ts" } } }
      await new Promise<void>(() => {})
    }
    const client = {
      event: { subscribe: async () => ({ stream: stream() }) },
      session: {
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        promptAsync: async () => ({}),
        abort: async () => ({}),
      },
    } as never
    const first = {
      info: { id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1, completed: 2 } },
      parts: [],
      assistantInfos: [],
    } as never

    await expect(
      applyCompletionCheckpoint(
        client,
        {
          phase: agentStep("implementer"),
          targetDir: "/repo",
          model: { providerID: "openai", modelID: "gpt-5.5" },
          progress: noopProgress,
          shutdown: trackedShutdown(),
          sessionID: "ses_1",
          loopGuard,
        },
        first,
        advisor as never,
      ),
    ).rejects.toBeInstanceOf(LoopGuardError)
  })
})

/**
 * The completion checkpoint's second turn decides whether the report comes
 * from the first or the second turn. lastAssistantParts must follow that
 * decision so extractAssistantText never concatenates the first turn's report
 * onto the second's (the narrative-contamination bug this phase fixes).
 */
describe("applyCompletionCheckpoint lastAssistantParts", () => {
  const completedMessage = (id: string, text: string) => ({
    info: {
      id,
      sessionID: "ses_1",
      role: "assistant" as const,
      time: { created: 1, completed: 2 },
      parentID: "p",
      modelID: "gpt-5.5",
      providerID: "openai",
      mode: "primary",
      agent: "implementer",
      path: { cwd: "/repo", root: "/repo" },
      cost: 1,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: `${id}_p`, sessionID: "ses_1", messageID: id, type: "text" as const, text }],
  })

  function firstResult(text: string) {
    const info = {
      id: "msg_1",
      sessionID: "ses_1",
      role: "assistant" as const,
      time: { created: 1, completed: 2 },
      parentID: "p",
      modelID: "gpt-5.5",
      providerID: "openai",
      mode: "primary",
      agent: "implementer",
      path: { cwd: "/repo", root: "/repo" },
      cost: 1,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    const parts = [{ id: "msg_1_p", sessionID: "ses_1", messageID: "msg_1", type: "text" as const, text }]
    return { info, parts, assistantInfos: [info], lastAssistantParts: parts } as never
  }

  function checkpointClient(secondMessage: { info: Record<string, unknown> }) {
    async function* stream() {
      yield messageUpdated(secondMessage.info)
      yield { type: "session.idle", properties: { sessionID: "ses_1" } }
      await new Promise<void>(() => {})
    }
    return {
      event: { subscribe: async () => ({ stream: stream() }) },
      session: {
        messages: async () => ({ data: [secondMessage] }),
        status: async () => ({ data: {} }),
        promptAsync: async () => ({}),
        abort: async () => ({}),
      },
    } as never
  }

  const advisor = {
    consult: async () => ({ text: "review it", ok: true as const, callId: "call_1" }),
    delivered: async () => {},
  } as never

  const baseInput = (phase: AgentStep) => ({
    phase,
    targetDir: "/repo",
    model: { providerID: "openai", modelID: "gpt-5.5" },
    progress: noopProgress,
    shutdown: trackedShutdown(),
    sessionID: "ses_1",
    loopGuard: new LoopGuard(resolveLoopGuard()),
  })

  test("a read-only phase with an unchanged follow-up keeps the first turn's last parts", async () => {
    const second = completedMessage("msg_2", "NO CHANGES")
    const result = await applyCompletionCheckpoint(
      checkpointClient(second),
      baseInput({ ...agentStep("scope"), readOnly: true }),
      firstResult("first report"),
      advisor,
    )

    // unchanged → the read-only report stays the first turn's findings; the
    // sentinel must not become the report.
    expect(result.lastAssistantParts).toHaveLength(1)
    expect((result.lastAssistantParts[0] as { text: string }).text).toBe("first report")
  })

  test("a read-only phase with a corrected report uses the second turn's last parts", async () => {
    const second = completedMessage("msg_2", "# corrected report")
    const result = await applyCompletionCheckpoint(
      checkpointClient(second),
      baseInput({ ...agentStep("scope"), readOnly: true }),
      firstResult("first report"),
      advisor,
    )

    // a new report replaces the first: read-only uses second.lastAssistantParts.
    expect(result.lastAssistantParts).toHaveLength(1)
    expect((result.lastAssistantParts[0] as { text: string }).text).toBe("# corrected report")
  })

  test("a writable phase with an unchanged follow-up keeps the first turn's last parts", async () => {
    const second = completedMessage("msg_2", "NO CHANGES")
    const result = await applyCompletionCheckpoint(
      checkpointClient(second),
      baseInput(agentStep("implementer")),
      firstResult("first report"),
      advisor,
    )

    // A writing phase keeps both turns' parts (fallback report), but the report
    // extract comes from the first turn: the NO CHANGES sentinel must never
    // become the phase report through the text-fallback channel.
    expect(result.lastAssistantParts).toHaveLength(1)
    expect((result.lastAssistantParts[0] as { text: string }).text).toBe("first report")
    expect(result.parts).toHaveLength(2)
  })
})

describe("applyReportCheckpoint", () => {
  const reportPrepared = {
    attachments: [],
    prompt: "test prompt",
    model: { providerID: "openai", modelID: "gpt-5.5" },
    loopGuard: resolveLoopGuard(),
  }

  async function reportWorkspace(): Promise<Workspace> {
    const dir = await mkdtemp(join(tmpdir(), "convoy-report-checkpoint-"))
    recoveryDirs.push(dir)
    await mkdir(join(dir, "logs"))
    return { dir, runID: "20260724-110022-test" }
  }

  const message = (id: string, text: string) => {
    const info = {
      id,
      sessionID: "ses_1",
      role: "assistant" as const,
      time: { created: 1, completed: 2 },
      parentID: "p",
      modelID: "gpt-5.5",
      providerID: "openai",
      mode: "primary",
      agent: "scope",
      path: { cwd: "/repo", root: "/repo" },
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    return { info, parts: [{ id: `${id}_p`, sessionID: "ses_1", messageID: id, type: "text" as const, text }] }
  }

  const firstResult = (text = "") => {
    const first = message("msg_1", text)
    return { ...first, assistantInfos: [first.info], lastAssistantParts: first.parts } as never
  }

  function reminderClient(first: ReturnType<typeof message>, followUps: ReturnType<typeof message>[]) {
    const waits = followUps.map(() => deferred())
    let prompts = 0
    let subscriptions = 0
    const sessionIDs: string[] = []
    const client = {
      event: {
        subscribe: async () => {
          const index = subscriptions++
          async function* stream() {
            await waits[index]!.promise
            yield { type: "session.idle", properties: { sessionID: "ses_1" } }
            await new Promise<void>(() => {})
          }
          return { stream: stream() }
        },
      },
      session: {
        promptAsync: async ({ sessionID }: { sessionID: string }) => {
          sessionIDs.push(sessionID)
          waits[prompts++]!.resolve()
          return {}
        },
        messages: async () => ({ data: [first, ...followUps.slice(0, prompts)] }),
        status: async () => ({ data: {} }),
        abort: async () => ({}),
      },
    } as never
    return { client, promptCount: () => prompts, sessionIDs }
  }

  const emptyReport = {
    get candidate() {
      return undefined
    },
    write: async () => ({ markdown: "unused" }),
    end: () => {},
  }

  const inputFor = (workspace: Workspace, phase: AgentStep) => ({
    phase,
    workspace,
    targetDir: "/repo",
    model: { providerID: "openai", modelID: "gpt-5.5" },
    progress: noopProgress,
    shutdown: trackedShutdown(),
    sessionID: "ses_1",
    loopGuard: new LoopGuard(resolveLoopGuard()),
  })

  test("never nudges a phase whose contract explicitly owns no deliverable", async () => {
    let prompts = 0
    const client = {
      session: {
        promptAsync: async () => {
          prompts++
          return {}
        },
      },
    } as never
    const workspace = await reportWorkspace()
    const phase = { ...agentStep("scope"), deliverableContract: { kind: "none" } as const }
    const first = firstResult()

    const result = await applyReportCheckpoint(client, inputFor(workspace, phase), first, emptyReport as never)

    // A `none` contract stays an explicit opt-out: no report, no reminders.
    expect(result).toBe(first)
    expect(prompts).toBe(0)
  })

  test("does not nudge when write_report already persisted a valid report", async () => {
    let prompts = 0
    const first = {
      info: { id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1, completed: 2 } },
      parts: [],
      assistantInfos: [],
      lastAssistantParts: [],
    } as never
    const report = {
      candidate: "# Findings\n\nNo blockers.",
      write: async () => ({ markdown: "unused" }),
      end: () => {},
    }

    const result = await applyReportCheckpoint(
      { session: { promptAsync: async () => { prompts++; return {} } } } as never,
      {
        phase: { ...agentStep("scope"), readOnly: true, deliverableContract: { kind: "markdown-report" } },
        workspace: { dir: "/run", runID: "test-run" },
        targetDir: "/repo",
        model: { providerID: "openai", modelID: "gpt-5.5" },
        progress: noopProgress,
        shutdown: trackedShutdown(),
        sessionID: "ses_1",
        loopGuard: new LoopGuard(resolveLoopGuard()),
      },
      first,
      report as never,
    )

    expect(result).toBe(first)
    expect(prompts).toBe(0)
  })

  test("sends exactly two same-session reminders before accepting valid chat fallback", async () => {
    const workspace = await reportWorkspace()
    const phase = { ...agentStep("scope"), readOnly: true, deliverableContract: { kind: "markdown-report" } as const }
    const first = firstResult()
    const reminders = reminderClient(first, [message("msg_2", "still working"), message("msg_3", "# Fallback report\n\nSaved in chat only.")])

    const result = await applyReportCheckpoint(reminders.client, inputFor(workspace, phase), first, emptyReport as never)

    expect(reminders.promptCount()).toBe(2)
    expect(reminders.sessionIDs).toEqual(["ses_1", "ses_1"])
    expect(extractAssistantText(result.lastAssistantParts)).toContain("Fallback report")
  })

  test("sends two reminders then lets empty fallback reach the normal user gate", async () => {
    const workspace = await reportWorkspace()
    const phase = { ...agentStep("scope"), readOnly: true, deliverableContract: { kind: "markdown-report" } as const }
    const first = firstResult()
    const reminders = reminderClient(first, [message("msg_2", ""), message("msg_3", "")])
    const gates: HumanReviewPromptInfo[] = []
    const progress: ProgressUI = {
      ...noopProgress,
      askHumanReview: (info) => {
        gates.push(info)
        // First [c] has no report to deliver; the gate reopens. Aborting after
        // that proves the step did not silently advance past an empty deliverable.
        return Promise.resolve(gates.length === 1 ? "continue" : "abort")
      },
    }

    await expect(
      runPhaseUntilResolved(
        reminders.client,
        workspace,
        phase,
        "/repo",
        reportPrepared,
        { head: "baseline" },
        progress,
        trackedShutdown(),
        createGitLock(),
        { serverUrl: "http://127.0.0.1:1" },
        {
          runPhaseAttempt: async () => {
            const checkpoint = await applyReportCheckpoint(reminders.client, inputFor(workspace, phase), first, emptyReport as never)
            return extractAssistantText(checkpoint.lastAssistantParts)
          },
          restorePhaseBaseline: async () => {},
        },
      ),
    ).rejects.toThrow(UserAbortError)

    expect(reminders.promptCount()).toBe(2)
    expect(reminders.sessionIDs).toEqual(["ses_1", "ses_1"])
    // An empty fallback reaches the failure gate once, and a continue without a
    // valid report reopens it with the validation error instead of advancing.
    expect(gates).toHaveLength(2)
    expect(gates[0]).toMatchObject({ kind: "failure", error: "phase produced an empty report" })
    expect(gates[1]).toMatchObject({ kind: "failure", error: "phase produced an empty report" })
  })
})

describe("PhaseGroupError", () => {
  test("formats all failures into a single message", () => {
    const error = new PhaseGroupError([
      { name: "design", error: new Error("model timeout") },
      { name: "implementer", error: "provider unavailable" },
    ])
    expect(error.name).toBe("PhaseGroupError")
    expect(error.message).toContain("[design]")
    expect(error.message).toContain("model timeout")
    expect(error.message).toContain("[implementer]")
    expect(error.message).toContain("provider unavailable")
  })

  test("preserves the failures array", () => {
    const failures = [{ name: "design", error: new Error("boom") }]
    const error = new PhaseGroupError(failures)
    expect(error.failures).toEqual(failures)
  })

  test("handles empty failures", () => {
    const error = new PhaseGroupError([])
    expect(error.message).toBe("")
    expect(error.failures).toEqual([])
  })
})

describe("isUserAbortError", () => {
  test("returns true for UserAbortError instance", () => {
    expect(isUserAbortError(new UserAbortError())).toBe(true)
  })

  test("returns true for UserAbortError with custom message", () => {
    expect(isUserAbortError(new UserAbortError("custom abort"))).toBe(true)
  })

  test("returns true for Error with UserAbortError name", () => {
    const error = new Error("wrapped abort")
    Object.defineProperty(error, "name", { value: "UserAbortError" })
    expect(isUserAbortError(error)).toBe(true)
  })

  test("returns false for plain Error", () => {
    expect(isUserAbortError(new Error("some error"))).toBe(false)
  })

  test("returns false for non-Error values", () => {
    expect(isUserAbortError("aborted")).toBe(false)
    expect(isUserAbortError(null)).toBe(false)
    expect(isUserAbortError(undefined)).toBe(false)
    expect(isUserAbortError(42)).toBe(false)
    expect(isUserAbortError({})).toBe(false)
  })
})

describe("isIgnorableRejection", () => {
  test("returns true for UserAbortError", () => {
    expect(isIgnorableRejection(new UserAbortError())).toBe(true)
  })

  test("returns true for AbortError by name", () => {
    const error = new Error("The operation was aborted")
    error.name = "AbortError"
    expect(isIgnorableRejection(error)).toBe(true)
  })

  test("returns true for error with 'aborted' in message", () => {
    expect(isIgnorableRejection(new Error("request was aborted"))).toBe(true)
  })

  test("returns true for errors containing 'aborted' or 'aborte'", () => {
    expect(isIgnorableRejection(new Error("user aborted"))).toBe(true)
    expect(isIgnorableRejection(new Error("aborted by kernel"))).toBe(true)
  })

  test("returns false for regular errors", () => {
    expect(isIgnorableRejection(new Error("Cannot read properties of undefined"))).toBe(false)
    expect(isIgnorableRejection(new TypeError("boom"))).toBe(false)
  })

  test("returns false for non-Error values", () => {
    expect(isIgnorableRejection("aborted")).toBe(false)
    expect(isIgnorableRejection(undefined)).toBe(false)
    expect(isIgnorableRejection(null)).toBe(false)
    expect(isIgnorableRejection(42)).toBe(false)
  })
})

describe("RunShutdown methods", () => {
  test("signal returns an AbortSignal", () => {
    const shutdown = trackedShutdown()
    expect(shutdown.signal).toBeInstanceOf(Object)
    expect(shutdown.signal.aborted).toBe(false)
    shutdown.dispose()
  })

  test("aborted reflects the underlying controller state", () => {
    const shutdown = trackedShutdown()
    expect(shutdown.aborted).toBe(false)
    shutdown.dispose()
  })

  test("abortError returns UserAbortError when no reason is set", () => {
    const shutdown = trackedShutdown()
    const error = shutdown.abortError()
    expect(isUserAbortError(error)).toBe(true)
    shutdown.dispose()
  })

  test("abortError returns the signal reason when it is a UserAbortError", () => {
    const shutdown = trackedShutdown()
    const signal = shutdown.signal
    const err = new UserAbortError("test abort")
    // Manually abort the controller to set the reason
    const controller = new AbortController()
    controller.abort(err)
    expect(isUserAbortError(controller.signal.reason)).toBe(true)
    shutdown.dispose()
  })

  test("abortError falls back to fallback when available", () => {
    const shutdown = trackedShutdown()
    const fallback = new UserAbortError("fallback")
    const error = shutdown.abortError(fallback)
    expect(isUserAbortError(error)).toBe(true)
    expect((error as Error).message).toBe("fallback")
    shutdown.dispose()
  })

  test("throwIfRequested does not throw before abort", () => {
    const shutdown = trackedShutdown()
    expect(() => shutdown.throwIfRequested()).not.toThrow()
    shutdown.dispose()
  })

  test("setActiveSession and clearActiveSession manage session map", async () => {
    const shutdown = trackedShutdown()
    const session = {
      client: {} as never,
      sessionID: "ses_1",
      directory: "/tmp",
      phaseName: "design",
    }
    shutdown.setActiveSession(session)
    // Wrong sessionID for the phase: should not clear
    shutdown.clearActiveSession("design", "ses_wrong")
    // Correct sessionID: should clear
    shutdown.clearActiveSession("design", "ses_1")
    // Clearing again is a no-op
    shutdown.clearActiveSession("design", "ses_1")
    shutdown.dispose()
  })

  test("abortActiveSessions resolves when no sessions are tracked", async () => {
    const shutdown = trackedShutdown()
    await shutdown.abortActiveSessions()
    shutdown.dispose()
  })
})

describe("RunControl state management", () => {
  function metadataFor(state: "running" | "pausing" | "paused") {
    let current = state
    return {
      controlState: () => current,
      setControlState: async (next: typeof current) => {
        current = next
      },
    } as unknown as RunMetadataStore
  }

  test("starts in controlState from metadata", () => {
    const control = new RunControl(metadataFor("paused"))
    expect(control).toBeDefined()
  })

  test("requestPause is a no-op when already paused", async () => {
    const meta = metadataFor("paused")
    const setCalls: string[] = []
    const spy = {
      controlState: () => "paused" as const,
      setControlState: async (next: string) => { setCalls.push(next) },
    } as unknown as RunMetadataStore
    const control = new RunControl(spy)
    await control.requestPause()
    expect(setCalls).toEqual([])
  })

  test("requestPause is a no-op when already pausing", async () => {
    const meta = metadataFor("pausing")
    const setCalls: string[] = []
    const spy = {
      controlState: () => "pausing" as const,
      setControlState: async (next: string) => { setCalls.push(next) },
    } as unknown as RunMetadataStore
    const control = new RunControl(spy)
    await control.requestPause()
    expect(setCalls).toEqual([])
  })

  test("resume is a no-op when already running", async () => {
    const meta = metadataFor("running")
    const setCalls: string[] = []
    const spy = {
      controlState: () => "running" as const,
      setControlState: async (next: string) => { setCalls.push(next) },
    } as unknown as RunMetadataStore
    const control = new RunControl(spy)
    await control.resume()
    expect(setCalls).toEqual([])
  })

  test("toggle switches between running and paused", async () => {
    let state = "running" as "running" | "paused"
    const persisted: string[] = []
    const meta = {
      controlState: () => state,
      setControlState: async (next: typeof state) => {
        state = next
        persisted.push(next)
      },
    } as unknown as RunMetadataStore
    const control = new RunControl(meta)

    await control.toggle()
    expect(state).toBe("paused")
    expect(persisted).toEqual(["paused"])

    await control.toggle()
    expect(state).toBe("running")
    expect(persisted).toEqual(["paused", "running"])
  })

  test("awaitRunnable resolves immediately when state is running", async () => {
    const control = new RunControl(metadataFor("running"))
    await control.awaitRunnable()
  })

  test("awaitRunnable rejects when signal is already aborted", async () => {
    const control = new RunControl(metadataFor("paused"))
    const controller = new AbortController()
    controller.abort(new UserAbortError("already aborted"))
    await expect(control.awaitRunnable(controller.signal)).rejects.toThrow("already aborted")
  })

  test("publish calls runControlState on bound progress", async () => {
    const calls: { state: string; active: number }[] = []
    const control = new RunControl(metadataFor("running"))
    control.bind({
      ...noopProgress,
      runControlState: (state, active) => calls.push({ state, active }),
    })
    expect(calls).toContainEqual({ state: "running", active: 0 })
  })
})

describe("planBatches edge cases", () => {
  const agent = (name: string, groupId = `g-${name}`): AgentStep => ({
    type: "agent",
    name,
    agentName: name,
    description: name,
    model: "openai/gpt-4",
    inputFiles: [],
    inputDiff: false,
    reportPath: `reports/${name}.md`,
    groupId,
    stepName: name,
  })

  test("single step returns one batch", () => {
    expect(planBatches([agent("design")])).toEqual([[agent("design")]])
  })

  test("no steps returns empty array", () => {
    expect(planBatches([])).toEqual([])
  })

  test("human step is always its own batch", () => {
    const human = { type: "human" as const, name: "review", description: "review" }
    expect(planBatches([human])).toEqual([[human]])
  })

  test("agents with matching groupId batch together", () => {
    const a = agent("a", "g1")
    const b = agent("b", "g1")
    const c = agent("c", "g1")
    expect(planBatches([a, b, c])).toEqual([[a, b, c]])
  })

  test("human gate splits groupId continuity", () => {
    const before = agent("a", "g1")
    const human = { type: "human" as const, name: "review", description: "review" }
    const after = agent("b", "g1")
    expect(planBatches([before, human, after])).toEqual([[before], [human], [after]])
  })

  test("adjacent but different groupIds are separate batches", () => {
    const a = agent("a", "g1")
    const b = agent("b", "g2")
    expect(planBatches([a, b])).toEqual([[a], [b]])
  })
})

describe("createConcurrencyLimiter edge cases", () => {
  test("single job runs immediately", async () => {
    const limit = createConcurrencyLimiter(1)
    let ran = false
    await limit(async () => { ran = true })
    expect(ran).toBe(true)
  })

  test("empty queue resolves no extra jobs", async () => {
    const limit = createConcurrencyLimiter(5)
    expect(limit).toBeDefined()
  })

  test("jobs are drained in FIFO order", async () => {
    const limit = createConcurrencyLimiter(1)
    const order: number[] = []
    const releaseFirst = deferred()
    const firstStarted = deferred()
    const jobs = [
      limit(async () => {
        order.push(1)
        firstStarted.resolve()
        await releaseFirst.promise
      }),
      limit(async () => {
        order.push(2)
      }),
      limit(async () => {
        order.push(3)
      }),
    ]
    await firstStarted.promise
    expect(order).toEqual([1])
    releaseFirst.resolve()
    await Promise.all(jobs)
    expect(order).toEqual([1, 2, 3])
  })

  test("limit of 1 serializes all work", async () => {
    const limit = createConcurrencyLimiter(1)
    const release = deferred()
    let running = 0
    let peak = 0
    const job = () =>
      limit(async () => {
        running++
        peak = Math.max(peak, running)
        await release.promise
        running--
      })
    const jobs = Array.from({ length: 5 }, job)
    expect(running).toBe(1)
    release.resolve()
    await Promise.all(jobs)
    expect(peak).toBe(1)
  })
})

/**
 * Transcript backfill: a dashboard that attaches mid-run reconstructs a
 * session's earlier output from the live server and merges it with the live
 * stream. The fakes delay `session.messages` so the buffered live chunks and
 * the fetched history deterministically straddle the server's snapshot — the
 * race the merge must resolve without duplicates.
 */
describe("watchSession transcript backfill", () => {
  const assistantMessage = (id: string, text: string, opts: { completed?: boolean; parts?: unknown[] } = {}) => ({
    info: {
      id,
      sessionID: "ses_1",
      role: "assistant" as const,
      time: opts.completed === false ? { created: 1 } : { created: 1, completed: 2 },
      parentID: "p",
      modelID: "gpt-5.6-sol",
      providerID: "openai",
      mode: "primary",
      agent: "implementer",
      path: { cwd: "/repo", root: "/repo" },
      cost: 0.1,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts:
      opts.parts ??
      [{ id: `${id}_p`, sessionID: "ses_1", messageID: id, type: "text" as const, text }],
  })

  const textDelta = (messageID: string, partID: string, delta: string) => ({
    type: "message.part.delta",
    properties: { sessionID: "ses_1", messageID, partID, field: "text", delta },
  })

  function backfillClient(liveUpdates: unknown[], messages: unknown[], delayMs = 0) {
    const chunks: { channel: string; text: string; partID?: string }[] = []
    async function* stream() {
      for (const update of liveUpdates) yield update
      await new Promise<void>(() => {})
    }
    const client = {
      event: { subscribe: async () => ({ stream: stream() }) },
      session: {
        messages: async () => {
          if (delayMs > 0) await Bun.sleep(delayMs)
          return { data: messages }
        },
        status: async () => ({ data: {} }),
      },
    } as never
    const progress: ProgressUI = {
      ...noopProgress,
      phaseMessage: (_name, message) => void chunks.push(message),
    }
    const watcher = watchSession(client, {
      directory: "/repo",
      phaseName: "build",
      sessionID: "ses_1",
      progress,
      signal: new AbortController().signal,
      backfill: true,
    })
    return { watcher, chunks }
  }

  const until = async (chunks: unknown[], count: number) => {
    for (let attempt = 0; attempt < 200 && chunks.length < count; attempt++) await Bun.sleep(5)
  }

  test("history and live merge without duplication, history first", async () => {
    const { watcher, chunks } = backfillClient(
      [textDelta("msg_2", "p2", "NO"), textDelta("msg_2", "p2", " CHANGES")],
      [assistantMessage("msg_1", "first report")],
    )
    try {
      await until(chunks, 3)
      expect(chunks).toEqual([
        { channel: "response", text: "first report", partID: "msg_1_p" },
        { channel: "response", text: "NO", partID: "p2" },
        { channel: "response", text: " CHANGES", partID: "p2" },
      ])
    } finally {
      await watcher.stop()
    }
  })

  test("buffered deltas straddling the snapshot continue the part instead of duplicating it", async () => {
    // History holds the response up to the snapshot ("hello world"); the
    // buffer holds the deltas since subscription: the snapshot's tail ("world"
    // — or just "ld", depending on when the subscribe landed) plus the part's
    // continuation ("!"). The merged transcript reads "hello world!" exactly
    // once — even when the part began streaming before the subscription, so
    // the buffer only ever held its tail.
    for (const buffered of [["world", "!"], ["ld", "!"]]) {
      const { watcher, chunks } = backfillClient(
        buffered.map((delta) => textDelta("msg_1", "p1", delta)),
        [assistantMessage("msg_1", "", { completed: false, parts: [{ id: "p1", sessionID: "ses_1", messageID: "msg_1", type: "text" as const, text: "hello world" }] })],
        40,
      )
      try {
        await until(chunks, 2)
        expect(chunks).toHaveLength(2)
        expect(chunks[0]).toEqual({ channel: "response", text: "hello world", partID: "p1" })
        // Whatever the snapshot already covered was trimmed from the buffer;
        // only the continuation survives it.
        expect(chunks[1]!.text).toBe("!")
        expect(chunks.map((chunk) => chunk.text).join("")).toBe("hello world!")
      } finally {
        await watcher.stop()
      }
    }
  })

  test("a completed message's stale delta is dropped, not doubled", async () => {
    const { watcher, chunks } = backfillClient(
      [textDelta("msg_1", "msg_1_p", "more")],
      [assistantMessage("msg_1", "done")],
    )
    try {
      await Bun.sleep(60)
      expect(chunks).toEqual([{ channel: "response", text: "done", partID: "msg_1_p" }])
    } finally {
      await watcher.stop()
    }
  })

  test("tool markers dedupe against history by call id", async () => {
    const { watcher, chunks } = backfillClient(
      [
        { type: "session.next.tool.called", properties: { sessionID: "ses_1", assistantMessageID: "msg_1", callID: "call_1", tool: "read", input: { filePath: "src/a.ts" } } },
        { type: "session.next.shell.started", properties: { sessionID: "ses_1", assistantMessageID: "msg_1", callID: "call_2", command: "bun test" } },
      ],
      [
        assistantMessage("msg_1", "", {
          completed: false,
          parts: [{ id: "tp1", sessionID: "ses_1", messageID: "msg_1", type: "tool" as const, callID: "call_1", tool: "read", state: { status: "completed", input: { filePath: "src/a.ts" }, output: "ok", title: "", metadata: {} } }],
        }),
      ],
      40,
    )
    try {
      await until(chunks, 2)
      expect(chunks).toEqual([
        { channel: "tool", text: "read: src/a.ts" },
        { channel: "bash", text: "bun test" },
      ])
    } finally {
      await watcher.stop()
    }
  })

  test("a server that cannot answer leaves the live stream flowing", async () => {
    const chunks: { channel: string; text: string; partID?: string }[] = []
    async function* stream() {
      yield textDelta("msg_1", "p1", "fresh text")
      await new Promise<void>(() => {})
    }
    const client = {
      event: { subscribe: async () => ({ stream: stream() }) },
      session: {
        messages: async () => {
          throw new Error("server gone")
        },
        status: async () => ({ data: {} }),
      },
    } as never
    const progress: ProgressUI = { ...noopProgress, phaseMessage: (_name, message) => void chunks.push(message) }
    const watcher = watchSession(client, {
      directory: "/repo",
      phaseName: "build",
      sessionID: "ses_1",
      progress,
      signal: new AbortController().signal,
      backfill: true,
    })
    try {
      await until(chunks, 1)
      expect(chunks).toEqual([{ channel: "response", text: "fresh text", partID: "p1" }])
    } finally {
      await watcher.stop()
    }
  })

  test("a cancelled attach's in-flight backfill delivers nothing, even when history resolves late", async () => {
    // The owning attach was torn down while the fetch was pending (a reset
    // replaced the view): neither the fetched history nor the buffered live
    // deltas may reach the dashboard — the next run can reuse the phase name,
    // and stale transcript content would suppress its correct backfill.
    let resolveMessages: (value: { data: unknown[] }) => void = () => {}
    const chunks: { channel: string; text: string; partID?: string }[] = []
    let cancelled = false
    async function* stream() {
      yield textDelta("msg_2", "p2", "live delta")
      await new Promise<void>(() => {})
    }
    const client = {
      event: { subscribe: async () => ({ stream: stream() }) },
      session: { messages: () => new Promise<{ data: unknown[] }>((resolve) => { resolveMessages = resolve }), status: async () => ({ data: {} }) },
    } as never
    const progress: ProgressUI = { ...noopProgress, phaseMessage: (_name, message) => void chunks.push(message) }
    const watcher = watchSession(client, {
      directory: "/repo",
      phaseName: "build",
      sessionID: "ses_1",
      progress,
      signal: new AbortController().signal,
      backfill: true,
      isCancelled: () => cancelled,
    })
    try {
      // The live delta is buffered while the fetch is pending; nothing emits.
      await Bun.sleep(20)
      expect(chunks).toEqual([])

      cancelled = true
      resolveMessages({ data: [assistantMessage("msg_1", "stale history")] })
      await Bun.sleep(40)
      // The late-arriving history and the dropped buffer both stay silent.
      expect(chunks).toEqual([])
    } finally {
      await watcher.stop()
    }
  })

  test("a same-run watcher stop does not cancel the in-flight backfill", async () => {
    // The phase finalized while its fetch was in flight — the common eager
    // case — and the attach never stopped: the history still delivers.
    let resolveMessages: (value: { data: unknown[] }) => void = () => {}
    const chunks: { channel: string; text: string; partID?: string }[] = []
    async function* stream() {
      await new Promise<void>(() => {})
    }
    const client = {
      event: { subscribe: async () => ({ stream: stream() }) },
      session: { messages: () => new Promise<{ data: unknown[] }>((resolve) => { resolveMessages = resolve }), status: async () => ({ data: {} }) },
    } as never
    const progress: ProgressUI = { ...noopProgress, phaseMessage: (_name, message) => void chunks.push(message) }
    const watcher = watchSession(client, {
      directory: "/repo",
      phaseName: "build",
      sessionID: "ses_1",
      progress,
      signal: new AbortController().signal,
      backfill: true,
      isCancelled: () => false,
    })
    try {
      resolveMessages({ data: [assistantMessage("msg_1", "late but wanted")] })
      await until(chunks, 1)
      expect(chunks).toEqual([{ channel: "response", text: "late but wanted", partID: "msg_1_p" }])
    } finally {
      await watcher.stop()
    }
  })
})
