import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import type { AdvisorService, ApprovalRequest, DeliverableService, ExecutionRequest, ExecutionServices, LoopDecision, RunnerEvent } from "../src/runners/contracts"
import {
  codexAppServerArgs,
  codexSandbox,
  codexThreadConfig,
  configuredMcpServers,
  createCodexRunner,
  decideCommand,
  decideFileChange,
  usageFromCodexTokens,
  type ApprovalContext,
} from "../src/runners/codex/adapter"
import type { PolicyConfig } from "../src/runners/policy"
import { completeTurn, defaultCodexHandlers, fakeCodex, type FakeCodexServer } from "./helpers/fake-codex"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function checkout(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-codex-"))
  dirs.push(dir)
  return dir
}

function writePolicy(dir: string, overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return { mode: "write", approvals: "auto", writeRoots: [dir], readRoots: [], denyRoots: [join(dir, ".private")], cwd: dir, commands: { "*": "ask", "rm -rf *": "deny" }, ...overrides }
}

function request(dir: string, overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    identity: { runId: "run-codex", phaseName: "implement", attempt: 1 },
    runner: "codex",
    checkout: dir,
    agent: { name: "implementer", mode: "write", model: { runner: "codex", modelId: "gpt-5.5", effort: "high" }, instructions: "You implement." },
    prompt: "do the thing",
    auth: { mode: "subscription" },
    mode: "write",
    approvals: "auto",
    policy: writePolicy(dir),
    signal: new AbortController().signal,
    ...overrides,
  }
}

/** Runs the scripted turn after `turn/start` answers. */
function onTurn(script: (server: FakeCodexServer) => Promise<void> | void) {
  return defaultCodexHandlers({
    "turn/start": (_params, server) => {
      setTimeout(() => void script(server), 0)
      return { turn: { id: "turn-1", status: "inProgress" } }
    },
  })
}

describe("codex invocation", () => {
  test("every Convoy-owned app-server disables the operator's hooks and Codex's own app and browser actions", () => {
    const args = codexAppServerArgs()
    expect(args).toEqual(expect.arrayContaining(["--disable", "hooks", "--disable", "apps", "--disable", "computer_use"]))
  })

  test("read-only and verify attempts run in Codex's read-only sandbox; writes in workspace-write", () => {
    expect(codexSandbox("read-only")).toBe("read-only")
    expect(codexSandbox("verify")).toBe("read-only")
    expect(codexSandbox("write")).toBe("workspace-write")
  })

  test("the thread config disables every operator MCP server and declares only Convoy's host", () => {
    expect(configuredMcpServers({ config: { mcp_servers: { a: {}, b: {} } } })).toEqual(["a", "b"])
    expect(configuredMcpServers({ config: {} })).toEqual([])
    expect(configuredMcpServers(undefined)).toBeUndefined()
    // Without Convoy's host, an operator server under its name is disabled like any other.
    expect(codexThreadConfig(["a", "convoy"])).toEqual({ "mcp_servers.a.enabled": false, "mcp_servers.convoy.enabled": false })
    expect(codexThreadConfig(["a"], { command: "convoy", args: ["mcp", "--bridge-file", "/p"] })).toEqual({
      "mcp_servers.a.enabled": false,
      "mcp_servers.convoy.command": "convoy",
      "mcp_servers.convoy.args": ["mcp", "--bridge-file", "/p"],
      "mcp_servers.convoy.enabled": true,
      "mcp_servers.convoy.tool_timeout_sec": 3600,
    })
  })

  test("an attempt does not start when the operator's MCP servers cannot be read or one takes Convoy's name", async () => {
    const dir = await checkout()
    for (const [configRead, reason] of [
      [async () => { throw new Error("config unavailable") }, "could not read the operator's Codex MCP servers"],
      [() => ({}), "could not read the operator's Codex MCP servers"],
      [() => ({ config: { mcp_servers: { convoy: { command: "operator-convoy" } } } }), "an MCP server named `convoy`"],
    ] as const) {
      const codex = fakeCodex(defaultCodexHandlers({ "config/read": configRead }))
      const outcome = await createCodexRunner({ cwd: dir, mcpHost: ["convoy", "mcp"], deps: { spawn: codex.spawn } }).executeAttempt(request(dir), () => {}, {
        deliverables: { expected: ["report"], candidate: () => "accepted", submit: async () => ({ ok: true }) },
      })
      expect(outcome).toMatchObject({ status: "failed" })
      expect((outcome as { error: string }).error).toContain(reason)
      expect(codex.requests("thread/start")).toHaveLength(0)
    }
  })

  test("token usage splits cached input and reasoning out of OpenAI's totals", () => {
    expect(usageFromCodexTokens({ inputTokens: 100, cachedInputTokens: 60, outputTokens: 30, reasoningOutputTokens: 10, totalTokens: 130 })).toEqual({ input: 40, output: 20, reasoning: 10, cacheRead: 60, cacheWrite: 0 })
  })
})

