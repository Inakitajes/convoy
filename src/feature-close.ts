import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  commitAsUser,
  currentBranch,
  detectBaseRef,
  diffStat,
  execFile,
  findSuspiciousStagedFiles,
  isAncestor,
  mainWorktreeDir,
  findWorktreeDirForBranch,
  mergeBase,
  removeWorktree,
  resolveCommit,
  statusPorcelain,
} from "./git"
import { branchIdFromBranch, isOpenSpecChangeId, openspecDirName } from "./openspec"
import { lifecycleCommonDir } from "./feature-lifecycle/store"
import { resolveFeature, type FeatureResolution } from "./feature-lifecycle/resolver"
import {
  listAttemptIds,
  listReceiptIds,
  readAttemptJournal,
  readFeatureRecord,
  readReceipt,
  writeAttemptJournal,
  writeFeatureRecord,
  writeReceiptIfAbsent,
  type CloseAttemptJournal,
  type FeatureRecord,
  type LandingReceipt,
} from "./feature-lifecycle/records"
import { isLandingReachableFrom as featureLandingReachable, protectFeatureRef } from "./feature-lifecycle/refs"
import { featureCandidateRef as featureCandidateRefName, featureTipRef as featureTipRefName } from "./feature-lifecycle/refs"
import { withFeatureLock } from "./feature-lifecycle/store"
import {
  clearCloseJournal,
  closeCommonDir,
  closeCandidateRef,
  closeFeatureTipRef,
  protectCloseRef,
  isLandingReachable,
  readCloseJournal,
  writeCloseJournal,
  type CloseJournal,
} from "./close-journal"
import {
  closeFallbackCommitMessage,
  formatCommitMessage,
  normalizeComposedMessage,
  proposeCommitMessage,
  type CommitMessageProposal,
} from "./commit-message"
import { maxCommitSubjectLength, stripControlBytes } from "./commit-text"
import { listRuns } from "./runs"
import { acquireMutationLease, LeaseUnavailableError, type MutationLease } from "./finalization/lease"

/**
 * `convoy close` — the death of a feature, one resumable sequence (capability
 * `feature-close`, design D6): preflight → sync (merge the base branch into
 * the feature branch) → archive (through the OpenSpec CLI, the tool that owns
 * that state) → squash-merge (stage a one-parent candidate commit in a private
 * integration worktree at the captured base, then advance the base onto it
 * with a guarded fast-forward-only ref update). Each step checks its own
 * precondition, so `close --resume` after a mid-sequence stop continues from
 * the first incomplete step without redoing completed ones.
 *
 * The landing is always exactly one regular commit on the base branch whose
 * tree is the feature's post-archive tree. The feature branch is never
 * rewritten — its history (operator proposal commits, run-compaction commits,
 * sync/archive work) survives untouched — and published history is never
 * rewritten by construction: the candidate's parent is the captured base, so
 * landing is a pure fast-forward of the base ref, guarded by an expected-old
 * value that refuses when the base moved.
 *
 * The sequence narrates itself through one-way `CloseEvent`s (design D8) and
 * gates the candidate commit behind a separate `resolveMessage` resolver, so
 * the TTY checklist and the headless formatter consume the same stream.
 */

export type CloseStep = "sync" | "archive" | "squash-merge"

/**
 * The squash-merge step's typed sub-states (design D8): stable identifiers the
 * renderers map to their own copy, so semantic operation state stays in the
 * orchestrator instead of being inferred from which renderer is waiting.
 */
export type CloseSquashPhase = "composing-message" | "awaiting-message-review" | "creating-commit"

/** How the close ended, stated once (design D8: no dual merge-shape narration). */
export type CloseDisposition =
  /** The base advanced onto the one candidate commit. */
  | "landed"
  /** The feature's post-archive tree equals the captured base tree — nothing to land, no empty commit. */
  | "no-content-to-land"
  /** A verified receipt shows this exact feature already landed; nothing was redone. */
  | "already-landed"

export type CloseEvent =
  | { type: "preflight"; summary: string }
  | { type: "preflight-failed"; blockers: readonly ClosePreflightBlocker[] }
  | { type: "step-started"; step: CloseStep }
  | { type: "step-completed"; step: CloseStep; detail?: string }
  | { type: "step-skipped"; step: CloseStep; reason: string }
  | { type: "step-failed"; step: CloseStep; message: string }
  | { type: "squash-phase"; phase: CloseSquashPhase }
  | { type: "result"; result: CloseResult }

/** What the message gate hands the operator: the normalized proposal, and where it came from. */
export type CloseMessageProposal = {
  message: string
  source: "model" | "fallback"
  /** Set when the writing model failed and the message is the deterministic fallback. */
  error?: string
}

/**
 * An open pull request detected for the feature branch (capability
 * feature-close, PR-aware close): the probe's whole truth. Close never
 * asserts merge state — it discloses what it found, rides the GitHub-recognized
 * `(#N)` reference on the composed subject, and leaves every GitHub mutation
 * to the operator's deliberate follow-ups.
 */
export type DetectedPullRequest = {
  number: number
  title?: string
  url: string
}

export type CloseInput = {
  /** The repo (used to detect the base branch and reach the main checkout). */
  targetDir: string
  /** The feature worktree; resolved from `branch` or the current directory when omitted. */
  worktreeDir?: string
  /** The feature branch; defaults to the worktree's checked-out branch. */
  branch?: string
  /** The change to archive; defaults to the branch's change id (the shared resolver rule). */
  changeID?: string
  /** Explicit stable feature id (design D3): resolution is identity-keyed, never a heuristic fallback. */
  featureId?: string
  /**
   * Cleanup-only continuation of a verified landing (design D9): the
   * feature-keyed guarded commands the TUI and headless output print are
   * this same executable surface. Requires `featureId`.
   */
  cleanup?: "worktree" | "branch"
  /** Continue a previously stopped sequence: completed steps are detected, not repeated. */
  resume?: boolean
  /** Override for the landing commit's message; wins verbatim and bypasses composition. */
  message?: string
  /** One-way narration of the sequence (design D8); safe to ignore for scripted calls. */
  onEvent?: (event: CloseEvent) => void
  /**
   * The two-way gate before the candidate commit is created: receives the
   * composed message and returns the message to commit, or undefined to stop
   * the sequence before the landing. Headless callers omit it (the proposal is
   * accepted unchanged); `--message` never reaches it.
   */
  resolveMessage?: (proposal: CloseMessageProposal) => Promise<string | undefined>
  /**
   * Releases an interactive renderer while a user-owned git command may need
   * the terminal (commit signing, hooks, credential prompts). Headless callers
   * omit it and execute the action directly.
   */
  withTerminal?: <T>(action: () => Promise<T>) => Promise<T>
  /** Test seam: the commit writer behind composition. Defaults to `proposeCommitMessage`. */
  writer?: (input: Parameters<typeof proposeCommitMessage>[0]) => Promise<CommitMessageProposal>
  /** Test seam: the open-PR probe. Defaults to the real GitHub CLI probe; undefined means none detected. */
  probePullRequest?: (branch: string) => Promise<DetectedPullRequest | undefined>
}

export type ClosePreflightBlocker = {
  check: "clean-tree" | "tasks" | "live-run" | "main-checkout" | "unrelated-base"
  message: string
}

export type CloseStop = {
  /** The step the sequence stopped at, so --resume knows where to pick up. */
  step: CloseStep
  message: string
}

export type CloseResult = {
  changeID: string
  branch: string
  worktreeDir: string
  baseRef: string
  disposition: CloseDisposition
  /** Present when the disposition is "landed" or "already-landed". */
  landing?: { sha: string }
  /**
   * The resolved registered feature (task 7.1): the follow-up surface uses it
   * to print the feature-keyed guarded cleanup commands (design D9) instead
   * of display-only git recipes.
   */
  featureId?: string
  /**
   * The open pull request this attempt detected for the feature branch
   * (PR-aware close), present only when a landing happened this attempt: the
   * composed subject carried its `(#N)` reference and the follow-up surface
   * names the deliberate fallback close command. Never asserts merge state.
   */
  pullRequest?: DetectedPullRequest
}

export type CloseTarget = {
  worktreeDir: string
  branch: string
  changeID: string
  /** The registered feature this close resolved to, when one is associated (task 7.1). */
  feature?: FeatureRecord
}

/**
 * Resolves the registered feature for this close through the shared resolver
 * (task 7.1): the branch/change selectors must agree with the feature's
 * verified association — a mistyped change selector refuses before mutation
 * instead of checking or modifying another change. The tagged resolution is
 * returned so `runClose` can refuse every unresolved shape before mutation
 * (task 7.1 + the BREAKING proposal bullet: an unassociated close is an
 * adoption decision, never a branch-name guess).
 */
async function resolveCloseFeature(input: CloseInput, target: CloseTarget): Promise<FeatureResolution | undefined> {
  const commonDir = await lifecycleCommonDir(input.targetDir)
  if (!commonDir) return undefined
  return resolveFeature({ cwd: input.targetDir, commonDir, ...(input.featureId ? { featureId: input.featureId } : {}), branch: target.branch, changeId: target.changeID })
}

/**
 * The adoption gate (task 7.1, the proposal's BREAKING bullet): an unresolved
 * context is a consent decision, never a branch-name guess — close refuses
 * before any mutation and names the exact explicit adoption (or rebinding)
 * command the operator runs to establish the association. Interactive close
 * surfaces the same review through its checklist instead of running sync or
 * archive.
 */
function unassociatedCloseError(resolution: FeatureResolution, target: CloseTarget, baseRef: string): Error {
  const adopt =
    `convoy feature adopt --branch ${shq(target.branch)} --change ${shq(target.changeID)} --base ${shq(baseRef)}`
  if (resolution.status === "unreadable") {
    return new Error(
      `close: registered feature evidence is unreadable — ${resolution.reason}. ` +
        "Close refuses to mutate while identity cannot be verified; repair the records (see `convoy feature show`) and try again.",
    )
  }
  if (resolution.status === "missing") {
    return new Error(
      `close: ${resolution.reason}. Close refuses before any mutation; resolve or adopt the work first (see \`convoy feature show\`).`,
    )
  }
  const detail = resolution.status === "unassociated" && resolution.reason ? ` (${resolution.reason})` : ""
  return new Error(
    `close: ${target.branch} has no verified feature association${detail} — close refuses to guess ownership and performs no mutation. ` +
      `Adopt the work explicitly, then close again:\n  ${adopt}\n` +
      "(browsing never adopts; only the explicit command or an accepted review establishes the association)",
  )
}

/**
 * Resolves the feature the close sequence operates on. Explicit worktree and
 * branch (the board's handoff) win; a bare `--branch` resolves its worktree
 * from the repo's worktree list; running inside the worktree is enough on its
 * own. The change id follows the shared branch↔change rule unless `--change`
 * pins it. A completed receipt lets cleanup-only resumes proceed without a
 * worktree (design D7): the caller names the branch, the receipt supplies the
 * rest, and no worktree is demanded.
 */
