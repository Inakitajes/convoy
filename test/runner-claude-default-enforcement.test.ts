import { afterAll, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { bashPolicy, noAdditions } from "../src/bash-policy"
import { LoopGuard, resolveLoopGuard } from "../src/loop-guard"
import type { AdvisorRuntime } from "../src/advisor-runtime"
import type { ReportRuntime } from "../src/report-runtime"
import type { AgentStep } from "../src/types"
import type { AttemptContext } from "../src/runners/attempt"
import { resolveRunnerCapabilities } from "../src/runners/capabilities"
import { buildClaudeInvocation } from "../src/runners/claude/adapter"
import { executeClaudeAttempt } from "../src/runners/claude/attempt"
import { assertEnforcementReady } from "../src/runners/claude/enforcement"
import { convoyEnforcementPlan, convoySubcommandArgv, resolveClaudeEnforcement, shellCommandLine } from "../src/runners/claude/enforcement-plan"
import { composeRunners } from "../src/runners/compose"
import type { AttemptOutcome, ExecutionAdapter, ExecutionRequest, ExecutionServices } from "../src/runners/contracts"
import { approvalsFor, phasePolicy, rootForms } from "../src/runners/phase-policy"
import { evaluateAction, runnerPolicyEnv, type PolicyConfig } from "../src/runners/policy"
import type { ServiceRuntimes } from "../src/runners/service-runtimes"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const entry = resolve("src/main.ts")
const sourceArgv = (sub: string) => [process.execPath, entry, sub]

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    identity: { runId: "run", phaseName: "scope", attempt: 1 },
    runner: "claude-code",
    checkout: "/repo",
    agent: { name: "review-scope", mode: "verify", model: { runner: "claude-code", modelId: "sonnet" } },
    prompt: "go",
    auth: { mode: "subscription" },
    mode: "verify",
    approvals: "interactive",
    signal: new AbortController().signal,
    ...overrides,
  }
}

function verifyPolicy(): PolicyConfig {
  return phasePolicy({
    mode: "verify",
    autoAccept: "off",
    checkout: "/repo",
    runDir: "/runs/r1",
    privateDirs: ["/runs/r1/.private"],
    commands: bashPolicy("/nonexistent", noAdditions),
  })
}

/** Runs a PreToolUse payload through a hook command line exactly as Claude would: via a shell. */
async function runHook(commandLine: string, payload: unknown, policy: PolicyConfig): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", commandLine], {
    cwd: process.cwd(),
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, [runnerPolicyEnv]: JSON.stringify(policy) },
  })
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return JSON.parse(out).hookSpecificOutput.permissionDecision
}

describe("phase policy", () => {
  test("auto-accept maps onto the approval mode an ask follows", () => {
    expect(approvalsFor("all")).toBe("auto")
    expect(approvalsFor("smart")).toBe("smart")
    expect(approvalsFor("off")).toBe("interactive")
  })

  test("confines writes to the checkout and run dir and protects the private dir", () => {
    const policy = phasePolicy({ mode: "write", autoAccept: "all", checkout: "/repo", runDir: "/runs/r1", privateDirs: ["/runs/r1/.private"], commands: {} })
    expect(policy).toMatchObject({ mode: "write", approvals: "auto", writeRoots: ["/repo", "/runs/r1"], denyRoots: ["/runs/r1/.private"] })
  })
})

test("roots match a path in both its given and its real form", async () => {
  const dir = await mkdtemp(join(tmpdir(), "convoy-roots-"))
  dirs.push(dir)
  const real = realpathSync(dir)
  const policy = phasePolicy({ mode: "write", autoAccept: "off", checkout: dir, runDir: dir, privateDirs: [join(dir, "missing")], commands: {} })
  expect(policy.writeRoots).toContain(dir)
  expect(policy.writeRoots).toContain(real)
  expect(evaluateAction({ tool: "Write", intent: "write", resource: join(real, "hello.txt") }, policy).effect).toBe("allow")
  expect(rootForms("/definitely/not/here")).toEqual(["/definitely/not/here"])
})

