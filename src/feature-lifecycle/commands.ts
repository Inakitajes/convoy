import { readdir, realpath } from "node:fs/promises"
import { join } from "node:path"

import { currentBranch, execFile, findWorktreeDirForBranch, mainWorktreeDir, resolveCommit } from "../git"
import { isOpenSpecChangeId, listChangeIds, openspecDirName } from "../openspec"
import { observeLiveRunsAt } from "./adapters"
import { assessLifecycle, type LifecycleAssessment } from "./assessment"
import { discoverLifecycle } from "./discovery"
import {
  ensureRepositoryRecord,
  isFound,
  lifecycleCommonDir,
  withFeatureLock,
  type StoreRead,
} from "./store"
import { acquireMutationLease, LeaseUnavailableError, type MutationLease } from "../finalization/lease"
import {
  isCompletedFeature,
  listAttemptIds,
  listFeatureRecords,
  listReceiptIds,
  readAttemptJournal,
  readFeatureRecord,
  readReceipt,
  writeFeatureRecord,
  writeReceiptIfAbsent,
  type AssociationEvent,
  type FeatureContract,
  type FeatureRecord,
} from "./records"
import { isLandingReachableFrom } from "./refs"
import { planningPathWithin, resolveFeature } from "./resolver"

/**
 * The explicit feature identity operations (capability `feature-lifecycle`,
 * design D3, tasks 3.1–3.6): show, adopt, bind, revise, recover, new-work.
 * Adoption/rebinding are the consent gates that replace naming authority:
 * every operation validates repository membership, the actual checked-out
 * branch, worktree registration, and the selected sources before persisting
 * a new association revision. None of them mark tasks, archives, or
 * integration complete, and none rename a branch (design D3).
 */

export type FeatureOperationError = Error & { code?: "missing" | "ambiguous" | "unreadable" | "conflict" }

export function operationError(message: string, code: FeatureOperationError["code"]): FeatureOperationError {
  const error = new Error(message) as FeatureOperationError
  error.code = code
  return error
}

// ── show (task 3.1) ──────────────────────────────────────────────────────

export type FeatureShowOutput = {
  featureId?: string
  displayName?: string
  associationRevision?: number
  intendedBaseRef?: string
  context?: { branch: string; checkoutPath?: string }
  contracts?: FeatureContract[]
  runIds?: string[]
  closeAttemptIds?: string[]
  receipts?: Array<{ attemptId: string; landingSha: string; landingReachable: boolean }>
  assessment?: Pick<LifecycleAssessment, "summary" | "blockers" | "closeStartPrerequisitesPass">
  resolution?: { status: string; reason?: string }
  /** Unresolved discovery evidence for the current context (task 3.1). */
  discovery?: { candidates: Array<{ changeId: string; dir: string; hasMarkdown: boolean }>; unreadableFeatures: Array<{ featureId: string; reason: string }> }
  /** Rendered text form, present when `json` was not requested. */
  text?: string
}

/**
 * Read-only inspection of a feature (by ID) or of the current context. Never
 * mutates: no repository UUID is created, no record is adopted or migrated
 * (task 3.1; design D1: reads do not create).
 */
export async function featureShow(input: { cwd: string; featureId?: string; json?: boolean }): Promise<{ output: FeatureShowOutput; text?: string }> {
  const commonDir = await lifecycleCommonDir(input.cwd)
  if (!commonDir) throw operationError("not a git repository", "missing")

  const resolution = await resolveFeature({ cwd: input.cwd, commonDir, featureId: input.featureId })
  const output: FeatureShowOutput = { resolution: { status: resolution.status, ...(resolution.status !== "verified" && "reason" in resolution ? { reason: resolution.reason } : {}) } }

  if (resolution.status === "verified") {
    const feature = resolution.feature
    const receipts: FeatureShowOutput["receipts"] = []
    for (const { attemptId, receipt } of (await discoverLifecycle({ cwd: input.cwd, commonDir })).features.find((entry) => entry.featureId === feature.featureId)?.receipts ?? []) {
      if (!receipt) continue
      receipts.push({ attemptId, landingSha: receipt.landingSha, landingReachable: await isLandingReachableFrom(receipt.landingSha, receipt.baseRef, input.cwd) })
    }
    output.featureId = feature.featureId
    output.displayName = feature.displayName
    output.associationRevision = feature.associationRevision
    output.intendedBaseRef = feature.intendedBaseRef
    output.context = { branch: resolution.context.branch, ...(resolution.context.checkoutPath ? { checkoutPath: resolution.context.checkoutPath } : {}) }
    output.contracts = feature.contracts
    output.runIds = feature.runIds
    output.closeAttemptIds = feature.closeAttemptIds
    output.receipts = receipts
    const assessment = await assessCurrentFeature({ cwd: input.cwd, commonDir, feature })
    output.assessment = { summary: assessment.summary, blockers: assessment.blockers, closeStartPrerequisitesPass: assessment.closeStartPrerequisitesPass }
  } else if (input.featureId) {
    // An explicitly named record renders even without a verified context
    // (e.g. a recovered completed feature whose worktree is gone).
    const read = await readFeatureRecord(commonDir, input.featureId)
    if (isFound(read)) {
      const feature = read.value
      const receipts: FeatureShowOutput["receipts"] = []
      for (const attemptId of await listReceiptIds(commonDir, feature.featureId)) {
        const receiptRead = await readReceipt(commonDir, feature.featureId, attemptId)
        if (receiptRead.status !== "found") continue
        const receipt = receiptRead.value
        receipts.push({ attemptId, landingSha: receipt.landingSha, landingReachable: await isLandingReachableFrom(receipt.landingSha, receipt.baseRef, input.cwd) })
      }
      output.featureId = feature.featureId
      output.displayName = feature.displayName
      output.associationRevision = feature.associationRevision
      output.intendedBaseRef = feature.intendedBaseRef
      if (feature.context) {
        output.context = { branch: feature.context.branch, ...(feature.context.checkoutPath ? { checkoutPath: feature.context.checkoutPath } : {}) }
      }
      output.contracts = feature.contracts
      output.runIds = feature.runIds
      output.closeAttemptIds = feature.closeAttemptIds
      output.receipts = receipts
    } else {
      const discovery = await discoverLifecycle({ cwd: input.cwd, commonDir })
      output.discovery = {
        candidates: discovery.candidates.map((candidate) => ({ changeId: candidate.changeId, dir: candidate.dir, hasMarkdown: candidate.hasMarkdown })),
        unreadableFeatures: discovery.unreadableFeatures.map((entry) => ({ featureId: entry.featureId, reason: entry.reason })),
      }
    }
  } else {
    // Unresolved: include discovery evidence so the operator can decide what
    // to adopt (task 3.1: show unresolved discovery evidence).
    const discovery = await discoverLifecycle({ cwd: input.cwd, commonDir })
    output.discovery = {
      candidates: discovery.candidates.map((candidate) => ({ changeId: candidate.changeId, dir: candidate.dir, hasMarkdown: candidate.hasMarkdown })),
      unreadableFeatures: discovery.unreadableFeatures.map((entry) => ({ featureId: entry.featureId, reason: entry.reason })),
    }
  }

  if (!input.json) output.text = renderFeatureShow(output)
  return { output, text: output.text }
}

