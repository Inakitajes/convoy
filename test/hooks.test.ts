import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { hooksForPipeline, runHooks } from "../src/hooks"
import { noopProgress } from "../src/progress"
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
})
