import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { codexAuthShellCommand, codexResumeProblem, openCodexSessionWindow } from "../src/codex-cli"
import { bridgeFileEnvironment, convoyToolHost } from "../src/runners/commands"
import { handleMcpPermissionRequest } from "../src/runners/claude/mcp-permission-server"
import { bridgeFileFlag, createCodexRunner } from "../src/runners/codex/adapter"
import { codexAccountMismatch, prepareCodexAuth } from "../src/runners/codex/auth"
import { codexInference, isReadOnlyHelperCommand } from "../src/runners/codex/inference"
import { missingCodexModel, offeredCodexModels, preflightCodex } from "../src/runners/codex/preflight"
import type { ExecutionRequest } from "../src/runners/contracts"
import { convoySecretsDir } from "../src/workspace"
import { codexVersionProblem } from "../src/runners/declarations"
import { completeTurn, defaultCodexHandlers, fakeCodex } from "./helpers/fake-codex"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-codex-services-"))
  dirs.push(dir)
  return dir
}

describe("Convoy's tools reach a Codex attempt through a private bridge file", () => {
  test("the host's address and token live in an owner-only file named on the host's argv, and are discarded after the attempt", async () => {
    const dir = await tempDir()
    let bridgeFile = ""
    let contents: Record<string, string> = {}
    let mode = 0
    const codex = fakeCodex(
      defaultCodexHandlers({
        "thread/start": async (params) => {
          const args = (params as { config: Record<string, string[]> }).config["mcp_servers.convoy.args"]!
          bridgeFile = args[args.indexOf(bridgeFileFlag) + 1]!
          contents = JSON.parse(await readFile(bridgeFile, "utf8"))
          mode = (await stat(bridgeFile)).mode & 0o777
          return { thread: { id: "thread-1" } }
        },
        "turn/start": (_params, server) => {
          setTimeout(() => completeTurn(server), 0)
          return { turn: { id: "turn-1" } }
        },
      }),
    )
    const request: ExecutionRequest = {
      identity: { runId: "r", phaseName: "p", attempt: 1 },
      runner: "codex",
      checkout: dir,
      agent: { name: "a", mode: "write", model: { runner: "codex", modelId: "default" } },
      prompt: "x",
      auth: { mode: "subscription" },
      mode: "write",
      approvals: "auto",
      signal: new AbortController().signal,
    }
    await createCodexRunner({ cwd: dir, mcpHost: ["convoy", "mcp"], deps: { spawn: codex.spawn } }).executeAttempt(request, () => {}, {
      deliverables: { expected: ["report"], candidate: () => "accepted", submit: async () => ({ ok: true }) },
    })
    expect(bridgeFile.startsWith(convoySecretsDir())).toBe(true)
    expect(mode).toBe(0o600)
    expect(contents.CONVOY_TOOLS).toBe("report")
    // The host's write_report schema follows the attempt's phase: writable, not scoring.
    expect(contents.CONVOY_REPORT_SCOPE).toBe("writable")
    expect(contents.CONVOY_TOOLS_URL).toStartWith("http://127.0.0.1:")
    expect(contents.CONVOY_APPROVAL_TOKEN).toMatch(/^[0-9a-f]{64}$/)
    // Neither the token nor the address is on the app-server's argv or environment.
    expect(JSON.stringify(codex.spawned[0])).not.toContain(contents.CONVOY_APPROVAL_TOKEN!)
    expect(existsSync(bridgeFile)).toBe(false)
  })

  test("`convoy mcp --bridge-file` serves Convoy's tools only, with no permission tool", async () => {
    const dir = await tempDir()
    const file = join(dir, "bridge.json")
    await writeFile(file, JSON.stringify({ CONVOY_TOOLS_URL: "http://127.0.0.1:1", CONVOY_APPROVAL_TOKEN: "t", CONVOY_TOOLS: "report,advisor" }))
    const env = await bridgeFileEnvironment(["--bridge-file", file])
    expect(env).toEqual({ CONVOY_TOOLS_URL: "http://127.0.0.1:1", CONVOY_APPROVAL_TOKEN: "t", CONVOY_TOOLS: "report,advisor" })
    expect(await bridgeFileEnvironment([])).toBeUndefined()
    expect(await bridgeFileEnvironment(["--bridge-file", join(dir, "missing.json")])).toEqual({})
    const tools = convoyToolHost(env)!
    const listed = await handleMcpPermissionRequest({ id: 1, method: "tools/list" }, { permissionTool: false, tools, resolve: async () => ({ decision: "deny" }) })
    expect((listed as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name)).toEqual(["write_report", "advisor", "advisor_feedback"])
    const permission = await handleMcpPermissionRequest({ id: 2, method: "tools/call", params: { name: "permission", arguments: {} } }, { permissionTool: false, tools, resolve: async () => ({ decision: "allow" }) })
    expect(permission).toMatchObject({ error: { code: -32602 } })
  })

  test("the host offers write_report scoped to the attempt's phase", () => {
    const schemaFor = (scope?: string) => {
      const tools = convoyToolHost({ CONVOY_TOOLS_URL: "http://127.0.0.1:1", CONVOY_APPROVAL_TOKEN: "t", CONVOY_TOOLS: "report", ...(scope !== undefined ? { CONVOY_REPORT_SCOPE: scope } : {}) })!
      return tools.definitions[0]!.inputSchema as { properties: Record<string, unknown>; required: string[] }
    }
    expect(Object.keys(schemaFor("").properties)).toEqual(["markdown"])
    expect(Object.keys(schemaFor("writable").properties)).toEqual(["markdown", "commit"])
    expect(schemaFor("scoring").required).toEqual(["markdown", "dimensions"])
    expect(schemaFor("scoring").properties.commit).toBeUndefined()
    // A host without a scope (an unscoped bridge) offers every field.
    expect(Object.keys(schemaFor().properties)).toEqual(["markdown", "dimensions", "mustFix", "gaps", "confidence", "commit"])
  })
})

