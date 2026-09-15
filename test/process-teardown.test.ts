import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { IdentityObservation, IdentityProbe, ProcessIdentity } from "../src/process-identity"
import { createProcessRecordStore, newProcessRecord, type ProcessRecord } from "../src/process-records"
import { stopOwnedTestServers } from "./process-teardown"

/** This test process, as the probe reports it — the owner of the records under test. */
const self: ProcessIdentity = { pid: process.pid, birth: "boot:self", uid: 501, executable: "bun" }
const child: ProcessIdentity = { pid: 4242, birth: "boot:child", uid: 501, executable: "opencode" }
const foreignOwner: ProcessIdentity = { pid: 999, birth: "boot:foreign", uid: 501, executable: "bun" }

type ProbeState = {
  /** Identity reported for each pid; a pid absent from here observes as gone. */
  identities: Map<number, ProcessIdentity>
  alive: Set<number>
  /** Pids that answer with an inconclusive `unknown` instead of alive/gone. */
  unknown?: Set<number>
}

function fakeProbe(state: ProbeState): IdentityProbe {
  return {
    async observe(pid): Promise<IdentityObservation> {
      if (state.unknown?.has(pid)) return { status: "unknown", reason: `inconclusive pid ${pid}` }
      const identity = state.identities.get(pid)
      if (!identity) return { status: "gone" }
      return state.alive.has(pid) ? { status: "alive", identity } : { status: "gone" }
    },
  }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-teardown-test-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function record(overrides: Partial<ProcessRecord> & Pick<ProcessRecord, "owner" | "child">): ProcessRecord {
  return {
    ...newProcessRecord({ lifetime: "helper" }),
    state: "ready",
    url: "http://127.0.0.1:1",
    ...overrides,
  }
}

const fastPolicy = { graceMs: 200, forceObservationMs: 200, pollMs: 10 } as const

describe("stopOwnedTestServers", () => {
  test("stops a live child this process recorded and removes its record", async () => {
    await withTempDir(async (dir) => {
      const store = createProcessRecordStore(dir)
      const published = record({ owner: self, child })
      await store.put(published)

      const state: ProbeState = {
        identities: new Map([
          [self.pid, self],
          [child.pid, child],
        ]),
        alive: new Set([self.pid, child.pid]),
      }
      const signals: Array<{ pid: number; signal: string }> = []
      const outcomes: string[] = []

      const stopped = await stopOwnedTestServers(dir, {
        store,
        probe: fakeProbe(state),
        signal: (pid, signal) => {
          signals.push({ pid, signal })
          if (pid === child.pid && signal === "SIGTERM") state.alive.delete(child.pid)
        },
        onOutcome: (_id, outcome) => outcomes.push(outcome.status),
        policy: fastPolicy,
      })

      expect(stopped).toEqual([published.id])
      expect(signals).toEqual([{ pid: child.pid, signal: "SIGTERM" }])
      expect(outcomes).toEqual(["stopped"])
      expect(await store.get(published.id)).toBeUndefined()
    })
  })

  test("never signals a child owned by another process", async () => {
    await withTempDir(async (dir) => {
      const store = createProcessRecordStore(dir)
      const published = record({ owner: foreignOwner, child })
      await store.put(published)

      const state: ProbeState = {
        identities: new Map([
          [self.pid, self],
          [child.pid, child],
        ]),
        alive: new Set([self.pid, child.pid, foreignOwner.pid]),
      }
      const signals: number[] = []

      const stopped = await stopOwnedTestServers(dir, {
        store,
        probe: fakeProbe(state),
        signal: (pid) => signals.push(pid),
        policy: fastPolicy,
      })

      expect(stopped).toEqual([])
      expect(signals).toEqual([])
      expect(await store.get(published.id)).toBeDefined()
    })
  })

  test("removes a record whose child already exited, without signaling", async () => {
    await withTempDir(async (dir) => {
      const store = createProcessRecordStore(dir)
      const published = record({ owner: self, child })
      await store.put(published)

      const state: ProbeState = {
        identities: new Map([
          [self.pid, self],
          [child.pid, child],
        ]),
        alive: new Set([self.pid]),
      }
      const signals: number[] = []

      const stopped = await stopOwnedTestServers(dir, {
        store,
        probe: fakeProbe(state),
        signal: (pid) => signals.push(pid),
        policy: fastPolicy,
      })

      expect(stopped).toEqual([])
      expect(signals).toEqual([])
      expect(await store.get(published.id)).toBeUndefined()
    })
  })

  test("leaves evidence untouched when this process cannot prove its own identity", async () => {
    await withTempDir(async (dir) => {
      const store = createProcessRecordStore(dir)
      const published = record({ owner: self, child })
      await store.put(published)

      const state: ProbeState = {
        identities: new Map([
          [self.pid, self],
          [child.pid, child],
        ]),
        alive: new Set([self.pid, child.pid]),
        unknown: new Set([self.pid]),
      }
      const signals: number[] = []

      const stopped = await stopOwnedTestServers(dir, {
        store,
        probe: fakeProbe(state),
        signal: (pid) => signals.push(pid),
        policy: fastPolicy,
      })

      expect(stopped).toEqual([])
      expect(signals).toEqual([])
      expect(await store.get(published.id)).toBeDefined()
    })
  })
})
