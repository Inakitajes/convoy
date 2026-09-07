import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  assembleControlBoard,
  branchForChange,
  createBoardReads,
  hasUncommittedProposal,
  openspecTaskCounts,
  type BoardReads,
  type BoardRun,
  type BoardTasks,
  type BoardWorktree,
} from "../src/control-board"

const cleanupDirs: string[] = []

afterAll(async () => {
  await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const mainDir = "/repo"
const worktreeDir = "/wt/feat-add-foo"

function readsFixture(input: {
  worktrees?: BoardWorktree[]
  mainChanges?: string[]
  worktreeChanges?: string[]
  /** Per-worktree change ids, overriding `worktreeChanges` for that dir. */
  worktreeChangesByDir?: Record<string, string[]>
  /** Whether each (dir, id) change dir carries markdown; defaults to true. */
  markdown?: Record<string, Record<string, boolean>>
  /** Per-dir, per-id proposal title; defaults to `Title of <id>` so foreign copies can be told apart. */
  titles?: Record<string, Record<string, string>>
  tasks?: Record<string, Record<string, BoardTasks>>
  runs?: BoardRun[]
  status?: Record<string, string>
  synced?: boolean
  cherryClean?: boolean
  baseBranch?: string
  present?: boolean
  /** Checkout paths registered as a feature's current context. */
  registeredContextDirs?: string[]
}): BoardReads {
  const {
    worktrees = [
      { dir: mainDir, branch: "main", main: true },
      { dir: worktreeDir, branch: "feat/add-foo", main: false },
    ],
    mainChanges = [],
    worktreeChanges = ["add-foo"],
    worktreeChangesByDir = {},
    markdown = {},
    titles = {},
    tasks = {},
    runs = [],
    status = {},
    synced = true,
    cherryClean = true,
    baseBranch = "main",
    present = true,
    registeredContextDirs = [],
  } = input
  const idsFor = (dir: string) => worktreeChangesByDir[dir] ?? worktreeChanges
  return {
    worktrees: async () => worktrees,
    openspecPresent: async (dir) => (dir === mainDir ? present : idsFor(dir).length > 0),
    changeIds: async (dir) => (dir === mainDir ? mainChanges : idsFor(dir)),
    changeHasMarkdown: async (dir, id) => markdown[dir]?.[id] ?? true,
    changeTitle: async (dir, id) => titles[dir]?.[id] ?? `Title of ${id}`,
    taskCounts: async (dir) => new Map(Object.entries(tasks[dir] ?? {})),
    runs: async () => runs,
    status: async (dir) => status[dir] ?? "",
    contains: async () => synced,
    patchEquivalent: async () => cherryClean,
    baseBranch: async () => baseBranch,
    canonicalSpecs: async () => ["openspec/specs/specs-viewer/spec.md"],
    registeredContextDirs: async () => registeredContextDirs,
  }
}

/** Real-repo plumbing for the integration test below. */
async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "convoy-test",
      GIT_AUTHOR_EMAIL: "convoy-test@example.invalid",
      GIT_COMMITTER_NAME: "convoy-test",
      GIT_COMMITTER_EMAIL: "convoy-test@example.invalid",
    },
  })
  const stderr = await new Response(proc.stderr).text()
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`)
}

describe("branchForChange", () => {
  test("links a worktree branch whose id matches the change id (the shared resolver rule)", () => {
    expect(branchForChange("add-foo", "feat/add-foo")).toBe("feat/add-foo")
    expect(branchForChange("add-foo", "add-foo")).toBe("add-foo")
  })

  test("a renamed branch orphans the linkage so the row degrades without runs", () => {
    expect(branchForChange("add-foo", "feat/add-bar")).toBeUndefined()
    expect(branchForChange("add-foo", undefined)).toBeUndefined()
  })
})

describe("hasUncommittedProposal", () => {
  test("matches the exact proposal path in porcelain output", () => {
    const status = "?? openspec/changes/add-foo/proposal.md\n M src/cli.ts\n"
    expect(hasUncommittedProposal(status, "add-foo")).toBe(true)
    expect(hasUncommittedProposal(status, "add-bar")).toBe(false)
  })

  test("unrelated dirt and other change files never flip the marker", () => {
    expect(hasUncommittedProposal("?? openspec/changes/add-foo/design.md", "add-foo")).toBe(false)
    expect(hasUncommittedProposal("", "add-foo")).toBe(false)
  })
})

describe("assembleControlBoard", () => {
  test("a change in a worktree with two runs, one live, shows implementing", async () => {
    const runs: BoardRun[] = [
      { runID: "r1", branch: "feat/add-foo", live: false },
      { runID: "r2", branch: "feat/add-foo", live: true },
    ]
    const board = await assembleControlBoard(readsFixture({ runs }))
    expect(board.rows).toHaveLength(1)
    const row = board.rows[0]!
    expect(row.stage).toBe("implementing")
    expect(row.runs).toHaveLength(2)
    expect(row.liveRuns).toBe(1)
    expect(row.location).toBe("worktree")
    expect(row.branch).toBe("feat/add-foo")
    expect(row.synced).toBe(true)
  })

  test("a stranded change on main offers its own row", async () => {
    const board = await assembleControlBoard(readsFixture({ worktreeChanges: [], mainChanges: ["add-foo"] }))
    const row = board.rows[0]!
    expect(row.stage).toBe("stranded")
    expect(row.location).toBe("main")
    expect(row.worktreeDir).toBeUndefined()
  })

  test("tasks complete and a clean tree read as ready to close", async () => {
    const board = await assembleControlBoard(
      readsFixture({ tasks: { [worktreeDir]: { "add-foo": { done: 11, total: 11 } } } }),
    )
    expect(board.rows[0]!.stage).toBe("ready")
    expect(board.rows[0]!.tasks).toEqual({ done: 11, total: 11 })
  })

  test("incomplete tasks stay below ready even with runs recorded", async () => {
    const board = await assembleControlBoard(
      readsFixture({
        tasks: { [worktreeDir]: { "add-foo": { done: 8, total: 11 } } },
        runs: [{ runID: "r1", branch: "feat/add-foo", live: false }],
      }),
    )
    expect(board.rows[0]!.stage).toBe("implementing")
  })

  test("unsynced branch that is patch-equivalent reports probably merged", async () => {
    const board = await assembleControlBoard(readsFixture({ synced: false, cherryClean: true }))
    const row = board.rows[0]!
    expect(row.synced).toBe(false)
    expect(row.probablyMerged).toBe(true)
    expect(row.stage).toBe("probably-merged")
  })

  test("unsynced branch that is not patch-equivalent stays implementing", async () => {
    const board = await assembleControlBoard(readsFixture({ synced: false, cherryClean: false }))
    expect(board.rows[0]!.probablyMerged).toBe(false)
  })

  test("a renamed branch degrades the row: no runs, not synced, stranded signals kept", async () => {
    const worktrees: BoardWorktree[] = [
      { dir: mainDir, branch: "main", main: true },
      { dir: worktreeDir, branch: "feat/add-bar", main: false },
    ]
    const board = await assembleControlBoard(
      readsFixture({ worktrees, runs: [{ runID: "r1", branch: "feat/add-bar", live: false }] }),
    )
    const row = board.rows[0]!
    expect(row.branch).toBeUndefined()
    expect(row.runs).toHaveLength(0)
    expect(row.synced).toBeUndefined()
    expect(row.stage).toBe("proposing")
  })

  test("a worktree with runs but no change dir lands in worktrees-without-spec", async () => {
    const worktrees: BoardWorktree[] = [
      { dir: mainDir, branch: "main", main: true },
      { dir: "/wt/iso-run", branch: "feat/quick-fix", main: false },
    ]
    const board = await assembleControlBoard(
      readsFixture({
        worktrees,
        worktreeChanges: [],
        runs: [{ runID: "r1", branch: "feat/quick-fix", live: false }],
      }),
    )
    expect(board.rows).toHaveLength(0)
    expect(board.worktreesWithoutSpec).toEqual([{ dir: "/wt/iso-run", branch: "feat/quick-fix", runCount: 1 }])
  })

  test("an unassociated worktree with no change dir and no runs is still listed (delta: including those with no runs)", async () => {
    const worktrees: BoardWorktree[] = [
      { dir: mainDir, branch: "main", main: true },
      { dir: "/wt/empty", branch: "feat/nothing", main: false },
    ]
    const board = await assembleControlBoard(readsFixture({ worktrees, worktreeChanges: [] }))
    expect(board.worktreesWithoutSpec).toEqual([{ dir: "/wt/empty", branch: "feat/nothing", runCount: 0 }])
  })

  test("a registered feature's worktree is never downgraded to a specless worktree", async () => {
    const worktrees: BoardWorktree[] = [
      { dir: mainDir, branch: "main", main: true },
      { dir: "/wt/pre-proposal", branch: "feat/pre-proposal", main: false },
    ]
    const board = await assembleControlBoard(
      readsFixture({ worktrees, worktreeChanges: [], registeredContextDirs: ["/wt/pre-proposal"] }),
    )
    expect(board.worktreesWithoutSpec).toHaveLength(0)
  })

  test("the same change id prefers the worktree row over the stranded main copy", async () => {
    const board = await assembleControlBoard(readsFixture({ mainChanges: ["add-foo"] }))
    expect(board.rows).toHaveLength(1)
    expect(board.rows[0]!.location).toBe("worktree")
  })

  test("the uncommitted-proposal marker reflects the change's own checkout", async () => {
    const board = await assembleControlBoard(
      readsFixture({ status: { [worktreeDir]: "?? openspec/changes/add-foo/proposal.md\n" } }),
    )
    expect(board.rows[0]!.uncommittedProposal).toBe(true)
  })

  test("no worktrees at all answers an empty board instead of throwing", async () => {
    const board = await assembleControlBoard(readsFixture({ worktrees: [] }))
    expect(board.present).toBe(false)
    expect(board.rows).toEqual([])
  })

  test("canonical specs and base branch ride along for the view", async () => {
    const board = await assembleControlBoard(readsFixture({}))
    expect(board.specs).toEqual(["openspec/specs/specs-viewer/spec.md"])
    expect(board.baseBranch).toBe("main")
  })

  test("a run on feat/<id> links to the stranded main row even without a worktree", async () => {
    const board = await assembleControlBoard(
      readsFixture({
        worktreeChanges: [],
        mainChanges: ["add-foo"],
        runs: [{ runID: "r1", branch: "feat/add-foo", live: false }],
      }),
    )
    expect(board.rows[0]!.runs).toHaveLength(1)
    expect(board.rows[0]!.stage).toBe("implementing")
  })
})

describe("change rows resolve to the owning worktree", () => {
  const changeId = "specs-viewer-worktree-artifacts"
  const foreignDir = "/wt/feat-preflight-dirty-tree-in-launcher"
  const ownerDir = "/wt/feat-specs-viewer-worktree-artifacts"

  test("a husk in an earlier worktree cannot steal the row", async () => {
    const worktrees: BoardWorktree[] = [
      { dir: mainDir, branch: "main", main: true },
      { dir: foreignDir, branch: "feat/preflight-dirty-tree-in-launcher", main: false },
      { dir: ownerDir, branch: `feat/${changeId}`, main: false },
    ]
    const board = await assembleControlBoard(
      readsFixture({
        worktrees,
        worktreeChangesByDir: { [foreignDir]: [changeId], [ownerDir]: [changeId] },
        // The foreign listing is a husk: no markdown inside.
        markdown: { [foreignDir]: { [changeId]: false } },
        tasks: { [ownerDir]: { [changeId]: { done: 6, total: 6 } } },
        runs: [{ runID: "r1", branch: `feat/${changeId}`, live: false }],
      }),
    )
    expect(board.rows).toHaveLength(1)
    const row = board.rows[0]!
    expect(row.worktreeDir).toBe(ownerDir)
    expect(row.branch).toBe(`feat/${changeId}`)
    expect(row.tasks).toEqual({ done: 6, total: 6 })
    // Complete tasks in the owning worktree read ready to close, not implementing.
    expect(row.stage).toBe("ready")
    expect(row.runs).toHaveLength(1)
  })

  test("branch match outranks a fuller foreign copy", async () => {
    const worktrees: BoardWorktree[] = [
      { dir: mainDir, branch: "main", main: true },
      { dir: "/wt/feat-other", branch: "feat/other", main: false },
      { dir: worktreeDir, branch: "feat/add-foo", main: false },
    ]
    // Both copies bear markdown; only the later worktree's branch matches the id.
    const board = await assembleControlBoard(
      readsFixture({ worktrees, worktreeChangesByDir: { "/wt/feat-other": ["add-foo"] } }),
    )
    expect(board.rows).toHaveLength(1)
    const row = board.rows[0]!
    expect(row.worktreeDir).toBe(worktreeDir)
    expect(row.branch).toBe("feat/add-foo")
  })

  test("a markdown-bearing copy outranks an earlier husk when no branch matches", async () => {
    const worktrees: BoardWorktree[] = [
      { dir: mainDir, branch: "main", main: true },
      { dir: "/wt/feat-alpha", branch: "feat/alpha", main: false },
      { dir: "/wt/feat-beta", branch: "feat/beta", main: false },
    ]
    const board = await assembleControlBoard(
      readsFixture({
        worktrees,
        worktreeChangesByDir: { "/wt/feat-alpha": ["add-foo"], "/wt/feat-beta": ["add-foo"] },
        markdown: { "/wt/feat-alpha": { "add-foo": false } },
      }),
    )
    expect(board.rows).toHaveLength(1)
    const row = board.rows[0]!
    expect(row.worktreeDir).toBe("/wt/feat-beta")
    expect(row.branch).toBeUndefined()
  })

  test("husk-only candidates keep the row present, degraded from the first-listed candidate", async () => {
    const worktrees: BoardWorktree[] = [
      { dir: mainDir, branch: "main", main: true },
      { dir: "/wt/feat-alpha", branch: "feat/alpha", main: false },
      { dir: "/wt/feat-beta", branch: "feat/beta", main: false },
    ]
    const board = await assembleControlBoard(
      readsFixture({
        worktrees,
        worktreeChangesByDir: { "/wt/feat-alpha": ["add-foo"], "/wt/feat-beta": ["add-foo"] },
        markdown: {
          "/wt/feat-alpha": { "add-foo": false },
          "/wt/feat-beta": { "add-foo": false },
        },
        // Runs recorded against `feat/<id>` still link through the shared-id fallback.
        runs: [{ runID: "r1", branch: "feat/add-foo", live: false }],
      }),
    )
    expect(board.rows).toHaveLength(1)
    const row = board.rows[0]!
    expect(row.worktreeDir).toBe("/wt/feat-alpha")
    expect(row.branch).toBeUndefined()
    expect(row.tasks).toBeUndefined()
    expect(row.runs).toHaveLength(1)
    expect(row.stage).toBe("implementing")
  })

  test("single-copy rows keep today's facts and walk order", async () => {
    const worktrees: BoardWorktree[] = [
      { dir: mainDir, branch: "main", main: true },
      { dir: "/wt/feat-alpha", branch: "feat/alpha", main: false },
      { dir: "/wt/feat-beta", branch: "feat/beta", main: false },
    ]
    const board = await assembleControlBoard(
      readsFixture({
        worktrees,
        worktreeChangesByDir: { "/wt/feat-alpha": ["alpha"], "/wt/feat-beta": ["beta"] },
        mainChanges: ["on-main"],
        tasks: {
          "/wt/feat-alpha": { alpha: { done: 2, total: 5 } },
          "/wt/feat-beta": { beta: { done: 4, total: 4 } },
        },
      }),
    )
    expect(board.rows.map((row) => row.id)).toEqual(["alpha", "beta", "on-main"])
    const [alpha, beta, onMain] = board.rows
    expect(alpha!.worktreeDir).toBe("/wt/feat-alpha")
    expect(alpha!.branch).toBe("feat/alpha")
    expect(alpha!.tasks).toEqual({ done: 2, total: 5 })
    expect(beta!.worktreeDir).toBe("/wt/feat-beta")
    expect(beta!.branch).toBe("feat/beta")
    expect(beta!.tasks).toEqual({ done: 4, total: 4 })
    expect(onMain!.location).toBe("main")
    expect(onMain!.worktreeDir).toBeUndefined()
  })

  test("title and uncommitted-marker come from the winning checkout", async () => {
    const worktrees: BoardWorktree[] = [
      { dir: mainDir, branch: "main", main: true },
      { dir: foreignDir, branch: "feat/preflight-dirty-tree-in-launcher", main: false },
      { dir: ownerDir, branch: `feat/${changeId}`, main: false },
    ]
    const board = await assembleControlBoard(
      readsFixture({
        worktrees,
        worktreeChangesByDir: { [foreignDir]: [changeId], [ownerDir]: [changeId] },
        markdown: { [foreignDir]: { [changeId]: false } },
        // The husk's stale proposal and status must not leak into the row: the owner supplies every derived fact.,
        titles: { [foreignDir]: { [changeId]: "Stale foreign title" }, [ownerDir]: { [changeId]: "Real owner title" } },
        status: { [foreignDir]: `?? openspec/changes/${changeId}/proposal.md\n`, [ownerDir]: "" },
      }),
    )
    const row = board.rows[0]!
    expect(row.title).toBe("Real owner title")
    expect(row.uncommittedProposal).toBe(false)
  })

  test("an id resolved from worktrees never duplicates as a stranded main row", async () => {
    const worktrees: BoardWorktree[] = [
      { dir: mainDir, branch: "main", main: true },
      { dir: foreignDir, branch: "feat/preflight-dirty-tree-in-launcher", main: false },
      { dir: ownerDir, branch: `feat/${changeId}`, main: false },
    ]
    const board = await assembleControlBoard(
      readsFixture({
        worktrees,
        mainChanges: [changeId],
        worktreeChangesByDir: { [foreignDir]: [changeId], [ownerDir]: [changeId] },
        markdown: { [foreignDir]: { [changeId]: false } },
      }),
    )
    expect(board.rows).toHaveLength(1)
    expect(board.rows[0]!.worktreeDir).toBe(ownerDir)
  })
})

describe("openspecTaskCounts", () => {
  test("falls back to checkbox parsing when the openspec CLI is absent", async () => {
    // A spawn of a missing binary throws (ENOENT) rather than exiting
    // non-zero; the fallback must still serve, or the whole board join
    // degrades on machines without the CLI.
    const dir = await mkdtemp(join(tmpdir(), "convoy-board-tasks-"))
    cleanupDirs.push(dir)
    const changeDir = join(dir, "openspec", "changes", "add-foo")
    await mkdir(changeDir, { recursive: true })
    await writeFile(join(changeDir, "tasks.md"), "# Tasks\n\n- [x] one\n- [x] two\n- [ ] three\n")

    const originalPath = process.env.PATH
    process.env.PATH = join(dir, "no-bin")
    try {
      const counts = await openspecTaskCounts(dir)
      expect(counts.get("add-foo")).toEqual({ done: 2, total: 3 })
    } finally {
      process.env.PATH = originalPath
    }
  })
})

describe("createBoardReads.changeHasMarkdown", () => {
  test("a husk with only empty subdirectories is not markdown-bearing; any .md file is", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-board-markdown-"))
    cleanupDirs.push(dir)
    const reads = createBoardReads(dir)

    // A husk: directories only, no markdown anywhere below.
    const husk = join(dir, "openspec", "changes", "husk-id", "specs", "cli")
    await mkdir(husk, { recursive: true })
    await expect(reads.changeHasMarkdown(dir, "husk-id")).resolves.toBe(false)

    // A real copy: markdown nested under the capability subtree.
    const real = join(dir, "openspec", "changes", "real-id", "specs", "cli")
    await mkdir(real, { recursive: true })
    await writeFile(join(real, "spec.md"), "# cli\n")
    await expect(reads.changeHasMarkdown(dir, "real-id")).resolves.toBe(true)

    // A missing directory reads as false, never throws.
    await expect(reads.changeHasMarkdown(dir, "ghost-id")).resolves.toBe(false)
  })
})

describe("createBoardReads precedence over real git worktrees", () => {
  test("a husk in an earlier worktree cannot steal the row from the branch-matching owner", async () => {
    // `git worktree` echoes canonical paths (e.g. /private/var/... on macOS), so
    // resolve the temp root through realpath before building the expected dirs..
    const top = await realpath(await mkdtemp(join(tmpdir(), "convoy-board-repo-")))
    cleanupDirs.push(top)
    const root = join(top, "repo")
    const foreign = join(top, "wt-foreign")
    const owner = join(top, "wt-owner")
    await mkdir(root)
    await git(["init", "-q", "-b", "main"], root)
    await writeFile(join(root, "README.md"), "base\n")
    await git(["add", "README.md"], root)
    await git(["commit", "-q", "-m", "chore: init"], root)

    const changeId = "specs-viewer-worktree-artifacts"

    // Earlier worktree: an unrelated branch carrying an untracked husk of the id..
    await git(["worktree", "add", "-q", "-b", "feat/other", foreign], root)
    const husk = join(foreign, "openspec", "changes", changeId, "specs", "cli")
    await mkdir(husk, { recursive: true })

    // Later worktree: the branch-matching owner carrying the real change artifacts..
    await git(["worktree", "add", "-q", "-b", `feat/${changeId}`, owner], root)
    const changeRoot = join(owner, "openspec", "changes", changeId)
    await mkdir(join(changeRoot, "specs", "cli"), { recursive: true })
    await writeFile(join(changeRoot, "proposal.md"), "# Proposal: owner copy\n")
    await writeFile(join(changeRoot, "tasks.md"), "# Tasks\n\n- [x] one\n- [x] two\n- [x] three\n- [x] four\n- [x] five\n- [x] six\n")
    await writeFile(join(changeRoot, "specs", "cli", "spec.md"), "# cli\n")

    // Isolate run-history reads: nothing under the temp home means no runs,
    // which keeps the join independent of this machine's ~/.convoy state..
    const previousHome = process.env.CONVOY_HOME
    const home = await mkdtemp(join(tmpdir(), "convoy-board-home-"))
    cleanupDirs.push(home)
    process.env.CONVOY_HOME = home
    try {
      const board = await assembleControlBoard(createBoardReads(root))
      expect(board.rows).toHaveLength(1)
      const row = board.rows[0]!
      expect(row.id).toBe(changeId)
      expect(row.worktreeDir).toBe(owner)
      expect(row.branch).toBe(`feat/${changeId}`)
      expect(row.tasks).toEqual({ done: 6, total: 6 })
      expect(row.stage).toBe("ready")
    } finally {
      process.env.CONVOY_HOME = previousHome
    }
  })
})