describe("reopening a Codex thread", () => {
  test("only a thread the operator's Codex home holds is reopened; an API-key thread is refused with its reason", async () => {
    const home = await tempDir()
    const thread = "01a15065-0fe6-7cd1-a60a-0db398a995b2"
    const env = { CODEX_HOME: home }
    expect(await codexResumeProblem(thread, { mode: "subscription" }, env)).toContain("is not in your Codex home")
    await expect(openCodexSessionWindow({ targetDir: home, sessionID: thread, env })).rejects.toThrow("cannot be reopened")
    await Bun.write(join(home, "sessions", "2026", "10", "18", `rollout-2026-10-18T20-02-42-${thread}.jsonl`), "{}\n")
    expect(await codexResumeProblem(thread, { mode: "subscription" }, env)).toBeUndefined()
    expect(await codexResumeProblem(thread, { mode: "api-key", credentialRef: "CONVOY_OPENAI_KEY" }, env)).toContain("ran under API-key mode")
    expect(await codexResumeProblem("../../x", { mode: "subscription" }, env)).toContain("is not in your Codex home")
  })
})

describe("Codex authentication", () => {
  test("subscription removes ambient OpenAI keys and refuses a credential reference", async () => {
    const auth = await prepareCodexAuth({ selection: { mode: "subscription" }, env: { PATH: "/bin", OPENAI_API_KEY: "sk-x", CODEX_API_KEY: "y" }, cwd: "/tmp" })
    expect(auth.env.OPENAI_API_KEY).toBeUndefined()
    expect(auth.env.CODEX_API_KEY).toBeUndefined()
    expect(auth.env.CODEX_HOME).toBeUndefined()
    await expect(prepareCodexAuth({ selection: { mode: "subscription", credentialRef: "K" }, cwd: "/tmp" })).rejects.toThrow(/must not carry a credential reference/)
  })

  test("api-key logs the key in to a private Codex home through stdin, never the operator's, and discards it", async () => {
    const seen: { env: NodeJS.ProcessEnv; key: string }[] = []
    const auth = await prepareCodexAuth({
      selection: { mode: "api-key", credentialRef: "CONVOY_OPENAI_KEY" },
      env: { PATH: "/bin", CONVOY_OPENAI_KEY: "sk-secret", OPENAI_API_KEY: "sk-ambient" },
      cwd: "/tmp",
      login: async (input) => (seen.push({ env: input.env, key: input.key }), { code: 0, stderr: "" }),
    })
    const home = auth.env.CODEX_HOME!
    expect(home.startsWith(join(convoySecretsDir(), "codex-home"))).toBe(true)
    expect(seen).toEqual([{ env: expect.objectContaining({ CODEX_HOME: home }), key: "sk-secret" }])
    expect(auth.env.OPENAI_API_KEY).toBeUndefined()
    expect(auth.description).not.toContain("sk-secret")
    expect(existsSync(home)).toBe(true)
    await auth.discard()
    expect(existsSync(home)).toBe(false)
  })

  test("api-key fails closed on a missing key or a failed login", async () => {
    await expect(prepareCodexAuth({ selection: { mode: "api-key", credentialRef: "MISSING" }, env: {}, cwd: "/tmp" })).rejects.toThrow(/"MISSING" is missing or empty/)
    await expect(
      prepareCodexAuth({ selection: { mode: "api-key", credentialRef: "K" }, env: { K: "sk" }, cwd: "/tmp", login: async () => ({ code: 1, stderr: "bad key" }) }),
    ).rejects.toThrow(/login --with-api-key failed \(status 1\): bad key/)
  })

  test("the effective account must match the reviewed mode", () => {
    expect(codexAccountMismatch("subscription", { account: { type: "chatgpt" } })).toBeUndefined()
    expect(codexAccountMismatch("api-key", { account: { type: "apiKey" } })).toBeUndefined()
    expect(codexAccountMismatch("subscription", { account: { type: "apiKey" } })).toContain("would bill an API key")
    expect(codexAccountMismatch("api-key", { account: { type: "chatgpt" } })).toContain("reviewed as an API key")
    expect(codexAccountMismatch("subscription", { account: null })).toContain("run `codex login`")
  })

  test("an interactive api-key client types only the variable's name and removes its private home", () => {
    const line = codexAuthShellCommand("codex", { mode: "api-key", credentialRef: "CONVOY_OPENAI_KEY" })
    expect(line).toContain('"$CONVOY_OPENAI_KEY"')
    expect(line).toContain("login --with-api-key")
    expect(line).toEndWith('codex; rm -rf "$CODEX_HOME"')
    expect(codexAuthShellCommand("codex")).toBe("unset OPENAI_API_KEY CODEX_API_KEY; codex")
    expect(() => codexAuthShellCommand("codex", { mode: "api-key", credentialRef: "sk-live" })).toThrow()
  })
})

