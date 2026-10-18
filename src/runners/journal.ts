/**
 * Durable normalized event journal (change `runner-parity-opencode-v2`, design D6).
 *
 * The coordinator publishes runner-neutral events with a durable, monotonic
 * Convoy sequence number, persists them append-only, and keeps a bounded
 * in-memory tail so a lagging dashboard can replay without blocking the upstream
 * event intake.
 *
 * Guarantees:
 *  - monotonically increasing `seq` per run, assigned before publication;
 *  - attempt-qualified records (`runId` / `phase` / `attempt` / `runner`);
 *  - duplicate native ids are dropped (stream reconnects must not duplicate);
 *  - the on-disk file is `0600` and its directory `0700`;
 *  - a partial final line (crash mid-write) is ignored on read;
 *  - the in-memory buffer is bounded by record count and bytes;
 *  - a persistence failure degrades the journal (reported as incomplete) rather
 *    than silently claiming completeness.
 */

import { mkdir, open, readFile } from "node:fs/promises"
import { dirname } from "node:path"

import type { RunnerEvent, RunnerId } from "./contracts"

export type JournalAttempt = {
  runId: string
  phase: string
  attempt: number
}

export type JournalRecord = {
  seq: number
  runner: RunnerId
  attempt: JournalAttempt
  /** Wall-clock time the coordinator recorded the event. */
  at: number
  /** Native harness id, retained for dedup; never parsed. */
  nativeId?: string
  event: RunnerEvent
}

export type JournalStatus = { degraded: false } | { degraded: true; reason: string }

/** Filesystem seam so disk-failure behavior is testable. */
export type JournalStore = {
  append(path: string, line: string): Promise<void>
  read(path: string): Promise<string>
}

export type JournalOptions = {
  /** Absolute path of the journal file. */
  path: string
  maxBufferRecords?: number
  maxBufferBytes?: number
  now?: () => number
  store?: JournalStore
}

const defaultMaxBufferRecords = 2_000
const defaultMaxBufferBytes = 4 * 1024 * 1024

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
}

const defaultStore: JournalStore = {
  async append(path, line) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const handle = await open(path, "a", 0o600)
    try {
      await handle.write(line)
    } finally {
      await handle.close()
    }
  },
  async read(path) {
    try {
      return await readFile(path, "utf8")
    } catch (error) {
      if (isEnoent(error)) return ""
      throw error
    }
  },
}

export type AppendInput = {
  runner: RunnerId
  attempt: JournalAttempt
  event: RunnerEvent
  nativeId?: string
}

export class RunnerJournal {
  private readonly path: string
  private readonly store: JournalStore
  private readonly now: () => number
  private readonly maxBufferRecords: number
  private readonly maxBufferBytes: number
  private readonly buffer: JournalRecord[] = []
  private readonly seen = new Map<string, number>()
  private bufferedBytes = 0
  private lastSeq = 0
  private degradedReason: string | undefined

  constructor(options: JournalOptions) {
    this.path = options.path
    this.store = options.store ?? defaultStore
    this.now = options.now ?? Date.now
    this.maxBufferRecords = options.maxBufferRecords ?? defaultMaxBufferRecords
    this.maxBufferBytes = options.maxBufferBytes ?? defaultMaxBufferBytes
  }

  /** The highest sequence number assigned so far. */
  get sequence(): number {
    return this.lastSeq
  }

  /**
   * Continues the sequence of records already on disk, so a resumed
   * coordinator never reuses a `seq` a follower has already consumed. A file
   * that cannot be read leaves the sequence where it is.
   */
  async restore(): Promise<void> {
    let text: string
    try {
      text = await this.store.read(this.path)
    } catch {
      return
    }
    for (const line of text.split("\n")) {
      try {
        const seq = (JSON.parse(line) as { seq?: unknown }).seq
        if (typeof seq === "number" && seq > this.lastSeq) this.lastSeq = seq
      } catch {
        // A partial or malformed line carries no usable sequence.
      }
    }
  }

  status(): JournalStatus {
    return this.degradedReason === undefined ? { degraded: false } : { degraded: true, reason: this.degradedReason }
  }

  private dedupeKey(input: AppendInput): string | undefined {
    if (!input.nativeId) return undefined
    return `${input.attempt.runId}:${input.attempt.phase}:${input.attempt.attempt}:${input.runner}:${input.nativeId}`
  }

  /**
   * Assign the next sequence number, publish, and persist. Returns the record's
   * `seq`, or `undefined` when the event was dropped as a duplicate. A
   * persistence failure degrades the journal and still returns the assigned
   * `seq` so in-memory consumers are not blocked.
   */
  async append(input: AppendInput): Promise<number | undefined> {
    const key = this.dedupeKey(input)
    if (key && this.seen.has(key)) return undefined

    const record: JournalRecord = {
      seq: ++this.lastSeq,
      runner: input.runner,
      attempt: input.attempt,
      at: this.now(),
      ...(input.nativeId ? { nativeId: input.nativeId } : {}),
      event: input.event,
    }
    if (key) this.seen.set(key, record.seq)
    this.push(record)

    try {
      await this.store.append(this.path, `${JSON.stringify(record)}\n`)
    } catch (error) {
      this.degradedReason = error instanceof Error ? error.message : String(error)
    }
    return record.seq
  }

  private push(record: JournalRecord): void {
    this.buffer.push(record)
    this.bufferedBytes += Buffer.byteLength(JSON.stringify(record), "utf8")
    while (this.buffer.length > this.maxBufferRecords || (this.bufferedBytes > this.maxBufferBytes && this.buffer.length > 1)) {
      const dropped = this.buffer.shift()
      if (!dropped) break
      this.bufferedBytes -= Buffer.byteLength(JSON.stringify(dropped), "utf8")
    }
    // Bound the dedupe index alongside the buffer so a long stream cannot grow
    // memory without limit.
    if (this.seen.size > this.maxBufferRecords * 2) {
      for (const [oldKey] of this.seen) {
        this.seen.delete(oldKey)
        if (this.seen.size <= this.maxBufferRecords) break
      }
    }
  }

  /** In-memory records with `seq >= fromSeq` (bounded, newest-kept). */
  buffered(fromSeq = 1): JournalRecord[] {
    return this.buffer.filter((record) => record.seq >= fromSeq)
  }

  /** Errors that left the journal with lost history (empty when healthy). */
  gaps(fromSeq: number, toSeq: number): { from: number; to: number }[] {
    const have = new Set(this.buffer.map((record) => record.seq))
    const missing: number[] = []
    for (let seq = fromSeq; seq <= toSeq; seq++) if (!have.has(seq)) missing.push(seq)
    if (missing.length === 0) return []
    return [{ from: missing[0]!, to: missing[missing.length - 1]! }]
  }

  /**
   * Read persisted records, tolerating a partial trailing line from a crash.
   * A malformed complete line is surfaced as an error rather than dropped
   * silently.
   */
  async readPersisted(fromSeq = 1): Promise<JournalRecord[]> {
    const text = await this.store.read(this.path)
    const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1)
    const records: JournalRecord[] = []
    for (const line of complete.split("\n")) {
      if (line.length === 0) continue
      const parsed = JSON.parse(line) as JournalRecord
      if (parsed.seq >= fromSeq) records.push(parsed)
    }
    return records
  }
}
