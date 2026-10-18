import { describe, expect, test } from "bun:test"

import { releaseSessionHandles, type HandleSource } from "../src/runners/session-handles"

function source(handles: Record<string, { end(): void } | undefined>): { source: HandleSource; ended: string[] } {
  const ended: string[] = []
  const wrapped: HandleSource = {
    handleFor(sessionID) {
      const handle = handles[sessionID]
      if (!handle) return undefined
      return {
        end() {
          ended.push(sessionID)
          handle.end()
        },
      }
    },
  }
  return { source: wrapped, ended }
}

describe("session-bound handle release", () => {
  test("ends the handles of the exact session across every source", () => {
    const reports = source({ ses_1: { end() {} } })
    const advisors = source({ ses_1: { end() {} } })
    releaseSessionHandles("ses_1", reports.source, advisors.source)
    expect(reports.ended).toEqual(["ses_1"])
    expect(advisors.ended).toEqual(["ses_1"])
  })

  test("a missing session or a missing source is a no-op", () => {
    const reports = source({ ses_1: { end() {} } })
    expect(() => releaseSessionHandles(undefined, reports.source, undefined)).not.toThrow()
    releaseSessionHandles(undefined, reports.source)
    expect(reports.ended).toEqual([])

    // A session with no handle in the source is untouched.
    releaseSessionHandles("ses_absent", reports.source)
    expect(reports.ended).toEqual([])
  })
})
