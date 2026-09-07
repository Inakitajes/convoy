import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { execFile } from "../src/git"
import { ensureRepositoryRecord, isFound, lifecycleCommonDir } from "../src/feature-lifecycle/store"
import { writeFeatureRecord, type FeatureRecord } from "../src/feature-lifecycle/records"
import { resolveWorkContext } from "../src/feature-lifecycle/work-context"

/**
 * Task 1.1 (capability work-context, design D1): the projection is a thin
 * plain-data view over the shared resolver — explicit associations verify,
 * arbitrary branch names are honored, a missing context is unavailable with
 * remediation, and the complete multi-contract set survives projection. No
 * second resolver logic is exercised here beyond the resolver's own tests.
 */

const dirs: string[] = []

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await execFile("git", args, { cwd, allowFailure: true })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
}

function record(featureId: string, repositoryId: string, overrides: Partial<FeatureRecord> = {}): FeatureRecord {
  return {
    schemaVersion: 1,
    featureId,
    repositoryId,
    displayName: "add-widget",
    associationRevision: 1,
    contracts: [{ changeId: "add-widget", kind: "active", sourcePath: "openspec/changes/add-widget", provenance: "adopt", selectedAtRevision: 1 }],
    intendedBaseRef: "main",
    runIds: [],
    closeAttemptIds: [],
    history: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

let repoDir: string
let worktreeDir: string
let commonDir: string
let repositoryId: string

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "convoy-work-context-"))
  dirs.push(repoDir)
  await Bun.write(join(repoDir, "README.md"), "# repo\n")
  await git(repoDir, ["init", "-q", "-b", "main"])
  await git(repoDir, ["add", "."])
  await git(repoDir, ["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-q", "-m", "init"])
  // An arbitrary Git-valid branch name: the projection must honor it verbatim.
  worktreeDir = join(await mkdtemp(join(tmpdir(), "convoy-work-context-wt-")), "wt")
  dirs.push(worktreeDir)
  await git(repoDir, ["worktree", "add", "-q", "-b", "team/alice/release-42", worktreeDir])
  commonDir = (await lifecycleCommonDir(repoDir))!
  const repoRecord = await ensureRepositoryRecord(commonDir)
  if (!isFound(repoRecord)) throw new Error("no repository record")
  repositoryId = repoRecord.value.repositoryId
})

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("resolveWorkContext (task 1.1)", () => {
  test("a verified association projects the worktree checkout, contracts, base, and revision", async () => {
    const featureId = "cccccccc-0000-4000-8000-00000000abc3"
    await writeFeatureRecord(commonDir, record(featureId, repositoryId, { context: { branch: "team/alice/release-42", checkoutPath: worktreeDir } }), 0)
    const resolution = await resolveWorkContext({ launchDir: repoDir, featureId })
    expect(resolution.status).toBe("validated")
    if (resolution.status !== "validated") return
    expect(resolution.context.executionCheckout).toBe(await realpath(worktreeDir))
    expect(resolution.context.branch).toBe("team/alice/release-42")
    expect(resolution.context.feature?.featureId).toBe(featureId)
    // The complete reviewed contract set survives projection.
    expect(resolution.context.contracts).toEqual(["add-widget"])
    expect(resolution.context.intendedBase).toBe("main")
    expect(resolution.context.associationRevision).toBe(1)
    expect(resolution.context.origin).toBe("verified-association")
    // The focused contract names its source inside the verified checkout.
    expect(resolution.context.focusedContract?.changeId).toBeUndefined()
  })

  test("a focused change projects its source root without reducing the contract set", async () => {
    const featureId = "cccccccc-0000-4000-8000-00000000abc4"
    await writeFeatureRecord(
      commonDir,
      record(featureId, repositoryId, {
        associationRevision: 2,
        contracts: [
          { changeId: "add-widget", kind: "active", sourcePath: "openspec/changes/add-widget", provenance: "adopt", selectedAtRevision: 1 },
          { changeId: "tweak-widget", kind: "active", sourcePath: "openspec/changes/tweak-widget", provenance: "revise", selectedAtRevision: 2 },
        ],
        context: { branch: "team/alice/release-42", checkoutPath: worktreeDir },
      }),
      0,
    )
    const resolution = await resolveWorkContext({ launchDir: repoDir, featureId, changeId: "tweak-widget" })
    expect(resolution.status).toBe("validated")
    if (resolution.status !== "validated") return
    // Reader focus is context, not a contract-set edit (design D2).
    expect(resolution.context.contracts).toEqual(["add-widget", "tweak-widget"])
    expect(resolution.context.focusedContract?.changeId).toBe("tweak-widget")
    expect(resolution.context.focusedContract?.sourceRoot).toBe(join(await realpath(worktreeDir), "openspec/changes/tweak-widget"))
  })

  test("a change selector that conflicts with the contracts is unavailable, not silently resolved", async () => {
    const featureId = "cccccccc-0000-4000-8000-00000000abc5"
    await writeFeatureRecord(commonDir, record(featureId, repositoryId, { context: { branch: "team/alice/release-42", checkoutPath: worktreeDir } }), 0)
    const resolution = await resolveWorkContext({ launchDir: repoDir, featureId, changeId: "other-change" })
    expect(resolution.status).toBe("unavailable")
    if (resolution.status !== "unavailable") return
    expect(resolution.condition).toBe("ambiguous")
    expect(resolution.reason).toContain("other-change")
  })

  test("a context checked out nowhere is unavailable with rebind remediation", async () => {
    const featureId = "cccccccc-0000-4000-8000-00000000abc6"
    await writeFeatureRecord(commonDir, record(featureId, repositoryId, { context: { branch: "feat/ghost-branch" } }), 0)
    const resolution = await resolveWorkContext({ launchDir: repoDir, featureId })
    expect(resolution.status).toBe("unavailable")
    if (resolution.status !== "unavailable") return
    expect(resolution.condition).toBe("missing")
    expect(resolution.reason).toContain("feat/ghost-branch")
    expect(resolution.remediation.join(" ")).toContain("convoy feature bind")
  })

  test("a Git-listed worktree whose directory vanished does not validate (missing, not launch-dir fallback)", async () => {
    const vanished = join(await mkdtemp(join(tmpdir(), "convoy-work-context-gone-")), "gone")
    dirs.push(vanished)
    await git(repoDir, ["worktree", "add", "-q", "-b", "feat/vanishing", vanished])
    // Remove the directory out from under Git: the worktree stays listed
    // (prunable) but the checkout no longer exists on disk.
    await rm(vanished, { recursive: true, force: true })
    const featureId = "cccccccc-0000-4000-8000-00000000abc7"
    await writeFeatureRecord(commonDir, record(featureId, repositoryId, { context: { branch: "feat/vanishing", checkoutPath: vanished } }), 0)
    const resolution = await resolveWorkContext({ launchDir: repoDir, featureId })
    expect(resolution.status).toBe("unavailable")
    if (resolution.status !== "unavailable") return
    expect(resolution.condition).toBe("missing")
    expect(resolution.reason).toContain("no longer present on disk")
  })

  test("an unknown explicit feature id is unavailable (never a heuristic fallback)", async () => {
    const resolution = await resolveWorkContext({ launchDir: repoDir, featureId: "dddddddd-0000-4000-8000-00000000abc8" })
    expect(resolution.status).toBe("unavailable")
    if (resolution.status !== "unavailable") return
    expect(resolution.condition).toBe("missing")
  })

  test("plain unassociated work validates with the launch directory as its checkout", async () => {
    const resolution = await resolveWorkContext({ launchDir: repoDir })
    expect(resolution.status).toBe("validated")
    if (resolution.status !== "validated") return
    expect(resolution.context.executionCheckout).toBe(repoDir)
    expect(resolution.context.origin).toBe("launch-directory")
    expect(resolution.context.feature).toBeUndefined()
    expect(resolution.context.contracts).toEqual([])
  })

  test("an empty repository (no registry yet) still validates as launch-directory work", async () => {
    const bare = await mkdtemp(join(tmpdir(), "convoy-work-context-bare-"))
    dirs.push(bare)
    await git(bare, ["init", "-q"])
    const resolution = await resolveWorkContext({ launchDir: bare })
    expect(resolution.status).toBe("validated")
    if (resolution.status !== "validated") return
    expect(resolution.context.origin).toBe("launch-directory")
    expect(resolution.context.executionCheckout).toBe(bare)
  })

  test("a verified checkout with a created change projects the source root as present for handoff checks", async () => {
    // Integration-shaped: create the change tree in the worktree, then the
    // focused source root must point into it (the routing layer stats this).
    const change = join(worktreeDir, "openspec", "changes", "add-widget")
    await mkdir(join(change, "specs"), { recursive: true })
    await writeFile(join(change, "proposal.md"), "# Add widget\n")
    const featureId = "cccccccc-0000-4000-8000-00000000abc9"
    await writeFeatureRecord(
      commonDir,
      record(featureId, repositoryId, { context: { branch: "team/alice/release-42", checkoutPath: worktreeDir } }),
      0,
    )
    const resolution = await resolveWorkContext({ launchDir: repoDir, featureId, changeId: "add-widget" })
    expect(resolution.status).toBe("validated")
    if (resolution.status !== "validated") return
    expect(resolution.context.focusedContract?.sourceRoot).toBe(join(await realpath(worktreeDir), "openspec/changes/add-widget"))
  })
})
