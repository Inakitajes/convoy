import { existsSync, readFileSync, statSync } from "node:fs"

import { describe, expect, test } from "bun:test"

import type { ExecutionRequest, RunnerEvent } from "../src/runners/contracts"
import {
  buildClaudeArgs,
  createClaudeRunner,
  modeFlags,
  signalsToEvents,
  usageFromTokens,
  type ClaudeProcess,
} from "../src/runners/claude/adapter"
import { approvalTokenEnv, approvalUrlEnv } from "../src/runners/attempt-bridge"
import type { EnforcementPlan } from "../src/runners/claude/enforcement"
import { redactSecrets } from "../src/runners/redaction"
import { convoySecretsDir } from "../src/workspace"
import { buildPermissionPromptTool } from "../src/runners/claude/permission-broker"
import { buildClaudeSettings, buildPermissionMcpConfig } from "../src/runners/claude/settings"

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    identity: { runId: "run-claude", phaseName: "implement", attempt: 1 },
    runner: "claude-code",
    checkout: "/tmp/checkout",
    agent: { name: "implementer", mode: "write", model: { runner: "claude-code", modelId: "sonnet" } },
    prompt: "do the thing",
    auth: { mode: "subscription" },
    mode: "write",
    approvals: "auto",
    signal: new AbortController().signal,
    ...overrides,
  }
}

/** A read-only, auto-approved request that needs no enforcement host. */
function readOnly(): ExecutionRequest {
  return request({
    mode: "read-only",
    agent: { name: "reviewer", mode: "read-only", model: { runner: "claude-code", modelId: "sonnet" } },
  })
}

/** The effective-auth probe of an operator logged in with a subscription. */
const subscriptionLogin = { probeAuth: async () => ({ authMethod: "claude.ai" }) }

/** A reviewed plan that installs the hook and the permission host. */
function enforcementPlan(): EnforcementPlan {
  return {
    settings: buildClaudeSettings({ preToolUse: { command: "convoy hook pre-tool-use" } }),
    mcpConfig: buildPermissionMcpConfig("convoy", "convoy-mcp"),
    permissionPromptTool: buildPermissionPromptTool("convoy", "permission"),
  }
}

function fakeProcess(lines: string[], onKill?: () => void): ClaudeProcess {
  const encoder = new TextEncoder()
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      if (lines.length) controller.enqueue(encoder.encode(`${lines.join("\n")}\n`))
      controller.close()
    },
  })
  const stderr = new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
  return { stdout, stderr, exited: Promise.resolve(0), exitCode: 0, kill: () => onKill?.() }
}

const fixture = [
  `{"type":"system","subtype":"init","session_id":"ses_claude_1"}`,
  `{"type":"stream_event","event":{"type":"content_block_start"}}`,
  `{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"Hello "}}}`,
  `{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"world"}}}`,
  `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"a.ts"}}]}}`,
  `{"type":"result","subtype":"success","result":"Hello world","total_cost_usd":0.02,"usage":{"input_tokens":10,"output_tokens":5}}`,
]

/** A completed turn that produced no assistant text. */
const emptyResult = [
  `{"type":"system","subtype":"init","session_id":"ses_claude_2"}`,
  `{"type":"result","subtype":"success","result":"","total_cost_usd":0.01,"usage":{"input_tokens":3,"output_tokens":0}}`,
]

describe("claude adapter (unit)", () => {
  test("maps execution modes to tool and permission flags", () => {
    expect(modeFlags("read-only")).toEqual({ tools: "Read,Glob,Grep", permissionMode: "dontAsk" })
    expect(modeFlags("verify")).toEqual({ tools: "Read,Glob,Grep,Bash", permissionMode: "dontAsk" })
    expect(modeFlags("write")).toEqual({ permissionMode: "acceptEdits" })
  })

  test("builds headless streaming args", () => {
    const args = buildClaudeArgs(
      request({
        mode: "read-only",
        agent: { name: "a", mode: "read-only", model: { runner: "claude-code", modelId: "op" }, instructions: "sys" },
      }),
    )
    expect(args).toContain("--output-format")
    expect(args).toContain("stream-json")
    expect(args).toContain("--append-system-prompt")
    expect(args).toContain("sys")
    expect(args).toContain("--model")
    expect(args).toContain("op")
    expect(args).toEqual(expect.arrayContaining(["--tools", "Read,Glob,Grep", "--permission-mode", "dontAsk"]))
  })

  test("maps signals to neutral events and outcomes", () => {
    const session = signalsToEvents({ type: "session", sessionID: "ses_x" }, 2)
    expect(session.events).toEqual([{ type: "session", runner: "claude-code", attempt: 2, session: { runner: "claude-code", sessionId: "ses_x" } }])

    const text = signalsToEvents({ type: "message", message: { channel: "response", text: "hi" } }, 2)
    expect(text.events[0]?.type).toBe("text")

    // The result reports its usage; the terminal event is the adapter's, once the outcome is final.
    const result = signalsToEvents({ type: "result", subtype: "success", text: "done", cost: 0.1, tokens: undefined, isError: false }, 2)
    expect(result.outcome?.status).toBe("completed")
    expect(result.events.map((event) => event.type)).toEqual(["usage"])
  })

  test("maps tokens and cost to usage", () => {
    expect(usageFromTokens({ input: 3, output: 4, reasoning: 1, cacheRead: 2, cacheWrite: 0, total: 10 }, 0.5)).toEqual({
      input: 3,
      output: 4,
      reasoning: 1,
      cacheRead: 2,
      cacheWrite: 0,
      costEstimate: 0.5,
    })
  })
})

