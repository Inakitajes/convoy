import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"

import type { OpencodeClient } from "@opencode-ai/sdk/v2"

/**
 * Task 4.6 (capability work-conversations, design D4/D5): explicit external
 * presentation, detached active-agent reporting, and foreground wiring.
 * `openConversationExternal` must never report a session as running on the
 * bare fact that a pane/window was created, and `sessionActivity` is how a
 * detached view still observes whether its agent is executing. The harness
 * (`connectOpencode`) and the window/pane launcher are injected/mocked; the
 * production OpenCode spawn path is exercised against a mocked `Bun.spawn`.
 *
 * bun runs this file's top-level code before any test, so mock.module is
 * visible process-wide — the connectOpcencode stub delegates everything else
 * to the real opencode module.
 */

const actualOpencode = await import("../src/opencode")
const originalSpawn = Bun.spawn

let statusAnswer: unknown
let getAnswer: unknown
let statusThrows = false
let getThrows = false

const fakeClient = {
  session: {
    status: async () => {
      if (statusThrows) throw new Error("connection reset")
      return statusAnswer
    },
    get: async () => {
      if (getThrows) throw new Error("harness unavailable")
      return getAnswer
    },
    create: async () => ({ data: { id: "ses_minted" } }),
    command: async () => ({}),
  },
} as unknown as OpencodeClient

mock.module("../src/opencode", () => ({
  ...actualOpencode,
  connectOpencode: () => fakeClient,
}))

const { authoringClientArgv, openConversationExternal, openConversationForeground, sessionActivity } = await import(
  "../src/conversations"
)

const OPEN_SERVER = { url: "http://127.0.0.1:51021" }
const SESSION = { harness: "opencode" as const, sessionId: "ses_1" }

function resetHarness(): void {
  statusAnswer = undefined
  getAnswer = undefined
  statusThrows = false
  getThrows = false
}

afterEach(() => {
  Bun.spawn = originalSpawn
  resetHarness()
})

describe("sessionActivity (task 4.6 detached active agents)", () => {
  test("reports busy when the harness marks the exact session actively executing (busy or retry)", async () => {
    for (const type of ["busy", "retry"]) {
      resetHarness()
      statusAnswer = { data: { [SESSION.sessionId]: { type } } }
      const activity = await sessionActivity({ checkout: "/repo", ref: SESSION, server: OPEN_SERVER })
      expect(activity).toBe("busy")
    }
  })

  test("reports idle for a quiescent session, a missing entry, or an unknown harness type", async () => {
    statusAnswer = { data: { [SESSION.sessionId]: { type: "idle" } } }
    expect(await sessionActivity({ checkout: "/repo", ref: SESSION, server: OPEN_SERVER })).toBe("idle")

    resetHarness()
    statusAnswer = { data: {} }
    expect(await sessionActivity({ checkout: "/repo", ref: SESSION, server: OPEN_SERVER })).toBe("idle")

    resetHarness()
    statusAnswer = { data: { [SESSION.sessionId]: { type: "other" } } }
    expect(await sessionActivity({ checkout: "/repo", ref: SESSION, server: OPEN_SERVER })).toBe("idle")
  })

  test("reports unknown when the harness cannot answer, without assuming the agent stopped", async () => {
    statusAnswer = { error: { message: "boom" } }
    expect(await sessionActivity({ checkout: "/repo", ref: SESSION, server: OPEN_SERVER })).toBe("unknown")

    // An unsupported harness is unknown — a caller must reconcile, not take over.
    expect(
      await sessionActivity({
        checkout: "/repo",
        ref: { harness: "other", sessionId: "x" } as never,
        server: OPEN_SERVER,
      }),
    ).toBe("unknown")
  })

  test("reports unknown and never throws when the harness call rejects", async () => {
    statusThrows = true
    expect(await sessionActivity({ checkout: "/repo", ref: SESSION, server: OPEN_SERVER })).toBe("unknown")
  })

  test("does not close an injected server handle (the service outlives the call)", async () => {
    resetHarness()
    statusAnswer = { data: { [SESSION.sessionId]: { type: "idle" } } }
    let closed = false
    const server = { url: "http://127.0.0.1:9", close: () => void (closed = true) }
    expect(await sessionActivity({ checkout: "/repo", ref: SESSION, server })).toBe("idle")
    expect(closed).toBe(false)
  })
})

describe("openConversationExternal (task 4.6 explicit external presentation)", () => {
  test("reports opened + sessionVerified when a pane is created and the exact session resolves", async () => {
    resetHarness()
    getAnswer = { data: { title: "widget" } }
    const result = await openConversationExternal({
      checkout: "/repo",
      ref: SESSION,
      openWindow: async () => "herdr",
      server: OPEN_SERVER,
    })
    expect(result).toEqual({ status: "opened", backend: "herdr", sessionVerified: true })
  })

  test("a pane created but the harness cannot resolve the session is opened-unverified, never reported as running", async () => {
    resetHarness()
    getAnswer = { error: { message: "no such session" } }
    const result = await openConversationExternal({
      checkout: "/repo",
      ref: SESSION,
      openWindow: async () => "zellij",
      server: OPEN_SERVER,
    })
    expect(result.status).toBe("opened-unverified")
    if (result.status === "opened-unverified") {
      expect(result.backend).toBe("zellij")
      expect(result.reason).toContain("no such session")
    }
  })

  test("a pane created but the availability check itself fails is opened-unverified, not a crash", async () => {
    resetHarness()
    getThrows = true
    const result = await openConversationExternal({
      checkout: "/repo",
      ref: SESSION,
      openWindow: async () => "terminal",
      server: OPEN_SERVER,
    })
    expect(result.status).toBe("opened-unverified")
    if (result.status === "opened-unverified") {
      expect(result.backend).toBe("terminal")
      expect(result.reason).toContain("harness unavailable")
    }
  })

  test("a window/pane launcher failure is reported as failed, with the cause", async () => {
    resetHarness()
    const result = await openConversationExternal({
      checkout: "/repo",
      ref: SESSION,
      openWindow: async () => {
        throw new Error("unsupported platform")
      },
      server: OPEN_SERVER,
    })
    expect(result).toEqual({ status: "failed", reason: "unsupported platform" })
  })
})

describe("authoringClientArgv / openConversationForeground (task 4.6)", () => {
  test("builds structured argv for the exact session (no shell string re-parsed on the way in)", () => {
    expect(authoringClientArgv({ checkout: "/repo", ref: SESSION })).toEqual(["opencode", "/repo", "--session", "ses_1"])
  })

  test("routes through the foreground host with the exact ref, cwd, and env override", async () => {
    const spawn = spyOn(Bun, "spawn")
    spawn.mockImplementation((() => ({ exited: Promise.resolve(0) })) as unknown as typeof Bun.spawn)

    await openConversationForeground({
      checkout: "/repo",
      ref: SESSION,
      suspend: () => {},
      resume: () => {},
      env: { FOO: "bar" },
    })

    const [argv, options] = spawn.mock.calls[0]! as [string[], Record<string, unknown>]
    expect(argv).toEqual(["opencode", "/repo", "--session", "ses_1"])
    expect(options).toMatchObject({ cwd: "/repo", env: { FOO: "bar" } })
  })
})
