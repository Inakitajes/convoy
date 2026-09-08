import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { commitAsUser, execFile, findWorktreeDirForBranch, findSuspiciousStagedFiles, resolveCommit, statusPorcelain, treeOf, currentBranch } from "./git"
import { observeBaseDivergence, observeTreeEquality } from "./worktree-observations"
import { createOperation, acknowledgeStep, recordStepIntent, resolveOperation } from "./operation-journal"

/**
 * Whole-branch squash-to-base (change `worktree-control-center`, tasks 7.1–7.2,
 * design D7): the entire reviewed source/base difference lands as exactly one
 * operator-authored conventional commit whose only parent is the pinned base.
 * The source's history is never rewritten; the base checkout is validated
 * clean and on the intended branch before a guarded fast-forward. Equal trees
 * produce no commit and no historical-integration claim. An operation journal
 * records intent before the candidate exists and acknowledges verified effects
 * after, so a crash between the two reconciles instead of replaying.
 */

export type SquashOutcome =
  | { ok: true; landedSha: string; base: string; baseSha: string }
  | { ok: true; noDifference: true }
  | { ok: false; reason: string }

/** Deterministic conventional fallback: type from the branch prefix, subject from the slug as words. */
export function fallbackSquashMessage(branch: string): string {
  const separator = branch.indexOf("/")
  const prefix = separator > 0 ? branch.slice(0, separator) : "feat"
  const slug = separator > 0 ? branch.slice(separator + 1) : branch
  const type = ["feat", "fix", "refactor", "perf", "docs", "test", "chore", "build", "ci"].includes(prefix) ? prefix : "feat"
  const subject = slug
    .split(/[-_]+/)
    .filter((word) => word !== "")
    .join(" ")
  return `${type}: ${subject || "land branch work"}`
}

/**
 * Squash-integrates the whole reviewed branch into `base`. Both checkouts are
 * revalidated inside the effect; every mutation is journaled before it happens
 * and acknowledged only after verification.
 */
