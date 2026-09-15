import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { launchManagedServer, parseReadinessLine } from "../src/managed-server"
import {
  captureIdentity,
  defaultIdentityProbe,
  identityMismatchReason,
  linuxProcessIdentity,
  macosProcessIdentity,
  parseBoottime,
  parseProcStat,
  parseProcStatusUid,
  sameIdentity,
  type IdentityObservation,
  type IdentityProbe,
  type ProcessIdentity,
} from "../src/process-identity"
import {
  createProcessRecordStore,
  newProcessRecord,
  processRecordsDir,
  reconcileProcessRecords,
  type ProcessRecord,
  type ProcessRecordStore,
} from "../src/process-records"
import { sweepPendingLaunches } from "../src/coordinate"
import { cleanupWorkspace } from "../src/workspace"
import { stopTarget } from "../src/process-stop"

const dirs: string[] = []
afterAll(async () => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))))

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-process-lifecycle-"))
  dirs.push(dir)
  return dir
}

const identity = (pid: number, overrides: Partial<ProcessIdentity> = {}): ProcessIdentity => ({
  pid,
  birth: `boot:${pid}`,
  uid: 501,
  executable: "opencode",
  ...overrides,
})

function probeOf(map: Record<number, IdentityObservation>): IdentityProbe {
  return { observe: async (pid) => map[pid] ?? { status: "gone" } }
}

describe("process identity parsing", () => {
  test("parses /proc stat past a comm containing spaces and parentheses", () => {
    // comm = "(a b) c)"; field 4 (ppid) = 42, field 22 (starttime) = 12345.
    const fields = ["S", "42", "1", "1", "0", "-1", "4194304"]
    while (fields.length < 20) fields.push("0")
    fields[19] = "12345"
    const stat = `7 (a b) c) ${fields.join(" ")}`
    expect(parseProcStat(stat)).toEqual({ ppid: 42, startTicks: 12345 })
  })

  test("rejects a stat line without a usable starttime", () => {
    expect(parseProcStat("not a stat line")).toBeUndefined()
  })

  test("reads the real uid from /proc status", () => {
    expect(parseProcStatusUid("Name:\topencode\nUid:\t501\t501\t501\t501\n")).toBe(501)
    expect(parseProcStatusUid("Name:\topencode\n")).toBeUndefined()
  })

  test("parses the macOS boottime discriminator", () => {
    expect(parseBoottime("{ sec = 1787332370, usec = 36769 } Fri Aug 21")).toBe("1787332370.36769")
    expect(parseBoottime("nonsense")).toBeUndefined()
  })

  test("low-resolution or partial identities never compare equal", () => {
    const expected = identity(7, { birth: "boot:1" })
    expect(sameIdentity(expected, identity(7, { birth: "boot:1" }))).toBe(true)
    expect(sameIdentity(expected, identity(7, { birth: "boot:2" }))).toBe(false)
    expect(sameIdentity(expected, identity(7, { uid: 0 }))).toBe(false)
    expect(identityMismatchReason(expected, identity(7, { birth: "boot:2" }))).toContain("reused")
  })
})

