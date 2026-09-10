import { afterEach, describe, expect, test } from "bun:test"

import { createFixtureRepo, type FixtureRepo } from "./helpers/multi-worktree"
import {
  observeAncestry,
  observeBaseDivergence,
  observeDirt,
  observeExecutionActivity,
  observeTreeEquality,
  observeUpstreamDivergence,
  observeWriterClaim,
} from "../src/worktree-observations"

/**
 * Task 1.5: typed, timestamped independent observations. Unknown is distinct
 * from clean/absent; no upstream is distinct from zero divergence; related
 * history is distinct from base containment; equal content is distinct from
 * historical integration. Collection never fetches or writes.
 */

const fixtures: FixtureRepo[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
})

describe("observeDirt", () => {
  test("clean is known-dirty:false; modifications and untracked files count", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "dirty", branch: "feat/dirty" }] })
    fixtures.push(fixture)
    const checkout = fixture.worktrees["dirty"]!
    expect(await observeDirt(checkout)).toMatchObject({ kind: "known", value: { dirty: false, fileCount: 0 } })

    await fixture.write(checkout, "tracked.txt", "changed\n")
    await fixture.write(checkout, "untracked.txt", "new\n")
    expect(await observeDirt(checkout)).toMatchObject({ kind: "known", value: { dirty: true, fileCount: 2 } })
  })

  test("an unreadable checkout is unknown, never clean", async () => {
    const observed = await observeDirt("/definitely/not/a/checkout")
    expect(observed.kind).toBe("unknown")
    if (observed.kind === "unknown") expect(observed.reason).toBeTruthy()
    expect(observed.collectedAt).toBeGreaterThan(0)
  })
})

describe("observeBaseDivergence", () => {
  test("ahead/behind counts against the selected base, with containment stated separately", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "diverge", branch: "feat/diverge" }] })
    fixtures.push(fixture)
    const checkout = fixture.worktrees["diverge"]!
    const mainHead = (await fixture.git(["rev-parse", "main"])).trim()

    // Fresh worktree: same tip as main — contained, zero/zero.
    expect(await observeBaseDivergence(checkout, "main")).toMatchObject({
      kind: "known",
      value: { ahead: 0, behind: 0, baseContainedInSource: true },
    })

    // Advance main: the branch is behind but the base is NOT contained in the branch.
    await fixture.write(fixture.root, "main-advance.txt", "x\n")
    await fixture.commitAll("advance main")
    expect(await observeBaseDivergence(checkout, "main")).toMatchObject({
      kind: "known",
      value: { ahead: 0, behind: 1, baseContainedInSource: false },
    })

    // Advance the branch too: ahead 1 behind 1, and the base's NEW tip is
    // still not contained in the branch (both sides moved independently).
    await fixture.write(checkout, "branch-advance.txt", "x\n")
    await fixture.commitAll("advance branch", checkout)
    expect(await observeBaseDivergence(checkout, "main")).toMatchObject({
      kind: "known",
      value: { ahead: 1, behind: 1, baseContainedInSource: false },
    })
    expect((await observeBaseDivergence(checkout, "main")).collectedAt).toBeGreaterThan(0)
    expect(mainHead).toMatch(/^[0-9a-f]{40}$/)

    // After the branch incorporates the base's tip (merge), containment holds.
    await fixture.git(["-C", checkout, "merge", "main", "--no-edit", "-q"])
    expect(await observeBaseDivergence(checkout, "main")).toMatchObject({
      kind: "known",
      value: { ahead: 2, behind: 0, baseContainedInSource: true },
    })
  })

  test("a merely related history is not containment; an unrelated base is unknown-safe", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "related", branch: "feat/related" }] })
    fixtures.push(fixture)
    const checkout = fixture.worktrees["related"]!
    // An orphan branch shares no history with main.
    await fixture.git(["checkout", "--orphan", "orphan"])
    await fixture.write(fixture.root, "orphan.txt", "x\n")
    await fixture.commitAll("orphan commit", fixture.root)
    const observed = await observeBaseDivergence(checkout, "orphan")
    // Unrelated histories: rev-list still counts, containment is false.
    expect(observed.kind).toBe("known")
    if (observed.kind === "known") {
      expect(observed.value.baseContainedInSource).toBe(false)
      expect(observed.value.ahead + observed.value.behind).toBeGreaterThan(0)
    }
  })

  test("a base ref that does not resolve is unknown with the ref named", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "badbase", branch: "feat/badbase" }] })
    fixtures.push(fixture)
    const observed = await observeBaseDivergence(fixture.worktrees["badbase"]!, "no-such-base")
    expect(observed.kind).toBe("unknown")
    if (observed.kind === "unknown") expect(observed.reason).toContain("no-such-base")
  })
})