export async function resolveCloseTarget(input: CloseInput): Promise<CloseTarget> {
  const { targetDir } = input
  let worktreeDir = input.worktreeDir
  let branch = input.branch

  if (!worktreeDir && branch) worktreeDir = (await findWorktreeDirForBranch(branch, targetDir)) ?? undefined
  if (!worktreeDir && !input.resume) {
    // Running inside the feature worktree is the natural `convoy close` cwd.
    const main = await mainWorktreeDir(targetDir).catch(() => undefined)
    if (main && (await resolveSame(main, targetDir)) === false) {
      worktreeDir = targetDir
    }
  }
  if (!worktreeDir) {
    throw new Error(
      "couldn't locate the feature worktree: pass --branch <name>, run inside the worktree, or — when the feature's context moved — rebind it with `convoy feature bind <feature-id> --branch <name> --worktree <path>`",
    )
  }

  if (!branch) branch = await currentBranch(worktreeDir)
  if (!branch) throw new Error(`the worktree at ${worktreeDir} has a detached HEAD; check out the feature branch first`)

  const changeID = input.changeID ?? branchIdFromBranch(branch)
  if (!changeID || !isOpenSpecChangeId(changeID)) {
    throw new Error(`branch "${branch}" carries no change id (expected <type>/<change-id>); pass --change <id>`)
  }
  return { worktreeDir, branch, changeID }
}

async function resolveSame(a: string, b: string): Promise<boolean> {
  try {
    const { realpath } = await import("node:fs/promises")
    return (await realpath(a)) === (await realpath(b))
  } catch {
    return a === b
  }
}

/**
 * The preflight state: the blocking conditions (each with its concrete
 * remediation) plus the one-line summary the checklist renders (design D8:
 * `clean tree · 24/24 tasks · no live runs`, plus the factual remote context
 * when the feature is published).
 */
export type ClosePreflightState = {
  blockers: ClosePreflightBlocker[]
  summary: string
}

/**
 * The blocking preflight conditions, each with its concrete remediation.
 * Returned (not thrown) so the caller can print them all at once; an empty
 * list means the sequence may start. Both worktrees are checked before any
 * mutation: the feature tree must be clean, and the main checkout must sit
 * clean and on the base branch the landing will advance (design D6, task 5.2).
 * A published feature branch is disclosed factually, never treated as a
 * blocker — and an upstream alone is never described as proof of anything.
 */
export async function closePreflight(input: CloseInput, target: CloseTarget): Promise<ClosePreflightBlocker[]> {
  return (await closePreflightState(input, target)).blockers
}

export async function closePreflightState(input: CloseInput, target: CloseTarget): Promise<ClosePreflightState> {
  const blockers: ClosePreflightBlocker[] = []
  const baseRef = await closeBaseRef(input.targetDir)

  // Fail closed: a git status that cannot be read must not be read as "clean",
  // because the sequence that follows moves the base branch. If we cannot
  // verify the tree, we refuse (SC-6).
  let porcelain: string
  let treeVerifiable = true
  try {
    porcelain = await statusPorcelain(target.worktreeDir)
  } catch (error) {
    porcelain = ""
    treeVerifiable = false
    blockers.push({
      check: "clean-tree",
      message: `couldn't verify the worktree at ${target.worktreeDir} is clean (${error instanceof Error ? error.message : error}) — refusing to move history under an unverifiable tree`,
    })
  }
  if (porcelain.trim() !== "") {
    blockers.push({ check: "clean-tree", message: `the worktree at ${target.worktreeDir} has uncommitted changes — commit or stash them first` })
  }

  const { openspecTaskCounts } = await import("./control-board")
  // An already-archived change (a resumed sequence) has no task list to
  // check — its precondition was satisfied and archived away with the change.
  const changeStillPresent = await exists(join(target.worktreeDir, openspecDirName, "changes", target.changeID))
  let taskSummary: string | undefined
  if (changeStillPresent) {
    const tasks = (await openspecTaskCounts(target.worktreeDir)).get(target.changeID)
    if (!tasks || tasks.total === 0) {
      blockers.push({ check: "tasks", message: `no task list found for change ${target.changeID}; finish the tasks before closing` })
      taskSummary = "no task list"
    } else if (tasks.done < tasks.total) {
      blockers.push({ check: "tasks", message: `${tasks.total - tasks.done} of ${tasks.total} tasks are incomplete — finish them before closing` })
      taskSummary = `${tasks.done}/${tasks.total} tasks`
    } else {
      taskSummary = `${tasks.done}/${tasks.total} tasks`
    }
  }

  let liveCount = 0
  try {
    const runs = await listRuns()
    // Compare by resolved physical path: the worktree dir recorded in a run
    // plan and the one resolved from `git worktree list` can differ textually
    // (/var vs /private/var on macOS) while naming the same checkout — a raw
    // string comparison would let a live agent be missed (SC-6).
    for (const run of runs) {
      if (run.live && run.targetDir && (await resolveSame(run.targetDir, target.worktreeDir))) liveCount += 1
    }
  } catch (error) {
    blockers.push({
      check: "live-run",
      message: `couldn't verify no live run is attached to ${target.branch} (${error instanceof Error ? error.message : error}) — refusing while run state is unreadable`,
    })
  }
  if (liveCount > 0) {
    blockers.push({ check: "live-run", message: `${liveCount} live run${liveCount === 1 ? " is" : "s are"} attached to ${target.branch} — wait for or stop ${liveCount === 1 ? "it" : "them"} first` })
  }

  // The landing advances the base branch from the main checkout (design D6,
  // task 5.2): that checkout must be verifiably clean and already on the base
  // branch — close never moves the operator's own checkout out from under
  // them. This check lives in preflight so a stop happens before any sync or
  // archive mutation, not after the feature work has been prepared.
  const mainDir = (await mainWorktreeDir(input.targetDir).catch(() => undefined)) ?? input.targetDir
  const mainBranch = await currentBranch(mainDir).catch(() => undefined)
  if (mainBranch !== baseRef) {
    blockers.push({
      check: "main-checkout",
      message: `the main checkout is on ${mainBranch ?? "a detached HEAD"}, not ${baseRef} — check out ${baseRef} there, then run \`convoy close --resume\``,
    })
  } else {
    const mainStatus = await statusPorcelain(mainDir).catch(() => "unreadable")
    if (mainStatus.trim() !== "") {
      blockers.push({ check: "main-checkout", message: "the main checkout has uncommitted changes — commit or stash them first, then run `convoy close --resume`" })
    }
  }

  // The fork relationship is derived from git, never from a branch timestamp
  // or a configurable boundary (design D6, task 5.2): unrelated or ambiguous
  // histories are refused rather than falling back to HEAD.
  const related = await mergeBase(baseRef, target.branch, target.worktreeDir).catch(() => undefined)
  if (!related) {
    blockers.push({
      check: "unrelated-base",
      message: `${target.branch} and ${baseRef} share no merge-base — close refuses to land across unrelated histories`,
    })
  }

  const parts: string[] = [
    // Verified feature/context identification (task 7.8): the checklist's
    // preflight line names the registered feature it is about to act on.
    ...(target.feature ? [`feature ${target.feature.displayName}`] : []),
    treeVerifiable ? "clean tree" : "tree unverifiable",
  ]
  if (taskSummary) parts.push(taskSummary)
  parts.push(liveCount === 0 ? "no live runs" : `${liveCount} live run${liveCount === 1 ? "" : "s"}`)
  // Factual remote disclosure (design D7): an upstream is reported, never
  // interpreted — close neither blocks on it nor claims a PR exists.
  const upstream = await import("./git").then((git) => git.branchUpstream(target.branch, target.worktreeDir).catch(() => undefined))
  if (upstream) parts.push(`${target.branch} tracks ${upstream}`)
  return { blockers, summary: parts.join(" · ") }
}

/**
 * The full closing sequence. Throws `Error` on every stop (preflight
 * blockers, sync conflict, archive failure, declined message, stale base,
 * landing failure); the error message names the step and the remediation, and
 * `close --resume` picks up from the first incomplete step. Every state
 * change the renderers need travels through `input.onEvent` (design D8) — the
 * TTY checklist and the headless formatter consume the same stream, so
 * narration has one source.
 */
