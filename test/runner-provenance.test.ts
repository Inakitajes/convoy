import { describe, expect, test } from "bun:test"

import {
  isRunnerExecutionRecord,
  readPhaseExecution,
  runnerExecutionRecord,
  runnerQualifiedSession,
} from "../src/runners/provenance"

describe("runner provenance", () => {
  test("builds and reads a v1 record without secrets", () => {
    const record = runnerExecutionRecord({
      runner: "claude-code",
      auth: { mode: "subscription", credentialRef: "CLAUDE_CONFIG_DIR" },
      model: { modelId: "sonnet", variant: "high" },
      sessionId: "ses_abc",
      attempt: { runId: "run-1", phase: "implement", attempt: 2 },
      protocolVersion: "2.1.296",
    })

    expect(record.version).toBe(1)
    expect(JSON.stringify(record)).not.toMatch(/sk-|token|password|secret/i)
    expect(isRunnerExecutionRecord(record)).toBe(true)

    const read = readPhaseExecution({ sessionID: "legacy", execution: record })
    expect(read.kind).toBe("record")
    expect(runnerQualifiedSession(read)).toEqual({ runner: "claude-code", sessionId: "ses_abc" })
  })

  test("reads a legacy bare session id without guessing a runner", () => {
    const read = readPhaseExecution({ sessionID: "ses_legacy" })
    expect(read).toEqual({ kind: "legacy", sessionId: "ses_legacy" })
    expect(runnerQualifiedSession(read)).toBeUndefined()
  })

  test("preserves the historical coordinator PID and explicit child", () => {
    const read = readPhaseExecution({ server: { url: "http://127.0.0.1:1234", pid: 111, childPid: 222 } })
    expect(read).toEqual({ kind: "legacy", server: { url: "http://127.0.0.1:1234", pid: 111, childPid: 222 } })
  })

  test("omits an absent child PID rather than inventing one", () => {
    const read = readPhaseExecution({ server: { url: "http://127.0.0.1:1234", pid: 111 } })
    expect(read).toEqual({ kind: "legacy", server: { url: "http://127.0.0.1:1234", pid: 111 } })
    if (read.kind === "legacy") expect(read.server && "childPid" in read.server).toBe(false)
  })

  test("returns none for empty or malformed entries", () => {
    expect(readPhaseExecution({})).toEqual({ kind: "none" })
    expect(readPhaseExecution(null)).toEqual({ kind: "none" })
    expect(readPhaseExecution({ version: 99, runner: "opencode", auth: { mode: "subscription" } })).toEqual({ kind: "none" })
    expect(readPhaseExecution({ version: 1, runner: "nope", auth: { mode: "subscription" } })).toEqual({ kind: "none" })
    expect(readPhaseExecution({ version: 1, runner: "opencode", auth: { mode: "bogus" } })).toEqual({ kind: "none" })
  })

  test("a record without a session has no qualified session", () => {
    const read = readPhaseExecution(runnerExecutionRecord({ runner: "opencode", auth: { mode: "subscription" } }))
    expect(runnerQualifiedSession(read)).toBeUndefined()
  })
})