describe("observeUpstreamDivergence", () => {
  test("no upstream is known with upstream: undefined, not zero divergence", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "noup", branch: "feat/noup" }] })
    fixtures.push(fixture)
    const observed = await observeUpstreamDivergence(fixture.root, "main")
    expect(observed).toEqual({ kind: "known", value: { upstream: undefined }, collectedAt: expect.any(Number) })
  })

  test("an upstream with divergence reports ahead/behind from locally known remote refs", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "upstreamed", branch: "feat/up" }] })
    fixtures.push(fixture)
    const remote = `${fixture.root}-remote.git`
    await fixture.git(["clone", "--bare", fixture.root, remote])
    await fixture.git(["remote", "add", "origin", remote])
    await fixture.git(["push", "-q", "origin", "main:main"])
    await fixture.git(["branch", "--set-upstream-to=origin/main", "main"])

    // Local-only commit: ahead 1, behind 0, without any fetch (the remote
    // refs used are the locally known ones).
    await fixture.write(fixture.root, "local-only.txt", "x\n")
    await fixture.commitAll("local only")
    const observed = await observeUpstreamDivergence(fixture.root, "main")
    expect(observed).toMatchObject({ kind: "known", value: { upstream: "origin/main", ahead: 1, behind: 0 } })
  })
})

describe("observeAncestry", () => {
  test("reachability is a fact about the two revisions only", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "anc", branch: "feat/anc" }] })
    fixtures.push(fixture)
    const mainHead = (await fixture.git(["rev-parse", "main"])).trim()
    // main is an ancestor of the branch tip.
    expect(await observeAncestry(mainHead, "feat/anc", fixture.root)).toMatchObject({ kind: "known", value: { tipReachableFromBase: true } })
    // After the branch advances, its new tip is not reachable from main's old commit.
    await fixture.write(fixture.worktrees["anc"]!, "advance.txt", "x\n")
    await fixture.commitAll("advance", fixture.worktrees["anc"]!)
    const branchTip = (await fixture.git(["rev-parse", "feat/anc"])).trim()
    expect(await observeAncestry(branchTip, mainHead, fixture.root)).toMatchObject({ kind: "known", value: { tipReachableFromBase: false } })
  })

  test("unresolvable refs are unknown, never silently false", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const observed = await observeAncestry("no-such-ref", "main", fixture.root)
    expect(observed.kind).toBe("unknown")
  })
})

describe("observeTreeEquality", () => {
  test("identical trees across different commits are equal; changed content is not", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "trees", branch: "feat/trees" }] })
    fixtures.push(fixture)
    const checkout = fixture.worktrees["trees"]!
    const mainHead = (await fixture.git(["rev-parse", "main"])).trim()
    // A different commit, identical tree (empty commit): equality is content, not identity.
    await fixture.git(["commit", "--allow-empty", "-m", "marker", "--no-gpg-sign"])
    const markerHead = (await fixture.git(["rev-parse", "HEAD"])).trim()
    expect(markerHead).not.toBe(mainHead)
    expect(await observeTreeEquality(mainHead, markerHead, fixture.root)).toMatchObject({ kind: "known", value: { equalTrees: true } })
    // Changed content is unequal without any integration claim.
    await fixture.write(checkout, "changed.txt", "different\n")
    await fixture.commitAll("change", checkout)
    expect(await observeTreeEquality(mainHead, "feat/trees", fixture.root)).toMatchObject({ kind: "known", value: { equalTrees: false } })
  })

  test("unresolvable refs are unknown", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    expect((await observeTreeEquality("nope", "main", fixture.root)).kind).toBe("unknown")
  })
})