describe("Codex helper inference", () => {
  test("answers once on an ephemeral read-only thread, declining every write", async () => {
    const answers: unknown[] = []
    const codex = fakeCodex(
      defaultCodexHandlers({
        "turn/start": (_params, server) => {
          setTimeout(async () => {
            answers.push((await server.request("item/fileChange/requestApproval", { itemId: "f" })).result)
            answers.push((await server.request("item/commandExecution/requestApproval", { command: "/bin/zsh -lc 'git log -5'" })).result)
            answers.push((await server.request("item/commandExecution/requestApproval", { command: "/bin/zsh -lc 'curl example.com'" })).result)
            completeTurn(server, '{"safe": true, "reason": "read-only"}')
          }, 0)
          return { turn: { id: "turn-1" } }
        },
      }),
    )
    const result = await codexInference({ prompt: "is this safe?", system: "judge", variant: "low", auth: { mode: "subscription" }, cwd: "/tmp", tools: "read-only" }, { spawn: codex.spawn })
    expect(result.text).toBe('{"safe": true, "reason": "read-only"}')
    expect(answers).toEqual([{ decision: "decline" }, { decision: "accept" }, { decision: "decline" }])
    expect(codex.requests("thread/start")[0]!.params).toMatchObject({ ephemeral: true, sandbox: "read-only", developerInstructions: "judge", config: { "mcp_servers.operator_tools.enabled": false } })
    expect(codex.requests("turn/start")[0]!.params).toMatchObject({ effort: "low" })
  })

  test("a tool-less helper runs nothing, and a failed turn or timeout throws", async () => {
    const codex = fakeCodex(
      defaultCodexHandlers({
        "turn/start": (_params, server) => {
          setTimeout(async () => {
            expect((await server.request("item/commandExecution/requestApproval", { command: "ls" })).result).toEqual({ decision: "decline" })
            completeTurn(server, "x", "failed")
          }, 0)
          return { turn: { id: "turn-1" } }
        },
      }),
    )
    await expect(codexInference({ prompt: "p", system: "s", auth: { mode: "subscription" }, cwd: "/tmp", tools: "none" }, { spawn: codex.spawn })).rejects.toThrow(/answered with an error: model error/)
    const silent = fakeCodex()
    await expect(codexInference({ prompt: "p", system: "s", auth: { mode: "subscription" }, cwd: "/tmp", tools: "none", timeoutMs: 20 }, { spawn: silent.spawn })).rejects.toThrow("codex inference timed out")
    expect(silent.requests("turn/interrupt")).toHaveLength(1)
  })

  test("helper inference does not start a thread when the operator's MCP servers cannot be read", async () => {
    const codex = fakeCodex(defaultCodexHandlers({ "config/read": async () => { throw new Error("config unavailable") } }))
    await expect(codexInference({ prompt: "p", system: "s", auth: { mode: "subscription" }, cwd: "/tmp", tools: "none", timeoutMs: 500 }, { spawn: codex.spawn })).rejects.toThrow("could not read the operator's Codex MCP servers")
    expect(codex.requests("thread/start")).toHaveLength(0)
  })

  test("helper inference refuses a Codex with no readable or supported release before any thread", async () => {
    const codex = fakeCodex(defaultCodexHandlers({ initialize: () => ({ userAgent: "convoy/0.150.2", codexHome: "/home/.codex" }) }))
    await expect(codexInference({ prompt: "p", system: "s", auth: { mode: "subscription" }, cwd: "/tmp", tools: "none", timeoutMs: 500 }, { spawn: codex.spawn })).rejects.toThrow("predates the supported app-server protocol")
    expect(codex.requests("thread/start")).toHaveLength(0)
  })

  test("only plain inspection commands count as read-only", () => {
    for (const command of ["ls -la", "cat a.ts | head -5", "git diff --stat", "rg foo src", "/bin/zsh -lc 'git status'", "find . -name '*.ts'"]) expect(isReadOnlyHelperCommand(command)).toBe(true)
    for (const command of ["git push", "rm a", "cat a > b", "echo $(id)", "find . -delete", "npm test", "ls; curl x"]) expect(isReadOnlyHelperCommand(command)).toBe(false)
    // Option and expansion spellings that once hid the path they read.
    for (const command of [`cat -n ${convoySecretsDir()}/x`, `wc -c ${convoySecretsDir()}/x`, "cat $XDG_CONFIG_HOME/x", "git diff --no-index /etc/passwd /dev/null", "git branch -D main"]) {
      expect({ command, readOnly: isReadOnlyHelperCommand(command) }).toEqual({ command, readOnly: false })
    }
  })
})