describe("platform adapters", () => {
  test("macOS observes the current process with a kernel birth token", async () => {
    if (process.platform !== "darwin") return
    const observation = await macosProcessIdentity(process.pid)
    expect(observation.status).toBe("alive")
    if (observation.status === "alive") {
      expect(observation.identity.pid).toBe(process.pid)
      expect(observation.identity.birth).toMatch(/^\d+\.\d+:\d+\.\d+$/)
      expect(observation.identity.executable.length).toBeGreaterThan(0)
    }
  })

  test("a failed libproc read on a live PID is uncertain, never gone", async () => {
    // proc_pidinfo writing nothing models an unreadable/refused PID; the
    // process still exists, so the observation must not become kill authority.
    const failed = await macosProcessIdentity(process.pid, { proc_pidinfo: () => 0, proc_pidpath: () => 0 })
    expect(failed.status).toBe("unknown")
  })

  test("a failed libproc read reports gone only when the kernel proves absence", async () => {
    const gone = await macosProcessIdentity(999_999, { proc_pidinfo: () => 0, proc_pidpath: () => 0 }, () => "absent")
    expect(gone.status).toBe("gone")
    const unreadable = await macosProcessIdentity(999_999, { proc_pidinfo: () => 0, proc_pidpath: () => 0 }, () => "present")
    expect(unreadable.status).toBe("unknown")
  })

  test("linux adapter reports gone only when the kernel proves absence", async () => {
    if (process.platform !== "linux") return
    const missing = 4_194_000 // beyond typical pid_max; /proc/<pid> does not exist
    const gone = await linuxProcessIdentity(missing, () => "absent")
    expect(gone.status).toBe("gone")
    const hidden = await linuxProcessIdentity(missing, () => "present")
    expect(hidden.status).toBe("unknown")
  })

  test("linux adapter reads birth, uid, and executable from a live process", async () => {
    if (process.platform !== "linux") return
    const observation = await linuxProcessIdentity(process.pid)
    expect(observation.status).toBe("alive")
    if (observation.status !== "alive") return
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()
    expect(observation.identity.pid).toBe(process.pid)
    // The birth token must carry the kernel boot discriminator, not just a
    // start time: a reboot has to invalidate the recorded incarnation.
    expect(observation.identity.birth.startsWith(`${bootId}:`)).toBe(true)
    expect(observation.identity.uid).toBe(process.getuid?.() ?? -1)
    expect(observation.identity.executable.length).toBeGreaterThan(0)
  })

  test("linux reboot invalidates the recorded incarnation, never authorizing a signal", async () => {
    if (process.platform !== "linux") return
    const observation = await linuxProcessIdentity(process.pid)
    expect(observation.status).toBe("alive")
    if (observation.status !== "alive") return
    const recorded = observation.identity
    const startTicks = recorded.birth.slice(recorded.birth.lastIndexOf(":") + 1)
    // Same pid and start ticks, different boot: not the same incarnation.
    const afterReboot: ProcessIdentity = { ...recorded, birth: `rebooted-boot:${startTicks}` }
    expect(sameIdentity(recorded, afterReboot)).toBe(false)
    expect(identityMismatchReason(recorded, afterReboot)).toContain("reused")
  })

  test("captureIdentity gives up non-destructively when a probe cannot answer", async () => {
    const captured = await captureIdentity(4242, { observe: async () => ({ status: "unknown", reason: "no probe" }) }, 3)
    expect(captured).toBeUndefined()
  })

  test("the default probe is platform-selected and never throws", async () => {
    const probe = defaultIdentityProbe("sunos")
    const observation = await probe.observe(1)
    expect(observation.status).toBe("unknown")
  })
})

describe("bounded stop state machine", () => {
  test("observes a graceful exit", async () => {
    let exited = false
    const outcome = await stopTarget(
      {
        pid: 1,
        isExited: () => exited,
        waitForExit: async () => {
          exited = true
          return true
        },
        signal: () => {},
      },
      { graceMs: 10, forceObservationMs: 10 },
    )
    expect(outcome).toEqual({ status: "stopped", via: "graceful" })
  })

  test("escalates to SIGKILL when the target ignores SIGTERM", async () => {
    const signals: string[] = []
    let exited = false
    const outcome = await stopTarget(
      {
        pid: 2,
        isExited: () => exited,
        waitForExit: async () => exited,
        signal: (signal) => {
          signals.push(signal)
          if (signal === "SIGKILL") exited = true
        },
      },
      { graceMs: 5, forceObservationMs: 5 },
    )
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
    expect(outcome).toEqual({ status: "stopped", via: "forced" })
  })

  test("an already-exited target settles without another signal", async () => {
    let signalled = false
    const outcome = await stopTarget(
      {
        pid: 3,
        isExited: () => true,
        waitForExit: async () => true,
        signal: () => {
          signalled = true
        },
      },
      { graceMs: 5, forceObservationMs: 5 },
    )
    expect(outcome).toEqual({ status: "stopped", via: "already-gone" })
    expect(signalled).toBe(false)
  })

  test("refuses forced escalation when the target no longer verifies", async () => {
    const signals: string[] = []
    const outcome = await stopTarget(
      {
        pid: 4,
        isExited: () => false,
        waitForExit: async () => false,
        signal: (signal) => void signals.push(signal),
        verify: async () => ({ ok: false, reason: "pid was reused" }),
      },
      { graceMs: 5, forceObservationMs: 5 },
    )
    expect(signals).toEqual(["SIGTERM"])
    expect(outcome.status).toBe("unresolved")
    if (outcome.status === "unresolved") expect(outcome.reason).toContain("pid was reused")
  })

  test("reports unresolved rather than claiming a stop it could not observe", async () => {
    const outcome = await stopTarget(
      {
        pid: 5,
        isExited: () => false,
        waitForExit: async () => false,
        signal: () => {},
      },
      { graceMs: 5, forceObservationMs: 5 },
    )
    expect(outcome.status).toBe("unresolved")
  })
})

