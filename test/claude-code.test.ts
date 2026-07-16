import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "bun:test"

import {
  claudeArgs,
  claudeModelLabel,
  claudePrompt,
  claudeResumeArgs,
  claudeTokens,
  describeClaudeEvent,
  ensureClaudeAvailable,
  ndjsonLines,
  newClaudeStreamState,
  pipelineUsesClaudeCode,
  promptClaudePhase,
  stageClaudeAttachments,
} from "../src/claude-code"
import { builtInAgents, resolvePipeline, type PipelineSpec } from "../src/pipeline"
import { noopProgress, type ProgressUsage } from "../src/progress"
import type { AgentStep } from "../src/types"

const resolve = (spec: PipelineSpec) => resolvePipeline({ name: "test", spec, agents: builtInAgents })

const claudePipeline = resolve({
  steps: [
    { agent: "review-scope", name: "scope", model: "openai/gpt-5.5#xhigh", reports: "none", diff: true },
    { agent: "security-reviewer", name: "external-security", runner: "claude-code", model: "opus", reports: ["scope"] },
  ],
})

const opencodePipeline = resolve({ steps: [{ agent: "bug-auditor", name: "bugs", reports: "none", diff: true }] })

const claudePhase: AgentStep = {
  type: "agent",
  name: "security",
  stepName: "security",
  groupId: "g1",
  agentName: "security-reviewer",
  description: "Review security",
  model: "opus",
  runner: "claude-code",
  inputFiles: [],
  inputDiff: true,
  reportPath: "reports/security.md",
  readOnly: true,
}

