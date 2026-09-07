import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { execFile } from "../src/git"
import { ensureRepositoryRecord, isFound, lifecycleCommonDir, lifecycleSchemaVersion } from "../src/feature-lifecycle/store"
import {
  ensureConversationService,
  probeConversationService,
  readConversationServiceDiscovery,
  stopConversationService,
  validateConversationServiceRecord,
  type ConversationServiceRecord,
} from "../src/conversation-service"
import { bootOpencodeServerFrom, connectOpencode } from "../src/opencode"
import { createAuthoringConversation, validateAuthoringSession } from "../src/conversations"

/**
 * Task 4.3 (capability work-conversations, design D5): the authoring
 * conversation service — discovery and lifetime independent of run servers.
 * One live server per repository is discovered, liveness-verified, and
 * reused; a run server or dashboard closing never stops it, a client view
 * detaching never stops it, and only an explicit stop with quiescence
 * evidence does — anything it cannot rule out keeps the service alive.
 */

const dirs: string[] = []
let repoDir: string
let commonDir: string

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await execFile("git", args, { cwd, allowFailure: true })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
}

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "convoy-service-"))
  dirs.push(repoDir)
  await Bun.write(join(repoDir, "README.md"), "# repo\n")
  await git(repoDir, ["init", "-q", "-b", "main"])
  await git(repoDir, ["add", "."])
  await git(repoDir, ["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-q", "-m", "init"])
  commonDir = (await lifecycleCommonDir(repoDir))!
  const repoRecord = await ensureRepositoryRecord(commonDir)
  if (!isFound(repoRecord)) throw new Error("no repository record")
})

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("conversation-service discovery and reuse (task 4.3)", () => {
  test("a live discovered service is reused; it is booted only once", async () => {
    let boots = 0
    const boot = async () => {
      boots += 1
      return { url: "http://127.0.0.1:51001", close() {}, pid: 123_456 }
    }
    const live: ConversationServiceRecord = {
      schemaVersion: lifecycleSchemaVersion,
      url: "http://127.0.0.1:51001",
      pid: 123_456,
      bootCheckout: repoDir,
      startedAt: Date.now(),
    }
    const first = await ensureConversationService({ commonDir, checkout: repoDir, boot, probe: async () => "stale" })
    expect(first.status).toBe("live")
    if (first.status !== "live") return
    expect(first.reused).toBe(false)
    expect(boots).toBe(1)
    // The discovery record persisted, separately from the durable feature records.
    const onDisk = JSON.parse(await readFile(join(commonDir, "convoy", "authoring-server.json"), "utf8"))
    expect(onDisk.url).toBe(live.url)
    expect(onDisk.pid).toBe(live.pid)
    // A second ensure reuses the live service — no second boot, same URL.
    const second = await ensureConversationService({ commonDir, checkout: repoDir, boot, probe: async () => "live" })
    expect(second.status).toBe("live")
    if (second.status !== "live") return
    expect(second.reused).toBe(true)
    expect(second.url).toBe(first.url)
    expect(boots).toBe(1)
  })

  test("a stale discovery record (dead pid) is replaced by a fresh boot, not trusted", async () => {
    let boots = 0
    const boot = async () => {
      boots += 1
      return { url: "http://127.0.0.1:51002", close() {}, pid: 123_457 }
    }
    const first = await ensureConversationService({ commonDir, checkout: repoDir, boot, probe: async () => "stale" })
    expect(first.status).toBe("live")
    // The next discovery finds the recorded server gone: a fresh boot
    // replaces it and the record reflects the new server.
    const second = await ensureConversationService({ commonDir, checkout: repoDir, boot, probe: async () => "stale" })
    expect(second.status).toBe("live")
    if (second.status !== "live") return
    expect(second.reused).toBe(false)
    expect(second.record.url).toBe("http://127.0.0.1:51002")
    expect(boots).toBe(2)
  })

  test("an uncertain service (alive pid, unanswerable url) is never booted over", async () => {
    let boots = 0
    const boot = async () => {
      boots += 1
      return { url: "http://127.0.0.1:51003", close() {}, pid: 123_458 }
    }
    const seeded: ConversationServiceRecord = {
      schemaVersion: lifecycleSchemaVersion,
      url: "http://127.0.0.1:51004",
      pid: process.pid,
      bootCheckout: repoDir,
      startedAt: Date.now(),
    }
    const { writeJsonFile } = await import("../src/feature-lifecycle/store")
    await writeJsonFile(join(commonDir, "convoy", "authoring-server.json"), seeded)
    const outcome = await ensureConversationService({ commonDir, checkout: repoDir, boot, probe: async () => "uncertain" })
    expect(outcome.status).toBe("uncertain")
    if (outcome.status !== "uncertain") return
    expect(outcome.reason).toContain("unverified state")
    expect(boots).toBe(0)
    // The record was left for reconciliation, not overwritten.
    const read = await readConversationServiceDiscovery(commonDir)
    expect(read.status).toBe("found")
    if (read.status !== "found") return
    expect(read.value.url).toBe(seeded.url)
  })

  test("a discovery record pointing off-loopback is not valid evidence", async () => {
    for (const url of [
      "http://example.com:8080",
      // Lookalike hosts that a bare prefix match would let through.
      "http://127.0.0.1.evil.com",
      "http://localhost.attacker.com",
      "http://127.0.0.1:8080@evil.com",
    ]) {
      const tampered: ConversationServiceRecord = {
        schemaVersion: lifecycleSchemaVersion,
        url,
        pid: 123_458,
        bootCheckout: repoDir,
        startedAt: Date.now(),
      }
      expect(validateConversationServiceRecord(tampered)).toBeUndefined()
    }
    // And an external URL never causes a probe/connect of that host: the
    // record is treated as not-found instead of being reused or booted over.
    let boots = 0
    const offLoopback: ConversationServiceRecord = {
      schemaVersion: lifecycleSchemaVersion,
      url: "http://example.com:8080",
      pid: 123_458,
      bootCheckout: repoDir,
      startedAt: Date.now(),
    }
    await Bun.write(join(commonDir, "convoy", "authoring-server.json"), JSON.stringify(offLoopback))
    const outcome = await ensureConversationService({
      commonDir,
      checkout: repoDir,
      boot: async () => {
        boots += 1
        return { url: "http://127.0.0.1:51005", close() {}, pid: 123_459 }
      },
    })
    expect(outcome.status).toBe("uncertain")
    expect(boots).toBe(0)
  })

  test("a corrupt discovery record is reported, never overwritten by a boot", async () => {
    let boots = 0
    const boot = async () => {
      boots += 1
      return { url: "http://127.0.0.1:51005", close() {}, pid: 123_459 }
    }
    await Bun.write(join(commonDir, "convoy", "authoring-server.json"), "{ not json")
    const outcome = await ensureConversationService({ commonDir, checkout: repoDir, boot })
    expect(outcome.status).toBe("uncertain")
    expect(boots).toBe(0)
  })

  test("explicit stop requires quiescence evidence and re-verifies the recorded identity", async () => {
    const seeded: ConversationServiceRecord = {
      schemaVersion: lifecycleSchemaVersion,
      url: "http://127.0.0.1:51006",
      pid: 123_460,
      bootCheckout: repoDir,
      startedAt: Date.now(),
    }
    const { writeJsonFile } = await import("../src/feature-lifecycle/store")
    await writeJsonFile(join(commonDir, "convoy", "authoring-server.json"), seeded)
    const probe = async () => "live" as const
    // Busy and unknown evidence keep the service alive — the shutdown
    // boundaries: a stopping request that cannot rule out active execution
    // is refused rather than silently terminating the service.
    const busy = await stopConversationService({ commonDir, activity: "busy", probe })
    expect(busy.status).toBe("kept")
    const unknown = await stopConversationService({ commonDir, activity: "unknown", probe })
    expect(unknown.status).toBe("kept")
    const read1 = await readConversationServiceDiscovery(commonDir)
    expect(read1.status).toBe("found")
    // With idle evidence the stop proceeds: identity re-verified through the
    // probe, the recorded process terminated, the record removed.
    let killed = 0
    const stopped = await stopConversationService({
      commonDir,
      activity: "idle",
      probe,
      kill: async () => {
        killed += 1
      },
    })
    expect(stopped.status).toBe("stopped")
    expect(killed).toBe(1)
    const read2 = await readConversationServiceDiscovery(commonDir)
    expect(read2.status).toBe("missing")
  })

  test("an uncertain probe during stop keeps both the process and its record", async () => {
    const seeded: ConversationServiceRecord = {
      schemaVersion: lifecycleSchemaVersion,
      url: "http://127.0.0.1:51007",
      pid: process.pid,
      bootCheckout: repoDir,
      startedAt: Date.now(),
    }
    const { writeJsonFile } = await import("../src/feature-lifecycle/store")
    await writeJsonFile(join(commonDir, "convoy", "authoring-server.json"), seeded)
    let killed = 0
    const stopped = await stopConversationService({
      commonDir,
      activity: "idle",
      probe: async () => "uncertain",
      kill: async () => {
        killed += 1
      },
    })
    expect(stopped.status).toBe("kept")
    expect(killed).toBe(0)
    const read = await readConversationServiceDiscovery(commonDir)
    expect(read.status).toBe("found")
  })
})