describe("process record storage", () => {
  test("publishes atomically with private modes and never stores secrets", async () => {
    const root = await scratchDir()
    const store = createProcessRecordStore(join(root, "processes"))
    const record = { ...newProcessRecord({ lifetime: "helper" }), runId: "20260101-000000-ab12", url: "http://127.0.0.1:1" }
    await store.put(record)
    const raw = await readFile(join(store.dir, `${record.id}.json`), "utf8")
    expect(JSON.parse(raw)).toMatchObject({ version: 1, lifetime: "helper", state: "provisional" })
    expect(raw).not.toContain("token")
    expect(raw).not.toContain("OPENCODE_CONFIG_CONTENT")
    expect((await stat(store.dir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(store.dir, `${record.id}.json`))).mode & 0o777).toBe(0o600)
    // No temp files survive a successful publication.
    expect((await readdir(store.dir)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("ignores corrupt and legacy records", async () => {
    const root = await scratchDir()
    const store = createProcessRecordStore(join(root, "processes"))
    await mkdir(store.dir, { recursive: true })
    await writeFile(join(store.dir, "bad.json"), "{not json")
    await writeFile(join(store.dir, "old.json"), JSON.stringify({ version: 0, id: "old", lifetime: "run" }))
    expect(await store.list()).toEqual([])
    expect(await store.get("bad")).toBeUndefined()
  })

  test("serializes concurrent lock attempts without stealing a live lock", async () => {
    const root = await scratchDir()
    const store = createProcessRecordStore(join(root, "processes"))
    const record = newProcessRecord({ lifetime: "run" })
    let release: (() => void) | undefined
    const first = store.withLock(record.id, async () => {
      await new Promise<void>((resolve) => (release = resolve))
      return "first"
    })
    await Bun.sleep(5)
    const second = await store.withLock(record.id, async () => "second", { timeoutMs: 30 })
    expect(second).toBeUndefined()
    release?.()
    expect(await first).toBe("first")
    // The lock is released for the next caller.
    expect(await store.withLock(record.id, async () => "third", { timeoutMs: 30 })).toBe("third")
  })
})

describe("orphan reconciliation", () => {
  async function seed(record: ProcessRecord): Promise<{ store: ReturnType<typeof createProcessRecordStore>; record: ProcessRecord }> {
    const root = await scratchDir()
    const store = createProcessRecordStore(join(root, "processes"))
    await store.put(record)
    return { store, record }
  }

  test("stops a verified orphan whose owner is provably gone", async () => {
    const child = identity(900, { birth: "boot:900" })
    const owner = identity(901, { birth: "boot:901", executable: "bun" })
    const record = { ...newProcessRecord({ lifetime: "run" }), owner, child, state: "ready" as const }
    const { store } = await seed(record)
    const signals: string[] = []
    const observations: Record<number, IdentityObservation> = { 901: { status: "gone" }, 900: { status: "alive", identity: child } }
    const outcome = await reconcileProcessRecords({
      store,
      probe: { observe: async (pid) => observations[pid] ?? { status: "gone" } },
      signal: (pid, signal) => {
        signals.push(signal)
        observations[pid] = { status: "gone" }
      },
      policy: { graceMs: 5, forceObservationMs: 5, pollMs: 1 },
    })
    expect(outcome.stopped).toEqual([record.id])
    expect(signals).toEqual(["SIGTERM"])
    expect(await store.get(record.id)).toBeUndefined()
  })

  test("leaves a detached run alone while its owner is alive", async () => {
    const child = identity(910, { birth: "boot:910" })
    const owner = identity(911, { birth: "boot:911", executable: "bun" })
    const record = { ...newProcessRecord({ lifetime: "run" }), owner, child, state: "ready" as const }
    const { store } = await seed(record)
    const signals: string[] = []
    const outcome = await reconcileProcessRecords({
      store,
      probe: probeOf({ 911: { status: "alive", identity: owner }, 910: { status: "alive", identity: child } }),
      signal: (_pid, signal) => void signals.push(signal),
    })
    expect(outcome.skipped.map((entry) => entry.id)).toEqual([record.id])
    expect(signals).toEqual([])
    expect(await store.get(record.id)).toBeDefined()
  })

  test("never signals a reused child PID", async () => {
    const child = identity(920, { birth: "boot:920" })
    const owner = identity(921, { birth: "boot:921", executable: "bun" })
    const record = { ...newProcessRecord({ lifetime: "helper" }), owner, child, state: "ready" as const }
    const { store } = await seed(record)
    const signals: string[] = []
    const outcome = await reconcileProcessRecords({
      store,
      probe: probeOf({
        921: { status: "gone" },
        920: { status: "alive", identity: identity(920, { birth: "boot:other" }) },
      }),
      signal: (_pid, signal) => void signals.push(signal),
    })
    expect(signals).toEqual([])
    expect(outcome.skipped.length).toBe(1)
  })

  test("an unknown probe is uncertain, never a kill target", async () => {
    const child = identity(930, { birth: "boot:930" })
    const owner = identity(931, { birth: "boot:931", executable: "bun" })
    const record = { ...newProcessRecord({ lifetime: "helper" }), owner, child, state: "ready" as const }
    const { store } = await seed(record)
    const outcome = await reconcileProcessRecords({
      store,
      probe: probeOf({ 931: { status: "unknown", reason: "no /proc" } }),
      signal: () => {
        throw new Error("must not signal")
      },
    })
    expect(outcome.uncertain.map((entry) => entry.id)).toEqual([record.id])
    expect(await store.get(record.id)).toBeDefined()
  })

  test("a legacy record without child identity is never a kill target", async () => {
    const owner = identity(941, { birth: "boot:941", executable: "bun" })
    const record = { ...newProcessRecord({ lifetime: "run" }), owner, state: "ready" as const }
    const { store } = await seed(record)
    const outcome = await reconcileProcessRecords({
      store,
      probe: probeOf({ 941: { status: "gone" } }),
      signal: () => {
        throw new Error("must not signal")
      },
    })
    expect(outcome.uncertain.map((entry) => entry.id)).toEqual([record.id])
  })

  test("bounds the pass and preserves unprocessed records", async () => {
    const root = await scratchDir()
    const store = createProcessRecordStore(join(root, "processes"))
    for (let index = 0; index < 5; index++) {
      await store.put({ ...newProcessRecord({ lifetime: "helper", now: index }), state: "ready" })
    }
    const outcome = await reconcileProcessRecords({
      store,
      probe: { observe: async () => ({ status: "unknown", reason: "slow" }) },
      maxRecords: 2,
    })
    expect(outcome.inspected).toBe(2)
    expect(outcome.deferred.length).toBe(3)
  })

  test("a passing budget defers without failing startup", async () => {
    const root = await scratchDir()
    const store = createProcessRecordStore(join(root, "processes"))
    await store.put(newProcessRecord({ lifetime: "helper" }))
    const outcome = await reconcileProcessRecords({ store, budgetMs: -1, probe: { observe: async () => ({ status: "unknown", reason: "x" }) } })
    expect(outcome.deferred).toContain((await store.list())[0]!.id)
  })

  test("two concurrent passes serialize on the record lock and signal once", async () => {
    const child = identity(950, { birth: "boot:950" })
    const owner = identity(951, { birth: "boot:951", executable: "bun" })
    const record = { ...newProcessRecord({ lifetime: "run" }), owner, child, state: "ready" as const }
    const { store } = await seed(record)
    const observations: Record<number, IdentityObservation> = { 951: { status: "gone" }, 950: { status: "alive", identity: child } }
    const probe: IdentityProbe = {
      observe: async (pid) => {
        // The reconciler's own live lock must never be reclaimed as dead.
        if (pid === process.pid) return { status: "alive", identity: identity(process.pid, { executable: "bun" }) }
        return observations[pid] ?? { status: "gone" }
      },
    }
    let signals = 0
    const signal = (pid: number, _signal: string) => {
      signals++
      observations[pid] = { status: "gone" }
    }
    const policy = { graceMs: 5, forceObservationMs: 5, pollMs: 1 }
    const [first, second] = await Promise.all([
      reconcileProcessRecords({ store, probe, signal, policy }),
      reconcileProcessRecords({ store, probe, signal, policy }),
    ])
    expect(signals).toBe(1)
    expect(first.stopped.length + second.stopped.length).toBe(1)
  })

  test("the continuation cursor advances so deferred records are not starved", async () => {
    const root = await scratchDir()
    const store = createProcessRecordStore(join(root, "processes"))
    for (let index = 0; index < 3; index++) {
      await store.put({ ...newProcessRecord({ lifetime: "helper", now: index }), state: "ready" })
    }
    const probe: IdentityProbe = { observe: async () => ({ status: "unknown", reason: "slow probe" }) }
    const inspected: string[] = []
    for (let pass = 0; pass < 3; pass++) {
      const outcome = await reconcileProcessRecords({ store, probe, maxRecords: 1 })
      inspected.push(outcome.uncertain[0]!.id)
    }
    expect(new Set(inspected).size).toBe(3)
  })

  test("an ancient incomplete record is reported uncertain and removed without a signal", async () => {
    const root = await scratchDir()
    const store = createProcessRecordStore(join(root, "processes"))
    const record = {
      ...newProcessRecord({ lifetime: "run", now: Date.now() - 25 * 60 * 60 * 1_000 }),
      state: "ready" as const,
    }
    await store.put(record)
    const outcome = await reconcileProcessRecords({
      store,
      probe: { observe: async () => ({ status: "gone" }) },
      signal: () => {
        throw new Error("must not signal an incomplete record")
      },
    })
    expect(outcome.uncertain.map((entry) => entry.id)).toContain(record.id)
    expect(await store.get(record.id)).toBeUndefined()
  })
})

describe("managed server launch and stop", () => {
  type FakeChild = {
    pid: number
    stdout: { on(event: string, listener: (chunk: Buffer) => void): void; destroy(): void }
    stderr: { on(event: string, listener: (chunk: Buffer) => void): void; destroy(): void }
    kill(signal?: string): boolean
    once(event: string, listener: (...args: unknown[]) => void): void
    on(event: string, listener: (...args: unknown[]) => void): void
    removeListener(event: string, listener: (...args: unknown[]) => void): void
  }

  function fakeChild(options: { pid?: number; ignoreTerm?: boolean } = {}): { child: FakeChild; emitExit: () => void; emitData: (line: string) => void } {
    const exitListeners: Array<(...args: unknown[]) => void> = []
    const dataListeners: Array<(chunk: Buffer) => void> = []
    // The launcher awaits identity capture and record publication before it
    // spawns, so a test's emission can precede listener registration. Replay
    // everything emitted so far to each late listener.
    const pendingData: Buffer[] = []
    let pendingExit = false
    let exited = false
    const child: FakeChild = {
      pid: options.pid ?? 5555,
      stdout: {
        on: (_event, listener) => {
          dataListeners.push(listener)
          for (const chunk of pendingData.splice(0)) listener(chunk)
        },
        destroy: () => {},
      },
      stderr: { on: () => {}, destroy: () => {} },
      kill: (signal) => {
        if (signal === "SIGTERM" && options.ignoreTerm) return true
        if (exited) return false
        exited = true
        pendingExit = true
        setTimeout(() => exitListeners.splice(0).forEach((listener) => listener(0, null)), 0)
        return true
      },
      once: (event, listener) => {
        if (event !== "exit") return
        exitListeners.push(listener)
        if (pendingExit) setTimeout(listener, 0)
      },
      on: () => {},
      removeListener: (event, listener) => {
        if (event !== "exit") return
        const index = exitListeners.indexOf(listener)
        if (index !== -1) exitListeners.splice(index, 1)
      },
    }
    return {
      child,
      emitExit: () => {
        pendingExit = true
        exitListeners.splice(0).forEach((listener) => listener(0, null))
      },
      emitData: (line) => {
        const chunk = Buffer.from(line)
        if (dataListeners.length === 0) pendingData.push(chunk)
        else dataListeners.forEach((listener) => listener(chunk))
      },
    }
  }

  const probe: IdentityProbe = { observe: async (pid) => ({ status: "alive", identity: identity(pid, { executable: "opencode" }) }) }

  test("parses the strict readiness line and rejects a malformed one", () => {
    expect(parseReadinessLine("opencode server listening on http://127.0.0.1:4123")).toEqual({ url: "http://127.0.0.1:4123" })
    expect(parseReadinessLine("opencode server listening somewhere")).toBe("malformed")
    expect(parseReadinessLine("some other output")).toBeUndefined()
  })

  test("publishes ownership before resolving and stops idempotently", async () => {
    const root = await scratchDir()
    const store = createProcessRecordStore(join(root, "processes"))
    const { child, emitData } = fakeChild()
    const serverPromise = launchManagedServer({
      command: "opencode",
      args: ["serve"],
      cwd: root,
      env: {},
      lifetime: "helper",
      label: "test helper",
      deps: { spawn: () => child as never, probe, store, policy: { graceMs: 5, forceObservationMs: 5 } },
    })
    emitData("opencode server listening on http://127.0.0.1:9999\n")
    const server = await serverPromise
    expect(server.url).toBe("http://127.0.0.1:9999")
    expect(server.recordId).toBeDefined()
    const records = await store.list()
    expect(records.length).toBe(1)
    expect(records[0]!.state).toBe("ready")
    expect(records[0]!.child?.pid).toBe(5555)

    const [first, second] = await Promise.all([server.stop(), server.stop()])
    expect(first.status).toBe("stopped")
    expect(second.status).toBe("stopped")
    // A confirmed stop removes the transient record.
    expect(await store.list()).toEqual([])
  })

  test("a malformed readiness line fails the boot after bounded cleanup", async () => {
    const root = await scratchDir()
    const store = createProcessRecordStore(join(root, "processes"))
    const { child, emitData } = fakeChild()
    const serverPromise = launchManagedServer({
      command: "opencode",
      args: ["serve"],
      cwd: root,
      env: {},
      lifetime: "helper",
      label: "test helper",
      deps: { spawn: () => child as never, probe, store, policy: { graceMs: 5, forceObservationMs: 5 } },
    })
    emitData("opencode server listening somewhere\n")
    await expect(serverPromise).rejects.toThrow(/malformed readiness/)
  })

  test("bounds an unterminated stdout line without losing a later readiness line", async () => {
    const root = await scratchDir()
    const store = createProcessRecordStore(join(root, "processes"))
    const { child, emitData } = fakeChild()
    const serverPromise = launchManagedServer({
      command: "opencode",
      args: ["serve"],
      cwd: root,
      env: {},
      lifetime: "helper",
      label: "test helper",
      deps: { spawn: () => child as never, probe, store, policy: { graceMs: 5, forceObservationMs: 5 } },
    })
    // A chatty child that never emits a newline must not grow the line buffer
    // without bound. The cap keeps only the tail, so a readiness line on its
    // own line still parses.
    emitData("x".repeat(200_000))
    emitData("\nopencode server listening on http://127.0.0.1:4321\n")
    const server = await serverPromise
    expect(server.url).toBe("http://127.0.0.1:4321")
    await server.stop()
  })

  test("an early exit fails the boot and leaves no record", async () => {
    const root = await scratchDir()
    const store = createProcessRecordStore(join(root, "processes"))
    const { child, emitExit } = fakeChild()
    const serverPromise = launchManagedServer({
      command: "opencode",
      args: ["serve"],
      cwd: root,
      env: {},
      lifetime: "helper",
      label: "test helper",
      deps: { spawn: () => child as never, probe, store, policy: { graceMs: 5, forceObservationMs: 5 } },
    })
    emitExit()
    await expect(serverPromise).rejects.toThrow(/exited before it was ready/)
    await Bun.sleep(10)
    expect(await store.list()).toEqual([])
  })

  test("a pre-aborted signal never spawns", async () => {
    const root = await scratchDir()
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))
    let spawned = false
    await expect(
      launchManagedServer({
        command: "opencode",
        args: [],
        cwd: root,
        env: {},
        lifetime: "helper",
        label: "test helper",
        signal: controller.signal,
        deps: {
          spawn: () => {
            spawned = true
            return fakeChild().child as never
          },
        },
      }),
    ).rejects.toThrow(/cancelled/)
    expect(spawned).toBe(false)
  })

  test("an authoring-service launch publishes no reconciliation record", async () => {
    const root = await scratchDir()
    const store = createProcessRecordStore(join(root, "processes"))
    const { child, emitData } = fakeChild()
    const serverPromise = launchManagedServer({
      command: "opencode",
      args: ["serve"],
      cwd: root,
      env: {},
      lifetime: "authoring-service",
      label: "authoring service",
      deps: { spawn: () => child as never, probe, store, policy: { graceMs: 5, forceObservationMs: 5 } },
    })
    emitData("opencode server listening on http://127.0.0.1:8888\n")
    const server = await serverPromise
    expect(server.recordId).toBeUndefined()
    expect(await store.list()).toEqual([])
    await server.stop()
  })
})

describe("managed server ownership evidence and startup recovery", () => {
  // Reuse the fake-child shape by redeclaring a minimal version here; the
  // launcher only needs pid/stdout/stderr/kill/once/on/removeListener.
  function childFixture(options: { pid?: number; ignoreTerm?: boolean; ignoreKill?: boolean } = {}) {
    const exitListeners: Array<(...args: unknown[]) => void> = []
    const dataListeners: Array<(chunk: Buffer) => void> = []
    const pendingData: Buffer[] = []
    let pendingExit = false
    let exited = false
    let killed = 0
    const child = {
      pid: options.pid ?? 6001,
      stdout: {
        on: (_event: string, listener: (chunk: Buffer) => void) => {
          dataListeners.push(listener)
          for (const chunk of pendingData.splice(0)) listener(chunk)
        },
        destroy: () => {},
      },
      stderr: { on: () => {}, destroy: () => {} },
      kill: (signal?: string) => {
        killed++
        if (signal === "SIGTERM" && options.ignoreTerm) return true
        if (options.ignoreKill) return true
        if (exited) return false
        exited = true
        pendingExit = true
        setTimeout(() => exitListeners.splice(0).forEach((listener) => listener(0, null)), 0)
        return true
      },
      once: (event: string, listener: (...args: unknown[]) => void) => {
        if (event !== "exit") return
        exitListeners.push(listener)
        if (pendingExit) setTimeout(listener, 0)
      },
      on: () => {},
      removeListener: (event: string, listener: (...args: unknown[]) => void) => {
        if (event !== "exit") return
        const index = exitListeners.indexOf(listener)
        if (index !== -1) exitListeners.splice(index, 1)
      },
      get killedTimes() {
        return killed
      },
    }
    return {
      child,
      emitData: (line: string) => {
        const chunk = Buffer.from(line)
        if (dataListeners.length === 0) pendingData.push(chunk)
        else dataListeners.forEach((listener) => listener(chunk))
      },
    }
  }

  const probe: IdentityProbe = { observe: async (pid) => ({ status: "alive", identity: identity(pid, { executable: "opencode" }) }) }
  const stopPolicy = { graceMs: 5, forceObservationMs: 5 }

  test("refuses to spawn when the provisional ownership record cannot be persisted", async () => {
    const root = await scratchDir()
    // A file where the record directory must be makes `mkdir`/`put` fail.
    await writeFile(join(root, "processes"), "not a directory")
    const store = createProcessRecordStore(join(root, "processes"))
    let spawned = false
    await expect(
      launchManagedServer({
        command: "opencode",
        args: ["serve"],
        cwd: root,
        env: {},
        lifetime: "helper",
        label: "test helper",
        deps: {
          spawn: () => {
            spawned = true
            return childFixture().child as never
          },
          probe,
          store,
        },
      }),
    ).rejects.toThrow(/ownership cannot be persisted/)
    expect(spawned).toBe(false)
  })

  test("refuses readiness and cleans up when the child identity cannot be captured", async () => {
    const root = await scratchDir()
    const store = createProcessRecordStore(join(root, "processes"))
    const { child, emitData } = childFixture()
    const unknownProbe: IdentityProbe = { observe: async () => ({ status: "unknown", reason: "no probe" }) }
    const serverPromise = launchManagedServer({
      command: "opencode",
      args: ["serve"],
      cwd: root,
      env: {},
      lifetime: "helper",
      label: "test helper",
      deps: { spawn: () => child as never, probe: unknownProbe, store, policy: stopPolicy },
    })
    emitData("opencode server listening on http://127.0.0.1:7777\n")
    await expect(serverPromise).rejects.toThrow(/identity could not be captured/)
    // The still-owned child is cleaned up and its transient record removed.
    expect(child.killedTimes).toBe(1)
    await Bun.sleep(10)
    expect(await store.list()).toEqual([])
  })

  test("refuses readiness and cleans up when publishing the child identity fails", async () => {
    const root = await scratchDir()
    const real = createProcessRecordStore(join(root, "processes"))
    let puts = 0
    const flaky: ProcessRecordStore = {
      ...real,
      put: async (record: ProcessRecord) => {
        puts++
        if (puts >= 2) throw new Error("no space left on device")
        await real.put(record)
      },
    }
    const { child, emitData } = childFixture()
    const serverPromise = launchManagedServer({
      command: "opencode",
      args: ["serve"],
      cwd: root,
      env: {},
      lifetime: "run",
      label: "test run server",
      deps: { spawn: () => child as never, probe, store: flaky, policy: stopPolicy },
    })
    emitData("opencode server listening on http://127.0.0.1:7778\n")
    await expect(serverPromise).rejects.toThrow(/ownership could not be published/)
    expect(child.killedTimes).toBe(1)
  })

  test("runs a bounded reconciliation pass before a run/helper boot", async () => {
    const root = await scratchDir()
    const store = createProcessRecordStore(join(root, "processes"))
    const order: string[] = []
    const passes: Array<{ store: unknown; probe: unknown }> = []
    const { child, emitData } = childFixture()
    const serverPromise = launchManagedServer({
      command: "opencode",
      args: ["serve"],
      cwd: root,
      env: {},
      lifetime: "helper",
      label: "test helper",
      deps: {
        spawn: () => {
          order.push("spawn")
          return child as never
        },
        probe,
        store,
        reconcile: async (deps) => {
          order.push("reconcile")
          passes.push(deps)
        },
        policy: stopPolicy,
      },
    })
    emitData("opencode server listening on http://127.0.0.1:6666\n")
    const server = await serverPromise
    expect(order).toEqual(["reconcile", "spawn"])
    expect(passes.length).toBe(1)
    expect(passes[0]!.store).toBe(store)
    expect(passes[0]!.probe).toBe(probe)
    await server.stop()
  })

  test("an authoring-service boot runs no reconciliation pass", async () => {
    const root = await scratchDir()
    const store = createProcessRecordStore(join(root, "processes"))
    let passes = 0
    const { child, emitData } = childFixture()
    const serverPromise = launchManagedServer({
      command: "opencode",
      args: ["serve"],
      cwd: root,
      env: {},
      lifetime: "authoring-service",
      label: "authoring service",
      deps: {
        spawn: () => child as never,
        probe,
        store,
        reconcile: async () => {
          passes++
        },
        policy: stopPolicy,
      },
    })
    emitData("opencode server listening on http://127.0.0.1:6667\n")
    const server = await serverPromise
    expect(passes).toBe(0)
    await server.stop()
  })

  test("a failing reconciliation pass does not fail an unrelated launch", async () => {
    const root = await scratchDir()
    const store = createProcessRecordStore(join(root, "processes"))
    const { child, emitData } = childFixture()
    const serverPromise = launchManagedServer({
      command: "opencode",
      args: ["serve"],
      cwd: root,
      env: {},
      lifetime: "helper",
      label: "test helper",
      deps: {
        spawn: () => child as never,
        probe,
        store,
        reconcile: async () => {
          throw new Error("slow record could not be classified")
        },
        policy: stopPolicy,
      },
    })
    emitData("opencode server listening on http://127.0.0.1:6668\n")
    const server = await serverPromise
    expect(server.url).toBe("http://127.0.0.1:6668")
    await server.stop()
  })

  test("an unobserved stop retains the record as unresolved evidence", async () => {
    const root = await scratchDir()
    const store = createProcessRecordStore(join(root, "processes"))
    // A child that ignores both signals: the stop cannot confirm exit and must
    // not claim one (design D2/D5).
    const { child, emitData } = childFixture({ ignoreKill: true })
    const serverPromise = launchManagedServer({
      command: "opencode",
      args: ["serve"],
      cwd: root,
      env: {},
      lifetime: "helper",
      label: "test helper",
      deps: { spawn: () => child as never, probe, store, policy: stopPolicy },
    })
    emitData("opencode server listening on http://127.0.0.1:4444\n")
    const server = await serverPromise
    const outcome = await server.stop()
    expect(outcome.status).toBe("unresolved")
    const record = await store.get(server.recordId!)
    expect(record?.state).toBe("unresolved")
    expect(record?.lastOutcome).toContain("not observed")
  })

  test("a helper stopped under a shared budget uses the resolver and cannot restart it", async () => {
    const root = await scratchDir()
    const store = createProcessRecordStore(join(root, "processes"))
    const { child, emitData } = childFixture({ ignoreKill: true })
    let policyCalls = 0
    const serverPromise = launchManagedServer({
      command: "opencode",
      args: ["serve"],
      cwd: root,
      env: {},
      lifetime: "helper",
      label: "test helper",
      deps: {
        spawn: () => child as never,
        probe,
        store,
        // The shared budget a coordinator under its deadline would report:
        // no time left, so no fresh graceful/observation window (design D2).
        policy: () => {
          policyCalls++
          return { graceMs: 0, forceObservationMs: 0 }
        },
      },
    })
    emitData("opencode server listening on http://127.0.0.1:7777\n")
    const server = await serverPromise
    const started = Date.now()
    const outcome = await server.stop()
    const elapsed = Date.now() - started
    // The resolver is evaluated at stop time, and the default 2s+1s standalone
    // allowance was not restarted: an unresponsive child settles unresolved in
    // well under it.
    expect(policyCalls).toBeGreaterThan(0)
    expect(outcome.status).toBe("unresolved")
    expect(elapsed).toBeLessThan(500)
  })

  test("a signal aborted during startup still cleans up the owned child", async () => {
    const root = await scratchDir()
    const store = createProcessRecordStore(join(root, "processes"))
    const controller = new AbortController()
    const { child } = childFixture()
    const serverPromise = launchManagedServer({
      command: "opencode",
      args: ["serve"],
      cwd: root,
      env: {},
      lifetime: "helper",
      label: "test helper",
      signal: controller.signal,
      deps: {
        spawn: () => child as never,
        probe,
        store,
        // Cancel during the pre-spawn gap: the abort event never replays, so
        // the launcher must recheck `aborted` after spawn to avoid exposing a
        // live server after cancellation won (design D1).
        reconcile: async () => {
          controller.abort(new Error("cancelled"))
        },
        policy: stopPolicy,
      },
    })
    await expect(serverPromise).rejects.toThrow(/cancelled/)
    expect(child.killedTimes).toBe(1)
    await Bun.sleep(10)
    expect(await store.list()).toEqual([])
  })
})

describe("process records survive ordinary cleanup", () => {
  test("an unresolved record outlives a pending-launch sweep and its workspace removal", async () => {
    const root = await scratchDir()
    const home = join(root, "home")
    const previousHome = process.env.CONVOY_HOME
    process.env.CONVOY_HOME = home
    try {
      // The record lives under <convoy home>/.convoy/processes, independently
      // of the disposable `pending/` and run workspaces (design D5).
      const store = createProcessRecordStore(processRecordsDir())
      const record: ProcessRecord = {
        ...newProcessRecord({ lifetime: "run" }),
        state: "unresolved",
        runId: "20260101-000000-ab12",
        child: identity(4321),
      }
      await store.put(record)

      // A dead-pid pending launch dir is swept away.
      const pendingRoot = join(home, ".convoy", "pending")
      const dirName = "22222222-2222-4222-8222-222222222222"
      await mkdir(join(pendingRoot, dirName), { recursive: true })
      const gone = Bun.spawn(["true"])
      await gone.exited
      await writeFile(join(pendingRoot, dirName, "pid"), String(gone.pid))
      await sweepPendingLaunches(pendingRoot)
      expect(await readdir(pendingRoot)).toEqual([])

      // The run workspace is removed as ordinary cleanup does.
      const runDir = join(home, ".convoy", "runs", record.runId!)
      await mkdir(runDir, { recursive: true })
      await cleanupWorkspace({ dir: runDir, runID: record.runId! })

      // Unresolved evidence is retained for a later reconciliation pass.
      const retained = await store.get(record.id)
      expect(retained?.state).toBe("unresolved")
      expect(retained?.child?.pid).toBe(4321)
      expect(await readFile(join(processRecordsDir(), `${record.id}.json`), "utf8")).toContain(record.runId!)
    } finally {
      if (previousHome === undefined) delete process.env.CONVOY_HOME
      else process.env.CONVOY_HOME = previousHome
    }
  })
})