export async function runClose(input: CloseInput): Promise<CloseResult> {
  const emit = (event: CloseEvent) => input.onEvent?.(event)
  const baseRef = await closeBaseRef(input.targetDir)
  const mainDir = (await mainWorktreeDir(input.targetDir).catch(() => undefined)) ?? input.targetDir
  const commonDir = await closeCommonDir(input.targetDir)

  // Identity-keyed resolution (design D3 rule 1, task 7.1): an explicit
  // --feature resolves the record directly and cross-checks the selectors —
  // before any worktree is demanded, so a worktree-less resume and the
  // feature-keyed cleanup work by identity rather than branch spelling.
  let explicitFeature: FeatureRecord | undefined
  if (input.featureId !== undefined) {
    if (!commonDir) throw new Error(`close: no git repository — feature ${input.featureId} cannot resolve`)
    const read = await readFeatureRecord(commonDir, input.featureId)
    if (read.status !== "found") {
      const why = read.status === "corrupt" || read.status === "unreadable" ? `: ${read.reason}` : ""
      throw new Error(
        `close: feature ${input.featureId} could not be resolved (${read.status}${why}) — run \`convoy feature show\` to list the registered features.`,
      )
    }
    explicitFeature = read.value
    if (input.branch && explicitFeature.context?.branch !== input.branch) {
      throw new Error(
        `close: the selectors disagree with the registered association — feature ${input.featureId} is associated with branch "${explicitFeature.context?.branch ?? "(none)"}", not "${input.branch}". Close refuses before any mutation.`,
      )
    }
    if (input.changeID && !explicitFeature.contracts.some((contract) => contract.changeId === input.changeID)) {
      throw new Error(
        `close: the selectors disagree with the registered association — change "${input.changeID}" is not one of feature ${input.featureId}'s contracts. Close refuses before any mutation.`,
      )
    }
  }

  // Receipt fast path (design D7, task 5.1): a resume against a completed
  // receipt skips completed work before any worktree is demanded, even when
  // the worktree was already removed and cleanup is all that remains.
  if (input.resume && input.branch && commonDir) {
    const receipt = await readCloseJournal(commonDir, input.branch, input.changeID ?? branchIdFromBranch(input.branch) ?? "")
    if (receipt?.phase === "landed" && receipt.landingSha && receipt.postArchiveTip && receipt.checkoutMaterialized !== false) {
      const reachable = await isLandingReachable(receipt.landingSha, baseRef, mainDir)
      const tip = await resolveCommit(receipt.branch, mainDir).catch(() => undefined)
      const tipUnchanged = tip === undefined || tip === receipt.postArchiveTip
      if (reachable && tipUnchanged) {
        const summary = `landing ${receipt.landingSha.slice(0, 8)} already recorded for ${receipt.branch} → ${baseRef}`
        emit({ type: "preflight", summary: `${summary} · nothing to redo` })
        for (const step of ["sync", "archive", "squash-merge"] as const) {
          emit({ type: "step-skipped", step, reason: "a verified landing receipt covers this sequence" })
        }
        const result: CloseResult = {
          changeID: receipt.changeID,
          branch: receipt.branch,
          worktreeDir: input.worktreeDir ?? (await findWorktreeDirForBranch(receipt.branch, input.targetDir)) ?? mainDir,
          baseRef,
          disposition: "already-landed",
          landing: { sha: receipt.landingSha },
          ...(explicitFeature ? { featureId: explicitFeature.featureId } : {}),
        }
        emit({ type: "result", result })
        return result
      }
      if (!reachable) {
        throw new Error(
          `close receipt invalid: landing ${receipt.landingSha.slice(0, 8)} is no longer reachable from ${baseRef} — ` +
            "inspect the branch history before closing again; a revert is an explicit git revert, never a re-land",
        )
      }
      throw new Error(
        `close receipt invalid: ${receipt.branch}'s tip moved past the landed state (${receipt.postArchiveTip.slice(0, 8)}) — ` +
          "inspect the branch, then plan a new close",
      )
    }
  }

  // Identity-keyed receipt fast path (--feature, design D8): every close with
  // an explicit feature id consults that feature's receipts BEFORE any
  // worktree is demanded — a worktree-less resume, or a repeated close after
  // cleanup, reports the recorded landing instead of guessing by branch.
  if (explicitFeature && commonDir) {
    const receipt = await latestVerifiedReceipt(commonDir, explicitFeature.featureId, mainDir)
    if (receipt) {
      const summary = `landing ${receipt.landingSha.slice(0, 8)} already recorded for ${receipt.branch} → ${receipt.baseRef}`
      emit({ type: "preflight", summary: `${summary} · nothing to redo` })
      for (const step of ["sync", "archive", "squash-merge"] as const) {
        emit({ type: "step-skipped", step, reason: "a verified landing receipt covers this sequence" })
      }
      const result: CloseResult = {
        changeID: input.changeID ?? explicitFeature.contracts[0]?.changeId ?? branchIdFromBranch(receipt.branch) ?? receipt.branch,
        branch: receipt.branch,
        worktreeDir: input.worktreeDir ?? (await findWorktreeDirForBranch(receipt.branch, input.targetDir)) ?? mainDir,
        baseRef: receipt.baseRef,
        disposition: "already-landed",
        landing: { sha: receipt.landingSha },
        featureId: explicitFeature.featureId,
      }
      emit({ type: "result", result })
      return result
    }
  }

  // An explicit feature id pins the branch: the feature's current context
  // (or, failing that, its landing receipt's branch) supplies what a bare
  // `--branch` would have, so identity — not branch spelling — selects the
  // work (design D3 rule 1).
  const branchHint = input.branch ?? explicitFeature?.context?.branch
  const target = await resolveCloseTarget(branchHint ? { ...input, branch: branchHint } : input)
  // Identity-keyed resolution (task 7.1): the selectors must agree with the
  // registered association; a contradictory selector refuses before mutation.
  const resolution = await resolveCloseFeature(input, target)
  if (resolution) {
    if (resolution.status === "verified") {
      target.feature = resolution.feature
    } else if (resolution.status === "ambiguous") {
      throw new Error(
        `close: the selectors disagree with the registered association — ${resolution.reason}. ` +
          "Close refuses before any mutation; pass --feature <id> (see `convoy feature show`) or fix the selectors.",
      )
    } else {
      throw unassociatedCloseError(resolution, target, baseRef)
    }
  }
  // Every close — with or without --resume — consults identity-keyed landing
  // receipts before new sync/archive work (task 7.3/D8: repeated close after
  // success performs nothing).
  if (target.feature && commonDir && !explicitFeature) {
    const landing = await verifiedIdentityReceipt(commonDir, target.feature, baseRef, input.targetDir)
    if (landing) {
      const summary = `landing ${landing.landingSha.slice(0, 8)} already recorded for ${target.branch} → ${baseRef}`
      emit({ type: "preflight", summary: `${summary} · nothing to redo` })
      for (const step of ["sync", "archive", "squash-merge"] as const) {
        emit({ type: "step-skipped", step, reason: "a verified landing receipt covers this sequence" })
      }
      const result: CloseResult = {
        changeID: target.changeID,
        branch: target.branch,
        worktreeDir: input.worktreeDir ?? (await findWorktreeDirForBranch(target.branch, input.targetDir)) ?? mainDir,
        baseRef,
        disposition: "already-landed",
        landing: { sha: landing.landingSha },
        ...(target.feature ? { featureId: target.feature.featureId } : {}),
      }
      emit({ type: "result", result })
      return result
    }
  }

  // Preflight: refuse to touch anything until the feature is ready to close.
  const preflight = await closePreflightState(input, target)
  if (preflight.blockers.length > 0) {
    emit({ type: "preflight-failed", blockers: preflight.blockers })
    throw new Error(`close preflight failed:\n  ${preflight.blockers.map((blocker) => blocker.message).join("\n  ")}`)
  }
  emit({ type: "preflight", summary: preflight.summary })

  // Interrupted-landing reconciliation (task 7.5/D8): a journal whose landing
  // already stands in the base but whose checkout was never materialized —
  // every close invocation reconciles it from observed effects, without
  // re-running sync/archive and without creating another commit.
  const priorJournal = commonDir ? await readCloseJournal(commonDir, target.branch, target.changeID) : undefined
  if (priorJournal?.phase === "landed" && priorJournal.landingSha && priorJournal.candidateSha && priorJournal.checkoutMaterialized === false) {
    if (await isLandingReachable(priorJournal.landingSha, priorJournal.baseRef, mainDir)) {
      const reconciling = priorJournal
      const journalState: CloseJournalState = { record: reconciling, commonDir: commonDir ?? undefined, ...(target.feature ? { feature: target.feature } : {}) }
      emit({ type: "step-started", step: "squash-merge" })
      // The reconciliation mutates the base checkout and evidence (design D9):
      // it is one lease-guarded mutation segment of its own.
      const result = await withCloseLease(commonDir, async (): Promise<CloseResult> => {
        try {
          await materializeBaseCheckout(journalState, mainDir)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          emit({ type: "step-failed", step: "squash-merge", message })
          throw new Error(message)
        }
        await persistJournal(journalState, { checkoutMaterialized: true })
        await writeLandingReceipt(journalState, target, reconciling.baseRef, reconciling.baseSha, reconciling.postArchiveTip ?? "", reconciling.preparedTree ?? "", reconciling.candidateSha ?? "", mainDir)
        emit({ type: "step-completed", step: "squash-merge", detail: `reconciled the landing ${reconciling.landingSha!.slice(0, 8)} on ${reconciling.baseRef}` })
        const result: CloseResult = {
          changeID: target.changeID,
          branch: target.branch,
          worktreeDir: target.worktreeDir,
          baseRef: reconciling.baseRef,
          disposition: "landed",
          landing: { sha: reconciling.landingSha! },
          ...(target.feature ? { featureId: target.feature.featureId } : {}),
        }
        emit({ type: "result", result })
        return result
      })
      return result
    }
  }

  // Prepare segment (design D9): the journal intent, the sync merge, the
  // archive, and the tip protection are one lease-guarded mutation segment.
  // The lease is released before message composition and review and the
  // landing segment reacquires it with fresh revalidation.
  type PreparedClose =
    | { kind: "prepared"; journalState: CloseJournalState; baseSha: string; snapshot: CloseContextSnapshot; postArchiveTip: string; preparedTree: string }
    | { kind: "no-content"; result: CloseResult }
  const prepared = await withCloseLease(commonDir, async (): Promise<PreparedClose> => {
    const journalState = await openJournal(commonDir, target, baseRef, input)
    const journal = journalState.record

    // Sync: bring the base branch's tip in before archiving, so the canonical
    // specs the archive produces land against a fresh base. The base revision
    // is captured (pinned) here and revalidated before the landing (task 5.6).
    const baseSha = journal.baseSha
    let preSyncTip: string | undefined
    if (await isAncestor(baseRef, target.branch, target.worktreeDir)) {
      emit({ type: "step-skipped", step: "sync", reason: `${baseRef} is already an ancestor of ${target.branch}` })
    } else {
      emit({ type: "step-started", step: "sync" })
      preSyncTip = (await resolveCommit(target.branch, target.worktreeDir)) ?? undefined
      const merge = await execFile("git", ["merge", "--no-edit", baseSha], { cwd: target.worktreeDir, allowFailure: true })
      if (merge.exitCode !== 0) {
        const message = `sync: merging ${baseRef} into ${target.branch} conflicted — resolve the conflicts and commit inside the worktree, then run \`convoy close --resume\`\n${merge.stderr || merge.stdout}`
        emit({ type: "step-failed", step: "sync", message })
        throw new Error(message)
      }
      emit({ type: "step-completed", step: "sync", detail: `merged ${baseSha.slice(0, 8)} into ${target.branch}` })
      if (journal.phase === "prepared" && !journal.postArchiveTip) await persistJournal(journalState, { preSyncTip })
    }

    // Snapshot the message inputs before the first archive mutation (design D6):
    // the archive moves the live change, and the archive layout's naming is an
    // implementation detail the message must never discover. A resume reuses the
    // persisted context so a retry never degrades to archive-only text.
    const archiveSubject = `chore(openspec): archive ${target.changeID}`
    const snapshot: CloseContextSnapshot = journal.messageContext
      ? { ...journal.messageContext, changeID: target.changeID }
      : await snapshotCloseContext(target, baseSha, { archiveSubject })
    if (!journal.messageContext) await persistJournal(journalState, { messageContext: snapshot })

    // Archive: through the OpenSpec CLI only — convoy never edits openspec/.
    const changeDir = join(target.worktreeDir, openspecDirName, "changes", target.changeID)
    if (await exists(changeDir)) {
      emit({ type: "step-started", step: "archive" })
      // Capture the delta effects the archive must prove BEFORE invoking the
      // CLI (task 7.2/D7): the change's own delta specs are the contract the
      // canonical specs must reflect once OpenSpec has archived.
      const { readDeltaSpecs, effectsForDeltas, verifyEffects, toRequiredEffects } = await import("./feature-lifecycle/archive-verify")
      const deltas = await readDeltaSpecs(changeDir)
      const effects = effectsForDeltas(deltas.values())
      // Persist the required effects BEFORE the archive mutation (task 7.2) —
      // in the identity attempt journal for registered features, in the legacy
      // journal otherwise — so resume validates against this snapshot, never
      // against the archived copy. An empty snapshot is meaningful too: it
      // records a legitimately no-delta change (D7 item 3).
      const effectSnapshot = toRequiredEffects(effects)
      if (effectSnapshot.length > 0) {
        await persistRequiredEffects(journalState, target.changeID, effectSnapshot)
        if (!journalState.feature) await persistJournal(journalState, { requiredEffects: effectSnapshot })
      } else if (!journalState.feature) {
        // Still record that the no-delta case was observed, so a later resume
        // can distinguish it from a deleted delta.
        await persistJournal(journalState, { requiredEffects: [] })
      }
      const archive = await execFile("openspec", ["archive", target.changeID, "--yes"], { cwd: target.worktreeDir, allowFailure: true })
      if (archive.exitCode !== 0) {
        const message = `archive: openspec archive ${target.changeID} failed — the sequence stops before any squash-merge\n${archive.stderr || archive.stdout}`
        emit({ type: "step-failed", step: "archive", message })
        throw new Error(message)
      }
      // Positive archive verification (task 7.2): the CLI's output must prove
      // every delta effect in the canonical specs — ADDED/MODIFIED present with
      // their scenarios, REMOVED absent — before the result is committed. A
      // change with no delta specs needs no canonical comparison (D7 item 3).
      if (effects.length > 0) {
        const verification = await verifyEffects(target.worktreeDir, effects)
        if (verification.unproven.length > 0) {
          const reasons = verification.unproven.map((entry) => {
            const name = entry.effect.kind === "no-effect" ? "(no canonical effect)" : entry.effect.name
            const kind = entry.effect.kind === "no-effect" ? "effect" : entry.effect.kind === "requirement-absent" ? "absent" : "present"
            return `  ${kind} ${entry.effect.capability}/${name}: ${entry.reason}`
          })
          const message =
            `archive: the archived result does not prove every delta effect in the canonical specs — close stops before committing or landing\n` +
            `${reasons.join("\n")}\n` +
            `Reconcile the archive with the canonical specs through OpenSpec (never by editing specs inside Convoy), then run \`convoy close --resume\`.`
          emit({ type: "step-failed", step: "archive", message })
          throw new Error(message)
        }
      }
      // The archive result is committed on the feature branch under the
      // operator's identity (staged explicitly; commitAsUser adds nothing).
      try {
        await execFile("git", ["add", openspecDirName], { cwd: target.worktreeDir })
        const commitArchive = () => commitAsUser(archiveSubject, target.worktreeDir)
        if (input.withTerminal) await input.withTerminal(commitArchive)
        else await commitArchive()
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const message =
          `archive: change ${target.changeID} was archived but committing the result failed — resolve the git error in the worktree, ` +
          `commit the archive result, then run \`convoy close --resume\`\n${detail}`
        emit({ type: "step-failed", step: "archive", message })
        throw new Error(message)
      }
      emit({ type: "step-completed", step: "archive", detail: `archived ${target.changeID}` })
    } else {
      // The active directory is gone — that alone is never proof of a complete
      // archive (task 7.2). The archived source must exist and its delta
      // effects must still verify against the canonical specs before the
      // sequence treats the archive as done; a resume after an incomplete or
      // uncommitted archive refuses here instead of landing unproven work.
      const archiveDir = join(target.worktreeDir, openspecDirName, "changes", "archive", target.changeID)
      if (!(await exists(archiveDir))) {
        const message =
          `archive: change ${target.changeID} has neither an active directory nor an archived copy under ${openspecDirName}/changes/archive/ — ` +
          "an absent active directory alone does not mean the change was archived. Locate or recreate the change's archive through OpenSpec, then run `convoy close --resume`."
        emit({ type: "step-failed", step: "archive", message })
        throw new Error(message)
      }
      const { readDeltaSpecs, effectsForDeltas, verifyEffects, toRequiredEffects, fromRequiredEffects } = await import("./feature-lifecycle/archive-verify")
      // The required effects come, in order, from: the identity attempt
      // journal's snapshot, the legacy journal's snapshot, and finally the
      // archived copy itself (legacy journals written before snapshots
      // existed). A journal snapshot of any length — including empty, the
      // legitimate no-delta case — is authoritative; falling back to the
      // archived copy when NO snapshot exists and finding no deltas there is
      // fail-closed: a deleted delta must never make verification vacuous.
      let requiredEffects: Array<{ kind: "present" | "absent"; capability: string; name: string; scenarios: string[] }> | undefined
      let snapshotAuthoritative = false
      if (journalState.feature) {
        requiredEffects = await readAttemptRequiredEffects(journalState, target.changeID, commonDir)
        if (requiredEffects !== undefined) snapshotAuthoritative = true
      }
      if (requiredEffects === undefined && journal.requiredEffects !== undefined) {
        requiredEffects = journal.requiredEffects
        snapshotAuthoritative = true
      }
      if (requiredEffects === undefined) {
        const deltas = await readDeltaSpecs(archiveDir)
        requiredEffects = toRequiredEffects(effectsForDeltas(deltas.values()))
      }
      const effects = fromRequiredEffects(requiredEffects)
      if (effects.length > 0) {
        const verification = await verifyEffects(target.worktreeDir, effects)
        if (verification.unproven.length > 0) {
          const reasons = verification.unproven.map((entry) => {
            const name = entry.effect.kind === "no-effect" ? "(no canonical effect)" : entry.effect.name
            const kind = entry.effect.kind === "no-effect" ? "effect" : entry.effect.kind === "requirement-absent" ? "absent" : "present"
            return `  ${kind} ${entry.effect.capability}/${name}: ${entry.reason}`
          })
          const message =
            `archive: the archived change ${target.changeID} does not prove every delta effect in the canonical specs — close stops before landing\n` +
            `${reasons.join("\n")}\n` +
            `Reconcile the archive with the canonical specs through OpenSpec, then run \`convoy close --resume\`.`
          emit({ type: "step-failed", step: "archive", message })
          throw new Error(message)
        }
      } else if (!snapshotAuthoritative) {
        // No persisted snapshot and the archived copy carries no delta specs:
        // there is no trustworthy evidence of what this archive must contain.
        const message =
          `archive: no persisted effect snapshot exists for ${target.changeID} and its archived copy carries no delta specs — ` +
          "the archive cannot be verified. Locate the change's original delta specs through OpenSpec, then run `convoy close --resume`."
        emit({ type: "step-failed", step: "archive", message })
        throw new Error(message)
      }
      emit({ type: "step-skipped", step: "archive", reason: `change ${target.changeID} is archived and its canonical result verifies` })
    }

    // The post-archive feature tip is the squash-merge source (design D6): the
    // candidate folds sync resolutions, archive output, and every author's
    // feature content by tree, not by walking authors. Protect it create-only
    // before anything else happens to the branch (design D7).
    const postArchiveTip = (await resolveCommit(target.branch, target.worktreeDir)) ?? ""
    if (!postArchiveTip) {
      const message = `squash-merge: ${target.branch} has no commits — nothing to land`
      emit({ type: "step-failed", step: "squash-merge", message })
      throw new Error(message)
    }
    try {
      await protectCloseRef(closeFeatureTipRef(target.branch, journal.attemptID), postArchiveTip, mainDir)
    } catch (error) {
      const message = `squash-merge: couldn't protect the feature tip ref (${error instanceof Error ? error.message : String(error)}) — the sequence stops before the landing`
      emit({ type: "step-failed", step: "squash-merge", message })
      throw new Error(message)
    }
    const preparedTree = (await treeOf(postArchiveTip, target.worktreeDir)) ?? ""
    await persistJournal(journalState, { postArchiveTip, preparedTree })

    // Squash-merge: stage the one-parent candidate on the captured base in a
    // private detached integration worktree, then advance the base onto it. The
    // main checkout's index is never left half-staged by a failed signature or
    // hook, because the staging happens away from it (design D6, task 5.4).
    emit({ type: "step-started", step: "squash-merge" })
    await assertBaseUnchanged(baseSha, baseRef, mainDir)

    if (preparedTree === (await treeOf(baseSha, mainDir))) {
      // Identical trees: nothing to land, no empty commit, and no cleanup
      // authorization from that fact alone (design D6/D7).
      emit({ type: "step-skipped", step: "squash-merge", reason: "the archived feature's tree equals the captured base tree — no content to land" })
      await clearCloseJournal(commonDir ?? "", target.branch, target.changeID)
      const result: CloseResult = { changeID: target.changeID, branch: target.branch, worktreeDir: target.worktreeDir, baseRef, disposition: "no-content-to-land", ...(target.feature ? { featureId: target.feature.featureId } : {}) }
      emit({ type: "result", result })
      return { kind: "no-content", result }
    }

    return { kind: "prepared", journalState, baseSha, snapshot, postArchiveTip, preparedTree }
  })
  if (prepared.kind === "no-content") return prepared.result
  const { journalState, baseSha, snapshot, postArchiveTip, preparedTree } = prepared
  const journal = journalState.record

  // The open-PR probe (PR-aware close, design D1): one tolerant lookup, run
  // here because a landing is about to happen — never on no-content or
  // already-landed dispositions, and never inside the mutation lease (design
  // D9: no slow external waits while holding it). Its result rides the
  // composed subject and, on landing, the result's follow-up facts.
  const detectedPullRequest = await (input.probePullRequest ?? ((branch: string) => probeOpenPullRequest(branch, mainDir)))(target.branch)

  // A crash after candidate creation resumes the landing without a new
  // compose/review round-trip (design D6, task 5.7): the candidate is
  // verified against the journal before it is trusted.
  const reconciled = await reconcileCandidate(journal, baseSha, preparedTree, mainDir)
  let message: string | undefined
  let candidateSha: string | undefined
  if (reconciled.ok && reconciled.candidateSha) {
    candidateSha = reconciled.candidateSha
    message = journal.message ?? reconciled.message
    if (message) emit({ type: "squash-phase", phase: "creating-commit" })
  }

  // The message gate runs WITHOUT the mutation lease (design D9: never hold
  // it while waiting for message review — persist preparation, release, and
  // reacquire/revalidate afterward).
  if (!candidateSha && message === undefined) {
    // `--message ""` is still an explicit override and must win verbatim, so
    // presence is `!== undefined`, never truthiness (SC-8). The override
    // bypasses composition, normalization, and the review gate entirely.
    if (input.message !== undefined) {
      message = input.message
    } else {
      // The composition await is real work the renderer must see as such
      // (design D8): a slow model produces no intermediate event of its own.
      emit({ type: "squash-phase", phase: "composing-message" })
      const proposal = await composeCloseMessage({ target, snapshot, baseSha, diffStat: await diffStat(baseSha, postArchiveTip, target.worktreeDir), ...(detectedPullRequest ? { pullRequest: detectedPullRequest } : {}) }, input.writer)
      if (input.resolveMessage) {
        emit({ type: "squash-phase", phase: "awaiting-message-review" })
        message = await input.resolveMessage(proposal)
      } else {
        // Headless: the proposal is accepted unchanged.
        message = proposal.message
      }
    }
    if (message === undefined) {
      const stop = "close stopped: the landing commit's message wasn't confirmed — rerun `convoy close --resume` to retry the squash-merge"
      emit({ type: "step-failed", step: "squash-merge", message: stop })
      await persistJournal(journalState, { message: undefined })
      throw new Error(stop)
    }
  }

  // Landing segment (design D9): the lease is reacquired after review and
  // everything from the confirmed message through the immutable receipt —
  // candidate creation, the guarded ref transaction, checkout
  // materialization, and the receipt write — is one serialized mutation
  // segment.
  const result = await withCloseLease(commonDir, async (): Promise<CloseResult> => {
    if (!candidateSha) {
      const confirmedMessage = message
      if (confirmedMessage === undefined) {
        throw new Error("close: the landing message vanished before the candidate commit — rerun `convoy close --resume` to retry")
      }
      await persistJournal(journalState, { message: confirmedMessage })
      emit({ type: "squash-phase", phase: "creating-commit" })
      try {
        candidateSha = await createCandidate(journalState, target, confirmedMessage, baseSha, postArchiveTip, mainDir, input.withTerminal)
      } catch (error) {
        // A failed candidate (declined signature, rejected hook) must still mark
        // the squash-merge row failed; the failed event carries the remediation (SC-5).
        const detail = error instanceof Error ? error.message : String(error)
        emit({ type: "step-failed", step: "squash-merge", message: `squash-merge: ${detail}` })
        throw error
      }
    }
    const landedSha = candidateSha
    if (landedSha === undefined) {
      throw new Error("close: the candidate commit vanished before the landing — rerun `convoy close --resume` to retry")
    }

    // Land (task 7.5): two distinct recorded stages. Stage 1 advances the base
    // ref through an expected-old guarded ref transaction — the candidate's
    // parent is the captured base, so only a pure fast-forward can succeed, and
    // a base that moved after the candidate was built makes the expected-old
    // value refuse instead of merging or forcing. Once the transaction
    // succeeds, the landing has happened. Stage 2 materializes the base
    // checkout with Git's guarded two-tree update — a separate stage whose
    // failure is checkout recovery, never a claim that the base is unadvanced.
    const baseNow = (await resolveCommit(baseRef, mainDir)) ?? ""
    // Crash reconciliation: a ref that already carries this verified candidate
    // is the interrupted attempt's own landing — never re-land, and never
    // trust a foreign commit that merely shares the SHA spelling.
    const refLanded = baseNow === landedSha && journal.candidateSha === landedSha
    if (!refLanded && baseNow !== baseSha) {
      const message = `squash-merge: ${baseRef} moved to ${baseNow.slice(0, 8)} while the close was in progress — run \`convoy close\` to re-sync against the new base`
      emit({ type: "step-failed", step: "squash-merge", message })
      throw new Error(message)
    }
    const mainStatus = await statusPorcelain(mainDir).catch(() => "unreadable")
    if (mainStatus.trim() !== "") {
      const message = "squash-merge: the main checkout has uncommitted changes — commit or stash them first, then run `convoy close --resume`"
      emit({ type: "step-failed", step: "squash-merge", message })
      throw new Error(message)
    }

    // Stage 1: the landing ref transaction.
    if (!refLanded) {
      try {
        const land = await execFile("git", ["update-ref", "-m", "convoy: close landing", `refs/heads/${baseRef}`, landedSha, baseSha], { cwd: mainDir, allowFailure: true })
        if (land.exitCode !== 0) {
          throw new Error((land.stderr || land.stdout || "git update-ref refused the landing") + ` — the expected-old value ${baseSha.slice(0, 8)} no longer matches ${baseRef}`)
        }
      } catch (error) {
        const message = `squash-merge: landing ${baseRef} at ${landedSha.slice(0, 8)} failed (${error instanceof Error ? error.message : String(error)}) — the base is unadvanced; run \`convoy close --resume\``
        emit({ type: "step-failed", step: "squash-merge", message })
        throw new Error(message)
      }
    }
    // The landing stands as of the ref transaction; record it before
    // materialization so a crash here reconciles the checkout, never re-lands.
    await persistJournal(journalState, { phase: "landed", landingSha: landedSha, checkoutMaterialized: false })

    // Stage 2: materialize the base checkout (guarded two-tree update — Git
    // refuses to clobber any local change that differs between the trees; the
    // clean-tree preflight guarantees there is nothing to lose).
    try {
      await materializeBaseCheckout(journalState, mainDir)
    } catch (error) {
      const message =
        `squash-merge: the base ref ${baseRef} now carries the landing ${landedSha.slice(0, 8)}, but materializing the checkout failed ` +
        `(${error instanceof Error ? error.message : String(error)}) — the landing stands; reconcile the main checkout, then run \`convoy close --resume\`. ` +
        "Cleanup stays blocked until the checkout is reconciled."
      emit({ type: "step-failed", step: "squash-merge", message })
      throw new Error(message)
    }
    await persistJournal(journalState, { checkoutMaterialized: true })
    await writeLandingReceipt(journalState, target, baseRef, baseSha, postArchiveTip, preparedTree, landedSha, mainDir)

    emit({
      type: "step-completed",
      step: "squash-merge",
      detail: detectedPullRequest
        ? `landed ${landedSha.slice(0, 8)} on ${baseRef}; pull request #${detectedPullRequest.number} is open for ${target.branch} (${detectedPullRequest.url})`
        : `landed ${landedSha.slice(0, 8)} on ${baseRef}`,
    })
    const result: CloseResult = {
      changeID: target.changeID,
      branch: target.branch,
      worktreeDir: target.worktreeDir,
      baseRef,
      disposition: "landed",
      landing: { sha: landedSha },
      ...(target.feature ? { featureId: target.feature.featureId } : {}),
      ...(detectedPullRequest ? { pullRequest: detectedPullRequest } : {}),
    }
    emit({ type: "result", result })
    return result
  })
  return result
}

