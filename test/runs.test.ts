import { createServer, type Server } from "node:net"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { isServerLive, listRuns } from "../src/runs"

function listen(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("no port"))
      resolve({ port: address.port, close: () => server.close() })
    })
  })
}

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "convoy-runs-test-"))

  // Newer run with metadata: gets targetDir, phase summary, and cost.
  const newer = join(root, "20260610-120000-bbbb")
  await mkdir(newer, { recursive: true })
  await writeFile(join(newer, "prd.md"), "# Add onboarding\n\ndetails\n")
  await writeFile(
    join(newer, "metadata.json"),
    JSON.stringify({
      schemaVersion: 1,
      runID: "20260610-120000-bbbb",
      targetDir: "/tmp/repo",
      createdAt: 1,
      updatedAt: 2,
      phases: {
        implementer: { status: "completed", cost: 1.25 },
        tests: { status: "failed", cost: 0.25 },
      },
    }),
  )

  // Older run from before metadata.json existed.
  await mkdir(join(root, "20260601-090000-aaaa"), { recursive: true })

  // Not a run ID; must be ignored.
  await mkdir(join(root, "not-a-run"), { recursive: true })
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("run history listing", () => {
  test("lists valid runs newest first with metadata details", async () => {
    const runs = await listRuns(root)

    expect(runs.map((run) => run.runID)).toEqual(["20260610-120000-bbbb", "20260601-090000-aaaa"])

    const [newer, older] = runs
    expect(newer!.dir).toBe(join(root, "20260610-120000-bbbb"))
    expect(newer!.title).toBe("Add onboarding")
    expect(newer!.targetDir).toBe("/tmp/repo")
    expect(newer!.status).toBe("failed (1/2 ok)")
    expect(newer!.cost).toBeCloseTo(1.5)

    expect(older!.title).toBe("(no prd)")
    expect(older!.targetDir).toBeUndefined()
    expect(older!.status).toBe("-")
    expect(older!.cost).toBeUndefined()
  })

  test("returns empty for a missing root", async () => {
    expect(await listRuns(join(root, "does-not-exist"))).toEqual([])
  })

  test("runs without a live server entry are not live", async () => {
    const [newer] = await listRuns(root)
    expect(newer!.live).toBe(false)
    expect(newer!.serverUrl).toBeUndefined()
  })
})

describe("run liveness detection", () => {
  test("no server entry is never live", async () => {
    expect(await isServerLive(undefined)).toBe(false)
  })

  test("a dead process is not live", async () => {
    const proc = Bun.spawn(["true"])
    await proc.exited
    expect(await isServerLive({ url: "http://127.0.0.1:59999", pid: proc.pid, startedAt: Date.now() })).toBe(false)
  })

  test("an alive process whose port isn't listening is not live", async () => {
    // Nothing is bound here, so the TCP probe must fail even though the pid is alive.
    expect(await isServerLive({ url: "http://127.0.0.1:1", pid: process.pid, startedAt: Date.now() })).toBe(false)
  })

  test("an alive process with a listening port is live", async () => {
    const server = await listen()
    try {
      expect(await isServerLive({ url: `http://127.0.0.1:${server.port}`, pid: process.pid, startedAt: Date.now() })).toBe(true)
    } finally {
      server.close()
    }
  })
})