describe("observeExecutionActivity", () => {
  test("no runs at all is known-empty with the runs root relocated", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "quiet", branch: "feat/quiet" }] })
    fixtures.push(fixture)
    const previousHome = process.env.CONVOY_HOME
    const { mkdtemp } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const emptyHome = await mkdtemp(`${tmpdir()}/convoy-home-`)
    process.env.CONVOY_HOME = emptyHome
    try {
      const observed = await observeExecutionActivity(fixture.worktrees["quiet"]!)
      expect(observed).toEqual({ kind: "known", value: { liveRunIds: [], total: 0 }, collectedAt: expect.any(Number) })
    } finally {
      process.env.CONVOY_HOME = previousHome
      await import("node:fs/promises").then((fs) => fs.rm(emptyHome, { recursive: true, force: true }))
    }
  })
})

describe("observeWriterClaim", () => {
  /** The fixture repo's absolute common dir, where the shared claims live. */
  async function commonDirOf(fixture: FixtureRepo): Promise<string> {
    return (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
  }

  /** Writes one writer-claim record keyed by the branch (separators escaped). */
  async function writeClaim(fixture: FixtureRepo, branch: string, record: Record<string, unknown>): Promise<void> {
    await fixture.write(await commonDirOf(fixture), `convoy/writer-claims/${branch.replace(/\//g, "__")}.json`, JSON.stringify(record))
  }

  test("a missing claim is an honest none, never unknown", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "free", branch: "feat/free" }] })
    fixtures.push(fixture)
    const observed = await observeWriterClaim({ commonDir: await commonDirOf(fixture), branch: "feat/free" })
    expect(observed).toMatchObject({ kind: "known", value: undefined })
  })

  test("a live claim exposes kind, owner, and liveness", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "live", branch: "feat/live" }] })
    fixtures.push(fixture)
    await writeClaim(fixture, "feat/live", {
      schemaVersion: 1,
      branch: "feat/live",
      checkoutPath: fixture.worktrees["live"]!,
      kind: "authoring",
      owner: "ses_test",
      pid: process.pid,
      startedAt: Date.now() - 1_000,
      heartbeatAt: Date.now(),
    })
    expect(await observeWriterClaim({ commonDir: await commonDirOf(fixture), branch: "feat/live" })).toMatchObject({
      kind: "known",
      value: { kind: "authoring", owner: "ses_test", liveness: "live" },
    })
  })

  test("a dead writer past the freshness window is stale, not live", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "stale", branch: "feat/stale" }] })
    fixtures.push(fixture)
    await writeClaim(fixture, "feat/stale", {
      schemaVersion: 1,
      branch: "feat/stale",
      checkoutPath: fixture.worktrees["stale"]!,
      kind: "pipeline",
      pid: 999_999,
      startedAt: Date.now() - 3_600_000,
      heartbeatAt: Date.now() - 3_600_000,
    })
    expect(await observeWriterClaim({ commonDir: await commonDirOf(fixture), branch: "feat/stale" })).toMatchObject({
      kind: "known",
      value: { kind: "pipeline", liveness: "stale" },
    })
  })

  test("an unreadable claim is unknown, never free", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "corrupt", branch: "feat/corrupt" }] })
    fixtures.push(fixture)
    await fixture.write(await commonDirOf(fixture), "convoy/writer-claims/feat__corrupt.json", "{ not json")
    const observed = await observeWriterClaim({ commonDir: await commonDirOf(fixture), branch: "feat/corrupt" })
    expect(observed.kind).toBe("unknown")
    if (observed.kind === "unknown") expect(observed.reason).toBeTruthy()
  })

  test("a detached checkout and an unresolved common dir are typed, not crashes", async () => {
    expect(await observeWriterClaim({ commonDir: "/tmp/nowhere/.git", branch: undefined })).toMatchObject({ kind: "known", value: undefined })
    expect((await observeWriterClaim({ commonDir: undefined, branch: "feat/x" })).kind).toBe("unknown")
  })
})
