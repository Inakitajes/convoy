import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createFixtureRepo, type FixtureRepo } from "./helpers/multi-worktree"
import { readCheckoutActiveChanges, readCheckoutArchives, readCheckoutCanonicalSpecs } from "../src/checkout-openspec"

/**
 * Task 1.4: checkout-local active/archive/canonical readers. Same-id copies
 * stay independent, husks and unreadable facts are preserved as such, and
 * archive destinations are the real dated directories OpenSpec created.
 */

const fixtures: FixtureRepo[] = []
const scratch: string[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true }).catch(() => {})
})

async function seedChange(checkout: string, changeId: string, files: { proposal?: string; tasks?: string; design?: string; delta?: { capability: string; body: string } }) {
  const root = join(checkout, "openspec", "changes", changeId)
  await mkdir(root, { recursive: true })
  if (files.proposal !== undefined) await writeFile(join(root, "proposal.md"), files.proposal)
  if (files.tasks !== undefined) await writeFile(join(root, "tasks.md"), files.tasks)
  if (files.design !== undefined) await writeFile(join(root, "design.md"), files.design)
  if (files.delta) {
    const specDir = join(root, "specs", files.delta.capability)
    await mkdir(specDir, { recursive: true })
    await writeFile(join(specDir, "spec.md"), files.delta.body)
  }
}

describe("readCheckoutActiveChanges", () => {
  test("same-id copies in two checkouts stay independent: own title, own tasks, own artifacts", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt-a", branch: "feat/a" }, { name: "wt-b", branch: "feat/b" }] })
    fixtures.push(fixture)
    const [a, b] = [fixture.worktrees["wt-a"]!, fixture.worktrees["wt-b"]!]
    await seedChange(a, "add-widget", {
      proposal: "# Add the widget\n\nWhy it matters.\n",
      tasks: "- [x] 1.1 first\n- [ ] 1.2 second\n- [ ] 1.3 third\n",
    })
    await seedChange(b, "add-widget", {
      proposal: "# Widget, but renamed locally\n",
      tasks: "- [x] 1.1 only\n",
    })

    const readA = await readCheckoutActiveChanges(a)
    const readB = await readCheckoutActiveChanges(b)
    expect(readA.kind).toBe("known")
    expect(readB.kind).toBe("known")
    const changeA = readA.kind === "known" ? readA.value[0]! : undefined
    const changeB = readB.kind === "known" ? readB.value[0]! : undefined
    expect(changeA).toMatchObject({ checkout: a, changeId: "add-widget", title: "Add the widget", tasks: { done: 1, total: 3 }, hasMarkdown: true })
    expect(changeB).toMatchObject({ checkout: b, changeId: "add-widget", title: "Widget, but renamed locally", tasks: { done: 1, total: 1 } })
    expect(changeA!.sourcePath).toBe(join(a, "openspec", "changes", "add-widget"))
    expect(changeB!.sourcePath).toBe(join(b, "openspec", "changes", "add-widget"))
  })

  test("a husk (directory without markdown) stays listed with unknown facts, not dropped", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "husky", branch: "feat/husk" }] })
    fixtures.push(fixture)
    const checkout = fixture.worktrees["husky"]!
    await mkdir(join(checkout, "openspec", "changes", "empty-proposal"), { recursive: true })
    await seedChange(checkout, "real-change", { proposal: "# Real\n" })

    const read = await readCheckoutActiveChanges(checkout)
    expect(read.kind).toBe("known")
    if (read.kind !== "known") return
    expect(read.value.map((change) => change.changeId)).toEqual(["empty-proposal", "real-change"])
    const husk = read.value.find((change) => change.changeId === "empty-proposal")!
    expect(husk.hasMarkdown).toBe(false)
    expect(husk.title).toBeUndefined()
    expect(husk.tasks).toBeUndefined()
  })

  test("a change with a tasks file that cannot be counted reads as unknown, never 0/0", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "counted", branch: "feat/counted" }] })
    fixtures.push(fixture)
    const checkout = fixture.worktrees["counted"]!
    // tasks.md exists but is not a file (a directory): inventory sees it, the count cannot.
    await mkdir(join(checkout, "openspec", "changes", "broken", "tasks.md"), { recursive: true })
    await seedChange(checkout, "broken", { proposal: "# Broken\n" })

    const read = await readCheckoutActiveChanges(checkout)
    expect(read.kind).toBe("known")
    if (read.kind !== "known") return
    const broken = read.value.find((change) => change.changeId === "broken")!
    expect(broken.artifacts.tasks).toBe(false)
    expect(broken.tasks).toBeUndefined()
  })

  test("stray files, dotfiles, and archive are not active changes; archive/ missing is a known empty list", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "strays", branch: "feat/strays" }] })
    fixtures.push(fixture)
    const checkout = fixture.worktrees["strays"]!
    const changesDir = join(checkout, "openspec", "changes")
    await mkdir(changesDir, { recursive: true })
    await writeFile(join(changesDir, "stray-notes.md"), "not a change\n")
    await mkdir(join(changesDir, ".hidden"), { recursive: true })
    await seedChange(checkout, "real", { proposal: "# Real\n" })

    const read = await readCheckoutActiveChanges(checkout)
    expect(read.kind).toBe("known")
    if (read.kind !== "known") return
    expect(read.value.map((change) => change.changeId)).toEqual(["real"])
  })

  test("a checkout without openspec is a known empty list, not unknown", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "specless", branch: "feat/specless" }] })
    fixtures.push(fixture)
    const read = await readCheckoutActiveChanges(fixture.worktrees["specless"]!)
    expect(read).toEqual({ kind: "known", value: [] })
  })

  test("delta specs under nested capabilities are inventoried as delta specs", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "deltas", branch: "feat/deltas" }] })
    fixtures.push(fixture)
    const checkout = fixture.worktrees["deltas"]!
    await seedChange(checkout, "with-specs", {
      proposal: "# Deltas\n",
      delta: { capability: "nested/cli", body: "## ADDED Requirements\n" },
    })
    const read = await readCheckoutActiveChanges(checkout)
    expect(read.kind).toBe("known")
    if (read.kind !== "known") return
    expect(read.value[0]!.artifacts.deltaSpecs).toEqual(["specs/nested/cli/spec.md"])
  })
})

