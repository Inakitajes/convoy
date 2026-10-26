import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createFixtureRepo, type FixtureRepo } from "./helpers/multi-worktree"
import {
  acceptSingletonSuggestion,
  confirmedChangeSelection,
  expectedSourcePath,
  freezeSelectedInputs,
  markAllChanges,
  suggestSingleton,
  toggleMarkedChange,
  validateChangeSelection,
  type ChangeSelectionInput,
  type SelectedChangeInput,
} from "../src/change-selection"

/**
 * Task 1.6: explicit ordered checkout-local change selection. Order is
 * preserved verbatim, stale/missing inputs refuse with the change named,
 * a singleton suggestion requires explicit acceptance, and archive
 * selection is a separate input from whole-branch Git scope.
 */

const fixtures: FixtureRepo[] = []
const scratch: string[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true }).catch(() => {})
})

async function seedChanges(checkout: string, ids: string[]) {
  for (const id of ids) {
    const dir = join(checkout, "openspec", "changes", id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "proposal.md"), `# ${id}\n`)
  }
}

function selected(...ids: string[]): SelectedChangeInput[] {
  return ids.map((id) => ({ changeId: id, sourcePath: join("/unused/checkout", "openspec", "changes", id) }))
}

describe("validateChangeSelection", () => {
  test("uses the execution checkout's configured root, not a same-id OpenSpec directory", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "feature", branch: "feat/001-login" }] })
    fixtures.push(fixture)
    const checkout = fixture.worktrees.feature!
    await fixture.write(checkout, ".convoy/config.yaml", "features:\n  specs: speckit\n")
    await fixture.write(checkout, "specs/001-login/spec.md", "# Feature Specification: Login\n")
    await seedChanges(checkout, ["001-login"])
    const sourcePath = join(checkout, "specs/001-login")
    expect(await expectedSourcePath(checkout, "001-login")).toBe(sourcePath)
    expect(await validateChangeSelection(checkout, { mode: "selected", changes: [{ changeId: "001-login", sourcePath }] })).toMatchObject({ ok: true })
    expect(await validateChangeSelection(checkout, { mode: "selected", changes: [{ changeId: "001-login", sourcePath: join(checkout, "openspec/changes/001-login") }] })).toMatchObject({ ok: false })
  })

  test("manual mode is explicit; an empty selected list is not manual", async () => {
    const checkout = tmpdir()
    expect(await validateChangeSelection(checkout, { mode: "manual" })).toMatchObject({ ok: true, mode: "manual" })
    const emptySelected = await validateChangeSelection(checkout, { mode: "selected", changes: [] })
    expect(emptySelected.ok).toBe(false)
    if (!emptySelected.ok) expect(emptySelected.reason).toContain("manual")
  })

  test("order is preserved verbatim: B then A stays B then A", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "ordered", branch: "feat/ordered" }] })
    fixtures.push(fixture)
    const checkout = fixture.worktrees["ordered"]!
    await seedChanges(checkout, ["change-a", "change-b", "change-c"])
    const input: ChangeSelectionInput = {
      mode: "selected",
      changes: await Promise.all(selected("change-b", "change-a").map(async (entry) => ({ ...entry, sourcePath: await expectedSourcePath(checkout, entry.changeId) }))),
    }
    const result = await validateChangeSelection(checkout, input)
    expect(result).toMatchObject({ ok: true, mode: "selected" })
    if (result.ok && result.mode === "selected") {
      expect(result.changes.map((change) => change.changeId)).toEqual(["change-b", "change-a"])
    }
  })

  test("a missing selected input refuses with the change named instead of substituting", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "stale", branch: "feat/stale" }] })
    fixtures.push(fixture)
    const checkout = fixture.worktrees["stale"]!
    await seedChanges(checkout, ["change-present"])
    const input: ChangeSelectionInput = {
      mode: "selected",
      changes: [
        { changeId: "change-present", sourcePath: await expectedSourcePath(checkout, "change-present") },
        { changeId: "change-gone", sourcePath: await expectedSourcePath(checkout, "change-gone") },
      ],
    }
    const result = await validateChangeSelection(checkout, input)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.changeId).toBe("change-gone")
      expect(result.reason).toContain("missing")
    }
  })

  test("a source outside the checkout's openspec/changes is refused", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "outside", branch: "feat/outside" }] })
    fixtures.push(fixture)
    const checkout = fixture.worktrees["outside"]!
    const elsewhere = join(tmpdir(), `convoy-elsewhere-${Date.now()}`, "openspec", "changes", "change-x")
    scratch.push(elsewhere)
    await mkdir(elsewhere, { recursive: true })
    const result = await validateChangeSelection(checkout, { mode: "selected", changes: [{ changeId: "change-x", sourcePath: elsewhere }] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("outside the selected checkout")
  })

  test("a duplicate selection is refused rather than silently merged", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "dupe", branch: "feat/dupe" }] })
    fixtures.push(fixture)
    const checkout = fixture.worktrees["dupe"]!
    await seedChanges(checkout, ["change-dup"])
    const path = await expectedSourcePath(checkout, "change-dup")
    const result = await validateChangeSelection(checkout, { mode: "selected", changes: [{ changeId: "change-dup", sourcePath: path }, { changeId: "change-dup", sourcePath: path }] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("more than once")
  })
})