function renderFeatureShow(output: FeatureShowOutput): string {
  const lines: string[] = []
  if (output.featureId) {
    lines.push(`feature  ${output.displayName} (${output.featureId})`)
    lines.push(`revision ${output.associationRevision}`)
    lines.push(`base     ${output.intendedBaseRef}`)
    if (output.context) lines.push(`context  ${output.context.branch}${output.context.checkoutPath ? ` at ${output.context.checkoutPath}` : ""}`)
    for (const contract of output.contracts ?? []) {
      lines.push(`contract ${contract.changeId} (${contract.kind}) ← ${contract.sourcePath}`)
    }
    for (const receipt of output.receipts ?? []) {
      lines.push(`receipt  ${receipt.attemptId.slice(0, 8)} landing ${receipt.landingSha.slice(0, 8)}${receipt.landingReachable ? " (reachable)" : " (unreachable)"}`)
    }
    if (output.assessment) {
      lines.push(`status   ${output.assessment.summary}`)
      for (const blocker of output.assessment.blockers) lines.push(`blocker  ${blocker}`)
    }
  } else {
    lines.push(`no verified feature for this context (${output.resolution?.status})`)
    if (output.resolution?.reason) lines.push(output.resolution.reason)
    for (const candidate of output.discovery?.candidates ?? []) {
      lines.push(`candidate ${candidate.changeId}${candidate.hasMarkdown ? "" : " (husk)"} in ${candidate.dir}`)
    }
    for (const unreadable of output.discovery?.unreadableFeatures ?? []) {
      lines.push(`unreadable feature record ${unreadable.featureId}: ${unreadable.reason}`)
    }
  }
  return lines.join("\n")
}

// ── adopt (task 3.2) ─────────────────────────────────────────────────────

export type AdoptInput = {
  cwd: string
  branch: string
  changeIds: string[]
  base: string
  displayName?: string
  /** Single-contract shorthand: the archive path for one archived contract. */
  archivePath?: string
  /** Headless multi-contract form: `--archive-source <change-id>=<path>`, mutually exclusive with `--archive-path`. */
  archiveSources?: Array<{ changeId: string; path: string }>
}

export type AdoptResult = { feature: FeatureRecord }

/**
 * Explicit adoption of existing work (task 3.2): associates `changeIds` with
 * `branch` (any Git-valid name — the branch is never renamed) and `base`.
 * Validates repository membership, worktree registration, the actual
 * checked-out branch, and each selected source (active tree or archive
 * path). Adoption records intent; it never marks tasks, archives, or
 * integration complete (design D3).
 */
