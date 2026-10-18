import { afterAll, describe, expect, test } from "bun:test"
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LiveAttach, replayJournal } from "../src/attach-runtime"
import { ControlPendingQueue, type ControlServer } from "../src/control-server"
import { ControlProgress } from "../src/control-progress"
import { noopProgress, type ActivityKind, type ProgressMessage, type ProgressPhase, type ProgressUI } from "../src/progress"
import { coordinatorJournalPath, CoordinatorEvents, followJournalFile, type CoordinatorEventItem } from "../src/runners/coordinator-events"
import type { Pipeline } from "../src/types"

// Production wiring of the durable transcript journal (design D6): the
// coordinator's ControlProgress — built exactly as coordinate.ts builds it —
// journals every runner's phase output into the run dir, and a dashboard in
// another process follows that file. Neither side needs an OpenCode server.

const dirs: string[] = []
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-journal-wiring-"))
  dirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

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

async function until(ready: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await ready()) return true
    await Bun.sleep(5)
  }
  return ready()
}

const pipeline = { name: "mixed", steps: [] } as unknown as Pipeline
const phases: ProgressPhase[] = [
  { name: "implement", description: "", kind: "step", runner: "claude-code" },
  { name: "review", description: "", kind: "step" },
]

type Rendered = { messages: Record<string, ProgressMessage[]>; activity: Record<string, string[]>; tui: ProgressUI }
function recordingTui(): Rendered {
  const messages: Record<string, ProgressMessage[]> = {}
  const activity: Record<string, string[]> = {}
  const tui: ProgressUI = {
    ...noopProgress,
    phaseMessage: (name, message) => {
      ;(messages[name] ??= []).push(message)
    },
    phaseActivity: (name: string, detail: string, _kind?: ActivityKind) => {
      ;(activity[name] ??= []).push(detail)
    },
  }
  return { messages, activity, tui }
}

