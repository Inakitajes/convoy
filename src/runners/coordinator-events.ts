/**
 * Coordinator-owned, runner-neutral event read model (change
 * `runner-parity-opencode-v2`, design D6).
 *
 * `RunnerJournal` owns durable append-only storage, monotonic sequence numbers,
 * bounded memory, and duplicate-native-id suppression. `CoordinatorEvents`
 * wraps it with the coordination surface a dashboard needs and no harness
 * specifics:
 *
 *  - `publish` appends one attempt-qualified neutral `RunnerEvent` and wakes
 *    live subscribers;
 *  - `read` replays a `[fromSeq, toSeq]` cursor slice from durable history
 *    (merged with the in-memory tail so a degraded journal is still readable);
 *  - `subscribe(cursor, sink)` replays from the cursor and then merges live
 *    events using a high-water mark, so replay/live overlap never duplicates a
 *    fragment, and reports unrecoverable intervals as explicit gaps;
 *  - `enqueue` accepts events without blocking the caller, draining them to the
 *    journal on a bounded queue so a slow observer cannot stall intake or
 *    permission handling (design D6, task 9.5).
 *
 * Nothing here names a vendor or needs a live OpenCode server: the same surface
 * serves Claude and OpenCode, so a dashboard can follow either runner from the
 * journal alone.
 */

import { open, stat } from "node:fs/promises"
import { join } from "node:path"

import type { ProgressMessage } from "../progress"
import type { RunnerEvent, RunnerId } from "./contracts"
import { RunnerJournal, type JournalOptions, type JournalRecord } from "./journal"

/** Where a run's coordinator journal lives: private, beside the run's other event logs. */
export function coordinatorJournalPath(runDir: string): string {
  return join(runDir, "events", "coordinator-events.ndjson")
}

/**
 * One event to publish: a neutral `RunnerEvent` already carrying its `runner`
 * and `attempt`, plus the run/phase identity the journal qualifies records with.
 * `nativeId` is the harness id used only for reconnect deduplication.
 */
export type CoordinatorEventInput = {
  runId: string
  phase: string
  event: RunnerEvent
  nativeId?: string
}

/** An item delivered by `subscribe`: a durable event, or an unrecoverable gap. */
export type CoordinatorEventItem =
  | { kind: "event"; record: JournalRecord }
  | { kind: "gap"; from: number; to: number }

export type CoordinatorEventSink = (item: CoordinatorEventItem) => void

/** What a dashboard follows: the in-process read model, or a journal file another process writes. */
export type CoordinatorEventSource = {
  subscribe(cursor: number, sink: CoordinatorEventSink): () => void
}

export type CoordinatorEventsStatus = {
  /** Highest sequence number assigned so far. */
  sequence: number
  /** True when durable persistence failed and history is incomplete. */
  degraded: boolean
  reason?: string
  /** Fragments dropped by the bounded non-blocking `enqueue` policy. */
  dropped: number
  /** Events currently queued for background publication. */
  queued: number
}

export type CoordinatorEventsOptions = {
  /** Injectable journal (a shared instance, or a test double). Wins when set. */
  journal?: RunnerJournal
  /** Bound on the non-blocking `enqueue` queue; overflow drops oldest first. */
  maxQueueRecords?: number
} & Partial<JournalOptions>

type Listener = {
  cursor: number
  sink: CoordinatorEventSink
  active: boolean
}

const defaultMaxQueueRecords = 1_000

export class CoordinatorEvents {
  private readonly journal: RunnerJournal
  private readonly maxQueueRecords: number
  private readonly listeners = new Set<Listener>()
  private readonly waiters = new Set<() => void>()
  private readonly idleWaiters = new Set<() => void>()
  private readonly queue: CoordinatorEventInput[] = []
  private dropped = 0
  private pumping = false
  private closed = false
  private restored?: Promise<void>

