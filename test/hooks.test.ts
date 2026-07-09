import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { hookPhaseNames, hooksForPipeline, runHooks } from "../src/hooks"
import { noopProgress, type ProgressUI } from "../src/progress"
import type { HooksConfig } from "../src/types"
import type { Workspace } from "../src/workspace"

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function hookContext() {
  const targetDir = await mkdtemp(join(tmpdir(), "archer-hooks-target-"))
  const runDir = await mkdtemp(join(tmpdir(), "archer-hooks-run-"))
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

  test("runs hooks from the target repo with Archer environment variables", async () => {
    const context = await hookContext()

    await runHooks("pre", [{ command: 'printf "%s:%s:%s" "$ARCHER_PIPELINE" "$ARCHER_HOOK_STAGE" "$ARCHER_RUN_ID" > hook.out' }], context)

    expect(await readFile(join(context.targetDir, "hook.out"), "utf8")).toBe("implement:pre:20260101-000000-hook")
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
