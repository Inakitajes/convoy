import { describe, expect, test } from "bun:test"

import {
  controllerLeaseDeadlineMs,
  controllerLeaseDetectionMs,
  controllerLeaseHeartbeatMs,
  ControllerLease,
  createAttemptLifecycle,
  separateRelease,
} from "../src/runners/claude/lifecycle"

describe("attempt lifecycle cancellation", () => {
  test("a second cancel is idempotent and aborts once", () => {
    let cancels = 0
    const lifecycle = createAttemptLifecycle({ onCancel: () => (cancels += 1) })

    lifecycle.cancel()
    lifecycle.cancel()
    lifecycle.cancel()

    expect(cancels).toBe(1)
    expect(lifecycle.aborted).toBe(true)
    expect(lifecycle.abort.aborted).toBe(true)
  })

  test("a deadline escalates cleanup exactly once after the interrupt budget", async () => {
    let cancels = 0
    const lifecycle = createAttemptLifecycle({ onCancel: () => (cancels += 1), deadlineMs: 10 })

    lifecycle.cancel()
    expect(cancels).toBe(1)
    await Bun.sleep(60)
    expect(cancels).toBe(2)
  })

  test("without a deadline there is no escalation", async () => {
    let cancels = 0
    const lifecycle = createAttemptLifecycle({ onCancel: () => (cancels += 1) })

    lifecycle.cancel()
    await Bun.sleep(30)
    expect(cancels).toBe(1)
  })
})

describe("view detach versus explicit stop", () => {
  test("detaching a view does not cancel execution while a controller is held", () => {
    const decision = separateRelease({ viewDetached: true, controllerHeld: true })
    expect(decision.cancelExecution).toBe(false)
    expect(decision.releaseResources).toBe(false)
  })

  test("detaching with no controller releases the finished hold but never cancels execution", () => {
    const decision = separateRelease({ viewDetached: true, controllerHeld: false })
    expect(decision.cancelExecution).toBe(false)
    expect(decision.releaseResources).toBe(true)
    // Independent authoring survives: no execution cancellation is implied.
    expect(decision.reason).toContain("independent authoring")
  })

  test("only an explicit stop cancels execution", () => {
    const decision = separateRelease({ explicitStop: true, viewDetached: true })
    expect(decision).toEqual({
      cancelExecution: true,
      releaseResources: true,
      reason: expect.stringContaining("explicit stop"),
    })
  })

  test("no signals means nothing is released or cancelled", () => {
    expect(separateRelease({})).toEqual({ cancelExecution: false, releaseResources: false, reason: expect.any(String) })
  })
})

describe("controller lease", () => {
  test("uses the existing 15s heartbeat and 1s detection allowance", () => {
    expect(controllerLeaseHeartbeatMs).toBe(15_000)
    expect(controllerLeaseDetectionMs).toBe(1_000)
    expect(controllerLeaseDeadlineMs).toBe(16_000)
  })

  test("expires exactly at the heartbeat window", () => {
    let now = 0
    const lease = new ControllerLease(() => now)
    lease.acquire("controller-a")

    expect(lease.isExpired(controllerLeaseHeartbeatMs - 1)).toBe(false)
    expect(lease.isExpired(controllerLeaseHeartbeatMs)).toBe(true)
  })

  test("heartbeats extend the lease and a stale heartbeat is refused", () => {
    let now = 0
    const lease = new ControllerLease(() => now)
    lease.acquire("a")

    now = 10_000
    expect(lease.heartbeat("a")).toBe(true)
    expect(lease.isExpired(10_000 + controllerLeaseHeartbeatMs - 1)).toBe(false)
    expect(lease.isExpired(10_000 + controllerLeaseHeartbeatMs)).toBe(true)

    expect(lease.heartbeat("stale")).toBe(false)
  })

  test("an empty lease is not expired", () => {
    const lease = new ControllerLease(() => 0)
    expect(lease.isExpired(1_000_000)).toBe(false)
  })

  test("a stale controller cannot release or outlive its replacement", () => {
    let now = 0
    const lease = new ControllerLease(() => now)
    lease.acquire("a")

    now = 1_000
    lease.acquire("b")

    // The old holder's delayed calls must not evict the replacement.
    expect(lease.release("a")).toBe(false)
    expect(lease.heartbeat("a")).toBe(false)
    expect(lease.holds("b")).toBe(true)
    expect(lease.current()).toBe("b")

    expect(lease.release("b")).toBe(true)
    expect(lease.current()).toBeUndefined()
    expect(lease.release("b")).toBe(false)
  })
})