// --- journal handling ---------------------------------------------------------

/**
 * Stage 2 of the landing (task 7.5): materializes the base checkout onto the
 * landed ref with Git's guarded two-tree update — it refuses to clobber any
 * local change that differs between the trees — then verifies the checkout's
 * tree is exactly the prepared feature tree and the checkout is clean.
 */
async function materializeBaseCheckout(journalState: CloseJournalState, mainDir: string): Promise<void> {
  const materialize = await execFile("git", ["read-tree", "-u", "-m", "HEAD"], { cwd: mainDir, allowFailure: true })
  if (materialize.exitCode !== 0) {
    throw new Error((materialize.stderr || materialize.stdout || "git read-tree refused the checkout update").trim())
  }
  const headTree = await treeOf("HEAD", mainDir)
  if (journalState.record.preparedTree && headTree !== journalState.record.preparedTree) {
    throw new Error(`the base checkout's tree (${headTree?.slice(0, 8) ?? "?"}) does not match the prepared feature tree (${journalState.record.preparedTree.slice(0, 8)})`)
  }
  const afterStatus = await statusPorcelain(mainDir).catch(() => "unreadable")
  if (afterStatus.trim() !== "") {
    throw new Error("the base checkout reports uncommitted changes after the update")
  }
}

/**
 * The immutable identity-keyed receipt (task 7.3/D8): create-only, tied to
 * the stable feature identity, the exact prepared feature tip, and the
 * landing commit. Later attempts and cleanup consult it — never the branch
 * spelling. Protected refs are created alongside (create-only).
 */