export async function featureAdopt(input: AdoptInput): Promise<AdoptResult> {
  const commonDir = await lifecycleCommonDir(input.cwd)
  if (!commonDir) throw operationError("not a git repository", "missing")
  if (input.branch.startsWith("-") || input.branch.includes(" ")) throw operationError(`"${input.branch}" is not a valid branch name`, "missing")
  if (input.changeIds.length === 0) throw operationError("adopt requires at least one --change <id>", "missing")
  for (const changeId of input.changeIds) {
    if (!isOpenSpecChangeId(changeId)) throw operationError(`"${changeId}" is not a valid change id`, "missing")
  }
  if (input.archivePath !== undefined && input.archiveSources !== undefined && input.archiveSources.length > 0) {
    throw operationError("use either --archive-path (single contract) or --archive-source <change>=<path> (multi-contract), not both", "missing")
  }

  const repoRecord = await ensureRepositoryRecord(commonDir)
  if (!isFound(repoRecord)) throw operationError(`couldn't initialize the lifecycle store: ${repoRecord.status === "unreadable" ? repoRecord.reason : repoRecord.status}`, "unreadable")

  // Context uniqueness: a context SHALL NOT be silently claimed by two
  // features (design D2) — adoption refuses an already-claimed branch.
  for (const entry of await listFeatureRecords(commonDir)) {
    if (isFound(entry.read) && entry.read.value.context?.branch === input.branch) {
      throw operationError(`branch "${input.branch}" is already claimed by feature ${entry.read.value.featureId}`, "conflict")
    }
  }

  // The branch must be checked out somewhere (worktree registration) and the
  // named branch must be the checkout's actual branch (design D3: validate
  // the actual checked-out branch, not the requested spelling).
  const worktreeDir = await findWorktreeDirForBranch(input.branch, input.cwd)
  if (!worktreeDir) throw operationError(`branch "${input.branch}" is not checked out in any worktree of this repository`, "missing")
  const actual = await currentBranch(worktreeDir)
  if (actual !== input.branch) throw operationError(`worktree ${worktreeDir} has branch "${actual ?? "(detached)"}" checked out, not "${input.branch}"`, "conflict")

  const mainDir = (await mainWorktreeDir(input.cwd).catch(() => undefined)) ?? input.cwd
  const baseSha = await resolveCommit(input.base, mainDir).catch(() => undefined)
  if (!baseSha) throw operationError(`base ref "${input.base}" does not resolve in this repository`, "missing")

  const planningRoot = worktreeDir
  const archiveSources = new Map<string, string>()
  if (input.archivePath !== undefined) {
    if (input.changeIds.length !== 1) throw operationError("--archive-path applies to exactly one --change", "missing")
    archiveSources.set(input.changeIds[0]!, input.archivePath)
  }
  for (const source of input.archiveSources ?? []) {
    if (!archiveSources.has(source.changeId)) archiveSources.set(source.changeId, source.path)
  }

  const contracts: FeatureContract[] = []
  for (const changeId of input.changeIds) {
    const archivePath = archiveSources.get(changeId)
    if (archivePath !== undefined) {
      const rel = planningPathWithin(join(planningRoot, openspecDirName), archivePath)
      if (!rel || !rel.startsWith("archive/") || !rel.endsWith(`/${changeId}`)) {
        throw operationError(`archive source "${archivePath}" must be a path under ${openspecDirName}/archive/ ending in /${changeId}`, "missing")
      }
      // Symlink escape check: the real path must stay inside the planning root.
      const realArchive = await realpathSafe(join(planningRoot, openspecDirName, rel))
      if (realArchive === undefined || !realArchive.startsWith(await realpathSafe(planningRoot) + "/")) {
        throw operationError(`archive source "${archivePath}" escapes the planning root`, "conflict")
      }
      contracts.push({ changeId, kind: "archive", sourcePath: join(openspecDirName, rel), provenance: "adopt", selectedAtRevision: 1 })
    } else {
      const idsHere = await listChangeIds(join(planningRoot, openspecDirName, "changes"))
      if (!idsHere.includes(changeId)) {
        throw operationError(`change "${changeId}" is not an active change in ${planningRoot} — pass --archive-path if it is archived`, "missing")
      }
      contracts.push({ changeId, kind: "active", sourcePath: join(openspecDirName, "changes", changeId), provenance: "adopt", selectedAtRevision: 1 })
    }
  }

  const featureId = crypto.randomUUID()
  const now = Date.now()
  const record: FeatureRecord = {
    schemaVersion: 1,
    featureId,
    repositoryId: repoRecord.value.repositoryId,
    displayName: input.displayName ?? input.changeIds.join(" + "),
    associationRevision: 1,
    contracts,
    intendedBaseRef: input.base,
    context: { branch: input.branch, ...(await realpathSafe(worktreeDir) ? { checkoutPath: await realpathSafe(worktreeDir) } : {}) },
    runIds: [],
    closeAttemptIds: [],
    history: [{ at: now, kind: "adopted", summary: `adopted ${contracts.map((contract) => contract.changeId).join(", ")} on ${input.branch}`, revision: 1 }],
    createdAt: now,
    updatedAt: now,
  }
  const written = await withAssociationLease(commonDir, () => withFeatureLock(featureDirPath(commonDir, featureId), () => writeFeatureRecord(commonDir, record, 0)))
  if (!isFound(written)) throw operationError("adoption conflicted with a concurrent write — inspect and retry", "conflict")
  return { feature: written.value }
}

function featureDirPath(commonDir: string, featureId: string): string {
  return join(commonDir, "convoy", "features", featureId)
}

async function realpathSafe(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}


/**
 * The repository mutation lease around one association write (design D9,
 * SC-5): the lease serializes Convoy's own repository mutations — close
 * segments, run finalization, association writes — so an association record
 * never lands underneath an in-flight close or compaction. It is acquired
 * outside the per-feature lock (consistent ordering, no deadlock) and
 * released even when the write fails.
 */
