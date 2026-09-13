import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { boardCacheKey, boardCachePath, loadBoardSnapshot, saveBoardSnapshot, snapshotMateriallyChanged, type BoardSnapshot } from "../src/board-cache"
import { repoCommonDir } from "../src/repo-store"
import { createFixtureRepo, type FixtureRepo } from "./helpers/multi-worktree"

/**
 * The repository-scoped board cache (change `live-board-cache-and-refresh`,
 * tasks 1.1–1.3): keyed by the realpath'd Git common dir, versioned, written
 * atomically, and disposable — every unreadable state simply means "no cache".
 */

const fixtures: FixtureRepo[] = []
const dirs: string[] = []
let previousHome: string | undefined
let home: string

beforeAll(async () => {
  previousHome = process.env.CONVOY_HOME
  home = await mkdtemp(join(tmpdir(), "convoy-board-cache-"))
  process.env.CONVOY_HOME = home
})

afterAll(async () => {
  await Promise.all(fixtures.map((fixture) => fixture.cleanup()))
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  await rm(home, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.CONVOY_HOME
  else process.env.CONVOY_HOME = previousHome
})

function snapshot(commonDir: string, overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    schemaVersion: 1,
    repoKey: boardCacheKey(commonDir),
    commonDir,
    builtAt: 1_000,
    board: { worktrees: [] },
    fingerprints: {},
    runsFingerprint: "runs-1",
    ...overrides,
  }
}

describe("board cache key", () => {
  test("is stable across worktrees of one repository and differs between clones", async () => {
    const repo = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/wt" }] })
    fixtures.push(repo)
    const main = await repoCommonDir(repo.root)
    const linked = await repoCommonDir(repo.worktrees["wt"]!)
    expect(main).toBeTruthy()
    expect(linked).toBeTruthy()
    expect(boardCacheKey(main!)).toBe(boardCacheKey(linked!))

    const other = await createFixtureRepo()
    fixtures.push(other)
    const otherCommon = await repoCommonDir(other.root)
    expect(boardCacheKey(otherCommon!)).not.toBe(boardCacheKey(main!))
  })
})

describe("loadBoardSnapshot", () => {
  test("missing, corrupt, unsupported, and unreadable all mean no cache and never throw", async () => {
    const commonDir = join(home, "clone", ".git")
    const path = boardCachePath(commonDir)
    expect(await loadBoardSnapshot(commonDir)).toBeUndefined()

    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, "{ this is not json")
    expect(await loadBoardSnapshot(commonDir)).toBeUndefined()

    await writeFile(path, JSON.stringify({ schemaVersion: 99, repoKey: "x", commonDir, builtAt: 1, board: { worktrees: [] }, fingerprints: {} }))
    expect(await loadBoardSnapshot(commonDir)).toBeUndefined()

    await rm(path, { force: true })
    await mkdir(path, { recursive: true })
    expect(await loadBoardSnapshot(commonDir)).toBeUndefined()
  })

  test("a supported snapshot round-trips through the atomic writer", async () => {
    const commonDir = join(home, "clone2", ".git")
    const saved = snapshot(commonDir, { fingerprints: { "/wt": "fp-1" } })
    expect(await saveBoardSnapshot(saved)).toBe(true)
    expect(await loadBoardSnapshot(commonDir)).toEqual(saved)
  })
})

describe("saveBoardSnapshot", () => {
  test("an unchanged snapshot writes nothing", async () => {
    const commonDir = join(home, "clone3", ".git")
    const prior = snapshot(commonDir)
    await saveBoardSnapshot(prior)
    const path = boardCachePath(commonDir)
    const before = (await stat(path)).mtimeMs
    await Bun.sleep(20)
    // A later cycle's snapshot with a new builtAt but identical board facts is
    // not a material change: the cache must not churn.
    expect(await saveBoardSnapshot({ ...prior, builtAt: prior.builtAt + 5_000 }, prior)).toBe(false)
    expect((await stat(path)).mtimeMs).toBe(before)
    expect(snapshotMateriallyChanged({ ...prior, builtAt: prior.builtAt + 5_000 }, prior)).toBe(false)
    expect(snapshotMateriallyChanged({ ...prior, board: { worktrees: [{ path: "/x" } as never] } }, prior)).toBe(true)
  })

  test("an idle re-probe with fresh collection times is not a material change", async () => {
    const commonDir = join(home, "clone3b", ".git")
    const before = snapshot(commonDir, {
      board: { worktrees: [{ path: "/wt", detached: false, main: false, bare: false, accessible: true, changes: [], dirt: { kind: "known", value: { dirty: false, fileCount: 0 }, collectedAt: 1_000 } }] },
    })
    const after = {
      ...before,
      builtAt: before.builtAt + 5_000,
      board: { worktrees: [{ ...before.board.worktrees[0]!, dirt: { kind: "known" as const, value: { dirty: false, fileCount: 0 }, collectedAt: 9_000 } }] },
    }
    expect(snapshotMateriallyChanged(after, before)).toBe(false)
    await saveBoardSnapshot(before)
    const path = boardCachePath(commonDir)
    const mtime = (await stat(path)).mtimeMs
    await Bun.sleep(20)
    expect(await saveBoardSnapshot(after, before)).toBe(false)
    expect((await stat(path)).mtimeMs).toBe(mtime)
  })

  test("a cached unknown observation stays unknown with its reason", async () => {
    const commonDir = join(home, "clone-unknown", ".git")
    const saved = snapshot(commonDir, {
      board: {
        worktrees: [
          {
            path: "/wt/unknown",
            detached: false,
            main: false,
            bare: false,
            accessible: true,
            changes: [],
            dirt: { kind: "unknown", reason: "git status timed out", collectedAt: 1_000 },
            upstream: { kind: "unknown", reason: "no upstream configured", collectedAt: 1_000 },
          },
        ],
      },
    })
    await saveBoardSnapshot(saved)
    const loaded = await loadBoardSnapshot(commonDir)
    // The cache preserves the typed unknown fact and its reason rather than
    // collapsing it into a negative (clean/no-upstream) observation.
    expect(loaded?.board.worktrees[0]?.dirt).toEqual({ kind: "unknown", reason: "git status timed out", collectedAt: 1_000 })
    expect(loaded?.board.worktrees[0]?.upstream).toEqual({ kind: "unknown", reason: "no upstream configured", collectedAt: 1_000 })
    expect(loaded?.board.worktrees[0]?.dirt?.kind).toBe("unknown")
  })

  test("a crash mid-write leaves the previous cache intact", async () => {
    const commonDir = join(home, "clone4", ".git")
    const prior = snapshot(commonDir)
    await saveBoardSnapshot(prior)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const failing = snapshot(commonDir, { board: { worktrees: circular as never } })
    await expect(saveBoardSnapshot(failing)).rejects.toThrow()
    // The atomic temp+rename never exposes a torn record.
    expect(await loadBoardSnapshot(commonDir)).toEqual(prior)
  })
})
