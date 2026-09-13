import { afterAll, describe, expect, test } from "bun:test"

import { BoardSource, fingerprintCheckout } from "../src/board-refresh"
import type { ControlBoard } from "../src/control-board"
import type { BoardSnapshot } from "../src/board-cache"
import type { WorktreeInventory, WorktreeInventoryEntry } from "../src/worktree-inventory"
import { createFixtureRepo, type FixtureRepo } from "./helpers/multi-worktree"

/**
 * Fingerprint-gated refresh (change `live-board-cache-and-refresh`, tasks
 * 2.1–2.4): an unchanged cycle issues no OpenSpec task query and no
 * run-history read, `cached()` never assembles, and a slow older cycle cannot
 * overwrite a newer snapshot.
 */

const fixtures: FixtureRepo[] = []
afterAll(async () => {
  await Promise.all(fixtures.map((fixture) => fixture.cleanup()))
})

function entry(path: string): WorktreeInventoryEntry {
  return { path, branch: path.split("/").pop(), accessible: true }
}

function inventory(paths: string[]): WorktreeInventory {
  return { commonDir: "/repo/.git", entries: paths.map(entry) }
}

function board(paths: string[]): ControlBoard {
  return {
    worktrees: paths.map((path) => ({ path, detached: false, main: false, bare: false, accessible: true, changes: [] })),
  }
}

describe("fingerprintCheckout", () => {
  test("is stable when the OpenSpec tree is untouched and changes when content changes", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/wt" }] })
    fixtures.push(fixture)
    const checkout = fixture.worktrees["wt"]!
    const before = await fingerprintCheckout(checkout)
    expect(await fingerprintCheckout(checkout)).toBe(before)
    await fixture.write(checkout, "openspec/changes/add-widget/tasks.md", "# Tasks\n\n- [ ] one\n")
    const after = await fingerprintCheckout(checkout)
    expect(after).toBeTruthy()
    expect(after).not.toBe(before)
  })
})

describe("BoardSource", () => {
  test("cached() reads memory then disk and never assembles", async () => {
    let assembleCalls = 0
    const disk: BoardSnapshot = {
      schemaVersion: 1,
      repoKey: "k",
      commonDir: "/repo/.git",
      builtAt: 42,
      board: board(["/a"]),
      fingerprints: {},
    }
    const source = new BoardSource({
      targetDir: "/repo",
      commonDir: async () => "/repo/.git",
      load: async () => disk,
      assemble: async () => {
        assembleCalls++
        return board(["/a"])
      },
    })
    expect(await source.cached()).toEqual(disk)
    expect(assembleCalls).toBe(0)
  })

  test("an unchanged cycle skips the run-history read and reuses prior artifacts", async () => {
    let listRunsCalls = 0
    let assembleOptions: Record<string, unknown> | undefined
    const source = new BoardSource({
      targetDir: "/repo",
      commonDir: async () => "/repo/.git",
      inventory: async () => inventory(["/a", "/b"]),
      fingerprintCheckout: async () => "fp-constant",
      fingerprintRuns: async () => "runs-constant",
      listRuns: async () => {
        listRunsCalls++
        return []
      },
      load: async () => undefined,
      save: async () => true,
      assemble: async (_dir, options) => {
        assembleOptions = options as Record<string, unknown>
        return board(["/a", "/b"])
      },
    })
    // Cold cycle: one shared run-history read, no reuse.
    await source.refresh()
    expect(listRunsCalls).toBe(1)
    expect(assembleOptions?.skipRunHistory).toBeUndefined()
    // Idle cycle: same fingerprint -> no second read, reuse requested.
    await source.refresh()
    expect(listRunsCalls).toBe(1)
    expect(assembleOptions?.skipRunHistory).toBe(true)
    expect(assembleOptions?.reuse).toBeTruthy()
  })

  test("a forced refresh invalidates the fingerprint gate and recomputes", async () => {
    let listRunsCalls = 0
    let assembleOptions: Record<string, unknown> | undefined
    const source = new BoardSource({
      targetDir: "/repo",
      commonDir: async () => "/repo/.git",
      inventory: async () => inventory(["/a"]),
      fingerprintCheckout: async () => "fp-constant",
      fingerprintRuns: async () => "runs-constant",
      listRuns: async () => {
        listRunsCalls++
        return []
      },
      load: async () => undefined,
      save: async () => true,
      assemble: async (_dir, options) => {
        assembleOptions = options as Record<string, unknown>
        return board(["/a"])
      },
    })
    await source.refresh()
    await source.refresh()
    expect(listRunsCalls).toBe(1)
    await source.refresh({ force: true })
    expect(listRunsCalls).toBe(2)
    expect(assembleOptions?.skipRunHistory).toBeUndefined()
    expect(assembleOptions?.reuse).toBeUndefined()
  })

  test("a slow older cycle cannot overwrite a newer snapshot", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => (release = resolveGate))
    let call = 0
    const source = new BoardSource({
      targetDir: "/repo",
      commonDir: async () => "/repo/.git",
      inventory: async () => inventory(["/a"]),
      fingerprintCheckout: async () => "fp",
      fingerprintRuns: async () => "runs",
      listRuns: async () => [],
      load: async () => undefined,
      save: async () => true,
      assemble: async () => {
        call++
        if (call === 1) {
          await gate
          return board(["/old"])
        }
        return board(["/new"])
      },
    })
    const first = source.refresh()
    await Bun.sleep(5)
    await source.refresh()
    release()
    const firstResult = await first
    expect(source.current()?.board.worktrees[0]?.path).toBe("/new")
    expect(firstResult.refreshed).toBe(false)
  })

  test("a failed refresh retains the last snapshot and discloses the failure", async () => {
    let call = 0
    const source = new BoardSource({
      targetDir: "/repo",
      commonDir: async () => "/repo/.git",
      inventory: async () => inventory(["/a"]),
      fingerprintCheckout: async () => "fp",
      fingerprintRuns: async () => "runs",
      listRuns: async () => [],
      load: async () => undefined,
      save: async () => true,
      assemble: async () => {
        call++
        if (call === 1) return board(["/a"])
        throw new Error("git unreadable")
      },
    })
    await source.refresh()
    const result = await source.refresh()
    expect(result.refreshed).toBe(false)
    expect(result.error).toContain("git unreadable")
    expect(source.current()?.board.worktrees[0]?.path).toBe("/a")
    expect(source.lastError()).toContain("git unreadable")
  })
})