export async function withAssociationLease<T>(commonDir: string, fn: () => Promise<T>): Promise<T> {
  let lease: MutationLease
  try {
    lease = await acquireMutationLease(commonDir)
  } catch (error) {
    const reason = error instanceof LeaseUnavailableError ? error.message : `couldn't acquire the repository mutation lease: ${String(error)}`
    throw operationError(reason, "conflict")
  }
  try {
    return await fn()
  } finally {
    await lease.release()
  }
}

// ── bind (task 3.3) ──────────────────────────────────────────────────────

export type BindInput = { cwd: string; featureId: string; branch: string; worktree: string }

/**
 * Explicit consent to update a feature's context (task 3.3). Not consent to
 * change base/contracts, migrate a foreign receipt, rewrite a run boundary,
 * or claim a landing. Validates Git common-directory membership (the
 * worktree must belong to this repository), registered worktree root, actual
 * branch, context uniqueness (no other feature claims it), and the absence
 * of a live run on the new context before bumping the revision.
 */
export async function featureBind(input: BindInput): Promise<FeatureRecord> {
  const commonDir = await lifecycleCommonDir(input.cwd)
  if (!commonDir) throw operationError("not a git repository", "missing")
  const current = await readFeatureRecord(commonDir, input.featureId)
  if (!isFound(current)) throw operationError(`feature ${input.featureId} not found (status: ${current.status})`, "missing")
  const feature = current.value

  const registered = await findWorktreeDirForBranch(input.branch, input.cwd)
  if (!registered) throw operationError(`branch "${input.branch}" is not checked out in any registered worktree`, "missing")
  const sameDir = (await realpathSafe(registered)) === (await realpathSafe(input.worktree))
  if (!sameDir) throw operationError(`branch "${input.branch}" is checked out at ${registered}, not ${input.worktree}`, "conflict")

  // Context uniqueness: at most one feature may claim a context (design D2).
  const all = await listFeatureRecords(commonDir)
  for (const entry of all) {
    if (!isFound(entry.read) || entry.read.value.featureId === feature.featureId) continue
    if (entry.read.value.context?.branch === input.branch) {
      throw operationError(`branch "${input.branch}" is already claimed by feature ${entry.read.value.featureId}`, "conflict")
    }
  }

  const liveRuns = await observeLiveRunsAt(registered)
  if (liveRuns.kind === "known" && liveRuns.value.length > 0) {
    throw operationError(`${liveRuns.value.length} live run(s) attached to "${input.branch}" — stop them before rebinding`, "conflict")
  }
  if (liveRuns.kind === "unknown") {
    throw operationError(`couldn't verify live runs (${liveRuns.reason}) — refusing the rebind while run state is unreadable`, "unreadable")
  }

  // An unresolved close attempt targets the old context; rebinding marks the
  // transition (the attempt's journal keeps its evidence, new work resumes
  // fresh — capability feature-lifecycle: recovery after a context moves).
  const attemptIds = await listAttemptIds(commonDir, feature.featureId)
  for (const attemptId of attemptIds) {
    const journal = await readAttemptJournal(commonDir, feature.featureId, attemptId)
    if (isFound(journal) && journal.value.phase !== "landed") {
      // Pending attempt: allowed, but the rebind supersedes its target. The
      // journal's recorded state is preserved; the next close reconciles from
      // observed effects rather than replaying the stale target.
      continue
    }
  }

  return await withAssociationLease(commonDir, () => withFeatureLock(featureDirPath(commonDir, feature.featureId), async () => {
    const reread = await readFeatureRecord(commonDir, feature.featureId)
    if (!isFound(reread)) throw operationError("feature record vanished during rebind", "missing")
    const revision = reread.value.associationRevision + 1
    const checkoutPath = (await realpathSafe(registered)) ?? registered
    const event: AssociationEvent = { at: Date.now(), kind: "bound", summary: `bound context ${input.branch} at ${checkoutPath}`, revision }
    const updated: FeatureRecord = {
      ...reread.value,
      associationRevision: revision,
      context: { branch: input.branch, checkoutPath },
      history: [...reread.value.history, event],
      updatedAt: Date.now(),
    }
    const written = await writeFeatureRecord(commonDir, updated, reread.value.associationRevision)
    if (!isFound(written)) throw operationError("rebind conflicted with a concurrent association update — inspect and retry", "conflict")
    return written.value
  }))
}

// ── revise (task 3.4) ────────────────────────────────────────────────────

export type ReviseInput = { cwd: string; featureId: string; changeIds: string[]; base: string }

/**
 * Explicit reviewed consent to replace a live feature's contract set and
 * intended base (task 3.4). Refused while a run is live on the context or an
 * unresolved close attempt exists (capability feature-lifecycle: contract
 * revision is blocked while running).
 */
