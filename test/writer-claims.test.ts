import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  acquireWriterClaim,
  readWriterClaim,
  releaseWriterClaim,
  reownWriterClaim,
  validateWriterClaim,
  writerClaimPath,
  type WriterClaim,
} from "../src/writer-claims"
import { writeJsonFile } from "../src/repo-store"

/**
 * Managed writer claims (change `worktree-control-center`, task 2.1): the
 * generic coordination layer extracted from the feature-lifecycle domain.
 * This suite covers the claims API whose direct behavior is not asserted by
 * the feature-lifecycle compat tests — the `reownWriterClaim` propose-flow
 * handoff and the `validateWriterClaim` record gate. The claim paths operate
 * under a plain filesystem root, so no Git repository is required.
 */

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "writer-claims-"))
  dirs.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("validateWriterClaim", () => {
  const base: WriterClaim = {
    schemaVersion: 1,
    branch: "feat/add-widget",
    checkoutPath: "/wt/add-widget",
    kind: "authoring",
    owner: "session-1",
    pid: 12345,
    startedAt: 1,
    heartbeatAt: 2,
  }

  test("accepts a well-formed claim and preserves the optional owner", () => {
    const claim = validateWriterClaim(base)
    expect(claim).toBeTruthy()
    expect(claim).toEqual(base)
  })

  test("accepts a claim with no owner", () => {
    const { owner, ...noOwner } = base
    const claim = validateWriterClaim(noOwner)
    expect(claim).toBeTruthy()
    expect(claim).toEqual(noOwner)
  })

  test("rejects non-objects (undefined, string, array)", () => {
    expect(validateWriterClaim(undefined)).toBeUndefined()
    expect(validateWriterClaim("nope")).toBeUndefined()
    expect(validateWriterClaim([1, 2])).toBeUndefined()
  })

  test("rejects a foreign or missing schema version", () => {
    expect(validateWriterClaim({ ...base, schemaVersion: 2 })).toBeUndefined()
    expect(validateWriterClaim({ ...base, schemaVersion: undefined })).toBeUndefined()
  })

  test("rejects an unknown kind or an empty branch", () => {
    expect(validateWriterClaim({ ...base, kind: "other" as never })).toBeUndefined()
    expect(validateWriterClaim({ ...base, branch: "" })).toBeUndefined()
  })

  test("rejects malformed numeric or identifier fields", () => {
    expect(validateWriterClaim({ ...base, pid: "123" })).toBeUndefined()
    expect(validateWriterClaim({ ...base, pid: 1.5 })).toBeUndefined()
    expect(validateWriterClaim({ ...base, startedAt: "now" })).toBeUndefined()
    expect(validateWriterClaim({ ...base, heartbeatAt: undefined })).toBeUndefined()
  })
})

describe("reownWriterClaim (propose-flow handoff)", () => {
  test("re-owns the claim when the owning process still holds it", async () => {
    const dir = await tempDir()
    await acquireWriterClaim({ commonDir: dir, branch: "feat/x", checkoutPath: "/wt/x", kind: "authoring", owner: "pre-session", pid: 424_242 })
    const reowned = await reownWriterClaim({ commonDir: dir, branch: "feat/x", owner: "session-1", ownerPid: 424_242 })
    expect(reowned).toBe(true)
    const read = await readWriterClaim(dir, "feat/x")
    expect(read.status).toBe("found")
    if (read.status === "found") expect(read.value.owner).toBe("session-1")
  })

  test("refuses to re-own a claim held by a different PID (no takeover)", async () => {
    const dir = await tempDir()
    await acquireWriterClaim({ commonDir: dir, branch: "feat/y", checkoutPath: "/wt/y", kind: "authoring", owner: "other", pid: 555_555 })
    const reowned = await reownWriterClaim({ commonDir: dir, branch: "feat/y", owner: "session-2", ownerPid: 666_666 })
    expect(reowned).toBe(false)
    const read = await readWriterClaim(dir, "feat/y")
    expect(read.status).toBe("found")
    if (read.status === "found") expect(read.value.owner).toBe("other")
  })

  test("is a no-op when no claim exists", async () => {
    const dir = await tempDir()
    expect(await reownWriterClaim({ commonDir: dir, branch: "feat/none", owner: "session-3", ownerPid: 777_777 })).toBe(false)
  })

  test("a re-own leaves the claim releasable by the continued owner", async () => {
    const dir = await tempDir()
    await acquireWriterClaim({ commonDir: dir, branch: "feat/z", checkoutPath: "/wt/z", kind: "pipeline", owner: "run-a", pid: 888_888 })
    await reownWriterClaim({ commonDir: dir, branch: "feat/z", owner: "run-b", ownerPid: 888_888 })
    const released = await releaseWriterClaim({ commonDir: dir, branch: "feat/z", owner: "run-b" })
    expect(released).toBe(true)
    expect((await readWriterClaim(dir, "feat/z")).status).toBe("missing")
  })

  test("the claim path escapes separator-only branch keys into a flat name", () => {
    expect(writerClaimPath("/common", "feat/a/b")).toMatch(/writer-claims\/feat__a__b\.json$/)
    expect(writerClaimPath("/common", "branch-only")).toMatch(/writer-claims\/branch-only\.json$/)
  })
})

