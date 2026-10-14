import { describe, expect, test } from "bun:test"

import { PermissionLedger, type PermissionScope } from "../src/runners/permission-scope"

function scope(overrides: Partial<PermissionScope> = {}): PermissionScope {
  return {
    runId: "run-1",
    phaseName: "implement",
    attempt: 1,
    sessionId: "sess-1",
    requestId: "req-1",
    generation: 1,
    ...overrides,
  }
}

describe("permission ledger", () => {
  test("registers and lists pending requests", () => {
    const ledger = new PermissionLedger()
    const a = scope({ requestId: "a" })
    const b = scope({ requestId: "b" })
    ledger.request(a)
    ledger.request(b)
    expect(ledger.pending()).toEqual([a, b])
    expect(ledger.isPending(a)).toBe(true)
  })

  test("rejects a duplicate request id while it is pending", () => {
    const ledger = new PermissionLedger()
    ledger.request(scope())
    expect(() => ledger.request(scope({ generation: 2 }))).toThrow()
  })

  test("sibling scopes settle independently", () => {
    const ledger = new PermissionLedger()
    const claude = scope({ requestId: "claude", sessionId: "c" })
    const opencode = scope({ requestId: "opencode", sessionId: "o", attempt: 2 })
    ledger.request(claude)
    ledger.request(opencode)

    expect(ledger.settle(claude, "allow")).toBe(true)
    expect(ledger.isPending(claude)).toBe(false)
    // The sibling is untouched and stays independently responsive.
    expect(ledger.isPending(opencode)).toBe(true)
    expect(ledger.settle(opencode, "deny")).toBe(true)
  })

  test("a foreign reply cannot settle another attempt", () => {
    const ledger = new PermissionLedger()
    const original = scope({ attempt: 1 })
    ledger.request(original)
    expect(ledger.settle(scope({ attempt: 2 }), "allow")).toBe(false)
    expect(ledger.isPending(original)).toBe(true)
  })

  test("a stale generation cannot settle a newer generation", () => {
    const ledger = new PermissionLedger()
    const current = scope({ generation: 2 })
    ledger.request(current)
    expect(ledger.settle(scope({ generation: 1 }), "allow")).toBe(false)
    expect(ledger.isPending(current)).toBe(true)
  })

  test("a duplicate reply resolves to false", () => {
    const ledger = new PermissionLedger()
    const pending = scope()
    ledger.request(pending)
    expect(ledger.settle(pending, "allow")).toBe(true)
    expect(ledger.settle(pending, "allow")).toBe(false)
  })

  test("an unknown request resolves to false", () => {
    const ledger = new PermissionLedger()
    expect(ledger.settle(scope({ requestId: "never" }), "allow")).toBe(false)
  })

  test("a cancelled request cannot be authorized by a late reply", () => {
    const ledger = new PermissionLedger()
    const pending = scope()
    ledger.request(pending)
    ledger.cancel(pending)
    expect(ledger.isPending(pending)).toBe(false)
    expect(ledger.settle(pending, "allow")).toBe(false)
  })

  test("a timed-out request settles as expired and rejects a later allow", () => {
    const ledger = new PermissionLedger()
    const pending = scope()
    ledger.request(pending)
    const expired = ledger.expire(pending)
    expect(expired?.decision).toBe("expired")
    expect(ledger.isPending(pending)).toBe(false)
    // A deadline that fired must never silently permit: the later reply is stale.
    expect(ledger.settle(pending, "allow")).toBe(false)
  })

  test("only the settled scope is recorded", () => {
    const ledger = new PermissionLedger()
    const pending = scope({ runId: "run-1" })
    ledger.request(pending)
    expect(ledger.settle(scope({ runId: "run-2" }), "deny")).toBe(false)
    expect(ledger.settle(pending, "deny")).toBe(true)
    expect(ledger.decisions().map((entry) => entry.decision)).toEqual(["deny"])
    expect(ledger.decisions()[0]?.scope.runId).toBe("run-1")
  })
})
