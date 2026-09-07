import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { execFile, findWorktreeDirForBranch } from "../src/git"
import { ensureRepositoryRecord, isFound, lifecycleCommonDir } from "../src/feature-lifecycle/store"
import { writeFeatureRecord, type FeatureRecord } from "../src/feature-lifecycle/records"
import { buildObservationsForFeature } from "../src/feature-lifecycle/observe"

/**
 * Task 5.4 / capability work-context: "Stale branch copy defers to verified
 * archive evidence." `buildObservationsForFeature` reads the underlying
 * evidence (not the pure assessment), so this pins the rule at the observation
 * boundary: when the base state carries verified archive markdown for a change
 * id AND the feature branch sits behind its recorded base (never synced that
 * archive state), the branch's unarchived copy is a leftover — reported
 * `verified-archived` with the stale-copy discrepancy disclosed, never
 * presented as active work. A branch that has synced the base keeps the copy
 * active.
 */

const dirs: string[] = []
let repoDir: string
let commonDir: string
let repositoryId: string

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await execFile("git", args, { cwd, allowFailure: true })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
}

function record(featureId: string, overrides: Partial<FeatureRecord> = {}): FeatureRecord {
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

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "convoy-observe-"))
  dirs.push(repoDir)
  await writeFile(join(repoDir, "README.md"), "# repo\n")
  await git(repoDir, ["init", "-q", "-b", "main"])
  await git(repoDir, ["add", "."])
  await git(repoDir, ["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-q", "-m", "init"])
  commonDir = (await lifecycleCommonDir(repoDir))!
  const repoRecord = await ensureRepositoryRecord(commonDir)
  if (!isFound(repoRecord)) throw new Error("no repository record")
  repositoryId = repoRecord.value.repositoryId
})

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A worktree branch carrying the active change copy on the recorded branch. */
async function makeFeatureBranch(
  branch: string,
  label: string,
): Promise<{ worktreeDir: string; checkoutDir: string }> {
  const worktreeDir = join(await mkdtemp(join(tmpdir(), `convoy-observe-${label}-`)), "wt")
  dirs.push(worktreeDir)
  await git(repoDir, ["worktree", "add", "-q", "-b", branch, worktreeDir])
  const change = join(worktreeDir, "openspec", "changes", "add-widget")
  await mkdir(change, { recursive: true })
  await writeFile(join(change, "proposal.md"), "# Add widget\n")
  await writeFile(join(change, "tasks.md"), "# Tasks\n- [ ] do it\n")
  await git(worktreeDir, ["add", "."])
  await git(worktreeDir, ["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-q", "-m", `chore(openspec): ${label}`])
  // observe.ts compares the recorded checkoutPath against git's reported
  // worktree path verbatim, so use exactly what `git worktree list` reports
  // (macOS /tmp symlinking is otherwise a mismatch that reads as ambiguous).
  const registered = (await findWorktreeDirForBranch(branch, repoDir))!
  return { worktreeDir: registered, checkoutDir: registered }
}

describe("stale branch copy vs verified archive evidence (work-context, task 5.4)", () => {
  test("a branch behind its recorded base defers to the base's verified archive evidence", async () => {
    // The branch is created off main BEFORE the archive lands, then main
    // advances with an archived copy of the same change id. The feature branch
    // does not contain that archive state, so its unarchived copy is a stale
    // leftover — reported archived, not active.
    const { worktreeDir } = await makeFeatureBranch("feat/widget-behind", "behind")
    const archive = join(repoDir, "openspec", "changes", "archive", "add-widget")
    await mkdir(archive, { recursive: true })
    await writeFile(join(archive, "proposal.md"), "# Add widget (archived)\n")
    await git(repoDir, ["add", "."])
    await git(repoDir, ["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-q", "-m", "chore(openspec): archive add-widget"])

    const featureId = "5e5e5e5e-0000-4000-8000-00000000abc1"
    await writeFeatureRecord(
      commonDir,
      record(featureId, { context: { branch: "feat/widget-behind", checkoutPath: worktreeDir } }),
      0,
    )
    const observations = await buildObservationsForFeature({ cwd: repoDir, commonDir, feature: (await readFeature(featureId))! })
    const contract = observations.contracts[0]!
    expect(contract.changeId).toBe("add-widget")
    // The stale copy reads as archived (the base's evidence) — never active.
    expect(contract.state).toBe("verified-archived")
    expect(contract.reason).toContain("stale branch copy")
    expect(contract.reason).toContain("main")
    // A stale copy is not integration evidence: no landing was performed.
    expect(observations.integration).toBe("pending")
  })

  test("a branch that has synced the base keeps its copy active, not archived", async () => {
    // This branch is created from the CURRENT main tip (which already carries
    // the archive), so it contains the base state. Its active copy is therefore
    // current — the rule must NOT fire and the contract stays active.
    const { worktreeDir } = await makeFeatureBranch("feat/widget-synced", "synced")
    const featureId = "5e5e5e5e-0000-4000-8000-00000000abc2"
    await writeFeatureRecord(
      commonDir,
      record(featureId, { context: { branch: "feat/widget-synced", checkoutPath: worktreeDir } }),
      0,
    )
    const observations = await buildObservationsForFeature({ cwd: repoDir, commonDir, feature: (await readFeature(featureId))! })
    const contract = observations.contracts[0]!
    expect(contract.state).toBe("active")
    expect(contract.reason).toBeUndefined()
  })
})

async function readFeature(featureId: string): Promise<FeatureRecord | undefined> {
  const { readFeatureRecord } = await import("../src/feature-lifecycle/records")
  const read = await readFeatureRecord(commonDir, featureId)
  return read.status === "found" ? read.value : undefined
}
