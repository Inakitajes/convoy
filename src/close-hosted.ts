import { execFile, findWorktreeDirForBranch, isAncestor, pushRefspec, realpathSafe, remoteBranchTip, resolveCommit, statusPorcelain, currentBranch, branchUpstream } from "./git"
import {
  acknowledgeStep,
  createOperation,
  listPendingOperations,
  readOperation,
  recordStepIntent,
  resolveOperation,
  type OperationRecord,
} from "./operation-journal"
import { assertNonForceRefspec } from "./operation-handlers"
import { reconcileStepReality } from "./operation-reconcile"
import { recoverOperation } from "./operation-recovery"
import { readPrMergeState } from "./pr-merge-state"
import type { CloseEvent, HostedMergeFacts } from "./close-events"

/**
 * The hosted close landing (change `close-lands-via-github-pr`, design D2–D6):
 * when close detects exactly one open PR for the branch through usable hosting
 * evidence, the landing leaves the local candidate behind and becomes a
 * three-step remote transaction — publish the branch (non-force), request the
 * PR's squash-merge with the reviewed message, then fast-forward the local
 * base to GitHub's squash commit.
 *
 * Every step records its intent before its effect and acknowledges it only
 * after verifying the actual remote/hosting/Git state, so an interrupted or
 * uncertain operation reconciles by receipt (`convoy worktrees recover`):
 * a pushed SHA is recognized rather than re-pushed, a merged PR rather than
 * re-merged, a base that already contains the hosted commit rather than
 * advanced again. Contradictory evidence stops with guidance instead of
 * guessing. The source branch is never force-pushed, rewritten, or deleted.
 */

export type HostedLandingOutcome =
  | { ok: true; facts: HostedMergeFacts; narration: string[] }
  | { ok: false; reason: string }

/** The frozen reviewed inputs of one hosted landing attempt. */
export type HostedLandingInput = {
  checkout: string
  branch: string
  base: string
  commonDir: string
  prNumber: number
  /** The accepted message: subject is its first line, body the remaining lines. */
  message: string
  /** Remote the PR's head branch lives on; resolved from the upstream when unset. */
  remote?: string
  onEvent?: (event: CloseEvent) => void
  /** An existing pending operation to resume (recovery), instead of creating one. */
  existingOperationId?: string
  /** Injected effects for tests; default to the real `gh`/git subprocesses. */
  effects?: Partial<HostedEffects>
}

export type HostedEffects = {
  /** `gh pr merge <n> --squash --subject … --body …`; throws on failure. */
  requestMerge: (prNumber: number, subject: string, body: string, checkout: string) => Promise<void>
  /** `gh pr view <n> --json state,mergeCommit`, honestly unknown on failure. */
  readMergeState: (prNumber: number, checkout: string) => Promise<{ state?: string; mergeCommit?: string; reason?: string }>
  /** The remote's current tip for `refs/heads/<ref>`, or undefined. */
  remoteTip: (remote: string, ref: string, checkout: string) => Promise<string | undefined>
}

const defaultEffects: HostedEffects = {
  async requestMerge(prNumber, subject, body, checkout) {
    const result = await execFile(
      "gh",
      ["pr", "merge", String(prNumber), "--squash", "--subject", subject, "--body", body],
      { cwd: checkout, allowFailure: true },
    )
    if (result.exitCode !== 0) {
      // The request may still have taken effect: the caller re-reads the PR
      // state rather than trusting the exit code either way.
      throw new Error((result.stderr || result.stdout).trim().slice(0, 300) || `gh pr merge ${prNumber} failed`)
    }
  },
  async readMergeState(prNumber, checkout) {
    return readPrMergeState(prNumber, checkout)
  },
  async remoteTip(remote, ref, checkout) {
    const queried = await remoteBranchTip(remote, ref, checkout)
    return queried.kind === "known" ? queried.tip : undefined
  },
}

