import { afterEach, describe, expect, test, spyOn } from "bun:test"

import { runForegroundChild } from "../src/terminal-host"

/**
 * Task 4.6 (capability work-conversations, design D4): foreground terminal
 * recovery. `runForegroundChild` suspends the owning TUI, runs the interactive
 * harness child with the terminal's own streams, and hands control back in
 * `finally` — so normal exit, non-zero exit, failure to spawn, and
 * interruption all restore input, rendering, and current dimensions. The
 * terminal-host module itself never spawns a real child in its own tests: the
 * observable contract is the suspend/resume lifecycle around a mocked
 * `Bun.spawn`, and the developer-facing production path that actually launches
 * OpenCode lives behind `openConversationForeground` (tested in
 * conversations.test.ts).
 */

const originalSpawn = Bun.spawn

const OPENCODE_ARGV = ["opencode", "/repo", "--session", "ses_1"]

function mockSpawn(implementation: (...args: any[]) => unknown) {
  const spawn = spyOn(Bun, "spawn")
  spawn.mockImplementation(implementation as unknown as typeof Bun.spawn)
  return spawn
}

afterEach(() => {
  Bun.spawn = originalSpawn
})

describe("runForegroundChild (task 4.6 foreground terminal recovery)", () => {
  test("suspends the TUI, starts the child with structured argv and inherit streams, and resumes after a normal exit", async () => {
    const events: string[] = []
    const spawn = mockSpawn((argv: string[]) => {
      events.push("spawn")
      expect(argv).toEqual(OPENCODE_ARGV)
      return { exited: Promise.resolve(0) }
    })

    const code = await runForegroundChild({
      argv: OPENCODE_ARGV,
      cwd: "/repo",
      suspend: () => void events.push("suspend"),
      resume: () => void events.push("resume"),
    })

    expect(code).toBe(0)
    expect(events).toEqual(["suspend", "spawn", "resume"])
    const [, options] = spawn.mock.calls[0]! as [string[], Record<string, unknown>]
    expect(options).toMatchObject({ cwd: "/repo", stdin: "inherit", stdout: "inherit", stderr: "inherit" })
    // No env override supplied: the child inherits the parent's environment.
    expect(options.env).toBe(process.env)
  })

  test("returns a non-zero exit code and still restores the terminal (failure reported, caller not broken)", async () => {
    const events: string[] = []
    mockSpawn(() => ({ exited: Promise.resolve(7) }))

    const code = await runForegroundChild({
      argv: OPENCODE_ARGV,
      cwd: "/repo",
      suspend: () => void events.push("suspend"),
      resume: () => void events.push("resume"),
    })

    expect(code).toBe(7)
    // The caller gets the exit code to decide meaning; the terminal is restored.
    expect(events).toEqual(["suspend", "resume"])
  })

  test("restores the terminal when the child cannot be spawned (Bun.spawn throws)", async () => {
    const events: string[] = []
    mockSpawn(() => {
      throw new Error("failed to launch the harness client")
    })

    await expect(
      runForegroundChild({
        argv: OPENCODE_ARGV,
        cwd: "/repo",
        suspend: () => void events.push("suspend"),
        resume: () => void events.push("resume"),
      }),
    ).rejects.toThrow("failed to launch the harness client")

    // startup failure still returns input and rendering to the caller.
    expect(events).toEqual(["suspend", "resume"])
  })

  test("restores the terminal when the child is interrupted (its exit promise rejects)", async () => {
    const events: string[] = []
    mockSpawn(() => ({ exited: Promise.reject(new Error("interrupted")) }))

    await expect(
      runForegroundChild({
        argv: OPENCODE_ARGV,
        cwd: "/repo",
        suspend: () => void events.push("suspend"),
        resume: () => void events.push("resume"),
      }),
    ).rejects.toThrow("interrupted")

    expect(events).toEqual(["suspend", "resume"])
  })

  test("resume is the redraw hook: it fires on every exit path so the renderer can re-render at the current size", async () => {
    // The resize guarantee lives in the TUI renderer: `resume()` re-renders at
    // the current dimensions. The host's job is to guarantee resume lands after
    // the child gives the terminal back, including a non-zero (-reshaped) exit.
    const events: string[] = []
    mockSpawn(() => ({ exited: Promise.resolve(-2) }))

    const code = await runForegroundChild({
      argv: OPENCODE_ARGV,
      cwd: "/repo",
      suspend: () => void events.push("suspend"),
      resume: () => void events.push("resume"),
    })

    expect(code).toBe(-2)
    expect(events).toEqual(["suspend", "resume"])
  })

  test("passes the caller's env override to the child", async () => {
    const spawn = mockSpawn(() => ({ exited: Promise.resolve(0) }))

    await runForegroundChild({
      argv: OPENCODE_ARGV,
      cwd: "/repo",
      suspend: () => {},
      resume: () => {},
      env: { FOO: "bar" },
    })

    const [, options] = spawn.mock.calls[0]! as [string[], Record<string, unknown>]
    expect(options).toMatchObject({ env: { FOO: "bar" } })
  })
})
