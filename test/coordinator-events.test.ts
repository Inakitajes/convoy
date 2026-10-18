import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OpencodeClient } from "../src/opencode-client"

import { LiveAttach } from "../src/attach-runtime"
import { ControlPendingQueue, type ControlServer } from "../src/control-server"
import { ControlProgress } from "../src/control-progress"
import { noopProgress, type ProgressMessage, type ProgressUI } from "../src/progress"
import type { RunnerEvent, RunnerId } from "../src/runners/contracts"
import { CoordinatorEvents, progressMessageFromRunnerEvent, runnerEventFromProgressMessage, type CoordinatorEventInput, type CoordinatorEventItem } from "../src/runners/coordinator-events"
import type { JournalStore } from "../src/runners/journal"

const dirs: string[] = []
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-coordinator-events-"))
  dirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

// A hand-driven in-memory journal store: `lines` is the plain-text NDJSON the
// journal appends, and `read` returns it exactly — so a second CoordinatorEvents
// over the same store replays durable history without any live harness.
function memoryStore(options: { gate?: Promise<void>; dropSeq?: number[] } = {}) {
  const lines: string[] = []
  const store: JournalStore = {
    async append(_path, line) {
      if (options.gate) await options.gate
      if (options.dropSeq?.includes((JSON.parse(line) as { seq: number }).seq)) return
      lines.push(line)
    },
    async read() {
      return lines.join("")
    },
  }
  return { store, lines }
}

const text = (value: string, runner: RunnerId = "claude-code", attempt = 1): RunnerEvent => ({ type: "text", runner, attempt, text: value })

function input(value: string, overrides: Partial<CoordinatorEventInput> = {}): CoordinatorEventInput {
  return { runId: "run-1", phase: "implement", event: text(value), ...overrides }
}

function fakeControlServer(): ControlServer {
  return {
    url: "http://127.0.0.1:0",
    token: "test-token",
    pending: new ControlPendingQueue(),
    hasController: () => false,
    onControllerLease: () => () => {},
    isInteractiveArmed: () => false,
    setHandlers: () => {},
    close: () => {},
  }
}

async function until(ready: () => boolean, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (ready()) return true
    await Bun.sleep(1)
  }
  return ready()
}

const seqs = (items: CoordinatorEventItem[]) => items.filter((item) => item.kind === "event").map((item) => (item as { record: { seq: number } }).record.seq)

