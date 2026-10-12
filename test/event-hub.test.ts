import { describe, expect, test } from "bun:test"
import type { OpencodeClient } from "../src/opencode-client"

import { createSessionEventHub, getSessionEventHub } from "../src/event-hub"

// A hand-driven event stream: push() feeds one event to the async iterator the
// hub consumes; close() lets the iterator finish (the hub does this on abort).
function createEventChannel() {
  const queue: unknown[] = []
  let wake: (() => void) | undefined
  let closed = false
  const stream = (async function* () {
    while (true) {
      if (queue.length === 0) {
        if (closed) return
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
      while (queue.length > 0) yield queue.shift()
      if (closed && queue.length === 0) return
    }
  })()
  return {
    stream,
    push(event: unknown) {
      queue.push(event)
      wake?.()
      wake = undefined
    },
    close() {
      closed = true
      wake?.()
      wake = undefined
    },
  }
}

function makeClient() {
  const channels: ReturnType<typeof createEventChannel>[] = []
  let subscribeCalls = 0
  const client = {
    event: {
      subscribe: async (_opts: unknown, init?: { signal?: AbortSignal }) => {
        subscribeCalls++
        const channel = createEventChannel()
        channels.push(channel)
        init?.signal?.addEventListener("abort", () => channel.close(), { once: true })
        return { stream: channel.stream }
      },
    },
  } as unknown as OpencodeClient
  return { client, channels, subscribeCalls: () => subscribeCalls }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const sessionEvent = (sessionID: string, type = "message.part.delta") => ({ payload: { type, properties: { sessionID } } })

describe("SessionEventHub", () => {
  test("routes each event only to its session's listeners, and everything to onAny", async () => {
    const { client, channels } = makeClient()
    const hub = createSessionEventHub(client, "/repo")
    const a: unknown[] = []
    const b: unknown[] = []
    const all: unknown[] = []
    const offs = [
      hub.onSession("s1", (p) => a.push(p)),
      hub.onSession("s2", (p) => b.push(p)),
      hub.onAny((p) => all.push(p)),
    ]
    try {
      await hub.ready
      channels[0]!.push(sessionEvent("s1"))
      channels[0]!.push(sessionEvent("s2"))
      channels[0]!.push({ payload: { type: "permission.asked", properties: { id: "req-1" } } }) // no sessionID
      await tick()

      expect(a).toHaveLength(1)
      expect(b).toHaveLength(1)
      expect((a[0] as { properties: { sessionID: string } }).properties.sessionID).toBe("s1")
      expect((b[0] as { properties: { sessionID: string } }).properties.sessionID).toBe("s2")
      // onAny sees all three, including the session-less permission request.
      expect(all).toHaveLength(3)
    } finally {
      for (const off of offs) off()
    }
  })

  test("a failing listener never starves the others", async () => {
    const { client, channels } = makeClient()
    const hub = createSessionEventHub(client, "/repo")
    const seen: unknown[] = []
    const offs = [
      hub.onSession("s1", () => {
        throw new Error("boom")
      }),
      hub.onSession("s1", (p) => seen.push(p)),
    ]
    try {
      await hub.ready
      channels[0]!.push(sessionEvent("s1"))
      await tick()
      expect(seen).toHaveLength(1)
    } finally {
      for (const off of offs) off()
    }
  })

  test("getSessionEventHub memoizes one subscription per (client, directory)", async () => {
    const { client, subscribeCalls } = makeClient()
    const h1 = getSessionEventHub(client, "/repo")
    const off = h1.onAny(() => {})
    try {
      const h2 = getSessionEventHub(client, "/repo")
      expect(h2).toBe(h1)
      const other = getSessionEventHub(client, "/other")
      expect(other).not.toBe(h1)
      await Promise.all([h1.ready, other.ready])
      expect(subscribeCalls()).toBe(2) // one per distinct directory, not per caller
    } finally {
      off()
    }
  })

  test("tears the subscription down when the last listener leaves, then rebuilds on demand", async () => {
    const { client, subscribeCalls } = makeClient()
    const h1 = getSessionEventHub(client, "/repo")
    const off = h1.onSession("s1", () => {})
    await h1.ready
    expect(subscribeCalls()).toBe(1)

    off() // last listener gone → hub stops and evicts itself
    const h2 = getSessionEventHub(client, "/repo")
    expect(h2).not.toBe(h1)
    const off2 = h2.onSession("s1", () => {})
    try {
      await h2.ready
      expect(subscribeCalls()).toBe(2)
    } finally {
      off2()
    }
  })
})