describe("conversation-service shutdown boundaries (task 4.3, real server)", () => {
  let realRepoDir: string
  let realCommonDir: string

  beforeAll(async () => {
    // An isolated repository: the unit tests above deliberately leave seeded
    // discovery records behind, and the real boundaries need clean state.
    realRepoDir = await mkdtemp(join(tmpdir(), "convoy-service-real-"))
    dirs.push(realRepoDir)
    await Bun.write(join(realRepoDir, "README.md"), "# repo\n")
    await git(realRepoDir, ["init", "-q", "-b", "main"])
    await git(realRepoDir, ["add", "."])
    await git(realRepoDir, ["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-q", "-m", "init"])
    realCommonDir = (await lifecycleCommonDir(realRepoDir))!
    const repoRecord = await ensureRepositoryRecord(realCommonDir)
    if (!isFound(repoRecord)) throw new Error("no repository record")
  })

  test("a run server closing does not stop the authoring service or its sessions", async () => {
    // The authoring service: booted once, recorded, and independent.
    const service = await ensureConversationService({ commonDir: realCommonDir, checkout: realRepoDir })
    expect(service.status).toBe("live")
    if (service.status !== "live") return
    try {
      // An authoring session is created through the service.
      const ref = await createAuthoringConversation({ checkout: realRepoDir, title: "boundary", server: { url: service.url } })
      expect(ref.sessionId).toMatch(/^ses_/)
      // A run's server (the dashboard's attachment) boots and then closes —
      // the run dashboard goes away entirely.
      const runServer = await bootOpencodeServerFrom(realRepoDir)
      runServer.close()
      // The authoring service is unaffected: still live, same URL, and the
      // session it created still resolves through it.
      const again = await ensureConversationService({ commonDir: realCommonDir, checkout: realRepoDir })
      expect(again.status).toBe("live")
      if (again.status !== "live") return
      expect(again.url).toBe(service.url)
      expect(again.reused).toBe(true)
      const validated = await validateAuthoringSession({ ref, checkout: realRepoDir, server: { url: again.url } })
      expect(validated.status).toBe("available")
    } finally {
      // Explicit stop with idle evidence (a fresh session is quiescent).
      await stopConversationService({ commonDir: realCommonDir, activity: "idle" })
    }
  })

  test("a client view detaching keeps the service alive and sessions resolvable", async () => {
    const service = await ensureConversationService({ commonDir: realCommonDir, checkout: realRepoDir })
    expect(service.status).toBe("live")
    if (service.status !== "live") return
    try {
      const client = connectOpencode(service.url)
      const created = await client.session.create({ title: "detach" })
      if (created.error || !created.data) throw new Error("session create failed")
      const sessionId = created.data.id
      // The client view detaches (its process is gone; nobody holds a handle).
      // The service outlives it: the exact session still resolves through the
      // service, and the discovery record still probes live.
      const validated = await validateAuthoringSession({ ref: { harness: "opencode", sessionId }, checkout: realRepoDir, server: { url: service.url } })
      expect(validated.status).toBe("available")
      const record = await readConversationServiceDiscovery(realCommonDir)
      expect(record.status).toBe("found")
      if (record.status !== "found") return
      expect(await probeConversationService(record.value)).toBe("live")
    } finally {
      await stopConversationService({ commonDir: realCommonDir, activity: "idle" })
    }
    // After the explicit stop the discovery record is gone and a fresh
    // ensure boots a new service — the recovery path for a dead server.
    const fresh = await ensureConversationService({ commonDir: realCommonDir, checkout: realRepoDir })
    expect(fresh.status).toBe("live")
    if (fresh.status !== "live") return
    expect(fresh.reused).toBe(false)
    await stopConversationService({ commonDir: realCommonDir, activity: "idle" })
  })
})
