import { describe, expect, test } from "bun:test"

import { assertSessionOperationSupported, supportsSessionOperation, UnsupportedSessionOperationError } from "../src/runners/capabilities"
import { resolveRunnerCapabilities } from "../src/runners/capabilities"
import { createOpencodeSessionControls } from "../src/runners/opencode/session-controls"
import type { RunnerEvent } from "../src/runners/contracts"

const identity = { runId: "run-1", phaseName: "implement", attempt: 2 }
const opencodeSession = { runner: "opencode" as const, sessionId: "ses_1" }

describe("OpenCode session facets", () => {
  test("history reconstructs the exact recorded session, tagging events with the attempt", async () => {
    const seen: { sessionId: string; attempt: number }[] = []
    const events: RunnerEvent[] = [{ type: "text", runner: "opencode", attempt: 2, text: "hi" }]
    const controls = createOpencodeSessionControls({
      runner: {
        backfillEvents: async (sessionId, attempt) => {
          seen.push({ sessionId, attempt })
          return events
        },
      },
    })
    const result = await controls.history({ session: opencodeSession, identity })
    expect(result).toEqual({ ok: true, events })
    expect(seen).toEqual([{ sessionId: "ses_1", attempt: 2 }])
  })

  test("a session that belongs to another runner is refused", async () => {
    const controls = createOpencodeSessionControls({ runner: { backfillEvents: async () => [] } })
    const result = await controls.history({ session: { runner: "claude-code", sessionId: "ses_1" }, identity })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("not an opencode session")
  })

  test("an unavailable session is an honest failure, never fabricated history", async () => {
    const controls = createOpencodeSessionControls({
      runner: {
        backfillEvents: async () => {
          throw new Error("server unreachable")
        },
      },
    })
    const result = await controls.history({ session: opencodeSession, identity })
    expect(result).toEqual({ ok: false, error: "server unreachable" })
  })

  test("attach is present only when an opener is supplied", async () => {
    const withoutOpener = createOpencodeSessionControls({ runner: { backfillEvents: async () => [] } })
    expect(withoutOpener.attach).toBeUndefined()

    const withOpener = createOpencodeSessionControls({
      runner: { backfillEvents: async () => [] },
      openWindow: async (sessionId) => ({ backend: `tui:${sessionId}` }),
    })
    expect(await withOpener.attach!({ session: opencodeSession, identity })).toEqual({ ok: true, detail: "tui:ses_1" })
    const foreign = await withOpener.attach!({ session: { runner: "claude-code", sessionId: "ses_1" }, identity })
    expect(foreign.ok).toBe(false)
  })

  test("resume is present only when a continuation is supplied", async () => {
    const withoutResume = createOpencodeSessionControls({ runner: { backfillEvents: async () => [] } })
    expect(withoutResume.resume).toBeUndefined()

    const withResume = createOpencodeSessionControls({
      runner: { backfillEvents: async () => [] },
      continueSession: async (request) => ({ ok: true, outcome: { status: "completed", session: request.session } }),
    })
    const result = await withResume.resume!({ session: opencodeSession, prompt: "continue", identity, signal: new AbortController().signal })
    expect(result.ok).toBe(true)
  })

  test("the operations are capability-gated and attach is refused where there is no native attach", () => {
    const opencode = resolveRunnerCapabilities("opencode", { version: "2.0.28" })
    expect(supportsSessionOperation(opencode, "history")).toBe(true)
    expect(supportsSessionOperation(opencode, "resume")).toBe(true)
    expect(supportsSessionOperation(opencode, "attach")).toBe(true)

    const claude = resolveRunnerCapabilities("claude-code", { enforcementReady: true })
    expect(supportsSessionOperation(claude, "attach")).toBe(false)
    expect(() => assertSessionOperationSupported(claude, "attach")).toThrow(UnsupportedSessionOperationError)
  })
})
