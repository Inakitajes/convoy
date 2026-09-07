import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { execFile } from "../src/git"
import { isFound, lifecycleCommonDir } from "../src/feature-lifecycle/store"
import { readFeatureRecord } from "../src/feature-lifecycle/records"
import { ensureRepositoryRecord } from "../src/feature-lifecycle/store"
import { featureNewWork } from "../src/feature-lifecycle/commands"
import { beginCreationIntent, completeCreationIntent, listPendingCreationIntents, readCreationIntent } from "../src/feature-lifecycle/creation"
import { acquireWriterClaim, claimLiveness, readWriterClaim, releaseWriterClaim, writerClaimPath, writerConflictGuidance } from "../src/feature-lifecycle/writer-claims"
import { writeJsonFile } from "../src/feature-lifecycle/store"
import { assessLifecycle } from "../src/feature-lifecycle/assessment"
import type { LifecycleObservations } from "../src/feature-lifecycle/assessment"
import type { FeatureRecord } from "../src/feature-lifecycle/records"

/**
 * Tasks 5.1/5.2 (creation before proposal) and 4.4 (managed writer
 * ownership): a pre-proposal feature has an empty contract set and a display
 * name independent of change ids; the creation intent is recovery evidence
 * that reconciles partial results; a writer claim refuses a live conflicting
 * writer and reconciles a provably stale one without unconditional takeover.
 */