describe("default Claude enforcement", () => {
  test("re-invokes this Convoy: a release binary directly, a source checkout through its entry script", () => {
    expect(convoySubcommandArgv("hook", true)).toEqual([process.execPath, "hook"])
    const source = convoySubcommandArgv("mcp", false)
    expect(source[0]).toBe(process.execPath)
    expect(source.at(-1)).toBe("mcp")
    // Always Convoy's own entry, never argv[1]: a script embedding Convoy (the
    // acceptance runner) re-ran itself per hook call and forked without bound.
    expect(source.at(-2)).toBe(join(import.meta.dir, "..", "src", "main.ts"))
  })

  test("quotes the hook command line for the shell Claude runs it through", () => {
    expect(shellCommandLine(["/usr/bin/bun", "/a b/main.ts", "it's", "hook"])).toBe(`/usr/bin/bun '/a b/main.ts' 'it'\\''s' hook`)
  })

  test("the default plan is ready, and the environment only overrides its commands", () => {
    const plan = convoyEnforcementPlan(sourceArgv)
    expect(() => assertEnforcementReady(plan)).not.toThrow()
    expect(plan.mcpConfig).toEqual({ mcpServers: { convoy: { command: process.execPath, args: [entry, "mcp"] } } })
    const overridden = resolveClaudeEnforcement({ CONVOY_CLAUDE_HOOK_COMMAND: "my-hook", CONVOY_CLAUDE_MCP_COMMAND: "my-mcp" })
    expect(overridden.mcpConfig).toEqual({ mcpServers: { convoy: { command: "my-mcp", args: [] } } })
    expect(() => assertEnforcementReady(resolveClaudeEnforcement({}))).not.toThrow()
  })

  test("a verify attempt is no longer refused: it runs enforced with its reviewed policy in the child env", () => {
    const policy = verifyPolicy()
    const invocation = buildClaudeInvocation(request({ policy }), convoyEnforcementPlan(sourceArgv), { env: {} })
    expect(invocation.args).toContain("--settings")
    expect(invocation.args).toContain("--permission-prompt-tool")
    expect(JSON.parse(invocation.env[runnerPolicyEnv]!)).toEqual(policy)
  })

  test("without a reviewed policy the children enforce the attempt's own mode, never a wider default", () => {
    const invocation = buildClaudeInvocation(request({ mode: "read-only", approvals: "auto" }), undefined, { env: {} })
    expect(JSON.parse(invocation.env[runnerPolicyEnv]!)).toEqual({ mode: "read-only", approvals: "auto" })
  })

  test("the rendered hook command runs through a shell and applies the verify policy", async () => {
    const plan = convoyEnforcementPlan(sourceArgv)
    const hook = ((plan.settings as { hooks: { PreToolUse: { hooks: { command: string }[] }[] } }).hooks.PreToolUse[0]!.hooks[0]!).command
    const policy = verifyPolicy()
    expect(await runHook(hook, { tool_name: "Bash", tool_input: { command: "bun test 2>&1" } }, policy)).toBe("allow")
    expect(await runHook(hook, { tool_name: "Bash", tool_input: { command: "rm -rf src" } }, policy)).toBe("deny")
    expect(await runHook(hook, { tool_name: "Bash", tool_input: { command: "git push origin" } }, policy)).toBe("deny")
    expect(await runHook(hook, { tool_name: "Write", tool_input: { file_path: "/repo/a.ts" } }, policy)).toBe("deny")
    expect(await runHook(hook, { tool_name: "Read", tool_input: { file_path: "/runs/r1/.private/password" } }, policy)).toBe("deny")
  }, 30_000)
})

describe("service binding by the composition", () => {
  const runtimes = (): ServiceRuntimes => ({
    reports: { handleFor: () => undefined } as unknown as ReportRuntime,
    advisors: { handleFor: () => undefined } as unknown as AdvisorRuntime,
    loopGuard: new LoopGuard(resolveLoopGuard(undefined)),
    expected: ["report"],
    session: () => "ses_1",
  })

  test("OpenCode binds the report, advisor and loop-guard services it honors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-bind-"))
    dirs.push(dir)
    const composition = composeRunners({ cwd: dir })
    const services = composition.servicesFor("opencode", runtimes(), resolveRunnerCapabilities("opencode"))
    expect(Object.keys(services).sort()).toEqual(["advisor", "deliverables", "loopGuard"])
    expect(services.deliverables?.expected).toEqual(["report"])
    expect(composition.abortsSessionOnShutdown("opencode")).toBe(true)
    await composition.close()
  })

  test("Claude binds the session's deliverables and advisor, and owns its session through cancellation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-bind-"))
    dirs.push(dir)
    const composition = composeRunners({ cwd: dir })
    // No runtimes, no services; the loop guard is never bound (print mode cannot be nudged).
    const bound = composition.servicesFor("claude-code", runtimes(), resolveRunnerCapabilities("claude-code"))
    expect(bound.loopGuard).toBeUndefined()
    expect(bound.approvals).toBeUndefined()
    expect(composition.abortsSessionOnShutdown("claude-code")).toBe(false)
    await composition.close()
  })

  test("Claude declares the loop guard unavailable with its reason", () => {
    const loop = resolveRunnerCapabilities("claude-code").capabilities.find((entry) => entry.id === "loop-guard")
    expect(loop?.availability).toBe("unavailable")
    expect(loop && loop.availability !== "available" ? loop.reason : "").toContain("nudge")
  })
})

describe("Claude attempt", () => {
  test("hands the composed adapter its services and the reviewed policy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-claude-attempt-"))
    dirs.push(dir)
    let seen: { request?: ExecutionRequest; services?: ExecutionServices } = {}
    const adapter: ExecutionAdapter = {
      id: "claude-code",
      capabilities: async () => resolveRunnerCapabilities("claude-code"),
      async executeAttempt(req, _sink, services): Promise<AttemptOutcome> {
        seen = { request: req, ...(services ? { services } : {}) }
        return { status: "completed", assistantText: "# report" }
      },
      cancelAttempt: async () => undefined,
    }
    const services: ExecutionServices = { deliverables: { expected: ["report"], submit: async () => ({ ok: true }) } }
    const policy = phasePolicy({ mode: "write", autoAccept: "off", checkout: dir, runDir: dir, privateDirs: [join(dir, ".private")], commands: {} })
    const context: AttemptContext = {
      identity: { runId: "run", phaseName: "implement", attempt: 1 },
      runner: "claude-code",
      phase: { name: "implement", agentName: "implementer", readOnly: false, verify: false, model: "sonnet" } as AgentStep,
      targetDir: dir,
      prompt: "go",
      model: { providerID: "anthropic", modelID: "sonnet" },
      attachments: [],
      sink: () => undefined,
      signal: new AbortController().signal,
      attempt: 1,
      services,
      policy,
    }
    const result = await executeClaudeAttempt(context, adapter)
    expect(result.assistantText).toBe("# report")
    expect(seen.services).toBe(services)
    expect(seen.request?.policy).toBe(policy)
    expect(seen.request?.approvals).toBe("interactive")
  })
})
