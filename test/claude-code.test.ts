import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import type { FilePartInput } from "../src/opencode-client"

import {
  claudeArgs,
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
  type ClaudeShutdown,
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

function attachment(path: string, mime = "text/markdown"): FilePartInput {
  return { type: "file", url: pathToFileURL(path).href, filename: basename(path), mime }
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

function executionShutdown(controller: AbortController): ClaudeShutdown {
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

async function executionDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-claude-execution-"))
  await mkdir(join(dir, "logs"), { recursive: true })
  return dir
}

describe("optional Claude Code dependency", () => {
  test("only pipelines with claude-code steps require the binary", () => {
    let checks = 0
    ensureClaudeAvailable(opencodePipeline, () => {
      checks++
      return null
    })
    expect(checks).toBe(0)
    expect(pipelineUsesClaudeCode(opencodePipeline)).toBe(false)
    expect(pipelineUsesClaudeCode(claudePipeline)).toBe(true)
    expect(() => ensureClaudeAvailable(claudePipeline, () => null)).toThrow(/external-security/)
    expect(() => ensureClaudeAvailable(claudePipeline, () => null)).toThrow(/claude.*not found in PATH/)
  })
})

describe("stream-json adapter", () => {
  test("system/init yields the session id", () => {
    expect(
      describeClaudeEvent(
        { type: "system", subtype: "init", session_id: "abc-123", model: "claude-opus-4-8" },
        newClaudeStreamState(),
      ),
    ).toEqual([{ type: "session", sessionID: "abc-123" }])
  })

  test("ignores unknown and malformed events", () => {
    const state = newClaudeStreamState()
    expect(describeClaudeEvent(null, state)).toEqual([])
    expect(describeClaudeEvent("noise", state)).toEqual([])
    expect(describeClaudeEvent({ type: "user" }, state)).toEqual([])
    expect(describeClaudeEvent({ type: "stream_event", event: {} }, state)).toEqual([])
  })

  test("preserves streamed response, reasoning, tool and result semantics", () => {
    const state = newClaudeStreamState()
    const response = describeClaudeEvent(
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } } },
      state,
    )
    expect(response[0]).toEqual({ type: "message", message: { channel: "response", text: "Hello", partID: "block:0" } })
    expect(response[1]).toMatchObject({ type: "activity", kind: "write", pulse: true })
    expect(state.textChars).toBe(5)

    describeClaudeEvent({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "thinking" } } }, state)
    const reasoning = describeClaudeEvent(
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Inspecting" } } },
      state,
    )
    expect(reasoning[0]).toEqual({ type: "message", message: { channel: "reasoning", text: "Inspecting", partID: "block:1" } })
    expect(reasoning[1]).toMatchObject({ type: "activity", kind: "think", pulse: true })

    expect(
      describeClaudeEvent(
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Already streamed" },
              { type: "tool_use", name: "Read", input: { file_path: "/repo/src/auth.ts" } },
              { type: "tool_use", name: "Grep", input: { pattern: "password" } },
            ],
          },
        },
        state,
      ),
    ).toEqual([
      { type: "activity", message: "tool: Read /repo/src/auth.ts", kind: "tool" },
      { type: "message", message: { channel: "tool", text: "tool: Read /repo/src/auth.ts" } },
      { type: "activity", message: "tool: Grep password", kind: "tool" },
      { type: "message", message: { channel: "tool", text: "tool: Grep password" } },
    ])

    expect(
      describeClaudeEvent(
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "# Security report",
          total_cost_usd: 0.42,
          usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100 },
        },
        state,
      ),
    ).toEqual([
      {
        type: "result",
        subtype: "success",
        text: "# Security report",
        cost: 0.42,
        tokens: { input: 1000, output: 200, reasoning: 0, cacheRead: 5000, cacheWrite: 100, total: 6300 },
        isError: false,
      },
    ])
  })

  test("keeps consecutive content blocks in separate transcript parts", () => {
    const state = newClaudeStreamState()
    const start = () =>
      describeClaudeEvent(
        { type: "stream_event", event: { type: "content_block_start", content_block: { type: "thinking" } } },
        state,
      )
    const delta = (thinking: string) =>
      describeClaudeEvent(
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } } },
        state,
      )

    start()
    const first = delta("Planning the diff scope")
    start()
    const second = delta("Inspecting the rules")

    expect(first[0]).toMatchObject({ type: "message", message: { channel: "reasoning", partID: "block:1" } })
    expect(second[0]).toMatchObject({ type: "message", message: { channel: "reasoning", partID: "block:2" } })
  })

  test("normalizes only non-empty token usage", () => {
    expect(claudeTokens(undefined)).toBeUndefined()
    expect(claudeTokens({})).toBeUndefined()
    expect(claudeTokens({ input_tokens: 0, output_tokens: 0 })).toBeUndefined()
    expect(claudeTokens({ input_tokens: 12, output_tokens: 3 })).toEqual({
      input: 12,
      output: 3,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 15,
    })
  })
})