describe("draft marking helpers", () => {
  test("toggle marks and unmarks one change, never adding it twice", () => {
    expect(toggleMarkedChange([], "change-a")).toEqual(["change-a"])
    expect(toggleMarkedChange(["change-a"], "change-b")).toEqual(["change-a", "change-b"])
    expect(toggleMarkedChange(["change-a", "change-b"], "change-a")).toEqual(["change-b"])
    expect(toggleMarkedChange(["change-a"], "change-a")).toEqual([])
  })

  test("select-all marks every active change in listing order, and nothing when the listing is empty", () => {
    expect(markAllChanges(["change-a", "change-b", "change-c"])).toEqual(["change-a", "change-b", "change-c"])
    expect(markAllChanges([])).toEqual([])
  })

  test("a confirmed multi-selection is ordered by the listing, independent of toggle order", () => {
    // Toggled change-b then change-a; confirm reads change-a then change-b.
    const marked = toggleMarkedChange(toggleMarkedChange([], "change-b"), "change-a")
    expect(confirmedChangeSelection(marked, ["change-a", "change-b"])).toEqual(["change-a", "change-b"])
  })

  test("the confirmed selection dedupes and drops stale marks; an empty selection stays empty", () => {
    expect(confirmedChangeSelection(["change-a", "change-a", "change-gone"], ["change-a", "change-b"])).toEqual(["change-a"])
    expect(confirmedChangeSelection([], ["change-a", "change-b"])).toEqual([])
    expect(confirmedChangeSelection([], [])).toEqual([])
  })
})

describe("singleton suggestions require explicit acceptance", () => {
  test("one local change may be suggested; zero or several produce no suggestion", async () => {
    const checkout = tmpdir()
    const one = [{ changeId: "only", sourcePath: join(checkout, "openspec", "changes", "only") }]
    expect(suggestSingleton(one)).toMatchObject({ kind: "singleton", changeId: "only" })
    expect(suggestSingleton([])).toBeUndefined()
    expect(suggestSingleton([...one, ...one.map((entry) => ({ ...entry, changeId: "second" }))])).toBeUndefined()
  })

  test("a suggestion becomes a selection only through acceptSingletonSuggestion", async () => {
    const suggestion = suggestSingleton([{ changeId: "only", sourcePath: "/wt/openspec/changes/only" }])!
    const accepted = acceptSingletonSuggestion(suggestion)
    expect(accepted).toEqual({ changeId: "only", sourcePath: "/wt/openspec/changes/only" })
  })
})

describe("freezeSelectedInputs", () => {
  test("freezes the configured feature's spec.md instead of proposal.md", async () => {
    const fixture = await createFixtureRepo()
    fixtures.push(fixture)
    await fixture.write(fixture.root, ".convoy/config.yaml", "features:\n  specs: speckit\n")
    await fixture.write(fixture.root, "specs/001-login/spec.md", "# Feature Specification: Login\n")
    const read = async (path: string) => readFile(path, "utf8")
    const result = await freezeSelectedInputs(fixture.root, [{ changeId: "001-login", sourcePath: join(fixture.root, "specs/001-login") }], read)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.frozen[0]?.snapshot?.content).toContain("Feature Specification: Login")
  })

  test("proposals are snapshotted with content hashes for unresolved-operation reuse", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "freeze", branch: "feat/freeze" }] })
    fixtures.push(fixture)
    const checkout = fixture.worktrees["freeze"]!
    await seedChanges(checkout, ["frozen-change"])
    const read = async (path: string) => (await import("node:fs/promises")).readFile(path, "utf8")
    const result = await freezeSelectedInputs(checkout, [{ changeId: "frozen-change", sourcePath: await expectedSourcePath(checkout, "frozen-change") }], read)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const frozen = result.frozen[0]!
      expect(frozen.snapshot?.content).toContain("# frozen-change")
      expect(frozen.snapshot?.contentHash).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  test("an unfreezable input names the change instead of silently dropping it", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "nofreeze", branch: "feat/nofreeze" }] })
    fixtures.push(fixture)
    const checkout = fixture.worktrees["nofreeze"]!
    await mkdir(join(checkout, "openspec", "changes", "no-proposal"), { recursive: true })
    const read = async (path: string) => (await import("node:fs/promises")).readFile(path, "utf8")
    const result = await freezeSelectedInputs(checkout, [{ changeId: "no-proposal", sourcePath: await expectedSourcePath(checkout, "no-proposal") }], read)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.changeId).toBe("no-proposal")
  })
})