describe("acquireWriterClaim (task 4.6 conflicting writers on resume)", () => {
  test("refuses a live conflicting claim held by another owner/PID (no takeover), returning the existing claim", async () => {
    const dir = await tempDir()
    const now = Date.now()
    await writeJsonFile(
      writerClaimPath(dir, "feat/live"),
      {
        schemaVersion: 1,
        branch: "feat/live",
        checkoutPath: "/wt/live",
        kind: "authoring",
        owner: "other",
        pid: process.pid,
        startedAt: now - 1000,
        heartbeatAt: now,
      } satisfies WriterClaim,
    )
    const result = await acquireWriterClaim({
      commonDir: dir,
      branch: "feat/live",
      checkoutPath: "/wt/live-2",
      kind: "authoring",
      owner: "mine",
    })
    expect(result.status).toBe("conflict")
    if (result.status === "conflict") {
      expect(result.existing.owner).toBe("other")
      expect(result.existing.pid).toBe(process.pid)
    }
    // The live claim is left untouched — no takeover by a new PID.
    const read = await readWriterClaim(dir, "feat/live")
    expect(read.status).toBe("found")
    if (read.status === "found") expect(read.value.owner).toBe("other")
  })

  test("an uncertain claim (alive PID, stale heartbeat) is refused, never taken over without reconciliation", async () => {
    const dir = await tempDir()
    const now = Date.now()
    await writeJsonFile(
      writerClaimPath(dir, "feat/uncertain"),
      {
        schemaVersion: 1,
        branch: "feat/uncertain",
        checkoutPath: "/wt/uncertain",
        kind: "authoring",
        owner: "other",
        pid: process.pid,
        startedAt: now - 20 * 60 * 1000,
        heartbeatAt: now - 20 * 60 * 1000,
      } satisfies WriterClaim,
    )
    const result = await acquireWriterClaim({
      commonDir: dir,
      branch: "feat/uncertain",
      checkoutPath: "/wt/u",
      kind: "authoring",
      owner: "mine",
    })
    expect(result.status).toBe("uncertain")
    if (result.status === "uncertain") expect(result.existing?.owner).toBe("other")
  })

  test("a stale claim (dead PID, stale heartbeat) is reconciled and replaced", async () => {
    const dir = await tempDir()
    const now = Date.now()
    await writeJsonFile(
      writerClaimPath(dir, "feat/stale"),
      {
        schemaVersion: 1,
        branch: "feat/stale",
        checkoutPath: "/wt/stale",
        kind: "pipeline",
        owner: "run-old",
        pid: 999_999_999,
        startedAt: now - 30 * 60 * 1000,
        heartbeatAt: now - 30 * 60 * 1000,
      } satisfies WriterClaim,
    )
    const result = await acquireWriterClaim({
      commonDir: dir,
      branch: "feat/stale",
      checkoutPath: "/wt/stale",
      kind: "pipeline",
      owner: "run-new",
      pid: process.pid,
    })
    expect(result.status).toBe("acquired")
    if (result.status === "acquired") {
      expect(result.claim.owner).toBe("run-new")
      expect(result.claim.pid).toBe(process.pid)
    }
  })

  test("a matching reconcileOwner may continue even over a live claim (same writer, not a takeover)", async () => {
    const dir = await tempDir()
    const now = Date.now()
    await writeJsonFile(
      writerClaimPath(dir, "feat/continue"),
      {
        schemaVersion: 1,
        branch: "feat/continue",
        checkoutPath: "/wt/continue",
        kind: "authoring",
        owner: "session-9",
        pid: process.pid,
        startedAt: now - 1000,
        heartbeatAt: now,
      } satisfies WriterClaim,
    )
    const result = await acquireWriterClaim({
      commonDir: dir,
      branch: "feat/continue",
      checkoutPath: "/wt/continue",
      kind: "authoring",
      owner: "session-9",
      reconcileOwner: "session-9",
    })
    expect(result.status).toBe("acquired")
  })
})
