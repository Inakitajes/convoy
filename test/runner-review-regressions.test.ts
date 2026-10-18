/**
 * Regressions from the runner-parity review: each case reproduces a defect that
 * was first confirmed against a live `claude` CLI run.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { evaluateHookInput } from "../src/runners/commands"
import { phasePolicy } from "../src/runners/phase-policy"
import { createClaudeRunner, type ClaudeProcess } from "../src/runners/claude/adapter"
import { startClaudeAttemptBridge, approvalBridgeProvider } from "../src/runners/attempt-bridge"
import { resolvePermission } from "../src/runners/claude/permission-broker"
import { executeClaudeAttempt } from "../src/runners/claude/attempt"
import { parseModelOverride } from "../src/step-runners"
import type { AttemptContext } from "../src/runners/attempt"
import type { AttemptOutcome, ExecutionAdapter, ExecutionRequest, ExecutionServices, RunnerEvent } from "../src/runners/contracts"
import type { AgentStep } from "../src/types"

const root = mkdtempSync(join(tmpdir(), "convoy-review-"))
const checkout = join(root, "repo")
const runDir = join(root, "home", ".convoy", "runs", "r1")
const privateDir = join(runDir, "private")
mkdirSync(join(checkout, "src"), { recursive: true })
mkdirSync(privateDir, { recursive: true })
writeFileSync(join(checkout, "src", "a.ts"), "export {}\n")
writeFileSync(join(privateDir, "bridge.env"), "BRIDGE_TOKEN=secret\n")
writeFileSync(join(root, "outside.txt"), "outside\n")
symlinkSync(privateDir, join(checkout, "leak"))

afterAll(() => rmSync(root, { recursive: true, force: true }))

function policy(mode: "read-only" | "verify" | "write", attachments: string[] = []) {
  return phasePolicy({ mode, autoAccept: "off", checkout, runDir, privateDirs: [privateDir], commands: { "*": "ask", "cat *": "allow", "grep *": "allow" }, attachments })
}

function decide(tool: string, input: Record<string, unknown>, mode: "read-only" | "verify" | "write" = "read-only", attachments: string[] = []) {
  const raw = JSON.stringify({ hook_event_name: "PreToolUse", cwd: checkout, tool_name: tool, tool_input: input })
  return JSON.parse(evaluateHookInput(raw, policy(mode, attachments))).hookSpecificOutput.permissionDecision as string
}

describe("M3: Claude reads are confined like OpenCode's external_directory", () => {
  test("a relative Grep path into the private dir is denied", () => {
    expect(decide("Grep", { pattern: "BRIDGE_TOKEN", path: "../home/.convoy/runs/r1/private" })).toBe("deny")
  })

  test("a symlink inside the checkout that resolves into the private dir is denied", () => {
    expect(decide("Read", { file_path: join(checkout, "leak", "bridge.env") })).toBe("deny")
  })

  test("a Grep over an ancestor of the private dir is denied", () => {
    expect(decide("Grep", { pattern: "BRIDGE_TOKEN", path: runDir })).toBe("deny")
  })

  test("a Glob pattern that escapes into the private dir is denied", () => {
    expect(decide("Glob", { pattern: "../home/.convoy/runs/r1/private/*" })).toBe("deny")
  })

  test("a read outside the checkout, run dir and attachments is denied", () => {
    expect(decide("Read", { file_path: join(root, "outside.txt") })).toBe("deny")
  })

  test("an attachment outside the checkout stays readable", () => {
    expect(decide("Read", { file_path: join(root, "outside.txt") }, "read-only", [join(root, "outside.txt")])).toBe("allow")
  })

  test("reads inside the checkout and the run dir are still allowed", () => {
    expect(decide("Read", { file_path: "src/a.ts" })).toBe("allow")
    expect(decide("Grep", { pattern: "export" })).toBe("allow")
    expect(decide("Glob", { pattern: "**/*.ts" })).toBe("allow")
    expect(decide("Read", { file_path: join(runDir, "prd.md") })).toBe("allow")
  })

  test("a Grep regex is never mistaken for a path", () => {
    expect(decide("Grep", { pattern: "/etc/passwd" })).toBe("allow")
  })

  test("an allowlisted shell command cannot reach the private dir through a relative or ~ path", () => {
    expect(decide("Bash", { command: "cat ../home/.convoy/runs/r1/private/bridge.env" }, "verify")).toBe("deny")
    expect(decide("Bash", { command: "grep -r TOKEN ../home/.convoy/runs/r1" }, "verify")).toBe("deny")
    expect(decide("Bash", { command: "cat leak/bridge.env" }, "verify")).toBe("deny")
    expect(decide("Bash", { command: "cat src/a.ts" }, "verify")).toBe("allow")
  })
})

