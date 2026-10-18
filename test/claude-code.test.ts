import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"


import {
  claudeReadableDirectories,
  claudeResumeArgs,
  claudeTokens,
  describeClaudeEvent,
  ensureClaudeAvailable,
  ndjsonLines,
  newClaudeStreamState,
  pipelineUsesClaudeCode,
  whichOnPath,
} from "../src/claude-code"
import { builtInAgents, resolvePipeline, type PipelineSpec } from "../src/pipeline"
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

  test("the availability check resolves against the live PATH, as the launch does", async () => {
    const bin = await mkdtemp(join(tmpdir(), "convoy-which-"))
    const original = process.env.PATH
    try {
      const name = `convoy-fake-cli-${process.pid}`
      await writeFile(join(bin, name), "#!/bin/sh\n", { mode: 0o755 })
      expect(whichOnPath(name)).toBeNull()
      process.env.PATH = `${bin}:${original ?? ""}`
      // Bun.which alone would still read the startup PATH here.
      expect(whichOnPath(name)).toBe(join(bin, name))
    } finally {
      process.env.PATH = original
      await rm(bin, { recursive: true, force: true })
    }
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

describe("read-only reopen envelope", () => {
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
    const dirs = claudeReadableDirectories([{ type: "file", url: "file:///external/specs/api.md", filename: "api.md", mime: "text/markdown" }], "/repo", "/runs/r1")
    expect(dirs).toEqual(["/runs/r1"])
  })

  test("external directory attachments expose the directory but not its parent", () => {
    const dirs = claudeReadableDirectories(
      [{ type: "file", url: "file:///external/review-input", filename: "review-input", mime: "application/x-directory" }],
      "/repo",
      "/runs/r1",
    )
    expect(dirs).toEqual(["/runs/r1", "/external/review-input"])
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