/** Whether a pending operation is a hosted close landing for a branch. */
export function isHostedCloseOperation(record: OperationRecord): boolean {
  const intent = typeof record.intent === "object" && record.intent !== null ? (record.intent as Record<string, unknown>) : {}
  return record.kind === "close" && intent.hosted === true
}

/**
 * Reads a hosted close operation's frozen inputs (top-level intent plus the
 * per-step recorded intents). Recovery replays the remaining steps with these
 * frozen facts — never regenerated text and never re-pushed or re-merged
 * effects.
 */
export async function hostedOperationInputs(commonDir: string, operationId: string): Promise<HostedLandingInput | undefined> {
  const read = await readOperation(commonDir, operationId)
  if (read.status !== "found" || !isHostedCloseOperation(read.value)) return undefined
  const record = read.value
  const intent = typeof record.intent === "object" && record.intent !== null ? (record.intent as Record<string, unknown>) : {}
  if (typeof intent.checkout !== "string" || typeof intent.branch !== "string" || typeof intent.base !== "string" || typeof intent.prNumber !== "number") return undefined
  const step = (id: string) => record.steps.find((entry) => entry.id === id)
  const stepIntent = (id: string) => {
    const raw = step(id)?.intent
    return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {}
  }
  const mergeStep = stepIntent("hosted-merge")
  const subject = typeof mergeStep.subject === "string" ? mergeStep.subject : typeof intent.subject === "string" ? intent.subject : ""
  const body = typeof mergeStep.body === "string" ? mergeStep.body : typeof intent.body === "string" ? intent.body : ""
  return {
    checkout: intent.checkout,
    branch: intent.branch,
    base: intent.base,
    commonDir,
    prNumber: intent.prNumber,
    remote: typeof intent.remote === "string" ? intent.remote : undefined,
    message: subject ? [subject, ...(body ? [body] : [])].join("\n") : "",
    existingOperationId: operationId,
  }
}

/**
 * The step's progress within a pending operation: undecided steps are the
 * only ones an execution may run.
 */
async function stepState(commonDir: string, operationId: string, stepId: string): Promise<"undecided" | "acknowledged" | "cancelled" | "missing"> {
  const read = await readOperation(commonDir, operationId)
  if (read.status !== "found") return "missing"
  const step = read.value.steps.find((entry) => entry.id === stepId)
  if (!step) return "missing"
  if (step.acknowledgement) return "acknowledged"
  if (step.cancelled) return "cancelled"
  return "undecided"
}

function splitMessage(message: string): { subject: string; body: string } {
  const [subject = "", ...rest] = message.split("\n")
  return { subject: subject.trim(), body: rest.join("\n").trim() }
}

/**
 * Runs the hosted landing. Creates (or resumes) the journaled close operation,
 * then executes the three steps in order with intent-before-effect and
 * receipt-reconciliation, resolving the journal only when every step verified.
 * Any failure leaves the journal pending for recovery; the local branch,
 * worktree, and PR stay usable.
 */