describe("codex approvals", () => {
  const approvals = (decision: "allow" | "deny", seen: ApprovalRequest[] = []): ExecutionServices => ({
    approvals: {
      async decide(request) {
        seen.push(request)
        return decision
      },
    },
  })
  const context = (policy: PolicyConfig, services?: ExecutionServices, steer: (text: string) => Promise<boolean> = async () => true): ApprovalContext => ({ policy, ...(services ? { services } : {}), advised: false, steer })

  test("policy judges the script a login shell wraps", async () => {
    const dir = await checkout()
    const policy = writePolicy(dir, { commands: { "*": "ask", "bun test*": "allow" } })
    expect(await decideCommand(context(policy), "/bin/zsh -lc 'bun test'", dir)).toMatchObject({ accept: true })
  })

  test("a hard denial holds in every approval mode, a protected path included", async () => {
    const dir = await checkout()
    expect(await decideCommand(context(writePolicy(dir), approvals("allow")), "/bin/zsh -lc 'rm -rf src'", dir)).toMatchObject({ accept: false })
    expect(await decideCommand(context(writePolicy(dir), approvals("allow")), `/bin/zsh -lc 'cat ${join(dir, ".private", "token")}'`, dir)).toMatchObject({ accept: false })
  })

  test("an ask reaches the operator gate, and no gate denies", async () => {
    const dir = await checkout()
    const seen: ApprovalRequest[] = []
    const policy = writePolicy(dir, { approvals: "interactive" })
    expect(await decideCommand(context(policy, approvals("allow", seen)), "/bin/zsh -lc 'git push'", dir)).toMatchObject({ accept: true })
    expect(seen).toEqual([expect.objectContaining({ tool: "shell", action: "bash", resources: ["git push"] })])
    expect(await decideCommand(context(policy), "/bin/zsh -lc 'git push'", dir)).toMatchObject({ accept: false })
  })

  test("inspection is judged as the reads it performs: allowed in a read-only phase, never past a protected path", async () => {
    const dir = await checkout()
    const policy = writePolicy(dir, { mode: "read-only", approvals: "interactive" })
    const ctx = context(policy)
    for (const command of ["/bin/zsh -lc 'cat math.js'", "/bin/zsh -lc 'rg -n subtract src'", "/bin/zsh -lc \"sed -n '1,40p' README.md\"", "/bin/zsh -lc 'git diff --stat'", "ls -la", "cat math.js | head -5"]) {
      expect(await decideCommand(ctx, command, dir)).toMatchObject({ accept: true, reason: "read-only inspection" })
    }
    // Listing a directory that holds a protected one is not a recursive read of it.
    expect(await decideCommand(ctx, `ls -la ${dir}`, dir)).toMatchObject({ accept: true })
    expect(await decideCommand(ctx, `ls -R ${dir}`, dir)).toMatchObject({ accept: false })
    for (const command of [`cat ${join(dir, ".private", "token")}`, "cat ~/.ssh/id_rsa", "cat /etc/passwd", "rg secret /", "rg secret ~", "cat ../outside.txt"]) {
      expect(await decideCommand(ctx, command, dir)).toMatchObject({ accept: false })
    }
    // Not inspection: a redirection, a substitution, an in-place edit, a writer option, a program.
    for (const command of ["cat a > b", "cat $(echo a)", "sed -i 's/a/b/' a", "git log --output=x", "rg --pre ./run x", "node a.js", "find . -delete"]) {
      expect(await decideCommand(ctx, command, dir)).toMatchObject({ accept: false })
    }
  })

  test("no option, expansion or glob spelling carries an inspection past a protected path", async () => {
    const dir = await checkout()
    const ctx = context(writePolicy(dir, { mode: "read-only", approvals: "interactive" }))
    const secret = join(dir, ".private", "token")
    for (const command of [
      // An option the classifier took for one with a value swallowed the path.
      `cat -n ${secret}`,
      `wc -c ${secret}`,
      `grep -c . ${secret}`,
      `rg -c secret ${secret}`,
      `ls -C ${join(dir, ".private")}`,
      `head -n ${secret}`,
      // The shell, not the classifier, decides what these name.
      "cat $XDG_CONFIG_HOME/gh/hosts.yml",
      'cat "$SECRET_FILE"',
      "cat ~root/.ssh/id_rsa",
      `cat ${dir}/{.private,x}/token`,
      `cat ${dir}/.priv*/token`,
      `rg -n x ${dir}/.*`,
      `RIPGREP_CONFIG_PATH=${dir}/rc rg foo`,
      // A file of file names reads paths the classifier never sees.
      `file -f ${dir}/list`,
      `file --files-from=${dir}/list`,
      `wc --files0-from=${dir}/list`,
      `wc --files0-from ${dir}/list`,
      `du --files0-from=${dir}/list`,
    ]) {
      expect({ command, verdict: await decideCommand(ctx, command, dir) }).toMatchObject({ command, verdict: { accept: false } })
    }
    for (const command of ["cat -n math.js", "wc -l src/a.ts", "grep -c foo math.js", "ls -C src", "rg -n 'foo$' src", "head -n 20 math.js", "tail -n +5 math.js", "cat src/*.ts", "rg -g '*.ts' -e subtract src"]) {
      expect({ command, verdict: await decideCommand(ctx, command, dir) }).toMatchObject({ command, verdict: { accept: true } })
    }
  })

  test("git inspection checks its paths and never writes a ref, reads outside the repository, or runs a program", async () => {
    const dir = await checkout()
    const ctx = context(writePolicy(dir, { mode: "read-only", approvals: "interactive" }))
    const secret = join(dir, ".private", "token")
    for (const command of [
      "git branch -D other",
      "git branch new-branch",
      "git branch -m old new",
      "git diff --no-index /etc/passwd /dev/null",
      "git diff /etc/passwd /dev/null",
      `git show -- ${secret}`,
      "git grep --no-index secret /etc/hosts",
      "git grep -O vim x",
      "git -c diff.external=./x diff",
      "git -cdiff.external=./x diff",
      "git log --ext-diff -p",
      `git -C ${join(dir, ".private")} status`,
    ]) {
      expect({ command, verdict: await decideCommand(ctx, command, dir) }).toMatchObject({ command, verdict: { accept: false } })
    }
    for (const command of ["git branch", "git branch -a -v", "git branch --show-current", "git branch --list 'feat/*'", "git log --oneline -n 5", "git diff --stat HEAD~1", "git show HEAD:math.js", "git grep -n subtract", "git -C src status --short", "git --no-pager log -p math.js"]) {
      expect({ command, verdict: await decideCommand(ctx, command, dir) }).toMatchObject({ command, verdict: { accept: true } })
    }
  })

  test("a hard-denied spelling stays denied even when it only reads", async () => {
    const dir = await checkout()
    const policy = writePolicy(dir, { commands: { "*": "ask", "cat *.env*": "deny" } })
    expect(await decideCommand(context(policy), "/bin/zsh -lc 'cat .env'", dir)).toMatchObject({ accept: false })
  })

  test("a read-only attempt declines every write, whatever the sandbox would allow", async () => {
    const dir = await checkout()
    const policy = writePolicy(dir, { mode: "read-only" })
    expect(await decideFileChange(context(policy, approvals("allow")), [join(dir, "a.ts")], dir)).toMatchObject({ accept: false })
    expect(await decideCommand(context(policy, approvals("allow")), "/bin/zsh -lc 'echo hi > a.txt'", dir)).toMatchObject({ accept: false })
  })

  test("a write outside the checkout and a change with no known path are declined", async () => {
    const dir = await checkout()
    expect(await decideFileChange(context(writePolicy(dir)), ["/etc/hosts"], dir)).toMatchObject({ accept: false })
    expect(await decideFileChange(context(writePolicy(dir)), [], dir)).toMatchObject({ accept: false })
    expect(await decideFileChange(context(writePolicy(dir)), [join(dir, "src", "a.ts")], dir)).toMatchObject({ accept: true })
  })

  test("the first advised write is held for one consultation and its advice steered into the turn", async () => {
    const dir = await checkout()
    let satisfied = false
    const delivered: string[] = []
    const advisor: AdvisorService = {
      firstWriteGate: "hold",
      satisfied: () => satisfied,
      async consult() {
        satisfied = true
        return { ok: true, text: "Edit b.ts instead.", callId: "c1" }
      },
      async delivered(_callId, how) {
        delivered.push(how)
      },
    }
    const steered: string[] = []
    const ctx: ApprovalContext = { policy: writePolicy(dir, { requireAdvisorBeforeWrite: true }), services: { advisor }, advised: true, steer: async (text) => (steered.push(text), true) }
    expect(await decideFileChange(ctx, [join(dir, "a.ts")], dir)).toMatchObject({ accept: false })
    expect(steered[0]).toContain("Edit b.ts instead.")
    expect(delivered).toEqual(["follow-up"])
    expect(await decideFileChange(ctx, [join(dir, "a.ts")], dir)).toMatchObject({ accept: true })
  })

  test("a failed consultation releases the hold; an unreachable checkpoint keeps the write blocked", async () => {
    const dir = await checkout()
    const failing: AdvisorService = { firstWriteGate: "hold", satisfied: () => false, consult: async () => ({ ok: false, text: "unavailable" }) }
    const policy = writePolicy(dir, { requireAdvisorBeforeWrite: true })
    expect(await decideFileChange({ policy, services: { advisor: failing }, advised: true, steer: async () => true }, [join(dir, "a.ts")], dir)).toMatchObject({ accept: true })
    expect(await decideFileChange({ policy, advised: true, steer: async () => true }, [join(dir, "a.ts")], dir)).toMatchObject({ accept: false, reason: "no advisor checkpoint is reachable for this attempt" })
  })

  test("advice that cannot be steered into the turn keeps the first write blocked", async () => {
    const dir = await checkout()
    let satisfied = false
    const delivered: string[] = []
    const advisor: AdvisorService = {
      firstWriteGate: "hold",
      satisfied: () => satisfied,
      async consult() {
        satisfied = true
        return { ok: true, text: "Edit b.ts instead.", callId: "c1" }
      },
      async delivered(_callId, how) {
        delivered.push(how)
      },
    }
    let reachable = false
    const steered: string[] = []
    const ctx: ApprovalContext = {
      policy: writePolicy(dir, { requireAdvisorBeforeWrite: true }),
      services: { advisor },
      advised: true,
      steer: async (text) => (reachable && steered.push(text), reachable),
    }
    expect(await decideFileChange(ctx, [join(dir, "a.ts")], dir)).toMatchObject({ accept: false })
    expect(await decideFileChange(ctx, [join(dir, "a.ts")], dir)).toMatchObject({ accept: false })
    expect(delivered).toEqual([])
    reachable = true
    expect(await decideFileChange(ctx, [join(dir, "a.ts")], dir)).toMatchObject({ accept: false })
    expect(steered).toEqual([expect.stringContaining("Edit b.ts instead.")])
    expect(delivered).toEqual(["follow-up"])
    expect(await decideFileChange(ctx, [join(dir, "a.ts")], dir)).toMatchObject({ accept: true })
  })
})

