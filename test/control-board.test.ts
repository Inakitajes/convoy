import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

import { assembleControlBoard, openspecTaskCounts, worktreeDisplayName } from "../src/control-board"
import { PrCache } from "../src/pr-observations"
import { createFixtureRepo, type FixtureRepo } from "./helpers/multi-worktree"

const cleanupDirs: string[] = []

/**
 * The inventory reports physical paths; /tmp and /var are symlinks on macOS.
 * Tolerates stale registrations whose directory no longer exists by resolving
 * the nearest existing ancestor instead.
 */
async function physical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return join(await physical(dirname(path)), basename(path))
  }
}

afterAll(async () => {
  await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

/**
 * The worktree-rooted board (change `worktree-control-center`, tasks 3.1–3.3;
 * gaps CC-1/CC-2): every Git-registered checkout is a root entry with its own
 * local changes as children, and every fact is an independent observation.
 * There is no lifecycle stage, no feature registry consult, and no
 * cross-checkout ownership — these tests pin the retirement as well as the
 * new shape.
 */

describe("assembleControlBoard", () => {
  test("every registered checkout is a root entry, including spec-less and detached ones", async () => {
    const fixture = await createFixtureRepo({
      worktrees: [
        { name: "spec-less", branch: "feat/plain" },
        { name: "detached-wt", detach: true },
      ],
    })
    fixtures.push(fixture)
    const board = await assembleControlBoard(fixture.root)
    expect(board.worktrees).toHaveLength(3)
    expect(board.worktrees[0]!.main).toBe(true)
    const paths = await Promise.all(board.worktrees.map((worktree) => worktree.path))
    expect(paths).toContain(await physical(fixture.worktrees["spec-less"]!))
    const detachedPath = await physical(fixture.worktrees["detached-wt"]!)
    const detached = board.worktrees.find((worktree) => worktree.path === detachedPath)
    expect(detached?.detached).toBe(true)
    // No adoption prompts, no lifecycle stages anywhere on the rows.
    expect(JSON.stringify(board)).not.toMatch(/adopt/i)
    expect(JSON.stringify(board)).not.toMatch(/"stage"/)
  })

  test("local changes are children of their containing checkout; same-id copies stay independent", async () => {
    const fixture = await createFixtureRepo({
      worktrees: [{ name: "wt", branch: "feat/widget" }],
    })
    fixtures.push(fixture)
    const wt = fixture.worktrees["wt"]!
    await fixture.write(wt, "openspec/changes/add-widget/proposal.md", "# Worktree copy\n")
    await fixture.write(fixture.root, "openspec/changes/add-widget/proposal.md", "# Main copy\n")
    const board = await assembleControlBoard(fixture.root)
    const copies = board.worktrees.flatMap((worktree) => worktree.changes).filter((change) => change.changeId === "add-widget")
    expect(copies).toHaveLength(2)
    const titles = copies.map((change) => change.title).sort()
    expect(titles).toEqual(["Main copy", "Worktree copy"])
    // Each copy is keyed to its own checkout.
    for (const change of copies) {
      expect(change.checkout).toBeTruthy()
      expect(change.sourcePath.startsWith(change.checkout)).toBe(true)
    }
  })

  test("a husk copy lists by id with no fabricated task counts", async () => {
    const fixture = await createFixtureRepo({
      worktrees: [{ name: "wt", branch: "feat/widget" }],
    })
    fixtures.push(fixture)
    const wt = fixture.worktrees["wt"]!
    await mkdir(join(wt, "openspec", "changes", "add-widget"), { recursive: true })
    const board = await assembleControlBoard(fixture.root)
    const husk = board.worktrees.flatMap((worktree) => worktree.changes).find((change) => change.changeId === "add-widget")
    expect(husk).toBeDefined()
    expect(husk!.hasMarkdown).toBe(false)
    expect(husk!.tasks).toBeUndefined()
    expect(husk!.title).toBeUndefined()
  })

  test("an inaccessible registration stays visible with its condition, never a missing feature", async () => {
    const fixture = await createFixtureRepo({
      worktrees: [{ name: "gone", branch: "feat/gone", removeAfterCreate: true }],
    })
    fixtures.push(fixture)
    const board = await assembleControlBoard(fixture.root)
    const gonePath = await physical(fixture.worktrees["gone"]!)
    const gone = board.worktrees.find((worktree) => worktree.path === gonePath)
    expect(gone).toBeDefined()
    expect(gone!.accessible).toBe(false)
  })

  test("dirt and activity are independent observations; unknown is never clean", async () => {
    const fixture = await createFixtureRepo({
      worktrees: [{ name: "wt", branch: "feat/widget" }],
    })
    fixtures.push(fixture)
    const wt = fixture.worktrees["wt"]!
    await fixture.write(wt, "uncommitted.txt", "dirty\n")
    const board = await assembleControlBoard(fixture.root)
    const wtPath = await physical(wt)
    const row = board.worktrees.find((worktree) => worktree.path === wtPath)!
    expect(row.dirt?.kind).toBe("known")
    if (row.dirt?.kind === "known") expect(row.dirt.value.dirty).toBe(true)
  })

  test("the detected base rides along for the divergence disclosures", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const board = await assembleControlBoard(fixture.root)
    expect(board.baseBranch).toBe("main")
  })

  test("the display name is the checkout folder basename", () => {
    expect(worktreeDisplayName({ path: "/wt/feat-add-foo", detached: false })).toBe("feat-add-foo")
    expect(worktreeDisplayName({ path: "/repo", detached: false })).toBe("repo")
  })
})

describe("board PR observations", () => {
  test("a failed PR lookup is unknown evidence, never absence or a merge claim", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/widget" }] })
    fixtures.push(fixture)
    const board = await assembleControlBoard(fixture.root, {
      base: "main",
      prAdapter: async () => ({ error: "gh: authentication failed" }),
      prCache: new PrCache(),
    })
    const row = board.worktrees.find((worktree) => worktree.branch === "feat/widget")!
    expect(row.pr).toBeDefined()
    expect(row.pr?.availability).toBe("unknown")
    if (row.pr?.availability === "unknown") expect(row.pr.reason).toMatch(/authentication failed/)
    // The row never renders the failure as a negative fact.
    expect(JSON.stringify(row.pr)).not.toMatch(/"availability":"known"/)
  })

  test("a merged PR is a fact about that PR, never a completion claim", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/widget" }] })
    fixtures.push(fixture)
    const board = await assembleControlBoard(fixture.root, {
      base: "main",
      prAdapter: async () => [{ number: 7, title: "Old work", url: "https://example.test/pr/7", state: "MERGED", headSha: "0000000000000000000000000000000000000000" }],
      prCache: new PrCache(),
    })
    const row = board.worktrees.find((worktree) => worktree.branch === "feat/widget")!
    expect(row.pr?.availability).toBe("known")
    if (row.pr?.availability === "known") {
      expect(row.pr.pr?.state).toBe("MERGED")
      expect(row.pr.pr?.number).toBe(7)
    }
    // No lifecycle vocabulary anywhere on the row: the merged state is a PR
    // fact, not an integrated/completed summary.
    expect(JSON.stringify(row)).not.toMatch(/completed|integrated/i)
  })

  test("a detached checkout's PR evidence is unknown, not absent", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "detached", detach: true }] })
    fixtures.push(fixture)
    const queriedBranches: string[] = []
    const board = await assembleControlBoard(fixture.root, {
      base: "main",
      prAdapter: async (query) => {
        queriedBranches.push(query.headBranch)
        return []
      },
      prCache: new PrCache(),
    })
    const row = board.worktrees.find((worktree) => worktree.detached)!
    expect(row.pr?.availability).toBe("unknown")
    if (row.pr?.availability === "unknown") expect(row.pr.reason).toMatch(/no attached branch/)
    // A detached checkout is never queried: it has no branch to scope one.
    expect(queriedBranches).toEqual(["main"])
  })
})

const fixtures: FixtureRepo[] = []

describe("openspecTaskCounts (shared read)", () => {
  test("counts checkboxes from tasks.md when the CLI is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-task-counts-"))
    cleanupDirs.push(dir)
    await mkdir(join(dir, "openspec", "changes", "add-widget"), { recursive: true })
    await writeFile(join(dir, "openspec", "changes", "add-widget", "tasks.md"), "# Tasks\n\n- [x] one\n- [ ] two\n- [x] three\n")
    const counts = await openspecTaskCounts(dir)
    expect(counts.get("add-widget")).toEqual({ done: 2, total: 3 })
  })
})
