import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { createFixtureRepo, type FixtureRepo } from "./helpers/multi-worktree"
import { inspectOperation, revalidateForExecution } from "../src/operation-guards"
import { acquireWriterClaim } from "../src/writer-claims"
import { repoCommonDir } from "../src/repo-store"

/**
 * Task 2.2: shared inspect/review/execute guards. Direct-handler checks
 * reject stale targets, unknown status, detached-only incompatibilities, and
 * conflicting managed writers, while independent safe actions stay allowed.
 */

const fixtures: FixtureRepo[] = []
const scratch: string[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true }).catch(() => {})
})

async function commonDirOf(fixture: FixtureRepo): Promise<string> {
  const dir = await repoCommonDir(fixture.root)
  if (!dir) throw new Error("fixture has no common dir")
  return dir
}

describe("inspectOperation", () => {
  test("a clean attached checkout with a resolvable base is available", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "ready", branch: "feat/ready" }] })
    fixtures.push(fixture)
    const inspection = await inspectOperation({ action: "sync", checkout: fixture.worktrees["ready"]!, base: "main", commonDir: await commonDirOf(fixture) })
    expect(inspection.available).toBe(true)
    expect(inspection.blockers).toEqual([])
    expect(inspection.target?.branch).toBe("feat/ready")
    expect(inspection.pinnedHead).toMatch(/^[0-9a-f]{40}$/)
    expect(inspection.facts.base).toMatchObject({ ref: "main", known: true })
    expect(inspection.facts.dirt).toMatchObject({ known: true, dirty: false })
  })

  test("dirty trees block clean-required actions with a count, and unknown status is never clean", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "dirty", branch: "feat/dirty" }] })
    fixtures.push(fixture)
    const checkout = fixture.worktrees["dirty"]!
    await fixture.write(checkout, "leftover.txt", "uncommitted\n")
    const dirty = await inspectOperation({ action: "archive", checkout, commonDir: await commonDirOf(fixture) })
    expect(dirty.available).toBe(false)
    expect(dirty.blockers.some((blocker) => blocker.reason.includes("1 uncommitted"))).toBe(true)

    // A checkout whose status cannot be read is blocked with the read failure, not passed as clean.
    const missing = join(await import("node:os").then((os) => os.tmpdir()), `convoy-gone-${Date.now()}`)
    const unknown = await inspectOperation({ action: "archive", checkout: missing, commonDir: await commonDirOf(fixture) })
    expect(unknown.available).toBe(false)
  })

  test("detached checkouts refuse attached-only actions and explain the prerequisite", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "det", detach: true }] })
    fixtures.push(fixture)
    const inspection = await inspectOperation({ action: "sync", checkout: fixture.worktrees["det"]!, base: "main", commonDir: await commonDirOf(fixture) })
    expect(inspection.available).toBe(false)
    expect(inspection.blockers.map((blocker) => blocker.reason).join("\n")).toContain("detached-HEAD")
    // Fetch remains available on the same detached checkout: not all actions share the prerequisite.
    const fetch = await inspectOperation({ action: "fetch", checkout: fixture.worktrees["det"]!, commonDir: await commonDirOf(fixture) })
    expect(fetch.available).toBe(true)
  })

  test("a missing base ref blocks base-required actions with remediation", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "nobase", branch: "feat/nobase" }] })
    fixtures.push(fixture)
    const noBase = await inspectOperation({ action: "squash", checkout: fixture.worktrees["nobase"]!, commonDir: await commonDirOf(fixture) })
    expect(noBase.available).toBe(false)
    expect(noBase.blockers.some((blocker) => blocker.reason.includes("explicitly selected base"))).toBe(true)
    const badBase = await inspectOperation({ action: "squash", checkout: fixture.worktrees["nobase"]!, base: "ghost", commonDir: await commonDirOf(fixture) })
    expect(badBase.available).toBe(false)
    expect(badBase.facts.base).toMatchObject({ ref: "ghost", known: false })
  })

  test("a live managed writer conflicts; an unrelated checkout stays independent", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "writer", branch: "feat/writer" }, { name: "other", branch: "feat/other" }] })
    fixtures.push(fixture)
    const commonDir = await commonDirOf(fixture)
    const acquired = await acquireWriterClaim({ commonDir, branch: "feat/writer", checkoutPath: fixture.worktrees["writer"]!, kind: "pipeline", owner: "run-1" })
    expect(acquired.status).toBe("acquired")

    const conflicted = await inspectOperation({ action: "archive", checkout: fixture.worktrees["writer"]!, commonDir })
    expect(conflicted.available).toBe(false)
    expect(conflicted.blockers.map((blocker) => blocker.reason).join("\n")).toContain("managed writer already owns")
    expect(conflicted.facts.writerClaim).toMatchObject({ liveness: "live" })

    // Same-checkout actions that do not need a free writer still report facts but stay inspectable;
    // an unrelated checkout with a different branch is unaffected.
    const independent = await inspectOperation({ action: "archive", checkout: fixture.worktrees["other"]!, commonDir })
    expect(independent.available).toBe(true)
    expect(independent.facts.writerClaim).toBeUndefined()
  })

  test("a stale writer claim is not a blocker; an uncertain one is", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "stale-writer", branch: "feat/stale" }] })
    fixtures.push(fixture)
    const commonDir = await commonDirOf(fixture)
    const deadPidDir = join(await import("node:os").then((os) => os.tmpdir()), `convoy-deadpid-${Date.now()}`)
    scratch.push(deadPidDir)
    // A claim whose owner process is provably gone and whose heartbeat is old: stale.
    await acquireWriterClaim({ commonDir, branch: "feat/stale", checkoutPath: fixture.worktrees["stale-writer"]!, kind: "authoring", owner: "ses-old", pid: 999_999_999 })
    // Force the heartbeat old by rewriting the record (the acquisition wrote it fresh).
    const claimPath = join(commonDir, "convoy", "writer-claims", "feat__stale.json")
    const claim = JSON.parse(await (await import("node:fs/promises")).readFile(claimPath, "utf8"))
    claim.heartbeatAt = Date.now() - 20 * 60 * 1000
    await writeFile(claimPath, JSON.stringify(claim))
    const stale = await inspectOperation({ action: "archive", checkout: fixture.worktrees["stale-writer"]!, commonDir })
    expect(stale.facts.writerClaim).toMatchObject({ liveness: "stale" })
    expect(stale.available).toBe(true)
    await mkdir(deadPidDir, { recursive: true })
  })

  test("a stale reviewed target refuses at revalidation time", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "reviewed", branch: "feat/reviewed" }] })
    fixtures.push(fixture)
    const checkout = fixture.worktrees["reviewed"]!
    const commonDir = await commonDirOf(fixture)
    const reviewed = await inspectOperation({ action: "squash", checkout, base: "main", commonDir })
    expect(reviewed.available).toBe(true)
    // Advance the checkout after review.
    await fixture.write(checkout, "late.txt", "x\n")
    await fixture.commitAll("late", checkout)
    const revalidated = await revalidateForExecution({ action: "squash", checkout, base: "main", commonDir, reviewed })
    expect(revalidated.available).toBe(false)
    expect(revalidated.blockers.map((blocker) => blocker.reason).join("\n")).toContain("advanced from")
  })

  test("a wrong repository is refused when the reviewed common dir is pinned", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "own-repo", branch: "feat/own" }] })
    fixtures.push(fixture)
    const elsewhere = await createFixtureRepo({})
    fixtures.push(elsewhere)
    const inspection = await inspectOperation({
      action: "push",
      checkout: elsewhere.root,
      commonDir: await commonDirOf(fixture),
      requirements: { requireCommonDir: (await repoCommonDir(fixture.root))! },
    })
    expect(inspection.available).toBe(false)
    expect(inspection.blockers.map((blocker) => blocker.reason).join("\n")).toContain("different repository")
  })
})