  constructor(options: CoordinatorEventsOptions = {}) {
    this.journal = options.journal ?? new RunnerJournal({
      path: options.path ?? "coordinator-events.ndjson",
      ...(options.store ? { store: options.store } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.maxBufferRecords !== undefined ? { maxBufferRecords: options.maxBufferRecords } : {}),
      ...(options.maxBufferBytes !== undefined ? { maxBufferBytes: options.maxBufferBytes } : {}),
    })
    this.maxQueueRecords = options.maxQueueRecords ?? defaultMaxQueueRecords
  }

  /** The durable journal this read model owns or was handed. */
  get store(): RunnerJournal {
    return this.journal
  }

  /** Highest sequence number assigned so far. */
  get sequence(): number {
    return this.journal.sequence
  }

  status(): CoordinatorEventsStatus {
    const journal = this.journal.status()
    return {
      sequence: this.journal.sequence,
      degraded: journal.degraded,
      ...(journal.degraded ? { reason: journal.reason } : {}),
      dropped: this.dropped,
      queued: this.queue.length,
    }
  }

  /**
   * Append one neutral event durably and wake live subscribers. Resolves to the
   * assigned `seq`, or `undefined` when a duplicate native id was suppressed.
   */
  async publish(input: CoordinatorEventInput): Promise<number | undefined> {
    if (this.closed) return undefined
    // A resumed run appends to its existing journal: continue its sequence.
    await (this.restored ??= this.journal.restore())
    const seq = await this.journal.append({
      runner: input.event.runner,
      attempt: { runId: input.runId, phase: input.phase, attempt: input.event.attempt },
      event: input.event,
      ...(input.nativeId ? { nativeId: input.nativeId } : {}),
    })
    if (seq !== undefined) this.signal()
    return seq
  }

  /**
   * Non-blocking publication for the native intake path (design D6, task 9.5):
   * pushes onto a bounded queue and returns immediately, so a stalled journal
   * write or subscriber never blocks the caller. Overflow drops the oldest
   * queued fragments and is counted in `status().dropped` (reported as
   * incomplete, never silently complete).
   */
  enqueue(input: CoordinatorEventInput): void {
    if (this.closed) return
    this.queue.push(input)
    while (this.queue.length > this.maxQueueRecords) {
      this.queue.shift()
      this.dropped++
    }
    this.pump()
  }

  /** Resolves once every `enqueue`d event has been published (or dropped). */
  async whenIdle(): Promise<void> {
    while (this.pumping) {
      await new Promise<void>((resolve) => {
        const waiter = () => {
          this.idleWaiters.delete(waiter)
          resolve()
        }
        this.idleWaiters.add(waiter)
      })
    }
  }

  private pump(): void {
    if (this.pumping) return
    this.pumping = true
    void this.runQueue()
  }

  private async runQueue(): Promise<void> {
    try {
      for (;;) {
        const next = this.queue.shift()
        if (next === undefined) return
        await this.publish(next)
      }
    } finally {
      this.pumping = false
      for (const waiter of [...this.idleWaiters]) waiter()
      // An enqueue that raced the final shift starts the drain again.
      if (this.queue.length > 0) this.pump()
    }
  }

  /**
   * Replay durable history in `[fromSeq, toSeq]`, merged with the in-memory
   * tail so a record that failed to persist is still visible. Sorted by `seq`.
   */
  async read(fromSeq = 1, toSeq = Number.MAX_SAFE_INTEGER): Promise<JournalRecord[]> {
    const merged = new Map<number, JournalRecord>()
    for (const record of await this.journal.readPersisted(fromSeq)) {
      if (record.seq >= fromSeq && record.seq <= toSeq) merged.set(record.seq, record)
    }
    for (const record of this.journal.buffered(fromSeq)) {
      if (record.seq <= toSeq) merged.set(record.seq, record)
    }
    return [...merged.values()].sort((a, b) => a.seq - b.seq)
  }

