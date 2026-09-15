import { describe, expect, test } from "bun:test"

import { createControlClient } from "../src/control-client"
import { ControlProgress } from "../src/control-progress"
import { CONTROLLER_ID_HEADER, ControlPendingQueue, startControlServer, type ControlServer } from "../src/control-server"
import type { AutoAccept, PermissionPromptInfo } from "../src/progress"

const permissionInfo: PermissionPromptInfo = {
  id: "perm-1",
  permission: "bash",
  patterns: ["bash"],
  command: "ls -la",
  sessionID: "sess-1",
}

async function post(srv: ControlServer, path: string, body?: unknown, controllerId?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${srv.token}` }
  if (controllerId) headers[CONTROLLER_ID_HEADER] = controllerId
  return fetch(`${srv.url}${path}`, {
    method: "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function claim(srv: ControlServer): Promise<string> {
  const hello = await post(srv, "/hello", { role: "controller" })
  const { controllerId } = (await hello.json()) as { controllerId: string }
  return controllerId
}

describe("control server", () => {
  test("rejects missing and wrong auth on every route", async () => {
    const server = await startControlServer()
    try {
      expect((await fetch(`${server.url}/pending`)).status).toBe(401)
      expect((await fetch(`${server.url}/pending`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401)
      expect((await fetch(`${server.url}/abort`, { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(401)
    } finally {
      server.close()
    }
  })

  test("allows one controller and refuses a second with 409 while observers pass", async () => {
    const server = await startControlServer()
    try {
      expect((await post(server, "/hello", { role: "controller" })).status).toBe(200)
      expect((await post(server, "/hello", { role: "controller" })).status).toBe(409)
      expect((await post(server, "/hello", { role: "observer" })).status).toBe(200)
      // A malformed role is a protocol error, not a slot claim.
      expect((await post(server, "/hello", { role: "manager" })).status).toBe(400)
    } finally {
      server.close()
    }
  })

  test("bye frees the controller slot, but only for the claimant", async () => {
    const server = await startControlServer()
    try {
      const hello = await post(server, "/hello", { role: "controller" })
      const { controllerId } = (await hello.json()) as { controllerId: string }
      // A caller without the claim id (an observer sharing the token) must not
      // be able to evict the live controller.
      expect((await post(server, "/bye")).status).toBe(409)
      expect((await post(server, "/bye", { controllerId: "not-the-id" })).status).toBe(409)
      expect((await post(server, "/hello", { role: "controller" })).status).toBe(409)
      expect((await post(server, "/bye", { controllerId })).status).toBe(200)
      expect((await post(server, "/hello", { role: "controller" })).status).toBe(200)
    } finally {
      server.close()
    }
  })

  test("a controller that goes silent loses the slot after the heartbeat window", async () => {
    const server = await startControlServer({ controllerTimeoutMs: 120 })
    try {
      expect((await post(server, "/hello", { role: "controller" })).status).toBe(200)
      expect(server.hasController()).toBe(true)
      // No request carries the controller id: the claim expires, so the next
      // attach takes control instead of being locked out as an observer.
      await Bun.sleep(250)
      expect(server.hasController()).toBe(false)
      expect((await post(server, "/hello", { role: "controller" })).status).toBe(200)
    } finally {
      server.close()
    }
  })

  test("observer traffic does not keep a dead controller's slot alive", async () => {
    const server = await startControlServer({ controllerTimeoutMs: 120 })
    try {
      const client = createControlClient({ url: server.url, token: server.token })
      expect(await client.claimController()).toBe("controller")
      // An observer polls (no controller id header) while the controller is
      // gone; the slot must still expire on schedule.
      const observer = createControlClient({ url: server.url, token: server.token })
      expect(await observer.claimController()).toBe("observer")
      for (let i = 0; i < 6; i++) {
        await observer.pending()
        await Bun.sleep(50)
      }
      expect(server.hasController()).toBe(false)
    } finally {
      server.close()
    }
  })

  test("pause, resume, abort, and keep-awake fire their handlers", async () => {
    const calls: string[] = []
    const server = await startControlServer({
      handlers: {
        onPause: () => void calls.push("pause"),
        onResume: () => void calls.push("resume"),
        onAbort: () => void calls.push("abort"),
        onKeepAwakeToggle: () => void calls.push("keep-awake"),
      },
    })
    try {
      const id = await claim(server)
      await post(server, "/pause", undefined, id)
      await post(server, "/resume", undefined, id)
      await post(server, "/abort", undefined, id)
      await post(server, "/keep-awake", undefined, id)
      expect(calls).toEqual(["pause", "resume", "abort", "keep-awake"])
    } finally {
      server.close()
    }
  })

  test("interactive and finish-dismiss fire their handlers", async () => {
    const calls: string[] = []
    const server = await startControlServer({
      handlers: {
        onFinishDismiss: () => void calls.push("finish-dismiss"),
      },
    })
    try {
      const id = await claim(server)
      // [i] lives on the server's armed set, readable by the gate adapter.
      await post(server, "/interactive", { phase: "design", armed: true }, id)
      await post(server, "/interactive", { phase: "design", armed: false }, id)
      expect(server.isInteractiveArmed("design")).toBe(false)
      await post(server, "/interactive", { phase: "tests", armed: true }, id)
      expect(server.isInteractiveArmed("tests")).toBe(true)
      await post(server, "/finish-dismiss", undefined, id)
      expect(calls).toEqual(["finish-dismiss"])
      expect((await post(server, "/interactive", { phase: 1 }, id)).status).toBe(400)
    } finally {
      server.close()
    }
  })

  test("auto-accept cycles the shared object and honors an explicit mode", async () => {
    const shared: AutoAccept = { mode: "off" }
    const server = await startControlServer({ handlers: { autoAccept: shared } })
    try {
      const id = await claim(server)
      const first = await post(server, "/auto-accept", undefined, id)
      expect((await first.json())).toMatchObject({ mode: "all" })
      expect(shared.mode).toBe("all")

      expect((await (await post(server, "/auto-accept", undefined, id)).json())).toMatchObject({ mode: "smart" })
      expect((await (await post(server, "/auto-accept", { mode: "off" }, id)).json())).toMatchObject({ mode: "off" })
      expect(shared.mode).toBe("off")
    } finally {
      server.close()
    }
  })

  test("POST /keep-run-dir flips ControlProgress.keepRunDirRequested so release can keep the workspace", async () => {
    const server = await startControlServer()
    try {
      const progress = new ControlProgress({ server })
      expect(progress.keepRunDirRequested()).toBe(false)
      const id = await claim(server)
      expect((await post(server, "/keep-run-dir", undefined, id)).status).toBe(200)
      expect(progress.keepRunDirRequested()).toBe(true)
    } finally {
      server.close()
    }
  })

  test("a pending permission shows in GET /pending and resolves on POST /permission", async () => {
    const pending = new ControlPendingQueue()
    const server = await startControlServer({ pending })
    try {
      expect(pending.snapshot()).toEqual({})

      const id = await claim(server)
      const wait = pending.holdPermission({ ...permissionInfo })
      expect(pending.snapshot()).toMatchObject({
        permission: { requestId: "perm-1", permission: "bash", patterns: ["bash"], command: "ls -la" },
      })

      expect((await post(server, "/permission", { id: "nope", reply: "once" }, id)).status).toBe(404)
      expect((await post(server, "/permission", { id: "perm-1" }, id)).status).toBe(400)

      expect((await post(server, "/permission", { id: "perm-1", reply: "once" }, id)).status).toBe(200)
      expect(await wait).toBe("once")
      expect(pending.snapshot()).toEqual({})
    } finally {
      server.close()
    }
  })

  test("concurrent permission asks queue instead of overwriting each other", async () => {
    const pending = new ControlPendingQueue()
    const server = await startControlServer({ pending })
    try {
      const id = await claim(server)
      // Parallel phases can ask concurrently; dropping a waiter would hang the
      // coordinator on a promise nobody can resolve anymore.
      const first = pending.holdPermission({ ...permissionInfo })
      const second = pending.holdPermission({ ...permissionInfo, id: "perm-2" })

      // The snapshot surfaces the head; the tail waits its turn.
      expect(pending.snapshot().permission?.requestId).toBe("perm-1")

      // Resolving out of order (by id) must not orphan the other waiter.
      expect((await post(server, "/permission", { id: "perm-2", reply: "reject" }, id)).status).toBe(200)
      expect(await second).toBe("reject")
      expect(pending.snapshot().permission?.requestId).toBe("perm-1")
      expect((await post(server, "/permission", { id: "perm-1", reply: "once" }, id)).status).toBe(200)
      expect(await first).toBe("once")
      expect(pending.snapshot()).toEqual({})
    } finally {
      server.close()
    }
  })

  test("pending is empty when idle", async () => {
    const server = await startControlServer()
    try {
      const response = await fetch(`${server.url}/pending`, { headers: { authorization: `Bearer ${server.token}` } })
      expect(await response.json()).toEqual({})
    } finally {
      server.close()
    }
  })

  test("the finish hold surfaces its outcome for the client's finish screen", async () => {
    const pending = new ControlPendingQueue()
    const server = await startControlServer({ pending })
    try {
      // The outcome travels with the hold so an attached dashboard renders
      // the real verdict (status, error, goal loop) instead of guessing.
      const wait = pending.holdFinish({
        status: "failed",
        error: "phase tests failed",
        goalLoop: { target: 90, iteration: 3, maxRuns: 5, plateau: 2, scores: [60, 71, 84], outcome: { reason: "max-iterations", reached: false, restored: false } },
      })
      expect(pending.snapshot().finish).toEqual({
        status: "failed",
        error: "phase tests failed",
        goalLoop: { target: 90, iteration: 3, maxRuns: 5, plateau: 2, scores: [60, 71, 84], outcome: { reason: "max-iterations", reached: false, restored: false } },
      })
      expect(pending.resolveFinish()).toBe(true)
      await wait
      expect(pending.snapshot()).toEqual({})
    } finally {
      server.close()
    }
  })

  test("round-trips through the client with Bearer auth", async () => {
    const server = await startControlServer()
    const client = createControlClient({ url: server.url, token: server.token })
    try {
      expect(await client.claimController()).toBe("controller")
      expect(await client.pending()).toEqual({})

      // A second controller is refused and falls back to observer.
      const second = createControlClient({ url: server.url, token: server.token })
      expect(await second.claimController()).toBe("observer")

      // A gate held by the coordinator resolves through the client.
      const wait = server.pending.holdPermission({ ...permissionInfo })
      expect((await client.pending()).permission?.requestId).toBe("perm-1")
      await client.permission("perm-1", "reject")
      expect(await wait).toBe("reject")
      expect(server.pending.snapshot()).toEqual({})
    } finally {
      server.close()
    }
  })

  test("mutating routes require a live controller claim, not just the bearer token", async () => {
    const calls: string[] = []
    const pending = new ControlPendingQueue()
    const server = await startControlServer({
      pending,
      handlers: {
        onPause: () => void calls.push("pause"),
        onResume: () => void calls.push("resume"),
        onAbort: () => void calls.push("abort"),
        onKeepAwakeToggle: () => void calls.push("keep-awake"),
        onFinishDismiss: () => void calls.push("finish-dismiss"),
        onKeepRunDirRequested: () => void calls.push("keep-run-dir"),
      },
    })
    try {
      const mutating: Array<[string, unknown?]> = [
        ["/pause"],
        ["/resume"],
        ["/abort"],
        ["/keep-awake"],
        ["/keep-run-dir"],
        ["/finish-dismiss"],
        ["/auto-accept", { mode: "off" }],
        ["/interactive", { phase: "design", armed: true }],
        ["/permission", { id: "perm-1", reply: "once" }],
        ["/human", { id: "human-1", action: "continue" }],
      ]
      for (const [path, body] of mutating) {
        expect((await post(server, path, body)).status).toBe(403)
      }
      expect(calls).toEqual([])
      // Reads and the claim protocol stay token-open.
      expect((await fetch(`${server.url}/pending`, { headers: { authorization: `Bearer ${server.token}` } })).status).toBe(200)
      expect((await fetch(`${server.url}/status`, { headers: { authorization: `Bearer ${server.token}` } })).status).toBe(200)

      const hello = await post(server, "/hello", { role: "controller" })
      const { controllerId } = (await hello.json()) as { controllerId: string }
      expect((await post(server, "/abort", undefined, controllerId)).status).toBe(200)
      expect(calls).toEqual(["abort"])
      // Bearer-only after a claim is still refused — observers share the token.
      expect((await post(server, "/pause")).status).toBe(403)
      expect(calls).toEqual(["abort"])
    } finally {
      server.close()
    }
  })

  test("controller lease expiry leaves permission and human gates pending", async () => {
    const pending = new ControlPendingQueue()
    const server = await startControlServer({ pending, controllerTimeoutMs: 120 })
    try {
      const id = await claim(server)
      expect(id).toBeTruthy()
      let permissionSettled = false
      let humanSettled = false
      const permission = pending.holdPermission({ ...permissionInfo })
      const human = pending.holdHuman({ stepName: "review-a", iterations: 0 })
      void permission.then(() => {
        permissionSettled = true
      })
      void human.then(() => {
        humanSettled = true
      })
      expect(pending.snapshot().permission?.requestId).toBe("perm-1")
      expect(pending.snapshot().human?.stepName).toBe("review-a")

      // The controller goes silent; the lease expires with no further request.
      await Bun.sleep(250)
      expect(server.hasController()).toBe(false)

      // A departed controller never answers or rejects a pending decision, and
      // the gates are not auto-cancelled: they wait for the next controller
      // (spec R5 "Background execution and independent services remain
      // protected"). Only the finish hold follows the lease.
      expect(permissionSettled).toBe(false)
      expect(humanSettled).toBe(false)
      expect(pending.snapshot().permission?.requestId).toBe("perm-1")
      expect(pending.snapshot().human?.stepName).toBe("review-a")
    } finally {
      server.close()
    }
  })

  test("concurrent human gates resolve by id, not by queue head", async () => {
    const pending = new ControlPendingQueue()
    const server = await startControlServer({ pending })
    try {
      const hello = await post(server, "/hello", { role: "controller" })
      const { controllerId } = (await hello.json()) as { controllerId: string }

      const first = pending.holdHuman({ stepName: "review-a", iterations: 0 })
      const second = pending.holdHuman({ stepName: "review-b", iterations: 1, kind: "failure", canRetry: true })

      const headId = pending.snapshot().human?.requestId
      expect(headId).toBeTruthy()
      expect(pending.snapshot().human?.stepName).toBe("review-a")

      const bad = await post(server, "/human", { id: headId, action: "nope" }, controllerId)
      expect(bad.status).toBe(400)
      expect(await bad.text()).toMatch(/reset/)

      // A missing id must not shift the head (permissions already resolve by id).
      expect((await post(server, "/human", { id: "nope", action: "continue" }, controllerId)).status).toBe(404)
      expect(pending.snapshot().human?.stepName).toBe("review-a")

      expect((await post(server, "/human", { id: headId, action: "iterate" }, controllerId)).status).toBe(200)
      expect(await first).toBe("iterate")
      const next = pending.snapshot().human
      expect(next?.stepName).toBe("review-b")
      expect(next?.requestId).toBeTruthy()
      expect(next?.requestId).not.toBe(headId)
      // A stale POST naming the already-resolved head must not consume the tail.
      expect((await post(server, "/human", { id: headId, action: "abort" }, controllerId)).status).toBe(404)
      expect(pending.snapshot().human?.stepName).toBe("review-b")
      expect((await post(server, "/human", { id: next?.requestId, action: "retry" }, controllerId)).status).toBe(200)
      expect(await second).toBe("retry")
      expect(pending.snapshot()).toEqual({})
    } finally {
      server.close()
    }
  })
})