describe("Codex preflight", () => {
  const offered = offeredCodexModels({
    data: [
      { id: "gpt-6.1-sol", model: "gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
      { id: "gpt-5.5", model: "gpt-5.5", supportedReasoningEfforts: [] },
    ],
  })

  test("names a model or effort the account does not offer", () => {
    expect(missingCodexModel([{ model: "gpt-6.1-sol", effort: "high", label: "step a" }, { model: "default", label: "step b" }, { model: "gpt-5.5", effort: "xhigh", label: "step c" }], offered)).toBeUndefined()
    expect(missingCodexModel([{ model: "gpt-9", label: "step a" }], offered)).toBe('step a names the Codex model "gpt-9", which this account does not offer')
    expect(missingCodexModel([{ model: "gpt-6.1-sol", effort: "minimal", label: "the judge" }], offered)).toContain('reasoning effort "minimal"')
  })

  test("checks the account first, then the plan's models", async () => {
    const codex = fakeCodex(defaultCodexHandlers({ "model/list": () => ({ data: [{ id: "gpt-5.5", supportedReasoningEfforts: [] }] }) }))
    expect(await preflightCodex({ selection: { mode: "subscription" }, models: [{ model: "gpt-5.5", label: "step a" }], cwd: "/tmp", spawn: codex.spawn })).toBeUndefined()
    expect(await preflightCodex({ selection: { mode: "subscription" }, models: [{ model: "gpt-9", label: "step a" }], cwd: "/tmp", spawn: codex.spawn })).toContain('"gpt-9"')
    const keyed = fakeCodex(defaultCodexHandlers({ "account/read": () => ({ account: { type: "apiKey" } }) }))
    expect(await preflightCodex({ selection: { mode: "subscription" }, models: [], cwd: "/tmp", spawn: keyed.spawn })).toContain("reviewed as a subscription")
  })

  test("refuses a Codex older than the supported app-server protocol, read from initialize's user agent", async () => {
    const old = fakeCodex(defaultCodexHandlers({ initialize: () => ({ userAgent: "convoy/0.150.2 (Mac OS 27.0.1; arm64)", codexHome: "/home/.codex" }) }))
    expect(await preflightCodex({ selection: { mode: "subscription" }, models: [], cwd: "/tmp", spawn: old.spawn })).toContain("Codex 0.150.2 predates the supported app-server protocol (0.160.0 or later)")
    const current = fakeCodex(defaultCodexHandlers({ initialize: () => ({ userAgent: "convoy/0.163.0 (Mac OS 27.0.1; arm64) herdr/0.9.5 (convoy; 0.0.0)", codexHome: "/home/.codex" }) }))
    expect(await preflightCodex({ selection: { mode: "subscription" }, models: [], cwd: "/tmp", spawn: current.spawn })).toBeUndefined()
  })

  test("refuses a Codex whose release cannot be read: an unreadable version is never taken as current", async () => {
    for (const userAgent of ["codex_cli_rs 0.99.0", "convoy/dev", undefined]) {
      const drifted = fakeCodex(defaultCodexHandlers({ initialize: () => ({ ...(userAgent ? { userAgent } : {}), codexHome: "/home/.codex" }) }))
      expect(await preflightCodex({ selection: { mode: "subscription" }, models: [], cwd: "/tmp", spawn: drifted.spawn })).toContain("did not report a readable release")
    }
    expect(codexVersionProblem("x.y")).toContain("did not report a readable release")
    expect(codexVersionProblem(undefined)).toContain("did not report a readable release")
    expect(codexVersionProblem("0.160.0")).toBeUndefined()
  })
})