export async function featureRevise(input: ReviseInput): Promise<FeatureRecord> {
  const commonDir = await lifecycleCommonDir(input.cwd)
  if (!commonDir) throw operationError("not a git repository", "missing")
  const current = await readFeatureRecord(commonDir, input.featureId)
  if (!isFound(current)) throw operationError(`feature ${input.featureId} not found`, "missing")
  const feature = current.value
  if (feature.context?.checkoutPath) {
    const liveRuns = await observeLiveRunsAt(feature.context.checkoutPath)
    if (liveRuns.kind === "known" && liveRuns.value.length > 0) {
      throw operationError(`a run is live on "${feature.context.branch}" — finish or stop it before revising contracts`, "conflict")
    }
    if (liveRuns.kind === "unknown") throw operationError(`couldn't verify live runs (${liveRuns.reason})`, "unreadable")
  }
  for (const attemptId of await listAttemptIds(commonDir, feature.featureId)) {
    const journal = await readAttemptJournal(commonDir, feature.featureId, attemptId)
    if (isFound(journal) && journal.value.phase !== "landed") {
      throw operationError(`close attempt ${attemptId.slice(0, 8)} is unresolved — reconcile it before revising contracts`, "conflict")
    }
  }

  const contracts: FeatureContract[] = []
  // New contracts must be active in the feature's verified context checkout
  // (revise operates on the live feature's own planning sources).
  const reviseCheckout = feature.context?.checkoutPath ?? input.cwd
  for (const changeId of input.changeIds) {
    if (!isOpenSpecChangeId(changeId)) throw operationError(`"${changeId}" is not a valid change id`, "missing")
    const prior = feature.contracts.find((contract) => contract.changeId === changeId)
    if (prior) {
      contracts.push({ ...prior, selectedAtRevision: feature.associationRevision + 1 })
    } else {
      const idsHere = await listChangeIds(join(reviseCheckout, openspecDirName, "changes"))
      if (!idsHere.includes(changeId)) throw operationError(`change "${changeId}" is not active in ${reviseCheckout}`, "missing")
      contracts.push({ changeId, kind: "active", sourcePath: join(openspecDirName, "changes", changeId), provenance: "revise", selectedAtRevision: feature.associationRevision + 1 })
    }
  }

  return await withAssociationLease(commonDir, () => withFeatureLock(featureDirPath(commonDir, feature.featureId), async () => {
    const reread = await readFeatureRecord(commonDir, feature.featureId)
    if (!isFound(reread)) throw operationError("feature record vanished during revise", "missing")
    const revision = reread.value.associationRevision + 1
    const updated: FeatureRecord = {
      ...reread.value,
      associationRevision: revision,
      contracts,
      intendedBaseRef: input.base,
      history: [...reread.value.history, { at: Date.now(), kind: "revised", summary: `revised contracts to ${contracts.map((contract) => contract.changeId).join(", ")}`, revision }],
      updatedAt: Date.now(),
    }
    const written = await writeFeatureRecord(commonDir, updated, reread.value.associationRevision)
    if (!isFound(written)) throw operationError("revise conflicted with a concurrent association update — inspect and retry", "conflict")
    return written.value
  }))
}

// ── recover (task 3.5) ───────────────────────────────────────────────────

export type RecoverInput = { cwd: string; featureId?: string; legacy?: boolean; changeId?: string }

/** One legacy close journal with its embedded identity fields, for adoption. */
type LegacyLanding = {
  branch: string
  changeId: string
  baseRef: string
  baseSha: string
  postArchiveTip: string
  preparedTree?: string
  candidateSha: string
  landingSha: string
}

/**
 * Reads every landed legacy close journal (branch/change-keyed, pre-identity)
 * with its embedded evidence. The original files are never modified here.
 */
async function listLegacyLandings(commonDir: string): Promise<LegacyLanding[]> {
  const legacyDir = join(commonDir, "convoy", "close")
  let entries
  try {
    entries = await readdir(legacyDir, { withFileTypes: true })
  } catch {
    return []
  }
  const { readCloseJournal } = await import("../close-journal")
  const out: LegacyLanding[] = []
  for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json"))) {
    const match = entry.name.match(/^(.+)__(.+)\.json$/)
    if (!match) continue
    const journal = await readCloseJournal(commonDir, match[1]!, match[2]!)
    if (!journal || journal.phase !== "landed" || !journal.landingSha || !journal.postArchiveTip || !journal.candidateSha || !journal.preparedTree) continue
    out.push({
      branch: journal.branch,
      changeId: journal.changeID,
      baseRef: journal.baseRef,
      baseSha: journal.baseSha,
      postArchiveTip: journal.postArchiveTip,
      ...(journal.preparedTree ? { preparedTree: journal.preparedTree } : {}),
      candidateSha: journal.candidateSha,
      landingSha: journal.landingSha,
    })
  }
  return out
}

/**
 * Evidence-only import of a completed feature whose worktree is gone
 * (task 3.5): locates a landing receipt (identity-keyed, or legacy evidence
 * with `--legacy`), validates embedded identity, repository membership, and
 * landing reachability, then writes a stable feature record that grants only
 * receipt-verified follow-up/cleanup eligibility — never new execution
 * authority. Does not require the historical worktree or branch to exist.
 */