export async function landViaGitHub(input: HostedLandingInput): Promise<HostedLandingOutcome> {
  const emit = (event: CloseEvent) => input.onEvent?.(event)
  const effects = { ...defaultEffects, ...input.effects }
  const { subject, body } = splitMessage(input.message)

  const sourceTip = await resolveCommit("HEAD", input.checkout)
  if (!sourceTip) return { ok: false, reason: `checkout ${input.checkout} has no commit to publish` }
  // The PR's head branch lives on the branch's configured upstream remote when
  // one is set, otherwise the repository's default remote. Disclosed in review
  // before the effect, never guessed per-step.
  const upstream = await branchUpstream(input.branch, input.checkout).catch(() => undefined)
  const remote = input.remote ?? (upstream && upstream.includes("/") ? upstream.slice(0, upstream.indexOf("/")) : "origin")

  const operationId = input.existingOperationId ?? (await createHostedOperation(input, { remote, subject, body, sourceTip }))
  if (!operationId) return { ok: false, reason: "the hosted-landing journal could not be created" }

  const narration: string[] = []
  let mergeCommit: string | undefined
  let baseAdvanced = false

  // ── step 1: publish the reviewed branch tip (normal non-force update) ──
  if ((await stepState(input.commonDir, operationId, "branch-push")) === "undecided") {
    await recordStepIntent(input.commonDir, operationId, "branch-push", { remote, remoteRef: input.branch, oid: sourceTip, localBranch: input.branch }).catch(() => {})
    emit({ type: "squash-phase", phase: "pushing-branch" })
    // Receipt first: an already-pushed tip is recognized, never re-pushed.
    const currentRemoteTip = await effects.remoteTip(remote, input.branch, input.checkout)
    if (currentRemoteTip !== sourceTip) {
      try {
        // The same non-force refspec boundary the standalone push uses
        // (`assertNonForceRefspec`): a branch name that would turn this
        // `<branch>:<branch>` refspec into a force update (a leading `+`) is
        // refused before Git is invoked, never silently force-pushed.
        const refspec = `${input.branch}:${input.branch}`
        assertNonForceRefspec(refspec)
        await pushRefspec(remote, refspec, input.checkout)
      } catch (error) {
        return { ok: false, reason: `pushing ${input.branch} to ${remote} failed (no force fallback): ${error instanceof Error ? error.message : String(error)}` }
      }
      const after = await effects.remoteTip(remote, input.branch, input.checkout)
      if (after !== sourceTip) {
        return { ok: false, reason: `the push did not land the reviewed tip on ${remote}/${input.branch} (remote holds ${after?.slice(0, 8) ?? "nothing"}) — inspect before retrying` }
      }
      narration.push(`pushed ${input.branch} to ${remote} (normal non-force update)`)
    } else {
      narration.push(`${input.branch} was already pushed to ${remote}`)
    }
    const ack = await acknowledgeStep(input.commonDir, operationId, "branch-push", { remote, remoteRef: input.branch, oid: sourceTip })
    if (!ack.ok) return { ok: false, reason: `the branch push succeeded but its journal acknowledgement failed: ${ack.reason}` }
  }

  // ── step 2: request the hosted squash-merge with the reviewed message ──
  if ((await stepState(input.commonDir, operationId, "hosted-merge")) === "undecided") {
    await recordStepIntent(input.commonDir, operationId, "hosted-merge", { prNumber: input.prNumber, subject, body }).catch(() => {})
    emit({ type: "squash-phase", phase: "requesting-merge" })
    // Receipt reconciliation: a merged PR is the completed step, never a
    // second merge request.
    const before = await effects.readMergeState(input.prNumber, input.checkout)
    if (before.reason !== undefined) {
      return { ok: false, reason: `the pull request state could not be read: ${before.reason} — the merge request was not issued; retry when GitHub is reachable` }
    }
    if (before.state === "MERGED") {
      mergeCommit = before.mergeCommit
      narration.push(`PR #${input.prNumber} was already merged`)
    } else if (before.state === "OPEN") {
      let mergeError: string | undefined
      try {
        await effects.requestMerge(input.prNumber, subject, body, input.checkout)
      } catch (error) {
        mergeError = error instanceof Error ? error.message : String(error)
      }
      // Observe the outcome; an exit code alone is not a receipt either way.
      const after = await effects.readMergeState(input.prNumber, input.checkout)
      if (after.reason !== undefined) {
        return { ok: false, reason: `the hosted merge outcome is uncertain (the PR state could not be read: ${after.reason}${mergeError ? `; gh reported: ${mergeError}` : ""}) — reconcile with \`convoy worktrees recover\` before retrying` }
      }
      if (after.state === "MERGED") {
        mergeCommit = after.mergeCommit
        narration.push(`GitHub squash-merged PR #${input.prNumber}`)
      } else {
        return {
          ok: false,
          reason: `GitHub did not merge PR #${input.prNumber}${mergeError ? `: ${mergeError}` : " — the merge request did not complete"} — the PR and the branch are unchanged; resolve the blocker (merge conflicts, unmergeable state, permissions) and retry`,
        }
      }
    } else {
      return { ok: false, reason: `PR #${input.prNumber} is ${before.state ?? "in an unreadable state"} — a landing cannot be requested through it; inspect the PR before retrying` }
    }
    const ack = await acknowledgeStep(input.commonDir, operationId, "hosted-merge", { prNumber: input.prNumber, ...(mergeCommit ? { mergeCommit } : {}) })
    if (!ack.ok) return { ok: false, reason: `the hosted merge succeeded but its journal acknowledgement failed: ${ack.reason}` }
  } else {
    // Resuming: recover the merge commit from the acknowledged step's receipt.
    const read = await readOperation(input.commonDir, operationId)
    if (read.status === "found") {
      const evidence = read.value.steps.find((entry) => entry.id === "hosted-merge")?.acknowledgement?.evidence as { mergeCommit?: unknown } | undefined
      if (typeof evidence?.mergeCommit === "string") mergeCommit = evidence.mergeCommit
    }
  }

  // ── step 3: advance the clean local base to the hosted squash commit ──
  if ((await stepState(input.commonDir, operationId, "base-advancement")) === "undecided") {
    await recordStepIntent(input.commonDir, operationId, "base-advancement", { base: input.base, ...(mergeCommit ? { mergeCommit } : {}) }).catch(() => {})
    emit({ type: "squash-phase", phase: "catching-up-base" })
    const baseDir = await findWorktreeDirForBranch(input.base, input.checkout)
    if (!baseDir) return { ok: false, reason: `base branch ${input.base} is not checked out in any registered worktree — check it out somewhere clean before catching up` }
    const baseBranchNow = await currentBranch(baseDir)
    if (baseBranchNow !== input.base) {
      return { ok: false, reason: `the base checkout ${baseDir} is on ${baseBranchNow ?? "a detached HEAD"}, not ${input.base}` }
    }
    const baseDirt = await statusPorcelain(baseDir)
    if (baseDirt.trim() !== "") {
      return { ok: false, reason: `the base checkout ${baseDir} is dirty — the fast-forward needs a clean base; commit, stash, or clean it first` }
    }
    // Fetch the remote base, then fast-forward only: a merge commit on the
    // local base would reintroduce the local/remote divergence this path
    // exists to remove (design D6).
    const fetch = await execFile("git", ["fetch", "--", remote, input.base], { cwd: baseDir, allowFailure: true })
    if (fetch.exitCode !== 0) {
      return { ok: false, reason: `fetching ${remote}/${input.base} failed: ${(fetch.stderr || fetch.stdout).trim()}` }
    }
    const remoteBaseTip = await resolveCommit(`${remote}/${input.base}`, baseDir)
    if (!remoteBaseTip) return { ok: false, reason: `the fetched ${remote}/${input.base} did not resolve to a commit` }
    if (mergeCommit && !(await isAncestor(mergeCommit, remoteBaseTip, baseDir))) {
      return { ok: false, reason: `the hosted squash commit ${mergeCommit.slice(0, 8)} is not contained in the fetched ${remote}/${input.base} (${remoteBaseTip.slice(0, 8)}) — contradictory hosting/Git evidence; inspect before retrying` }
    }
    const localBaseTip = await resolveCommit(input.base, baseDir)
    if (localBaseTip === remoteBaseTip) {
      narration.push(`${input.base} already contained the hosted squash commit`)
    } else if (localBaseTip && (await isAncestor(localBaseTip, remoteBaseTip, baseDir))) {
      const ff = await execFile("git", ["merge", "--ff-only", "--", `${remote}/${input.base}`], { cwd: baseDir, allowFailure: true })
      if (ff.exitCode !== 0) {
        return { ok: false, reason: `fast-forwarding ${input.base} to ${remote}/${input.base} failed: ${(ff.stderr || ff.stdout).trim()}` }
      }
      const advanced = await resolveCommit(input.base, baseDir)
      if (advanced !== remoteBaseTip) {
        return { ok: false, reason: `the base did not advance onto ${remoteBaseTip.slice(0, 8)} (at ${advanced?.slice(0, 8) ?? "?"}) — inspect before retrying` }
      }
      narration.push(`fast-forwarded ${input.base} to ${remoteBaseTip.slice(0, 8)} (GitHub's squash commit)`)
      baseAdvanced = true
    } else {
      return { ok: false, reason: `the local ${input.base} has local-only commits and cannot fast-forward to ${remote}/${input.base} — reconcile the divergence (sync or rebase) and retry` }
    }
    const ack = await acknowledgeStep(input.commonDir, operationId, "base-advancement", { base: input.base, ...(mergeCommit ? { mergeCommit } : {}), landedSha: remoteBaseTip })
    if (!ack.ok) return { ok: false, reason: `the base advancement succeeded but its journal acknowledgement failed: ${ack.reason}` }
  }

  await resolveOperation({ commonDir: input.commonDir, operationId, gitCwd: input.checkout, outcome: "resolved" }).catch(() => {})
  return {
    ok: true,
    facts: { prNumber: input.prNumber, ...(mergeCommit ? { mergeSha: mergeCommit } : {}), base: input.base, baseAdvanced },
    narration,
  }
}

