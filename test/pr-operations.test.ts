import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseWorktreesArgs, runWorktreesCommand, worktreesHelp } from "../src/worktree-commands"
import { composePrDraft, queryOpenPr, type PrScope } from "../src/pr-operations"
import { createFixtureRepo, type FixtureRepo } from "./helpers/multi-worktree"
import { listPendingOperations } from "../src/operation-journal"

/**
 * The PR operation and the remaining D4 command surface (change
 * `worktree-control-center`, tasks 5.4–5.6 and gap CC-10): composition
 * describes the whole reviewed range with honest disclosures, a failed lookup
 * is unknown evidence never permission to create, accepted text is frozen in
 * an unresolved operation before effects, and `new`/`run` require explicit
 * targets and selections.
 */

const fixtures: FixtureRepo[] = []
const scratch: string[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true }).catch(() => {})
  process.exitCode = 0
})

// ── the command surface ──────────────────────────────────────────────────

describe("worktrees new/pr/run surface", () => {
  test("the help names the full D4 surface", () => {
    const help = worktreesHelp()
    for (const sub of ["new", "fetch", "sync", "push", "pr", "run", "archive", "squash", "close", "remove", "delete-branch", "recover"]) {
      expect(help).toContain(sub)
    }
  })

  test("pr parses with its explicit target and optional scope", () => {
    expect(parseWorktreesArgs(["pr", "--worktree", "/wt/x"])).toEqual({ kind: "pr", worktree: "/wt/x", push: false })
    expect(parseWorktreesArgs(["pr", "--worktree", "/wt/x", "--base", "main", "--repo", "o/r", "--push"])).toEqual({
      kind: "pr",
      worktree: "/wt/x",
      base: "main",
      repo: "o/r",
      push: true,
    })
  })

  test("run requires an explicit change selection or the explicit manual mode", () => {
    expect(() => parseWorktreesArgs(["run", "--worktree", "/wt/x"])).toThrow(/--change/)
    expect(parseWorktreesArgs(["run", "--worktree", "/wt/x", "--manual"])).toEqual({ kind: "run", worktree: "/wt/x", changes: [], manual: true })
    expect(parseWorktreesArgs(["run", "--worktree", "/wt/x", "--change", "a", "--change", "b"])).toEqual({ kind: "run", worktree: "/wt/x", changes: ["a", "b"], manual: false })
  })

  test("new parses its description and optional reviewed inputs", () => {
    expect(parseWorktreesArgs(["new", "improve", "review", "navigation"])).toEqual({ kind: "new", description: "improve review navigation" })
    expect(parseWorktreesArgs(["new", "widget", "--branch", "feat/w", "--base", "develop"])).toEqual({ kind: "new", description: "widget", branch: "feat/w", base: "develop" })
  })
})

// ── new ──────────────────────────────────────────────────────────────────

describe("worktrees new", () => {
  test("creates the reviewed worktree through the shared creation path", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    await runWorktreesCommand({ kind: "new", description: "improve review navigation" }, fixture.root)
    const branches = await fixture.git(["branch", "--list", "feat/improve-review-navigation"])
    expect(branches).toContain("feat/improve-review-navigation")
    const listing = await fixture.git(["worktree", "list"])
    expect(listing).toContain("feat-improve-review-navigation")
    // A resolved creation leaves no journal behind.
    const { repoCommonDir } = await import("../src/repo-store")
    const commonDir = (await repoCommonDir(fixture.root))!
    expect(await listPendingOperations(commonDir)).toEqual([])
  })

  test("a description without a usable slug requires an explicit branch", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    await expect(runWorktreesCommand({ kind: "new", description: "   " }, fixture.root)).rejects.toThrow(/describe/)
    await expect(runWorktreesCommand({ kind: "new", description: "!!!" }, fixture.root)).rejects.toThrow(/--branch/)
  })
})

// ── run ──────────────────────────────────────────────────────────────────

describe("worktrees run", () => {
  test("a selected change missing from the execution checkout stops, never borrows a same-id copy", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
    fixtures.push(fixture)
    // The change exists only in the launch checkout.
    await fixture.write(fixture.root, "openspec/changes/add-widget/proposal.md", "# Add widget\n")
    const { validateRunSelection } = await import("../src/worktree-commands")
    await expect(validateRunSelection(fixture.worktrees["wt"]!, ["add-widget"])).rejects.toThrow(/not found in .*add-widget/)
  })
})

