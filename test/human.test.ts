import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runHumanReviewGate } from "../src/human"
import { noopProgress, type HumanReviewAction, type HumanReviewPromptInfo, type ProgressUI } from "../src/progress"

import type { RunOptions } from "../src/types"
import type { Workspace } from "../src/workspace"

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function git(args: string[], cwd: string) {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "archer-human-review-"))
  dirs.push(root)
  const targetDir = join(root, "repo")
  const runDir = join(root, "run")
  await mkdir(targetDir)
  await mkdir(runDir)
  await git(["init", "-q"], targetDir)
  await writeFile(join(targetDir, "README.md"), "base\n")
  await git(["add", "-A"], targetDir)
  await git(["commit", "-qm", "base"], targetDir)
  return {
    workspace: { dir: runDir, runID: "20260708-120000-test" } as Workspace,
    options: {
      humanReview: true,
      targetDir,
      resumeRunID: "",
      appRunCommand: "",
      emulatorID: "",
      interactiveModel: "openai/gpt-5.5",
      interactiveVariant: "",
    } as RunOptions,
  }
}

function progressWithActions(actions: HumanReviewAction[]) {
  const calls = {
    suspend: 0,
    resume: 0,
    completed: 0,
    activities: [] as string[],
    prompts: [] as HumanReviewPromptInfo[],
  }
  const progress: ProgressUI = {
    ...noopProgress,
    suspend: () => void calls.suspend++,
    resume: () => void calls.resume++,
    phaseCompleted: () => void calls.completed++,
    phaseActivity: (_name, detail) => void calls.activities.push(detail),
    askHumanReview: (info) => {
      calls.prompts.push(info)
      return Promise.resolve(actions.shift() ?? "continue")
    },
  }
  return { calls, progress }
}

describe("runHumanReviewGate", () => {
  test("keeps human review inside the TUI when askHumanReview is available", async () => {
    const { workspace, options } = await fixture()
    const { calls, progress } = progressWithActions(["continue"])

    await runHumanReviewGate(workspace, options, "http://127.0.0.1:1234", progress)

    expect(calls.suspend).toBe(0)
    expect(calls.resume).toBe(0)
    expect(calls.completed).toBe(1)
    expect(calls.prompts).toHaveLength(1)
    expect(calls.prompts[0]).toMatchObject({ stepName: "human-review", appRunning: false, appCommand: "" })
    await expect(readFile(join(workspace.dir, "reports", "human-review.md"), "utf8")).resolves.toContain("- Result: approved")
  })

  test("handles start-app from the TUI without inheriting terminal output", async () => {
    const { workspace, options } = await fixture()
    const { calls, progress } = progressWithActions(["prepare", "continue"])

    await runHumanReviewGate(workspace, options, "http://127.0.0.1:1234", progress)

    expect(calls.suspend).toBe(0)
    expect(calls.prompts).toHaveLength(2)
    expect(calls.activities).toContain("app launch disabled; start it manually")
    await expect(readFile(join(workspace.dir, "reports", "human-review.md"), "utf8")).resolves.toContain("- Result: approved")
  })

  test("pauses the permission gate while an external TUI iteration is active", async () => {
    const { workspace, options } = await fixture()
    let paused = false
    const events: string[] = []
    const { calls, progress } = progressWithActions(["iterate", "continue"])
    const originalAsk = progress.askHumanReview!
    const pausedAtPrompt: boolean[] = []
    progress.askHumanReview = (info) => {
      pausedAtPrompt.push(paused)
      return originalAsk(info)
    }

    await runHumanReviewGate(
      workspace,
      options,
      "http://127.0.0.1:1234",
      progress,
      {
        stop: async () => {},
        pause: () => {
          paused = true
          events.push("pause")
        },
        resume: () => {
          paused = false
          events.push("resume")
        },
      },
      "human-review",
      {
        openInteractiveOpencodeWindow: async () => "terminal",
        runInteractiveOpencode: async () => {},
      },
    )

    expect(events).toEqual(["pause", "resume"])
    expect(pausedAtPrompt).toEqual([false, true])
    expect(calls.activities).toContain("OpenCode iteration opened in terminal; return here and press c to continue")
    await expect(readFile(join(workspace.dir, "reports", "human-review.md"), "utf8")).resolves.toContain("- Manual OpenCode iterations: 1")
  })

  test("falls back to suspended same-terminal iteration when the TUI window cannot open", async () => {
    const { workspace, options } = await fixture()
    const events: string[] = []
    let interactiveRuns = 0
    const { calls, progress } = progressWithActions(["iterate", "continue"])

    await runHumanReviewGate(
      workspace,
      options,
      "http://127.0.0.1:1234",
      progress,
      {
        stop: async () => {},
        pause: () => void events.push("pause"),
        resume: () => void events.push("resume"),
      },
      "human-review",
      {
        openInteractiveOpencodeWindow: async () => {
          throw new Error("unsupported platform")
        },
        runInteractiveOpencode: async () => void interactiveRuns++,
      },
    )

    expect(interactiveRuns).toBe(1)
    expect(calls.suspend).toBe(1)
    expect(calls.resume).toBe(1)
    expect(events).toEqual(["pause", "resume", "pause", "resume"])
    expect(calls.activities).toContain("couldn't open OpenCode iteration: unsupported platform")
    expect(calls.activities).toContain("falling back to interactive OpenCode in this terminal")
    await expect(readFile(join(workspace.dir, "reports", "human-review.md"), "utf8")).resolves.toContain("- Manual OpenCode iterations: 1")
  })
})
