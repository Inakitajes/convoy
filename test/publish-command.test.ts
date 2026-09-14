import { describe, expect, test } from "bun:test"

import type { PublishPlan } from "../src/publish"
import { runPublishCommand, type PublishCommandOptions, type PublishCommandSeam } from "../src/publish-command"

const plan: PublishPlan = { branch: "feat/add-login", remote: "origin", base: "main" }

type Recorded = { applied?: { title: string; text: string } }

/** A stub seam capturing calls and sinks; no real git/gh is involved. */
function harness(overrides: Partial<PublishCommandSeam> = {}) {
  const recorded: Recorded = {}
  let applyCalls = 0
  const seam: PublishCommandSeam = {
    prepare: async () => ({ ok: true, plan }),
    compose: async () => ({ ok: true, title: "feat: Add login", text: "## Why\nBecause the flow was missing." }),
    apply: async (_plan, accepted) => {
      applyCalls++
      recorded.applied = accepted
      return { ok: true, outcome: { pushed: true, url: "https://example.test/pull/7" } }
    },
    ...overrides,
  }
  const out: string[] = []
  const err: string[] = []
  return {
    recorded,
    applyCalls: () => applyCalls,
    run: (options: PublishCommandOptions) =>
      runPublishCommand(options, { seam, stdout: (text) => void out.push(text), stderr: (text) => void err.push(text) }),
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  }
}

describe("runPublishCommand review modes", () => {
  test("--dry-run prints the disclosed plan and composed text and never applies", async () => {
    const h = harness()
    const code = await h.run({ worktree: "/repo", yes: false, dryRun: true })

    expect(code).toBe(0)
    expect(h.applyCalls()).toBe(0)
    expect(h.stdout()).toContain("branch: feat/add-login")
    expect(h.stdout()).toContain("remote: origin")
    expect(h.stdout()).toContain("base:   main")
    expect(h.stdout()).toContain("title: feat: Add login")
    expect(h.stdout()).toContain("## Why")
    expect(h.stdout()).toContain("dry run: no push or pull request was made")
  })

  test("without --yes the command reviews and performs no effect", async () => {
    const h = harness()
    const code = await h.run({ yes: false, dryRun: false })

    expect(code).toBe(0)
    expect(h.applyCalls()).toBe(0)
    expect(h.stdout()).toContain("pass --yes to publish")
  })

  test("--yes applies the composed text and reports the pull-request URL", async () => {
    const h = harness()
    const code = await h.run({ yes: true, dryRun: false })

    expect(code).toBe(0)
    expect(h.applyCalls()).toBe(1)
    expect(h.recorded.applied).toEqual({ title: "feat: Add login", text: "## Why\nBecause the flow was missing." })
    expect(h.stdout()).toContain("pull request: https://example.test/pull/7")
  })

  test("--title/--body overrides become the accepted text", async () => {
    const h = harness()
    const code = await h.run({ yes: true, dryRun: false, title: "feat: Custom title", body: "## Why\nCustom body." })

    expect(code).toBe(0)
    expect(h.recorded.applied).toEqual({ title: "feat: Custom title", text: "## Why\nCustom body." })
  })

  test("a successful apply without a reported URL names the pushed refspec", async () => {
    const h = harness({ apply: async () => ({ ok: true, outcome: { pushed: true } }) })
    const code = await h.run({ yes: true, dryRun: false })

    expect(code).toBe(0)
    expect(h.stdout()).toContain("pushed origin/feat/add-login")
  })
})

describe("runPublishCommand blocked stages", () => {
  test("a blocked prepare surfaces the message verbatim and never applies", async () => {
    const h = harness({ prepare: async () => ({ ok: false, message: "HEAD is detached" }) })
    const code = await h.run({ yes: true, dryRun: false })

    expect(code).toBe(1)
    expect(h.stderr()).toContain("blocked: HEAD is detached")
    expect(h.applyCalls()).toBe(0)
  })

  test("a blocked compose surfaces the message verbatim and never applies", async () => {
    const h = harness({ compose: async () => ({ ok: false, message: "a selected proposal is unreadable" }) })
    const code = await h.run({ yes: true, dryRun: false })

    expect(code).toBe(1)
    expect(h.stderr()).toContain("blocked: a selected proposal is unreadable")
    expect(h.applyCalls()).toBe(0)
  })

  test("a blocked apply surfaces the message verbatim", async () => {
    const h = harness({ apply: async () => ({ ok: false, message: "push was rejected; nothing was published" }) })
    const code = await h.run({ yes: true, dryRun: false })

    expect(code).toBe(1)
    expect(h.stderr()).toContain("blocked: push was rejected; nothing was published")
  })
})
