import { describe, expect, test } from "bun:test"

import { revalidateInteractive } from "../src/runners/revalidation"

const base = {
  previous: { checkout: "/repo", session: { runner: "claude-code" as const, sessionId: "ses_1" }, authMode: "subscription" as const, versionMajor: 2 },
  current: { checkoutMatches: true, sessionExists: true, authMode: "subscription" as const, versionMajor: 2 },
}

describe("interactive revalidation", () => {
  test("accepts an unchanged, verified target", () => {
    expect(revalidateInteractive(base)).toEqual({ ok: true })
  })

  test("refuses a moved or reused checkout", () => {
    expect(revalidateInteractive({ ...base, current: { ...base.current, checkoutMatches: false } })).toMatchObject({ ok: false })
  })

  test("refuses a missing or unknown session", () => {
    expect(revalidateInteractive({ ...base, current: { ...base.current, sessionExists: false } })).toMatchObject({ ok: false })
    expect(revalidateInteractive({ ...base, current: { ...base.current, sessionExists: undefined } })).toMatchObject({ ok: false })
  })

  test("refuses a changed billing/auth mode or an unsupported version", () => {
    expect(revalidateInteractive({ ...base, current: { ...base.current, authMode: "api-key" } })).toMatchObject({ ok: false })
    expect(revalidateInteractive({ ...base, current: { ...base.current, versionMajor: 1 } })).toMatchObject({ ok: false })
  })
})
