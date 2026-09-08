import { isAbsolute, resolve } from "node:path"

import { execFile, mainWorktreeDir, pushRefspec, removeWorktree, statusPorcelain } from "./git"
import {
  inspectOperation,
  revalidateForExecution,
  type OperationAction,
  type OperationBlocker,
  type OperationInspection,
  type OperationRequirements,
} from "./operation-guards"
import type { ObservedCheckoutTarget } from "./worktree-target"

/**
 * Guarded mutation handlers (change `worktree-control-center`, tasks 2.2 and
 * 7.8 groundwork): the review→execute seam every mutating entry point goes
 * through. A CLI command, TUI menu, or dashboard action reviews an operation
 * once (`reviewOperation`), shows its blockers or its pinned facts, and
 * later executes through `executeReviewed`, which revalidates the reviewed
 * target immediately before the effect and refuses a stale review instead
 * of mutating the replacement. Keyboard handlers and headless requests use
 * the same seam, so UI enabled states are projections of these handlers,
 * never independent decisions.
 */

export type OperationReview =
  | { ok: true; review: OperationInspection }
  | { ok: false; blockers: OperationBlocker[]; review: OperationInspection }

/**
 * Reviews an operation for a checkout: the shared inspection (target,
 * dirt, base/upstream, activity, managed writer, legacy conflicts) plus any
 * per-call requirement overrides. Read-only — nothing here mutates. A
 * failed review still carries its inspection so callers can display the
 * observed facts alongside the blockers.
 */
export async function reviewOperation(input: {
  action: OperationAction
  checkout: string
  base?: string
  commonDir: string
  requirements?: Partial<OperationRequirements>
}): Promise<OperationReview> {
  const inspection = await inspectOperation(input)
  if (!inspection.available) return { ok: false, blockers: inspection.blockers, review: inspection }
  return { ok: true, review: inspection }
}

export type ExecutionOutcome<T> =
  | { ok: true; value: T; inspection: OperationInspection }
  | { ok: false; blockers: OperationBlocker[]; reason: "stale-review" | "blocked"; review: OperationInspection }

/**
 * Executes a reviewed operation: the effect-time revalidation re-observes
 * the target and pins the reviewed HEAD; any drift (branch switched, HEAD
 * advanced, writer appeared, legacy journal still unresolved, checkout
 * replaced) refuses the stale review and runs nothing.
 */
export async function executeReviewed<T>(input: {
  action: OperationAction
  checkout: string
  base?: string
  commonDir: string
  review: OperationInspection
  requirements?: Partial<OperationRequirements>
  /** The mutation itself; receives the freshly validated target. */
  effect: (target: ObservedCheckoutTarget) => Promise<T>
}): Promise<ExecutionOutcome<T>> {
  if (!input.review.available || input.review.target === undefined) {
    return { ok: false, reason: "blocked", blockers: input.review.blockers, review: input.review }
  }
  const revalidated = await revalidateForExecution({
    action: input.action,
    checkout: input.checkout,
    base: input.base,
    commonDir: input.commonDir,
    reviewed: input.review,
    requirements: input.requirements,
  })
  if (!revalidated.available || revalidated.target === undefined) {
    return { ok: false, reason: "stale-review", blockers: revalidated.blockers, review: revalidated }
  }
  const value = await input.effect(revalidated.target)
  return { ok: true, value, inspection: revalidated }
}

export type WorktreeRemovalOutcome = ExecutionOutcome<{ removedPath: string }>

/**
 * The removal safety review (task 7.4, design D8): the checks ordinary removal
 * requires before `git worktree remove` may run. Conservative by design —
 * valuable ignored content, submodules with local state, locks, dirt, the
 * main checkout, and the current process checkout all block; there is no
 * force-removal shortcut. Unknown state blocks too: it is never read as clean.
 */
