import { readFileSync } from "node:fs"

import { describe, expect, test } from "bun:test"

import { consultAdvisor } from "../src/advisor"
import { createAdvisorRuntime } from "../src/advisor-runtime"
import { builtInAgents, resolvePipeline } from "../src/pipeline"
import { buildRunPlan } from "../src/run-plan"
import { preflightTargets } from "../src/preflight-validation"
import { runNeedsOpencodeServer } from "../src/runner"
import { createClaudeRunner, toolReportSubmission, type ClaudeProcess } from "../src/runners/claude/adapter"
import { attemptToolsClient, bridgeFileEnv } from "../src/runners/attempt-bridge"
import { buildPermissionPromptTool } from "../src/runners/claude/permission-broker"
import { handleMcpPermissionRequest } from "../src/runners/claude/mcp-permission-server"
import { buildClaudeSettings, buildPermissionMcpConfig } from "../src/runners/claude/settings"
import { checkpointFromEnv, convoyToolHost, evaluateHookInputWithCheckpoint } from "../src/runners/commands"
import type { AdvisorService, DeliverableService, DeliverableSubmission, ExecutionRequest } from "../src/runners/contracts"
import { stepRunnerFor } from "../src/step-runners"
import type { AgentStep, RunOptions } from "../src/types"

// Claude reaches Convoy's report and advisor services the way OpenCode does:
// through tools (here MCP) bound to the attempt's own services, plus the
// mandatory first-write checkpoint enforced by the PreToolUse hook.

const enforcement = {
  settings: buildClaudeSettings({ preToolUse: { command: "convoy hook" } }),
  mcpConfig: buildPermissionMcpConfig("convoy", "convoy-mcp"),
  permissionPromptTool: buildPermissionPromptTool("convoy", "permission"),
}

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    identity: { runId: "run-1", phaseName: "implement", attempt: 1 },
    runner: "claude-code",
    checkout: "/tmp",
    agent: { name: "implementer", mode: "write", model: { runner: "claude-code", modelId: "sonnet" } },
    prompt: "do it",
    auth: { mode: "subscription" },
    mode: "write",
    approvals: "auto",
    signal: new AbortController().signal,
    ...overrides,
  }
}

const result = `${JSON.stringify({ type: "system", subtype: "init", session_id: "ses-1" })}\n${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "ses-1" })}\n`

function fakeProcess(): ClaudeProcess {
  const out = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(result))
      controller.close()
    },
  })
  const err = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() })
  return { stdout: out, stderr: err, exited: Promise.resolve(0), exitCode: 0, kill: () => {} }
}

