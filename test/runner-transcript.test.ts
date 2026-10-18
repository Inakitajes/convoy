import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { RunnerJournal } from "../src/runners/journal"
import { findGaps, readRunTranscript } from "../src/runners/transcript"

const dirs: string[] = []
async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-transcript-"))
  dirs.push(dir)
  return join(dir, "events.ndjson")
}
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const attempt = { runId: "r", phase: "p", attempt: 1 }
const text = (value: string) => ({ type: "text" as const, runner: "opencode" as const, attempt: 1, text: value })

describe("offline run transcript", () => {
  test("reads captured records without a harness", async () => {
    const path = await tempPath()
    const journal = new RunnerJournal({ path })
    await journal.append({ runner: "opencode", attempt, event: text("a") })
    await journal.append({ runner: "opencode", attempt, event: text("b") })

    const transcript = await readRunTranscript(path)
    expect(transcript.hasHistory).toBe(true)
    expect(transcript.complete).toBe(true)
    expect(transcript.records.map((record) => record.seq)).toEqual([1, 2])
  })

  test("a missing journal is an honest empty result", async () => {
    const transcript = await readRunTranscript(join(await tempPath(), "does-not-exist.ndjson"))
    expect(transcript).toEqual({ records: [], hasHistory: false, complete: false, gaps: [] })
  })

  test("reports a sequence gap instead of claiming completeness", async () => {
    const path = await tempPath()
    const line = (seq: number, value: string) =>
      JSON.stringify({ seq, runner: "opencode", attempt, at: seq, event: text(value) })
    await writeFile(path, `${line(1, "a")}\n${line(3, "c")}\n`)

    const transcript = await readRunTranscript(path)
    expect(transcript.gaps).toEqual([{ from: 2, to: 2 }])
    expect(transcript.complete).toBe(false)
    expect(transcript.hasHistory).toBe(true)
  })

  test("findGaps computes contiguous holes", () => {
    expect(findGaps([1, 2, 3])).toEqual([])
    expect(findGaps([1, 4, 5, 9])).toEqual([
      { from: 2, to: 3 },
      { from: 6, to: 8 },
    ])
  })
})
