import { describe, expect, test } from "bun:test"

import { runInteractivePublish } from "../src/publish-action"
import { createPublishSeam, type PublishRunner, type RunResult, type PublishSeam } from "../src/publish"
import type { TuiRoute } from "../src/tui-session"

/**
 * The Home `Create pull request` action as one reviewed transaction. These tests
 * pin the fix: the composed text is reviewed before any effect, the branch is
 * pushed before the PR is created (the old menu path created PRs from a stale
 * remote head), and the outcome is reported in a dialog, never raw stdout.
 */

const ok = (stdout = ""): RunResult => ({ stdout, stderr: "", exitCode: 0 })
const fail = (stderr: string): RunResult => ({ stdout: "", stderr, exitCode: 1 })

/** A happy-path fake: clean feature branch, gh installed and authenticated. */
function fakeRunner(overrides: Record<string, RunResult> = {}, calls: Array<{ command: string; args: string[] }> = []): PublishRunner {
  const defaults: Record<string, RunResult> = {
    "git symbolic-ref --quiet --short HEAD": ok("feat/widget\n"),
    "git status --porcelain": ok(""),
    "git rev-parse --path-format=absolute --git-common-dir": ok("/repo/.git\n"),
    "git rev-parse --show-toplevel": ok("/repo\n"),
    "git remote": ok("origin\n"),
    "git rev-parse --quiet --abbrev-ref --symbolic-full-name feat/widget@{upstream}": fail("no upstream"),
    "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": ok("origin/main\n"),
    "gh --version": ok("gh version 2.0.0\n"),
    "gh auth status": ok(""),
    "git push origin feat/widget:feat/widget": ok(""),
    "gh pr list": ok("[]"),
    "gh pr create": ok("https://github.com/acme/repo/pull/12\n"),
    ...overrides,
  }
  return async (command, args) => {
    calls.push({ command, args })
    const key = `${command} ${args.join(" ")}`
    if (defaults[key] !== undefined) return defaults[key]!
    if (command === "gh" && args[0] === "pr" && args[1] === "create") return defaults["gh pr create"]!
    if (command === "gh" && args[0] === "pr" && args[1] === "list") return defaults["gh pr list"]!
    return fail(`unexpected call: ${key}`)
  }
}

/** A route whose renderer only needs to survive suspend/resume. */
function fakeRoute(): TuiRoute {
  return { session: { renderer: { suspend() {}, resume() {} } } } as unknown as TuiRoute
}

function harness(overrides: Record<string, RunResult> = {}) {
  const calls: Array<{ command: string; args: string[] }> = []
  const notices: Array<{ title: string; message: string }> = []
  const seam: PublishSeam = createPublishSeam({ cwd: "/repo", run: fakeRunner(overrides, calls) })
  return { calls, notices, seam }
}

describe("interactive publish reviews, pushes, then creates", () => {
  test("reviews the composed text, pushes before creating, and reports the PR URL", async () => {
    const { calls, notices, seam } = harness()
    let reviewed: { plan: { branch: string; remote: string; base: string }; title: string; text: string } | undefined

    await runInteractivePublish(
      { worktree: "/repo", route: fakeRoute() },
      {
        seam,
        review: (_route, options) => {
          reviewed = options
          return Promise.resolve({ kind: "publish", title: options.title, text: options.text })
        },
        notice: (_route, options) => {
          notices.push(options)
          return Promise.resolve()
        },
      },
    )

    // The operator saw the destination and the composed title before effects.
    expect(reviewed?.plan).toEqual({ branch: "feat/widget", remote: "origin", base: "main" })
    expect(reviewed?.title).toBe("feat: widget")

    // The push happened, and it happened before the PR was created.
    const pushIndex = calls.findIndex((call) => call.command === "git" && call.args[0] === "push")
    const createIndex = calls.findIndex((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "create")
    expect(pushIndex).toBeGreaterThanOrEqual(0)
    expect(createIndex).toBeGreaterThan(pushIndex)
    expect(calls[pushIndex]!.args).toEqual(["push", "origin", "feat/widget:feat/widget"])

    // The success dialog names the branch and the PR URL.
    expect(notices).toHaveLength(1)
    expect(notices[0]!.title).toBe("pull request")
    expect(notices[0]!.message).toContain("pushed feat/widget to origin/feat/widget")
    expect(notices[0]!.message).toContain("https://github.com/acme/repo/pull/12")
  })

  test("a cancelled review performs no effect at all", async () => {
    const { calls, notices, seam } = harness()
    await runInteractivePublish(
      { worktree: "/repo", route: fakeRoute() },
      {
        seam,
        review: () => Promise.resolve({ kind: "cancel" }),
        notice: (_route, options) => {
          notices.push(options)
          return Promise.resolve()
        },
      },
    )
    expect(calls.some((call) => call.command === "git" && call.args[0] === "push")).toBe(false)
    expect(calls.some((call) => call.command === "gh" && call.args[1] === "create")).toBe(false)
    expect(notices).toHaveLength(0)
  })

  test("an edit to the reviewed title flows into the created PR", async () => {
    const { calls, seam } = harness()
    await runInteractivePublish(
      { worktree: "/repo", route: fakeRoute() },
      {
        seam,
        review: (_route, options) => Promise.resolve({ kind: "publish", title: `${options.title} (edited)`, text: options.text }),
        notice: () => Promise.resolve(),
      },
    )
    const create = calls.find((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "create")
    expect(create?.args[create.args.indexOf("--title") + 1]).toBe("feat: widget (edited)")
  })

  test("a blocked preparation shows a notice and never publishes", async () => {
    const { calls, notices, seam } = harness({ "git status --porcelain": ok(" M src/x.ts\n") })
    await runInteractivePublish(
      { worktree: "/repo", route: fakeRoute() },
      {
        seam,
        review: () => {
          throw new Error("review must not be reached")
        },
        notice: (_route, options) => {
          notices.push(options)
          return Promise.resolve()
        },
      },
    )
    expect(notices).toHaveLength(1)
    expect(notices[0]!.message).toContain("uncommitted changes")
    expect(calls.some((call) => call.command === "git" && call.args[0] === "push")).toBe(false)
  })

  test("a PR failure after a landed push surfaces the failure and the push stays done", async () => {
    const { calls, notices, seam } = harness({ "gh pr create": fail("no permission") })
    await runInteractivePublish(
      { worktree: "/repo", route: fakeRoute() },
      {
        seam,
        review: (_route, options) => Promise.resolve({ kind: "publish", title: options.title, text: options.text }),
        notice: (_route, options) => {
          notices.push(options)
          return Promise.resolve()
        },
      },
    )
    expect(calls.some((call) => call.command === "git" && call.args[0] === "push")).toBe(true)
    expect(notices).toHaveLength(1)
    expect(notices[0]!.title).toBe("create pull request")
    expect(notices[0]!.message).toContain("the branch was pushed to origin/feat/widget")
  })
})
