import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { humanActionMenu, phaseGatePrompt, runHumanReviewGate, askHumanAction } from "../src/human"
import { noopProgress, type HumanReviewAction, type HumanReviewPromptInfo, type ProgressUI } from "../src/progress"
import type { TerminalInput, TerminalPrompt } from "../src/terminal-input"

import type { RunOptions } from "../src/types"
import type { Workspace } from "../src/workspace"

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
  const root = await mkdtemp(join(tmpdir(), "convoy-human-review-"))
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
    } as Partial<RunOptions> as RunOptions,
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

    await runHumanReviewGate(workspace, options, { url: "http://127.0.0.1:1234" }, progress)

    expect(calls.suspend).toBe(0)
    expect(calls.resume).toBe(0)
    expect(calls.completed).toBe(1)
    expect(calls.prompts).toHaveLength(1)
    expect(calls.prompts[0]).toMatchObject({ stepName: "human-review", iterations: 0 })
    await expect(readFile(join(workspace.dir, "reports", "human-review.md"), "utf8")).resolves.toContain("- Result: approved")
  })

  // A Claude-only run never boots OpenCode, so its human gate iterates with
  // Claude under the run's reviewed authentication instead.
  test("without an OpenCode server the iteration opens Claude, and its changes commit with the run trailer", async () => {
    const { workspace, options } = await fixture()
    const changed = join(options.targetDir, "claude-fix.md")
    const opened: Array<{ targetDir: string; auth?: unknown }> = []
    const { calls, progress } = progressWithActions(["iterate", "continue"])
    await runHumanReviewGate(
      workspace,
      { ...options, runnerAuth: { "claude-code": { mode: "subscription" } } },
      undefined,
      progress,
      undefined,
      "human-review",
      {
        openInteractiveOpencodeWindow: async () => {
          throw new Error("OpenCode must not be opened for a Claude-only run")
        },
        openClaudeInteractiveWindow: async (input) => {
          opened.push(input)
          await writeFile(changed, "edited in Claude\n")
          return "terminal"
        },
      },
    )
    expect(opened).toMatchObject([{ targetDir: options.targetDir, auth: { mode: "subscription" } }])
    expect(calls.activities).toContain("Claude iteration opened in terminal; return here and press c to continue")
    const log = Bun.spawnSync(["git", "log", "-1", "--format=%B"], { cwd: options.targetDir }).stdout.toString()
    expect(log).toContain(`Convoy-Run: ${workspace.runID}`)
    await expect(readFile(join(workspace.dir, "reports", "human-review.md"), "utf8")).resolves.toContain("- Manual Claude iterations: 1")
  })

  test("an iteration's committed changes carry the run trailer and describe the staged paths", async () => {
    const { workspace, options } = await fixture()
    // A human iteration leaves an uncommitted change behind; the "continue"
    // commit must describe it and link the active run instead of using the
    // fixed `apply manual iteration` summary.
    const changed = join(options.targetDir, "manual-fix.md")
    await writeFile(changed, "manual iteration result\n")

    const { progress } = progressWithActions(["iterate", "continue"])
    await runHumanReviewGate(
      workspace,
      options,
      { url: "http://127.0.0.1:1234" },
      progress,
      undefined,
      "human-review",
      {
        openInteractiveOpencodeWindow: async () => "terminal",
        runInteractiveOpencode: async () => {
          await writeFile(changed, "manual iteration result, revised\n")
        },
      },
    )

    const proc = Bun.spawn(["git", "log", "-1", "--pretty=%B"], { cwd: options.targetDir, stdout: "pipe" })
    const message = await new Response(proc.stdout).text()
    expect(message).toContain("convoy(human-review): update manual-fix.md")
    expect(message).toContain("Convoy-Run: 20260708-120000-test")
    expect(message).not.toContain("apply manual iteration")
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
      { url: "http://127.0.0.1:1234" },
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

  // The run's V2 server is password-protected; the iteration window has to
  // carry the password or the OpenCode client is rejected at connect.
  test("opens the iteration window with the run server's password", async () => {
    const { workspace, options } = await fixture()
    const opened: unknown[] = []
    const { progress } = progressWithActions(["iterate", "continue"])

    await runHumanReviewGate(
      workspace,
      options,
      { url: "http://127.0.0.1:1234", password: "s3cret" },
      progress,
      undefined,
      "human-review",
      {
        openInteractiveOpencodeWindow: async (input) => {
          opened.push(input)
          return "terminal"
        },
        runInteractiveOpencode: async () => {},
      },
    )

    expect(opened).toEqual([{ url: "http://127.0.0.1:1234", password: "s3cret", targetDir: options.targetDir }])
  })

  test("falls back to suspended same-terminal iteration when the TUI window cannot open", async () => {
    const { workspace, options } = await fixture()
    const events: string[] = []
    let interactiveRuns = 0
    const { calls, progress } = progressWithActions(["iterate", "continue"])

    await runHumanReviewGate(
      workspace,
      options,
      { url: "http://127.0.0.1:1234" },
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

describe("humanActionMenu", () => {
  test("renders the bracketed-key menu in [k]ey style for each allowed action", () => {
    // Every label starts with its key so the bracket strips the first letter.
    expect(humanActionMenu(["continue", "iterate", "abort"])).toBe("[c]ontinue pipeline, [o]pen session, [a]bort")
    expect(humanActionMenu(["retry", "iterate", "abort"])).toBe("[r]etry clean, [o]pen session, [a]bort")
  })

  test("a failure gate without a baseline shows only open and abort", () => {
    expect(humanActionMenu(["iterate", "abort"])).toBe("[o]pen session, [a]bort")
  })
})

describe("phaseGatePrompt", () => {
  test("a failure gate puts the error on its own line above the menu", () => {
    const prompt = phaseGatePrompt({ stepName: "implementer", kind: "failure", error: "network down", allowed: ["retry", "iterate", "abort"] })
    expect(prompt).toBe('Step "implementer" failed: network down\n[r]etry clean, [o]pen session, [a]bort > ')
  })

  test("a failure gate collapses whitespace in a multi-line error", () => {
    const prompt = phaseGatePrompt({ stepName: "tests", kind: "failure", error: "provider\ntemporarily\nunavailable", allowed: ["iterate", "abort"] })
    expect(prompt).toBe('Step "tests" failed: provider temporarily unavailable\n[o]pen session, [a]bort > ')
  })

  test("a failure gate without an error still shows the menu on the second line", () => {
    const prompt = phaseGatePrompt({ stepName: "plan", kind: "failure", allowed: ["retry", "iterate", "abort"] })
    expect(prompt).toBe('Step "plan" failed\n[r]etry clean, [o]pen session, [a]bort > ')
  })

  test("an interactive gate uses the session wording on a single line", () => {
    const prompt = phaseGatePrompt({ stepName: "implementer", kind: "interactive", allowed: ["continue", "iterate", "abort"] })
    expect(prompt).toBe('Interactive session on step "implementer": [c]ontinue pipeline, [o]pen session, [a]bort > ')
  })

  test("a budget gate offers reset and abort without a transparent continue action", () => {
    const prompt = phaseGatePrompt({ stepName: "implementer", kind: "budget-gate", allowed: ["reset", "abort"] })
    expect(prompt).toBe('Step "implementer" reached its step budget. Resetting starts another budget while keeping accumulated cost.\n[r]eset and continue, [a]bort > ')
  })
})

/**
 * A terminal-input arbiter that records each block and replays canned answers,
 * so askHumanAction can be driven without a real TTY and we can assert it
 * routes through the shared arbiter rather than opening its own readline.
 */
function scriptedTerminalInput(answers: string[]) {
  let withInputCalls = 0
  const queue = [...answers]
  const input: TerminalInput = {
    async withInput(fn) {
      withInputCalls++
      // Each ask consumes the next canned answer, so a re-prompt loop gets a
      // fresh input rather than spinning on the first one forever.
      const prompt: TerminalPrompt = { ask: async () => queue.shift() ?? "" }
      return fn(prompt)
    },
  }
  return { input, get calls() { return withInputCalls } }
}

describe("askHumanAction", () => {
  test("routes through the shared terminal-input arbiter and maps the answer to an action", async () => {
    const fake = scriptedTerminalInput(["c"])
    const action = await askHumanAction({ prompt: "decide > ", allowed: ["continue", "iterate", "abort"], terminalInput: fake.input })
    expect(action).toBe("continue")
    expect(fake.calls).toBe(1)
  })

  test("re-prompts under the same lock when the input matches no action", async () => {
    const fake = scriptedTerminalInput(["x", "a"])
    const action = await askHumanAction({ prompt: "decide > ", allowed: ["continue", "iterate", "abort"], terminalInput: fake.input })
    expect(action).toBe("abort")
    // The whole loop stays inside one withInput block so a sibling permission
    // prompt can't steal stdin between an invalid answer and the re-prompt.
    expect(fake.calls).toBe(1)
  })
})