export async function featureRecover(input: RecoverInput): Promise<FeatureRecord> {
  const commonDir = await lifecycleCommonDir(input.cwd)
  if (!commonDir) throw operationError("not a git repository", "missing")

  if (input.legacy) {
    return await recoverFromLegacy(commonDir, input)
  }

  const discovery = await discoverLifecycle({ cwd: input.cwd, commonDir })

  // Identity-keyed path: find a receipt for the named feature (or a unique
  // one across the store) and rebuild the record from that evidence.
  const candidates = discovery.features.filter((entry) => entry.receipts.some(({ receipt }) => receipt !== undefined) && (input.featureId === undefined || entry.featureId === input.featureId))
  if (candidates.length === 0) {
    throw operationError(
      input.featureId ? `no verified landing receipt found for feature ${input.featureId}` : "no completed feature with a verified landing receipt was found to recover",
      "missing",
    )
  }
  if (candidates.length > 1) {
    throw operationError(`${candidates.length} completed features carry receipts; name one with --feature <id>`, "ambiguous")
  }
  const entry = candidates[0]!
  const withReceipt = entry.receipts.find(({ receipt }) => receipt !== undefined)!
  const receipt = withReceipt.receipt!
  if (!(await isLandingReachableFrom(receipt.landingSha, receipt.baseRef, input.cwd))) {
    throw operationError(`landing ${receipt.landingSha.slice(0, 8)} is no longer reachable from ${receipt.baseRef} — recovery refuses unverifiable evidence`, "missing")
  }
  if (receipt.repositoryId !== entry.record.repositoryId) {
    throw operationError("receipt belongs to a different repository — refusing to import foreign evidence", "conflict")
  }
  // The record already exists and carries the receipt; recovery here means
  // validating and returning it (its eligibility derives from the receipt).
  return entry.record
}

/**
 * Explicit legacy adoption (task 8.2): imports a completed legacy close
 * journal (branch/change-keyed, pre-identity) into a stable feature record
 * with a fresh identity-keyed receipt. Embedded identity fields are
 * validated against the request and repository; the original journal bytes
 * and refs are preserved untouched; a collision (the branch/change already
 * claimed by a registered feature) or a mismatched journal is refused, never
 * reassigned.
 */
async function recoverFromLegacy(commonDir: string, input: RecoverInput): Promise<FeatureRecord> {
  const repoRecord = await ensureRepositoryRecord(commonDir)
  if (!isFound(repoRecord)) throw operationError(`couldn't initialize the lifecycle store: ${repoRecord.status === "unreadable" ? repoRecord.reason : repoRecord.status}`, "unreadable")

  // A requested change narrows the candidates; a requested featureId is not
  // meaningful for legacy records (they have no ids) and is refused.
  if (input.featureId) throw operationError("legacy evidence carries no feature ids; run `convoy feature recover --legacy` without --feature, narrowing with --change instead", "missing")
  const landed = await listLegacyLandings(commonDir)
  const filtered = input.changeId ? landed.filter((entry) => entry.changeId === input.changeId) : landed
  if (filtered.length === 0) {
    throw operationError("no landed legacy close journal matches — legacy adoption needs a completed legacy close record", "missing")
  }
  if (filtered.length > 1) {
    throw operationError(`${filtered.length} landed legacy journals match; narrow with --change <id>`, "ambiguous")
  }
  const candidate = filtered[0]!

  // Repository membership + landing reachability from current Git evidence.
  if (!(await isLandingReachableFrom(candidate.landingSha, candidate.baseRef, input.cwd))) {
    throw operationError(`legacy landing ${candidate.landingSha.slice(0, 8)} is no longer reachable from ${candidate.baseRef} — recovery refuses unverifiable evidence`, "missing")
  }
  // Collision: the branch/change must not already be claimed by a registered feature.
  for (const entry of await listFeatureRecords(commonDir)) {
    if (!isFound(entry.read)) continue
    const feature = entry.read.value
    if (feature.context?.branch === candidate.branch || feature.contracts.some((contract) => contract.changeId === candidate.changeId)) {
      throw operationError(`legacy evidence for ${candidate.branch}/${candidate.changeId} collides with registered feature ${feature.featureId} — refusing to reassign`, "conflict")
    }
  }

  // The stable identity + identity-keyed receipt, preserving the legacy
  // journal bytes/refs untouched.
  const featureId = crypto.randomUUID()
  const attemptId = crypto.randomUUID()
  const now = Date.now()
  const record: FeatureRecord = {
    schemaVersion: 1,
    featureId,
    repositoryId: repoRecord.value.repositoryId,
    displayName: candidate.changeId,
    associationRevision: 1,
    contracts: [{ changeId: candidate.changeId, kind: "archive", sourcePath: `openspec/changes/archive/${candidate.changeId}`, provenance: "legacy-adoption", selectedAtRevision: 1 }],
    intendedBaseRef: candidate.baseRef,
    runIds: [],
    closeAttemptIds: [attemptId],
    history: [{ at: now, kind: "recovered", summary: `adopted legacy landing for ${candidate.changeId} on ${candidate.branch}`, revision: 1 }],
    createdAt: now,
    updatedAt: now,
  }
  const written = await withAssociationLease(commonDir, () => withFeatureLock(featureDirPath(commonDir, featureId), () => writeFeatureRecord(commonDir, record, 0)))
  if (!isFound(written)) throw operationError("legacy adoption conflicted with a concurrent write — inspect and retry", "conflict")
  await writeReceiptIfAbsent(commonDir, {
    schemaVersion: 1,
    attemptId,
    featureId,
    repositoryId: repoRecord.value.repositoryId,
    associationRevision: 1,
    branch: candidate.branch,
    baseRef: candidate.baseRef,
    baseSha: candidate.baseSha,
    featureTip: candidate.postArchiveTip,
    preparedTree: candidate.preparedTree ?? "",
    candidateSha: candidate.candidateSha,
    landingSha: candidate.landingSha,
    landingAt: now,
  })
  return written.value
}