describe("M2: Claude asks reach the operator", () => {
  test("an ask is forwarded over the authenticated bridge and the operator's answer wins", async () => {
    const seen: string[] = []
    const bridge = await startClaudeAttemptBridge({ approve: async (ask) => {
      seen.push(`${ask.tool}:${ask.resource}`)
      return ask.resource === "mkdir newdir"
    } })
    try {
      const config = policy("write")
      const call = (command: string) => ({ tool_name: "Bash", tool_input: { command } })
      const provider = approvalBridgeProvider(bridge.env)!
      expect((await resolvePermission({ call: call("mkdir newdir"), config, requestApproval: provider })).decision).toBe("allow")
      expect((await resolvePermission({ call: call("rm -rf x"), config, requestApproval: provider })).decision).toBe("deny")
      expect(seen).toEqual(["Bash:mkdir newdir", "Bash:rm -rf x"])
    } finally {
      await bridge.close()
    }
  })

  test("the `convoy mcp` permission host forwards an ask to the bridge", async () => {
    const bridge = await startClaudeAttemptBridge({ approve: async (ask) => ask.resource === "mkdir newdir" })
    try {
      const call = (id: number, command: string) =>
        JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "permission", arguments: { tool_name: "Bash", input: { command } } } })
      const proc = Bun.spawn(["bun", "src/main.ts", "mcp"], {
        cwd: process.cwd(),
        stdin: new Blob([`${call(1, "mkdir newdir")}\n${call(2, "rm -rf x")}\n`]),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...bridge.env, CONVOY_RUNNER_POLICY: JSON.stringify(policy("write")) },
      })
      const lines = (await new Response(proc.stdout).text()).trim().split("\n")
      await proc.exited
      const behaviors = lines.map((line) => JSON.parse(JSON.parse(line).result.content[0].text).behavior)
      expect(behaviors).toEqual(["allow", "deny"])
    } finally {
      await bridge.close()
    }
  }, 30_000)

  test("a caller without the bridge token is refused", async () => {
    const bridge = await startClaudeAttemptBridge({ approve: async () => true })
    try {
      const forged = approvalBridgeProvider({ ...bridge.env, CONVOY_APPROVAL_TOKEN: "wrong" })!
      expect(await forged({ tool: "Bash", resource: "mkdir x", reason: "operator decides" })).toBe(false)
    } finally {
      await bridge.close()
    }
  })
})

function claudeRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    identity: { runId: "r1", phaseName: "review", attempt: 1 },
    runner: "claude-code",
    checkout,
    agent: { name: "reviewer", mode: "read-only", model: { runner: "claude-code", modelId: "sonnet" } },
    prompt: "go",
    auth: { mode: "subscription" },
    mode: "read-only",
    approvals: "auto",
    signal: new AbortController().signal,
    ...overrides,
  }
}

function proc(lines: string[], stderr = ""): ClaudeProcess {
  const encoder = new TextEncoder()
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (text) controller.enqueue(encoder.encode(text))
        controller.close()
      },
    })
  return { stdout: stream(lines.length ? `${lines.join("\n")}\n` : ""), stderr: stream(stderr), exited: Promise.resolve(lines.length ? 0 : 1), exitCode: lines.length ? 0 : 1, kill() {} }
}

const turn = [
  `{"type":"system","subtype":"init","session_id":"ses_1"}`,
  `{"type":"stream_event","event":{"type":"content_block_start"}}`,
  `{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"before"}}}`,
  `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"a.ts"}}]}}`,
  `{"type":"stream_event","event":{"type":"content_block_start"}}`,
  `{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"after"}}}`,
  `{"type":"result","subtype":"success","result":"","total_cost_usd":0.02,"usage":{"input_tokens":10,"output_tokens":5}}`,
]

function runner(probe: string, spawned: { command: string[]; env: NodeJS.ProcessEnv }[], lines = turn, stderr = "") {
  return createClaudeRunner({
    cwd: checkout,
    env: { PATH: process.env.PATH, MY_KEY: "sk-test-value" },
    deps: {
      spawn(command, options) {
        spawned.push({ command, env: options.env })
        if (command[1] === "auth") return proc([JSON.stringify({ loggedIn: true, authMethod: probe })])
        return proc(lines, stderr)
      },
    },
  })
}

