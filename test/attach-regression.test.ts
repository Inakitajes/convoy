import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, expect, test } from "bun:test"

import { LiveAttach } from "../src/attach-runtime"
import { noopProgress, type ProgressPhaseSnapshot, type ProgressUI } from "../src/progress"

import type { AdvisorEvent } from "../src/advisor-events"
import type { OpencodeClient } from "../src/opencode-client"

const dirs: string[] = []

afterAll(async () => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))))

test("live attachment replays the authoritative advisor journal before metadata catches up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "convoy-live-attach-regression-"))
  dirs.push(dir)
  const event: AdvisorEvent = {
    id: "evt-1",
    type: "advisor.requested",
    timestamp: new Date(0).toISOString(),
    callId: "call-1",
    phase: "build",
    attempt: 1,
    trigger: "first-write",
    budget: { used: 1, max: 3 },
    model: "anthropic/opus",
  }
  await mkdir(join(dir, "events"))
  await writeFile(join(dir, "events", "advisor.jsonl"), `${JSON.stringify(event)}\n`)
  await writeFile(
    join(dir, "metadata.json"),
    JSON.stringify({
      schemaVersion: 3,
      runID: "20260101-000000-test",
      targetDir: "/repo",
      createdAt: 0,
      updatedAt: 0,
      control: { state: "running" },
      phases: { build: { status: "running" } },
    }),
  )

  const started: string[] = []
  const received: AdvisorEvent[] = []
  const restored: ProgressPhaseSnapshot[] = []
  const progress: ProgressUI = {
    ...noopProgress,
    phaseStarted: (name) => started.push(name),
    phaseAdvisorEvent: (_name, advisorEvent) => received.push(advisorEvent),
    phaseRestored: (_name, snapshot) => restored.push(snapshot),
  }
  const attach = new LiveAttach({} as OpencodeClient, progress, "/repo", join(dir, "metadata.json"))

  await attach.start()
  await writeFile(
    join(dir, "metadata.json"),
    JSON.stringify({
      schemaVersion: 3,
      runID: "20260101-000000-test",
      targetDir: "/repo",
      createdAt: 0,
      updatedAt: 1,
      control: { state: "running" },
      phases: { build: { status: "completed" } },
    }),
  )
  for (let attempt = 0; attempt < 30 && restored.length === 0; attempt++) await Bun.sleep(50)
  await attach.stop()

  expect(started).toEqual(["build"])
  expect(received).toEqual([event])
  expect(restored).toMatchObject([{ status: "completed", advisorEvents: [event], advisor: { attempted: 1 } }])
})