describe("coordinator journal wiring", () => {
  test("the coordinator's progress journals each phase under its own runner, in the run dir", async () => {
    const runDir = await scratch()
    const progress = new ControlProgress({ server: fakeControlServer() })
    progress.resetPipeline(phases, { runID: "run-1", targetDir: runDir, runDir, pipeline })
    progress.start("run-1", runDir, runDir)
    progress.phaseAttempt("implement", { attempt: 2, model: "sonnet" })
    progress.phaseMessage("implement", { channel: "response", text: "hello", partID: "t1" })
    progress.phaseActivity("implement", "edit src/a.ts", "tool")
    progress.phaseMessage("review", { channel: "bash", text: "bun test" })
    await progress.flushEvents()

    const path = coordinatorJournalPath(runDir)
    const records = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    expect(records.map((record) => [record.attempt.phase, record.runner, record.event.type])).toEqual([
      ["implement", "claude-code", "text"],
      ["implement", "claude-code", "activity"],
      ["review", "opencode", "message"],
    ])
    expect(records[0].attempt).toEqual({ runId: "run-1", phase: "implement", attempt: 2 })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test("a resumed coordinator continues the journal's sequence instead of restarting it", async () => {
    const runDir = await scratch()
    const first = new CoordinatorEvents({ path: coordinatorJournalPath(runDir) })
    await first.publish({ runId: "run-1", phase: "implement", event: { type: "text", runner: "claude-code", attempt: 1, text: "a" } })
    await first.publish({ runId: "run-1", phase: "implement", event: { type: "text", runner: "claude-code", attempt: 1, text: "b" } })
    const resumed = new CoordinatorEvents({ path: coordinatorJournalPath(runDir) })
    expect(await resumed.publish({ runId: "run-1", phase: "implement", event: { type: "text", runner: "claude-code", attempt: 2, text: "c" } })).toBe(3)
  })

  test("a dashboard process follows the journal file incrementally, reporting gaps", async () => {
    const runDir = await scratch()
    const path = coordinatorJournalPath(runDir)
    const writer = new CoordinatorEvents({ path })
    const items: CoordinatorEventItem[] = []
    const stop = followJournalFile(path, 0, (item) => items.push(item), { pollMs: 5 })
    try {
      await writer.publish({ runId: "r", phase: "p", event: { type: "text", runner: "claude-code", attempt: 1, text: "one" } })
      expect(await until(() => items.length === 1)).toBe(true)
      // A record lost to a crash between two good ones is an explicit gap; a
      // partial trailing line waits until it is complete.
      await appendFile(path, `${JSON.stringify({ seq: 3, runner: "claude-code", attempt: { runId: "r", phase: "p", attempt: 1 }, at: 0, event: { type: "text", runner: "claude-code", attempt: 1, text: "three" } })}\n{"seq":4,`)
      expect(await until(() => items.length === 3)).toBe(true)
      expect(items[1]).toEqual({ kind: "gap", from: 2, to: 2 })
      await appendFile(path, `"runner":"claude-code","attempt":{"runId":"r","phase":"p","attempt":1},"at":0,"event":{"type":"text","runner":"claude-code","attempt":1,"text":"four"}}\n`)
      expect(await until(() => items.length === 4)).toBe(true)
      expect(items.flatMap((item) => (item.kind === "event" ? [item.record.seq] : []))).toEqual([1, 3, 4])
    } finally {
      stop()
    }
  })

  test("a live dashboard without an OpenCode server streams a Claude phase from the journal", async () => {
    const runDir = await scratch()
    const metaPath = join(runDir, "metadata.json")
    await writeFile(metaPath, JSON.stringify({ phases: { implement: { status: "running" } } }))
    const writer = new CoordinatorEvents({ path: coordinatorJournalPath(runDir) })
    const { messages, activity, tui } = recordingTui()
    // No OpenCode client at all: the run is Claude-only.
    const attach = new LiveAttach(undefined, tui, runDir, metaPath, new Set(["implement"]), 10, followJournalSource(coordinatorJournalPath(runDir)))
    try {
      await attach.start()
      await writer.publish({ runId: "r", phase: "implement", event: { type: "message", runner: "claude-code", attempt: 1, channel: "response", text: "hi", partId: "t1" } })
      await writer.publish({ runId: "r", phase: "implement", event: { type: "activity", runner: "claude-code", attempt: 1, message: "edit a.ts", kind: "tool" } })
      expect(await until(() => (messages.implement?.length ?? 0) === 1 && (activity.implement?.length ?? 0) === 1)).toBe(true)
      expect(messages.implement).toEqual([{ channel: "response", text: "hi", partID: "t1" }])
      expect(activity.implement).toEqual(["edit a.ts"])
    } finally {
      await attach.stop()
    }
  })

  test("a stopped run's journal with a hole is replayed with an explicit gap marker", async () => {
    const runDir = await scratch()
    const path = coordinatorJournalPath(runDir)
    const line = (seq: number, text: string) => `${JSON.stringify({ seq, runner: "claude-code", attempt: { runId: "r", phase: "implement", attempt: 1 }, at: 0, event: { type: "text", runner: "claude-code", attempt: 1, text } })}\n`
    await mkdir(join(runDir, "events"), { recursive: true })
    await writeFile(path, line(1, "before") + line(4, "after"))
    const notices: string[] = []
    const { messages, tui } = recordingTui()
    await replayJournal({ ...tui, message: (text) => void notices.push(text) }, runDir, new Set(["implement"]))
    expect(messages.implement?.map((message) => message.text)).toEqual(["before", "after"])
    expect(notices).toEqual(["transcript incomplete: events 2–3 were not captured"])
  })

  test("a phase with native live attach keeps its own stream, so the journal never doubles it", async () => {
    const runDir = await scratch()
    const writer = new CoordinatorEvents({ path: coordinatorJournalPath(runDir) })
    await writer.publish({ runId: "r", phase: "review", event: { type: "text", runner: "opencode", attempt: 1, text: "native" } })
    await writer.publish({ runId: "r", phase: "implement", event: { type: "text", runner: "claude-code", attempt: 1, text: "journal" } })
    const { messages, tui } = recordingTui()
    await replayJournal(tui, runDir, new Set(["implement"]))
    expect(messages).toEqual({ implement: [{ channel: "response", text: "journal" }] })
  })
})

function followJournalSource(path: string) {
  return { subscribe: (cursor: number, sink: (item: CoordinatorEventItem) => void) => followJournalFile(path, cursor, sink, { pollMs: 5 }) }
}