  /** Unrecoverable intervals inside `[fromSeq, toSeq]`, from durable history. */
  async gaps(fromSeq: number, toSeq: number): Promise<{ from: number; to: number }[]> {
    const have = new Set((await this.read(fromSeq, toSeq)).map((record) => record.seq))
    const missing: number[] = []
    for (let seq = fromSeq; seq <= toSeq; seq++) if (!have.has(seq)) missing.push(seq)
    if (missing.length === 0) return []
    const ranges: { from: number; to: number }[] = []
    let start = missing[0]!
    let previous = start
    for (const seq of missing.slice(1)) {
      if (seq === previous + 1) {
        previous = seq
        continue
      }
      ranges.push({ from: start, to: previous })
      start = seq
      previous = seq
    }
    ranges.push({ from: start, to: previous })
    return ranges
  }

  /**
   * Replay from `cursor` (the last seq the consumer already has) then merge live
   * events, delivering each fragment exactly once in `seq` order. Overlap with
   * replay is suppressed by the high-water mark; an interval the bounded tail
   * can no longer supply is reported as a `gap` item. Returns an unsubscribe.
   */
  subscribe(cursor: number, sink: CoordinatorEventSink): () => void {
    const listener: Listener = { cursor: Math.max(0, Math.floor(cursor)), sink, active: true }
    this.listeners.add(listener)
    void this.runListener(listener)
    return () => {
      if (!listener.active) return
      listener.active = false
      this.listeners.delete(listener)
      this.signal()
    }
  }

  private async runListener(listener: Listener): Promise<void> {
    try {
      // Durability-first replay: everything persisted beyond the cursor. A read
      // failure simply yields no durable records; the live loop below then
      // surfaces whatever the in-memory tail still holds, or an explicit gap.
      let replayed: JournalRecord[] = []
      try {
        replayed = await this.journal.readPersisted(listener.cursor + 1)
      } catch {
        replayed = []
      }
      this.deliver(listener, replayed)

      while (listener.active) {
        const buffered = this.journal.buffered(listener.cursor + 1)
        if (buffered.length > 0) {
          this.deliver(listener, buffered)
          continue
        }
        // Nothing in the bounded tail. If the sequence has moved past the
        // cursor those records were evicted from memory (a slow consumer):
        // report one gap and jump forward so the consumer never spins.
        if (this.journal.sequence > listener.cursor) {
          const from = listener.cursor + 1
          const to = this.journal.sequence
          listener.cursor = to
          listener.sink({ kind: "gap", from, to })
          continue
        }
        await this.wait(listener)
      }
    } catch {
      // A subscriber loop never throws into the publisher; the listener simply
      // stops. The journal's own `status()` carries degradation.
      this.listeners.delete(listener)
    }
  }

  private deliver(listener: Listener, records: readonly JournalRecord[]): void {
    for (const record of records) {
      if (!listener.active) return
      // High-water mark: a record already covered by replay or a previous
      // batch is never delivered twice.
      if (record.seq <= listener.cursor) continue
      if (record.seq > listener.cursor + 1) {
        listener.sink({ kind: "gap", from: listener.cursor + 1, to: record.seq - 1 })
      }
      listener.cursor = record.seq
      listener.sink({ kind: "event", record })
    }
  }

  private signal(): void {
    for (const waiter of [...this.waiters]) waiter()
    this.waiters.clear()
  }

  private wait(listener: Listener): Promise<void> {
    return new Promise<void>((resolve) => {
      const waiter = () => {
        this.waiters.delete(waiter)
        resolve()
      }
      this.waiters.add(waiter)
      // A publish may have landed between the caller's check and this
      // registration; resolve immediately so the wakeup is never lost.
      if (!listener.active || this.journal.sequence > listener.cursor) waiter()
    })
  }

  /** Stop accepting work and detach subscribers. */
  close(): void {
    this.closed = true
    for (const listener of this.listeners) listener.active = false
    this.listeners.clear()
    this.queue.length = 0
    this.signal()
  }
}