describe("claude adapter (fixture execution)", () => {
  test("streams a fixture turn into events and a completed outcome", async () => {
    const runner = createClaudeRunner({ cwd: "/tmp", env: {}, deps: { ...subscriptionLogin, spawn: () => fakeProcess(fixture) }, enforcement: enforcementPlan() })
    const events: RunnerEvent[] = []
    const outcome = await runner.executeAttempt(request(), (event) => events.push(event))

    expect(outcome.status).toBe("completed")
    expect(outcome.assistantText).toBe("Hello world")
    expect(outcome.session?.sessionId).toBe("ses_claude_1")
    expect(events.some((event) => event.type === "session")).toBe(true)
    expect(events.filter((event) => event.type === "text").map((event) => (event as { text: string }).text)).toEqual(["Hello ", "world"])
    expect(events.some((event) => event.type === "activity" && event.kind === "tool")).toBe(true)
    expect(events.at(-1)?.type).toBe("terminal")
  })

  test("strips an ambient API key under subscription auth", async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined
    const runner = createClaudeRunner({
      cwd: "/tmp",
      env: { ANTHROPIC_API_KEY: "sk-ambient-leak", PATH: "/bin" },
      enforcement: enforcementPlan(),
      deps: {
        ...subscriptionLogin,
        spawn: (_command, options) => {
          seenEnv = options.env
          return fakeProcess(fixture)
        },
      },
    })
    await runner.executeAttempt(request({ auth: { mode: "subscription" } }), () => {})
    expect(seenEnv?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(seenEnv?.PATH).toBe("/bin")
  })

  test("strips HERDR_* from the headless child without mutating the parent env", async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined
    const parentEnv = {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      PATH: "/bin",
    }
    const runner = createClaudeRunner({
      cwd: "/tmp",
      env: parentEnv,
      enforcement: enforcementPlan(),
      deps: {
        ...subscriptionLogin,
        spawn: (_command, options) => {
          seenEnv = options.env
          return fakeProcess(fixture)
        },
      },
    })

    await runner.executeAttempt(request(), () => {})
    expect(seenEnv).not.toHaveProperty("HERDR_ENV")
    expect(seenEnv).not.toHaveProperty("HERDR_PANE_ID")
    expect(seenEnv).not.toHaveProperty("HERDR_SOCKET_PATH")
    expect(seenEnv?.PATH).toBe("/bin")
    expect(parentEnv.HERDR_ENV).toBe("1")
    expect(parentEnv.HERDR_PANE_ID).toBe("w1:p1")
  })

  test("a pre-aborted attempt kills the child and reports interrupted", async () => {
    let killed = false
    const runner = createClaudeRunner({
      cwd: "/tmp",
      env: {},
      enforcement: enforcementPlan(),
      deps: { ...subscriptionLogin, spawn: () => fakeProcess([], () => { killed = true }) },
    })
    const controller = new AbortController()
    controller.abort()
    const outcome = await runner.executeAttempt(request({ signal: controller.signal }), () => {})
    expect(killed).toBe(true)
    expect(outcome.status).toBe("interrupted")
  })

  test("fails closed without enforcement for a writable auto attempt", async () => {
    let spawned = false
    const runner = createClaudeRunner({
      cwd: "/tmp",
      env: {},
      deps: { ...subscriptionLogin, spawn: () => { spawned = true; return fakeProcess(fixture) } },
    })
    const events: RunnerEvent[] = []
    const outcome = await runner.executeAttempt(request({ mode: "write", approvals: "auto" }), (event) => events.push(event))
    expect(spawned).toBe(false)
    expect(outcome.status).toBe("failed")
    expect(outcome.error).toContain("enforcement")
    expect(events.at(-1)?.type).toBe("terminal")
  })

  test("runs read-only + auto without the permission host", async () => {
    let spawned = false
    const runner = createClaudeRunner({
      cwd: "/tmp",
      env: {},
      deps: { ...subscriptionLogin, spawn: () => { spawned = true; return fakeProcess(fixture) } },
    })
    const outcome = await runner.executeAttempt(
      request({
        mode: "read-only",
        approvals: "auto",
        agent: { name: "reviewer", mode: "read-only", model: { runner: "claude-code", modelId: "sonnet" } },
      }),
      () => {},
    )
    expect(spawned).toBe(true)
    expect(outcome.status).toBe("completed")
  })

  test("delivers the final report to a contract that expects it", async () => {
    const runner = createClaudeRunner({ cwd: "/tmp", env: {}, deps: { ...subscriptionLogin, spawn: () => fakeProcess(fixture) } })
    const observed: string[] = []
    let submitted: { kind: string; body: string } | undefined
    const outcome = await runner.executeAttempt(readOnly(), () => {}, {
      deliverables: {
        expected: ["report"],
        submit: async (submission) => {
          submitted = submission
          return { ok: true }
        },
      },
      loopGuard: {
        observe: (observation) => {
          observed.push(observation.kind)
          return { action: "continue" }
        },
      },
    })
    expect(outcome.status).toBe("completed")
    expect(submitted?.body).toBe("Hello world")
    // Loop control is not claimed, so no observation is forwarded.
    expect(observed).toEqual([])
  })

  test("a contract that expects a report fails when the attempt produced none", async () => {
    const runner = createClaudeRunner({ cwd: "/tmp", env: {}, deps: { ...subscriptionLogin, spawn: () => fakeProcess(emptyResult) } })
    let submitted = false
    const outcome = await runner.executeAttempt(readOnly(), () => {}, {
      deliverables: {
        expected: ["report"],
        submit: async () => {
          submitted = true
          return { ok: true }
        },
      },
    })
    expect(outcome.status).toBe("failed")
    expect(outcome.error).toContain("expects a report")
    expect(submitted).toBe(false)
  })

  test("a rejected deliverable fails the attempt", async () => {
    const runner = createClaudeRunner({ cwd: "/tmp", env: {}, deps: { ...subscriptionLogin, spawn: () => fakeProcess(fixture) } })
    const outcome = await runner.executeAttempt(readOnly(), () => {}, {
      deliverables: {
        expected: ["report"],
        submit: async () => ({ ok: false, error: "invalid score", retryable: false, preserved: true }),
      },
    })
    expect(outcome.status).toBe("failed")
    expect(outcome.error).toContain("invalid score")
  })
})