describe("Claude attempt tools", () => {
  test("an advised attempt's MCP host serves write_report and the advisor, bound to that attempt's services", async () => {
    const submitted: DeliverableSubmission[] = []
    const consulted: string[] = []
    let satisfied = false
    const deliverables: DeliverableService = {
      expected: ["report"],
      candidate: () => (submitted.length > 0 ? "accepted" : undefined),
      submit: async (submission) => {
        submitted.push(submission)
        return submission.body ? { ok: true } : { ok: false, error: "empty report", retryable: true, preserved: false }
      },
    }
    const advisor: AdvisorService = {
      firstWriteGate: "hold",
      satisfied: () => satisfied,
      consult: async (consultation) => {
        consulted.push(consultation.trigger)
        satisfied = true
        return { text: "check the edge case", ok: true, callId: "call-1" }
      },
    }
    const seen: { argv?: string[]; tools?: string[]; report?: unknown; badReport?: unknown; advice?: unknown; firstWrite?: unknown; secondWrite?: unknown } = {}
    const runner = createClaudeRunner({
      cwd: "/tmp",
      env: { PATH: "/bin" },
      enforcement,
      deps: {
        probeAuth: async () => ({ authMethod: "claude.ai" }),
        spawn: (argv) => {
          // The fake CLI acts as its MCP host and its hook would, then finishes.
          const work = (async () => {
            const mcp = JSON.parse(readFileSync(argv[argv.indexOf("--mcp-config") + 1]!, "utf8")) as { mcpServers: { convoy: { env: Record<string, string> } } }
            const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]!) as { hooks: { PreToolUse: { hooks: { command: string }[] }[] } }
            const bridgeFile = /CONVOY_BRIDGE_FILE='([^']+)'/.exec(settings.hooks.PreToolUse[0]!.hooks[0]!.command)?.[1]
            const host = convoyToolHost(mcp.mcpServers.convoy.env)!
            const checkpoint = checkpointFromEnv({ [bridgeFileEnv]: bridgeFile! })!
            seen.argv = argv
            seen.tools = host.definitions.map((tool) => tool.name)
            seen.badReport = await host.call("write_report", {})
            seen.report = await host.call("write_report", { markdown: "# Report", commit: { subject: "Fix the bug" } })
            seen.firstWrite = await checkpoint()
            seen.secondWrite = await checkpoint()
            seen.advice = await host.call("advisor", { question: "next?" })
          })()
          const out = new ReadableStream<Uint8Array>({
            async start(controller) {
              await work
              controller.enqueue(new TextEncoder().encode(result))
              controller.close()
            },
          })
          return { stdout: out, stderr: new ReadableStream({ start: (c) => c.close() }), exited: work.then(() => 0), exitCode: 0, kill: () => {} }
        },
      },
    })

    const outcome = await runner.executeAttempt(request({ advised: true, policy: { mode: "write", approvals: "auto", requireAdvisorBeforeWrite: true } }), () => {}, { deliverables, advisor })
    expect(outcome.status).toBe("completed")
    expect(seen.tools).toEqual(["write_report", "advisor", "advisor_feedback"])
    expect(seen.argv!.slice(seen.argv!.indexOf("--allowedTools") + 1)).toEqual(["mcp__convoy__write_report", "mcp__convoy__advisor", "mcp__convoy__advisor_feedback"])
    // A rejected submission is a tool error the agent can correct; a valid one is saved.
    expect(seen.badReport).toEqual({ text: "empty report", isError: true })
    expect(seen.report).toEqual({ text: "Report saved.", isError: false })
    expect(submitted.at(-1)).toEqual({ kind: "report", body: "# Report", commit: { subject: "Fix the bug" } })
    // The first write is held for the advice; the second goes through.
    expect(seen.firstWrite).toMatchObject({ decision: "advise" })
    expect((seen.firstWrite as { message: string }).message).toContain("check the edge case")
    expect(seen.secondWrite).toEqual({ decision: "allow" })
    expect(seen.advice).toEqual({ text: "check the edge case", isError: false })
    expect(consulted).toEqual(["first-write", "on-demand"])
    // The accepted write_report wins over the final text: no second submission.
    expect(submitted).toHaveLength(2)
  })

  test("write_report maps onto the same submission OpenCode's tool sends", () => {
    expect(toolReportSubmission({ markdown: "# R", commit: { subject: "Add x", details: ["a", 1] } })).toEqual({ kind: "report", body: "# R", commit: { subject: "Add x", details: ["a"] } })
    const scored = toolReportSubmission({ markdown: "# S", dimensions: { prd: 80 }, confidence: "high" })
    expect(scored.kind).toBe("score")
    expect(JSON.parse(scored.body)).toEqual({ markdown: "# S", dimensions: { prd: 80 }, confidence: "high" })
  })
})

describe("the PreToolUse first-write checkpoint", () => {
  const policy = { mode: "write" as const, approvals: "auto" as const, requireAdvisorBeforeWrite: true }
  const edit = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/tmp/a.ts" } })
  const decision = (output: string) => (JSON.parse(output) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput

  test("holds the first write with the advice, then lets it through", async () => {
    const held = decision(await evaluateHookInputWithCheckpoint(edit, policy, async () => ({ decision: "advise", message: "Advice: check x" })))
    expect(held).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: "Advice: check x" })
    expect(decision(await evaluateHookInputWithCheckpoint(edit, policy, async () => ({ decision: "allow" }))).permissionDecision).toBe("allow")
  })

  test("an unreachable checkpoint keeps the write blocked, and a hard denial never reaches the advisor", async () => {
    expect(decision(await evaluateHookInputWithCheckpoint(edit, policy, undefined)).permissionDecision).toBe("deny")
    expect(decision(await evaluateHookInputWithCheckpoint(edit, policy, checkpointFromEnv({ [bridgeFileEnv]: "/nonexistent/bridge.json" }))).permissionDecision).toBe("deny")
    let asked = false
    const outside = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/etc/passwd" } })
    const denied = decision(await evaluateHookInputWithCheckpoint(outside, { ...policy, writeRoots: ["/tmp"] }, async () => ((asked = true), { decision: "allow" })))
    expect(denied.permissionDecision).toBe("deny")
    expect(asked).toBe(false)
  })

  test("Convoy's own MCP tools pass the hook; any other MCP tool stays denied", async () => {
    const readOnly = { mode: "read-only" as const, approvals: "auto" as const }
    expect(decision(await evaluateHookInputWithCheckpoint(JSON.stringify({ tool_name: "mcp__convoy__write_report", tool_input: { markdown: "x" } }), readOnly)).permissionDecision).toBe("allow")
    expect(decision(await evaluateHookInputWithCheckpoint(JSON.stringify({ tool_name: "mcp__github__create_issue" }), readOnly)).permissionDecision).toBe("deny")
  })
})