describe("readCheckoutArchives", () => {
  test("dated destinations are read as-is with the change id unprefixed; undated archives still count", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "archives", branch: "feat/archives" }] })
    fixtures.push(fixture)
    const checkout = fixture.worktrees["archives"]!
    const archive = join(checkout, "openspec", "changes", "archive")
    await mkdir(join(archive, "2026-09-08-dated-change"), { recursive: true })
    await writeFile(join(archive, "2026-09-08-dated-change", "proposal.md"), "# Archived, dated\n")
    await mkdir(join(archive, "legacy-undated"), { recursive: true })
    await writeFile(join(archive, "legacy-undated", "proposal.md"), "# Archived, undated\n")
    await mkdir(join(archive, ".ghost"), { recursive: true })

    const read = await readCheckoutArchives(checkout)
    expect(read.kind).toBe("known")
    if (read.kind !== "known") return
    const dated = read.value.find((entry) => entry.changeId === "dated-change")!
    expect(dated).toMatchObject({ checkout, datedDir: "2026-09-08-dated-change", hasMarkdown: true })
    expect(dated.sourcePath).toBe(join(archive, "2026-09-08-dated-change"))
    const undated = read.value.find((entry) => entry.changeId === "legacy-undated")!
    expect(undated.datedDir).toBeUndefined()
    expect(read.value.find((entry) => entry.changeId === ".ghost")).toBeUndefined()
  })

  test("an empty archive directory is a known empty list", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "no-archives", branch: "feat/noarchives" }] })
    fixtures.push(fixture)
    const checkout = fixture.worktrees["no-archives"]!
    await mkdir(join(checkout, "openspec", "changes", "archive"), { recursive: true })
    const read = await readCheckoutArchives(checkout)
    expect(read).toEqual({ kind: "known", value: [] })
  })
})

describe("readCheckoutCanonicalSpecs", () => {
  test("reads each checkout's own specs with capability paths", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "specs-a", branch: "feat/sa" }, { name: "specs-b", branch: "feat/sb" }] })
    fixtures.push(fixture)
    const [a, b] = [fixture.worktrees["specs-a"]!, fixture.worktrees["specs-b"]!]
    await mkdir(join(a, "openspec", "specs", "cli"), { recursive: true })
    await writeFile(join(a, "openspec", "specs", "cli", "spec.md"), "# CLI spec in A\n")
    await mkdir(join(b, "openspec", "specs", "ui"), { recursive: true })
    await writeFile(join(b, "openspec", "specs", "ui", "spec.md"), "# UI spec in B\n")

    const readA = await readCheckoutCanonicalSpecs(a)
    const readB = await readCheckoutCanonicalSpecs(b)
    expect(readA).toMatchObject({ kind: "known" })
    expect(readB).toMatchObject({ kind: "known" })
    if (readA.kind !== "known" || readB.kind !== "known") return
    expect(readA.value).toEqual([{ checkout: a, capability: "cli", sourcePath: join(a, "openspec", "specs", "cli", "spec.md") }])
    expect(readB.value).toEqual([{ checkout: b, capability: "ui", sourcePath: join(b, "openspec", "specs", "ui", "spec.md") }])
  })

  test("nested capability directories compose their capability path", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "nested-specs", branch: "feat/nested" }] })
    fixtures.push(fixture)
    const checkout = fixture.worktrees["nested-specs"]!
    const nested = join(checkout, "openspec", "specs", "group", "cap")
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, "spec.md"), "# Nested\n")
    const read = await readCheckoutCanonicalSpecs(checkout)
    expect(read.kind).toBe("known")
    if (read.kind !== "known") return
    expect(read.value[0]!.capability).toBe("group/cap")
  })

  test("a checkout without specs is a known empty list; a symlinked spec dir is not followed", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "sym", branch: "feat/sym" }] })
    fixtures.push(fixture)
    const checkout = fixture.worktrees["sym"]!
    const outside = join(tmpdir(), `convoy-sym-target-${Date.now()}`)
    scratch.push(outside)
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, "spec.md"), "# outside\n")
    const specsRoot = join(checkout, "openspec", "specs")
    await mkdir(join(specsRoot, "evil"), { recursive: true })
    await symlink(outside, join(specsRoot, "evil", "link-target"))
    const read = await readCheckoutCanonicalSpecs(checkout)
    expect(read.kind).toBe("known")
    if (read.kind !== "known") return
    expect(read.value).toEqual([])
  })
})