describe("CoordinatorEvents", () => {
  test("publishes attempt-qualified events with monotonic sequence and reads them back", async () => {
    const { store } = memoryStore()
    const events = new CoordinatorEvents({ path: "ignored", store })

    expect(await events.publish(input("a"))).toBe(1)
    expect(await events.publish(input("b", { phase: "review", runId: "run-2" }))).toBe(2)
    expect(events.sequence).toBe(2)

    const records = await events.read()
    expect(records.map((record) => record.seq)).toEqual([1, 2])
    expect(records[0]!.runner).toBe("claude-code")
    expect(records[0]!.attempt).toEqual({ runId: "run-1", phase: "implement", attempt: 1 })
    expect(records[1]!.attempt).toEqual({ runId: "run-2", phase: "review", attempt: 1 })
    expect(await events.read(2)).toHaveLength(1)
    expect(await events.read(1, 1)).toHaveLength(1)
  })

  test("suppresses duplicate native ids without advancing the sequence", async () => {
    const { store } = memoryStore()
    const events = new CoordinatorEvents({ path: "ignored", store })
    expect(await events.publish(input("a", { nativeId: "n1" }))).toBe(1)
    expect(await events.publish(input("a again", { nativeId: "n1" }))).toBeUndefined()
    expect(await events.publish(input("b", { nativeId: "n2" }))).toBe(2)
    expect(events.sequence).toBe(2)
  })

  test("replays durable history to a late subscriber without a live harness", async () => {
    const { store } = memoryStore()
    const publisher = new CoordinatorEvents({ path: "ignored", store })
    for (const value of ["a", "b", "c"]) await publisher.publish(input(value))

    // A separate read model over the same durable store (no shared memory, no
    // live publisher) reconstructs every fragment.
    const reader = new CoordinatorEvents({ path: "ignored", store })
    const items: CoordinatorEventItem[] = []
    const unsub = reader.subscribe(0, (item) => items.push(item))
    expect(await until(() => items.length === 3)).toBe(true)
    unsub()
    expect(seqs(items)).toEqual([1, 2, 3])
    expect(items.every((item) => item.kind === "event")).toBe(true)
  })

  test("a cursor replays and merges with live events without duplicating fragments", async () => {
    const { store } = memoryStore()
    const events = new CoordinatorEvents({ path: "ignored", store })

    const live: CoordinatorEventItem[] = []
    const unsubLive = events.subscribe(0, (item) => live.push(item))
    for (const value of ["a", "b", "c", "d"]) await events.publish(input(value))
    expect(await until(() => live.length === 4)).toBe(true)

    // A late consumer that already has seq 1..2 joins mid-stream and receives
    // 3..4 from replay, then 5..6 live, each exactly once and in order.
    const merged: CoordinatorEventItem[] = []
    const unsubLate = events.subscribe(2, (item) => merged.push(item))
    await events.publish(input("e"))
    await events.publish(input("f"))
    expect(await until(() => merged.length === 4)).toBe(true)

    unsubLive()
    unsubLate()
    expect(seqs(live)).toEqual([1, 2, 3, 4, 5, 6])
    expect(seqs(merged)).toEqual([3, 4, 5, 6])
    // No duplicates anywhere.
    expect(new Set(merged.map((item) => JSON.stringify(item))).size).toBe(merged.length)
  })

  test("reports gaps when durable history has a hole", async () => {
    const { store } = memoryStore({ dropSeq: [3] })
    const events = new CoordinatorEvents({ path: "ignored", store, maxBufferRecords: 0 })
    for (const value of ["a", "b", "c", "d", "e"]) await events.publish(input(value))

    expect(await events.gaps(1, 5)).toEqual([{ from: 3, to: 3 }])

    const items: CoordinatorEventItem[] = []
    const unsub = events.subscribe(0, (item) => items.push(item))
    expect(await until(() => items.length === 5)).toBe(true)
    unsub()
    expect(items).toEqual([
      { kind: "event", record: expect.objectContaining({ seq: 1 }) },
      { kind: "event", record: expect.objectContaining({ seq: 2 }) },
      { kind: "gap", from: 3, to: 3 },
      { kind: "event", record: expect.objectContaining({ seq: 4 }) },
      { kind: "event", record: expect.objectContaining({ seq: 5 }) },
    ])
  })

  test("reports a gap when a slow consumer falls past the bounded tail", async () => {
    // A journal whose durable read is unavailable (truncated/degraded) but whose
    // bounded in-memory tail still holds the newest records. A consumer resuming
    // from 0 can only be served seq 3..4, and is told about the missing interval
    // rather than silently claiming completeness.
    const store: JournalStore = { append: async () => {}, read: async () => "" }
    const events = new CoordinatorEvents({ path: "ignored", store, maxBufferRecords: 2 })
    for (const value of ["a", "b", "c", "d"]) await events.publish(input(value))

    const items: CoordinatorEventItem[] = []
    const unsub = events.subscribe(0, (item) => items.push(item))
    expect(await until(() => items.length === 3)).toBe(true)
    unsub()
    expect(items).toEqual([
      { kind: "gap", from: 1, to: 2 },
      { kind: "event", record: expect.objectContaining({ seq: 3 }) },
      { kind: "event", record: expect.objectContaining({ seq: 4 }) },
    ])
  })

  test("enqueue never blocks intake and drops the oldest fragments under backpressure", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { store } = memoryStore({ gate })
    const events = new CoordinatorEvents({ path: "ignored", store, maxQueueRecords: 2 })

    for (const value of ["a", "b", "c", "d", "e"]) events.enqueue(input(value))
    // Returned immediately while the journal write was still gated.
    expect(events.status().dropped).toBe(2)
    expect(events.status().queued).toBeLessThanOrEqual(2)

    release()
    await events.whenIdle()
    // e1 was already in flight, then e4 and e5 survived the bounded queue.
    expect((await events.read()).map((record) => record.seq)).toEqual([1, 2, 3])
  })

  test("unsubscribe stops delivery", async () => {
    const { store } = memoryStore()
    const events = new CoordinatorEvents({ path: "ignored", store })
    const items: CoordinatorEventItem[] = []
    const unsub = events.subscribe(0, (item) => items.push(item))
    await events.publish(input("a"))
    expect(await until(() => items.length === 1)).toBe(true)
    unsub()
    await events.publish(input("b"))
    await Bun.sleep(5)
    expect(items).toHaveLength(1)
  })

  test("a coordinator publishes Claude phase messages into the neutral journal without an OpenCode URL", async () => {
    const dir = await scratch()
    const { store } = memoryStore()
    const events = new CoordinatorEvents({ path: "ignored", store })
    const server = fakeControlServer()
    const progress = new ControlProgress({ server, events, runner: "claude-code" })

    progress.start("run-1", dir, dir)
    progress.phaseAttempt("implement", { attempt: 2, model: "claude-sonnet" })
    progress.phaseMessage("implement", { channel: "reasoning", text: "why", partID: "r1" })
    progress.phaseMessage("implement", { channel: "response", text: "answer", partID: "t1" })
    progress.phaseMessage("implement", { channel: "tool", text: "read: src/x.ts" })
    await events.whenIdle()

    const records = await events.read()
    expect(records.map((record) => record.runner)).toEqual(["claude-code", "claude-code", "claude-code"])
    expect(records[0]!.attempt).toEqual({ runId: "run-1", phase: "implement", attempt: 2 })
    expect(records.map((record) => record.event.type)).toEqual(["reasoning", "text", "tool"])
    expect(events.status().degraded).toBe(false)
  })

  test("a dashboard consumes neutral journal events for the phases without native live attach", async () => {
    const dir = await scratch()
    const { store } = memoryStore()
    const events = new CoordinatorEvents({ path: "ignored", store })
    const messages: Record<string, ProgressMessage[]> = {}
    const tui: ProgressUI = {
      ...noopProgress,
      phaseMessage: (name, message) => {
        ;(messages[name] ??= []).push(message)
      },
    }
    const attach = new LiveAttach({} as OpencodeClient, tui, dir, join(dir, "metadata.json"), new Set(["implement"]), 10, events)
    try {
      await attach.start()
      await events.publish({ runId: "run-1", phase: "implement", event: { type: "text", runner: "claude-code", attempt: 1, text: "hello" } })
      expect(await until(() => (messages["implement"]?.length ?? 0) === 1)).toBe(true)
      expect(messages["implement"]).toEqual([{ channel: "response", text: "hello" }])
    } finally {
      await attach.stop()
    }
  })

  test("translates ProgressMessage chunks to neutral events and back", () => {
    expect(runnerEventFromProgressMessage("claude-code", 2, { channel: "response", text: "hi", partID: "p1" })).toEqual({
      type: "text",
      runner: "claude-code",
      attempt: 2,
      text: "hi",
      partId: "p1",
    })
    expect(runnerEventFromProgressMessage("opencode", 1, { channel: "reasoning", text: "why" })).toEqual({
      type: "reasoning",
      runner: "opencode",
      attempt: 1,
      text: "why",
    })
    expect(runnerEventFromProgressMessage("opencode", 1, { channel: "tool", text: "read: src/x.ts" })).toEqual({
      type: "tool",
      runner: "opencode",
      attempt: 1,
      name: "read: src/x.ts",
    })
    expect(progressMessageFromRunnerEvent({ type: "text", runner: "opencode", attempt: 1, text: "hi", partId: "p1" })).toEqual({ channel: "response", text: "hi", partID: "p1" })
    expect(progressMessageFromRunnerEvent({ type: "tool", runner: "opencode", attempt: 1, name: "bash", detail: "ls" })).toEqual({ channel: "tool", text: "bash: ls" })
    expect(progressMessageFromRunnerEvent({ type: "permission-request", runner: "opencode", attempt: 1, requestId: "r", action: "read" })).toBeUndefined()
  })
})
