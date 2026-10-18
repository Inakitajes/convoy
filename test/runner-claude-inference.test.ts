import { describe, expect, test } from "bun:test"

import type { ClaudeProcess } from "../src/runners/claude/adapter"
import { claudeInference, claudeInferenceArgs, ClaudeInferenceError, parseInferenceResult } from "../src/runners/claude/inference"

function fakeProcess(stdout: string, options: { exitCode?: number; stderr?: string; hang?: boolean; onKill?: () => void } = {}): ClaudeProcess {
  const encoder = new TextEncoder()
  let close: (() => void) | undefined
  const out = new ReadableStream<Uint8Array>({
    start(controller) {
      if (stdout) controller.enqueue(encoder.encode(stdout))
      if (options.hang) close = () => {
        close = undefined
        controller.close()
      }
      else controller.close()
    },
  })
  const err = new ReadableStream<Uint8Array>({
    start(controller) {
      if (options.stderr) controller.enqueue(encoder.encode(options.stderr))
      controller.close()
    },
  })
  let resolveExit!: (code: number) => void
  const exited = options.hang ? new Promise<number>((resolve) => (resolveExit = resolve)) : Promise.resolve(options.exitCode ?? 0)
  return {
    stdout: out,
    stderr: err,
    exited,
    exitCode: options.hang ? null : (options.exitCode ?? 0),
    kill: () => {
      options.onKill?.()
      close?.()
      resolveExit?.(143)
    },
  }
}

const subscription = { probeAuth: async () => ({ authMethod: "claude.ai" }) }
const result = (text: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, session_id: "s1", total_cost_usd: 0.001, usage: { input_tokens: 10, output_tokens: 3 }, ...extra })}\n`

describe("claude helper inference", () => {
  test("runs tool-less, session-less, MCP-less, under the reviewed auth overlay", async () => {
    let seen: { argv: string[]; env: NodeJS.ProcessEnv; stdin: string } | undefined
    const answer = await claudeInference(
      { prompt: "classify this", system: "you classify", model: "haiku", auth: { mode: "subscription" }, cwd: "/tmp" },
      {
        ...subscription,
        env: { ANTHROPIC_API_KEY: "sk-ambient", HERDR_PANE_ID: "p1", PATH: "/bin" },
        spawn: (argv, options) => {
          void options.stdin.text().then((stdin) => (seen = { argv, env: options.env, stdin }))
          return fakeProcess(result('{"safe": true}'))
        },
      },
    )
    expect(answer.text).toBe('{"safe": true}')
    expect(answer.usage).toEqual({ input: 10, output: 3, costEstimate: 0.001 })
    const argv = seen!.argv.join(" ")
    expect(argv).toContain("--no-session-persistence")
    expect(argv).toContain("--strict-mcp-config")
    expect(seen!.argv[seen!.argv.indexOf("--tools") + 1]).toBe("")
    expect(seen!.argv[seen!.argv.indexOf("--model") + 1]).toBe("haiku")
    // Subscription isolation: the ambient key never reaches the child.
    expect(seen!.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(seen!.env.HERDR_PANE_ID).toBeUndefined()
    expect(seen!.stdin).toBe("classify this")
  })

  test("a read-only helper gets only the read tools", () => {
    const args = claudeInferenceArgs({ system: "s", tools: "read-only" })
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep")
    expect(args).not.toContain("--model")
  })

  test("refuses when the effective auth is not the reviewed one, before spawning", async () => {
    let spawned = false
    const run = claudeInference(
      { prompt: "x", system: "s", auth: { mode: "subscription" }, cwd: "/tmp" },
      { probeAuth: async () => ({ authMethod: "api_key_helper" }), spawn: () => ((spawned = true), fakeProcess(result("x"))) },
    )
    await expect(run).rejects.toBeInstanceOf(ClaudeInferenceError)
    expect(spawned).toBe(false)
  })

  test("an error result, a missing result, or a timeout is an error, never an answer", async () => {
    await expect(claudeInference({ prompt: "x", system: "s", auth: { mode: "subscription" }, cwd: "/tmp" }, { ...subscription, spawn: () => fakeProcess(result("quota", { is_error: true, subtype: "error_during_execution" })) })).rejects.toThrow("answered with an error")
    await expect(claudeInference({ prompt: "x", system: "s", auth: { mode: "subscription" }, cwd: "/tmp" }, { ...subscription, spawn: () => fakeProcess("", { exitCode: 1, stderr: "boom" }) })).rejects.toThrow("without a result: boom")
    let killed = false
    await expect(
      claudeInference(
        { prompt: "x", system: "s", auth: { mode: "subscription" }, cwd: "/tmp", timeoutMs: 20 },
        { ...subscription, spawn: () => fakeProcess("", { hang: true, onKill: () => (killed = true) }) },
      ),
    ).rejects.toThrow("timed out")
    expect(killed).toBe(true)
  })

  test("parses the json result object", () => {
    expect(parseInferenceResult(result("hi"))).toMatchObject({ isError: false, text: "hi", sessionId: "s1" })
    expect(parseInferenceResult("not json")).toBeUndefined()
    expect(parseInferenceResult(JSON.stringify({ type: "assistant" }))).toBeUndefined()
  })
})
