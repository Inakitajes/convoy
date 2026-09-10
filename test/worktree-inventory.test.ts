import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"

import { createFixtureRepo, type FixtureRepo } from "./helpers/multi-worktree"
import { findEntryForCheckout, listWorktrees, parseWorktreeInventory } from "../src/worktree-inventory"

/**
 * Task 1.2: one `git worktree list --porcelain -z` inventory covering main,
 * external, detached, locked, inaccessible/prunable entries, unusual paths,
 * and checkouts without OpenSpec files.
 */

const fixtures: FixtureRepo[] = []
const scratch: string[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true }).catch(() => {})
})

describe("parseWorktreeInventory (pure parser)", () => {
  test("parses main, branch, detached, locked-with-reason, and prunable records", () => {
    const zOutput = [
      "worktree /repo/main", "HEAD 1111111111111111111111111111111111111111", "branch refs/heads/main", "",
      "worktree /repo/feature", "HEAD 2222222222222222222222222222222222222222", "branch refs/heads/feat/widget", "",
      "worktree /repo/detached", "HEAD 3333333333333333333333333333333333333333", "detached", "",
      "worktree /repo/locked", "HEAD 4444444444444444444444444444444444444444", "branch refs/heads/locked", "locked held by operator", "",
      "worktree /repo/gone", "HEAD 5555555555555555555555555555555555555555", "branch refs/heads/gone", "prunable gitdir file points to non-existent location", "",
      "",
    ].join("\0")

    const entries = parseWorktreeInventory(zOutput)
    expect(entries).toHaveLength(5)
    expect(entries[0]).toMatchObject({ path: "/repo/main", head: "1111111111111111111111111111111111111111", branch: "main" })
    expect(entries[1]).toMatchObject({ path: "/repo/feature", branch: "feat/widget" })
    expect(entries[2]).toMatchObject({ path: "/repo/detached", detached: true })
    expect(entries[2]!.branch).toBeUndefined()
    expect(entries[3]).toMatchObject({ path: "/repo/locked", locked: { reason: "held by operator" } })
    expect(entries[4]).toMatchObject({ path: "/repo/gone", prunable: { reason: "gitdir file points to non-existent location" } })
    // Accessibility is not the parser's call: entries from canned output carry the default.
    for (const entry of entries) expect(entry.accessible).toBe(false)
  })

  test("empty locked/prunable reasons parse without swallowing the next record", () => {
    const zOutput = ["worktree /repo/a", "HEAD 1111111111111111111111111111111111111111", "branch refs/heads/a", "locked", "", "worktree /repo/b", "HEAD 2222222222222222222222222222222222222222", "branch refs/heads/b", ""].join("\0")
    const entries = parseWorktreeInventory(zOutput)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.locked).toEqual({ reason: undefined })
    expect(entries[1]).toMatchObject({ path: "/repo/b", branch: "b" })
  })

  test("records containing newlines inside a reason stay one record in -z mode", () => {
    const zOutput = "worktree /repo/locked\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/x\0locked held by ci\nsecond line\0\0"
    const entries = parseWorktreeInventory(zOutput)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.locked).toEqual({ reason: "held by ci\nsecond line" })
  })

  test("bare and bare-with-locked records are metadata entries", () => {
    const zOutput = "worktree /srv/repo.git\0bare\0\0"
    const entries = parseWorktreeInventory(zOutput)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ path: "/srv/repo.git", bare: true })
  })

  test("an empty listing parses to no entries", () => {
    expect(parseWorktreeInventory("")).toEqual([])
  })
})

describe("listWorktrees (live Git inventory)", () => {
  test("enumerates main, external (with spaces), detached, locked, and spec-less checkouts", async () => {
    const fixture = await createFixtureRepo({
      worktrees: [
        { name: "external wt", branch: "feat/spaces" },
        { name: "detached", detach: true },
        { name: "locked", lock: "held for the test" },
      ],
    })
    fixtures.push(fixture)

    const inventory = await listWorktrees(fixture.root)
    expect(inventory.commonDir).toContain("/.git")

    const main = inventory.entries[0]!
    expect(main.branch).toBe("main")
    expect(main.accessible).toBe(true)
    expect(main.gitDir).toContain("/.git")

    const external = inventory.entries.find((entry) => entry.path.endsWith("external wt"))!
    expect(external).toMatchObject({ branch: "feat/spaces", accessible: true })
    // The admin directory is resolved from the checkout's own .git file.
    expect(external.gitDir).toContain("worktrees")
    expect(await Bun.file(join(external.path, "openspec")).exists()).toBe(false)

    const detached = inventory.entries.find((entry) => entry.path.endsWith("detached"))!
    expect(detached).toMatchObject({ detached: true, accessible: true })
    expect(detached.branch).toBeUndefined()

    const locked = inventory.entries.find((entry) => entry.path.endsWith("locked"))!
    expect(locked).toMatchObject({ locked: { reason: "held for the test" }, accessible: true })
  })

  test("a checkout removed outside Git stays a visible prunable entry, not a tombstone or an error", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "removed-later", removeAfterCreate: true }] })
    fixtures.push(fixture)

    const inventory = await listWorktrees(fixture.root)
    const stale = inventory.entries.find((entry) => entry.path.endsWith("removed-later"))
    expect(stale).toBeDefined()
    expect(stale!.accessible).toBe(false)
    expect(stale!.branch).toBe("removed-later")
    expect(stale!.prunable).toBeDefined()
  })

  test("findEntryForCheckout matches physically (symlinked /private forms on macOS)", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "one", branch: "feat/one" }] })
    fixtures.push(fixture)
    const inventory = await listWorktrees(fixture.root)
    const found = await findEntryForCheckout(inventory, fixture.worktrees["one"]!)
    expect(found).toMatchObject({ branch: "feat/one" })
  })

  test("throws outside a repository instead of inventing an empty inventory", async () => {
    const outside = join(await import("node:os").then((os) => os.tmpdir()), `convoy-not-a-repo-${Date.now()}`)
    scratch.push(outside)
    await rm(outside, { recursive: true, force: true }).catch(() => {})
    await import("node:fs/promises").then((fs) => fs.mkdir(outside, { recursive: true }))
    await expect(listWorktrees(outside)).rejects.toThrow()
  })
})