describe("the MCP host's Convoy tools", () => {
  test("lists and routes tools only when the attempt's bridge serves them", async () => {
    const calls: Array<{ name: string; args: unknown }> = []
    const tools = {
      definitions: [{ name: "write_report", description: "d", inputSchema: { type: "object" } }],
      call: async (name: string, args: Record<string, unknown>) => (calls.push({ name, args }), { text: "Report saved.", isError: false }),
    }
    const listed = await handleMcpPermissionRequest({ id: 1, method: "tools/list" }, { resolve: async () => ({ decision: "allow" }), tools })
    expect((listed as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name)).toEqual(["permission", "write_report"])
    const called = await handleMcpPermissionRequest({ id: 2, method: "tools/call", params: { name: "write_report", arguments: { markdown: "# R" } } }, { resolve: async () => ({ decision: "allow" }), tools })
    expect(called).toMatchObject({ result: { content: [{ text: "Report saved." }], isError: false } })
    expect(calls).toEqual([{ name: "write_report", args: { markdown: "# R" } }])
    const unknown = await handleMcpPermissionRequest({ id: 3, method: "tools/call", params: { name: "advisor" } }, { resolve: async () => ({ decision: "allow" }), tools })
    expect(unknown).toMatchObject({ error: { code: -32602 } })
    expect(attemptToolsClient({})).toBeUndefined()
  })
})

describe("Claude advisors", () => {
  test("a Claude step accepts an advisor, and a claude-code advisor needs no OpenCode", () => {
    expect(stepRunnerFor("claude-code").capabilities.advisor).toBe(true)
    const pipeline = resolvePipeline({ name: "claude", spec: { steps: [{ agent: "implementer", runner: "claude-code", model: "sonnet", advisor: "claude-code/opus" }] }, agents: builtInAgents })
    const plan = buildRunPlan(planOptions(pipeline))
    const step = plan.pipeline.steps[0] as AgentStep
    expect(step.resolvedAdvisor).toMatchObject({ providerID: "claude-code", modelID: "opus" })
    expect(preflightTargets(plan)).toEqual([])
    expect(runNeedsOpencodeServer(plan.pipeline)).toBe(false)
  })

  test("consults a Claude advising model over the transcript Convoy recorded", async () => {
    let prompt = ""
    const result = await consultAdvisor({
      sessionID: "ses-1",
      directory: "/tmp",
      model: { providerID: "claude-code", modelID: "opus" },
      reason: "first-write",
      transcript: "### USER\nfix the bug\n\n### ASSISTANT\nI will edit a.ts",
      inferenceSeams: { claude: {
        probeAuth: async () => ({ authMethod: "claude.ai" }),
        spawn: (_argv, options) => {
          void options.stdin.text().then((text) => (prompt = text))
          const out = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Edit b.ts instead.", total_cost_usd: 0.02, usage: { input_tokens: 100, output_tokens: 8 } })}\n`))
              controller.close()
            },
          })
          return { stdout: out, stderr: new ReadableStream({ start: (c) => c.close() }), exited: Promise.resolve(0), exitCode: 0, kill: () => {} }
        },
      } },
    })
    expect(result).toEqual({ kind: "advice", text: "Edit b.ts instead.", usage: { cost: 0.02, tokens: { input: 100, output: 8, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, model: "claude-code/opus" } })
    expect(prompt).toContain("I will edit a.ts")
  })

  test("the runtime hands the advisor the recording of a Claude session", async () => {
    let seen: string | undefined
    const runtime = createAdvisorRuntime({ directory: "/tmp", consult: async (input) => ((seen = input.transcript), { kind: "advice", text: "ok" }) })
    const step = { type: "agent", name: "implement", resolvedAdvisor: { providerID: "claude-code", modelID: "opus" } } as unknown as AgentStep
    const handle = runtime.begin("ses-1", step)!
    runtime.record!("ses-1", { prompt: "fix the bug" })
    runtime.record!("ses-1", { event: { type: "text", runner: "claude-code", attempt: 1, text: "I will ", partId: "p1" } })
    runtime.record!("ses-1", { event: { type: "text", runner: "claude-code", attempt: 1, text: "edit a.ts", partId: "p1" } })
    runtime.record!("ses-1", { event: { type: "tool", runner: "claude-code", attempt: 1, name: "Edit", detail: "a.ts" } })
    await handle.consult("on-demand")
    expect(seen).toBe("### USER\nfix the bug\n\n### ASSISTANT\nI will edit a.ts\n\n### ASSISTANT\n[tool Edit] a.ts")
  })
})

function planOptions(pipeline: ReturnType<typeof resolvePipeline>) {
  return {
    prompt: "x",
    prdHistory: false,
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
    notifications: {},
    humanReview: false,
    baseRef: "HEAD",
    targetDir: "/tmp",
    worktree: false,
    includeDirty: false,
    yolo: false,
    smart: false,
    smartJudgeModel: "claude-code/haiku",
    pipeline,
    agents: [],
    permissions: { allow: [], deny: [] },
    hooks: { pre: [], post: [], pipelines: {} },
  } satisfies RunOptions
}
