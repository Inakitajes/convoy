import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { advisorTokenEnv, advisorUrlEnv } from "../src/advisor-bridge"
import { hookPhaseNames, hooksForPipeline, runHooks } from "../src/hooks"
import { noopProgress, type ProgressUI } from "../src/progress"
import type { HooksConfig } from "../src/types"
import type { Workspace } from "../src/workspace"

const dirs: string[] = []
const runUsageEnvNames = [
  "CONVOY_RUN_COST",
  "CONVOY_RUN_ADVISOR_COST",
  "CONVOY_RUN_TOKENS_INPUT",
  "CONVOY_RUN_TOKENS_OUTPUT",
  "CONVOY_RUN_TOKENS_REASONING",
  "CONVOY_RUN_TOKENS_CACHE_READ",
  "CONVOY_RUN_TOKENS_CACHE_WRITE",
  "CONVOY_RUN_TOKENS_TOTAL",
  "CONVOY_RUN_DURATION_MS",
] as const

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function hookContext() {
  const targetDir = await mkdtemp(join(tmpdir(), "convoy-hooks-target-"))
  const runDir = await mkdtemp(join(tmpdir(), "convoy-hooks-run-"))
  dirs.push(targetDir, runDir)
  return {
    workspace: { dir: runDir, runID: "20260101-000000-hook" } as Workspace,
    targetDir,
    pipelineName: "implement",
    prompt: "prompt",
    progress: noopProgress,
  }
}

