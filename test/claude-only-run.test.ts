import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { builtInAgents } from "../src/pipeline"
import { readRunMetadata } from "../src/metadata"
import { buildRunPlan, soleCliRunner } from "../src/run-plan"
import { run, runNeedsOpencodeServer, type RunDeps } from "../src/runner"
import { cachedCompositionCount } from "../src/runners/attempt-composition"
import type { AgentStep, Pipeline, RunOptions } from "../src/types"

// Spec runner-execution, "Claude-only workstation": a Claude-only plan runs
// preflight, execution, reports, and finalization without starting OpenCode.
// The real run() drives a fake `claude` CLI on PATH; starting OpenCode fails
// the test outright.

const dirs: string[] = []
let originalPath: string | undefined
let claudeCalls: string

beforeAll(async () => {
  const bin = await mkdtemp(join(tmpdir(), "convoy-fake-claude-"))
  dirs.push(bin)
  claudeCalls = join(bin, "calls.log")
  const report = "# Review\\n\\nThe change is sound."
  await writeFile(
    join(bin, "claude"),
    [
      "#!/bin/sh",
      `echo "$*" >> ${JSON.stringify(claudeCalls)}`,
      'if [ "$1" = "auth" ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'; exit 0; fi',
      "cat > /dev/null",
      // printf, not echo: POSIX sh's echo would expand the JSON's `\n` escapes.
      `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"ses-claude-1"}'`,
      `printf '%s\\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"${report}"}}}'`,
      `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"${report}","session_id":"ses-claude-1","total_cost_usd":0}'`,
    ].join("\n"),
  )
  await chmod(join(bin, "claude"), 0o755)
  originalPath = process.env.PATH
  process.env.PATH = `${bin}:${process.env.PATH}`
})

afterAll(async () => {
  process.env.PATH = originalPath
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function git(args: string[], cwd: string) {
  const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  })
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`)
}

const reviewer: AgentStep = {
  type: "agent",
  name: "review",
  agentName: "security-auditor",
  description: "review",
  model: "sonnet",
  runner: "claude-code",
  readOnly: true,
  inputFiles: [],
  inputDiff: false,
  reportPath: "reports/review.md",
  groupId: "g-review",
  stepName: "review",
}
const claudeOnly: Pipeline = { name: "claude-only", steps: [reviewer] }

const noOpencode: RunDeps["startOpencode"] = async () => {
  throw new Error("a Claude-only run must not start OpenCode")
}

describe("Claude-only run", () => {
  test("needs no OpenCode server unless a step, advisor, or judge runs there", () => {
    expect(soleCliRunner(claudeOnly)).toBe("claude-code")
    expect(runNeedsOpencodeServer(claudeOnly)).toBe(false)
    expect(runNeedsOpencodeServer(claudeOnly, { providerID: "claude-code" })).toBe(false)
    // An explicitly OpenCode-routed judge or advisor still gets its server.
    expect(runNeedsOpencodeServer(claudeOnly, { providerID: "openai" })).toBe(true)
    expect(runNeedsOpencodeServer({ ...claudeOnly, steps: [{ ...reviewer, resolvedAdvisor: { configured: "openai/gpt-5.5", logical: "openai/gpt-5.5", gateway: "configured", providerID: "openai", modelID: "gpt-5.5", target: "openai/gpt-5.5" } }] })).toBe(true)
    expect(runNeedsOpencodeServer({ ...claudeOnly, steps: [{ ...reviewer, runner: undefined, model: "openai/gpt-5.5" }] })).toBe(true)
  })

  test("a smart Claude-only plan judges with Claude, never an OpenCode model", () => {
    const plan = buildRunPlan({ ...options("/tmp/x"), smart: true, smartJudgeModel: "claude-code/haiku" })
    expect(plan.smartJudge).toMatchObject({ runner: "claude-code", model: { providerID: "claude-code", modelID: "haiku" } })
  })

  test("executes, reports, and finalizes without starting OpenCode", async () => {
    const repo = await mkdtemp(join(tmpdir(), "convoy-claude-only-repo-"))
    dirs.push(repo)
    await git(["init", "-q"], repo)
    await writeFile(join(repo, "README.md"), "base\n")
    await git(["add", "-A"], repo)
    await git(["commit", "-qm", "base"], repo)

    const logged: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => void logged.push(args.join(" "))
    const result = await run({ ...options(repo), plan: buildRunPlan(options(repo)) }, { startOpencode: noOpencode }).finally(() => {
      console.error = originalError
    })
    // Someone following the log (a CLI agent) sees the same session and usage
    // lines an OpenCode step prints.
    expect(logged.join("\n")).toContain("[review] session: ses-claude-1")
    expect(logged.join("\n")).toContain("[review] usage: $0.0000")
    expect(await readFile(join(result.dir, "reports", "review.md"), "utf8")).toContain("The change is sound.")
    const metadata = await readRunMetadata(join(result.dir, "metadata.json"))
    expect(metadata?.server).toBeUndefined()
    expect(metadata?.phases.review?.status).toBe("completed")
    // Versioned provenance names the runner, auth, model, and exact session.
    expect(metadata?.phases.review?.execution).toMatchObject({
      version: 1,
      runner: "claude-code",
      auth: { mode: "subscription" },
      model: { modelId: "sonnet" },
      session: { sessionId: "ses-claude-1" },
      attempt: { phase: "review", attempt: 1 },
    })
    // The raw stream-json is kept for inspection, owner-only.
    const streamLog = join(result.dir, "logs", "review.1.claude.jsonl")
    expect(await readFile(streamLog, "utf8")).toContain('"session_id":"ses-claude-1"')
    expect((await stat(streamLog)).mode & 0o777).toBe(0o600)
    // [o] reopens the finished session with the directories it could read.
    const directories = JSON.parse(await readFile(join(result.dir, "logs", "claude-ses-claude-1-directories.json"), "utf8")) as string[]
    expect(directories[0]).toBe(result.dir)
    // The run's attempt composition ended with it.
    expect(cachedCompositionCount()).toBe(0)
    // The Claude CLI ran the step under a verified subscription login.
    const calls = await readFile(claudeCalls, "utf8")
    expect(calls).toContain("auth status --json")
    expect(calls).toContain("--output-format stream-json")
  })
})

function options(repo: string): RunOptions {
  return {
    prompt: "review it",
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
    notifications: { enabled: false, terminalTitle: false },
    humanReview: false,
    baseRef: "HEAD",
    targetDir: repo,
    worktree: false,
    includeDirty: false,
    yolo: true,
    smart: false,
    smartJudgeModel: "claude-code/haiku",
    pipeline: claudeOnly,
    agents: [...builtInAgents],
    permissions: { allow: [], deny: [] },
    hooks: { pre: [], post: [], pipelines: {} },
  }
}
