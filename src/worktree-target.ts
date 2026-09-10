import { stat } from "node:fs/promises"

import { execFile, isAncestor, realpathSafe as physical, treeOf } from "./git"
import { currentBranch } from "./git"

/**
 * Observed checkout targets (change `worktree-control-center`, task 1.3,
 * design D1): a checkout target is a set of facts Git reports right now —
 * canonical checkout path, administrative Git directory, current branch or
 * detached state, and HEAD OID — never a minted identifier. Actions
 * re-observe and revalidate against the reviewed target before any effect;
 * disagreement stops for explicit reselection instead of falling back.
 */

export type ObservedCheckoutTarget = {
  /** The checkout path Git/`realpath` reports (absolute, physical). */
  checkoutPath: string
  /** The worktree's Git administrative directory resolved from the checkout. */
  gitDir?: string
  /** The repository's common directory; two targets share a repository iff these match. */
  commonDir: string
  /** Checked-out branch without `refs/heads/`; undefined when detached. */
  branch?: string
  /** True when HEAD is detached. */
  detached: boolean
  /** HEAD OID at observation time; undefined only when the repo has no commits. */
  head?: string
}

export type TargetValidation =
  | { ok: true; target: ObservedCheckoutTarget }
  | {
      ok: false
      code:
        | "missing"
        | "not-a-repo"
        | "different-repository"
        | "moved"
        | "branch-changed"
        | "head-changed"
        | "state-changed"
      reason: string
    }

/**
 * Observes a checkout as a target. Throws when the path is missing or not a
 * Git checkout — building a target from a non-checkout is exactly the
 * fabrication validation exists to prevent.
 */
export async function observeCheckoutTarget(checkoutPath: string): Promise<ObservedCheckoutTarget> {
  const physicalPath = await physical(checkoutPath)
  let dirInfo
  try {
    dirInfo = await stat(physicalPath)
  } catch {
    throw new Error(`checkout ${checkoutPath} does not exist`)
  }
  if (!dirInfo.isDirectory()) throw new Error(`checkout ${checkoutPath} is not a directory`)

  const gitDir = await execFile("git", ["rev-parse", "--path-format=absolute", "--git-dir"], {
    cwd: physicalPath,
    allowFailure: true,
  })
  if (gitDir.exitCode !== 0) throw new Error(`checkout ${checkoutPath} is not a git repository`)

  const common = await execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: physicalPath,
    allowFailure: true,
  })
  if (common.exitCode !== 0) throw new Error(`checkout ${checkoutPath} is not a git repository`)

  const branch = await currentBranch(physicalPath)
  const head = await resolveHead(physicalPath)
  return {
    checkoutPath: physicalPath,
    gitDir: gitDir.stdout.trim() || undefined,
    commonDir: common.stdout.trim(),
    branch,
    detached: branch === undefined,
    head,
  }
}

async function resolveHead(cwd: string): Promise<string | undefined> {
  const result = await execFile("git", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd, allowFailure: true })
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined
}

/**
 * Validates that the live Git state still matches a previously observed
 * target. The repository identity is the common directory (all worktrees of
 * one repository share it); continuity is established by matching path,
 * admin directory, branch/HEAD, and registration — never by branch spelling
 * or path alone. Nothing mutates; the returned reason is the remediation.
 */
