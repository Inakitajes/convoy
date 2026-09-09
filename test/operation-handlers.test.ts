import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createFixtureRepo, type FixtureRepo } from "./helpers/multi-worktree"
import { executeReviewed, pushCommittedRevision, removeRegisteredWorktree, reviewOperation } from "../src/operation-handlers"
import { execFile } from "../src/git"
import { acquireWriterClaim } from "../src/writer-claims"
import { repoCommonDir } from "../src/repo-store"
import { listWorktrees } from "../src/worktree-inventory"

/**
 * Handler-level guard wiring: `inspectOperation` and `revalidateForExecution`
 * consumed by real mutation handlers (`removeRegisteredWorktree`,
 * `pushCommittedRevision`, and the generic `executeReviewed` seam). Stale
 * targets, writer conflicts, and legacy unresolved operations are refused at
 * the handler, not only at the guard, and the refused effect never runs.
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

async function writeLegacyJournal(commonDir: string, branch: string, changeId: string): Promise<string> {
  const dir = join(commonDir, "convoy", "close")
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${branch.replace(/[^A-Za-z0-9._-]+/g, "_")}__${changeId}.json`)
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      attemptID: "attempt-1",
      branch,
      changeID: changeId,
      baseRef: "main",
      baseSha: "0".repeat(40),
      phase: "candidate",
      candidateSha: "1".repeat(40),
      recordedAt: 1,
      updatedAt: 2,
    }),
  )
  return path
}

describe("removeRegisteredWorktree (guarded handler)", () => {
  test("review → execute removes the reviewed checkout and nothing else", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "doomed", branch: "feat/doomed" }, { name: "kept", branch: "feat/kept" }] })
    fixtures.push(fixture)
    const outcome = await removeRegisteredWorktree({ checkout: fixture.worktrees["doomed"]!, commonDir: await commonDirOf(fixture) })
    expect(outcome.ok).toBe(true)
    const inventory = await listWorktrees(fixture.root)
    expect(inventory.entries.some((entry) => entry.path.endsWith("doomed"))).toBe(false)
    expect(inventory.entries.some((entry) => entry.path.endsWith("kept"))).toBe(true)
  })

  test("ignored content blocks ordinary removal and points to the force path (task 7.4)", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "doomed", branch: "feat/doomed" }] })
    fixtures.push(fixture)
    const doomed = fixture.worktrees["doomed"]!
    await fixture.write(doomed, ".gitignore", "cache/\n")
    await fixture.commitAll("chore: ignore cache", doomed)
    await mkdir(join(doomed, "cache"), { recursive: true })
    await writeFile(join(doomed, "cache", "valuable.local"), "keep me\n")
    const outcome = await removeRegisteredWorktree({ checkout: doomed, commonDir: await commonDirOf(fixture) })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      const reasons = outcome.blockers.map((blocker) => `${blocker.reason} ${blocker.remediation}`).join("\n")
      expect(reasons).toContain("ignored file")
      expect(reasons).toContain("force removal")
    }
    // The checkout and its ignored content survive an ordinary removal.
    expect(await readFile(join(doomed, "cache", "valuable.local"), "utf8")).toContain("keep me")
    const inventory = await listWorktrees(fixture.root)
    expect(inventory.entries.some((entry) => entry.path.endsWith("doomed"))).toBe(true)
  })

  test("force bypasses content blockers and removes the checkout", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "doomed", branch: "feat/doomed" }] })
    fixtures.push(fixture)
    const doomed = fixture.worktrees["doomed"]!
    await fixture.write(doomed, ".gitignore", "cache/\n")
    await fixture.commitAll("chore: ignore cache", doomed)
    await mkdir(join(doomed, "cache"), { recursive: true })
    await writeFile(join(doomed, "cache", "valuable.local"), "keep me\n")
    const outcome = await removeRegisteredWorktree({ checkout: doomed, commonDir: await commonDirOf(fixture), force: true })
    expect(outcome.ok).toBe(true)
    const inventory = await listWorktrees(fixture.root)
    expect(inventory.entries.some((entry) => entry.path.endsWith("doomed"))).toBe(false)
  })

  test("force never bypasses a hard blocker: the repository's main checkout stays", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/wt" }] })
    fixtures.push(fixture)
    const outcome = await removeRegisteredWorktree({ checkout: fixture.root, commonDir: await commonDirOf(fixture), force: true })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.blockers.map((blocker) => blocker.reason).join("\n")).toContain("main checkout")
    const inventory = await listWorktrees(fixture.root)
    expect(inventory.entries.length).toBe(2)
  })

  test("force never bypasses a lock — unlock is still the path", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "locked", branch: "feat/locked" }] })
    fixtures.push(fixture)
    const locked = fixture.worktrees["locked"]!
    await execFile("git", ["worktree", "lock", "--reason", "held by operator", locked], { cwd: fixture.root, allowFailure: true })
    const outcome = await removeRegisteredWorktree({ checkout: locked, commonDir: await commonDirOf(fixture), force: true })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      const reasons = outcome.blockers.map((blocker) => `${blocker.reason} ${blocker.remediation}`).join("\n")
      expect(reasons).toContain("the worktree is locked")
      expect(reasons).toContain("git worktree unlock")
    }
    const inventory = await listWorktrees(fixture.root)
    const entry = inventory.entries.find((candidate) => candidate.path.endsWith("locked"))
    expect(entry?.locked).toBeDefined()
  })

  test("the repository's main checkout is never removable", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/wt" }] })
    fixtures.push(fixture)
    const outcome = await removeRegisteredWorktree({ checkout: fixture.root, commonDir: await commonDirOf(fixture) })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.blockers.map((blocker) => blocker.reason).join("\n")).toContain("main checkout")
    const inventory = await listWorktrees(fixture.root)
    expect(inventory.entries.length).toBe(2)
  })

  test("a locked registration reports the lock blocker before any removal is attempted", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "locked", branch: "feat/locked" }] })
    fixtures.push(fixture)
    const locked = fixture.worktrees["locked"]!
    await execFile("git", ["worktree", "lock", "--reason", "held by operator", locked], { cwd: fixture.root, allowFailure: true })
    let effectRan = false
    const outcome = await removeRegisteredWorktree({
      checkout: locked,
      commonDir: await commonDirOf(fixture),
      effect: async () => {
        effectRan = true
        return { removedPath: locked }
      },
    })
    // The review refuses on the lock itself — never deferred to Git's refusal.
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      const reasons = outcome.blockers.map((blocker) => `${blocker.reason} ${blocker.remediation}`).join("\n")
      expect(reasons).toContain("the worktree is locked")
      expect(reasons).toContain("held by operator")
      expect(reasons).toContain("git worktree unlock")
    }
    expect(effectRan).toBe(false)
    // The locked checkout and its registration survive untouched.
    const inventory = await listWorktrees(fixture.root)
    const entry = inventory.entries.find((candidate) => candidate.path.endsWith("locked"))
    expect(entry?.locked).toBeDefined()
  })

  test("a branch switched after review is refused at execution and the worktree survives", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "drifter", branch: "feat/drifter" }] })
    fixtures.push(fixture)
    const commonDir = await commonDirOf(fixture)
    const review = await reviewOperation({ action: "remove", checkout: fixture.worktrees["drifter"]!, commonDir })
    expect(review.ok).toBe(true)
    if (!review.ok || !review.review) throw new Error("setup failed")

    // Rename the branch outside Convoy between review and execution.
    await fixture.git(["branch", "-m", "feat/drifter", "feat/renamed"])

    let effectRan = false
    const stale = await executeReviewed({
      action: "remove",
      checkout: fixture.worktrees["drifter"]!,
      commonDir,
      review: review.review,
      effect: async () => {
        effectRan = true
        return { removedPath: "" }
      },
    })
    expect(stale.ok).toBe(false)
    if (!stale.ok) {
      expect(stale.reason).toBe("stale-review")
      expect(stale.blockers.map((blocker) => blocker.reason).join("\n")).toContain("reviewed target requires feat/drifter")
    }
    expect(effectRan).toBe(false)
    // The worktree still exists under its renamed branch.
    const inventory = await listWorktrees(fixture.root)
    expect(inventory.entries.some((entry) => entry.branch === "feat/renamed")).toBe(true)
  })

  test("a live managed writer blocks the handler before any effect", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "busy", branch: "feat/busy" }] })
    fixtures.push(fixture)
    const commonDir = await commonDirOf(fixture)
    await acquireWriterClaim({ commonDir, branch: "feat/busy", checkoutPath: fixture.worktrees["busy"]!, kind: "pipeline", owner: "run-9" })
    let effectRan = false
    const outcome = await removeRegisteredWorktree({
      checkout: fixture.worktrees["busy"]!,
      commonDir,
      effect: async () => {
        effectRan = true
        return { removedPath: "" }
      },
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.blockers.map((blocker) => blocker.reason).join("\n")).toContain("managed writer already owns")
    expect(effectRan).toBe(false)
  })

  test("a legacy unresolved close on the branch blocks the handler with reconciliation guidance", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "haunted", branch: "feat/haunted" }] })
    fixtures.push(fixture)
    const commonDir = await commonDirOf(fixture)
    await writeLegacyJournal(commonDir, "feat/haunted", "old-change")
    let effectRan = false
    const outcome = await removeRegisteredWorktree({
      checkout: fixture.worktrees["haunted"]!,
      commonDir,
      effect: async () => {
        effectRan = true
        return { removedPath: "" }
      },
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      const reasons = outcome.blockers.map((blocker) => blocker.reason).join("\n")
      expect(reasons).toContain("legacy unresolved operation")
      expect(outcome.blockers.some((blocker) => blocker.remediation.includes("inspect the legacy journal"))).toBe(true)
    }
    expect(effectRan).toBe(false)

    // An unrelated branch is untouched by the legacy journal.
    const other = await createFixtureRepo({ worktrees: [{ name: "clean", branch: "feat/clean" }] })
    fixtures.push(other)
    const unrelated = await reviewOperation({ action: "remove", checkout: other.worktrees["clean"]!, commonDir: await commonDirOf(other) })
    expect(unrelated.ok).toBe(true)
  })

  test("an independent checkout proceeds while another checkout's writer holds its own branch", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "writer", branch: "feat/writer" }, { name: "bystander", branch: "feat/bystander" }] })
    fixtures.push(fixture)
    const commonDir = await commonDirOf(fixture)
    await acquireWriterClaim({ commonDir, branch: "feat/writer", checkoutPath: fixture.worktrees["writer"]!, kind: "pipeline", owner: "run-1" })
    const outcome = await removeRegisteredWorktree({ checkout: fixture.worktrees["bystander"]!, commonDir })
    expect(outcome.ok).toBe(true)
  })
})

describe("pushCommittedRevision (guarded handler)", () => {
  test("the effect receives the pinned HEAD; later local commits cannot join the accepted push", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "pushable", branch: "feat/pushable" }] })
    fixtures.push(fixture)
    const commonDir = await commonDirOf(fixture)
    const checkout = fixture.worktrees["pushable"]!
    const review = await reviewOperation({ action: "push", checkout, commonDir })
    expect(review.ok).toBe(true)
    if (!review.ok || !review.review) throw new Error("setup failed")
    const pinnedHead = review.review.pinnedHead!

    // Local commit AFTER review: the pinned HEAD no longer matches.
    await fixture.write(checkout, "late.txt", "x\n")
    await fixture.commitAll("late commit", checkout)
    const seen: string[] = []
    const outcome = await executeReviewed({
      action: "push",
      checkout,
      commonDir,
      review: review.review,
      effect: async (target) => {
        seen.push(target.head!)
        return { pushedRef: "feat/pushable:feat/pushable" }
      },
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe("stale-review")
    expect(seen).toEqual([])
    const worktreeHead = await fixture.git(["-C", checkout, "rev-parse", "HEAD"]).then((value) => value.trim())
    expect(pinnedHead).not.toBe(worktreeHead)
  })

  test("an unchanged reviewed target pushes through the handler's default effect", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "pushed", branch: "feat/pushed" }] })
    fixtures.push(fixture)
    const remote = `${fixture.root}-origin.git`
    await fixture.git(["clone", "--bare", fixture.root, remote])
    const outcome = await pushCommittedRevision({
      checkout: fixture.worktrees["pushed"]!,
      commonDir: await commonDirOf(fixture),
      remote,
      refspec: "feat/pushed:feat/pushed",
    })
    expect(outcome.ok).toBe(true)
    // The branch really arrived on the remote.
    const shown = await fixture.git(["ls-remote", remote, "refs/heads/feat/pushed"])
    expect(shown.trim()).not.toBe("")
  })

  test("the handler refuses without running the effect when review fails outright", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "det", detach: true }] })
    fixtures.push(fixture)
    let effectRan = false
    const outcome = await pushCommittedRevision({
      checkout: fixture.worktrees["det"]!,
      commonDir: await commonDirOf(fixture),
      remote: "origin",
      refspec: "x:x",
      effect: async () => {
        effectRan = true
        return { pushedRef: "x:x" }
      },
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe("blocked")
    expect(effectRan).toBe(false)
  })
})

describe("reviewOperation", () => {
  test("the review exposes its pinned facts for display and its blockers with remediation", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "reviewed", branch: "feat/reviewed" }] })
    fixtures.push(fixture)
    const review = await reviewOperation({ action: "squash", checkout: fixture.worktrees["reviewed"]!, base: "main", commonDir: await commonDirOf(fixture) })
    expect(review.ok).toBe(true)
    if (!review.ok || !review.review) return
    expect(review.review.pinnedHead).toMatch(/^[0-9a-f]{40}$/)
    expect(review.review.facts.base).toMatchObject({ ref: "main", known: true })

    const blocked = await reviewOperation({ action: "squash", checkout: fixture.worktrees["reviewed"]!, commonDir: await commonDirOf(fixture) })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.blockers[0]!.remediation).toContain("--base")
    const ignored = join(tmpdir(), `convoy-ignored-${Date.now()}`)
    scratch.push(ignored)
    await mkdir(ignored, { recursive: true })
  })
})
