import { spawn as rawSpawn } from "node:child_process"
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { launchManagedServer } from "../src/managed-server"
import { captureIdentity, defaultIdentityProbe, type IdentityProbe } from "../src/process-identity"
import { createProcessRecordStore, newProcessRecord, reconcileProcessRecords } from "../src/process-records"
import { RunShutdown } from "../src/runner"

/**
 * Real-OS subprocess fixtures (change fix-opencode-server-lifecycle, D7).
 *
 * These children are plain local scripts: they never read OpenCode config, use
 * model credentials, or match a broad process scan. Every spawned PID is
 * tracked and killed in teardown even when an assertion fails.
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
  const dir = await mkdtemp(join(tmpdir(), "convoy-subprocess-"))
  dirs.push(dir)
  return dir
}

function track(pid: number | undefined): number {
  if (pid) spawned.add(pid)
  return pid ?? 0
}

/** Reads the readiness line the managed launcher waits for. */
const READY_LINE = 'console.log("opencode server listening on http://127.0.0.1:1")\n'

async function fixtureScript(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, `${name}.js`)
  await writeFile(path, body)
  return path
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await Bun.sleep(25)
  }
  return !pidAlive(pid)
}

describe("owned subprocess lifecycle", () => {
  test("terminates a real child and observes the exit", async () => {
    const dir = await scratchDir()
    const script = await fixtureScript(dir, "normal", `${READY_LINE}setInterval(() => {}, 1000)\n`)
    const store = createProcessRecordStore(join(dir, "processes"))
    const server = await launchManagedServer({
      command: process.execPath,
      args: [script],
      cwd: dir,
      env: {},
      lifetime: "helper",
      label: "fixture helper",
      timeoutMs: 5_000,
      deps: { store, policy: { graceMs: 2_000, forceObservationMs: 1_000 } },
    })
    track(server.pid)
    expect(server.url).toBe("http://127.0.0.1:1")
    expect(pidAlive(server.pid)).toBe(true)

    const outcome = await server.stop()
    expect(outcome.status).toBe("stopped")
    expect(await waitForExit(server.pid)).toBe(true)
    // The record of a confirmed stop is removed.
    expect(await store.list()).toEqual([])
  }, 15_000)

  test("escalates to SIGKILL for a child that ignores SIGTERM", async () => {
    const dir = await scratchDir()
    const script = await fixtureScript(
      dir,
      "stubborn",
      `${READY_LINE}process.on("SIGTERM", () => {})\nsetInterval(() => {}, 1000)\n`,
    )
    const store = createProcessRecordStore(join(dir, "processes"))
    const server = await launchManagedServer({
      command: process.execPath,
      args: [script],
      cwd: dir,
      env: {},
      lifetime: "helper",
      label: "fixture helper",
      timeoutMs: 5_000,
      deps: { store, policy: { graceMs: 300, forceObservationMs: 2_000 } },
    })
    track(server.pid)
    const outcome = await server.stop()
    expect(outcome).toEqual({ status: "stopped", via: "forced" })
    expect(await waitForExit(server.pid)).toBe(true)
  }, 15_000)

  test("a later reconciliation pass stops a real orphan whose owner is gone", async () => {
    const dir = await scratchDir()
    const script = await fixtureScript(dir, "orphan", `${READY_LINE}setInterval(() => {}, 1000)\n`)
    const probe: IdentityProbe = defaultIdentityProbe()

    // A real, already-dead owner: spawn and reap a short-lived process.
    const deadOwner = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" })
    const deadOwnerPid = track(deadOwner.pid)
    await deadOwner.exited
    const ownerIdentity = await captureIdentity(deadOwnerPid, probe)
    expect(ownerIdentity).toBeUndefined()

    // The orphan child is a real live process; its old owner PID is provably gone.
    const orphan = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "ignore" })
    const orphanPid = track(orphan.pid)
    const childIdentity = await captureIdentity(orphanPid, probe)
    expect(childIdentity).toBeDefined()

    const store = createProcessRecordStore(join(dir, "processes"))
    await store.put({
      ...newProcessRecord({ lifetime: "run" }),
      // Reuse the dead PID as the recorded owner: the probe reports `gone`.
      owner: { pid: deadOwnerPid, birth: "gone", uid: childIdentity!.uid, executable: "bun" },
      child: childIdentity!,
      state: "ready",
    })

    const outcome = await reconcileProcessRecords({ store, probe, policy: { graceMs: 2_000, forceObservationMs: 1_000, pollMs: 25 } })
    expect(outcome.stopped.length).toBe(1)
    expect(await waitForExit(orphanPid)).toBe(true)
  }, 20_000)

  test("reconciliation leaves a live owner's child untouched", async () => {
    const dir = await scratchDir()
    const script = await fixtureScript(dir, "owned", `${READY_LINE}setInterval(() => {}, 1000)\n`)
    const probe: IdentityProbe = defaultIdentityProbe()

    const owner = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" })
    const ownerPid = track(owner.pid)
    const ownerIdentity = await captureIdentity(ownerPid, probe)
    expect(ownerIdentity).toBeDefined()

    const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "ignore" })
    const childPid = track(child.pid)
    const childIdentity = await captureIdentity(childPid, probe)
    expect(childIdentity).toBeDefined()

    const store = createProcessRecordStore(join(dir, "processes"))
    await store.put({ ...newProcessRecord({ lifetime: "run" }), owner: ownerIdentity!, child: childIdentity!, state: "ready" })

    const outcome = await reconcileProcessRecords({ store, probe })
    expect(outcome.stopped).toEqual([])
    expect(pidAlive(childPid)).toBe(true)
    expect(pidAlive(ownerPid)).toBe(true)
    owner.kill("SIGKILL")
    child.kill("SIGKILL")
  }, 20_000)
})