describe("codex attempt", () => {
  test("runs one turn: thread settings, approvals answered by policy, transcript, usage, and the final answer", async () => {
    const dir = await checkout()
    const answers: unknown[] = []
    const codex = fakeCodex(
      onTurn(async (server) => {
        server.notify("item/started", { item: { type: "fileChange", id: "fc-1", changes: [{ path: join(dir, "a.ts"), kind: { type: "add" }, diff: "x" }], status: "inProgress" } })
        answers.push((await server.request("item/fileChange/requestApproval", { threadId: "thread-1", turnId: "turn-1", itemId: "fc-1" })).result)
        answers.push((await server.request("item/commandExecution/requestApproval", { threadId: "thread-1", turnId: "turn-1", itemId: "c-1", command: "/bin/zsh -lc 'rm -rf src'", cwd: dir })).result)
        answers.push((await server.request("mcpServer/elicitation/request", { serverName: "convoy", mode: "form", message: "allow?" })).result)
        answers.push((await server.request("mcpServer/elicitation/request", { serverName: "operator_tools", mode: "form", message: "allow?" })).result)
        answers.push((await server.request("item/permissions/requestApproval", {})).error?.message)
        server.notify("item/agentMessage/delta", { itemId: "msg-1", delta: "Working" })
        server.notify("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 5, reasoningOutputTokens: 1 } } })
        completeTurn(server, "# Report\nDone.")
      }),
    )
    const events: RunnerEvent[] = []
    const outcome = await createCodexRunner({ cwd: dir, deps: { spawn: codex.spawn } }).executeAttempt(request(dir), (event) => events.push(event))

    expect(outcome).toMatchObject({ status: "completed", assistantText: "# Report\nDone.", session: { runner: "codex", sessionId: "thread-1" }, usage: { input: 6, output: 4, reasoning: 1, cacheRead: 4 } })
    expect(answers).toEqual([{ decision: "accept" }, { decision: "decline" }, { action: "accept", content: null }, { action: "decline", content: null }, "Convoy declines item/permissions/requestApproval"])
    expect(codex.spawned[0]!.command).toEqual(["codex", "app-server", ...codexAppServerArgs()])
    const thread = codex.requests("thread/start")[0]!.params as Record<string, unknown>
    expect(thread).toMatchObject({ cwd: dir, approvalPolicy: "untrusted", sandbox: "workspace-write", model: "gpt-5.5", config: { "mcp_servers.operator_tools.enabled": false } })
    expect(thread.developerInstructions).toStartWith("You implement.\n\nConvoy runs this phase on Codex, where the shell is how you read")
    expect(codex.requests("turn/start")[0]!.params).toMatchObject({ threadId: "thread-1", effort: "high", input: [{ type: "text", text: "do the thing" }] })
    expect(events.find((event) => event.type === "session")).toMatchObject({ session: { sessionId: "thread-1" } })
    expect(events.filter((event) => event.type === "text").map((event) => (event as { text: string }).text)).toEqual(["Working"])
    expect(events.at(-1)).toMatchObject({ type: "terminal", outcome: { status: "completed" } })
    // The declined command's reason reaches the running turn, not "the user".
    const steer = codex.requests("turn/steer")[0]!.params as { input: { text: string }[] }
    expect(steer.input[0]!.text).toStartWith("Convoy declined the command `rm -rf src`: hard-denied command")
  })

  test("the final answer is the fallback report; an accepted write_report wins", async () => {
    const dir = await checkout()
    const submitted: string[] = []
    const deliverables = (candidate?: string): DeliverableService => ({
      expected: ["report"],
      candidate: () => candidate,
      async submit(submission) {
        submitted.push(submission.body)
        return { ok: true }
      },
    })
    const run = async (services: ExecutionServices) => {
      const codex = fakeCodex(onTurn((server) => completeTurn(server, "# Final")))
      return createCodexRunner({ cwd: dir, deps: { spawn: codex.spawn } }).executeAttempt(request(dir), () => {}, services)
    }
    expect(await run({ deliverables: deliverables() })).toMatchObject({ status: "completed" })
    expect(submitted).toEqual(["# Final"])
    await run({ deliverables: deliverables("# Accepted") })
    expect(submitted).toEqual(["# Final"])
  })

  test("an account other than the reviewed one refuses the attempt before any thread starts", async () => {
    const dir = await checkout()
    const codex = fakeCodex(defaultCodexHandlers({ "account/read": () => ({ account: { type: "apiKey" } }) }))
    const outcome = await createCodexRunner({ cwd: dir, deps: { spawn: codex.spawn } }).executeAttempt(request(dir), () => {})
    expect(outcome).toMatchObject({ status: "failed" })
    expect(outcome.error).toContain("reviewed as a subscription")
    expect(codex.requests("thread/start")).toEqual([])
  })

  test("a Codex older than the supported protocol, or with no readable release, refuses the attempt before any thread starts", async () => {
    const dir = await checkout()
    for (const userAgent of ["convoy/0.150.2 (Mac OS 27.0.1; arm64)", "codex_cli_rs 0.99.0"]) {
      const codex = fakeCodex(defaultCodexHandlers({ initialize: () => ({ userAgent, codexHome: "/home/.codex" }) }))
      const outcome = await createCodexRunner({ cwd: dir, deps: { spawn: codex.spawn } }).executeAttempt(request(dir), () => {})
      expect(outcome).toMatchObject({ status: "failed" })
      expect(outcome.error).toContain("update Codex with `codex update`")
      expect(codex.requests("thread/start")).toEqual([])
    }
  })

  test("ambient OpenAI keys never reach a subscription child", async () => {
    const dir = await checkout()
    const codex = fakeCodex(onTurn((server) => completeTurn(server)))
    await createCodexRunner({ cwd: dir, env: { PATH: "/bin", OPENAI_API_KEY: "sk-live", CODEX_API_KEY: "ck" }, deps: { spawn: codex.spawn } }).executeAttempt(request(dir), () => {})
    expect(codex.spawned[0]!.env.OPENAI_API_KEY).toBeUndefined()
    expect(codex.spawned[0]!.env.CODEX_API_KEY).toBeUndefined()
  })

  test("a continued session resumes its exact thread", async () => {
    const dir = await checkout()
    const codex = fakeCodex(
      defaultCodexHandlers({
        "thread/resume": () => ({ thread: { id: "thread-9" } }),
        "turn/start": (_params, server) => {
          setTimeout(() => server.notify("turn/completed", { threadId: "thread-9", turn: { id: "turn-1", status: "completed", items: [{ type: "agentMessage", text: "ok" }] } }), 0)
          return { turn: { id: "turn-1" } }
        },
      }),
    )
    const outcome = await createCodexRunner({ cwd: dir, deps: { spawn: codex.spawn } }).executeAttempt(request(dir, { continueSession: { runner: "codex", sessionId: "thread-9" } }), () => {})
    expect(outcome).toMatchObject({ status: "completed", session: { sessionId: "thread-9" } })
    expect(codex.requests("thread/resume")[0]!.params).toMatchObject({ threadId: "thread-9" })
    expect(codex.requests("thread/start")).toEqual([])
  })

  test("the loop guard steers a nudge into the turn and interrupts on a stop", async () => {
    const dir = await checkout()
    const decisions: LoopDecision[] = [{ action: "nudge", reason: "try something else" }, { action: "stop", code: "identical-calls", reason: "repeated the same call" }]
    const codex = fakeCodex(
      onTurn((server) => {
        server.notify("item/started", { item: { type: "commandExecution", id: "c-1", command: "/bin/zsh -lc ls" } })
        server.notify("item/started", { item: { type: "commandExecution", id: "c-2", command: "/bin/zsh -lc ls" } })
        setTimeout(() => server.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", items: [] } }), 10)
      }),
    )
    const outcome = await createCodexRunner({ cwd: dir, deps: { spawn: codex.spawn } }).executeAttempt(request(dir), () => {}, {
      loopGuard: { observe: (observation) => (observation.kind === "call" ? (decisions.shift() ?? { action: "continue" }) : { action: "continue" }) },
    })
    expect(codex.requests("turn/steer")[0]!.params).toMatchObject({ expectedTurnId: "turn-1", input: [{ type: "text", text: "try something else" }] })
    expect(codex.requests("turn/interrupt")).toHaveLength(1)
    expect(outcome).toMatchObject({ status: "failed", error: "loop guard: repeated the same call" })
  })

  test("cancelling interrupts the turn and settles as interrupted with the thread recorded", async () => {
    const dir = await checkout()
    const controller = new AbortController()
    const codex = fakeCodex(onTurn(() => void setTimeout(() => controller.abort(), 0)))
    const outcome = await createCodexRunner({ cwd: dir, deps: { spawn: codex.spawn } }).executeAttempt(request(dir, { signal: controller.signal }), () => {})
    expect(outcome).toMatchObject({ status: "interrupted", session: { sessionId: "thread-1" } })
    expect(codex.requests("turn/interrupt")).toHaveLength(1)
  })

  test("a child that exits mid-turn fails the attempt", async () => {
    const dir = await checkout()
    const codex = fakeCodex(onTurn((server) => server.exit(1)))
    const outcome = await createCodexRunner({ cwd: dir, deps: { spawn: codex.spawn } }).executeAttempt(request(dir), () => {})
    expect(outcome).toMatchObject({ status: "failed" })
    expect(outcome.error).toContain("exited before the turn finished")
  })

  test("a failed turn reports Codex's error", async () => {
    const dir = await checkout()
    const codex = fakeCodex(onTurn((server) => completeTurn(server, "partial", "failed")))
    const outcome = await createCodexRunner({ cwd: dir, deps: { spawn: codex.spawn } }).executeAttempt(request(dir), () => {})
    expect(outcome).toMatchObject({ status: "failed", error: "model error" })
  })

  test("the adapter refuses another runner's request", async () => {
    const dir = await checkout()
    const outcome = await createCodexRunner({ cwd: dir }).executeAttempt(request(dir, { runner: "claude-code" }), () => {})
    expect(outcome).toMatchObject({ status: "failed", error: "codex adapter received a claude-code request" })
  })
})