async function writeLandingReceipt(
  journalState: CloseJournalState,
  target: CloseTarget,
  baseRef: string,
  baseSha: string,
  postArchiveTip: string,
  preparedTree: string,
  candidateSha: string,
  mainDir: string,
): Promise<void> {
  if (!journalState.feature || !journalState.commonDir) return
  const feature = journalState.feature
  const receipt: LandingReceipt = {
    schemaVersion: 1,
    attemptId: journalState.record.attemptID,
    featureId: feature.featureId,
    repositoryId: feature.repositoryId,
    associationRevision: feature.associationRevision,
    branch: target.branch,
    baseRef,
    baseSha,
    featureTip: postArchiveTip,
    preparedTree,
    candidateSha,
    landingSha: candidateSha,
    landingAt: Date.now(),
  }
  const created = await writeReceiptIfAbsent(journalState.commonDir, receipt)
  if (!created) {
    // An existing receipt for this attempt is verified, not overwritten.
    const existing = await import("./feature-lifecycle/records").then((records) => records.readReceipt(journalState.commonDir!, feature.featureId, receipt.attemptId))
    if (existing.status === "found" && existing.value.landingSha !== candidateSha) {
      throw new Error(`close: receipt for attempt ${receipt.attemptId} already records landing ${existing.value.landingSha.slice(0, 8)} — refusing to overwrite immutable evidence`)
    }
  }
  await protectFeatureRef(featureTipRefName(feature.featureId, receipt.attemptId), postArchiveTip, mainDir)
  await protectFeatureRef(featureCandidateRefName(feature.featureId, receipt.attemptId), candidateSha, mainDir)
}

/**
 * Opens (or starts) the close journal for this attempt. A fresh close starts
 * a new attempt; a resume with a matching base continues the recorded one so
 * completed work and the reviewed message survive. A resume whose recorded
 * base differs stops — the base moved, and the sequence must re-sync against
 * the new base rather than land a stale candidate (task 5.6).
 */
type CloseJournalState = { record: CloseJournal; commonDir?: string; feature?: FeatureRecord; repositoryId?: string }