// ── PR composition ───────────────────────────────────────────────────────

describe("composePrDraft", () => {
  test("the deterministic title is conventional and human-readable; the body describes the whole range", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/quiet-notifications" }] })
    fixtures.push(fixture)
    const wt = fixture.worktrees["wt"]!
    await fixture.write(wt, "a.txt", "one\n")
    await fixture.commitAll("feat: add quiet notifications", wt)
    await fixture.write(wt, "b.txt", "two\n")
    await fixture.commitAll("feat: mute the noisy loop", wt)

    const draft = await composePrDraft({ checkout: wt, base: "main", branch: "feat/quiet-notifications" })
    expect(draft.title).toBe("feat: Quiet notifications")
    expect(draft.title.length).toBeLessThanOrEqual(72)
    expect(draft.body).toContain("## Why")
    expect(draft.body).toContain("## What")
    expect(draft.body).toContain("add quiet notifications")
    expect(draft.body).toContain("mute the noisy loop")
    // Missing evidence is disclosed, never invented.
    expect(draft.body).toContain("Not disclosed")
    expect(draft.body).toContain("testing status is unknown")
  })

  test("operator text always wins over composition", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
    fixtures.push(fixture)
    const draft = await composePrDraft({ checkout: fixture.worktrees["wt"]!, base: "main", branch: "feat/x", title: "My title", body: "My body" })
    expect(draft.title).toBe("My title")
    expect(draft.body).toBe("My body")
  })
})

// ── the scoped lookup ────────────────────────────────────────────────────

describe("queryOpenPr", () => {
  test("a failed gh query is unknown evidence, never no-PR", async () => {
    const scope: PrScope = { hostingRepo: "o/r", headRepo: "o/r", headBranch: "feat/x", baseRepo: "o/r", baseBranch: "main" }
    // A stub gh that fails the list call.
    const dir = await mkdtemp(join(tmpdir(), "convoy-pr-gh-"))
    scratch.push(dir)
    const stub = join(dir, "gh")
    await writeFile(stub, "#!/bin/sh\necho 'gh: network unreachable' >&2\nexit 1\n")
    await chmod(stub, 0o755)
    const savedPath = process.env.PATH
    process.env.PATH = `${dir}:${savedPath}`
    try {
      const result = await queryOpenPr(scope, dir)
      expect(result.kind).toBe("unknown")
    } finally {
      if (savedPath !== undefined) process.env.PATH = savedPath
    }
  })

  test("a matching open PR is reported; an empty list is known absence", async () => {
    const scope: PrScope = { hostingRepo: "o/r", headRepo: "o/r", headBranch: "feat/x", baseRepo: "o/r", baseBranch: "main" }
    const dir = await mkdtemp(join(tmpdir(), "convoy-pr-gh-"))
    scratch.push(dir)
    const stub = join(dir, "gh")
    await writeFile(
      stub,
      "#!/bin/sh\necho '[{\"number\":7,\"title\":\"Add x\",\"url\":\"https://example/pr/7\",\"state\":\"OPEN\"}]'\n",
    )
    await chmod(stub, 0o755)
    const savedPath = process.env.PATH
    process.env.PATH = `${dir}:${savedPath}`
    try {
      const found = await queryOpenPr(scope, dir)
      expect(found.kind).toBe("known")
      if (found.kind === "known") expect(found.pr?.number).toBe(7)

      const empty = join(dir, "gh-empty")
      await mkdir(dir, { recursive: true })
      await writeFile(empty, "#!/bin/sh\necho '[]'\n")
      await chmod(empty, 0o755)
      process.env.PATH = `${dir}:${savedPath}`
      // Re-stub the same name to answer empty.
      await writeFile(stub, "#!/bin/sh\necho '[]'\n")
      const absent = await queryOpenPr(scope, dir)
      expect(absent.kind).toBe("known")
      if (absent.kind === "known") expect(absent.pr).toBeUndefined()
    } finally {
      if (savedPath !== undefined) process.env.PATH = savedPath
    }
  })
})

// ── the operation end-to-end (gh stubbed) ────────────────────────────────