describe("prompt and exact read-only envelope", () => {
  test("attachments become an absolute-path reading list", () => {
    const prompt = claudePrompt("# Phase", [
      { type: "file", url: "file:///runs/r1/prd.md", filename: "prd.md", mime: "text/plain" },
      { type: "file", url: "file:///runs/r1/reports/scope.md", filename: "scope.md", mime: "text/plain" },
    ])
    expect(prompt).toContain("# Phase")
    expect(prompt).toContain("- /runs/r1/prd.md")
    expect(prompt).toContain("- /runs/r1/reports/scope.md")
    expect(claudePrompt("# Phase", [])).toBe("# Phase")
  })

  test("headless execution uses the exact read-only tool and permission arguments", () => {
    expect(
      claudeArgs({
        systemPromptPath: "/runs/r1/prompts/security.md",
        runDir: "/runs/r1",
        targetDir: "/repo",
        model: "opus",
        attachments: [],
      }),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--append-system-prompt-file",
      "/runs/r1/prompts/security.md",
      "--add-dir",
      "/runs/r1",
      "--safe-mode",
      "--tools",
      "Read,Glob,Grep",
      "--disallowedTools",
      "Write,Edit,NotebookEdit,Bash,Task,WebFetch,WebSearch",
      "--permission-mode",
      "dontAsk",
      "--model",
      "opus",
    ])
  })

  test("an empty model omits --model so the CLI default applies", () => {
    expect(claudeArgs({ systemPromptPath: "/r/prompt.md", runDir: "/r", targetDir: "/repo", model: "", attachments: [] })).not.toContain("--model")
  })

  test("interactive resume preserves the exact same read-only envelope", () => {
    expect(claudeResumeArgs("session-123", ["/runs/r1", "/external/review-input"])).toEqual([
      "--safe-mode",
      "--tools",
      "Read,Glob,Grep",
      "--disallowedTools",
      "Write,Edit,NotebookEdit,Bash,Task,WebFetch,WebSearch",
      "--permission-mode",
      "dontAsk",
      "--add-dir",
      "/runs/r1",
      "/external/review-input",
      "--resume",
      "session-123",
    ])
  })

  test("external files do not expose their parent directory", () => {
    const args = claudeArgs({
      systemPromptPath: "/runs/r1/prompt.md",
      runDir: "/runs/r1",
      targetDir: "/repo",
      model: "opus",
      attachments: [{ type: "file", url: "file:///external/specs/api.md", filename: "api.md", mime: "text/markdown" }],
    })
    expect(args).not.toContain("/external/specs")
  })

  test("external directory attachments expose the directory but not its parent", () => {
    const args = claudeArgs({
      systemPromptPath: "/runs/r1/prompt.md",
      runDir: "/runs/r1",
      targetDir: "/repo",
      model: "opus",
      attachments: [
        { type: "file", url: "file:///external/review-input", filename: "review-input", mime: "application/x-directory" },
      ],
    })
    expect(args).toContain("/external/review-input")
    expect(args).not.toContain("/external")
  })
})