export async function validateCheckoutTarget(
  observed: ObservedCheckoutTarget,
  options: { requireBranch?: string; requireHead?: string } = {},
): Promise<TargetValidation> {
  let fresh: ObservedCheckoutTarget
  try {
    fresh = await observeCheckoutTarget(observed.checkoutPath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, code: message.includes("is not a git repository") ? "not-a-repo" : "missing", reason: message }
  }

  if (fresh.commonDir !== observed.commonDir) {
    return {
      ok: false,
      code: "different-repository",
      reason: `checkout ${observed.checkoutPath} now belongs to a different repository (common dir ${fresh.commonDir}, was ${observed.commonDir})`,
    }
  }

  if (observed.gitDir && fresh.gitDir && fresh.gitDir !== observed.gitDir) {
    return {
      ok: false,
      code: "moved",
      reason: `checkout ${observed.checkoutPath} is registered through a different Git administrative directory (${fresh.gitDir}, was ${observed.gitDir}); reselect the target`,
    }
  }

  if (options.requireBranch !== undefined && fresh.branch !== options.requireBranch) {
    return {
      ok: false,
      code: "branch-changed",
      reason: `checkout ${observed.checkoutPath} has ${fresh.branch ?? "a detached HEAD"} checked out, but the reviewed target requires ${options.requireBranch}`,
    }
  }

  if (!observed.detached && !fresh.detached && observed.branch !== undefined && fresh.branch !== observed.branch) {
    return {
      ok: false,
      code: "branch-changed",
      reason: `checkout ${observed.checkoutPath} switched from ${observed.branch} to ${fresh.branch ?? "a detached HEAD"}; reselect the target`,
    }
  }

  if (observed.detached !== fresh.detached) {
    return {
      ok: false,
      code: "state-changed",
      reason: observed.detached
        ? `checkout ${observed.checkoutPath} left its detached-HEAD state (now on ${fresh.branch}); reselect the target`
        : `checkout ${observed.checkoutPath} left its branch ${observed.branch} (now detached); reselect the target`,
    }
  }

  if (observed.head !== undefined && fresh.head !== undefined && fresh.head !== observed.head) {
    return {
      ok: false,
      code: "head-changed",
      reason: `HEAD at ${observed.checkoutPath} advanced from ${observed.head} to ${fresh.head}; revalidate the reviewed target`,
    }
  }

  if (options.requireHead !== undefined && fresh.head !== options.requireHead) {
    return {
      ok: false,
      code: "head-changed",
      reason: `HEAD at ${observed.checkoutPath} is ${fresh.head ?? "unborn"}, but the reviewed target pins ${options.requireHead}`,
    }
  }

  return { ok: true, target: fresh }
}

/**
 * Requires explicit selectors to agree on one target before any effect: a
 * checkout path and a branch must resolve to the same registration, and an
 * unverifiable disagreement is refused rather than resolved by guessing.
 * Returns the observed target on success.
 */
export async function requireAgreeingSelectors(input: {
  checkoutPath?: string
  branch?: string
  /** Repository root any selector must belong to (common dir), when known. */
  commonDir?: string
}): Promise<TargetValidation> {
  const { checkoutPath, branch, commonDir } = input
  if (!checkoutPath && !branch) {
    return { ok: false, code: "missing", reason: "no target given: select an explicit checkout path or branch" }
  }

  if (checkoutPath) {
    let observed: ObservedCheckoutTarget
    try {
      observed = await observeCheckoutTarget(checkoutPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, code: message.includes("is not a git repository") ? "not-a-repo" : "missing", reason: message }
    }
    if (commonDir && observed.commonDir !== commonDir) {
      return {
        ok: false,
        code: "different-repository",
        reason: `checkout ${checkoutPath} belongs to a different repository (${observed.commonDir}) than the reviewed one (${commonDir})`,
      }
    }
    if (branch && observed.branch !== branch) {
      return {
        ok: false,
        code: "branch-changed",
        reason: `checkout ${checkoutPath} has ${observed.branch ?? "a detached HEAD"} checked out, not ${branch}; the selectors disagree`,
      }
    }
    return { ok: true, target: observed }
  }

  // Branch-only selector: resolve it through Git's worktree inventory, never
  // through a branch-derived path template.
  const result = await execFile("git", ["worktree", "list", "--porcelain", "-z"], { cwd: commonDir ?? process.cwd(), allowFailure: true })
  if (result.exitCode !== 0) {
    return { ok: false, code: "not-a-repo", reason: "the repository could not be read to resolve the branch selector" }
  }
  let found: string | undefined
  let current: string | undefined
  for (const field of result.stdout.split("\0")) {
    if (field.startsWith("worktree ")) current = field.slice("worktree ".length)
    else if (field === `branch refs/heads/${branch}` && current) {
      found = current
      break
    }
  }
  if (!found) {
    return { ok: false, code: "missing", reason: `branch "${branch}" is not checked out in any registered worktree; select the checkout explicitly` }
  }
  return requireAgreeingSelectors({ checkoutPath: found, commonDir })
}

/**
 * Whether `tip` is reachable from `base` (the base contains the tip) and
 * whether the two refs hold identical trees. Both are facts about the two
 * selected revisions only — neither promises anything about later reverts,
 * remote coverage, or historical integration.
 */
export async function observeRelation(tip: string, base: string, cwd: string): Promise<{ containedInBase: boolean; equalTrees: boolean } | undefined> {
  const contained = await isAncestor(tip, base, cwd)
  const [tipTree, baseTree] = await Promise.all([treeOf(tip, cwd), treeOf(base, cwd)])
  if (tipTree === undefined || baseTree === undefined) return undefined
  return { containedInBase: contained, equalTrees: tipTree === baseTree }
}
