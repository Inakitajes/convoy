import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { exec as execCb } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { createFixtureRepo, type FixtureRepo } from "./helpers/multi-worktree"
import { observeCheckoutTarget, observeRelation, requireAgreeingSelectors, validateCheckoutTarget } from "../src/worktree-target"

/**
 * Task 1.3: observed checkout targets and fresh-target validation. Targets
 * carry no minted identifiers; every disagreement (external move, path
 * reuse, repository replacement, branch/HEAD change) stops with a reason
 * instead of silently accepting a replacement.
 */

const exec = promisify(execCb)
const fixtures: FixtureRepo[] = []
const scratch: string[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true }).catch(() => {})
})

afterAll(async () => {
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true }).catch(() => {})
})

describe("observeCheckoutTarget", () => {
  test("observes the checkout from Git: path, admin dir, common dir, branch, HEAD", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "one", branch: "feat/one" }] })
    fixtures.push(fixture)
    const target = await observeCheckoutTarget(fixture.worktrees["one"]!)
    expect(target.branch).toBe("feat/one")
    expect(target.detached).toBe(false)
    expect(target.head).toMatch(/^[0-9a-f]{40}$/)
    expect(target.gitDir).toContain(join("worktrees", "one"))
    expect(target.commonDir).toBe((await observeCheckoutTarget(fixture.root)).commonDir)
  })

  test("a detached checkout observes detached without a branch", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "det", detach: true }] })
    fixtures.push(fixture)
    const target = await observeCheckoutTarget(fixture.worktrees["det"]!)
    expect(target.detached).toBe(true)
    expect(target.branch).toBeUndefined()
    expect(target.head).toBeDefined()
  })

  test("missing path and non-repository directory throw instead of fabricating targets", async () => {
    const missing = join(tmpdir(), `convoy-missing-${Date.now()}`)
    await expect(observeCheckoutTarget(missing)).rejects.toThrow("does not exist")
    const plain = await mkdtemp(join(tmpdir(), "convoy-plain-"))
    scratch.push(plain)
    await expect(observeCheckoutTarget(plain)).rejects.toThrow("not a git repository")
  })
})