async function createHostedOperation(input: HostedLandingInput, frozen: { remote: string; subject: string; body: string; sourceTip: string }): Promise<string | undefined> {
  const created = await createOperation(input.commonDir, {
    kind: "close",
    intent: {
      hosted: true,
      checkout: input.checkout,
      branch: input.branch,
      base: input.base,
      prNumber: input.prNumber,
      remote: frozen.remote,
      subject: frozen.subject,
      body: frozen.body,
      sourceTip: frozen.sourceTip,
    },
    steps: ["branch-push", "hosted-merge", "base-advancement"],
  })
  if (!created.ok) return undefined
  return created.operation.operationId
}

/**
 * Reconciles pending hosted close operations for this checkout/branch before a
 * fresh landing (design D9): verified effects are acknowledged by receipt,
 * unexplained evidence blocks, and undecided remaining steps stop the fresh
 * close — continuing them is an explicit recovery decision
 * (`convoy worktrees recover --operation <id> --continue`), never an
 * implicit one.
 */
export async function reconcilePendingHostedCloses(commonDir: string, checkout: string, branch: string, gitCwd: string): Promise<void> {
  // Paths compare through their physical form (the shared `realpathSafe`
  // helper, task 1.4 consolidation): a worktree reached through a symlinked
  // path (/var → /private/var) is the same checkout the intent froze.
  const samePath = async (a: string, b: string): Promise<boolean> => (await realpathSafe(a)) === (await realpathSafe(b))
  const pending = await listPendingOperations(commonDir)
  for (const operationId of pending) {
    const read = await readOperation(commonDir, operationId)
    if (read.status !== "found" || !isHostedCloseOperation(read.value)) continue
    const intent = read.value.intent as { checkout?: unknown; branch?: unknown }
    if (typeof intent.checkout !== "string" || intent.branch !== branch || !(await samePath(intent.checkout, checkout))) continue
    const probe = (step: Parameters<typeof reconcileStepReality>[0], operation: Parameters<typeof reconcileStepReality>[1]) => reconcileStepReality(step, operation, gitCwd)
    const outcome = await recoverOperation({ commonDir, operationId, gitCwd, probe, consent: "continue" })
    if (outcome.status === "blocked") {
      throw new Error(`a pending hosted close (${operationId}) could not be reconciled: ${outcome.reason} — inspect it with \`convoy worktrees recover --operation ${operationId}\``)
    }
    const remaining = outcome.status === "needs-work" ? outcome.remaining : []
    if (remaining.length > 0) {
      throw new Error(
        `a pending hosted close (${operationId}) still has undecided steps (${remaining.join(", ")}) — continue or cancel it explicitly with \`convoy worktrees recover --operation ${operationId} --continue|--cancel\` before closing here`,
      )
    }
    // Reconciled or cancelled: the journal was released; the fresh close proceeds.
  }
}