const dirs: string[] = []
let repoDir: string
let worktreeDir: string
let commonDir: string
let repositoryId: string

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await execFile("git", args, { cwd, allowFailure: true })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
}

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "convoy-creation-"))
  dirs.push(repoDir)
  await Bun.write(join(repoDir, "README.md"), "# repo\n")
  await git(repoDir, ["init", "-q", "-b", "main"])
  await git(repoDir, ["add", "."])
  await git(repoDir, ["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-q", "-m", "init"])
  worktreeDir = join(await mkdtemp(join(tmpdir(), "convoy-creation-wt-")), "wt")
  dirs.push(worktreeDir)
  await git(repoDir, ["worktree", "add", "-q", "-b", "feat/pre-proposal", worktreeDir])
  commonDir = (await lifecycleCommonDir(repoDir))!
  const repoRecord = await ensureRepositoryRecord(commonDir)
  if (!isFound(repoRecord)) throw new Error("no repository record")
  repositoryId = repoRecord.value.repositoryId
})

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("pre-proposal creation (task 5.2)", () => {
  test("featureNewWork accepts an empty contract set with an independent display name", async () => {
    const feature = await featureNewWork({
      cwd: repoDir,
      branch: "feat/pre-proposal",
      worktree: worktreeDir,
      changeIds: [],
      base: "main",
      displayName: "Widget redesign",
    })
    expect(feature.contracts).toEqual([])
    expect(feature.displayName).toBe("Widget redesign")
    expect(feature.context?.branch).toBe("feat/pre-proposal")
    const reread = await readFeatureRecord(commonDir, feature.featureId)
    expect(reread.status).toBe("found")
  })

  test("the shared assessment identifies the idle zero-contract feature as awaiting proposal", () => {
    const feature: FeatureRecord = {
      schemaVersion: 1,
      featureId: "cccccccc-0000-4000-8000-00000000abcd",
      repositoryId,
      displayName: "Widget redesign",
      associationRevision: 1,
      contracts: [],
      intendedBaseRef: "main",
      context: { branch: "feat/pre-proposal", checkoutPath: worktreeDir },
      runIds: [],
      closeAttemptIds: [],
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const observations: LifecycleObservations = {
      feature,
      context: { verification: "verified", branch: "feat/pre-proposal", checkoutPath: worktreeDir },
      contracts: [],
      execution: { kind: "known", liveRunIds: [], totalRuns: 0 },
      integration: "pending",
      publication: { kind: "known", published: false },
      cleanup: { kind: "known", worktreePresent: true, branchPresent: true },
    }
    const assessment = assessLifecycle(observations)
    expect(assessment.summary).toBe("Awaiting proposal")
    expect(assessment.closeStartPrerequisitesPass).toBe(false)
    const close = assessment.actions.find((action) => action.id === "close")
    expect(close?.enabled).toBe(false)
    expect(close?.blockers.join(" ")).toContain("no contracts")
    // The authoring actions are available on a verified context.
    expect(assessment.actions.find((action) => action.id === "propose")?.enabled).toBe(true)
    expect(assessment.actions.find((action) => action.id === "converse")?.enabled).toBe(true)
  })
})

describe("creation intents (tasks 5.1/5.2)", () => {
  test("an intent persists before effects, completes on registration, and leaves the pending list", async () => {
    const intent = await beginCreationIntent(commonDir, { repositoryId, displayName: "Recovery drill", branch: "feat/drill", base: "main", worktree: "/tmp/never-created" })
    expect(intent.status).toBe("pending")
    const pendingBefore = await listPendingCreationIntents(commonDir)
    expect(pendingBefore.some((entry) => entry.operationId === intent.operationId)).toBe(true)
    await completeCreationIntent(commonDir, intent.operationId, "cccccccc-0000-4000-8000-00000000abc9")
    const read = await readCreationIntent(commonDir, intent.operationId)
    expect(read.status).toBe("found")
    if (read.status !== "found") return
    expect(read.value.status).toBe("completed")
    expect(read.value.featureId).toBe("cccccccc-0000-4000-8000-00000000abc9")
    const pendingAfter = await listPendingCreationIntents(commonDir)
    expect(pendingAfter.some((entry) => entry.operationId === intent.operationId)).toBe(false)
  })

  test("a pending intent survives as discoverable recovery evidence (orphaned result)", async () => {
    const intent = await beginCreationIntent(commonDir, { repositoryId, displayName: "Orphan drill", branch: "feat/orphan", base: "main", worktree: "/tmp/orphan-wt" })
    // No completion: creation stopped between effects and registration.
    const pending = await listPendingCreationIntents(commonDir)
    const found = pending.find((entry) => entry.operationId === intent.operationId)
    expect(found?.read.status).toBe("found")
    if (found?.read.status !== "found") return
    expect(found.read.value.worktree).toBe("/tmp/orphan-wt")
    expect(found.read.value.displayName).toBe("Orphan drill")
  })
})

describe("managed writer claims (task 4.4)", () => {
  test("a live claim refuses a second writer with transition guidance", async () => {
    const acquired = await acquireWriterClaim({ commonDir, branch: "feat/claimed", checkoutPath: worktreeDir, kind: "pipeline", owner: "run-1" })
    expect(acquired.status).toBe("acquired")
    const second = await acquireWriterClaim({ commonDir, branch: "feat/claimed", checkoutPath: worktreeDir, kind: "authoring" })
    expect(second.status).toBe("conflict")
    if (second.status !== "conflict") return
    expect(second.existing.owner).toBe("run-1")
    const guidance = writerConflictGuidance(second.existing)
    expect(guidance.join(" ")).toContain("run-1")
    expect(guidance.join(" ")).toContain("convoy runs")
    await releaseWriterClaim({ commonDir, branch: "feat/claimed", owner: "run-1" })
  })

  test("a stale claim (dead pid, expired heartbeat) is reconciled, not taken over blindly", async () => {
    const acquired = await acquireWriterClaim({ commonDir, branch: "feat/stale", checkoutPath: worktreeDir, kind: "pipeline", owner: "run-old", pid: 999_999_999 })
    expect(acquired.status).toBe("acquired")
    // Simulate the owner having stopped heartbeating long ago: backdate the
    // on-disk heartbeat past the freshness window so the claim is provably
    // stale (dead pid, expired heartbeat) at the next acquisition.
    const claim = await readWriterClaim(commonDir, "feat/stale")
    if (claim.status !== "found") throw new Error("claim lost")
    const backdated = { ...claim.value, heartbeatAt: Date.now() - 20 * 60 * 1000 }
    expect(claimLiveness(backdated)).toBe("stale")
    await writeJsonFile(writerClaimPath(commonDir, "feat/stale"), backdated)
    const reAcquired = await acquireWriterClaim({ commonDir, branch: "feat/stale", checkoutPath: worktreeDir, kind: "authoring", owner: "session-2" })
    expect(reAcquired.status).toBe("acquired")
    if (reAcquired.status !== "acquired") return
    expect(reAcquired.claim.owner).toBe("session-2")
    expect(reAcquired.claim.kind).toBe("authoring")
    await releaseWriterClaim({ commonDir, branch: "feat/stale", owner: "session-2" })
  })

  test("a dead pid with a fresh heartbeat is uncertain and is never taken over silently", async () => {
    const acquired = await acquireWriterClaim({ commonDir, branch: "feat/uncertain", checkoutPath: worktreeDir, kind: "pipeline", owner: "run-x", pid: 999_999_998 })
    expect(acquired.status).toBe("acquired")
    const refused = await acquireWriterClaim({ commonDir, branch: "feat/uncertain", checkoutPath: worktreeDir, kind: "authoring", owner: "session-y" })
    expect(refused.status).toBe("uncertain")
    // The refused acquisition replaced nothing.
    const unchanged = await readWriterClaim(commonDir, "feat/uncertain")
    expect(unchanged.status).toBe("found")
    if (unchanged.status !== "found") return
    expect(unchanged.value.owner).toBe("run-x")
    await releaseWriterClaim({ commonDir, branch: "feat/uncertain", owner: "run-x" })
  })

  test("a foreign owner cannot release someone else's claim", async () => {
    await acquireWriterClaim({ commonDir, branch: "feat/foreign", checkoutPath: worktreeDir, kind: "authoring", owner: "session-a" })
    const released = await releaseWriterClaim({ commonDir, branch: "feat/foreign", owner: "session-b" })
    expect(released).toBe(false)
    const claim = await readWriterClaim(commonDir, "feat/foreign")
    expect(claim.status).toBe("found")
    await releaseWriterClaim({ commonDir, branch: "feat/foreign", owner: "session-a" })
    const gone = await readWriterClaim(commonDir, "feat/foreign")
    expect(gone.status).toBe("missing")
  })

  test("re-opening the conversation that holds the claim continues it (same-owner reconciliation)", async () => {
    await acquireWriterClaim({ commonDir, branch: "feat/resume", checkoutPath: worktreeDir, kind: "authoring", owner: "ses_same" })
    const resumed = await acquireWriterClaim({ commonDir, branch: "feat/resume", checkoutPath: worktreeDir, kind: "authoring", owner: "ses_same", reconcileOwner: "ses_same" })
    expect("claim" in resumed).toBe(true)
    await releaseWriterClaim({ commonDir, branch: "feat/resume", owner: "ses_same" })
  })

  test("claims are scoped per branch: independent checkouts do not block each other", async () => {
    const a = await acquireWriterClaim({ commonDir, branch: "feat/one", checkoutPath: "/wt/one", kind: "pipeline", owner: "run-a" })
    const b = await acquireWriterClaim({ commonDir, branch: "feat/two", checkoutPath: "/wt/two", kind: "authoring", owner: "ses-b" })
    expect("claim" in a).toBe(true)
    expect("claim" in b).toBe(true)
    await releaseWriterClaim({ commonDir, branch: "feat/one", owner: "run-a" })
    await releaseWriterClaim({ commonDir, branch: "feat/two", owner: "ses-b" })
  })
})