export async function reviewWorktreeRemoval(checkout: string): Promise<OperationBlocker[]> {
  const blockers: OperationBlocker[] = []
  // Path comparisons resolve symlinks (macOS /var → /private/var) so a
  // physical and a logical spelling of the same checkout always compare equal.
  const real = async (path: string): Promise<string> => {
    try {
      const { realpath } = await import("node:fs/promises")
      return await realpath(path)
    } catch {
      return resolve(path)
    }
  }
  const samePath = (a: string, b: string): boolean => resolve(a) === resolve(b)
  const checkoutReal = await real(checkout)
  const sameCheckout = (other: string): boolean => samePath(other, checkout) || samePath(other, checkoutReal)

  // The main checkout and the current process checkout are never removed.
  const main = await mainWorktreeDir(checkout).catch(() => undefined)
  if (main !== undefined && sameCheckout(main)) {
    blockers.push({
      reason: `${checkout} is the repository's main checkout — it is never removed`,
      remediation: "select a linked worktree to remove; the main checkout stays",
    })
  }
  let processDir = process.cwd()
  try {
    const { realpath } = await import("node:fs/promises")
    processDir = await realpath(processDir)
  } catch {
    // Unresolvable cwd: the resolved comparison below still applies.
  }
  if (sameCheckout(processDir)) {
    blockers.push({
      reason: `${checkout} is the current process's own checkout — removing it would pull the working directory out from under this session`,
      remediation: "run the removal from another checkout (for example the main checkout): `convoy worktrees remove --worktree <path>`",
    })
  }

  // Registration state, read through the shared inventory parser (task 1.2):
  // a locked or prunable registration is not removable.
  const { listWorktrees } = await import("./worktree-inventory")
  let inventory: Awaited<ReturnType<typeof listWorktrees>> | undefined
  try {
    inventory = await listWorktrees(checkout)
  } catch (error) {
    blockers.push({
      reason: `the worktree registration could not be read: ${error instanceof Error ? error.message : String(error)}`,
      remediation: "resolve the Git failure first; unknown registration state is never treated as removable",
    })
  }
  if (inventory) {
    const entry = inventory.entries.find((candidate) => sameCheckout(candidate.path))
    if (entry) {
      if (entry.locked) {
        blockers.push({
          reason: `the worktree is locked${entry.locked.reason ? `: ${entry.locked.reason}` : ""}`,
          remediation: "unlock it with `git worktree unlock <path>` (after resolving why it was locked) before removing",
        })
      }
      if (entry.prunable) {
        blockers.push({
          reason: `the registration reports prunable: ${entry.prunable.reason ?? "stale state"}`,
          remediation: "inspect with `git worktree prune --dry-run`; repair or prune the stale registration before removing",
        })
      }
    }
    // An entry that Git's inventory does not report at all is not a verified
    // registration: removal refuses rather than guessing.
    if (!entry) {
      blockers.push({
        reason: `${checkout} is not reported by this repository's worktree inventory`,
        remediation: "select a registered checkout (see `convoy worktrees`); unregistered paths are never removed",
      })
    }
  }

  // Tracked and untracked content: ordinary removal never deletes local data.
  const status = await statusPorcelain(checkout).catch(() => undefined)
  if (status === undefined) {
    blockers.push({
      reason: `the working-tree state of ${checkout} could not be read`,
      remediation: "resolve the Git failure; unknown status is never treated as clean",
    })
  } else {
    const lines = status.split("\n").filter((line) => line.trim() !== "")
    if (lines.length > 0) {
      blockers.push({
        reason: `the checkout has ${lines.length} uncommitted change(s) (tracked or untracked) that removal would delete`,
        remediation: "commit, stash, or remove them explicitly first — removal never forces away local data",
      })
    }
    // Ignored content may hold valuable local state (env files, caches with
    // credentials, build artifacts not reproducible from source): it blocks
    // ordinary removal until dealt with explicitly (design D8).
    const ignored = await execFile("git", ["status", "--porcelain", "--ignored"], { cwd: checkout, allowFailure: true })
    if (ignored.exitCode !== 0) {
      blockers.push({
        reason: `ignored content could not be inspected: ${(ignored.stderr || ignored.stdout).trim()}`,
        remediation: "resolve the Git failure; unknown ignored content is never treated as absent",
      })
    } else {
      const ignoredPaths = ignored.stdout.split("\n").filter((line) => line.startsWith("!!"))
      if (ignoredPaths.length > 0) {
        blockers.push({
          reason: `the checkout contains ${ignoredPaths.length} ignored file(s)/director(ies) that removal would delete`,
          remediation: "move or delete the ignored content explicitly first — ordinary removal has no force shortcut",
        })
      }
    }
  }

  // Submodules with local state (changed commits, uninitialized, or conflicts)
  // may hold work that only exists inside them.
  const submodules = await execFile("git", ["submodule", "status", "--recursive"], { cwd: checkout, allowFailure: true })
  if (submodules.exitCode === 0) {
    const dirty = submodules.stdout.split("\n").filter((line) => line.trim() !== "" && !line.startsWith(" "))
    if (dirty.length > 0) {
      blockers.push({
        reason: `${dirty.length} submodule(s) have local state (changed commit, uninitialized, or conflicted): ${dirty.map((line) => line.slice(1).split(" ")[1] ?? line.slice(1)).join(", ")}`,
        remediation: "resolve the submodule state (sync/commit/update) before removing the checkout",
      })
    }
  }
  // A failed submodule query is not evidence of clean submodules, but Git's
  // own `worktree remove` still refuses unsafe removals; the explicit failure
  // is disclosed rather than silently ignored.
  else {
    blockers.push({
      reason: `submodule state could not be read: ${(submodules.stderr || submodules.stdout).trim()}`,
      remediation: "resolve the Git failure; unknown submodule state is never treated as clean",
    })
  }

  return blockers
}