async function openJournal(
  commonDir: string | undefined,
  target: CloseTarget,
  baseRef: string,
  input: CloseInput,
): Promise<CloseJournalState> {
  const mainDir = (await mainWorktreeDir(input.targetDir).catch(() => undefined)) ?? input.targetDir
  const baseSha = (await resolveCommit(baseRef, mainDir)) ?? (await resolveCommit(baseRef, input.targetDir)) ?? ""
  if (!baseSha) throw new Error(`close: couldn't resolve the base branch ${baseRef}`)

  if (commonDir && input.resume) {
    const existing = await readCloseJournal(commonDir, target.branch, target.changeID)
    if (existing) {
      if (existing.baseSha !== baseSha) {
        // The landing itself advances the base: a recorded landed candidate
        // reachable from the new base reconciles instead of refusing (task
        // 7.5/D8 — "even if the base advanced afterward"). Anything else is
        // a genuine base move and must re-sync.
        const landingStands =
          existing.phase === "landed" && existing.candidateSha
            ? await isLandingReachable(existing.candidateSha, baseRef, mainDir)
            : false
        if (!landingStands) {
          throw new Error(
            `close resume: the base moved since this attempt was recorded (${existing.baseSha.slice(0, 8)} → ${baseSha.slice(0, 8)}) — ` +
              "run `convoy close` without --resume to re-sync against the new base",
          )
        }
      }
      return { record: existing, commonDir, ...(target.feature ? { feature: target.feature } : {}) }
    }
  }

  const attemptID = target.feature ? crypto.randomUUID() : `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
  const journal: CloseJournal = {
    schemaVersion: 1,
    attemptID,
    branch: target.branch,
    changeID: target.changeID,
    baseRef,
    baseSha,
    phase: "prepared",
    recordedAt: Date.now(),
    updatedAt: Date.now(),
  }
  const record: CloseJournal = {
    schemaVersion: 1,
    attemptID,
    branch: target.branch,
    changeID: target.changeID,
    baseRef,
    baseSha,
    phase: "prepared",
    recordedAt: Date.now(),
    updatedAt: Date.now(),
  }
  // The identity-keyed attempt journal is persisted before the first mutation
  // (task 7.3): a fresh attempt under the feature's stable identity, so the
  // intent survives crashes regardless of later renames or cleanup.
  if (commonDir && target.feature) {
    const attempt = attemptJournalFrom(record, target.feature, baseSha, attemptID)
    await writeAttemptJournal(commonDir, attempt)
    await recordCloseAttemptOnFeature(commonDir, target.feature, attemptID)
  }
  return { record, commonDir, ...(target.feature ? { feature: target.feature } : {}) }
}

/** Converts the legacy journal shape into its identity-keyed attempt form. */
function attemptJournalFrom(journal: CloseJournal, feature: FeatureRecord, baseSha: string, attemptID: string): CloseAttemptJournal {
  return {
    schemaVersion: 1,
    attemptId: attemptID,
    featureId: feature.featureId,
    repositoryId: feature.repositoryId,
    associationRevision: feature.associationRevision,
    phase: "prepared",
    contracts: [{ changeId: journal.changeID, sourcePath: `openspec/changes/${journal.changeID}`, archiveCommitted: false }],
    baseRef: journal.baseRef,
    baseSha,
    branch: journal.branch,
    recordedAt: journal.recordedAt,
    updatedAt: journal.updatedAt,
  }
}

/** Appends the attempt id to the feature record's close-attempt pointers. */
async function recordCloseAttemptOnFeature(commonDir: string, feature: FeatureRecord, attemptId: string): Promise<void> {
  await withFeatureLock(join(commonDir, "convoy", "features", feature.featureId), async () => {
    const current = await readFeatureRecord(commonDir, feature.featureId)
    if (current.status !== "found") return
    if (current.value.closeAttemptIds.includes(attemptId)) return
    const updated: FeatureRecord = {
      ...current.value,
      closeAttemptIds: [...current.value.closeAttemptIds, attemptId],
      updatedAt: Date.now(),
    }
    await writeFeatureRecord(commonDir, updated, current.value.associationRevision)
  }).catch(() => {
    // The attempt journal is the durable evidence; the pointer is best-effort.
  })
}

async function persistJournal(state: CloseJournalState, patch: Partial<CloseJournal>): Promise<void> {
  Object.assign(state.record, patch, { updatedAt: Date.now() })
  if (!state.commonDir) return
  await writeCloseJournal(state.commonDir, { ...state.record })
  // Mirror the transition into the identity-keyed attempt journal (task 7.3),
  // so recovery reads current Git/artifact state plus the durable intent.
  if (state.feature) {
    const current = await readAttemptJournal(state.commonDir, state.feature.featureId, state.record.attemptID).catch(() => undefined)
    const existing = current && current.status === "found" ? current.value : undefined
    const attempt = existing
      ? { ...existing, ...attemptPatchFrom(state.record), updatedAt: Date.now() }
      : attemptJournalFrom(state.record, state.feature, state.record.baseSha, state.record.attemptID)
    await writeAttemptJournal(state.commonDir, attempt).catch(() => {
      // A failed mirror keeps the legacy journal authoritative for this phase;
      // the landing receipt below is the immutable record that matters.
    })
  }
}

/** Maps legacy journal fields onto the attempt journal's phase/evidence fields. */
function attemptPatchFrom(journal: CloseJournal): Partial<CloseAttemptJournal> {
  const phaseMap: Record<CloseJournal["phase"], CloseAttemptJournal["phase"]> = {
    prepared: "prepared",
    candidate: "candidate",
    landed: "landed",
  }
  return {
    phase: phaseMap[journal.phase],
    ...(journal.preSyncTip ? { preSyncTip: journal.preSyncTip } : {}),
    ...(journal.postArchiveTip ? { postArchiveTip: journal.postArchiveTip } : {}),
    ...(journal.preparedTree ? { preparedTree: journal.preparedTree } : {}),
    ...(journal.messageContext ? { messageContext: journal.messageContext } : {}),
    ...(journal.message ? { message: journal.message } : {}),
    ...(journal.candidateSha ? { candidateSha: journal.candidateSha } : {}),
    ...(journal.landingSha ? { landingSha: journal.landingSha } : {}),
    ...(journal.checkoutMaterialized !== undefined ? { checkoutMaterialized: journal.checkoutMaterialized } : {}),
  }
}

/**
 * Persists the required canonical effects for a contract BEFORE the archive
 * mutation (task 7.2): the snapshot survives later edits to the archived
 * copy, so resume verification cannot be made vacuous.
 */
async function persistRequiredEffects(state: CloseJournalState, changeId: string, effects: Array<{ kind: "present" | "absent"; capability: string; name: string; scenarios: string[] }>): Promise<void> {
  if (!state.commonDir || !state.feature) return
  const current = await readAttemptJournal(state.commonDir, state.feature.featureId, state.record.attemptID).catch(() => undefined)
  const attempt = current && current.status === "found" ? current.value : attemptJournalFrom(state.record, state.feature, state.record.baseSha, state.record.attemptID)
  const updated: CloseAttemptJournal = {
    ...attempt,
    contracts: attempt.contracts.map((contract) =>
      contract.changeId === changeId && !contract.requiredEffects ? { ...contract, requiredEffects: effects } : contract,
    ),
    updatedAt: Date.now(),
  }
  await writeAttemptJournal(state.commonDir, updated).catch(() => {
    // A failed snapshot write blocks nothing here — the archive verification
    // below still runs against the live effects; resume falls back to the
    // archived copy's own deltas when no snapshot exists.
  })
}

/** Reads the persisted required-effect snapshot for a contract. `[]` (the legitimate no-delta case) is distinct from `undefined` (no snapshot). */
async function readAttemptRequiredEffects(state: CloseJournalState, changeId: string, commonDir: string | undefined): Promise<Array<{ kind: "present" | "absent"; capability: string; name: string; scenarios: string[] }> | undefined> {
  if (!state.feature || !commonDir) return undefined
  const current = await readAttemptJournal(commonDir, state.feature.featureId, state.record.attemptID).catch(() => undefined)
  if (!current || current.status !== "found") return undefined
  const contract = current.value.contracts.find((entry) => entry.changeId === changeId)
  return contract?.requiredEffects
}

/**
 * Verifies the recorded candidate still exists with exactly the journal's
 * parent (the captured base) and tree. Anything else is not trusted (task
 * 5.7): a stale or foreign commit is never reused, and the caller falls back
 * to building a fresh candidate.
 */
async function reconcileCandidate(
  journal: CloseJournal,
  baseSha: string,
  preparedTree: string,
  cwd: string,
): Promise<{ ok: true; candidateSha?: string; message?: string } | { ok: false }> {
  if (journal.phase !== "candidate" || !journal.candidateSha) return { ok: true }
  const sha = await resolveCommit(journal.candidateSha, cwd).catch(() => undefined)
  if (!sha) return { ok: true }
  const parents = await commitParents(sha, cwd)
  const tree = await treeOf(sha, cwd)
  if (parents.length !== 1 || parents[0] !== baseSha || tree !== preparedTree) return { ok: true }
  return { ok: true, candidateSha: sha, ...(journal.message ? { message: journal.message } : {}) }
}

async function commitParents(sha: string, cwd: string): Promise<string[]> {
  const result = await execFile("git", ["rev-list", "--parents", "-n", "1", sha], { cwd, allowFailure: true })
  if (result.exitCode !== 0) return []
  return result.stdout.trim().split(/\s+/).slice(1)
}

async function treeOf(sha: string, cwd: string): Promise<string | undefined> {
  const result = await execFile("git", ["rev-parse", "--verify", "--quiet", `${sha}^{tree}`], { cwd, allowFailure: true })
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined
}

async function assertBaseUnchanged(baseSha: string, baseRef: string, mainDir: string): Promise<void> {
  const baseNow = (await resolveCommit(baseRef, mainDir)) ?? ""
  if (baseNow !== baseSha) {
    throw new Error(
      `squash-merge: ${baseRef} moved to ${baseNow.slice(0, 8)} (captured ${baseSha.slice(0, 8)}) — run \`convoy close\` to re-sync against the new base`,
    )
  }
}

/**
 * Builds the one-parent candidate commit in a private detached integration
 * worktree at the captured base (design D6, task 5.4): `git merge --squash`
 * stages the feature's post-archive tree, the staged content is scanned for
 * secrets exactly like step commits, and the commit is made under the
 * operator's identity — signing and hooks effective — with the terminal
 * released for interactive close. The worktree is always removed afterwards.
 */