describe("hooks", () => {
  test("combines global and pipeline-specific hooks in order", () => {
    const config: HooksConfig = {
      pre: [{ command: "global-pre" }],
      post: [{ command: "global-post" }],
      pipelines: {
        implement: { pre: [{ command: "pipeline-pre" }], post: [{ command: "pipeline-post" }] },
      },
    }

    expect(hooksForPipeline(config, "implement")).toEqual({
      pre: [{ command: "global-pre" }, { command: "pipeline-pre" }],
      post: [{ command: "global-post" }, { command: "pipeline-post" }],
    })
    expect(hooksForPipeline(config, "review")).toEqual({ pre: [{ command: "global-pre" }], post: [{ command: "global-post" }] })
  })

  test("runs hooks from the target repo with Convoy environment variables", async () => {
    const context = await hookContext()

    await runHooks("pre", [{ command: 'printf "%s:%s:%s" "$CONVOY_PIPELINE" "$CONVOY_HOOK_STAGE" "$CONVOY_RUN_ID" > hook.out' }], context)

    expect(await readFile(join(context.targetDir, "hook.out"), "utf8")).toBe("implement:pre:20260101-000000-hook")
  })

  test("does not expose the advisor bridge credentials to project hooks", async () => {
    const context = await hookContext()
    const previousUrl = process.env[advisorUrlEnv]
    const previousToken = process.env[advisorTokenEnv]
    process.env[advisorUrlEnv] = "http://127.0.0.1:12345/advise"
    process.env[advisorTokenEnv] = "bridge-secret"

    try {
      await runHooks("post", [{ command: `printf '%s:%s' "\${${advisorUrlEnv}-unset}" "\${${advisorTokenEnv}-unset}" > hook.out` }], { ...context, status: "success" })
      expect(await readFile(join(context.targetDir, "hook.out"), "utf8")).toBe("unset:unset")
    } finally {
      if (previousUrl === undefined) delete process.env[advisorUrlEnv]
      else process.env[advisorUrlEnv] = previousUrl
      if (previousToken === undefined) delete process.env[advisorTokenEnv]
      else process.env[advisorTokenEnv] = previousToken
    }
  })

  test("post hooks honor run status filters", async () => {
    const context = await hookContext()
    const hooks = [
      { command: 'printf success >> status.out', when: "success" as const },
      { command: 'printf failure >> status.out', when: "failure" as const },
      { command: 'printf always >> status.out', when: "always" as const },
    ]

    await runHooks("post", hooks, { ...context, status: "failure" })

    expect(await readFile(join(context.targetDir, "status.out"), "utf8")).toBe("failurealways")
  })

  test("can run hooks from the run directory", async () => {
    const context = await hookContext()

    await runHooks("pre", [{ command: "pwd > cwd.out", cwd: "run" }], context)

    expect(await realpath((await readFile(join(context.workspace.dir, "cwd.out"), "utf8")).trim())).toBe(await realpath(context.workspace.dir))
  })

  test("post hooks receive the goal-cycle outcome as CONVOY_GOAL_* variables", async () => {
    // The goal loop lets a hook distinguish "cleared the bar" from "gave up
    // short of it": both runs succeed, but CONVOY_GOAL_REACHED carries the
    // verdict and CONVOY_GOAL_SCORE the best measured score.
    const context = await hookContext()
    await runHooks("post", [{ command: 'printf "%s:%s:%s" "$CONVOY_GOAL_REACHED" "$CONVOY_GOAL_TARGET" "$CONVOY_GOAL_SCORE" > goal.out', when: "always" }], {
      ...context,
      status: "success",
      goal: { reached: true, target: 85, score: 92 },
    })
    expect(await readFile(join(context.targetDir, "goal.out"), "utf8")).toBe("true:85:92")

    // A cycle that never produced a parseable score leaves CONVOY_GOAL_SCORE
    // unset rather than faking a number; reached stays honest too.
    await runHooks("post", [{ command: 'printf "%s:%s:%s" "$CONVOY_GOAL_REACHED" "$CONVOY_GOAL_TARGET" "${CONVOY_GOAL_SCORE-unset}" > goal2.out', when: "always" }], {
      ...context,
      status: "success",
      goal: { reached: false, target: 90 },
    })
    expect(await readFile(join(context.targetDir, "goal2.out"), "utf8")).toBe("false:90:unset")
  })

  test("hooks without a goal cycle see no CONVOY_GOAL_* variables", async () => {
    const context = await hookContext()
    await runHooks("post", [{ command: 'printf "%s" "${CONVOY_GOAL_REACHED-unset}" > nogoal.out', when: "always" }], { ...context, status: "success" })
    expect(await readFile(join(context.targetDir, "nogoal.out"), "utf8")).toBe("unset")
  })

  test("post hooks receive formatted run usage while pre-hooks do not", async () => {
    const context = await hookContext()
    const usage = {
      cost: 3.2,
      advisorCost: 0.125,
      tokens: { input: 1_234_567, output: 20, reasoning: 3, cacheRead: 4, cacheWrite: 5, total: 1_234_599 },
      durationMs: 90_000.4,
    }
    const command = 'printf "%s:%s:%s:%s:%s:%s:%s:%s:%s" "$CONVOY_RUN_COST" "$CONVOY_RUN_ADVISOR_COST" "$CONVOY_RUN_TOKENS_INPUT" "$CONVOY_RUN_TOKENS_OUTPUT" "$CONVOY_RUN_TOKENS_REASONING" "$CONVOY_RUN_TOKENS_CACHE_READ" "$CONVOY_RUN_TOKENS_CACHE_WRITE" "$CONVOY_RUN_TOKENS_TOTAL" "$CONVOY_RUN_DURATION_MS" > usage.out'

    await runHooks("post", [{ command, when: "always" }], { ...context, status: "success", usage })
    expect(await readFile(join(context.targetDir, "usage.out"), "utf8")).toBe("3.2000:0.1250:1234567:20:3:4:5:1234599:90000")

    await runHooks("pre", [{ command: 'printf "%s" "${CONVOY_RUN_COST-unset}" > pre-usage.out' }], { ...context, usage })
    expect(await readFile(join(context.targetDir, "pre-usage.out"), "utf8")).toBe("unset")
  })

  test("post hooks omit unavailable usage groups", async () => {
    const context = await hookContext()
    const command = 'printf "%s:%s:%s" "${CONVOY_RUN_COST-unset}" "${CONVOY_RUN_ADVISOR_COST-unset}" "${CONVOY_RUN_DURATION_MS-unset}" > partial-usage.out'

    await runHooks("post", [{ command, when: "always" }], { ...context, status: "failure", usage: { durationMs: 25 } })
    expect(await readFile(join(context.targetDir, "partial-usage.out"), "utf8")).toBe("unset:unset:25")

    // Advisor-only spend reaches the total without inventing executor tokens.
    const advisorOnly = 'printf "%s:%s:%s" "$CONVOY_RUN_COST" "$CONVOY_RUN_ADVISOR_COST" "${CONVOY_RUN_TOKENS_TOTAL-unset}" > advisor-usage.out'
    await runHooks("post", [{ command: advisorOnly, when: "always" }], { ...context, status: "failure", usage: { cost: 0.2, advisorCost: 0.2 } })
    expect(await readFile(join(context.targetDir, "advisor-usage.out"), "utf8")).toBe("0.2000:0.2000:unset")
  })

  test("hooks do not inherit run usage from the parent environment", async () => {
    const context = await hookContext()
    const previous = runUsageEnvNames.map((name) => [name, process.env[name]] as const)
    const expansions = runUsageEnvNames.map((name) => `\${${name}-unset}`).join(":")
    const expected = runUsageEnvNames.map(() => "unset").join(":")
    for (const name of runUsageEnvNames) process.env[name] = "stale"

    try {
      await runHooks("pre", [{ command: `printf "%s" "${expansions}" > inherited-pre-usage.out` }], { ...context, usage: { durationMs: 25 } })
      await runHooks("post", [{ command: `printf "%s" "${expansions}" > inherited-post-usage.out`, when: "always" }], { ...context, status: "success" })

      expect(await readFile(join(context.targetDir, "inherited-pre-usage.out"), "utf8")).toBe(expected)
      expect(await readFile(join(context.targetDir, "inherited-post-usage.out"), "utf8")).toBe(expected)
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  test("fails on a non-zero hook unless continueOnError is true", async () => {
    const context = await hookContext()

    await expect(runHooks("pre", [{ name: "bad", command: "exit 7" }], context)).rejects.toThrow('pre-hook "bad" exited with code 7')
    await expect(runHooks("pre", [{ name: "allowed", command: "exit 7", continueOnError: true }], context)).resolves.toBeUndefined()
  })

  test("times out long-running hooks", async () => {
    const context = await hookContext()
    await writeFile(join(context.targetDir, "slow.sh"), "#!/bin/sh\nsleep 2\n")
    await Bun.spawn(["chmod", "+x", join(context.targetDir, "slow.sh")]).exited

    await expect(runHooks("pre", [{ name: "slow", command: "./slow.sh", timeoutSeconds: 1 }], context)).rejects.toThrow("timed out")
  })

  test("hookPhaseNames are stable and disambiguate duplicate labels", () => {
    const names = hookPhaseNames("post", [{ name: "deploy", command: "a" }, { command: "npm    run\nlint" }, { name: "deploy", command: "b" }])
    expect(names).toEqual(["post-hook: deploy", "post-hook: npm run lint", "post-hook: deploy (3)"])
  })

  test("reports each hook as a dashboard phase with its output in the feed", async () => {
    const context = await hookContext()
    const events: string[] = []
    const progress: ProgressUI = {
      ...noopProgress,
      phaseStarted: (name) => void events.push(`started ${name}`),
      phaseCompleted: (name) => void events.push(`completed ${name}`),
      phaseFailed: (name, detail) => void events.push(`failed ${name}: ${detail}`),
      phaseSkipped: (name) => void events.push(`skipped ${name}`),
      phaseActivity: (name, detail) => void events.push(`activity ${name}: ${detail}`),
    }
    const hooks = [
      { name: "notify", command: "echo hook says hi", when: "always" as const },
      { name: "only-on-failure", command: "echo never", when: "failure" as const },
      { name: "broken", command: "exit 3", when: "always" as const, continueOnError: true },
    ]

    await runHooks("post", hooks, { ...context, progress, status: "success" })

    expect(events).toEqual([
      "started post-hook: notify",
      "activity post-hook: notify: hook says hi",
      "completed post-hook: notify",
      "skipped post-hook: only-on-failure",
      "started post-hook: broken",
      "failed post-hook: broken: exited with code 3",
    ])
  })
})