// ── new-work (task 3.6) ──────────────────────────────────────────────────

export type NewWorkInput = { cwd: string; branch: string; worktree: string; changeIds?: string[]; base: string; displayName?: string }

/**
 * Explicit consent to start a new feature on a retained completed context, or
 * to create pre-proposal work with no contracts at all (capability
 * work-context, task 5.2): creates a fresh identity and does not reopen the
 * completed feature's receipt or inherit its runs. `changeIds` may be empty —
 * an idle verified zero-contract feature is awaiting proposal, and its
 * contracts arrive later through the explicit association-revision workflow.
 * `displayName` is independent of change/branch names; without one, a
 * contract-less creation is named from the branch slug.
 */
export async function featureNewWork(input: NewWorkInput): Promise<FeatureRecord> {
  const commonDir = await lifecycleCommonDir(input.cwd)
  if (!commonDir) throw operationError("not a git repository", "missing")
  const repoRecord = await ensureRepositoryRecord(commonDir)
  if (!isFound(repoRecord)) throw operationError(`couldn't initialize the lifecycle store: ${repoRecord.status === "unreadable" ? repoRecord.reason : repoRecord.status}`, "unreadable")

  const registered = await findWorktreeDirForBranch(input.branch, input.cwd)
  if (!registered) throw operationError(`branch "${input.branch}" is not checked out in any registered worktree`, "missing")
  if ((await realpathSafe(registered)) !== (await realpathSafe(input.worktree))) {
    throw operationError(`branch "${input.branch}" is checked out at ${registered}, not ${input.worktree}`, "conflict")
  }
  // The context must be free: no other feature may claim it — except a
  // completed feature (a verified landing receipt), whose claim is released
  // by completion and whose reuse is exactly the explicit new-work decision
  // being made here (capability feature-lifecycle, D2).
  for (const entry of await listFeatureRecords(commonDir)) {
    if (!isFound(entry.read)) continue
    const claimant = entry.read.value
    if (claimant.context?.branch !== input.branch) continue
    if (await isCompletedFeature(commonDir, claimant)) continue
    throw operationError(`branch "${input.branch}" is still claimed by feature ${claimant.featureId} — complete or explicitly release it first`, "conflict")
  }

  const contracts: FeatureContract[] = []
  const changeIds = input.changeIds ?? []
  for (const changeId of changeIds) {
    if (!isOpenSpecChangeId(changeId)) throw operationError(`"${changeId}" is not a valid change id`, "missing")
    const idsHere = await listChangeIds(join(input.worktree, openspecDirName, "changes"))
    if (!idsHere.includes(changeId)) throw operationError(`change "${changeId}" is not active in ${input.worktree}`, "missing")
    contracts.push({ changeId, kind: "active", sourcePath: join(openspecDirName, "changes", changeId), provenance: "new-work", selectedAtRevision: 1 })
  }

  const featureId = crypto.randomUUID()
  const now = Date.now()
  const displayName = input.displayName ?? (contracts.length > 0 ? contracts.map((contract) => contract.changeId).join(" + ") : `new work (${input.branch})`)
  const record: FeatureRecord = {
    schemaVersion: 1,
    featureId,
    repositoryId: repoRecord.value.repositoryId,
    displayName,
    associationRevision: 1,
    contracts,
    intendedBaseRef: input.base,
    context: { branch: input.branch, ...(await realpathSafe(input.worktree) ? { checkoutPath: await realpathSafe(input.worktree) } : {}) },
    runIds: [],
    closeAttemptIds: [],
    history: [{ at: now, kind: "new-work", summary: contracts.length > 0 ? `new work on ${input.branch}: ${contracts.map((contract) => contract.changeId).join(", ")}` : `new work created before proposal on ${input.branch}`, revision: 1 }],
    createdAt: now,
    updatedAt: now,
  }
  const written = await withAssociationLease(commonDir, () => withFeatureLock(featureDirPath(commonDir, featureId), () => writeFeatureRecord(commonDir, record, 0)))
  if (!isFound(written)) throw operationError("new-work conflicted with a concurrent write — inspect and retry", "conflict")
  return written.value
}

// ── spin registration (task 4.1) ─────────────────────────────────────────

export type SpinRegistration = { feature: FeatureRecord; resumed: boolean }

/**
 * Two-phase spin registration (design D4): an intent record is persisted
 * before the proposal transfer, and the association is committed before
 * success output. A retry after a partial failure adopts the recorded intent
 * instead of creating a duplicate feature/context; refusals before any
 * mutation never persist anything.
 */