/**
 * Removes a registered worktree through the guarded seam: the review checks
 * the writer claim, legacy conflicts, and the full removal contract (task
 * 7.4) — main/process-checkout refusals, locks, tracked/untracked/ignored
 * content, and submodule state; execution revalidates the exact checkout
 * before `git worktree remove` runs. There is no force-removal shortcut.
 */
export async function removeRegisteredWorktree(input: {
  checkout: string
  commonDir: string
  /** Injected effect for tests; defaults to the real `git worktree remove`. */
  effect?: (target: ObservedCheckoutTarget) => Promise<{ removedPath: string }>
  /** Injected removal review for tests; defaults to the real safety checks. */
  review?: (checkout: string) => Promise<OperationBlocker[]>
}): Promise<WorktreeRemovalOutcome> {
  const safety = input.review ? await input.review(input.checkout) : await reviewWorktreeRemoval(input.checkout)
  const review = await reviewOperation({ action: "remove", checkout: input.checkout, commonDir: input.commonDir })
  const blockers = [...safety, ...(review.ok ? [] : review.blockers)]
  if (blockers.length > 0 || !review.review.available) {
    return { ok: false, reason: "blocked", blockers, review: review.review }
  }
  return executeReviewed({
    action: "remove",
    checkout: input.checkout,
    commonDir: input.commonDir,
    review: review.review,
    effect:
      input.effect ??
      (async (target) => {
        // `git worktree remove` refuses to delete the checkout it runs in, so
        // the command runs from the repository's main checkout.
        const main = (await mainWorktreeDir(target.checkoutPath)) ?? target.checkoutPath
        await removeWorktree(target.checkoutPath, main)
        return { removedPath: target.checkoutPath }
      }),
  })
}

export type PushOutcome = ExecutionOutcome<{ pushedRef: string }>

/**
 * Rejects force-equivalent refspecs at the handler boundary (task 5.3): a
 * push through this seam publishes with a normal non-force update only. A
 * leading `+`, a `--force`-shaped remote ref, or any `+` anywhere in the
 * refspec is refused before review — never silently rewritten into a
 * non-force form, and never passed to Git.
 */
export function assertNonForceRefspec(refspec: string): void {
  if (refspec.includes("+")) {
    throw new Error(`refusing force push: refspec "${refspec}" contains "+" — push publishes with a normal non-force update only`)
  }
  if (/\s/.test(refspec)) {
    throw new Error(`refusing malformed refspec "${refspec}": expected <local>:<remote> without whitespace`)
  }
  if (!refspec.includes(":")) {
    throw new Error(`refusing ambiguous refspec "${refspec}": push requires an explicit <local>:<remote> destination`)
  }
  const [, remoteRef = ""] = refspec.split(":")
  if (remoteRef === "" || remoteRef.startsWith("-")) {
    throw new Error(`refusing malformed refspec "${refspec}": the remote side must name a ref`)
  }
}

/**
 * Pushes the reviewed committed revision through the guarded seam: the
 * review pins the exact HEAD OID and destination; execution refuses to push
 * if the source advanced after review (later local commits cannot silently
 * join the accepted push). The refspec is validated non-force at this
 * boundary (task 5.3) — no caller can smuggle a force update through.
 */
export async function pushCommittedRevision(input: {
  checkout: string
  commonDir: string
  remote: string
  /** Refspec `<local>:<remote>`; validated non-force before any effect. */
  refspec: string
  /** Injected effect for tests; defaults to the real non-force `git push`. */
  effect?: (target: ObservedCheckoutTarget) => Promise<{ pushedRef: string }>
}): Promise<PushOutcome> {
  assertNonForceRefspec(input.refspec)
  const review = await reviewOperation({ action: "push", checkout: input.checkout, commonDir: input.commonDir })
  if (!review.ok) return { ok: false, reason: "blocked", blockers: review.blockers, review: review.review }
  return executeReviewed({
    action: "push",
    checkout: input.checkout,
    commonDir: input.commonDir,
    review: review.review,
    effect: input.effect ?? (async (target) => {
      await pushRefspec(input.remote, input.refspec, target.checkoutPath)
      return { pushedRef: input.refspec }
    }),
  })
}