describe("owned subprocess force edge and startup race", () => {
  test("the force edge kills a real child that ignores SIGTERM", async () => {
    const dir = await scratchDir()
    const script = await fixtureScript(
      dir,
      "stubborn-force",
      `${READY_LINE}process.on("SIGTERM", () => {})\nsetInterval(() => {}, 1000)\n`,
    )
    const store = createProcessRecordStore(join(dir, "processes"))
    const server = await launchManagedServer({
      command: process.execPath,
      args: [script],
      cwd: dir,
      env: {},
      lifetime: "helper",
      label: "fixture helper",
      timeoutMs: 5_000,
      deps: { store, policy: { graceMs: 5_000, forceObservationMs: 1_000 } },
    })
    track(server.pid)
    expect(pidAlive(server.pid)).toBe(true)
    // The synchronous last-resort edge a repeated abort/deadline delivers.
    server.forceStop()
    expect(await waitForExit(server.pid)).toBe(true)
    const outcome = await server.stop()
    expect(outcome.status).toBe("stopped")
  }, 15_000)

  test("a helper that exits before readiness fails with bounded cleanup and no lingering record", async () => {
    const dir = await scratchDir()
    const script = await fixtureScript(dir, "early-exit", "process.exit(3)\n")
    const store = createProcessRecordStore(join(dir, "processes"))
    // The managed launcher owns the child from spawn: a helper that dies before
    // reporting a URL must reject with a bounded cleanup outcome and leave no
    // record behind (design D1, spec R2 "Startup fails after spawning").
    await expect(
      launchManagedServer({
        command: process.execPath,
        args: [script],
        cwd: dir,
        env: {},
        lifetime: "helper",
        label: "fixture helper",
        timeoutMs: 5_000,
        deps: { store, policy: { graceMs: 500, forceObservationMs: 500 } },
      }),
    ).rejects.toThrow(/exited before it was ready/)
    expect(await store.list()).toEqual([])
  }, 15_000)

  test("the shutdown deadline force edge kills a real owned child when session cancellation hangs", async () => {
    const dir = await scratchDir()
    const script = await fixtureScript(
      dir,
      "stubborn-deadline",
      `${READY_LINE}process.on("SIGTERM", () => {})\nsetInterval(() => {}, 1000)\n`,
    )
    const store = createProcessRecordStore(join(dir, "processes"))
    const server = await launchManagedServer({
      command: process.execPath,
      args: [script],
      cwd: dir,
      env: {},
      lifetime: "helper",
      label: "fixture helper",
      timeoutMs: 5_000,
      deps: { store, policy: { graceMs: 5_000, forceObservationMs: 1_000 } },
    })
    track(server.pid)
    expect(pidAlive(server.pid)).toBe(true)

    // An explicitly aborted run whose session-cancellation request never
    // answers: the injected deadline must still deliver the owned-server force
    // edge before the process exits (spec R4 "Session cancellation does not
    // answer"; task 6.1 repeated-abort/deadline).
    let exitCode: number | undefined
    const shutdown = new RunShutdown({ exit: (code) => { exitCode = code }, graceMs: 40, forceObservationMs: 200 })
    shutdown.setForceHandler(() => server.forceStop())
    shutdown.setActiveSession({
      client: { session: { abort: () => new Promise(() => {}) } } as never,
      sessionID: "ses_hung",
      directory: dir,
      phaseName: "implementer",
    })
    const hung = shutdown.abortActiveSessions()
    shutdown.request("SIGTERM")
    expect(await waitForExit(server.pid)).toBe(true)
    await Bun.sleep(250)
    expect(exitCode).toBe(130)
    // The forced stop is observed, so the helper's record is released.
    const recordDeadline = Date.now() + 2_000
    while ((await store.list()).length > 0 && Date.now() < recordDeadline) await Bun.sleep(25)
    expect(await store.list()).toEqual([])
    shutdown.dispose()
    void hung
  }, 15_000)

  test("an abort racing startup cleans up the real child it spawned", async () => {
    const dir = await scratchDir()
    const script = await fixtureScript(dir, "hang", "setInterval(() => {}, 1000)\n")
    const store = createProcessRecordStore(join(dir, "processes"))
    const controller = new AbortController()
    let childPid = 0
    const promise = launchManagedServer({
      command: process.execPath,
      args: [script],
      cwd: dir,
      env: {},
      lifetime: "helper",
      label: "fixture helper",
      timeoutMs: 10_000,
      signal: controller.signal,
      deps: {
        store,
        spawn: (command, args, options) => {
          const child = rawSpawn(command, args, options)
          childPid = track(child.pid ?? 0)
          return child
        },
        policy: { graceMs: 2_000, forceObservationMs: 1_000 },
      },
    })
    // Cancel while the launch is still in its pre-spawn gaps: the abort event
    // never replays, so the launcher must recheck `aborted` after spawn.
    controller.abort(new Error("cancelled"))
    await expect(promise).rejects.toThrow(/cancelled/)
    expect(childPid).toBeGreaterThan(0)
    expect(await waitForExit(childPid)).toBe(true)
  }, 15_000)
})
