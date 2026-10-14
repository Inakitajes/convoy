import { describe, expect, test } from "bun:test"

import { adoptChild, createProcessRegistry, type AdoptableChild } from "../src/runners/claude/process"

/** A deterministic child seam: no real processes, exit observed through listeners. */
function fakeChild(options: { pid?: number; exitOn?: Array<NodeJS.Signals> } = {}) {
  const listeners = new Set<() => void>()
  const signals: NodeJS.Signals[] = []
  const exitOn = new Set<NodeJS.Signals>(options.exitOn ?? [])
  let exited = false

  const exit = () => {
    if (exited) return
    exited = true
    for (const listener of [...listeners]) listener()
  }

  const child: AdoptableChild = {
    pid: options.pid ?? 1000,
    kill(signal) {
      const normal = (signal ?? "SIGTERM") as NodeJS.Signals
      signals.push(normal)
      if (exitOn.has(normal)) exit()
      return true
    },
    once(event, listener) {
      if (event === "exit") listeners.add(listener)
      return child
    },
    removeListener(event, listener) {
      if (event === "exit") listeners.delete(listener)
      return child
    },
  }

  return { child, signals, exit, isExited: () => exited }
}

const fastPolicy = { graceMs: 8, forceObservationMs: 8 }

describe("claude owned process adoption", () => {
  test("does not signal a child that has already exited", async () => {
    const fake = fakeChild({ exitOn: ["SIGTERM"] })
    const owned = adoptChild(fake.child, { policy: fastPolicy })
    fake.exit()

    const outcome = await owned.stop()
    expect(outcome).toEqual({ status: "stopped", via: "already-gone" })
    expect(fake.signals).toEqual([])
    expect(owned.isExited()).toBe(true)
  })

  test("never force-kills when executable verification refuses (PID reuse / incomplete evidence)", async () => {
    const fake = fakeChild() // ignores every signal: never exits
    const owned = adoptChild(fake.child, {
      policy: fastPolicy,
      verifyExpectedExecutable: async () => ({ ok: false, reason: "recorded pid now belongs to another executable" }),
    })

    const outcome = await owned.stop()
    expect(outcome).toEqual({ status: "unresolved", reason: expect.stringContaining("refused forced escalation") })
    // The graceful request is sent, but the lethal escalation is refused.
    expect(fake.signals).toEqual(["SIGTERM"])
    expect(fake.signals).not.toContain("SIGKILL")
  })

  test("treats a throwing verification probe as unverifiable, not as passing", async () => {
    const fake = fakeChild()
    const owned = adoptChild(fake.child, {
      policy: fastPolicy,
      verifyExpectedExecutable: async () => {
        throw new Error("probe unavailable")
      },
    })

    const outcome = await owned.stop()
    expect(outcome.status).toBe("unresolved")
    expect(fake.signals).not.toContain("SIGKILL")
  })

  test("escalates to SIGKILL only after verification passes", async () => {
    const fake = fakeChild({ exitOn: ["SIGKILL"] })
    const owned = adoptChild(fake.child, {
      policy: fastPolicy,
      verifyExpectedExecutable: async () => ({ ok: true }),
    })

    const outcome = await owned.stop()
    expect(outcome).toEqual({ status: "stopped", via: "forced" })
    expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"])
  })

  test("shares a single outcome across concurrent stop calls", async () => {
    const fake = fakeChild({ exitOn: ["SIGTERM"] })
    const owned = adoptChild(fake.child, { policy: fastPolicy })

    const first = owned.stop()
    const second = owned.stop()
    expect(first).toBe(second)

    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual({ status: "stopped", via: "graceful" })
    expect(b).toEqual(a)
    expect(fake.signals).toEqual(["SIGTERM"])
  })

  test("forceStop delivers a synchronous SIGKILL edge", () => {
    const fake = fakeChild({ exitOn: ["SIGKILL"] })
    const owned = adoptChild(fake.child, { policy: fastPolicy })

    owned.forceStop()
    expect(fake.signals).toEqual(["SIGKILL"])
    expect(owned.isExited()).toBe(true)
  })
})

describe("process registry", () => {
  test("stopAll stops every owned process and retains unresolved evidence", async () => {
    const graceful = fakeChild({ pid: 11, exitOn: ["SIGTERM"] })
    const stuck = fakeChild({ pid: 22 })
    const registry = createProcessRegistry()
    registry.register("graceful", adoptChild(graceful.child, { policy: fastPolicy }))
    registry.register(
      "stuck",
      adoptChild(stuck.child, {
        policy: fastPolicy,
        verifyExpectedExecutable: async () => ({ ok: false, reason: "reused pid" }),
      }),
    )

    const result = await registry.stopAll(fastPolicy)
    expect(result.stopped).toEqual([{ id: "graceful", via: "graceful" }])
    expect(result.unresolved).toHaveLength(1)
    expect(result.unresolved[0]?.id).toBe("stuck")
    const retained = registry.unresolved()
    expect(retained).toHaveLength(1)
    expect(retained[0]?.id).toBe("stuck")
    expect(retained[0]?.reason).toContain("refused forced escalation")
  })

  test("a confirmed stop ends ownership; release forgets retained evidence", async () => {
    const stuck = fakeChild()
    const registry = createProcessRegistry()
    registry.register(
      "stuck",
      adoptChild(stuck.child, {
        policy: fastPolicy,
        verifyExpectedExecutable: async () => ({ ok: false, reason: "no evidence" }),
      }),
    )

    await registry.stopAll(fastPolicy)
    expect(registry.unresolved().map((entry) => entry.id)).toEqual(["stuck"])

    registry.release("stuck")
    expect(registry.unresolved()).toEqual([])
    expect(await registry.stopAll(fastPolicy)).toEqual({ stopped: [], unresolved: [] })
  })

  test("re-registering an id clears stale evidence", () => {
    const registry = createProcessRegistry()
    const never = fakeChild()
    registry.register("x", adoptChild(never.child, { policy: fastPolicy }))
    // Record an unresolved stop, then replace the registration.
    return registry.stopAll(fastPolicy).then(() => {
      expect(registry.unresolved()).toHaveLength(1)
      registry.register("x", adoptChild(fakeChild({ exitOn: ["SIGTERM"] }).child, { policy: fastPolicy }))
      expect(registry.unresolved()).toEqual([])
    })
  })
})