describe("claude adapter (robustness)", () => {
  async function run(lines: string[]) {
    const runner = createClaudeRunner({
      cwd: "/tmp",
      env: {},
      enforcement: enforcementPlan(),
      deps: { ...subscriptionLogin, spawn: () => fakeProcess(lines) },
    })
    const events: RunnerEvent[] = []
    const outcome = await runner.executeAttempt(request(), (event) => events.push(event))
    return { outcome, events }
  }

  test("a malformed line is ignored and never fabricates completion", async () => {
    const { outcome, events } = await run([
      `{"type":"system","subtype":"init","session_id":"ses_1"}`,
      `this is not json`,
      `{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"partial"}}}`,
    ])
    expect(outcome.status).toBe("failed")
    expect(events.some((event) => event.type === "text" && (event as { text: string }).text === "partial")).toBe(true)
  })

  test("a missing result message is a failure, not a success", async () => {
    const { outcome } = await run([`{"type":"system","subtype":"init","session_id":"ses_1"}`])
    expect(outcome.status).toBe("failed")
    expect(typeof outcome.error).toBe("string")
  })

  test("an error result is a failure", async () => {
    const { outcome } = await run([`{"type":"result","subtype":"error_max_turns","result":"","is_error":true}`])
    expect(outcome.status).toBe("failed")
  })

  test("startup hook events do not produce a successful terminal outcome", async () => {
    const { outcome, events } = await run([
      `{"type":"system","subtype":"hook_started","hook_name":"SessionStart"}`,
      `{"type":"system","subtype":"init","session_id":"ses_1"}`,
    ])
    const terminal = events.find((event) => event.type === "terminal") as { outcome?: { status?: string } } | undefined
    expect(terminal?.outcome?.status).toBe("failed")
    expect(outcome.status).toBe("failed")
  })

  test("a nested subagent assistant message maps to tool activity, not completion", async () => {
    const { outcome, events } = await run([
      `{"type":"assistant","parent_tool_use_id":"toolu_1","message":{"content":[{"type":"tool_use","name":"Grep","input":{}}]}}`,
      `{"type":"result","subtype":"success","result":"ok"}`,
    ])
    expect(events.some((event) => event.type === "activity" && event.kind === "tool")).toBe(true)
    expect(outcome.status).toBe("completed")
  })
})

