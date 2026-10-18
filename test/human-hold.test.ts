import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stdin, stdout } from "node:process"

import { runHumanReviewGate } from "../src/human"
import { noopProgress, type HumanReviewAction, type HumanReviewPromptInfo, type ProgressUI } from "../src/progress"

import type { RunOptions } from "../src/types"
import type { Workspace } from "../src/workspace"

// PRD §9 "human-hold": a coordinated run has no TTY on the coordinator, so the
// human gate must be driven by progress.askHumanReview alone — the promise the
// control adapter parks until a controller answers. The gate may never skip
// just because stdin/stdout aren't interactive, and --no-human-step still skips.

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function git(args: string[], cwd: string) {
  const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "convoy-human-hold-"))
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
    workspace: { dir: runDir, runID: "20260820-120000-test" } as Workspace,
    options: {
      humanReview: true,
      targetDir,
      resumeRunID: "",
    } as Partial<RunOptions> as RunOptions,
  }
}

/** Forces the no-TTY world the coordinator lives in, for the test's window. */
async function withoutTty(fn: () => Promise<void>): Promise<void> {
  const stdinTty = stdin.isTTY
  const stdoutTty = stdout.isTTY
  Object.defineProperty(stdin, "isTTY", { value: false, configurable: true })
  Object.defineProperty(stdout, "isTTY", { value: false, configurable: true })
  try {
    await fn()
  } finally {
    Object.defineProperty(stdin, "isTTY", { value: stdinTty, configurable: true })
    Object.defineProperty(stdout, "isTTY", { value: stdoutTty, configurable: true })
  }
}

/**
 * A hold harness shaped like ControlProgress: askHumanReview parks on a promise
 * only the test (standing in for the controller's POST /human) can resolve.
 */
function holdingProgress() {
  const prompts: HumanReviewPromptInfo[] = []
  const skipped: string[] = []
  const started: string[] = []
  const completed: string[] = []
  let resolveAsk!: (action: HumanReviewAction) => void
  const open = new Promise<HumanReviewAction>((resolve) => {
    resolveAsk = resolve
  })
  const progress: ProgressUI = {
    ...noopProgress,
    phaseSkipped: (name) => void skipped.push(name),
    phaseStarted: (name, _detail) => void started.push(name),
    phaseCompleted: (name) => void completed.push(name),
    askHumanReview: (info) => {
      prompts.push(info)
      return open
    },
  }
  return { progress, prompts, skipped, started, completed, resolveAsk }
}

describe("human gate hold without a TTY", () => {
  test("askHumanReview on progress is used even without a TTY — the gate never skips", async () => {
    const { workspace, options } = await fixture()
    const h = holdingProgress()

    const gate = runHumanReviewGate(workspace, options, { url: "http://127.0.0.1:1234" }, h.progress)
    const deadline = Date.now() + 2_000
    while (h.prompts.length === 0 && Date.now() < deadline) await Bun.sleep(5)

    await withoutTty(async () => {
      // The prompt was asked and the gate is waiting; nothing skipped.
      expect(h.prompts).toMatchObject([{ stepName: "human-review", iterations: 0 }])
      expect(h.started).toEqual(["human-review"])
      expect(h.skipped).toEqual([])
      // Give a hypothetical non-TTY skip branch time to fire; none should.
      await Bun.sleep(50)
      expect(h.skipped).toEqual([])

      // The controller answers; the gate completes like an in-TUI one.
      h.resolveAsk("continue")
      await gate
    })

    expect(h.completed).toEqual(["human-review"])
    await expect(readFile(join(workspace.dir, "reports", "human-review.md"), "utf8")).resolves.toContain("- Result: approved")
  })

  test("the gate holds indefinitely while no controller has answered", async () => {
    const { workspace, options } = await fixture()
    const h = holdingProgress()

    const gate = runHumanReviewGate(workspace, options, { url: "http://127.0.0.1:1234" }, h.progress)
    const deadline = Date.now() + 2_000
    while (h.prompts.length === 0 && Date.now() < deadline) await Bun.sleep(5)

    // A controller that never connects: the promise just stays parked — no
    // report is written, no skip, no abort.
    await Bun.sleep(60)
    expect(h.skipped).toEqual([])
    expect(h.completed).toEqual([])
    await expect(readFile(join(workspace.dir, "reports", "human-review.md"), "utf8")).rejects.toThrow()

    // A late controller still unblocks the very same hold.
    h.resolveAsk("continue")
    await gate
    expect(h.completed).toEqual(["human-review"])
  })

  test("--no-human-step skips the gate without ever prompting, even with askHumanReview available", async () => {
    const { workspace, options } = await fixture()
    const h = holdingProgress()

    await withoutTty(async () => {
      await runHumanReviewGate(workspace, { ...options, humanReview: false }, { url: "http://127.0.0.1:1234" }, h.progress)
    })

    expect(h.prompts).toEqual([])
    expect(h.started).toEqual([])
    expect(h.skipped).toEqual(["human-review"])
  })
})
