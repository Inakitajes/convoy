import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

/**
 * Isolated subprocess regression for the coordinator finish hold (change
 * fix-opencode-server-lifecycle, design D7 / spec R4).
 *
 * The fixture runs the production `runCoordinateBoot` with the real
 * SIGINT/SIGTERM/SIGHUP scope installed and owns a real managed `serve` child.
 * A real signal delivered while the finish hold is parked must release the
 * hold and run the bounded owned-server stop with an observed child exit. The
 * fixture runs in its own process so the signal never reaches the test runner.
 */

const dirs: string[] = []
const spawned = new Set<number>()

afterAll(async () => {
  for (const pid of spawned) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      /* already gone */
    }
  }
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-hold-"))
  dirs.push(dir)
  return dir
}

const READY_LINE = 'console.log("opencode server listening on http://127.0.0.1:1")\n'

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await Bun.sleep(25)
  }
  return !pidAlive(pid)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Runs the fixture, parks its finish hold, delivers a real signal, and asserts the observed stop. */
async function runFinishHold(signal: number): Promise<void> {
  const dir = await scratchDir()
  const childScript = join(dir, "hold-child.js")
  await writeFile(childScript, `${READY_LINE}setInterval(() => {}, 1000)\n`)
  const storeDir = join(dir, "processes")
  const recordPath = join(dir, "record.json")
  const holdingPath = join(dir, "holding")
  const pidPath = join(dir, "child.pid")
  const fixture = join(import.meta.dir, "fixtures", "coordinator-hold-fixture.ts")

  const proc = Bun.spawn([process.execPath, fixture, childScript, storeDir, recordPath, holdingPath, pidPath], {
    cwd: process.cwd(),
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, CONVOY_HOME: join(dir, "home") },
  })
  if (proc.pid) spawned.add(proc.pid)

  const drainStderr = async () => new Response(proc.stderr).text().catch(() => "")

  try {
    // Wait until the finish hold is parked and the owned child is running.
    const deadline = Date.now() + 15_000
    while (!(await fileExists(holdingPath)) && Date.now() < deadline) await Bun.sleep(25)
    if (!(await fileExists(holdingPath))) {
      proc.kill(9)
      throw new Error(`fixture never parked its finish hold. stderr: ${await drainStderr()}`)
    }

    const childPid = Number(await readFile(pidPath, "utf8"))
    expect(childPid).toBeGreaterThan(0)
    spawned.add(childPid)
    expect(pidAlive(childPid)).toBe(true)

    // The real signal the coordinator's owner scope must answer.
    proc.kill(signal)
    const code = await proc.exited
    if (code !== 0) throw new Error(`fixture exited with ${code}. stderr: ${await drainStderr()}`)

    const record = JSON.parse(await readFile(recordPath, "utf8")) as { pid: number; outcome: { status: string } }
    expect(record.pid).toBe(childPid)
    // A delivered signal is not a stop; the outcome is recorded only after the
    // bounded stop confirms the child exited.
    expect(record.outcome.status).toBe("stopped")
    expect(await waitForExit(childPid)).toBe(true)
  } finally {
    proc.kill(9)
    const childPid = await readFile(pidPath, "utf8")
      .then(Number)
      .catch(() => 0)
    if (Number.isFinite(childPid) && childPid > 0) {
      try {
        process.kill(childPid, "SIGKILL")
      } catch {
        /* gone */
      }
    }
  }
}

describe("coordinator finish-hold subprocess", () => {
  test("a real SIGTERM during the finish hold stops the owned child and observes its exit", async () => {
    await runFinishHold(15)
  }, 30_000)

  test("a real SIGHUP during the finish hold stops the owned child and observes its exit", async () => {
    await runFinishHold(1)
  }, 30_000)
})