export async function squashToBase(input: {
  checkout: string
  base: string
  commonDir: string
  /** Explicit message wins verbatim; otherwise the deterministic fallback composes from the branch. */
  message?: string
  /** Injected for tests; defaults to the real guarded landing. */
  land?: (candidateSha: string, baseDir: string) => Promise<void>
}): Promise<SquashOutcome> {
  const sourceTip = await resolveCommit("HEAD", input.checkout)
  if (!sourceTip) return { ok: false, reason: `checkout ${input.checkout} has no commit to integrate` }
  const sourceBranch = await currentBranch(input.checkout)
  if (!sourceBranch) return { ok: false, reason: `checkout ${input.checkout} is detached; squash needs an attached branch to name the source` }
  const baseSha = await resolveCommit(input.base, input.checkout)
  if (!baseSha) return { ok: false, reason: `base ref "${input.base}" does not resolve to a commit` }

  // The pinned base must be contained in the source (or sync first), and equal
  // trees land nothing at all.
  const divergence = await observeBaseDivergence(input.checkout, input.base)
  if (divergence.kind !== "known") return { ok: false, reason: divergence.reason }
  if (!divergence.value.baseContainedInSource) {
    return { ok: false, reason: `${input.base} is not contained in the source branch — run \`convoy worktrees sync --worktree ${input.checkout} --base ${input.base}\` first` }
  }
  const equality = await observeTreeEquality(sourceTip, baseSha, input.checkout)
  if (equality.kind === "known" && equality.value.equalTrees) {
    return { ok: true, noDifference: true }
  }

  // Intent before effect: the journal records the reviewed inputs and pending
  // steps before the candidate commit exists.
  const created = await createOperation(input.commonDir, {
    kind: "squash",
    intent: { checkout: input.checkout, sourceBranch, sourceTip, base: input.base, baseSha, message: input.message },
    steps: ["candidate", "land"],
  })
  if (!created.ok) return { ok: false, reason: `the squash journal could not be persisted — no mutation was made: ${created.reason}` }
  const operationId = created.operation.operationId
  await recordStepIntent(input.commonDir, operationId, "candidate", { sourceTip, baseSha })

  try {
    const candidateSha = await createCandidate({
      sourceTip,
      baseSha,
      message: input.message ?? fallbackSquashMessage(sourceBranch),
      cwd: input.checkout,
    })
    const ack = await acknowledgeStep(input.commonDir, operationId, "candidate", { candidateSha })
    if (!ack.ok) return { ok: false, reason: `the candidate was created but its journal acknowledgement failed: ${ack.reason}` }

    // Land through the guarded fast-forward into the clean base checkout.
    await recordStepIntent(input.commonDir, operationId, "land", { candidateSha })
    const baseDir = await findWorktreeDirForBranch(input.base, input.checkout)
    if (!baseDir) return { ok: false, reason: `base branch ${input.base} is not checked out in any registered worktree — check it out somewhere clean before squashing` }
    const baseBranchNow = await currentBranch(baseDir)
    if (baseBranchNow !== input.base) {
      return { ok: false, reason: `the base checkout ${baseDir} is on ${baseBranchNow ?? "a detached HEAD"}, not ${input.base}` }
    }
    const baseDirt = await statusPorcelain(baseDir)
    if (baseDirt.trim() !== "") {
      return { ok: false, reason: `the base checkout ${baseDir} is dirty — the landing needs a clean base; commit, stash, or clean it first` }
    }
    const baseNow = await resolveCommit(input.base, baseDir)
    if (baseNow !== baseSha) {
      return { ok: false, reason: `base ${input.base} moved to ${baseNow?.slice(0, 8) ?? "?"} (captured ${baseSha.slice(0, 8)}) — re-run sync and review the renewed integration` }
    }
    if (input.land) await input.land(candidateSha, baseDir)
    else {
      const merge = await execFile("git", ["merge", "--ff-only", "--", candidateSha], { cwd: baseDir, allowFailure: true })
      if (merge.exitCode !== 0) {
        return { ok: false, reason: `the guarded fast-forward into ${input.base} failed: ${(merge.stderr || merge.stdout).trim()} — the candidate commit ${candidateSha.slice(0, 8)} is preserved for inspection` }
      }
    }
    const landed = await resolveCommit(input.base, baseDir)
    if (landed !== candidateSha) {
      return { ok: false, reason: `the base did not advance onto the candidate (at ${landed?.slice(0, 8) ?? "?"}, candidate ${candidateSha.slice(0, 8)}) — inspect before retrying` }
    }
    await acknowledgeStep(input.commonDir, operationId, "land", { landedSha: candidateSha })
    await resolveOperation({ commonDir: input.commonDir, operationId, gitCwd: input.checkout, outcome: "resolved" })
    return { ok: true, landedSha: candidateSha, base: input.base, baseSha }
  } catch (error) {
    // The journal stays pending with its recorded evidence: recovery inspects
    // reality instead of replaying blindly.
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Builds the one-parent candidate commit in a private detached worktree at the
 * captured base: `git merge --squash` stages the source tree, the staged
 * content is scanned for secrets, and the commit is made under the operator's
 * identity — signing and hooks effective. The worktree is always removed.
 */
async function createCandidate(input: { sourceTip: string; baseSha: string; message: string; cwd: string }): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "convoy-squash-candidate-"))
  try {
    const added = await execFile("git", ["worktree", "add", "--detach", scratch, input.baseSha], { cwd: input.cwd, allowFailure: true })
    if (added.exitCode !== 0) throw new Error(`creating the private candidate checkout failed: ${(added.stderr || added.stdout).trim()}`)
    try {
      const squash = await execFile("git", ["merge", "--squash", input.sourceTip], { cwd: scratch, allowFailure: true })
      if (squash.exitCode !== 0) {
        throw new Error(`staging the source tree onto the captured base failed: ${(squash.stderr || squash.stdout).trim()}`)
      }
      // The candidate must not be the path that bypasses secret scanning.
      const porcelain = await statusPorcelain(scratch)
      const suspicious = findSuspiciousStagedFiles(porcelain)
      if (suspicious.length > 0) {
        throw new Error(`refusing to land: these files look like they contain secrets: ${suspicious.join(", ")} — remove them or add them to .gitignore and retry`)
      }
      await commitAsUser(input.message, scratch)
      const candidateSha = await resolveCommit("HEAD", scratch)
      if (!candidateSha) throw new Error("the candidate commit could not be resolved after creation")
      const parents = await commitParents(candidateSha, scratch)
      const tree = await treeOf(candidateSha, scratch)
      const sourceTree = await treeOf(input.sourceTip, scratch)
      if (parents.length !== 1 || parents[0] !== input.baseSha) {
        throw new Error(`the candidate must have exactly one parent, the captured base ${input.baseSha.slice(0, 8)} (got ${parents.length})`)
      }
      if (!tree || !sourceTree || tree !== sourceTree) {
        throw new Error(`the candidate's tree does not match the source tree (${tree?.slice(0, 8)} vs ${sourceTree?.slice(0, 8)})`)
      }
      return candidateSha
    } finally {
      await execFile("git", ["worktree", "remove", "--force", "--", scratch], { cwd: input.cwd, allowFailure: true })
    }
  } catch (error) {
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function commitParents(sha: string, cwd: string): Promise<string[]> {
  const result = await execFile("git", ["rev-list", "--parents", "-n", "1", sha], { cwd, allowFailure: true })
  if (result.exitCode !== 0) return []
  return result.stdout.trim().split(/\s+/).slice(1)
}