// The approval bridge's bearer token lets whoever holds it answer the attempt's
// approval prompts. Claude's tools inherit its environment and anything in its
// argv shows in `ps`, so the token must reach only the permission host: through
// that server's own env in a private config file the attempt cannot read.
describe("Claude approval bridge token", () => {
  test("never enters the child env or argv, and is redacted from diagnostics", async () => {
    let seen: { argv: string[]; env: NodeJS.ProcessEnv } | undefined
    let mcpConfigPath: string | undefined
    let mcpConfig: { mcpServers: Record<string, { env?: Record<string, string> }> } | undefined
    let mode = 0
    const runner = createClaudeRunner({
      cwd: "/tmp",
      env: { PATH: "/bin" },
      enforcement: enforcementPlan(),
      deps: {
        ...subscriptionLogin,
        spawn: (argv, options) => {
          seen = { argv, env: options.env }
          mcpConfigPath = argv[argv.indexOf("--mcp-config") + 1]
          mcpConfig = JSON.parse(readFileSync(mcpConfigPath!, "utf8"))
          mode = statSync(mcpConfigPath!).mode & 0o777
          return fakeProcess(fixture)
        },
      },
    })
    await runner.executeAttempt(request({ approvals: "interactive" }), () => {}, { approvals: { decide: async () => "allow" } })

    const token = mcpConfig?.mcpServers.convoy?.env?.[approvalTokenEnv]
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(mcpConfig?.mcpServers.convoy?.env?.[approvalUrlEnv]).toStartWith("http://127.0.0.1:")
    expect(seen?.env[approvalTokenEnv]).toBeUndefined()
    expect(seen?.env[approvalUrlEnv]).toBeUndefined()
    expect(seen?.argv.join(" ")).not.toContain(token!)
    expect(mode).toBe(0o600)
    expect(mcpConfigPath!.startsWith(convoySecretsDir())).toBe(true)
    expect(redactSecrets(`token=${token}`)).not.toContain(token!)
    // The staged config is removed with the attempt.
    expect(existsSync(mcpConfigPath!)).toBe(false)
  })
})

// Spec runner-execution, "Claude child stalls during abort": cancellation
// must settle within a bounded deadline, escalating to a forced stop of the
// owned child instead of waiting forever on one that ignores SIGTERM.
describe("Claude abort escalation", () => {
  test("a child that ignores SIGTERM is force-stopped within the grace period", async () => {
    const signals: string[] = []
    let closeStdout: (() => void) | undefined
    let resolveExit!: (code: number) => void
    const proc: ClaudeProcess = {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "system", subtype: "init", session_id: "ses_stall" })}\n`))
          closeStdout = () => controller.close()
        },
      }),
      stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      exited: new Promise<number>((resolve) => (resolveExit = resolve)),
      exitCode: null,
      kill: (signal?: NodeJS.Signals | number) => {
        signals.push(String(signal ?? "SIGTERM"))
        // Only a forced stop ends this child.
        if (signal === "SIGKILL") {
          proc.exitCode = 137
          closeStdout?.()
          resolveExit(137)
        }
      },
    }
    const controller = new AbortController()
    const runner = createClaudeRunner({ cwd: "/tmp", env: {}, deps: { ...subscriptionLogin, spawn: () => proc, stopGraceMs: 20 } })
    const outcome = runner.executeAttempt(readOnlyWith(controller.signal), () => {})
    await Bun.sleep(10)
    controller.abort()
    expect(await outcome).toMatchObject({ status: "interrupted", session: { sessionId: "ses_stall" } })
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
  }, 2_000)
})

function readOnlyWith(signal: AbortSignal): ExecutionRequest {
  return { ...readOnly(), signal }
}