/**
 * Follows a journal file another process appends to (the coordinator), for a
 * dashboard that cannot share the coordinator's in-memory read model. Reads
 * only the bytes appended since the last poll, waits for a partial trailing
 * line to complete, and delivers each record once in `seq` order, reporting
 * a skipped interval as a `gap`. A file that shrinks (replaced) is reread
 * from the start; the high-water mark still suppresses duplicates.
 */
export function followJournalFile(path: string, cursor: number, sink: CoordinatorEventSink, options: { pollMs?: number } = {}): () => void {
  const pollMs = options.pollMs ?? 250
  let offset = 0
  let pending = ""
  let last = Math.max(0, Math.floor(cursor))
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined

  const deliver = (line: string) => {
    let record: JournalRecord
    try {
      record = JSON.parse(line) as JournalRecord
    } catch {
      return
    }
    if (typeof record.seq !== "number" || record.seq <= last) return
    if (record.seq > last + 1) sink({ kind: "gap", from: last + 1, to: record.seq - 1 })
    last = record.seq
    sink({ kind: "event", record })
  }

  const poll = async () => {
    try {
      const size = (await stat(path)).size
      if (size < offset) {
        offset = 0
        pending = ""
      }
      if (size > offset) {
        const handle = await open(path, "r")
        try {
          const buffer = Buffer.alloc(size - offset)
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
          offset += bytesRead
          pending += buffer.subarray(0, bytesRead).toString("utf8")
        } finally {
          await handle.close()
        }
        const end = pending.lastIndexOf("\n")
        if (end !== -1) {
          const complete = pending.slice(0, end)
          pending = pending.slice(end + 1)
          for (const line of complete.split("\n")) if (active && line.length > 0) deliver(line)
        }
      }
    } catch {
      // Not written yet, or briefly unreadable: try again on the next poll.
    }
    if (active) {
      timer = setTimeout(() => void poll(), pollMs)
      timer.unref?.()
    }
  }
  void poll()
  return () => {
    active = false
    if (timer) clearTimeout(timer)
  }
}

/** A `CoordinatorEventSource` over a journal file, for a dashboard in another process. */
export function journalFileSource(path: string, options: { pollMs?: number } = {}): CoordinatorEventSource {
  return { subscribe: (cursor, sink) => followJournalFile(path, cursor, sink, options) }
}

// ---------------------------------------------------------------------------
// Neutral ProgressMessage <-> RunnerEvent translation
// ---------------------------------------------------------------------------

/**
 * The dashboard's live transcript vocabulary mapped onto the neutral events the
 * journal stores. Only the message channels the durable model understands are
 * translated; the caller keeps its own rendering for the rest.
 */
export function runnerEventFromProgressMessage(runner: RunnerId, attempt: number, message: ProgressMessage): RunnerEvent {
  switch (message.channel) {
    case "reasoning":
      return { type: "reasoning", runner, attempt, text: message.text, ...(message.partID ? { partId: message.partID } : {}) }
    case "response":
      return { type: "text", runner, attempt, text: message.text, ...(message.partID ? { partId: message.partID } : {}) }
    case "tool":
      return { type: "tool", runner, attempt, name: message.text }
    case "bash":
      // Kept as a transcript message so the shell marker renders as a shell line.
      return { type: "message", runner, attempt, channel: "bash", text: message.text, ...(message.partID ? { partId: message.partID } : {}) }
  }
}

/** The inverse of `runnerEventFromProgressMessage`; `undefined` for non-transcript events. */
export function progressMessageFromRunnerEvent(event: RunnerEvent): ProgressMessage | undefined {
  switch (event.type) {
    case "reasoning":
      return { channel: "reasoning", text: event.text, ...(event.partId ? { partID: event.partId } : {}) }
    case "text":
      return { channel: "response", text: event.text, ...(event.partId ? { partID: event.partId } : {}) }
    case "tool":
      return { channel: "tool", text: event.detail ? `${event.name}: ${event.detail}` : event.name }
    case "message":
      return { channel: event.channel, text: event.text, ...(event.partId ? { partID: event.partId } : {}) }
    default:
      return undefined
  }
}
