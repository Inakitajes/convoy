import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { openRunMetadata, readRunMetadata } from "../src/metadata"
import { defaultPipeline } from "../src/pipeline"
import type { Pipeline } from "../src/types"
import type { Workspace } from "../src/workspace"

const dirs: string[] = []

async function workspace(): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), "archer-metadata-"))
  dirs.push(dir)
  return { dir, runID: "20260612-103045-ab12" }
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const quick: Pipeline = {
  name: "quick",
  steps: [
    {
      type: "agent",
      name: "implementer",
      agentName: "implementer",
      description: "Implements",
      model: "openai/gpt-5.5",
      variant: "xhigh",
      inputFiles: ["prd.md"],
      inputDiff: false,
      reportPath: "reports/implementer.md",
      groupId: "g1",
      stepName: "implementer",
    },
  ],
}

describe("run metadata", () => {
  test("the first open freezes the pipeline; later opens replay it", async () => {
    const ws = await workspace()

    const first = await openRunMetadata(ws, "/repo", quick)
    expect(first.pipeline.name).toBe("quick")
    await first.flush()

    // A resume passes whatever the config resolves to today; the frozen
    // pipeline must win.
    const resumed = await openRunMetadata(ws, "/repo", defaultPipeline())
    expect(resumed.pipeline.name).toBe("quick")
    expect(resumed.pipeline.steps).toHaveLength(1)
  })

  test("records the live server and clears it on shutdown", async () => {
    const ws = await workspace()
    const store = await openRunMetadata(ws, "/repo", quick)

    store.serverStarted("http://127.0.0.1:4096")
    await store.flush()
    let saved = await readRunMetadata(join(ws.dir, "metadata.json"))
    expect(saved?.server?.url).toBe("http://127.0.0.1:4096")
    expect(saved?.server?.pid).toBe(process.pid)

    // Cleared on shutdown, so a lingering entry can only mean the run crashed.
    store.serverStopped()
    await store.flush()
    saved = await readRunMetadata(join(ws.dir, "metadata.json"))
    expect(saved?.server).toBeUndefined()
  })

  test("persists as schemaVersion 2 and still reads v1 metadata", async () => {
    const ws = await workspace()
    const store = await openRunMetadata(ws, "/repo", quick)
    await store.flush()

    const path = join(ws.dir, "metadata.json")
    const persisted = JSON.parse(await readFile(path, "utf8"))
    expect(persisted.schemaVersion).toBe(2)
    expect(persisted.pipeline.name).toBe("quick")

    // v1 runs predate the frozen pipeline; they read fine without one.
    await Bun.write(path, JSON.stringify({ ...persisted, schemaVersion: 1, pipeline: undefined }))
    const v1 = await readRunMetadata(path)
    expect(v1?.schemaVersion).toBe(2)
    expect(v1?.pipeline).toBeUndefined()

    const adopted = await openRunMetadata(ws, "/repo", defaultPipeline())
    expect(adopted.pipeline.name).toBe("implement")
  })
})