async function createCandidate(
  state: CloseJournalState,
  target: CloseTarget,
  message: string,
  baseSha: string,
  postArchiveTip: string,
  mainDir: string,
  withTerminal?: CloseInput["withTerminal"],
): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "convoy-close-integration-"))
  try {
    await execFile("git", ["worktree", "add", "--detach", scratch, baseSha], { cwd: mainDir })
    try {
      const squash = await execFile("git", ["merge", "--squash", postArchiveTip], { cwd: scratch, allowFailure: true })
      if (squash.exitCode !== 0) {
        throw new Error(
          `staging the feature tree onto ${state.record.baseRef} failed — the feature and the captured base diverged unexpectedly\n${squash.stderr || squash.stdout}`,
        )
      }

      // The candidate commit must not be the one path that bypasses secret
      // scanning (the same protection step commits get).
      const porcelain = await statusPorcelain(scratch)
      const suspicious = findSuspiciousStagedFiles(porcelain)
      if (suspicious.length > 0) {
        throw new Error(
          `refusing to land: the following files look like they contain secrets: ${suspicious.join(", ")}. ` +
            `Add them to .gitignore (or remove them) and re-run \`convoy close\`.`,
        )
      }

      const commitCandidate = () => commitAsUser(message, scratch)
      if (withTerminal) await withTerminal(commitCandidate)
      else await commitCandidate()

      const candidateSha = (await resolveCommit("HEAD", scratch)) ?? ""
      if (!candidateSha) throw new Error("the candidate commit could not be resolved after creation")
      const parents = await commitParents(candidateSha, scratch)
      const tree = await treeOf(candidateSha, scratch)
      if (parents.length !== 1 || parents[0] !== baseSha) {
        throw new Error(`the candidate commit must have exactly one parent, the captured base ${baseSha.slice(0, 8)} (got ${parents.length})`)
      }
      if (tree !== state.record.preparedTree) {
        throw new Error(`the candidate commit's tree does not match the prepared feature tree (${tree?.slice(0, 8)} vs ${state.record.preparedTree?.slice(0, 8)})`)
      }

      // Protect the candidate create-only, then record it in the journal
      // before the base is advanced (design D6/D7, task 5.5) — a crash after
      // this point resumes the landing instead of rebuilding the commit.
      await protectCloseRef(closeCandidateRef(state.record.branch, state.record.attemptID), candidateSha, mainDir)
      await persistJournal(state, { phase: "candidate", candidateSha })
      return candidateSha
    } finally {
      await execFile("git", ["worktree", "remove", "--force", scratch], { cwd: mainDir, allowFailure: true })
    }
  } catch (error) {
    // The scratch dir is removed by `git worktree remove`; a failure before
    // registration leaves only the empty mkdtemp dir behind.
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/**
 * Snapshot + final diffstat → normalized message proposal (design D6). The
 * writer's answer is a proposal, not authority: the scope rule is enforced
 * here, and a writer that answered nothing usable degrades to the
 * deterministic close fallback without blocking the sequence. When the PR
 * probe detected an open pull request for the feature branch, the formatted
 * proposal's subject carries the GitHub-recognized `(#N)` reference — applied
 * here so the operator reviews exactly what lands and the journal persists it.
 */
async function composeCloseMessage(
  context: { target: CloseTarget; snapshot: CloseContextSnapshot; baseSha: string; diffStat: string; pullRequest?: DetectedPullRequest },
  writer?: CloseInput["writer"],
): Promise<CloseMessageProposal> {
  const writerInput = {
    targetDir: context.target.worktreeDir,
    branch: context.target.branch,
    commits: context.snapshot.commitSubjects,
    ...(context.diffStat.trim() ? { diffStat: context.diffStat } : {}),
    ...(context.snapshot.proposalExcerpt ? { proposalExcerpt: context.snapshot.proposalExcerpt } : {}),
    ...(context.snapshot.scopeCandidates.length > 0 ? { scopeCandidates: context.snapshot.scopeCandidates } : {}),
  }
  const proposal = await (writer ?? proposeCommitMessage)(writerInput)
  if (proposal.source === "template") {
    const message = closeFallbackCommitMessage({
      branch: context.target.branch,
      proposal: context.snapshot.proposalExcerpt,
      changeID: context.target.changeID,
      scopeCandidates: context.snapshot.scopeCandidates,
      commits: context.snapshot.commitSubjects,
    })
    return {
      message: withPullRequestReference(stripControlBytes(formatCommitMessage(message)), context.pullRequest),
      source: "fallback",
      ...(proposal.error ? { error: proposal.error } : {}),
    }
  }
  const normalized = normalizeComposedMessage(proposal.message, {
    scopeCandidates: context.snapshot.scopeCandidates,
    changeID: context.target.changeID,
  })
  return { message: withPullRequestReference(stripControlBytes(formatCommitMessage(normalized)), context.pullRequest), source: "model" }
}

/**
 * Appends the GitHub squash reference ` (#N)` to a formatted commit message's
 * subject line (PR-aware close): the same shape GitHub's own squash merge
 * generates, so pushing the landing to the base branch lets GitHub attribute
 * the commit to the pull request and mark it merged. The subject part is
 * trimmed when needed so the whole first line stays within the conventional
 * cap, and an existing trailing `(#N)` reference is never doubled. The
 * reviewed value stays authoritative — this runs at composition only, never
 * after the operator's review or edit, and never on an explicit `--message`.
 */
export function withPullRequestReference(message: string, pullRequest?: DetectedPullRequest): string {
  if (!pullRequest) return message
  const reference = ` (#${pullRequest.number})`
  const [subjectLine = "", ...rest] = message.split("\n")
  if (/\s*\(#\d+\)$/.test(subjectLine)) return message
  let line = subjectLine
  const overflow = line.length + reference.length - maxCommitSubjectLength
  if (overflow > 0) line = line.slice(0, line.length - overflow)
  line = line.replace(/\s+$/, "")
  return [line + reference, ...rest].join("\n")
}

/**
 * The open-PR probe (PR-aware close, design D1): one tolerant `gh pr list`
 * lookup for an open pull request whose head is the feature branch. Every
 * failure mode — missing GitHub CLI, non-zero exit, unparseable output, empty
 * result — degrades to "none detected" without blocking close or asserting
 * anything about hosted merge state.
 */
export async function probeOpenPullRequest(branch: string, cwd: string): Promise<DetectedPullRequest | undefined> {
  let result
  try {
    result = await execFile("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "number,title,url", "--limit", "1"], { cwd, allowFailure: true })
  } catch {
    return undefined
  }
  if (!result || result.exitCode !== 0) return undefined
  try {
    const rows = JSON.parse(result.stdout) as Array<{ number?: unknown; title?: unknown; url?: unknown }>
    for (const row of rows) {
      if (typeof row.number === "number" && Number.isFinite(row.number) && typeof row.url === "string" && row.url) {
        return { number: row.number, ...(typeof row.title === "string" && row.title ? { title: row.title } : {}), url: row.url }
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

/** The message inputs, captured before archive moves the live change (design D6). */
export type CloseContextSnapshot = {
  changeID: string
  /** The proposal document's content, read while the live path still existed. */
  proposalExcerpt?: string
  /** The capability names under the change's delta specs — the scope rule's candidates. */
  scopeCandidates: string[]
  /** The feature-exclusive commit subjects, captured before the archive commit exists. */
  commitSubjects: string[]
}

async function snapshotCloseContext(
  target: CloseTarget,
  baseSha: string,
  opts: { archiveSubject: string },
): Promise<CloseContextSnapshot> {
  const changeDir = join(target.worktreeDir, openspecDirName, "changes", target.changeID)
  let proposalExcerpt: string | undefined
  try {
    proposalExcerpt = await readFile(join(changeDir, "proposal.md"), "utf8")
  } catch {
    // A change without a readable proposal still closes; the message just
    // loses that seed.
  }
  return {
    changeID: target.changeID,
    ...(proposalExcerpt ? { proposalExcerpt } : {}),
    scopeCandidates: await listChangeCapabilities(changeDir),
    commitSubjects: await featureCommitSubjects(target, baseSha),
  }
}

/** The capability directories of the change's delta specs, sorted. */
async function listChangeCapabilities(changeDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(changeDir, "specs"), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch {
    return []
  }
}

/**
 * The feature-exclusive commit subjects (base-exclusive reachability, design
 * D6): every commit on the branch not reachable from the base — operator
 * commits, run-compaction commits, sync merge resolutions — because the
 * landing includes all authors' content. A failure here only costs the
 * message its commit summaries.
 */
async function featureCommitSubjects(target: CloseTarget, baseSha: string): Promise<string[]> {
  try {
    const head = (await resolveCommit(target.branch, target.worktreeDir)) ?? ""
    if (!head) return []
    const result = await execFile("git", ["log", "--format=%s", `${baseSha}..${head}`], { cwd: target.worktreeDir, allowFailure: true })
    if (result.exitCode !== 0) return []
    return result.stdout.split("\n").filter(Boolean)
  } catch {
    return []
  }
}

/**
 * The remediation for a probably-merged-but-unarchived change: archive in the
 * main checkout, commit on the base branch, and nothing else — there is
 * nothing left to sync, squash-merge, or land (design D7).
 *
 * Task 7.9: the base-checkout copy is verified to correspond to the selected
 * contract (a real change tree, never a husk; its delta effects must prove
 * against the canonical specs, same as close) and the recorded archive source
 * is persisted for registered features, so discovery prefers the archive over
 * any unarchived copy the feature worktree still carries. Integration stays
 * probably merged or pending — archive-on-main never claims integration.
 */
export async function archiveChangeOnMain(input: { targetDir: string; changeID: string }): Promise<{ committed: boolean; archiveSource?: string }> {
  const { changeID } = input
  // Archive always lands on the base branch's checkout — the repo's main
  // worktree, not whatever directory the board happened to be launched from.
  // Opening `convoy specs` inside a feature worktree (a supported scenario)
  // must not archive and commit on that feature branch instead (SC-4).
  const targetDir = (await mainWorktreeDir(input.targetDir).catch(() => undefined)) ?? input.targetDir

  const status = await statusPorcelain(targetDir).catch(() => "dirty" as const)
  if (status.trim() !== "") {
    throw new Error("archive on main: the checkout has uncommitted changes — commit or stash them first")
  }

  const changeDir = join(targetDir, openspecDirName, "changes", changeID)
  if (!(await exists(changeDir))) {
    throw new Error(`archive on main: change ${changeID} is not present under ${openspecDirName}/changes/ — nothing to archive`)
  }
  // The base-checkout copy must be the real contract: a husk (no markdown)
  // is not the operator's change and must not be archived as one.
  const { collectDirRelativeMarkdown } = await import("./openspec")
  const changeFiles = await collectDirRelativeMarkdown(changeDir, ".")
  if (changeFiles.length === 0) {
    throw new Error(`archive on main: ${openspecDirName}/changes/${changeID} carries no markdown artifacts (a husk) — locate the real change before archiving`)
  }

  // Capture the delta effects before the CLI runs and prove them against the
  // canonical specs after it, exactly like close's archive step.
  const { readDeltaSpecs, effectsForDeltas, verifyEffects } = await import("./feature-lifecycle/archive-verify")
  const deltas = await readDeltaSpecs(changeDir)
  const effects = effectsForDeltas(deltas.values())

  const archive = await execFile("openspec", ["archive", changeID, "--yes"], { cwd: targetDir, allowFailure: true })
  if (archive.exitCode !== 0) {
    throw new Error(`archive on main: openspec archive ${changeID} failed\n${archive.stderr || archive.stdout}`)
  }

  if (effects.length > 0) {
    const verification = await verifyEffects(targetDir, effects)
    if (verification.unproven.length > 0) {
      const reasons = verification.unproven.map((entry) => {
        const name = entry.effect.kind === "no-effect" ? "(no canonical effect)" : entry.effect.name
        const kind = entry.effect.kind === "no-effect" ? "effect" : entry.effect.kind === "requirement-absent" ? "absent" : "present"
        return `  ${kind} ${entry.effect.capability}/${name}: ${entry.reason}`
      })
      throw new Error(
        `archive on main: the archived result does not prove every delta effect in the canonical specs — reconcile through OpenSpec before committing\n${reasons.join("\n")}`,
      )
    }
  }

  await execFile("git", ["add", openspecDirName], { cwd: targetDir })
  const staged = await execFile("git", ["diff", "--cached", "--quiet"], { cwd: targetDir, allowFailure: true })
  if (staged.exitCode === 0) {
    return { committed: false, archiveSource: join(openspecDirName, "changes", "archive", changeID) }
  }
  await commitAsUser(`chore(openspec): archive ${changeID}`, targetDir)

  // Record the archive source for a registered feature (task 7.9): the
  // contract's source becomes the verified archive, so discovery stops
  // reporting the feature worktree's stale active copy as current work.
  const commonDir = await lifecycleCommonDir(input.targetDir)
  if (commonDir) {
    const resolution = await resolveFeature({ cwd: input.targetDir, commonDir, changeId: changeID }).catch(() => undefined)
    if (resolution?.status === "verified") {
      const feature = resolution.feature
      await withFeatureLock(join(commonDir, "convoy", "features", feature.featureId), async () => {
        const current = await readFeatureRecord(commonDir, feature.featureId)
        if (current.status !== "found") return
        const revision = current.value.associationRevision + 1
        const updated: FeatureRecord = {
          ...current.value,
          associationRevision: revision,
          contracts: current.value.contracts.map((contract) =>
            contract.changeId === changeID && contract.kind === "active"
              ? { ...contract, kind: "archive" as const, sourcePath: join(openspecDirName, "changes", "archive", changeID), selectedAtRevision: revision }
              : contract,
          ),
          history: [...current.value.history, { at: Date.now(), kind: "revised" as const, summary: `archive on main recorded for ${changeID}`, revision }],
          updatedAt: Date.now(),
        }
        await writeFeatureRecord(commonDir, updated, current.value.associationRevision)
      }).catch(() => {
        // The archive commit is durable; a conflicting association update is
        // surfaced as a warning rather than failing the completed archive.
      })
    }
  }

  return { committed: true, archiveSource: join(openspecDirName, "changes", "archive", changeID) }
}

/** The base ref the close sequence syncs and lands against. */
export async function closeBaseRef(targetDir: string): Promise<string> {
  const mainDir = (await mainWorktreeDir(targetDir).catch(() => undefined)) ?? targetDir
  const detected = await detectBaseRef(mainDir).catch(() => undefined)
  return detected?.ref ?? "HEAD"
}

/**
 * The verified identity-keyed receipt for a feature (task 7.3/D8): counts
 * only when the landing commit is still reachable from the intended base and
 * the feature tip is unchanged. Everything else is no evidence at all.
 */
async function verifiedIdentityReceipt(
  commonDir: string,
  feature: FeatureRecord,
  baseRef: string,
  cwd: string,
): Promise<{ landingSha: string; featureTip: string } | undefined> {
  const receipt = await latestVerifiedReceipt(commonDir, feature.featureId, cwd)
  return receipt ? { landingSha: receipt.landingSha, featureTip: receipt.featureTip } : undefined
}

/**
 * The latest verified identity-keyed receipt (task 7.3/D8): full receipt
 * evidence for surfaces that must name the branch and base it recorded —
 * the worktree-less resume and cleanup. Counts only when the landing commit
 * is still reachable from the receipt's base and the feature tip is
 * unchanged (a deleted branch counts as unchanged: the landing already
 * happened and the tip cannot move).
 */
async function latestVerifiedReceipt(commonDir: string, featureId: string, cwd: string): Promise<LandingReceipt | undefined> {
  let verified: LandingReceipt | undefined
  for (const attemptId of await listReceiptIds(commonDir, featureId)) {
    const read = await readReceipt(commonDir, featureId, attemptId)
    if (read.status !== "found") continue
    const receipt = read.value
    if (!(await featureLandingReachable(receipt.landingSha, receipt.baseRef, cwd))) continue
    const tip = (await resolveCommit(receipt.branch, cwd).catch(() => undefined)) ?? undefined
    if (tip !== undefined && tip !== receipt.featureTip) continue
    verified = receipt
  }
  return verified
}

/**
 * The verified landing receipt for a branch/change, resolved by callers that
 * gate cleanup on evidence (design D7, task 6.3): identity-keyed receipts are
 * consulted first (they survive renames and reused branch names); the legacy
 * branch/change journal remains readable for unassociated work (design D10).
 * A receipt counts only when its landing commit is still reachable from the
 * base branch.
 */
export async function verifiedCloseReceipt(
  targetDir: string,
  branch: string,
  changeID: string,
): Promise<{ landingSha: string; postArchiveTip: string } | undefined> {
  const commonDir = await closeCommonDir(targetDir)
  if (!commonDir) return undefined
  const mainDir = (await mainWorktreeDir(targetDir).catch(() => undefined)) ?? targetDir

  // Identity-keyed first: resolve the feature by branch+change through the
  // shared resolver and verify its receipts against current Git evidence.
  const resolution = await resolveFeature({ cwd: targetDir, commonDir, branch, changeId: changeID }).catch(() => undefined)
  if (resolution?.status === "verified") {
    const identity = await verifiedIdentityReceipt(commonDir, resolution.feature, resolution.feature.intendedBaseRef, mainDir)
    if (identity) return { landingSha: identity.landingSha, postArchiveTip: identity.featureTip }
  }

  const journal = await readCloseJournal(commonDir, branch, changeID)
  if (!journal || journal.phase !== "landed" || !journal.landingSha || !journal.postArchiveTip) return undefined
  if (!(await isLandingReachable(journal.landingSha, journal.baseRef, mainDir))) return undefined
  return { landingSha: journal.landingSha, postArchiveTip: journal.postArchiveTip }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Quotes a token for the shell only when it would otherwise break out of a bare word. */
function shq(value: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

// ── the repository mutation lease (design D9, SC-5) ────────────────────────

/**
 * Runs one close mutation segment under the repository mutation lease. Close
 * never holds the lease while waiting for message review — the prepare
 * segment persists its journal and releases, the message gate runs unlocked,
 * and the landing segment reacquires with fresh revalidation. An unavailable
 * lease fails the segment closed (the operator retries once the other convoy
 * operation finishes); an unresolvable common dir refuses entirely, because
 * there would be no shared lock location to serialize against.
 */
async function withCloseLease<T>(commonDir: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!commonDir) {
    throw new Error("close: couldn't resolve the repository's git common dir — refusing to mutate without the repository mutation lease")
  }
  let lease: MutationLease
  try {
    lease = await acquireMutationLease(commonDir)
  } catch (error) {
    const reason = error instanceof LeaseUnavailableError ? error.message : `couldn't acquire the repository mutation lease: ${String(error)}`
    throw new Error(`close: ${reason}`)
  }
  try {
    return await fn()
  } finally {
    await lease.release()
  }
}

// ── cleanup-only continuation (design D9, task 7.7) ────────────────────────

/**
 * The feature-keyed cleanup executor: `convoy close --feature <id> --cleanup
 * worktree|branch`. This is the same guarded operation the TUI follow-ups and
 * the headless printed commands perform — never an unprotected check-then-
 * force-delete recipe. Every fact is revalidated at action time from current
 * Git evidence:
 *
 * - a verified identity receipt must name the feature (landing reachable from
 *   its recorded base, feature tip unchanged);
 * - no unresolved close attempt may be pending;
 * - worktree removal requires an existing, clean, non-main worktree with no
 *   live run, and Git's non-forced removal protections stay effective;
 * - branch deletion requires no registered worktree to check the branch out
 *   and runs the atomic expected-tip ref deletion, so a branch that moved
 *   between the check and the deletion refuses.
 *
 * Returns the human-readable outcome; throws with the concrete blocker when
 * any guard refuses.
 */
export async function runCloseCleanup(input: CloseInput): Promise<string> {
  if (!input.featureId) throw new Error("cleanup requires --feature <feature-id> — cleanup is feature-keyed, never branch-keyed (design D9)")
  if (input.cleanup !== "worktree" && input.cleanup !== "branch") throw new Error(`cleanup must be "worktree" or "branch"`)
  const mainDir = (await mainWorktreeDir(input.targetDir).catch(() => undefined)) ?? input.targetDir
  const commonDir = await closeCommonDir(input.targetDir)
  if (!commonDir) throw new Error("cleanup: no git repository — no landing evidence can resolve")

  const read = await readFeatureRecord(commonDir, input.featureId)
  if (read.status !== "found") throw new Error(`cleanup: feature ${input.featureId} could not be resolved (${read.status}) — run \`convoy feature show\``)
  const feature = read.value

  // Unresolved attempts block cleanup until reconciled (design D9: "verify no
  // live run/recovery").
  for (const attemptId of await listAttemptIds(commonDir, feature.featureId)) {
    const journal = await readAttemptJournal(commonDir, feature.featureId, attemptId)
    if (journal.status === "found" && journal.value.phase !== "landed") {
      throw new Error(`cleanup: close attempt ${attemptId.slice(0, 8)} is still unresolved — run \`convoy close --feature ${input.featureId} --resume\` to reconcile it first`)
    }
  }

  const receipt = await latestVerifiedReceipt(commonDir, feature.featureId, mainDir)
  if (!receipt) {
    throw new Error(await cleanupReceiptBlocker(commonDir, feature.featureId, mainDir))
  }
  const branch = receipt.branch
  const tipNow = (await resolveCommit(branch, mainDir).catch(() => undefined)) ?? undefined
  if (tipNow !== undefined && tipNow !== receipt.featureTip) {
    throw new Error(`cleanup: ${branch}'s tip moved past the landed state (${receipt.featureTip.slice(0, 8)}) — inspect the branch before removing anything`)
  }

  // The execution is a repository mutation (design D9): it runs under the
  // mutation lease, with the final context checks re-read inside the lease
  // window so the last-read-then-mutate gap is serialized against every
  // other convoy operation.
  return withCloseLease(commonDir, async () => {
    if (input.cleanup === "worktree") {
      const worktreeDir = input.worktreeDir ?? (await findWorktreeDirForBranch(branch, input.targetDir)) ?? undefined
      if (!worktreeDir) throw new Error(`cleanup: ${branch} has no registered worktree left — nothing to remove (branch cleanup is the remaining step)`)
      const isMain = (await resolveSame(mainDir, worktreeDir)) === true
      if (isMain) throw new Error(`cleanup: ${worktreeDir} is the main checkout — it is never removed`)
      const status = await statusPorcelain(worktreeDir).catch(() => "unreadable")
      if (status.trim() !== "") {
        throw new Error(`cleanup: the worktree at ${worktreeDir} has uncommitted changes — commit or stash them first; removal refuses dirty contexts`)
      }
      const live = await liveRunsAt(worktreeDir)
      if (live.kind === "unknown") throw new Error(`cleanup: couldn't verify live runs (${live.reason}) — refusing removal while run state is unreadable`)
      if (live.value > 0) throw new Error(`cleanup: ${live.value} live run${live.value === 1 ? " is" : "s are"} attached to ${worktreeDir} — wait for or stop ${live.value === 1 ? "it" : "them"} first`)
      await removeWorktree(worktreeDir, mainDir)
      return `removed the feature worktree at ${worktreeDir} (landing ${receipt.landingSha.slice(0, 8)} verified) — branch deletion is the remaining step: convoy close --feature ${input.featureId} --cleanup branch`
    }

    // Branch deletion: no registered worktree may have the branch checked out
    // (Git's inventory decides — never a path guess), then the atomic
    // expected-tip ref deletion.
    const list = await execFile("git", ["worktree", "list", "--porcelain"], { cwd: mainDir, allowFailure: true })
    if (list.exitCode !== 0) throw new Error("cleanup: couldn't read the worktree inventory — refusing to delete the branch while registration is unverifiable")
    if (list.stdout.split("\n").includes(`branch refs/heads/${branch}`)) {
      throw new Error(`cleanup: ${branch} is checked out in a registered worktree — remove that worktree first (convoy close --feature ${input.featureId} --cleanup worktree)`)
    }
    if (tipNow === undefined) {
      return `${branch} no longer exists locally — nothing to delete (feature ${feature.featureId}'s landing evidence is retained)`
    }
    const result = await execFile("git", ["update-ref", "-d", `refs/heads/${branch}`, receipt.featureTip], { cwd: mainDir, allowFailure: true })
    if (result.exitCode !== 0) {
      throw new Error((result.stderr || `the expected-tip deletion of ${branch} was refused`).trim())
    }
    return `deleted the local ${branch} branch at its landed tip ${receipt.featureTip.slice(0, 8)} (landing ${receipt.landingSha.slice(0, 8)} verified)`
  })
}

/**
 * Diagnoses why no verified receipt authorizes cleanup, so the refusal names
 * the actual fact (stale tip, unreachable landing, or no receipt at all)
 * instead of a generic "unauthorized".
 */
async function cleanupReceiptBlocker(commonDir: string, featureId: string, mainDir: string): Promise<string> {
  const receipts: LandingReceipt[] = []
  for (const attemptId of await listReceiptIds(commonDir, featureId)) {
    const read = await readReceipt(commonDir, featureId, attemptId)
    if (read.status === "found") receipts.push(read.value)
  }
  if (receipts.length === 0) {
    return (
      `cleanup: no verified landing receipt names feature ${featureId} — cleanup requires the receipt a completed close recorded ` +
      "(landing commit reachable from the base and an unchanged feature tip)"
    )
  }
  for (const receipt of receipts) {
    const tip = (await resolveCommit(receipt.branch, mainDir).catch(() => undefined)) ?? undefined
    if (tip !== undefined && tip !== receipt.featureTip) {
      return `cleanup: ${receipt.branch}'s tip moved past the landed state (${receipt.featureTip.slice(0, 8)}) — inspect the branch before removing anything`
    }
    if (!(await featureLandingReachable(receipt.landingSha, receipt.baseRef, mainDir))) {
      return `cleanup: the recorded landing ${receipt.landingSha.slice(0, 8)} is no longer reachable from ${receipt.baseRef} — inspect the history before removing anything`
    }
  }
  return `cleanup: feature ${featureId}'s landing evidence does not authorize cleanup — inspect \`convoy feature show\``
}

/** The live-run count at a checkout, typed so unreadable state is never "none". */
async function liveRunsAt(worktreeDir: string): Promise<{ kind: "known"; value: number } | { kind: "unknown"; reason: string }> {
  try {
    const runs = await listRuns()
    let count = 0
    for (const run of runs) {
      if (run.live && run.targetDir && (await resolveSame(run.targetDir, worktreeDir))) count += 1
    }
    return { kind: "known", value: count }
  } catch (error) {
    return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Re-exported so cleanup surfaces can quote guarded commands from the same evidence. */
export { isLandingReachable, readCloseJournal, closeCandidateRef, closeFeatureTipRef }
