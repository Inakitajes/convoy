import type { OpencodeClient } from "./opencode-client"

import { log } from "./log"

const reconnectBaseMs = 1_000
const reconnectMaxMs = 15_000

type Listener = (payload: unknown) => void

export type SessionEventHub = {
  /** Resolves once the shared subscription is established (or its first attempt settles). */
  ready: Promise<void>
  /** Fires for events whose payload carries this sessionID. Returns an unsubscribe. */
  onSession(sessionID: string, listener: Listener): () => void
  /** Fires for every event regardless of session (e.g. permission.asked). Returns an unsubscribe. */
  onAny(listener: Listener): () => void
}

// One directory-scoped `event.subscribe` shared by every phase and the
// permission gate, fanned out to per-session and global listeners. It replaces
// the old model of one subscription per phase (plus one for the gate): because
// opencode's event bus is directory-scoped, every subscription received every
// session's events, so N concurrent phases meant O(N²) delivery and parsing.
// Hubs are memoized per (client, directory) and torn down once their last
// listener unregisters (the run-long permission gate keeps the count ≥1 for the
// whole run, so a production run holds exactly one stable subscription).
const hubs = new WeakMap<OpencodeClient, Map<string, SessionEventHub>>()

export function getSessionEventHub(client: OpencodeClient, directory: string): SessionEventHub {
  let byDir = hubs.get(client)
  if (!byDir) {
    byDir = new Map()
    hubs.set(client, byDir)
  }
  let hub = byDir.get(directory)
  if (!hub) {
    hub = createSessionEventHub(client, directory, () => byDir!.delete(directory))
    byDir.set(directory, hub)
  }
  return hub
}

export function createSessionEventHub(client: OpencodeClient, directory: string, onEmpty?: () => void): SessionEventHub {
  const controller = new AbortController()
  const sessionListeners = new Map<string, Set<Listener>>()
  const anyListeners = new Set<Listener>()
  let listenerCount = 0
  let stopped = false

  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  const stop = () => {
    if (stopped) return
    stopped = true
    resolveReady()
    controller.abort(new Error("event hub stopped"))
    onEmpty?.()
  }

  // The gate and every watcher share this hub; when the last one unregisters the
  // shared subscription is no longer needed, so tear it down and let the next
  // getSessionEventHub build a fresh one.
  const dropListener = () => {
    listenerCount--
    if (listenerCount <= 0) stop()
  }

  const emit = (listeners: Iterable<Listener>, payload: unknown) => {
    for (const listener of listeners) {
      try {
        listener(payload)
      } catch (error) {
        log.warn(`event hub listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const dispatch = (payload: unknown) => {
    // A misbehaving global listener must never starve the session listeners, and
    // vice versa; emit() isolates each with its own try/catch.
    if (anyListeners.size > 0) emit(anyListeners, payload)
    const sessionID = payloadProperties(payload)?.sessionID
    if (typeof sessionID === "string") {
      const listeners = sessionListeners.get(sessionID)
      if (listeners) emit(listeners, payload)
    }
  }

  void (async () => {
    let reconnectDelay = reconnectBaseMs
    while (!controller.signal.aborted && !stopped) {
      try {
        const stream = await client.event.subscribe({ directory }, { signal: controller.signal })
        resolveReady() // the subscription is live; phases may fire their prompts now
        reconnectDelay = reconnectBaseMs
        for await (const event of stream.stream) {
          if (controller.signal.aborted || stopped) return
          dispatch(eventPayload(event))
        }
      } catch (error) {
        resolveReady() // never block a prompt on a failed subscribe; the loop retries
        if (controller.signal.aborted || stopped) return
        log.warn(`event stream dropped; reconnecting: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (controller.signal.aborted || stopped) return
      await sleep(reconnectDelay, controller.signal)
      reconnectDelay = Math.min(reconnectDelay * 2, reconnectMaxMs)
    }
  })()

  return {
    ready,
    onSession(sessionID, listener) {
      let listeners = sessionListeners.get(sessionID)
      if (!listeners) {
        listeners = new Set()
        sessionListeners.set(sessionID, listeners)
      }
      if (listeners.has(listener)) return () => {}
      listeners.add(listener)
      listenerCount++
      let removed = false
      return () => {
        if (removed) return
        removed = true
        const set = sessionListeners.get(sessionID)
        if (set) {
          set.delete(listener)
          if (set.size === 0) sessionListeners.delete(sessionID)
        }
        dropListener()
      }
    },
    onAny(listener) {
      if (anyListeners.has(listener)) return () => {}
      anyListeners.add(listener)
      listenerCount++
      let removed = false
      return () => {
        if (removed) return
        removed = true
        anyListeners.delete(listener)
        dropListener()
      }
    },
  }
}

// Opencode wraps some events as `{ payload }`; others arrive bare. Unwrap once.
export function eventPayload(event: unknown) {
  if (event && typeof event === "object" && "payload" in event) return (event as { payload?: unknown }).payload
  return event
}

export function payloadProperties(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined
  const properties = (payload as { properties?: unknown }).properties
  if (properties && typeof properties === "object") return properties as Record<string, unknown>
  const data = (payload as { data?: unknown }).data
  if (data && typeof data === "object") return data as Record<string, unknown>
  return undefined
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const done = () => {
      signal?.removeEventListener("abort", done)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener("abort", done, { once: true })
  })
}