describe("M1: Claude authentication is the reviewed selection, verified before the attempt", () => {
  test("the configured selection reaches the adapter's request", async () => {
    let seen: ExecutionRequest | undefined
    const adapter: ExecutionAdapter = {
      id: "claude-code",
      capabilities: async () => ({}) as never,
      async executeAttempt(request): Promise<AttemptOutcome> {
        seen = request
        return { status: "completed", assistantText: "ok" }
      },
      cancelAttempt: async () => undefined,
    }
    const context: AttemptContext = {
      identity: { runId: "r1", phaseName: "review", attempt: 1 },
      runner: "claude-code",
      phase: { name: "review", agentName: "implementer", readOnly: true, verify: false, model: "sonnet" } as AgentStep,
      targetDir: checkout,
      prompt: "go",
      model: { providerID: "anthropic", modelID: "sonnet" },
      attachments: [],
      sink: () => undefined,
      signal: new AbortController().signal,
      attempt: 1,
      services: {},
      auth: { mode: "api-key", credentialRef: "MY_KEY" },
    }
    await executeClaudeAttempt(context, adapter)
    expect(seen?.auth).toEqual({ mode: "api-key", credentialRef: "MY_KEY" })
  })

  test("an api-key selection reaches the child as the key", async () => {
    const spawned: { command: string[]; env: NodeJS.ProcessEnv }[] = []
    const outcome = await runner("api_key", spawned).executeAttempt(claudeRequest({ auth: { mode: "api-key", credentialRef: "MY_KEY" } }), () => {})
    expect(outcome.status).toBe("completed")
    expect(spawned.at(-1)!.env.ANTHROPIC_API_KEY).toBe("sk-test-value")
  })

  test("a subscription attempt that would bill a third-party provider is refused before the agent runs", async () => {
    const spawned: { command: string[]; env: NodeJS.ProcessEnv }[] = []
    const outcome = await runner("third_party", spawned).executeAttempt(claudeRequest(), () => {})
    expect(outcome.status).toBe("failed")
    expect(String(outcome.error)).toContain("third_party")
    expect(spawned.map((entry) => entry.command[1])).toEqual(["auth"])
  })
})

describe("S1: the Claude adapter keeps the old path's events", () => {
  test("usage is reported, tool calls render once, text blocks keep their part ids", async () => {
    const events: RunnerEvent[] = []
    await runner("claude.ai", []).executeAttempt(claudeRequest(), (event) => events.push(event))
    expect(events.filter((event) => event.type === "usage")).toHaveLength(1)
    expect(events.filter((event) => event.type === "tool" || (event.type === "message" && event.channel === "tool"))).toHaveLength(1)
    const parts = events.flatMap((event) => (event.type === "text" ? [event.partId] : []))
    expect(new Set(parts).size).toBe(2)
  })

  test("one attempt reports exactly one terminal outcome, the final one", async () => {
    const events: RunnerEvent[] = []
    const services: ExecutionServices = { deliverables: { expected: ["report"], submit: async () => ({ ok: true }) } }
    const outcome = await runner("claude.ai", []).executeAttempt(claudeRequest(), (event) => events.push(event), services)
    const terminals = events.filter((event) => event.type === "terminal")
    expect(outcome.status).toBe("failed")
    expect(terminals).toHaveLength(1)
    expect(terminals[0]!.type === "terminal" && terminals[0]!.outcome.status).toBe("failed")
  })

  test("an exit without a result carries the stderr tail", async () => {
    const outcome = await runner("claude.ai", [], [], "boom: not logged in\n").executeAttempt(claudeRequest(), () => {})
    expect(String(outcome.error)).toContain("not logged in")
  })
})

describe("S3: an OpenCode Zen model id is not a runner scope", () => {
  test("opencode/<id> is the model itself", () => {
    expect(parseModelOverride("opencode/grok-code")).toEqual({ model: "opencode/grok-code" })
    expect(parseModelOverride("opencode/opencode/grok-code")).toEqual({ scope: "opencode", model: "opencode/grok-code" })
    expect(parseModelOverride("claude-code/sonnet")).toEqual({ scope: "claude-code", model: "sonnet" })
  })
})