describe("runPrOperation", () => {
  function ghStub(dir: string, script: string): () => void {
    const savedPath = process.env.PATH
    const stubDir = join(dir, "bin")
    return () => {
      process.env.PATH = savedPath
      void stubDir
      void script
    }
  }

  test("an existing matching open PR is reused, never duplicated", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
    fixtures.push(fixture)
    const wt = fixture.worktrees["wt"]!
    await fixture.write(wt, "a.txt", "one\n")
    await fixture.commitAll("feat: work", wt)

    const stubDir = await mkdtemp(join(tmpdir(), "convoy-pr-stub-"))
    scratch.push(stubDir)
    await writeFile(join(stubDir, "gh"), "#!/bin/sh\nif [ \"$1\" = \"repo\" ]; then echo 'o/r'; else echo '[{\"number\":7,\"title\":\"Add x\",\"url\":\"https://example/pr/7\",\"state\":\"OPEN\"}]'; fi\n")
    await chmod(join(stubDir, "gh"), 0o755)
    const savedPath = process.env.PATH
    process.env.PATH = `${stubDir}:${savedPath}`
    const { runPrOperation } = await import("../src/pr-operations")
    try {
      const outcome = await runPrOperation({ checkout: wt, base: "main", repo: "o/r" })
      expect(outcome.ok).toBe(true)
      if (outcome.ok) {
        expect(outcome.reused).toBe(true)
        expect(outcome.pr?.number).toBe(7)
      }
      // A resolved operation releases its journal.
      const { repoCommonDir } = await import("../src/repo-store")
      const commonDir = (await repoCommonDir(wt))!
      expect(await listPendingOperations(commonDir)).toEqual([])
    } finally {
      if (savedPath !== undefined) process.env.PATH = savedPath
    }
  })

  test("a failed lookup freezes the accepted text in an unresolved operation instead of creating", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
    fixtures.push(fixture)
    const wt = fixture.worktrees["wt"]!
    await fixture.write(wt, "a.txt", "one\n")
    await fixture.commitAll("feat: work", wt)

    const stubDir = await mkdtemp(join(tmpdir(), "convoy-pr-stub-"))
    scratch.push(stubDir)
    await writeFile(join(stubDir, "gh"), "#!/bin/sh\nif [ \"$1\" = \"repo\" ]; then echo 'o/r'; else echo 'gh: down' >&2; exit 1; fi\n")
    await chmod(join(stubDir, "gh"), 0o755)
    const savedPath = process.env.PATH
    process.env.PATH = `${stubDir}:${savedPath}`
    const { runPrOperation } = await import("../src/pr-operations")
    try {
      const outcome = await runPrOperation({ checkout: wt, base: "main", repo: "o/r", title: "My title", body: "My body" })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.reason).toContain("unknown")
      // The accepted text is frozen for the retry.
      const { repoCommonDir } = await import("../src/repo-store")
      const { readOperation } = await import("../src/operation-journal")
      const commonDir = (await repoCommonDir(wt))!
      const pending = await listPendingOperations(commonDir)
      expect(pending).toHaveLength(1)
      const read = await readOperation(commonDir, pending[0]!)
      if (read.status !== "found") throw new Error("journal vanished")
      expect(read.value.kind).toBe("pr")
      expect((read.value.intent as { title?: string }).title).toBe("My title")
    } finally {
      if (savedPath !== undefined) process.env.PATH = savedPath
    }
  })

  test("without a run, a spec, or a feature record, the PR operation composes from the branch alone", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/plain" }] })
    fixtures.push(fixture)
    const wt = fixture.worktrees["wt"]!
    await fixture.write(wt, "a.txt", "one\n")
    await fixture.commitAll("feat: plain work", wt)

    const stubDir = await mkdtemp(join(tmpdir(), "convoy-pr-stub-"))
    scratch.push(stubDir)
    await writeFile(join(stubDir, "gh"), "#!/bin/sh\nif [ \"$1\" = \"repo\" ]; then echo 'o/r'; else echo '[]'; fi\n")
    await chmod(join(stubDir, "gh"), 0o755)
    const savedPath = process.env.PATH
    process.env.PATH = `${stubDir}:${savedPath}`
    const { runPrOperation } = await import("../src/pr-operations")
    try {
      const outcome = await runPrOperation({ checkout: wt, base: "main", repo: "o/r" })
      expect(outcome.ok).toBe(true)
      if (outcome.ok && outcome.pr) expect(outcome.pr.title).toBe("feat: Plain work")
    } finally {
      if (savedPath !== undefined) process.env.PATH = savedPath
    }
  })
})