export async function registerSpinFeature(input: { cwd: string; changeId: string; branch: string; worktreeDir: string; baseRef: string; phase: "intent" | "committed" }): Promise<SpinRegistration> {
  const commonDir = await lifecycleCommonDir(input.cwd)
  if (!commonDir) throw operationError("not a git repository", "missing")
  const repoRecord = await ensureRepositoryRecord(commonDir)
  if (!isFound(repoRecord)) throw operationError(`couldn't initialize the lifecycle store: ${repoRecord.status === "unreadable" ? repoRecord.reason : repoRecord.status}`, "unreadable")

  const existing = await findFeatureForBranchAndChange(commonDir, input.branch, input.changeId)
  if (existing) {
    if (input.phase === "committed") {
      // Resume: finalize the recorded intent.
      return await withAssociationLease(commonDir, () => withFeatureLock(featureDirPath(commonDir, existing.featureId), async () => {
        const reread = await readFeatureRecord(commonDir, existing.featureId)
        if (!isFound(reread)) throw operationError("spin intent record vanished", "missing")
        const revision = reread.value.associationRevision + 1
        const updated: FeatureRecord = {
          ...reread.value,
          associationRevision: revision,
          history: [...reread.value.history, { at: Date.now(), kind: "created", summary: `spin registration committed for ${input.changeId}`, revision }],
          updatedAt: Date.now(),
        }
        const written = await writeFeatureRecord(commonDir, updated, reread.value.associationRevision)
        if (!isFound(written)) throw operationError("spin registration conflicted with a concurrent write", "conflict")
        return { feature: written.value, resumed: true }
      }))
    }
    return { feature: existing, resumed: true }
  }

  if (input.phase === "committed") {
    // No intent was recorded (the intent phase failed or was skipped): the
    // caller must not silently mint the association here — adopt explicitly.
    throw operationError(`no spin intent is recorded for ${input.branch}/${input.changeId}; adopt the context explicitly with \`convoy feature adopt --branch ${input.branch} --change ${input.changeId} --base ${input.baseRef}\``, "missing")
  }

  // Context uniqueness: another feature must not already claim the branch.
  for (const entry of await listFeatureRecords(commonDir)) {
    if (isFound(entry.read) && entry.read.value.context?.branch === input.branch) {
      throw operationError(`branch "${input.branch}" is already claimed by feature ${entry.read.value.featureId}`, "conflict")
    }
  }

  const featureId = crypto.randomUUID()
  const now = Date.now()
  const checkoutPath = (await realpathSafe(input.worktreeDir)) ?? input.worktreeDir
  const record: FeatureRecord = {
    schemaVersion: 1,
    featureId,
    repositoryId: repoRecord.value.repositoryId,
    displayName: input.changeId,
    associationRevision: 1,
    contracts: [{ changeId: input.changeId, kind: "active", sourcePath: join(openspecDirName, "changes", input.changeId), provenance: "spin", selectedAtRevision: 1 }],
    intendedBaseRef: input.baseRef,
    context: { branch: input.branch, checkoutPath },
    runIds: [],
    closeAttemptIds: [],
    history: [{ at: now, kind: "created", summary: `spin intent: ${input.changeId} on ${input.branch} (pending transfer)`, revision: 1 }],
    createdAt: now,
    updatedAt: now,
  }
  const written = await withAssociationLease(commonDir, () => withFeatureLock(featureDirPath(commonDir, featureId), () => writeFeatureRecord(commonDir, record, 0)))
  if (!isFound(written)) throw operationError("spin intent could not be persisted — the transfer must not proceed without durable evidence", "conflict")
  return { feature: written.value, resumed: false }
}

async function findFeatureForBranchAndChange(commonDir: string, branch: string, changeId: string): Promise<FeatureRecord | undefined> {
  for (const entry of await listFeatureRecords(commonDir)) {
    if (!isFound(entry.read)) continue
    const feature = entry.read.value
    if (feature.context?.branch !== branch) continue
    if (feature.contracts.some((contract) => contract.changeId === changeId)) return feature
  }
  return undefined
}

// ── shared assessment wiring (task 2.5) ──────────────────────────────────

/** Builds the lifecycle assessment for one known feature record from live evidence. */
export async function assessCurrentFeature(input: { cwd: string; commonDir: string; feature: FeatureRecord }): Promise<ReturnType<typeof assessLifecycle>> {
  const { buildObservationsForFeature } = await import("./observe")
  const observations = await buildObservationsForFeature({ cwd: input.cwd, commonDir: input.commonDir, feature: input.feature })
  return assessLifecycle(observations)
}

/** Guards a ref against non-branch spellings used in CLI flags. */
export async function refResolves(ref: string, cwd: string): Promise<string | undefined> {
  return resolveCommit(ref, cwd).catch(() => undefined)
}

/** Git membership check used by every operation: same common dir ⇒ same repository. */
export async function sharesCommonDir(cwdA: string, cwdB: string): Promise<boolean> {
  const { gitCommonDir } = await import("../finalization/refs")
  const [a, b] = await Promise.all([gitCommonDir(cwdA), gitCommonDir(cwdB)])
  if (!a || !b) return false
  const ra = await realpathSafe(a)
  const rb = await realpathSafe(b)
  return ra !== undefined && rb !== undefined && ra === rb
}

/** Runs one git command (helper for callers that need raw output). */
export async function git(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return execFile("git", args, { cwd, allowFailure: true })
}