function textStream(...lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`))
      controller.close()
    },
  })
}

function executionShutdown(controller: AbortController) {
  return {
    signal: controller.signal,
    get aborted() {
      return controller.signal.aborted
    },
    throwIfRequested() {
      if (controller.signal.aborted) throw new Error("aborted")
    },
    abortError() {
      return new Error("aborted")
    },
  }
}

async function executionDir() {
  const dir = await mkdtemp(join(tmpdir(), "archer-claude-execution-"))
  await mkdir(join(dir, "logs"), { recursive: true })
  return dir
}

describe("optional dependency check", () => {
  test("a pipeline without claude-code steps never looks for the binary", () => {
    let asked = false
    ensureClaudeAvailable(opencodePipeline, () => {
      asked = true
      return null
    })
    expect(asked).toBe(false)
  })

  test("fails fast, naming the offending steps, when the binary is missing", () => {
    expect(() => ensureClaudeAvailable(claudePipeline, () => null)).toThrow(/external-security/)
    expect(() => ensureClaudeAvailable(claudePipeline, () => null)).toThrow(/claude.*not found in PATH/)
  })

  test("passes silently when the binary exists", () => {
    ensureClaudeAvailable(claudePipeline, () => "/usr/local/bin/claude")
  })

  test("pipelineUsesClaudeCode detects runner steps", () => {
    expect(pipelineUsesClaudeCode(claudePipeline)).toBe(true)
    expect(pipelineUsesClaudeCode(opencodePipeline)).toBe(false)
  })
})

describe("stream-json adapter", () => {
  test("system/init yields the session id", () => {
    const signals = describeClaudeEvent(
      { type: "system", subtype: "init", session_id: "abc-123", model: "claude-opus-4-8" },
      newClaudeStreamState(),
    )
    expect(signals).toEqual([{ type: "session", sessionID: "abc-123" }])
  })

  test("text deltas stream to the response channel with a pulse status line", () => {
    const state = newClaudeStreamState()
    const signals = describeClaudeEvent(
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } } },
      state,
    )
    expect(signals[0]).toEqual({ type: "message", message: { channel: "response", text: "Hello" } })
    expect(signals[1]).toMatchObject({ type: "activity", kind: "write", pulse: true })
    expect(state.textChars).toBe(5)
  })

  test("thinking deltas stream to the reasoning channel", () => {
    const state = newClaudeStreamState()
    const signals = describeClaudeEvent(
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm…" } } },
      state,
    )
    expect(signals[0]).toEqual({ type: "message", message: { channel: "reasoning", text: "hmm…" } })
    expect(signals[1]).toMatchObject({ type: "activity", kind: "think", pulse: true })
  })

  test("assistant messages contribute one-line tool markers only (text already streamed)", () => {
    const signals = describeClaudeEvent(
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Let me look." },
            { type: "tool_use", name: "Read", input: { file_path: "/repo/src/auth.py" } },
            { type: "tool_use", name: "Grep", input: { pattern: "password" } },
          ],
        },
      },
      newClaudeStreamState(),
    )
    expect(signals).toEqual([
      { type: "activity", message: "tool: Read /repo/src/auth.py", kind: "tool" },
      { type: "message", message: { channel: "tool", text: "tool: Read /repo/src/auth.py" } },
      { type: "activity", message: "tool: Grep password", kind: "tool" },
      { type: "message", message: { channel: "tool", text: "tool: Grep password" } },
    ])
  })

  test("a success result carries text, cost, and normalized tokens", () => {
    const signals = describeClaudeEvent(
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "# Security report\n\nNo findings.",
        total_cost_usd: 0.42,
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100 },
      },
      newClaudeStreamState(),
    )
    expect(signals).toEqual([
      {
        type: "result",
        subtype: "success",
        text: "# Security report\n\nNo findings.",
        cost: 0.42,
        tokens: { input: 1000, output: 200, reasoning: 0, cacheRead: 5000, cacheWrite: 100, total: 6300 },
        isError: false,
      },
    ])
  })

  test("an error result is marked as such", () => {
    const signals = describeClaudeEvent(
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        total_cost_usd: 0.25,
        usage: { input_tokens: 100, output_tokens: 20 },
      },
      newClaudeStreamState(),
    )
    expect(signals[0]).toMatchObject({
      type: "result",
      isError: true,
      subtype: "error_during_execution",
      cost: 0.25,
      tokens: { input: 100, output: 20, total: 120 },
    })
  })

  test("unknown or malformed events are ignored", () => {
    const state = newClaudeStreamState()
    expect(describeClaudeEvent(null, state)).toEqual([])
    expect(describeClaudeEvent("noise", state)).toEqual([])
    expect(describeClaudeEvent({ type: "user" }, state)).toEqual([])
    expect(describeClaudeEvent({ type: "stream_event", event: {} }, state)).toEqual([])
  })
})

describe("claudeTokens", () => {
  test("returns undefined for empty or absent usage", () => {
    expect(claudeTokens(undefined)).toBeUndefined()
    expect(claudeTokens({})).toBeUndefined()
    expect(claudeTokens({ input_tokens: 0, output_tokens: 0 })).toBeUndefined()
  })
})

describe("prompt and args assembly", () => {
  test("attachments become an absolute-path reading list", () => {
    const prompt = claudePrompt("# Phase", [
      { type: "file", url: "file:///runs/r1/prd.md", filename: "prd.md", mime: "text/plain" },
      { type: "file", url: "file:///runs/r1/reports/scope.md", filename: "scope.md", mime: "text/plain" },
    ])
    expect(prompt).toContain("# Phase")
    expect(prompt).toContain("- /runs/r1/prd.md")
    expect(prompt).toContain("- /runs/r1/reports/scope.md")
  })

  test("no attachments leaves the prompt untouched", () => {
    expect(claudePrompt("# Phase", [])).toBe("# Phase")
  })

  test("args are headless, streaming, read-only, and workspace-scoped", () => {
    const args = claudeArgs({ systemPromptPath: "/runs/r1/prompts/security.md", runDir: "/runs/r1", targetDir: "/repo", model: "opus", attachments: [] })
    expect(args).toContain("-p")
    expect(args).toContain("stream-json")
    expect(args).toContain("--include-partial-messages")
    expect(args).not.toContain("--append-system-prompt")
    expect(args[args.indexOf("--append-system-prompt-file") + 1]).toBe("/runs/r1/prompts/security.md")
    expect(args[args.indexOf("--add-dir") + 1]).toBe("/runs/r1")
    expect(args).toContain("--safe-mode")
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep")
    expect(args).not.toContain("--allowedTools")
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain("Bash")
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk")
    expect(args[args.indexOf("--model") + 1]).toBe("opus")
  })

  test("an empty model omits --model so the CLI default applies", () => {
    expect(claudeArgs({ systemPromptPath: "/r/prompt.md", runDir: "/r", targetDir: "/repo", model: "", attachments: [] })).not.toContain("--model")
  })

  test("external file attachments never expose their parent directory", () => {
    const args = claudeArgs({
      systemPromptPath: "/runs/r1/prompt.md",
      runDir: "/runs/r1",
      targetDir: "/repo",
      model: "opus",
      attachments: [{ type: "file", url: "file:///external/specs/api.md", filename: "api.md", mime: "text/markdown" }],
    })

    expect(args).not.toContain("/external/specs")
  })

  test("external directory attachments expose only that directory, not its parent", () => {
    const args = claudeArgs({
      systemPromptPath: "/runs/r1/prompt.md",
      runDir: "/runs/r1",
      targetDir: "/repo",
      model: "opus",
      attachments: [{ type: "file", url: "file:///external/review-input", filename: "review-input", mime: "application/x-directory" }],
    })

    expect(args).toContain("/external/review-input")
    expect(args).not.toContain("/external")
  })

  test("external file attachments are copied into the isolated run directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "archer-claude-attachments-"))
    const externalDir = join(root, "external")
    const runDir = join(root, "run")
    const targetDir = join(root, "repo")
    await Promise.all([mkdir(externalDir), mkdir(runDir), mkdir(targetDir)])
    const externalFile = join(externalDir, "api.md")
    await writeFile(externalFile, "API contract")

    try {
      const staged = await stageClaudeAttachments(
        [{ type: "file", url: new URL(`file://${externalFile}`).href, filename: "api.md", mime: "text/markdown" }],
        targetDir,
        runDir,
        join(runDir, "attachments", "security", "1"),
      )
      const stagedPath = fileURLToPath(staged[0]!.url)

      expect(stagedPath.startsWith(join(runDir, "attachments"))).toBe(true)
      expect(await readFile(stagedPath, "utf8")).toBe("API contract")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("parallel phases stage duplicate filenames in isolated directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "archer-claude-parallel-"))
    const runDir = join(root, "run")
    const targetDir = join(root, "repo")
    const firstDir = join(root, "first")
    const secondDir = join(root, "second")
    await Promise.all([mkdir(runDir), mkdir(targetDir), mkdir(firstDir), mkdir(secondDir)])
    await Promise.all([writeFile(join(firstDir, "scope.md"), "first"), writeFile(join(secondDir, "scope.md"), "second")])

    try {
      const attachment = (path: string) => ({ type: "file" as const, url: new URL(`file://${path}`).href, filename: "scope.md", mime: "text/markdown" })
      const [first, second] = await Promise.all([
        stageClaudeAttachments([attachment(join(firstDir, "scope.md"))], targetDir, runDir, join(runDir, "attachments", "bugs", "1")),
        stageClaudeAttachments([attachment(join(secondDir, "scope.md"))], targetDir, runDir, join(runDir, "attachments", "security", "1")),
      ])
      const firstPath = fileURLToPath(first[0]!.url)
      const secondPath = fileURLToPath(second[0]!.url)

      expect(firstPath).not.toBe(secondPath)
      expect(await readFile(firstPath, "utf8")).toBe("first")
      expect(await readFile(secondPath, "utf8")).toBe("second")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("headless execution lifecycle", () => {
  test("kills a child when abort lands while attachments are being staged", async () => {
    const runDir = await executionDir()
    const targetDir = await mkdtemp(join(tmpdir(), "archer-claude-target-"))
    const controller = new AbortController()
    let kills = 0

    try {
      await expect(
        promptClaudePhase({
          phase: claudePhase,
          workspace: { dir: runDir, runID: "test" },
          targetDir,
          prompt: "Review",
          attachments: [],
          attempt: 1,
          progress: noopProgress,
          shutdown: executionShutdown(controller),
          deps: {
            async stageAttachments() {
              controller.abort()
              return []
            },
            spawn() {
              return {
                stdout: textStream(),
                stderr: textStream(),
                exited: Promise.resolve(1),
                exitCode: 1,
                kill() {
                  kills++
                },
              }
            },
          },
        }),
      ).rejects.toThrow("aborted")
      expect(kills).toBe(1)
    } finally {
      await Promise.all([rm(runDir, { recursive: true, force: true }), rm(targetDir, { recursive: true, force: true })])
    }
  })

  test("persists the raw stream when Claude exits before a result", async () => {
    const runDir = await executionDir()
    const targetDir = await mkdtemp(join(tmpdir(), "archer-claude-target-"))
    const rawEvent = JSON.stringify({ type: "system", subtype: "init", session_id: "session-raw" })

    try {
      await expect(
        promptClaudePhase({
          phase: claudePhase,
          workspace: { dir: runDir, runID: "test" },
          targetDir,
          prompt: "Review",
          attachments: [],
          attempt: 2,
          progress: noopProgress,
          shutdown: executionShutdown(new AbortController()),
          deps: {
            async stageAttachments(attachments) {
              return [...attachments]
            },
            spawn() {
              return { stdout: textStream(rawEvent), stderr: textStream("fatal"), exited: Promise.resolve(1), exitCode: 1, kill() {} }
            },
          },
        }),
      ).rejects.toThrow("before reporting a result")
      expect(await readFile(join(runDir, "logs", "security.2.claude.jsonl"), "utf8")).toBe(`${rawEvent}\n`)
      if (process.platform !== "win32") {
        expect((await stat(join(runDir, "logs", "security.2.claude.jsonl"))).mode & 0o777).toBe(0o600)
        expect((await stat(join(runDir, "prompts", "security.2.claude.md"))).mode & 0o777).toBe(0o600)
      }
    } finally {
      await Promise.all([rm(runDir, { recursive: true, force: true }), rm(targetDir, { recursive: true, force: true })])
    }
  })

  test("streams raw events to disk before Claude exits", async () => {
    const runDir = await executionDir()
    const targetDir = await mkdtemp(join(tmpdir(), "archer-claude-target-"))
    const rawEvent = JSON.stringify({ type: "system", subtype: "init", session_id: "session-live" })
    let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined
    let resolveExit: ((code: number) => void) | undefined
    let exitCode: number | null = null
    let markSpawned: (() => void) | undefined
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve
    })

    try {
      const execution = promptClaudePhase({
        phase: claudePhase,
        workspace: { dir: runDir, runID: "test" },
        targetDir,
        prompt: "Review",
        attachments: [],
        attempt: 4,
        progress: noopProgress,
        shutdown: executionShutdown(new AbortController()),
        deps: {
          async stageAttachments(attachments) {
            return [...attachments]
          },
          spawn() {
            const stdout = new ReadableStream<Uint8Array>({
              start(controller) {
                stdoutController = controller
                controller.enqueue(new TextEncoder().encode(`${rawEvent}\n`))
              },
            })
            const exited = new Promise<number>((resolve) => {
              resolveExit = resolve
            })
            markSpawned?.()
            return { stdout, stderr: textStream(), exited, get exitCode() { return exitCode }, kill() {} }
          },
        },
      })
      await spawned

      const path = join(runDir, "logs", "security.4.claude.jsonl")
      let observed: string | undefined
      for (let attempt = 0; attempt < 20 && observed === undefined; attempt++) {
        try {
          observed = await readFile(path, "utf8")
        } catch {
          await Bun.sleep(5)
        }
      }

      stdoutController?.close()
      exitCode = 1
      resolveExit?.(1)
      await expect(execution).rejects.toThrow("before reporting a result")
      expect(observed).toBe(`${rawEvent}\n`)
    } finally {
      await Promise.all([rm(runDir, { recursive: true, force: true }), rm(targetDir, { recursive: true, force: true })])
    }
  })

  test("publishes and returns usage from a failed Claude result", async () => {
    const runDir = await executionDir()
    const targetDir = await mkdtemp(join(tmpdir(), "archer-claude-target-"))
    const usage: ProgressUsage[] = []
    const resultEvent = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "provider failed",
      total_cost_usd: 0.25,
      usage: { input_tokens: 100, output_tokens: 20 },
    })

    try {
      const result = await promptClaudePhase({
        phase: claudePhase,
        workspace: { dir: runDir, runID: "test" },
        targetDir,
        prompt: "Review",
        attachments: [],
        attempt: 3,
        progress: { ...noopProgress, phaseUsageTotal(_name, value) { usage.push(value) } },
        shutdown: executionShutdown(new AbortController()),
        deps: {
          async stageAttachments(attachments) {
            return [...attachments]
          },
          spawn() {
            return { stdout: textStream(resultEvent), stderr: textStream(), exited: Promise.resolve(1), exitCode: 1, kill() {} }
          },
        },
      })

      expect(result).toMatchObject({ cost: 0.25, tokens: { input: 100, output: 20, total: 120 }, error: expect.any(String) })
      expect(usage).toEqual([
        {
          cost: 0.25,
          tokens: { input: 100, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 120 },
          model: "claude-code/opus",
        },
      ])
    } finally {
      await Promise.all([rm(runDir, { recursive: true, force: true }), rm(targetDir, { recursive: true, force: true })])
    }
  })
})

describe("model label", () => {
  test("mirrors provider/model formatting", () => {
    expect(claudeModelLabel("opus")).toBe("claude-code/opus")
    expect(claudeModelLabel("")).toBe("claude-code/default")
  })
})

describe("interactive resume", () => {
  test("disables customizations while preserving the read-only tool envelope", () => {
    const args = claudeResumeArgs("session-123", ["/runs/r1", "/external/review-input"])

    expect(args).toContain("--safe-mode")
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep")
    expect(args).not.toContain("--allowedTools")
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk")
    expect(args).toContain("session-123")
    expect(args).toContain("/runs/r1")
    expect(args).toContain("/external/review-input")
    expect(args).not.toContain("/external")
  })
})

describe("ndjsonLines", () => {
  test("reassembles lines across chunk boundaries and drops blanks", async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"a":'))
        controller.enqueue(encoder.encode('1}\n\n{"b":2}\n{"c"'))
        controller.enqueue(encoder.encode(':3}'))
        controller.close()
      },
    })
    const lines: string[] = []
    for await (const line of ndjsonLines(stream)) lines.push(line)
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
  })
})
