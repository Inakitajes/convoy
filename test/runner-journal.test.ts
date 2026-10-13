import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { RunnerJournal, type JournalStore } from "../src/runners/journal"

const attempt = { runId: "run-1", phase: "implement", attempt: 1 }
const text = (value: string) => ({ type: "text" as const, runner: "opencode" as const, attempt: 1, text: value })

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-journal-"))
  dirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("runner event journal", () => {
  test("assigns monotonic sequence numbers and persists them 0600", async () => {
    const dir = await tempDir()
    const path = join(dir, "events.ndjson")
    const journal = new RunnerJournal({ path })

    expect(await journal.append({ runner: "opencode", attempt, event: text("a") })).toBe(1)
    expect(await journal.append({ runner: "opencode", attempt, event: text("b") })).toBe(2)
    expect(journal.sequence).toBe(2)

    const persisted = await journal.readPersisted()
    expect(persisted.map((record) => record.seq)).toEqual([1, 2])
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test("drops duplicate native ids but keeps distinct ones", async () => {
    const journal = new RunnerJournal({ path: join(await tempDir(), "e.ndjson") })
    expect(await journal.append({ runner: "opencode", attempt, event: text("a"), nativeId: "n1" })).toBe(1)
    expect(await journal.append({ runner: "opencode", attempt, event: text("a again"), nativeId: "n1" })).toBeUndefined()
    expect(await journal.append({ runner: "opencode", attempt, event: text("b"), nativeId: "n2" })).toBe(2)
    expect(journal.sequence).toBe(2)
  })

  test("reads a persisted cursor and ignores a partial trailing line", async () => {
    const lines = [
      JSON.stringify({ seq: 1, runner: "opencode", attempt, at: 1, event: text("a") }),
      JSON.stringify({ seq: 2, runner: "opencode", attempt, at: 2, event: text("b") }),
      '{"seq":3,"runner":"opencode",at":3',
    ].join("\n")
    const store: JournalStore = { append: async () => {}, read: async () => lines }
    const journal = new RunnerJournal({ path: "ignored", store })

    expect((await journal.readPersisted()).map((record) => record.seq)).toEqual([1, 2])
    expect((await journal.readPersisted(2)).map((record) => record.seq)).toEqual([2])
  })

  test("bounds the in-memory buffer by record count", async () => {
    const journal = new RunnerJournal({ path: join(await tempDir(), "e.ndjson"), maxBufferRecords: 2 })
    for (const value of ["a", "b", "c", "d", "e"]) {
      await journal.append({ runner: "opencode", attempt, event: text(value) })
    }
    expect(journal.sequence).toBe(5)
    expect(journal.buffered().map((record) => record.seq)).toEqual([4, 5])
  })

  test("reports a gap when the buffer dropped records", async () => {
    const journal = new RunnerJournal({ path: join(await tempDir(), "e.ndjson"), maxBufferRecords: 1 })
    await journal.append({ runner: "opencode", attempt, event: text("a") })
    await journal.append({ runner: "opencode", attempt, event: text("b") })
    await journal.append({ runner: "opencode", attempt, event: text("c") })
    expect(journal.gaps(1, 3)).toEqual([{ from: 1, to: 2 }])
  })

  test("degrades on a persistence failure but still assigns a sequence", async () => {
    const store: JournalStore = {
      append: async () => {
        throw new Error("disk full")
      },
      read: async () => "",
    }
    const journal = new RunnerJournal({ path: "ignored", store })
    expect(await journal.append({ runner: "opencode", attempt, event: text("a") })).toBe(1)
    expect(journal.status()).toEqual({ degraded: true, reason: "disk full" })
  })
})
