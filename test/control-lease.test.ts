import { describe, expect, test } from "bun:test"

import { createControlClient } from "../src/control-client"
import { ControlProgress } from "../src/control-progress"
import { startControlServer, type ControllerLeaseEvent, type ControlServer } from "../src/control-server"

/**
 * Controller-lease notifications (change fix-opencode-server-lifecycle,
 * design D4): a completed run's terminal hold must follow a controller that
 * leaves or silently dies, without waiting for a request that will never come.
 */

async function claim(server: Awaited<ReturnType<typeof startControlServer>>) {
  const client = createControlClient({ url: server.url, token: server.token })
  await client.claimController()
  return client
}

describe("control-server lease notifications", () => {
  test("a silent controller expires without any further request", async () => {
    const server = await startControlServer({ controllerTimeoutMs: 100 })
    const events: ControllerLeaseEvent[] = []
    const unsubscribe = server.onControllerLease((event) => events.push(event))
    try {
      await claim(server)
      expect(server.hasController()).toBe(true)
      // No further requests: the server's own timer must detect expiry.
      await Bun.sleep(1_300)
      expect(server.hasController()).toBe(false)
      expect(events).toEqual(["claimed", "expired"])
    } finally {
      unsubscribe()
      server.close()
    }
  })

  test("a valid /bye emits a release and no later expiry", async () => {
    const server = await startControlServer({ controllerTimeoutMs: 100 })
    const events: ControllerLeaseEvent[] = []
    server.onControllerLease((event) => events.push(event))
    try {
      const client = await claim(server)
      await client.bye()
      expect(server.hasController()).toBe(false)
      await Bun.sleep(1_300)
      expect(events).toEqual(["claimed", "released"])
    } finally {
      server.close()
    }
  })
})

describe("terminal hold follows the controller lease", () => {
  test("a silent expiry releases the finish hold", async () => {
    const server = await startControlServer({ controllerTimeoutMs: 100 })
    const progress = new ControlProgress({ server })
    try {
      await claim(server)
      let settled = false
      const held = progress.runFinished({ status: "completed", runDir: "/tmp/run" }).then(() => {
        settled = true
      })
      expect(server.pending.snapshot().finish?.status).toBe("completed")
      await Bun.sleep(1_400)
      expect(settled).toBe(true)
      expect(server.pending.snapshot().finish).toBeUndefined()
      await held
    } finally {
      server.close()
    }
  }, 10_000)

  test("an explicit departure releases the hold", async () => {
    const server = await startControlServer()
    const progress = new ControlProgress({ server })
    try {
      const client = await claim(server)
      const held = progress.runFinished({ status: "completed", runDir: "/tmp/run" })
      await Bun.sleep(20)
      expect(server.pending.snapshot().finish).toBeDefined()
      await client.bye()
      const settled = await Promise.race([held.then(() => true), Bun.sleep(250).then(() => false)])
      expect(settled).toBe(true)
    } finally {
      server.close()
    }
  })

  test("no controller at hold entry releases immediately", async () => {
    const server = await startControlServer()
    const progress = new ControlProgress({ server })
    try {
      await progress.runFinished({ status: "completed", runDir: "/tmp/run" })
      expect(server.pending.snapshot().finish).toBeUndefined()
    } finally {
      server.close()
    }
  })
})

describe("lease notification lifecycle", () => {
  test("unsubscribe stops further delivery", async () => {
    const server = await startControlServer({ controllerTimeoutMs: 100 })
    const events: ControllerLeaseEvent[] = []
    const unsubscribe = server.onControllerLease((event) => events.push(event))
    unsubscribe()
    try {
      await claim(server)
      await Bun.sleep(1_300)
      expect(events).toEqual([])
    } finally {
      server.close()
    }
  })

  test("observer traffic neither holds nor dismisses a controller's finish screen", async () => {
    const server = await startControlServer()
    const progress = new ControlProgress({ server })
    try {
      const controller = await claim(server)
      const observer = createControlClient({ url: server.url, token: server.token })
      const held = progress.runFinished({ status: "completed", runDir: "/tmp/run" })
      await Bun.sleep(20)
      await observer.pending()
      await Bun.sleep(20)
      // An observer may inspect pending state without acquiring or releasing
      // the terminal hold.
      expect(server.pending.snapshot().finish).toBeDefined()
      await controller.bye()
      const settled = await Promise.race([held.then(() => true), Bun.sleep(250).then(() => false)])
      expect(settled).toBe(true)
    } finally {
      server.close()
    }
  })

  test("closing the server disposes the lease timer and listeners", async () => {
    const server = await startControlServer({ controllerTimeoutMs: 50 })
    const events: ControllerLeaseEvent[] = []
    server.onControllerLease((event) => events.push(event))
    await claim(server)
    server.close()
    await Bun.sleep(1_200)
    expect(events).toEqual(["claimed"])
  })
})

describe("terminal hold against controller replacement", () => {
  test("an old lease's expiry never dismisses a replacement controller's finish screen", async () => {
    let controllerPresent = true
    let leaseListener: ((event: ControllerLeaseEvent) => void) | undefined
    let resolvedFinish = 0
    let releaseHold: (() => void) | undefined
    const fakeServer = {
      token: "t",
      setHandlers: () => {},
      hasController: () => controllerPresent,
      onControllerLease: (listener: (event: ControllerLeaseEvent) => void) => {
        leaseListener = listener
        return () => {
          leaseListener = undefined
        }
      },
      pending: {
        holdFinish: () => new Promise<void>((resolve) => (releaseHold = resolve)),
        resolveFinish: () => {
          resolvedFinish++
          releaseHold?.()
        },
      },
    } as unknown as ControlServer
    const progress = new ControlProgress({ server: fakeServer })
    const held = progress.runFinished({ status: "completed", runDir: "/tmp/run" })
    await Bun.sleep(5)
    // A replacement claimed the slot before the old lease's expiry ran: the
    // callback must revalidate current ownership and leave the hold alone.
    leaseListener?.("expired")
    await Bun.sleep(5)
    expect(resolvedFinish).toBe(0)
    // The replacement's own departure then releases it, once.
    controllerPresent = false
    leaseListener?.("released")
    expect(await Promise.race([held.then(() => true), Bun.sleep(100).then(() => false)])).toBe(true)
    expect(resolvedFinish).toBe(1)
  })
})