describe("stageClaudeAttachments isolation", () => {
  test("copies external files into the phase's isolated staging directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "convoy-claude-attachments-"))
    const externalDir = join(root, "external")
    const runDir = join(root, "run")
    const targetDir = join(root, "repo")
    await Promise.all([mkdir(externalDir), mkdir(runDir), mkdir(targetDir)])
    const externalFile = join(externalDir, "api.md")
    await writeFile(externalFile, "API contract")

    try {
      const stageDir = join(runDir, "attachments", "security", "1")
      const staged = await stageClaudeAttachments([attachment(externalFile)], targetDir, runDir, stageDir)
      const stagedPath = fileURLToPath(staged[0]!.url)

      expect(stagedPath).toBe(join(stageDir, "0-api.md"))
      expect(await readFile(stagedPath, "utf8")).toBe("API contract")
      expect(fileURLToPath(staged[0]!.url)).not.toBe(externalFile)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("duplicate filenames cannot collide within or across parallel phases", async () => {
    const root = await mkdtemp(join(tmpdir(), "convoy-claude-collisions-"))
    const runDir = join(root, "run")
    const targetDir = join(root, "repo")
    const firstDir = join(root, "first")
    const secondDir = join(root, "second")
    await Promise.all([mkdir(runDir), mkdir(targetDir), mkdir(firstDir), mkdir(secondDir)])
    const firstPath = join(firstDir, "scope.md")
    const secondPath = join(secondDir, "scope.md")
    await Promise.all([writeFile(firstPath, "first"), writeFile(secondPath, "second")])

    try {
      const inputs = [attachment(firstPath), attachment(secondPath)]
      const [bugs, security] = await Promise.all([
        stageClaudeAttachments(inputs, targetDir, runDir, join(runDir, "attachments", "bugs", "1")),
        stageClaudeAttachments(inputs, targetDir, runDir, join(runDir, "attachments", "security", "1")),
      ])
      const stagedPaths = [...bugs, ...security].map((part) => fileURLToPath(part.url))

      expect(new Set(stagedPaths).size).toBe(4)
      expect(stagedPaths.map((path) => basename(path))).toEqual(["0-scope.md", "1-scope.md", "0-scope.md", "1-scope.md"])
      expect(await Promise.all(stagedPaths.map((path) => readFile(path, "utf8")))).toEqual(["first", "second", "first", "second"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("promptClaudePhase lifecycle", () => {
  test("kills a spawned child when abort lands while attachments are staged", async () => {
    const runDir = await executionDir()
    const targetDir = await mkdtemp(join(tmpdir(), "convoy-claude-target-"))
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

  test("persists sensitive prompts and raw streams with mode 0600 on failure", async () => {
    const runDir = await executionDir()
    const targetDir = await mkdtemp(join(tmpdir(), "convoy-claude-target-"))
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
              return {
                stdout: textStream(rawEvent),
                stderr: textStream("fatal"),
                exited: Promise.resolve(1),
                exitCode: 1,
                kill() {},
              }
            },
          },
        }),
      ).rejects.toThrow("before reporting a result")

      const logPath = join(runDir, "logs", "security.2.claude.jsonl")
      const promptPath = join(runDir, "prompts", "security.2.claude.md")
      expect(await readFile(logPath, "utf8")).toBe(`${rawEvent}\n`)
      if (process.platform !== "win32") {
        expect((await stat(logPath)).mode & 0o777).toBe(0o600)
        expect((await stat(promptPath)).mode & 0o777).toBe(0o600)
      }
    } finally {
      await Promise.all([rm(runDir, { recursive: true, force: true }), rm(targetDir, { recursive: true, force: true })])
    }
  })

  test("writes streamed events before Claude exits", async () => {
    const runDir = await executionDir()
    const targetDir = await mkdtemp(join(tmpdir(), "convoy-claude-target-"))
    const rawEvent = JSON.stringify({ type: "system", subtype: "init", session_id: "session-live" })
    let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined
    let resolveExit: ((code: number) => void) | undefined
    let exitCode: number | null = null
    let resolveSession!: () => void
    const sessionObserved = new Promise<void>((resolve) => {
      resolveSession = resolve
    })

    try {
      const execution = promptClaudePhase({
        phase: claudePhase,
        workspace: { dir: runDir, runID: "test" },
        targetDir,
        prompt: "Review",
        attachments: [],
        attempt: 4,
        progress: { ...noopProgress, phaseSession: () => resolveSession() },
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
            return { stdout, stderr: textStream(), exited, get exitCode() { return exitCode }, kill() {} }
          },
        },
      })

      await sessionObserved
      expect(exitCode).toBeNull()
      expect(await readFile(join(runDir, "logs", "security.4.claude.jsonl"), "utf8")).toBe(`${rawEvent}\n`)

      stdoutController?.close()
      exitCode = 1
      resolveExit?.(1)
      await expect(execution).rejects.toThrow("before reporting a result")
    } finally {
      await Promise.all([rm(runDir, { recursive: true, force: true }), rm(targetDir, { recursive: true, force: true })])
    }
  })

  test("publishes and returns usage from an error result", async () => {
    const runDir = await executionDir()
    const targetDir = await mkdtemp(join(tmpdir(), "convoy-claude-target-"))
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
        progress: {
          ...noopProgress,
          phaseUsageTotal(_name, value) {
            usage.push(value)
          },
        },
        shutdown: executionShutdown(new AbortController()),
        deps: {
          async stageAttachments(attachments) {
            return [...attachments]
          },
          spawn() {
            return {
              stdout: textStream(resultEvent),
              stderr: textStream(),
              exited: Promise.resolve(1),
              exitCode: 1,
              kill() {},
            }
          },
        },
      })

      expect(result).toMatchObject({
        assistantText: "provider failed",
        cost: 0.25,
        tokens: { input: 100, output: 20, total: 120 },
        finish: "error_during_execution",
        error: expect.any(String),
      })
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

describe("ndjsonLines", () => {
  test("reassembles chunked records, drops blanks and emits the final tail", async () => {
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