describe("validateCheckoutTarget", () => {
  test("passes while nothing changed and reports the fresh observation", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "stable", branch: "feat/stable" }] })
    fixtures.push(fixture)
    const observed = await observeCheckoutTarget(fixture.worktrees["stable"]!)
    const result = await validateCheckoutTarget(observed)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.target.head).toBe(observed.head)
  })

  test("an external worktree move is refused as moved, not re-targeted", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "mover", branch: "feat/mover" }] })
    fixtures.push(fixture)
    const observed = await observeCheckoutTarget(fixture.worktrees["mover"]!)
    const moved = `${fixture.worktrees["mover"]}-moved`
    await exec(`git worktree move "${fixture.worktrees["mover"]}" "${moved}"`, { cwd: fixture.root })
    const result = await validateCheckoutTarget(observed)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("missing")
  })

  test("a branch switch after review is refused as branch-changed", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "switcher", branch: "feat/switcher" }] })
    fixtures.push(fixture)
    const observed = await observeCheckoutTarget(fixture.worktrees["switcher"]!)
    await exec(`git -C "${fixture.worktrees["switcher"]}" checkout --detach HEAD`, {})
    await exec(`git -C "${fixture.worktrees["switcher"]}" checkout -b feat/other`, {})
    const result = await validateCheckoutTarget(observed)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("branch-changed")
  })

  test("a HEAD advance after review is refused as head-changed", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "advancer", branch: "feat/advancer" }] })
    fixtures.push(fixture)
    const observed = await observeCheckoutTarget(fixture.worktrees["advancer"]!)
    await fixture.write(fixture.worktrees["advancer"]!, "change.txt", "new\n")
    await fixture.commitAll("advance", fixture.worktrees["advancer"]!)
    const result = await validateCheckoutTarget(observed)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("head-changed")
  })

  test("detached ↔ attached transitions are state changes, not branch matches", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "flip", detach: true }] })
    fixtures.push(fixture)
    const detached = await observeCheckoutTarget(fixture.worktrees["flip"]!)
    await exec(`git -C "${fixture.worktrees["flip"]}" checkout -b feat/flipped`, {})
    const nowAttached = await validateCheckoutTarget(detached)
    expect(nowAttached.ok).toBe(false)
    if (!nowAttached.ok) expect(nowAttached.code).toBe("state-changed")

    const attachedObserved = await observeCheckoutTarget(fixture.worktrees["flip"]!)
    await exec(`git -C "${fixture.worktrees["flip"]}" checkout --detach HEAD`, {})
    const nowDetached = await validateCheckoutTarget(attachedObserved)
    expect(nowDetached.ok).toBe(false)
    if (!nowDetached.ok) expect(nowDetached.code).toBe("state-changed")
  })

  test("a reused path hosting another repository is refused as a different repository", async () => {
    const host = await mkdtemp(join(tmpdir(), "convoy-reuse-"))
    scratch.push(host)
    const checkout = join(host, "wt")
    const other = join(host, "other-repo")
    await exec(`git init -q "${other}"`, {})
    await exec(`git -C "${other}" config user.email t@t`, {})
    await exec(`git -C "${other}" config user.name t`, {})
    await writeFile(join(other, "seed.txt"), "seed\n")
    await exec(`git -C "${other}" add -A`, {})
    await exec(`git -C "${other}" commit -qm seed`, {})
    await exec(`git -C "${other}" worktree add -b feat/reused "${checkout}" HEAD`, {})
    const observed = await observeCheckoutTarget(checkout)
    // Replace the registration with a worktree of a third repository.
    const third = join(host, "third-repo")
    await exec(`git -C "${other}" worktree remove "${checkout}"`, {})
    await exec(`git init -q "${third}"`, {})
    await exec(`git -C "${third}" config user.email t@t`, {})
    await exec(`git -C "${third}" config user.name t`, {})
    await writeFile(join(third, "seed.txt"), "seed\n")
    await exec(`git -C "${third}" add -A`, {})
    await exec(`git -C "${third}" commit -qm seed`, {})
    await exec(`git -C "${third}" worktree add -b feat/reused "${checkout}" HEAD`, {})
    const result = await validateCheckoutTarget(observed)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("different-repository")
  })

  test("requireBranch/requireHead pin the reviewed selectors at validation time", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "pinned", branch: "feat/pinned" }] })
    fixtures.push(fixture)
    const observed = await observeCheckoutTarget(fixture.worktrees["pinned"]!)
    expect((await validateCheckoutTarget(observed, { requireBranch: "feat/pinned" })).ok).toBe(true)
    const wrong = await validateCheckoutTarget(observed, { requireBranch: "feat/other" })
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.code).toBe("branch-changed")
    const staleHead = await validateCheckoutTarget(observed, { requireHead: `${observed.head!.slice(0, 39)}0`.padEnd(40, "0") })
    expect(staleHead.ok).toBe(false)
    if (!staleHead.ok) expect(staleHead.code).toBe("head-changed")
  })
})

describe("requireAgreeingSelectors", () => {
  test("a path and branch that agree observe one target", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "agree", branch: "feat/agree" }] })
    fixtures.push(fixture)
    const result = await requireAgreeingSelectors({ checkoutPath: fixture.worktrees["agree"], branch: "feat/agree" })
    expect(result.ok).toBe(true)
  })

  test("disagreeing selectors stop instead of trusting either one", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "clash", branch: "feat/clash" }] })
    fixtures.push(fixture)
    const result = await requireAgreeingSelectors({ checkoutPath: fixture.worktrees["clash"], branch: "feat/elsewhere" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("disagree")
  })

  test("a branch selector resolves through the Git inventory, not a path template", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "bybranch", branch: "type/bybranch" }] })
    fixtures.push(fixture)
    const result = await requireAgreeingSelectors({ branch: "type/bybranch", commonDir: (await observeCheckoutTarget(fixture.root)).commonDir })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.target.checkoutPath).toContain("bybranch")
  })

  test("no selectors at all is a refusal, not a guess", async () => {
    const result = await requireAgreeingSelectors({})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("no target")
  })
})

describe("observeRelation", () => {
  test("base containment and tree equality are separate facts", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "rel", branch: "feat/rel" }] })
    fixtures.push(fixture)
    const target = await observeCheckoutTarget(fixture.worktrees["rel"]!)
    // tip == base right after creation: contained and equal.
    const equal = await observeRelation(target.head!, target.head!, fixture.root)
    expect(equal).toMatchObject({ containedInBase: true, equalTrees: true })
    // Advance the worktree: still contained in base, trees differ.
    await fixture.write(fixture.worktrees["rel"]!, "new.txt", "x\n")
    await fixture.commitAll("advance", fixture.worktrees["rel"]!)
    const advanced = await observeCheckoutTarget(fixture.worktrees["rel"]!)
    const diverged = await observeRelation(advanced.head!, target.head!, fixture.root)
    expect(diverged).toMatchObject({ containedInBase: false, equalTrees: false })
  })
})
