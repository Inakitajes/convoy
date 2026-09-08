import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createFixtureRepo, type FixtureRepo } from "./helpers/multi-worktree"
import { legacyConflictsForBranch, listUnresolvedLegacyOperations, inspectLegacyCloseJournals } from "../src/legacy-operations"
import { repoCommonDir } from "../src/repo-store"

/**
 * Task 2.5: a narrow legacy unresolved-operation inspector and scoped
 * conflict guard. Original evidence is preserved byte-identical; conflicting
 * mutations are blocked with manual reconciliation guidance; unrelated
 * branches and resolved records stay usable; nothing is imported.
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

function legacyJournal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    attemptID: "attempt-1",
    branch: "feat/legacy",
    changeID: "legacy-change",
    baseRef: "main",
    baseSha: "0".repeat(40),
    phase: "candidate",
    candidateSha: "1".repeat(40),
    recordedAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

async function writeLegacyJournal(commonDir: string, name: string, value: unknown): Promise<string> {
  const dir = join(commonDir, "convoy", "close")
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, JSON.stringify(value, null, 2) + "\n")
  return path
}

describe("inspectLegacyCloseJournals", () => {
  test("lists unresolved half-applied closes with their evidence, read-only", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = await commonDirOf(fixture)
    const path = await writeLegacyJournal(commonDir, "feat__legacy__legacy-change.json", legacyJournal())
    const before = await readFile(path, "utf8")

    const found = await listUnresolvedLegacyOperations(commonDir)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      kind: "close-journal",
      branch: "feat/legacy",
      changeId: "legacy-change",
      phase: "candidate",
      unresolved: true,
      candidateSha: "1".repeat(40),
    })
    expect(found[0]!.refPrefix).toBe("refs/convoy/close/feat_legacy/")

    // Inspection is read-only: byte-identical evidence.
    expect(await readFile(path, "utf8")).toBe(before)
  })

  test("a landed and materialized legacy close is resolved, not unresolved", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = await commonDirOf(fixture)
    await writeLegacyJournal(commonDir, "done__done-change.json", legacyJournal({ branch: "done", changeID: "done-change", phase: "landed", landingSha: "2".repeat(40), checkoutMaterialized: true }))
    expect(await listUnresolvedLegacyOperations(commonDir)).toEqual([])
    const all = await inspectLegacyCloseJournals(commonDir)
    expect(all[0]).toMatchObject({ status: "found", unresolved: false })
  })

  test("a landed close with an unmaterialized checkout stays unresolved", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = await commonDirOf(fixture)
    await writeLegacyJournal(commonDir, "half__half-change.json", legacyJournal({ branch: "half", changeID: "half-change", phase: "landed", landingSha: "2".repeat(40), checkoutMaterialized: false }))
    const unresolved = await listUnresolvedLegacyOperations(commonDir)
    expect(unresolved).toHaveLength(1)
    expect(unresolved[0]).toMatchObject({ phase: "landed", unresolved: true })
  })

  test("corrupt and unsupported journals are disclosed, never interpreted or deleted", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = await commonDirOf(fixture)
    const corruptPath = await writeLegacyJournal(commonDir, "broken__x.json", { schemaVersion: 1, garbage: true })
    const newerPath = await writeLegacyJournal(commonDir, "newer__x.json", legacyJournal({ branch: "newer", changeID: "x", schemaVersion: 99 }))

    const all = await inspectLegacyCloseJournals(commonDir)
    const corrupt = all.find((entry) => entry.path === corruptPath)
    expect(corrupt).toMatchObject({ status: "corrupt" })
    const unsupported = all.find((entry) => entry.path === newerPath)
    expect(unsupported).toMatchObject({ status: "corrupt" })
    if (unsupported?.status === "corrupt") expect(unsupported.reason).toContain("unsupported journal schema version")
    // Evidence untouched.
    expect(await readFile(newerPath, "utf8")).toContain("\"schemaVersion\": 99")
  })

  test("a repository without legacy journals lists nothing", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    expect(await inspectLegacyCloseJournals(await commonDirOf(fixture))).toEqual([])
  })
})

describe("legacyConflictsForBranch", () => {
  test("blocks conflicting mutations on the legacy branch with reconciliation guidance", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = await commonDirOf(fixture)
    await writeLegacyJournal(commonDir, "feat__legacy__legacy-change.json", legacyJournal())
    const conflicts = await legacyConflictsForBranch({ commonDir, branch: "feat/legacy" })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.reason).toContain("stopped mid-sequence")
    expect(conflicts[0]!.remediation).toContain("inspect the legacy journal")
    // Unrelated branches stay usable.
    expect(await legacyConflictsForBranch({ commonDir, branch: "feat/unrelated" })).toEqual([])
  })

  test("a resolved legacy journal does not block anything", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = await commonDirOf(fixture)
    await writeLegacyJournal(commonDir, "done__done-change.json", legacyJournal({ branch: "done", changeID: "done-change", phase: "landed", landingSha: "2".repeat(40), checkoutMaterialized: true }))
    expect(await legacyConflictsForBranch({ commonDir, branch: "done" })).toEqual([])
  })
})
